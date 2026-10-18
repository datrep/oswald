// test/data-plane.test.js — F32: the header must not say `fresh` about a desk that has stopped updating.
//
// WHAT WENT WRONG. For ~16 hours on 2026-09-16/17 the desk's venue feed was frozen while every screen's
// `Data` chip read `fresh`. The chip was not lying: it was computed from whether each PANEL's own fetch
// had succeeded, which is a true and useless answer to "is this desk trading on live prices?". And the one
// surface built to answer that question — the scripts card's liveness column — rendered `—` for exactly
// the processes whose liveness mattered, because four of its `evidence` strings named event sources that
// no code emits (`telemetry.capture`, `telemetry.mirror`, `telemetry.discover`, `telemetry.tick_retention`).
// The lookup compared the newest telemetry event's source against those strings, failed to match, and left
// the cell blank.
//
// So there are two pins here, and the second is the one that generalises:
//   1. the VERDICT — thresholds, severity and chip text, on the pure decision function;
//   2. the CONTRACT — every `evidence` string in the registry must name a kind and source that some file
//      in `trading/` really emits. That assertion would have failed for four rows on the day they were
//      written, and it fails again the day someone renames an emitter without updating the card.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { code, ROOT } = require('./_source');

const dataPlane = require('../trading/agent/dataPlane');
const scripts = require('../trading/agent/scripts');
const { TICK_SLA_MS } = require('../trading/agent/quant');

const APP = 'trading/public/js/app.js';
const ROUTES = 'trading/routes.js';
const STORE = 'trading/store.js';
const TICKS = 'trading/store/ticks.js';
const PIPELINE = 'trading/agent/wakePipeline.js';
const DISCOVERER = 'trading/agent/discoverer.js';

// --- 1. the verdict ---------------------------------------------------------

const OK_FACTS = { cadenceMin: 10, feedAgeMin: 3, lastCapture: { captured: 12, atMs: 0 }, floorUnreadAgeMin: null, stoppedProcesses: [] };

test('a healthy desk is ok, and says nothing (so the chip keeps its own label)', () => {
  const v = dataPlane.assess(OK_FACTS);
  assert.strictEqual(v.state, 'ok');
  assert.deepStrictEqual(v.reasons, []);
  assert.strictEqual(dataPlane.chipText(v), null, 'no objection = no text, so "fresh" stays available');
});

test('the feed threshold is a MULTIPLE of the capture cadence, and the boundary is exclusive', () => {
  const cad = 10;
  const atLimit = dataPlane.assess({ ...OK_FACTS, cadenceMin: cad, feedAgeMin: cad * dataPlane.FEED_STALE_CYCLES });
  assert.strictEqual(atLimit.state, 'ok', 'exactly N cycles late is still tolerated: the capture is allowed to lose a busy cycle by design');

  const over = dataPlane.assess({ ...OK_FACTS, cadenceMin: cad, feedAgeMin: cad * dataPlane.FEED_STALE_CYCLES + 1 });
  assert.strictEqual(over.state, 'bad');
  assert.match(over.reasons[0].detail, /missed capture cycles/);
});

test('a slower wake cadence moves the threshold WITH it — the number is not hard-coded', () => {
  // The same 60 minutes is healthy at a 60m cadence and a 16-hour outage at a 10m one. That is the whole
  // reason the threshold is expressed as cycles: the audit's incident was 96 missed cycles.
  assert.strictEqual(dataPlane.assess({ ...OK_FACTS, cadenceMin: 60, feedAgeMin: 60 }).state, 'ok');
  assert.strictEqual(dataPlane.assess({ ...OK_FACTS, cadenceMin: 10, feedAgeMin: 60 }).state, 'bad');
});

test('no ticks at all is its own fact, never "0 minutes old"', () => {
  const v = dataPlane.assess({ cadenceMin: 10, feedAgeMin: null });
  assert.strictEqual(v.state, 'bad');
  assert.match(v.reasons[0].detail, /no venue ticks at all/);
  assert.strictEqual(dataPlane.chipText(v), 'STALE', 'an unknown age must not render as a number');
});

test('a capture that stored nothing is reported with the reason the capture itself recorded', () => {
  const v = dataPlane.assess({
    ...OK_FACTS,
    feedAgeMin: 900,
    lastCapture: { captured: 0, reason: 'bridge busy (watchdog) - lock wait exceeded for capture', atMs: Date.now() },
  });
  const cap = v.reasons.find((r) => r.id === 'capture');
  assert.ok(cap, 'the starvation signature must be named');
  assert.match(cap.detail, /bridge busy \(watchdog\)/, 'the lock holder is the actionable half of this fact');
});

