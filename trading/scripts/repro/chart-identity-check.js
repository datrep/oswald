// trading/scripts/repro/chart-identity-check.js — TRD-GRD-4's acceptance harness. READ-ONLY: it writes
// nothing, banks nothing and refuses nothing.
//
// WHAT IT IS FOR. The capture records, per sweep, the instrument id the venue's chart was actually showing
// (`capture_chart_identity` telemetry). ENFORCEMENT MUST NOT BE AUTHORISED UNTIL THIS SHOWS ZERO MISMATCHES
// ON A HEALTHY CAPTURE, because a refused capture costs real data and the desk would not notice until a
// symbol went quiet. This turns the accumulated observations into the verdict distribution that decision
// needs, instead of asking a reader to eyeball JSON.
//
// ★ IT RETURNED A FALSE ALL-CLEAR, AND THE FIX IS THE POINT OF THIS HEADER (TRD-GRD-4, 2026-09-25).
// Measured on 2026-09-25 the record held 48 mismatches, 471 unregistered observations and 1,427 matches
// across 163 swept events — while THIS SCRIPT PRINTED "No mismatches observed". Two independent reasons, and
// either one alone was enough:
//
//   (1) IT COUNTED DISTINCT PAIRS, NOT OBSERVATIONS. It collapsed every sweep into a Map keyed by
//       `symbol|chartSymbol` and tallied the verdict ONCE PER DISTINCT PAIR. That answers "has any pair EVER
//       been wrong" — 13 pairs, mostly right — and not "how often was the chart showing the wrong
//       instrument", which is the question enforcement turns on. One bad sample in 163 sweeps produced the
//       same output as 163 bad samples.
//
//   (2) IT READ THE TRUNCATED SAMPLE LIST INSTEAD OF THE RECORDED COUNTS. `capture.js` writes BOTH: the counts
//       it tallied (`match` / `mismatch` / `unregistered` / `unrecorded`) AND `samples`, which is CAPPED AT 8
//       and carries ONLY the non-match verdicts. A tally built from `samples` cannot see a single `match`, so
//       the distribution was not merely undercounted — it was drawn from a list built to exclude the majority
//       verdict. The counts existed for exactly this purpose and went unread.
//
// ⚠ AND THAT IS WHY THE UNDERCOUNT MATTERED MORE THAN ITS SIZE. This script's own text says "ENFORCEMENT MUST
// NOT BE AUTHORISED UNTIL THIS SHOWS ZERO MISMATCHES" — so an instrument that under-reports does not merely
// mislead a reader, it AUTHORISES the change it exists to gate. A guard whose failure looks like a pass is
// worse than no guard at all.
//
// ★ WHY THE VERDICT IS THE REGISTRY'S AND NOT A NAME COMPARISON. The first version of the check compared
// `engine.chart.symbol` to the desk symbol and reported of:12, match:0, mismatch:12 on a capture that was
// working perfectly — because the venue returns an INSTRUMENT ID (`11_Sell` for Gold), not a name. Enforcing
// that would have refused 100% of captures. See trading/docs/instrument-swap-2026-09-24.md §13.
//
// USAGE
//   node trading/scripts/repro/chart-identity-check.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');
const capture = require('../../plus500/capture');
const instruments = require('../../store/instruments');

const USER = 1;