test('a captured:0 row OLDER than the newest tick is history, not a current fault', () => {
  // The feed recovered after a starvation: the old zero must not keep the chip red forever.
  const v = dataPlane.assess({
    ...OK_FACTS,
    lastCapture: { captured: 0, reason: 'bridge busy', atMs: Date.now() - 60 * 60000 },
    feedAtMs: Date.now() - 60000,
  });
  assert.strictEqual(v.reasons.some((r) => r.id === 'capture'), false);
});

test('an unreadable disaster floor degrades but does not alarm, and only while it is recent', () => {
  const recent = dataPlane.assess({ ...OK_FACTS, floorUnreadAgeMin: 12 });
  assert.strictEqual(recent.state, 'degraded', 'the wake continued without the guard — a fact, not an outage');
  assert.match(recent.reasons[0].detail, /NOT being monitored/);

  const old = dataPlane.assess({ ...OK_FACTS, floorUnreadAgeMin: 10 * dataPlane.FLOOR_UNREAD_CYCLES + 1 });
  assert.strictEqual(old.state, 'ok', 'a floor read that failed an hour ago is not a current state');
});

test('a stopped process degrades the verdict, and says which one and for how long', () => {
  const v = dataPlane.assess({
    ...OK_FACTS,
    stoppedProcesses: [{ name: 'Multi-factor rank', cadence: '6h gate', ageText: '7.0d' }],
  });
  assert.strictEqual(v.state, 'degraded');
  assert.match(v.reasons[0].detail, /Multi-factor rank has not run since 7\.0d \(declared 6h gate\)/);
});

test('severity is the WORST reason, and every reason is kept', () => {
  const v = dataPlane.assess({
    cadenceMin: 10, feedAgeMin: 900, floorUnreadAgeMin: 5,
    stoppedProcesses: [{ name: 'Market pulse', cadence: '4h gate', ageText: '18.8h' }],
  });
  assert.strictEqual(v.state, 'bad', 'a dead feed outranks a degraded floor');
  assert.strictEqual(v.reasons.length, 3, 'the quieter faults are still reported — they are why the feed is dead');
});

test('the chip names the age when the feed is the fault, and never says fresh when the state is not ok', () => {
  const stale = dataPlane.assess({ ...OK_FACTS, feedAgeMin: 964 });
  assert.strictEqual(dataPlane.chipText(stale), 'STALE 16.1h');

  const floor = dataPlane.assess({ ...OK_FACTS, floorUnreadAgeMin: 5 });
  assert.strictEqual(dataPlane.chipText(floor), '1 data fault');

  for (const v of [stale, floor]) {
    assert.notStrictEqual(dataPlane.chipText(v), 'fresh');
  }
});

// --- 2. the contract: a label must name a producer that exists -------------

function allSourceText() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(ROOT, 'trading'));
  return out.join('\n');
}