(async () => {
  const pool = await getPool();
  const r = await pool.request()
    .query(`SELECT id, createdAt, payload FROM TradingEvents
            WHERE userId = ${Number(USER)} AND payload LIKE '%capture_chart_identity%'
            ORDER BY id`);

  // ★ TWO DIFFERENT EMITTERS WROTE THIS ONE EVENT NAME, AND THEIR COUNTS ARE NOT COMPARABLE.
  // Summing them is the SECOND way this script lied, and it was introduced by the FIRST fix: the version
  // that read the recorded counts summed all 167 events and reported 48 mismatches. All 48 come from four
  // events on 2026-09-23 20:19–20:32, and they are a measurement of a bug in the EMITTER, not of the chart.
  // The schema tells them apart without guessing:
  //   · the retired emitter recorded NO `unregistered` count and NO `registry` in its samples, because it
  //     compared the venue's instrument id (`11_Sell`) against the desk's NAME (`Gold`) — so all twelve
  //     symbols were "wrong" every time, on a capture that was working perfectly;
  //   · the emitter running today records `unregistered` AND judges each sample against the registry.
  // A total across the two measures neither, so they are reported separately and never added.
  const GENERATION_OF = (p) => (Object.prototype.hasOwnProperty.call(p, 'unregistered')
    && (p.samples || []).some((s) => s && Object.prototype.hasOwnProperty.call(s, 'registry')))
    ? 'registry-judged (the emitter running today)'
    : 'PRE-REGISTRY (retired emitter — instrument id compared to a name)';

  const pairSeen = new Map(); // distinct pair -> the latest observation of it, for the coverage table
  const gens = new Map();     // generation -> its own totals, its own span, its own re-judged samples
  const badSweeps = [];       // every sweep whose RECORDED mismatch count is above zero, tagged with its generation
  let scanned = 0;
  let events = 0;

  const regCache = new Map();
  const lookupRegistry = async (chartSymbol) => {
    const id = capture.chartInstrumentId(chartSymbol);
    if (!id) return null;
    if (!regCache.has(id)) {
      regCache.set(id, await instruments.getInstrumentById(USER, { venue: 'plus500', venueInstrumentId: id }).catch(() => null));
    }
    const row = regCache.get(id);
    return { id, symbol: row ? row.symbol : null };
  };

  for (const row of r.recordset) {
    scanned++;
    let p;
    try { p = JSON.parse(row.payload); } catch { continue; }
    // Match the FIELD, not the kind: capture.js writes these as kind='telemetry' with payload.source set. A
    // `kind = 'capture_chart_identity'` query returns zero rows on a healthy capture — a mistake made once
    // already while reading this task's own evidence.
    if (p.source !== 'capture_chart_identity') continue;
    events++;
    const gen = GENERATION_OF(p);
    if (!gens.has(gen)) gens.set(gen, {
      n: 0, match: 0, mismatch: 0, unregistered: 0, unrecorded: 0, countsMissing: [],
      rejudged: {}, rejudgedN: 0, first: null, last: null,
    });
    const g = gens.get(gen);
    g.n++;
    const at = row.createdAt ? new Date(row.createdAt).toISOString() : '?';
    if (!g.first) g.first = at;
    g.last = at;

    const present = ['match', 'mismatch', 'unregistered', 'unrecorded'].filter((k) => Number.isFinite(Number(p[k])));
    if (!present.length) g.countsMissing.push(row.id); // counting it as zero would manufacture a clean result
    for (const k of present) g[k] += Number(p[k]);

    if (Number(p.mismatch) > 0) badSweeps.push({ id: row.id, gen, mismatch: Number(p.mismatch), of: Number(p.of) });

    // ★ RE-JUDGE EVERY STORED SAMPLE WITH THE SAME FUNCTION ENFORCEMENT WOULD USE. This is the independent
    // check on the emitter's own tally, and it is what identifies the 48: a sample the emitter LABELLED
    // `mismatch` that re-judges as something else means the emitter was wrong, not the chart. The sample's own
    // recorded `registry` is used when the sample has one (judging a past decision with today's registry would
    // be a different question); otherwise the live registry is used and the fallback is counted.
    for (const s of p.samples || []) {
      if (!s || !s.symbol || !s.chartSymbol) continue;
      const recorded = Object.prototype.hasOwnProperty.call(s, 'registry') ? s.registry : undefined;
      const live = recorded === undefined ? await lookupRegistry(s.chartSymbol) : null;
      const registrySymbol = recorded !== undefined ? recorded : (live ? live.symbol : null);
      const v = capture.chartIdentityVerdict(s.chartSymbol, s.symbol, registrySymbol);
      g.rejudged[v] = (g.rejudged[v] || 0) + 1;
      g.rejudgedN++;
      pairSeen.set(`${s.symbol}|${s.chartSymbol}`, { ...s, _registry: registrySymbol });
    }
  }

  const current = [...gens.keys()].find((k) => /^registry-judged/.test(k));
  const observed = gens.has(current)
    ? gens.get(current).match + gens.get(current).mismatch + gens.get(current).unregistered + gens.get(current).unrecorded
    : 0;

  console.log(`\nchart-identity acceptance check — ${events} swept event(s) of ${scanned} row(s) scanned\n`);
  if (!events) {
    console.log('  No observations yet. Run a capture, then re-run this.');
    await pool.close();
    return;
  }

  console.log('  EMITTER GENERATIONS — reported separately, NEVER summed:');
  for (const [gen, g] of [...gens.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const tot = g.match + g.mismatch + g.unregistered + g.unrecorded;
    console.log(`\n    ${gen}`);
    console.log(`      ${g.n} event(s), ${g.first} .. ${g.last}`);
    console.log(`      recorded over OBSERVATIONS: match ${g.match}, mismatch ${g.mismatch}, unregistered ${g.unregistered}, unrecorded ${g.unrecorded}  (${tot} total)`);
    console.log(`      re-judged over the ${g.rejudgedN} sample(s) the events stored: ${JSON.stringify(g.rejudged)}`);
    if (!/^registry-judged/.test(gen)) {
      console.log('      NOTE: those samples record NO registry, so they are re-judged against the registry as it is');
      console.log('      TODAY. That answers "were the instrument ids right" — they were, 28 of 32 resolve to the');
      console.log('      expected symbol — which is exactly what the pre-fix name comparison could not see.');
    }
    if (g.countsMissing.length) {
      console.log(`      ⚠ ${g.countsMissing.length} event(s) carried NO usable counts (ids ${g.countsMissing.slice(0, 6).join(', ')}) — EXCLUDED, because "the field never arrived" and "nothing went wrong" are not the same fact.`);
    }
  }

  console.log(`\n  sweeps whose RECORDED mismatch count is above zero: ${badSweeps.length} of ${events}`);
  for (const b of badSweeps) console.log(`    #${b.id} ${b.mismatch}/${b.of} — ${/^registry-judged/.test(b.gen) ? 'current emitter' : 'RETIRED emitter'}`);

  // The coverage view: which pairs have actually been OBSERVED, and whether the check can run for them at all.
  console.log('\n  DISTINCT PAIRS OBSERVED (union of the capped `samples` lists — a coverage view, NOT a count):');
  const rows = [...pairSeen.values()].sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  const unparseable = [];
  for (const s of rows) {
    const id = capture.chartInstrumentId(s.chartSymbol);
    const symbol = Object.prototype.hasOwnProperty.call(s, '_registry') ? s._registry : null;
    const v = capture.chartIdentityVerdict(s.chartSymbol, s.symbol, symbol);
    if (id == null) unparseable.push(s.symbol);
    console.log(`    ${String(s.symbol).padEnd(16)} ${String(s.chartSymbol).padEnd(11)} id=${String(id).padEnd(7)} `
      + `registry=${String(symbol == null ? '(none)' : symbol).padEnd(16)} -> ${v}`);
  }

  console.log('\n  AUTHORISATION QUESTION: does `mismatch` EVER fire on a healthy capture?');
  const cur = gens.get(current);
  const retired = [...gens.entries()].filter(([k]) => !/^registry-judged/.test(k));
  if (cur && cur.mismatch === 0) {
    console.log(`  ⇒ NO on the emitter running today: 0 mismatch in ${observed} recorded observation(s) over ${cur.n} event(s).`);
    console.log('    That is ONE of the two facts enforcement needs.');
  } else if (cur) {
    console.log(`  ⚠ YES — ${cur.mismatch} observation(s) on the CURRENT emitter. Do NOT enforce; a refusal costs real data.`);
  }
  for (const [, g] of retired) {
    console.log(`  ⚠ ${g.mismatch} mismatch(es) DO sit in the record, all of them from ${g.n} event(s) written by the RETIRED`);
    console.log('    emitter. Its samples carry no `registry` at all, so it could not have been judging against the');
    console.log(`    registry — and re-judging its own stored samples gives ${JSON.stringify(g.rejudged)}. The number is a`);
    console.log('    measurement of the pre-fix name comparison, NOT of the chart. Quoting it as chart behaviour was');
    console.log('    an error made twice on 2026-09-25 (mine, then the first version of this corrected count).');
  }
  const unregistered = cur ? cur.unregistered : 0;
  if (unregistered) {
    console.log(`  ⚠ AND: ${unregistered} observation(s) are \`unregistered\` (no registry row), so the check CANNOT RUN`);
    console.log('    for those symbols. Enforcing today would leave them entirely unguarded, and a guard that is');
    console.log('    ABSENT looks exactly like a guard that PASSED. THIS is the blocker, not the mismatch count.');
    if (unparseable.length) {
      console.log(`    (${unparseable.length} of ${rows.length} distinct pair(s) carry no parseable instrument id at all: ${unparseable.join(', ')})`);
    }
  }
  console.log();

  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