const ALL = allSourceText();
// Kinds are emitted as the 2nd argument of logEvent / log.write.
const EMITTED_KINDS = new Set([...ALL.matchAll(/(?:logEvent|log\.write|\bwrite)\(\s*[^,()]+,\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
// Sources are emitted as `source: 'x'` (in a payload, a tick row, a connector result — any of which is a
// real producer, which is why the check is on the string rather than on a call shape).
const EMITTED_SOURCES = new Set([...ALL.matchAll(/source:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));

test('every registry `evidence` names a kind and source that trading/ really emits', () => {
  assert.ok(EMITTED_KINDS.size > 20, 'the kind scan must actually find the emitters');
  assert.ok(EMITTED_SOURCES.size > 20, 'the source scan must actually find the emitters');

  for (const d of scripts.SCRIPT_DEFS) {
    if (!d.evidence) continue;
    const { kind, source } = scripts.splitEvidence(d.evidence);
    assert.ok(
      EMITTED_KINDS.has(kind),
      `${d.id}: evidence kind '${kind}' is never logged by any file in trading/ — the card would show a dash forever`,
    );
    if (source) {
      assert.ok(
        EMITTED_SOURCES.has(source),
        `${d.id}: evidence source '${source}' is never emitted by any file in trading/ — this is exactly the `
        + 'bug that left four rows blank through the 2026-09-17 outage',
      );
    }
  }
});

test('the four wrong evidence strings from the outage cannot come back', () => {
  const defs = scripts.SCRIPT_DEFS.map((d) => d.evidence || '').join(' ');
  for (const wrong of ['telemetry.capture', 'telemetry.mirror', 'telemetry.discover', 'telemetry.tick_retention']) {
    assert.ok(!defs.includes(wrong), `${wrong} names a producer that does not exist`);
  }
});

test('every process declares EITHER an evidence path OR why it cannot be judged from the log', () => {
  // This is what makes a blank cell impossible: the card has something true to print either way, which was
  // the audit's complaint about the `Congress pull` dash being "correct but unqualified".
  for (const d of scripts.SCRIPT_DEFS) {
    assert.ok(
      !!d.evidence !== !!d.silentWhy,
      `${d.id}: needs exactly one of evidence (a producer to read) or silentWhy (why there is none)`,
    );
  }
});

// --- 3. the lookup must not be able to go blank silently -------------------

test('the scripts lookup filters by source in SQL instead of discarding a mismatched answer', () => {
  const src = code('trading/agent/scripts.js');
  assert.doesNotMatch(
    src,
    /if \(source && pl\.source !== source\) continue/,
    'the old shape threw the answer away without recording that it had — which is how the cell went blank',
  );
  assert.match(src, /store\.latestEvent\(userId, kind, \{ source \}\)/, 'the filter belongs in the query');

  const storeSrc = code(STORE);
  assert.match(storeSrc, /async function latestEvent\(userId, kind, \{ source = null \} = \{\}\)/, 'latestEvent must accept the filter');
  assert.match(storeSrc, /JSON_VALUE\(payload, '\$\.source'\) = @source/, 'and apply it in SQL');
});

test('an overdue process is decided in ONE place, so the card and the chip cannot disagree', () => {
  const src = code('trading/agent/scripts.js');
  assert.match(src, /d\.overdue = !!\(d\.enabled && d\.maxSilenceMin != null/, 'inventory owns the verdict');
  assert.match(src, /d\.maxSilenceMin = cadenceMin == null \? null : cadenceMin \* CADENCE_SLACK/, 'from the declared cadence and one slack factor');
  assert.match(src, /if \(d\.id === 'pulse'\) return Math\.max\(15, \(Number\(s\.pulse && s\.pulse\.intervalHours\) \|\| 4\) \* 60\)/,
    'a settings-driven gate is read from settings, or an owner who set 24h is reported as broken');

  const dp = code('trading/agent/dataPlane.js');
  assert.match(dp, /\.filter\(\(s\) => s && s\.overdue === true\)/, 'the verdict consumes that one decision');
});

test('a disabled-by-default process is never reported as overdue', () => {
  const off = { strategies: { enabled: ['turtle'] }, discover: { enabled: false } };
  const congress = scripts.SCRIPT_DEFS.find((d) => d.id === 'congress');
  const multi = scripts.SCRIPT_DEFS.find((d) => d.id === 'multi');
  const discoverer = scripts.SCRIPT_DEFS.find((d) => d.id === 'discover_ai');
  assert.strictEqual(scripts.enabledNow(congress, off), false, 'congress is off: its silence is not a fault');
  assert.strictEqual(scripts.enabledNow(multi, off), false, 'neither is the factor rank — see F31 below');
  assert.strictEqual(scripts.enabledNow(discoverer, off), false, 'the discoverer ships disabled');
  assert.strictEqual(scripts.enabledNow(congress, { strategies: { enabled: ['turtle', 'congress'] } }), true);
  assert.strictEqual(scripts.enabledNow(multi, { strategies: { enabled: ['survgold', 'multi'] } }), true);
});

test('F31 ROOT CAUSE is pinned: the factor rank is gated on strategies.enabled, so "silent" is not "broken"', () => {
  // The live setting on 2026-09-18 was `["survgold","survoil"]`, and `multi_signal` had not been written
  // for 7.5 days — with ZERO error events, because nothing failed. Nothing RAN. The gate and the registry's
  // reading of it must stay the same rule, or the chip will nag forever about a deliberate configuration.
  const pipe = code(PIPELINE);
  const disc = code(DISCOVERER);
  assert.match(pipe, /\(\(settings\.strategies \|\| \{\}\)\.enabled \|\| \['turtle'\]\)\.includes\('multi'\)/,
    'the wake gate for multi must still be an includes() over strategies.enabled');
  assert.match(pipe, /\(\(settings\.strategies \|\| \{\}\)\.enabled \|\| \['turtle'\]\)\.includes\('congress'\)/);
  assert.match(pipe, /\(\(settings\.pulse \|\| \{\}\)\.enabled !== false\)/);
  assert.match(disc, /dc\.enabled !== true/, 'the discoverer gates on discover.enabled');
});

test('the feed check reads the VENUE, not whichever source happens to be freshest', () => {
  const ticks = code(TICKS);
  assert.match(ticks, /async function newestTick\(userId, \{ venue = null \} = \{\}\)/, 'newestTick must exist and take a venue');
  const dp = code('trading/agent/dataPlane.js');
  assert.match(dp, /newestTick\(userId, \{ venue: 'plus500' \}\)/, 'the desk trades on the venue feed; a fresh yahoo fallback must not mask it');
});

test('the verdict never touches the bridge — it is DB-only', () => {
  // A health check that needs the thing it checks is not a check: during the outage every bridge-touching
  // probe hung, which is exactly when this verdict is most needed.
  const dp = code('trading/agent/dataPlane.js');
  assert.doesNotMatch(dp, /getConnector|pageLock|require\('\.\.\/connector'\)/, 'no venue access, ever');
});

// --- 5. F17: the entry gate -------------------------------------------------

test('the entry limit is quant\'s OWN not-tradable line, not a number this module invented', () => {
  // The first version of this gate derived 3 × the wake interval — a SCHEDULING number answering a question
  // about DATA. `quant.js` already owns the right one and states its meaning ("a series older than this is
  // NOT TRADABLE"), so the gate reuses it and this test refuses to let a second number creep back in.
  assert.strictEqual(dataPlane.entryFeedLimitMin({ wake: { intervalMinutes: 10 } }), TICK_SLA_MS / 60000,
    'unset = quant.TICK_SLA_MS');
  assert.strictEqual(dataPlane.entryFeedLimitMin({ wake: { intervalMinutes: 60 } }), TICK_SLA_MS / 60000,
    'and it does NOT move with the wake cadence — the data does not get older because the desk wakes less often');

  assert.strictEqual(dataPlane.entryFeedLimitMin({ risk: { maxEntryTickAgeMin: 90 } }), 90,
    'an owner who names a number gets that number');
  assert.strictEqual(dataPlane.entryFeedLimitMin({ risk: { maxEntryTickAgeMin: 0 } }), TICK_SLA_MS / 60000,
    '0 is not a limit, it is an unset field — it must not disable the gate');

  // THE RELATION WITH THE CHIP, which is the part that must not drift: the gate may refuse EARLIER than the
  // header alarms (that is a tight rule), but the header must never be quiet while entries are being refused.
  const chipLimitMin = 10 * dataPlane.FEED_STALE_CYCLES;
  assert.ok(dataPlane.entryFeedLimitMin({}) <= chipLimitMin,
    `the gate (${dataPlane.entryFeedLimitMin({})}m) must be at least as strict as the chip (${chipLimitMin}m)`);
});

test('the gate measures the price the DECISION used, not just the feed', async () => {
  // `priceAgeSec` comes off the quant snapshot, so it is per symbol, and it covers BOTH pricing paths: a
  // tick, and a bar close (which can be an hour old on a 1h bar). No branching on the source — one age,
  // measured against one line. This half runs before the feed read, so it is testable with no database.
  const stale = await dataPlane.entryGate(1, {}, { symbol: 'Oil', priceSource: 'bar_close', priceAgeSec: 4 * 3600 });
  assert.strictEqual(stale.ok, false, 'a 4-hour-old price cannot anchor an entry');
  assert.strictEqual(stale.reason, 'stale_price');
  assert.match(stale.detail, /Oil was priced from a bar close 240m old/, 'and it says which price, from what, how old');

  const fresh = await dataPlane.entryGate(1, {}, { symbol: 'Oil', priceSource: 'tick', priceAgeSec: 120 });
  assert.strictEqual(fresh.ok, true, 'a two-minute-old tick is exactly what an entry should be priced from');

  const boundary = await dataPlane.entryGate(1, {}, { symbol: 'Oil', priceSource: 'tick', priceAgeSec: (TICK_SLA_MS / 1000) });
  assert.strictEqual(boundary.ok, true, 'at the line is not past it');
  const past = await dataPlane.entryGate(1, {}, { symbol: 'Oil', priceSource: 'tick', priceAgeSec: (TICK_SLA_MS / 1000) + 1 });
  assert.strictEqual(past.ok, false, 'one second past the line is past it');

  // The 16-hour outage that produced F17, in the terms the gate actually uses.
  const outage = await dataPlane.entryGate(1, {}, { symbol: 'Oil', priceSource: 'tick', priceAgeSec: 16 * 3600 });
  assert.strictEqual(outage.ok, false);
});

test('the wake refuses BEFORE it reaches the venue, and records the refusal', () => {
  const src = code(PIPELINE);
  const execAt = src.indexOf("step('execute'");
  const body = src.slice(execAt);

  assert.match(body, /const gate = await require\('\.\/dataPlane'\)\.entryGate\(userId, settings, \{/, 'the gate runs on the agent entry path');
  assert.match(body, /priceAgeSec: qs && qs\.priceAgeSec,/, 'and is handed the price this decision used');
  assert.match(body, /placed: false, blocked: true, reason: `\$\{gate\.reason\}: \$\{gate\.detail\}`/, 'the refusal carries blocked:true and the reason it was refused');
  assert.match(body, /reason: gate\.reason, detail: gate\.detail,/, 'with an order_blocked event, like every other policy refusal');

  // ORDER MATTERS: the gate must come before the trade is placed, or it is decoration.
  const gateAt = body.indexOf('entryGate(userId, settings, {');
  const placeAt = body.indexOf("require('./executor').openTrade");
  assert.ok(gateAt > -1 && placeAt > -1 && gateAt < placeAt, 'the gate must precede the order');
});

test('the quant snapshot entry is read BEFORE the gate that consumes it', () => {
  // `qs` supplies the gate's price facts, so reading it after the gate is a TDZ crash on the first entry —
  // the same class of ordering defect this suite already pins once for the kill switch.
  const src = code(PIPELINE);
  const body = src.slice(src.indexOf("step('execute'"));
  const qsAt = body.indexOf('const qs = (quantResult.symbols || []).find((s) => s.symbol === d.symbol)');
  const gateAt = body.indexOf('entryGate(userId, settings, {');
  assert.ok(qsAt > -1 && gateAt > -1 && qsAt < gateAt, 'the snapshot entry must be read before the gate uses it');
});

test('a policy refusal is not drift, and the payload must carry `blocked` for that to hold', () => {
  const pipe = code(PIPELINE);
  assert.match(pipe, /blocked: e\.blocked === true,/, 'the flag must survive into the wake event');
  assert.match(code('trading/agent/selfHealth.js'), /if \(e\.action === 'entry' && e\.placed === false && !e\.blocked\)/,
    'or a working gate is reported as a broken one');
});

test('closes are never gated on feed freshness', () => {
  const src = code(PIPELINE);
  const execAt = src.indexOf("step('execute'");
  const body = src.slice(execAt);
  const gateAt = body.indexOf('entryGate(userId, settings, {');
  const gateBlock = body.slice(gateAt, gateAt + 2000);
  assert.ok(!/action === 'exit'[\s\S]{0,200}stale_price/.test(gateBlock), 'a position you cannot exit is worse than one you cannot enter');
});

// --- 4. the wiring ---------------------------------------------------------

test('the header chip carries BOTH answers and lets the server verdict win', () => {
  const app = code(APP);
  assert.match(app, /const dp = state\.dataPlane;/, 'the chip must consult the server verdict');
  assert.match(app, /const dpBad = dp && dp\.state && dp\.state !== 'ok';/);

  // The dp-bad branch must not contain the word fresh — that is the entire finding, in one assertion.
  const badBranch = app.slice(app.indexOf('if (dpBad) {'), app.indexOf('} else {', app.indexOf('if (dpBad) {')));
  assert.ok(badBranch.length > 0, 'the branch must exist');
  assert.ok(!badBranch.includes("'fresh'"), 'a desk with a dead feed must not be able to render "fresh"');
  assert.match(badBranch, /chip\.className = 'chip rejected'/, 'and it must look like a fault');
  assert.match(badBranch, /dp\.reasons\.map\(\(r\) => `• \$\{r\.detail\}`\)/, 'with the reasons in the tooltip');
});

test('the chip is refreshed with the other banner chips, and registered for its own staleness', () => {
  const app = code(APP);
  assert.match(app, /await tracked\('dataPlane', refreshDataPlane\)/, 'refreshAll must pull it');
  assert.match(app, /dataPlane: 120000/, 'and it must have its own SLA, so a dead endpoint shows up');
});

test('the route exists, is authenticated, and returns the chip text the UI renders', () => {
  const src = code(ROUTES);
  assert.match(src, /router\.get\('\/data-plane', authenticateToken/, 'every data route on this desk is gated');
  assert.match(src, /chip: dataPlane\.chipText\(verdict\)/, 'the chip text is decided server-side, with the thresholds');
  assert.match(src, /scripts\.inventory\(req\.user\.userID, settings\)/, 'and the registry is read with settings, so enablement is known');
});
