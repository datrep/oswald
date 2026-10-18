// trading/routes.js — Trading Agent REST API (Phase 0).
// Mounted at /api/trading. Ping is public (health-style, no secrets leaked);
// settings/events are owner-scoped behind authenticateToken.
/* global document */ // one route builds a browser-context snippet for the bridge page
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { authenticateToken, ifToken } = require('./auth');
const store = require('./store');
const calendar = require('./agent/calendar');
const killswitch = require('./agent/killswitch');
const executor = require('./agent/executor');
const bars = require('./agent/bars');
const providers = require('./agent/providers');
const backtest = require('./agent/backtest');
const lab = require('./agent/lab/scoreboard'); // TRD-14: Strategy Lab scoreboard
const quant = require('./agent/quant'); // TRD-UI-8: the bar threshold, for the read-time annotation on /prompts

const router = express.Router();

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Ping: 3 checks — (1) migration 024 applied, (2) DeepSeek key works,
// (3) browser (LibreWolf BiDi / Chromium CDP fallback) is drivable.
// DeepSeek result cached 300s; browser probe result cached 120s.
// ---------------------------------------------------------------------------

const PROBE_SCRIPT = path.join(__dirname, 'scripts', 'browser-probe.js');
const PROBE_RESULT = path.join(__dirname, 'temp', 'browser-probe.json');
const PROBE_LOCK = path.join(__dirname, 'temp', 'browser-probe.lock');

let deepseekCache = { at: 0, value: null };
let probeRunning = false;
const DEEPSEEK_MODEL = require('./agent/deepseek').DEFAULT_MODEL; // single source of truth (2026-09-12 reroute)

function checkDeepSeekKey() {
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (!key) return { status: 'missing', ok: false };
  return { status: 'present', ok: true };
}

async function checkDeepSeekCall() {
  // Phase 0: validate the key with a minimal chat call (5s timeout).
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { status: 'missing', ok: false };
  if (process.env.TRADING_STUB_LLM === '1') return { status: 'stub', ok: true };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: [{ role: 'user', content: 'reply ok' }], max_tokens: 4, stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'error', ok: false, detail: `HTTP ${res.status} ${text.slice(0, 120)}` };
    }
    const data = await res.json().catch(() => null);
    return data && data.choices && data.choices.length
      ? { status: 'ok', ok: true, model: data.model || DEEPSEEK_MODEL }
      : { status: 'error', ok: false, detail: 'unexpected response shape' };
  } catch (e) {
    return { status: 'error', ok: false, detail: String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

async function deepseekCheck() {
  if (deepseekCache.value && Date.now() - deepseekCache.at < 300000) return deepseekCache.value;
  const value = await checkDeepSeekCall();
  deepseekCache = { at: Date.now(), value };
  return value;
}

function cachedProbe() {
  try {
    const stat = fs.statSync(PROBE_RESULT);
    if (Date.now() - stat.mtimeMs < 120000) return JSON.parse(fs.readFileSync(PROBE_RESULT, 'utf8'));
  } catch { /* none yet */ }
  return null;
}

function startProbe() {
  if (probeRunning) return { status: 'running' };
  try {
    if (fs.existsSync(PROBE_LOCK) && Date.now() - fs.statSync(PROBE_LOCK).mtimeMs < 120000) return { status: 'running' };
  } catch { /* no lock */ }
  probeRunning = true;
  fs.mkdirSync(path.dirname(PROBE_RESULT), { recursive: true });
  fs.writeFileSync(PROBE_LOCK, String(Date.now()));
  const child = spawn(process.execPath, [PROBE_SCRIPT], { windowsHide: true, cwd: path.join(__dirname, 'scripts') });
  let out = ''; let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('close', () => {
    probeRunning = false;
    try { fs.unlinkSync(PROBE_LOCK); } catch { /* ignore */ }
    try {
      const result = JSON.parse(out.trim() || 'null');
      if (result) fs.writeFileSync(PROBE_RESULT, JSON.stringify({ ...result, at: Date.now(), stderr: String(err).slice(0, 400) }));
      else fs.writeFileSync(PROBE_RESULT, JSON.stringify({ ok: false, error: 'probe produced no JSON', at: Date.now(), stderr: String(err).slice(0, 400) }));
    } catch (e) {
      fs.writeFileSync(PROBE_RESULT, JSON.stringify({ ok: false, error: `probe output unparseable: ${e.message}`, at: Date.now(), stderr: String(err).slice(0, 400) }));
    }
  });
  return { status: 'started' };
}

// F12 (2026-09-18): THE SELF-CHECK ROUTES NOW ANSWER EVERYONE AND ACT FOR THE OWNER ONLY.
//
// All three were reachable with no token on a listener bound to `0.0.0.0:8114`, and all three have a side
// effect: this GET starts a CHROME PROBE when its cache is empty (the same class of probe that destroyed
// the shared tab on 16/09), `?deep=1` spends an LLM call, and the two POSTs do one of each on demand.
// The liveness half stays public — a boot script must be able to ask "is the desk up?" — but it now
// answers without touching the bridge, the database budget or a model.
router.get('/ping', ifToken, h(async (req, res) => {
  if (!req.user) {
    return res.json({
      ok: true,
      detail: 'liveness only — the SQL / DeepSeek / browser self-check requires a token',
      checks: { sql: 'unchecked', deepseek: 'unchecked', browser: 'unchecked' },
    });
  }
  const sqlOk = await store.schemaProbe();
  const deepseek = req.query.deep === '1' ? await deepseekCheck() : (deepseekCache.value || (deepseekCache.value = { status: 'pending', ok: checkDeepSeekKey().ok }));
  let browser = cachedProbe();
  if (!browser) browser = startProbe();
  res.json({
    ok: sqlOk && deepseek.ok,
    checks: {
      sql: { ok: sqlOk, detail: sqlOk ? 'migration 024 applied' : 'TradingSettings table missing' },
      deepseek,
      browser,
    },
  });
}));

router.post('/ping/deepseek', authenticateToken, h(async (req, res) => {
  res.json(await deepseekCheck());
}));

router.post('/ping/browser', authenticateToken, h(async (req, res) => {
  const cached = cachedProbe();
  if (cached) return res.json(cached);
  res.json(startProbe());
}));

// ★★ TRD-RSK-2 (2026-09-27): WHY IS THE DESK NOT TRADING — AS A NUMBER, NOT AS PROSE.
//
// The owner's report was "positions getting capped ... then rejected (not like they LLM knows if it got rejected
// or not, its silent)". The refusal IS recorded, but only as a prose reason inside a wake event, and answering the
// question meant reading that prose against `agent/risk.js` to find which site set the flag. TRD-RSK-2's own
// investigation did exactly that and got it WRONG once. Two things fix it and both are now in the record:
//   · `risk.js` emits `vetoCodes` beside the sentences, so the cause is machine-readable (no prose parsing); and
//   · this route groups by them, so the answer is one call.
//
// ⚠ IT COUNTS WAKES, NOT EVENTS, AND THAT IS NOT PEDANTRY. One wake could write TWO events (the aggregator's and
// the pipeline's), so an event count over-reports by up to 2x — measured: 2,247 events were 1,426 wakes. Events
// are clustered by the SECOND plus the reason, because the two emitters differ by milliseconds and no real wake
// repeats within a second. (The duplicate emitter is fixed, but historical rows still need this.)
//
// ⚠ AND IT SAYS WHEN ITS OWN READ IS CAPPED. `store.listEvents` clamps to EVENT_QUERY_CAP and returns less without
// saying so — the TRD-77 defect, where a caller asking for more silently received a floor and reported it as a
// total. So `truncated` is returned when the cap is hit, and `windowStart` states the oldest wake actually read
// rather than the window that was requested.
router.get('/risk/refusals', authenticateToken, h(async (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 14));
  const since = new Date(Date.now() - days * 86400000);
  // ⚠ THE CAP COMES FROM THE STORE, NOT FROM A NUMBER TYPED HERE. The first version of this route asked for 1000
  // and compared the result against 1000, while `store.listEvents` clamps at `EVENT_QUERY_CAP` (500) — so the read
  // WAS truncated and `truncated` still reported false. That is the TRD-77 defect verbatim, reproduced in new code
  // within an hour of reading the comment that describes it. Reading the constant is the only way the clamp and
  // its detection cannot drift.
  const cap = store.EVENT_QUERY_CAP;
  const events = await store.listEvents(req.user.userID, { kind: 'wake', since, limit: cap });

  // The "why" lives in one of THREE fields depending on the emitter. Reading only `reason` is what made an earlier
  // census call 237 self-describing `market_closed` wakes "empty" — see TRD-WAK-1's retraction.
  const whyOf = (p) => p.reason
    || (p.skipped ? `skipped: ${p.skipped}` : null)
    || (p.failedStep ? `failed: ${p.failedStep}` : null)
    || (p.error ? `error: ${String(p.error).slice(0, 80)}` : null)
    || null;

  const layerOf = (why) => {
    const r = String(why || '');
    if (!r) return 'unrecorded';
    if (/^skipped:/.test(r)) return 'skipped_early';
    if (/^failed:|^error:/.test(r)) return 'error_thrown_step';
    if (/^risk veto:/i.test(r)) return 'risk_veto';
    if (/chair VETO|deliberation|chair unavailable/i.test(r)) return 'committee';
    if (/no_signal|no proposal/i.test(r)) return 'no_proposal';
    return 'other';
  };

  const seen = new Map();
  const byLayer = new Map();
  const byCode = new Map();
  let lastRefusal = null;
  for (const e of events) {
    const p = e.payload || {};
    const why = whyOf(p);
    const key = `${new Date(e.createdAt).toISOString().slice(0, 19)}|${why}`;
    if (seen.has(key)) continue;
    seen.set(key, 1);
    const layer = layerOf(why);
    byLayer.set(layer, (byLayer.get(layer) || 0) + 1);
    // The CODES, when the refusal came from the risk gate. `vetoCodes` is an array because one call can refuse
    // for more than one reason; each is counted, and the first is the one reached first.
    for (const d of (p.decisions || [])) {
      for (const c of (d.vetoCodes || [])) byCode.set(c, (byCode.get(c) || 0) + 1);
    }
    if (!lastRefusal && layer === 'risk_veto') {
      const d = (p.decisions || [])[0] || {};
      lastRefusal = { at: e.createdAt, symbol: d.symbol || null, codes: d.vetoCodes || [], reason: why };
    }
  }

  const wakes = seen.size;
  const share = (n) => (wakes ? +(n / wakes * 100).toFixed(1) : null);
  const sorted = (m) => [...m.entries()].map(([k, n]) => ({ key: k, n, sharePct: share(n) })).sort((a, b) => b.n - a.n);
  res.json({
    days, requestedSince: since.toISOString(), wakes, events: events.length, eventCap: cap,
    // ★ A CLAMPED READ IS REPORTED, NOT ABSORBED. `events === eventCap` means the window was cut short at the OLD
    // end, so the breakdown describes only the wakes that fitted — which is why `coveredSince` is returned
    // alongside: the requested window and the measured one are different facts and both belong in the answer.
    truncated: events.length >= cap,
    coveredSince: events.length ? events[events.length - 1].createdAt : null,
    byLayer: sorted(byLayer),
    byVetoCode: sorted(byCode),
    lastRefusal,
    note: 'Counts WAKES (events clustered by the second), because one wake could write two events. A risk veto '
      + 'happens BEFORE the committee, so llmCalled is false on those wakes and no seat is asked anything. '
      + '`byVetoCode` is empty before 2026-09-27: the codes were added that day, so earlier refusals carry prose '
      + 'only — their layer is still counted, their cause is not.',
  });
}));

// ★★ TRD-DAT-1 (2026-09-27): ASK THE DESK WHAT A DATE RANGE IS ALLOWED TO PROVE.
//
// The owner's design, and it is better than deleting data: *"mechanisms that allow an LLM to set the date range, and
// know of the timeline of features added in ... that'll be safer, and will notify the LLM every time it reads those
// data."* Deleting pre-policy rows removes the baseline that lets a reader tell policy from era; announcing the
// boundary leaves the data and removes the SILENCE.
//
// WHY IT IS AN ENDPOINT AND NOT A COMMENT. A comment is invisible to the read path an agent actually takes — it
// writes SQL or calls the API. Three answers are therefore offered, in the order an agent needs them:
//   · `?about=<date>`  — which regime was a single date in, and what that regime's data cannot prove;
//   · `?since=&until=` — every boundary the window SPANS, with the caveat attached to each;
//   · nothing at all   — the whole timeline, so an agent can discover the boundaries before choosing a window.
//
// ⚠ `safe: true` means the window sits inside ONE regime, which is the only condition under which a single mean is
// a description of one thing. It is returned as a boolean rather than as advice so a caller can refuse to report.
router.get('/epoch', authenticateToken, h(async (req, res) => {
  const epoch = require('./agent/epoch');
  const about = req.query.about || null;
  const since = req.query.since || null;
  const until = req.query.until || null;
  const wantsWindow = !!(since || until || about);

  // The materialised ranges, so the API and the DB views cannot disagree about where the boundaries are.
  let ranges = [];
  try {
    const r = await require('../shared/db').getPool();
    const q = await r.request().query('SELECT id, landedAt, nextLandedAt, rowId, title FROM FeatureEpochs ORDER BY landedAt');
    ranges = q.recordset.map((x) => ({
      id: x.id, landedAt: new Date(x.landedAt).toISOString().slice(0, 10),
      nextLandedAt: new Date(x.nextLandedAt).toISOString().slice(0, 10), rowId: x.rowId, title: x.title,
    }));
  } catch { /* the registry in the module is authoritative; the table is the SQL-facing copy */ }

  res.json({
    epoch: epoch.EPOCH,
    now: new Date().toISOString(),
    // The rule, stated as an instruction rather than as a description, because the reader may be a model.
    rule: `Report the WINDOW beside any number read from this desk, and do not report a single mean over a range that `
      + `crosses ${epoch.EPOCH} or spans any boundary in \`features\`. A number without a window is the defect this `
      + `endpoint exists to prevent. In raw SQL, read the \`v*WithEpoch\` views or join FeatureEpochs — epochId and `
      + `the notice come with the row.`,
    features: epoch.FEATURES.map((f) => ({ id: f.id, landedAt: f.landedAt, row: f.row, title: f.title, invalidates: f.invalidates })),
    sqlRanges: ranges,
    ...(wantsWindow ? { annotation: epoch.annotate({ since, until, about }) } : {}),
  });
}));

// --- settings (owner-scoped) -------------------------------------------------
// ★ TRD-DEL-1 (2026-09-25): THE PANEL PUBLISHES THE RESOLVED CHAIR ROSTER BESIDE THE STORED ONE.
// Every seat on the live config carried `persona: null`, so the settings UI rendered "seat default" three
// times — while `aggregator.chairVotes` fell back to the seat's POSITION and the seats really did vote as
// trend / risk / macro. The operator was tuning three chairs' weights and reading three chairs' reasons with
// no way to see which lens produced which. `chairsResolved` carries the persona that will ACTUALLY be sent,
// plus `personaSource`, so the panel can show `seat default -> risk`.
//
// ⚠ IT IS A SIBLING OF `chairs`, NEVER A MUTATION OF IT. `chairs` is what PUT round-trips, so annotating it in
// place would save the resolved personas back as though the operator had typed them — silently converting every
// "seat default" into an explicit configuration, which is a one-way change to the deliberation setup.
router.get('/settings', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json({
    ...settings,
    deliberation: {
      ...(settings.deliberation || {}),
      chairsResolved: require('./agent/aggregator').chairRoster(settings),
    },
    // ★ TRD-LLM-2 (#1413): WHICH RISK DIAL ACTUALLY BINDS, resolved in ONE place and published.
    // `riskPerTradePct` sets the base size and `maxRiskPerTradePct` recomputes it — and both divide by the SAME
    // effective stop distance, so the smaller ALWAYS wins. Live: declared 2%, cap 0.07%, so the realised risk per
    // trade is 0.07% and the operator's "risk per trade" slider is INERT. The panel renders this so the dial and
    // the prompt cannot disagree — a second derivation is exactly how a displayed number drifts from an applied
    // one (the TRD-DEL-1 lesson), and here the two agreeing IS the fix.
    riskResolved: require('./agent/promptBuilder').effectiveRiskPct(settings),
  });
}));

router.put('/settings', authenticateToken, h(async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  res.json(await store.saveSettings(req.user.userID, body));
}));

// --- events (owner-scoped) ---------------------------------------------------
router.get('/events', authenticateToken, h(async (req, res) => {
  res.json({ items: await store.listEvents(req.user.userID, { limit: req.query.limit || 50, kind: req.query.kind || null }) });
}));

// DESIGN BIBLE v1 Phase A: filtered, cursor-paginated log query over the
// shared envelope (stream/level/actor/action/correlationId/since/until).
router.get('/logs', authenticateToken, h(async (req, res) => {
  const q = req.query;
  res.json(await store.queryEvents(req.user.userID, {
    stream: q.stream || null,
    level: q.level || null,
    actor: q.actor || null,
    action: q.action || null,
    correlationId: q.correlationId || null,
    since: q.since || null,
    until: q.until || null,
    limit: q.limit || 100,
    cursor: q.cursor || null,
  }));
}));

router.post('/events', authenticateToken, h(async (req, res) => {
  const kind = String((req.body || {}).kind || 'note').slice(0, 32);
  const payload = (req.body || {}).payload ?? null;
  await store.logEvent(req.user.userID, kind, payload);
  res.status(201).json({ ok: true });
}));

// --- wake loop (TRD-1) -------------------------------------------------------
const waker = require('./agent/waker');

router.post('/wake', authenticateToken, h(async (req, res) => {
  const userInput = String((req.body || {}).userInput || '').trim().slice(0, 500) || null;
  const result = await waker.runWake(req.user.userID, 'manual', { manual: true, userInput });
  res.json(result);
}));

// TRD-9 H: soft pause — scheduled wakes stop, manual wakes still work.
router.post('/wake/pause', authenticateToken, h(async (req, res) => {
  const paused = !!(req.body || {}).paused;
  await store.saveSettings(req.user.userID, { wake: { paused } });
  if (paused) waker.stop();
  else await waker.start(req.user.userID);
  await store.logEvent(req.user.userID, 'system', { kind: paused ? 'waker_paused' : 'waker_resumed' });
  res.json({ paused, status: waker.status() });
}));

router.get('/wakes', authenticateToken, h(async (req, res) => {
  res.json({ items: await store.listPrompts(req.user.userID, { limit: req.query.limit || 20 }) });
}));

// News S2 (open-work §4.19, built 2026-10-03): the deterministic digest — read-only owner surface.
// NOTHING here is chair-facing (S3 is separately gated): this is a window onto NewsItems, nothing more.
router.get('/news', authenticateToken, h(async (req, res) => {
  const newsDigest = require('./agent/newsDigest');
  const per = Math.min(Math.max(1, Number(req.query.perSymbol) || 3), 5);
  const hours = Math.min(Math.max(1, Number(req.query.hours) || 48), 168);
  const rows = await store.listRecentNewsItems(req.user.userID, { sinceHours: hours, limit: 400 });
  res.json(newsDigest.buildDigest(rows, { perSymbol: per, sinceHours: hours }));
}));

// --- TRD-4: persistence views (trades ledger, prompts, bars) ------------------
router.get('/trades', authenticateToken, h(async (req, res) => {
  const items = await store.listTrades(req.user.userID, { limit: req.query.limit || 100 });
  // TRD-11: 1s live overlay from the frontend (current rate + net P/L).
  const live = require('./agent/accountPoller').getLivePositions();
  res.json({ items, live: live || null });
}));

router.get('/prompts', authenticateToken, h(async (req, res) => {
  const items = await store.listPrompts(req.user.userID, { limit: req.query.limit || 50 });
  // ⚠ THE THRESHOLD IS ANNOTATED AT READ TIME, NOT RE-DERIVED BY THE CLIENT. MIN_BARS lives in `quant` and the
  // UI must not carry a second copy of it. Annotating here rather than only at scan time also means a wake
  // PERSISTED BEFORE THE FIELD EXISTED still shows the threshold instead of only the verdict - which matters,
  // because a snapshot is read long after it was written.
  for (const p of items) {
    const snap = p && p.bundle && p.bundle.snapshot;
    if (!Array.isArray(snap)) continue;
    for (const s of snap) {
      if (s && s.minBars == null) s.minBars = quant.MIN_BARS;
    }
  }
  res.json({ items });
}));

router.get('/bars', authenticateToken, h(async (req, res) => {
  const tf = store.BAR_TIMEFRAMES.includes(req.query.timeframe) ? req.query.timeframe : '1h';
  const items = await store.listBars(req.user.userID, {
    timeframe: tf,
    symbol: req.query.symbol || null,
    limit: req.query.limit || 200,
  });
  res.json({ items, timeframe: tf, symbol: req.query.symbol || null });
}));

router.post('/bars/build', authenticateToken, h(async (req, res) => {
  res.json(await bars.buildAll(req.user.userID));
}));

// --- TRD-5: market data providers (Binance/OKX public REST) -------------------
router.post('/providers/snapshot', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json(await providers.snapshotAll(req.user.userID, settings));
}));

router.get('/providers/status', authenticateToken, h(async (req, res) => {
  const s = await providers.providerStatus(req.user.userID);
  res.json({ ...s, symbolMap: providers.SYMBOL_MAP });
}));

router.post('/providers/backfill', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  const tf = store.BAR_TIMEFRAMES.includes(b.timeframe) ? b.timeframe : '1h';
  const r = await providers.backfillBars(req.user.userID, {
    provider: String(b.provider || 'binance'),
    symbol: String(b.symbol || '').trim(),
    timeframe: tf,
    limit: b.limit || null,
    rangeDays: b.rangeDays || null,
  });
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

// TRD-9: best-effort bulk backfill for every mapped watchlist symbol across
// the requested timeframes. Serial + throttled (yahoo paces itself at 300ms).
router.post('/providers/backfill-all', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  const tfs = Array.isArray(b.timeframes) && b.timeframes.length
    ? b.timeframes.filter((t) => store.BAR_TIMEFRAMES.includes(t))
    : ['5m', '1h', '4h', '1d'];
  const settings = await store.getSettings(req.user.userID);
  const symbols = Array.isArray(b.symbols) && b.symbols.length
    ? b.symbols
    : (settings.watchlist?.symbols || []).map((s) => s.symbol);
  const enabled = settings.providers?.enabled || ['binance', 'okx', 'yahoo'];
  const results = [];
  let ok = 0;
  for (const symbol of symbols) {
    for (const tf of tfs) {
      for (const provider of enabled) {
        if (!(providers.SYMBOL_MAP[symbol] && providers.SYMBOL_MAP[symbol][provider])) continue;
        const r = await providers.backfillBars(req.user.userID, { provider, symbol, timeframe: tf });
        results.push({ provider, symbol, timeframe: tf, ...(r.error ? { error: r.error } : { bars: r.bars }) });
        if (r.bars) ok++;
      }
    }
  }
  res.json({ ok, attempts: results.length, results });
}));

router.get('/providers/coverage', authenticateToken, h(async (req, res) => {
  res.json({ items: await store.barsCoverage(req.user.userID) });
}));

// --- TRD-6: backtester --------------------------------------------------------
// PHASE 2 (2026-09-14): every path that COSTS a backtest seeds the venue basis first, so the spread
// and the per-side overnight funding come from the registry whenever it has them, and the run's
// provenance says which basis it used. Both halves are one call on purpose — a run that read the
// facts but forgot to hand them to the cost model would look exactly like one that had none.
// TRD-79 (2026-09-21): the same path also seeds the DERIVED spread basis, so a run priced from stored
// tick history says `tick_history_p75_derived` instead of falling back to the flat v1 dial — and so a
// symbol with no curated entry can be backtested against the cost the gates will actually use.
router.post('/backtest', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  const symbol = String(b.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  await require('./agent/instruments').seedDerivedSpreadBasis(req.user.userID).catch(() => ({ seeded: 0 }));
  const seeded = await require('./agent/instruments').seedBacktestCostBasis(req.user.userID).catch(() => ({ seeded: 0 }));
  const r = await backtest.runBacktest(req.user.userID, {
    symbol,
    venue: String(b.venue || 'plus500'),
    timeframe: store.BAR_TIMEFRAMES.includes(b.timeframe) ? b.timeframe : '1h',
    config: b.config || {},
    label: b.label || null,
    range: ['1w', '1m', '1y'].includes(b.range) ? b.range : null,
  });
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, venueBasisSeeded: seeded.seeded });
}));

// TRD-11: parameter sweep (local to the Backtest tab — never touches the live
// strategy). config.grid = {param:[values]}.
router.post('/backtest/sweep', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  const symbol = String(b.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  await require('./agent/instruments').seedDerivedSpreadBasis(req.user.userID).catch(() => ({ seeded: 0 }));
  await require('./agent/instruments').seedBacktestCostBasis(req.user.userID).catch(() => ({ seeded: 0 }));
  const r = await backtest.sweep(req.user.userID, {
    symbol,
    venue: String(b.venue || 'plus500'),
    timeframe: store.BAR_TIMEFRAMES.includes(b.timeframe) ? b.timeframe : '1h',
    config: b.config || {},
    range: ['1w', '1m', '1y'].includes(b.range) ? b.range : null,
  });
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

router.get('/backtests', authenticateToken, h(async (req, res) => {
  res.json({ items: await store.listBacktestRuns(req.user.userID, { limit: req.query.limit || 20 }) });
}));

// --- TRD-14: Strategy Lab scoreboard ------------------------------------------
// Register a candidate pair (strategy x symbol). registrationNo = the
// cumulative shots-on-goal counter k (352 prior configs + sequence).
router.post('/lab/register', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  const strategy = String(b.strategy || '').trim();
  const symbol = String(b.symbol || '').trim();
  if (!strategy || !symbol) return res.status(400).json({ error: 'strategy and symbol required' });
  const cnt = await store.countLabCandidates(req.user.userID);
  const registrationNo = lab.K_BASE + cnt + 1;
  const row = await store.createLabCandidate(req.user.userID, {
    strategy, symbol,
    venue: String(b.venue || 'yahoo'),
    params: b.params && typeof b.params === 'object' ? b.params : {},
    label: b.label || null,
    registrationNo,
  });
  res.json({ id: row.id, registrationNo: row.registrationNo, k: lab.K_BASE + cnt + 1, seed: lab.seedFor(registrationNo) });
}));

// Score one (or all) registered candidates through the rolling walk-forward.
router.post('/lab/score', authenticateToken, h(async (req, res) => {
  const id = req.body && req.body.id != null ? Number(req.body.id) : null;
  const candidates = id
    ? [await store.getLabCandidate(req.user.userID, id)].filter(Boolean)
    : await store.listLabCandidates(req.user.userID, { status: 'registered' });
  if (id && !candidates.length) return res.status(404).json({ error: 'candidate not found' });
  const out = [];
  for (const c of candidates) {
    const r = await lab.scoreCandidate(req.user.userID, c);
    out.push({ id: c.id, strategy: c.strategy, symbol: c.symbol, ok: !!r.ok, error: r.error || null, stages: r.score ? r.score.stages : null });
  }
  res.json({ items: out });
}));

// RELEASE: freeze all registered pairs, lockbox-score the FULL set, run the
// single BH pass (q = 0.10) + PRDS check, write verdicts. One shot.
router.post('/lab/release', authenticateToken, h(async (req, res) => {
  const r = await lab.releaseAll(req.user.userID);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

// Fresh-data gate retest for one candidate (fresh family k').
// seriesDays (optional): size the evaluated series at gate invocation
// (plan §14) — shortest series whose W4 is both fully post-development and
// clears the n>=20 floor; bounded by yahoo 1h depth (729d).
router.post('/lab/retest', authenticateToken, h(async (req, res) => {
  const id = Number((req.body || {}).id);
  if (!id) return res.status(400).json({ error: 'candidate id required' });
  const r = await lab.retestCandidate(req.user.userID, id, { venue: (req.body || {}).venue || null, seriesDays: (req.body || {}).seriesDays || null });
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

router.get('/lab/scoreboard', authenticateToken, h(async (req, res) => {
  res.json(await lab.scoreboard(req.user.userID));
}));

// P2-13b (2026-09-10): live-vs-backtest scorecard — per strategy: live
// ledger stats (listStrategyStats) beside the latest backtest run metrics.
router.get('/scorecard', authenticateToken, h(async (req, res) => {
  const [live, runs] = await Promise.all([
    store.listStrategyStats(req.user.userID),
    store.listBacktestRuns(req.user.userID, { limit: 100 }),
  ]);
  const latest = new Map();
  for (const run of runs) {
    if (run.strategy && !latest.has(run.strategy)) latest.set(run.strategy, run);
  }
  const items = live.map((s) => {
    const run = latest.get(s.strategyId);
    let bt = null;
    if (run) {
      try {
        const m = run.metrics || {};
        bt = {
          pf: m.cfd?.profitFactor ?? null,
          winRate: m.cfd?.winRate ?? null,
          trades: m.cfd?.trades ?? null,
          oosPnl: m.walkForward?.oosPnl ?? null,
          at: run.createdAt,
        };
      } catch { bt = null; }
    }
    const grossWin = Number(s.grossWin) || 0;
    const grossLoss = Number(s.grossLoss) || 0;
    return {
      strategy: s.strategyId,
      live: { n: s.n, winRate: s.winRate, pnl: s.pnl, pf: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 1000) / 1000 : null },
      // P2 follow-up (2026-09-10): n >= 50 goal tracker (success criterion (b)).
      goal: 50,
      toGo: Math.max(0, 50 - s.n),
      pct: Math.min(100, Math.round((s.n / 50) * 100)),
      backtest: bt,
    };
  });
  res.json({ items, goal: 50 });
}));

router.get('/status', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  // ★ P1a (2026-10-01): the DERIVED USD->SGD rate, surfaced because a rate nobody can see is a rate nobody can
  // check. It is computed from position rows the poller was already reading (see `agent/fxRate.js`), and a
  // refusal travels as `fx.reason` rather than as a missing key — "no rate" and "the rate is 1" must not look
  // the same to an operator either. Additive: nothing consumes it yet; P2 is what will.
  res.json({ ...waker.status(), paused: !!settings.wake?.paused, watchdog: require('./agent/watchdog').status(),
    fx: require('./agent/accountPoller').getFxRate() });
}));

// --- TRD-8: zombie watchdog (login-death + waker-stale detection) -------------
const watchdog = require('./agent/watchdog');

router.get('/watchdog', authenticateToken, h(async (req, res) => {
  res.json(watchdog.status());
}));

// TRD-45 Phase 0: read the instrument page the OPERATOR has navigated to and report which fields
// the venue exposes. Read-only by default: no navigation, no clicks, no close/disconnect.
// `?force=1` skips the wake guard (the bridge is shared with the live desk, so it is on by default).
// `select` (true = the selected/first row, or an instrument id) performs ONE click to open the
// instrument sidebar, which is the only way the contract spec can be read — it mounts on selection.
router.post('/instruments/probe', authenticateToken, h(async (req, res) => {
  const force = String(req.query.force || '') === '1' || !!(req.body && req.body.force);
  const label = String((req.body && req.body.label) || req.query.label || '');
  const raw = req.body && req.body.select;
  const select = raw == null || raw === false || raw === '' ? false : (raw === true || raw === 'true' ? true : raw);
  // `symbol` opens that instrument INSIDE the probe's page lock and then reads it. Without it the
  // caller has to issue /watchlist/open and /instruments/probe as two requests, and the desk's own
  // position mirror can move the shared tab in between — measured 2026-09-14: openInstrument
  // confirmed Geely Automobile, and the next probe read /open-positions with rowCount 0.
  const symbol = String((req.body && req.body.symbol) || req.query.symbol || '').trim() || null;
  const settings = symbol ? await store.getSettings(req.user.userID) : null;
  const out = await require('./plus500/instrumentProbe').run({ force, label, select, symbol, settings });
  // TRD-45 Phase 1: a PROBE is a capture. Persisting here rather than in a separate "save" step
  // means the registry can only ever hold something a human actually looked at, and the observation
  // document stays the raw record while the registry becomes the readable one.
  if (req.body && req.body.capture !== false) {
    try {
      out.registry = await require('./agent/instruments').captureFromObservation(req.user.userID, out);
    } catch (e) {
      out.registry = { error: String(e.message || e).slice(0, 160) };
    }
  }
  res.json(out);
}));

// TRD-45 Phase 0b: chain scan — walks every instrument row on the loaded page, clicking each one's
// Info chevron to read its contract spec. Holds the bridge lock for the whole walk, so `max` is
// clamped; a ticket waits for the lock rather than failing, but a large chain should not be scanned
// mid-session.
router.post('/instruments/scan', authenticateToken, h(async (req, res) => {
  const force = String(req.query.force || '') === '1' || !!(req.body && req.body.force);
  const label = String((req.body && req.body.label) || req.query.label || '');
  const max = Math.max(1, Math.min(100, Number((req.body && req.body.max) || req.query.max) || 25));
  const out = await require('./plus500/instrumentProbe').run({ force, label, scan: max });
  // A scan is the capture that MATTERS — it is the whole instrument family at once, which is the
  // only way the 600x spread in minimum size inside one underlying is visible in one row of data.
  if (req.body && req.body.capture !== false) {
    try {
      out.registry = await require('./agent/instruments').captureFromObservation(req.user.userID, out);
    } catch (e) {
      out.registry = { error: String(e.message || e).slice(0, 160) };
    }
  }
  res.json(out);
}));

// TRD-EXE-1 (#1454): MEASURE THE VENUE'S ORDER BOOK. This exists because item 4's classification half
// and item 2's cancel/adopt both need the order row's `data-testid` prefix, and NOTHING in this repo has
// ever seen it — no selector can be asserted, only observed.
//
// ⚠ IT HAS TO RUN IN THIS PROCESS. `pageLock` is IN-PROCESS mutual exclusion ("every desk flow lives in
// the service process"), so a standalone script cannot coordinate with a ticket and would navigate the
// shared tab out from under one — the exact race that killed order 6289 mid set-limits. Hence a route and
// not a CLI script.
//
// READ-ONLY: navigates, waits, reads, and parks the tab back on /open-positions. It contains no click,
// so it cannot cancel or modify an order at the venue. The cancel half of item 2 is NOT here and must be
// written separately and deliberately, against a testid this route has actually produced.
router.post('/orders/book-probe', authenticateToken, h(async (req, res) => {
  const force = String(req.query.force || '') === '1' || !!(req.body && req.body.force);
  const waker = require('./agent/waker');
  if (!force && waker.status().inProgress) {
    return res.json({ skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' });
  }
  const pageLock = require('./plus500/pageLock');
  const browser = require('./plus500/browser');
  const webtrader = require('./plus500/webtrader');
  // The mirror cycle is opportunistic and normally releases within its 60s cadence, but a degraded cycle
  // can hold the tab longer than a minute — measured 2026-09-29: `account_poll_stats workMsMax 20393` and
  // the first probe attempt got `bridge busy (mirror) — lock wait exceeded for ticket` at 60s. So the wait
  // is explicit and adjustable rather than a magic constant that reads as "the bridge is broken".
  const waitMs = Math.max(10000, Math.min(300000, Number((req.body && req.body.waitMs) || req.query.waitMs) || 120000));
  await pageLock.acquire('ticket', { waitMs });
  // NOTE: newPage() returns the SHARED Plus500 tab — never close it and never disconnect(); both kill
  // the shared bridge for every other flow.
  const page = await browser.newPage();
  let shape = null;
  try {
    shape = await webtrader.readOrderBookShape(page);
  } finally {
    // Park the tab back where the mirror poller expects it, EVEN IF THE READ THREW — a probe that
    // leaves the shared tab on /open-orders would silently disable the positions mirror.
    await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    pageLock.release('ticket');
  }
  res.json(shape);
}));

// TRD-TRL-3: MEASURE the venue's trailing-stop control, because the desk has never known its units.
//
// WHY THE READ LIVES IN THE SERVICE, exactly as `/orders/book-probe` does: `pageLock` is IN-PROCESS mutual
// exclusion, so a script that grabbed the shared tab itself could not coordinate with a ticket and would navigate
// it out from under one - the race that killed order 6289 mid set-limits.
//
// ⚠⚠ IT NEVER SUBMITS, AND THAT IS WHAT MAKES IT AFFORDABLE. Nothing is armed until `#trade-button` is clicked and
// no path in `probeTrailCurve` clicks it. The alternative - learning the control's range by attempting entries -
// cost eight refused entries in 2h09m before this route existed. The tab is parked back on /open-positions in a
// `finally`, because a probe that leaves the shared tab elsewhere silently disables the positions mirror.
router.post('/orders/trail-curve-probe', authenticateToken, h(async (req, res) => {
  const force = String(req.query.force || '') === '1' || !!(req.body && req.body.force);
  const waker = require('./agent/waker');
  if (!force && waker.status().inProgress) {
    return res.json({ skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' });
  }
  const body = req.body || {};
  const pageLock = require('./plus500/pageLock');
  const browser = require('./plus500/browser');
  const webtrader = require('./plus500/webtrader');
  const waitMs = Math.max(10000, Math.min(300000, Number(body.waitMs) || 120000));
  await pageLock.acquire('ticket', { waitMs });
  // NOTE: newPage() returns the SHARED Plus500 tab — never close it and never disconnect().
  const page = await browser.newPage();
  let out = null;
  try {
    const settings = await require('./store').getSettings(req.user.userID);
    out = await webtrader.probeTrailCurve(page, settings, {
      symbol: String(body.symbol || 'Oil'),
      direction: body.direction === 'sell' ? 'sell' : 'buy',
      counts: Array.isArray(body.counts) && body.counts.length ? body.counts.map(Number).filter((n) => n > 0) : undefined,
      methods: Array.isArray(body.methods) && body.methods.length ? body.methods.map(String) : undefined,
      stopPrice: Number(body.stopPrice) > 0 ? Number(body.stopPrice) : null,
      size: Number(body.size) > 0 ? Number(body.size) : null,
    });
  } finally {
    await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    pageLock.release('ticket');
  }
  res.json(out);
}));

// TRD-TRL-9 (2026-10-08) — THE READ-ONLY VERIFICATION VEHICLE for the post-entry trail engage.
//
// `commit: false` ALWAYS in this route: it exists to prove the whole mechanism against a LIVE position without
// writing — open the Edit card (Update-label guarded), engage the trail card, type the count, read the venue's
// OWN calculation back, close. The commit path (`setPositionTrail({commit:true})`) is reachable only from
// `agent/trailEngage`, and only when `risk.trailingStop.engageOnTouch.enabled === true` (default: false).
//
// `diagnostic`, NOT `expose-pending`: it navigates the SHARED bridge tab and fills (but never commits) a live card.
router.post('/orders/edit-trail-probe', authenticateToken, h(async (req, res) => {
  const force = String(req.query.force || '') === '1' || !!(req.body && req.body.force);
  const waker = require('./agent/waker');
  if (!force && waker.status().inProgress) {
    return res.json({ skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' });
  }
  const body = req.body || {};
  const tradeId = Number(body.tradeId);
  if (!Number.isInteger(tradeId) || tradeId <= 0) return res.status(400).json({ error: 'tradeId required' });
  const pageLock = require('./plus500/pageLock');
  const browser = require('./plus500/browser');
  const waitMs = Math.max(10000, Math.min(300000, Number(body.waitMs) || 120000));
  await pageLock.acquire('ticket', { waitMs });
  const page = await browser.newPage();
  let out = null;
  try {
    const settings = await store.getSettings(req.user.userID);
    const trades = await store.getOpenTrades(req.user.userID);
    const trade = trades.find((t) => Number(t.id) === tradeId);
    if (!trade) {
      out = { ok: false, reason: 'open_trade_not_found', tradeId };
    } else {
      out = await require('./plus500/webtrader').setPositionTrail(page, settings, trade, {
        trailDistance: Number(body.trailDistance) > 0 ? Number(body.trailDistance) : null,
        stopPrice: Number(body.stopPrice) > 0 ? Number(body.stopPrice) : null,
        commit: false,
      });
    }
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    pageLock.release('ticket');
  }
  res.json(out);
}));

// TRD-PRU-3 (2026-10-08) — THE READ-ONLY CANDIDATE SCREEN. Navigation only: each category page is loaded and
// every instrument row's own buy/sell is read off the table. No ticket, no click, no order; nothing on this
// route can commit anything, and it writes no settings — the live trading scope and era clock are untouched.
router.post('/orders/instrument-screen-probe', authenticateToken, h(async (req, res) => {
  const force = String(req.query.force || '') === '1' || !!(req.body && req.body.force);
  const waker = require('./agent/waker');
  if (!force && waker.status().inProgress) {
    return res.json({ skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' });
  }
  const body = req.body || {};
  const paths = Array.isArray(body.paths) && body.paths.length
    ? body.paths.map(String).slice(0, 12)
    : ['/trade/all-commodities', '/trade/cryptocurrencies'];
  const pageLock = require('./plus500/pageLock');
  const browser = require('./plus500/browser');
  const waitMs = Math.max(10000, Math.min(300000, Number(body.waitMs) || 120000));
  await pageLock.acquire('ticket', { waitMs });
  const page = await browser.newPage();
  let out = null;
  try {
    const settings = await store.getSettings(req.user.userID);
    out = await require('./plus500/webtrader').probeInstrumentPages(page, settings, { paths });
  } finally {
    await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    pageLock.release('ticket');
  }
  res.json(out);
}));

// TRD-PRU-3b (2026-10-08) — READ-ONLY PER-SYMBOL CHART BACKFILL. Focus-only: each symbol is reached through the
// ordinary search/navigation path and its chart series is read; no ticket interaction, no order, no settings
// write. The reader is the candidate-profile study, not a screen.
router.post('/orders/instrument-bars-probe', authenticateToken, h(async (req, res) => {
  const force = String(req.query.force || '') === '1' || !!(req.body && req.body.force);
  const waker = require('./agent/waker');
  if (!force && waker.status().inProgress) {
    return res.json({ skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' });
  }
  const body = req.body || {};
  const symbols = Array.isArray(body.symbols) ? body.symbols.map(String).filter(Boolean).slice(0, 12) : [];
  if (!symbols.length) return res.status(400).json({ error: 'symbols required (max 12)' });
  const pageLock = require('./plus500/pageLock');
  const browser = require('./plus500/browser');
  const waitMs = Math.max(10000, Math.min(300000, Number(body.waitMs) || 180000));
  await pageLock.acquire('ticket', { waitMs });
  const page = await browser.newPage();
  let out = null;
  try {
    const settings = await store.getSettings(req.user.userID);
    out = await require('./plus500/webtrader').probeInstrumentBars(page, settings, { symbols });
  } finally {
    await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    pageLock.release('ticket');
  }
  res.json(out);
}));

// ★★ EXE-14 S1 (2026-10-01) — READ THE POST-ENTRY `Edit` -> `Set Limits` PATH, AND WRITE NOTHING.
//
// EXE-14 anchors the stop to the FILL, so it must write a level on a LIVE position after the order is placed. That
// route is documented from an owner dump (2026-09-30) and has NEVER BEEN EXERCISED. The plan's first step is
// therefore to find out whether it is where the dump says — because if it is not, every later step is fiction.
//
// ⚠⚠ AND THE RECONNAISSANCE FOUND THE DUMP COVERS ONLY HALF THE PATH. Every `TradeSetLimits.*` testid in the repo
// belongs to the TICKET-TIME card, and the dump says that same card is reused post-entry — consistent, and testable.
// But the ROW's `Edit` control has NO recorded testid anywhere; the only trace is the body-text signal `\bEdit\b`,
// which detects the word and not the element. So phase one CLICKS NOTHING and reports what is actually there.
//
// ⚠ IT SUBMITS NOTHING AND TOGGLES NOTHING. Nothing on this path commits until a Save/Confirm is pressed, and this
// route never presses one. The only interaction that can move the venue is the Escape in the `finally`, which
// closes the card the probe itself opened.
//
// ⚠ THE TAB IS PARKED BACK IN A `finally`, because a probe that leaves the shared tab elsewhere silently disables
// the positions mirror.
router.post('/orders/position-levels-probe', authenticateToken, h(async (req, res) => {
  const force = String(req.query.force || '') === '1' || !!(req.body && req.body.force);
  const waker = require('./agent/waker');
  if (!force && waker.status().inProgress) {
    return res.json({ skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' });
  }
  const body = req.body || {};
  const pageLock = require('./plus500/pageLock');
  const browser = require('./plus500/browser');
  const waitMs = Math.max(10000, Math.min(300000, Number(body.waitMs) || 120000));
  await pageLock.acquire('ticket', { waitMs });
  const page = await browser.newPage();
  let out = null;
  try {
    const settings = await store.getSettings(req.user.userID);
    out = await require('./plus500/webtrader').probePositionLevels(page, settings, {
      edit: body.edit === true,
      rowIndex: Number.isInteger(Number(body.rowIndex)) ? Math.max(0, Number(body.rowIndex)) : 0,
    });
  } finally {
    // ⚠ THE ONE INTERACTION THAT MATTERS, AND IT ONLY EVER CLOSES. Escape is the documented way out of the card;
    // without it the shared tab is left holding a half-open dialog the mirror poller will read as a stuck page.
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    pageLock.release('ticket');
  }
  res.json(out);
}));

// EXE-NG-1 (2026-10-02): HOW DOES AN INSTRUMENT REACH ITS TICKET, AND WHAT IS THERE WHEN IT FAILS?
//
// The four Natural Gas failures of 2026-10-01 were recorded as eight identical words (`order ticket did not
// open`, `errorClass: "other"`) for TWO different faults — a ticket that never appeared (27s) and a ticket that
// appeared but whose submit never became clickable (50s). The discriminator (which click path was taken) was
// computed and thrown away.
//
// ⚠ THIS ROUTE IS READ-ONLY AND CANNOT PLACE ANYTHING. It reproduces the REACH phase of `placeOrder` — the
// row, then the category page, then the search fallback — and then STOPS: no size is entered and `#trade-button`
// is never clicked, so the ticket is inert (nothing on this venue is armed until that button is pressed). It
// ends with an Escape.
//
// `diagnostic`, NOT `expose-pending`: it navigates the SHARED bridge tab and clicks a live instrument row.
router.post('/orders/ticket-path-probe', authenticateToken, h(async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || '').trim();
  const direction = String(body.direction || 'buy');
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const waker = require('./agent/waker');
  if (waker.status().inProgress && !body.force) {
    return res.json({ skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' });
  }
  const pageLock = require('./plus500/pageLock');
  const browser = require('./plus500/browser');
  const wt = require('./plus500/webtrader');
  const waitMs = Math.max(10000, Math.min(300000, Number(body.waitMs) || 120000));
  await pageLock.acquire('ticket', { waitMs });
  const page = await browser.newPage();
  const out = { symbol, direction, via: null, ticketOpened: false, msToTicket: null, reachError: null, census: null };
  try {
    const settings = await store.getSettings(req.user.userID);
    await wt.gotoPage(page, 'trade', settings).catch(() => {});
    const t0 = Date.now();
    try {
      const reach = await wt.openTicket(page, settings, { symbol, direction });
      out.via = reach.via;
    } catch (e) { out.reachError = String((e && e.message) || e).slice(0, 200); }
    if (!out.reachError) {
      try {
        await page.waitForSelector('#amount-input', { timeout: 15000 });
        out.ticketOpened = true;
      } catch { out.ticketOpened = false; }
    }
    out.msToTicket = Date.now() - t0;
    // Whether or not the ticket opened, say what is actually on the page.
    out.census = await wt.ticketCensus(page);
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto('https://app.plus500.com/trade', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    pageLock.release('ticket');
  }
  res.json(out);
}));

// EXE-14 S2 — the LIVE verification for `webtrader.setPositionLevels`, and ⚠ **IT CANNOT MOVE A LEVEL.**
//
// It reads the venue's OWN value for the trade off the row and writes THAT value back. So what it proves is
// exactly the two things no unit test can: that `#trade-button` really COMMITS the edit card (its label is
// `Update` there, `Buy`/`Sell` on the ticket), and that a read-back taken from the ROW is the venue's
// post-commit state rather than the number we typed. The position's risk is arithmetically unchanged.
//
// ⚠ WHY THIS IS NOT WIRED TO THE EXECUTOR. Anything that can MOVE a stop belongs behind S4's gate and its
// default-OFF switch. A route that could move one would be a second, unguarded writer of the same fact.
//
// ⚠ `confirm: true` IS REQUIRED, so an accidental POST cannot drive the venue.
router.post('/orders/position-levels-verify', authenticateToken, h(async (req, res) => {
  const body = req.body || {};
  if (body.confirm !== true) return res.status(400).json({ error: 'confirm:true required — this drives the live venue' });
  const tradeId = Number(body.tradeId);
  if (!Number.isFinite(tradeId)) return res.status(400).json({ error: 'tradeId required' });

  const waker = require('./agent/waker');
  if (waker.status().inProgress && !body.force) {
    return res.json({ skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' });
  }
  const trade = await store.getTradeById(req.user.userID, tradeId);
  if (!trade) return res.status(404).json({ error: `no trade ${tradeId}` });
  if (trade.plus500PositionId == null) {
    return res.status(400).json({ error: `trade ${tradeId} carries no plus500PositionId — there is no venue row to target` });
  }

  const pageLock = require('./plus500/pageLock');
  const browser = require('./plus500/browser');
  const wt = require('./plus500/webtrader');
  const waitMs = Math.max(10000, Math.min(300000, Number(body.waitMs) || 120000));
  await pageLock.acquire('ticket', { waitMs });
  const page = await browser.newPage();
  try {
    const settings = await store.getSettings(req.user.userID);
    await wt.gotoPage(page, 'positions').catch(() => {});
    // ⚠ THE ROW IS NOT THERE THE MOMENT THE SHELL IS. `gotoPage` waits for BODY TEXT (40 chars); the positions
    // TABLE renders after it. Reading immediately returned `row_not_found` on the first live run (2026-10-02,
    // 2165ms) — fast enough to be obviously a race. Wait for a row exactly as `probePositionLevels` does, and
    // report the url when it still fails, so "wrong tab" and "slow page" are distinguishable rather than both
    // arriving as the same three words.
    await page.waitForFunction(() => document.querySelector('[data-testid^="OpenPosition."]'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const before = await wt.readRowLevels(page, trade.plus500PositionId);
    if (!before || !before.found) {
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="OpenPosition."]')].map((e) => e.getAttribute('data-testid')).slice(0, 20)).catch(() => []);
      return res.json({ ok: false, reason: 'row_not_found', tradeId, venueId: trade.plus500PositionId, rowText: (before && before.text) || null, url: String(page.url()).slice(0, 160), rowsOnPage: rows, ledger: { stopPrice: trade.stopPrice, takeProfitPrice: trade.takeProfitPrice } });
    }
    if (before.stopPrice == null && before.takeProfitPrice == null) {
      return res.json({ ok: false, reason: 'no_levels_on_venue', tradeId, venueId: trade.plus500PositionId, before });
    }
    // THE IDEMPOTENT WRITE: hand back exactly what the venue says it holds.
    const out = await wt.setPositionLevels(page, settings, trade, {
      stopPrice: before.stopPrice,
      takeProfitPrice: before.takeProfitPrice,
    });
    res.json({
      verification: 'idempotent — the venue value is written back to itself, so no level moves',
      tradeId, venueId: trade.plus500PositionId,
      ledger: { stopPrice: trade.stopPrice, takeProfitPrice: trade.takeProfitPrice },
      ...out,
    });
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    pageLock.release('ticket');
  }
}));

// TRD-45 Phase 1: read the registry. `floor` answers the question the sizing path asks (what is the
// venue's minimum for this symbol, and can we trust it), kept next to the raw rows so a wrong size
// can be traced to the capture that produced it.
router.get('/instruments', authenticateToken, h(async (req, res) => {
  const venue = String(req.query.venue || 'plus500');
  const items = await require('./store/instruments').listInstruments(req.user.userID, { venue });
  const symbol = req.query.symbol ? String(req.query.symbol) : null;
  // The coverage counts are the honest header: how many instruments carry a usable minimum, and
  // how many were captured while the market was shut (which is fine for metadata, fatal for a cost).
  const withMinimum = items.filter((i) => i.unitAmount != null && Number(i.unitAmount) > 0).length;
  const byClass = {};
  for (const i of items) byClass[i.instrumentClass] = (byClass[i.instrumentClass] || 0) + 1;
  const out = {
    venue,
    coverage: {
      instruments: items.length,
      withMinimum,
      missingMinimum: items.length - withMinimum,
      byClass,
      options: items.filter((i) => i.instrumentClass === 'option').length,
      capturedClosed: items.filter((i) => i.marketStateAtCapture === 'closed').length,
      newestCaptureAt: items.reduce((m, i) => (!m || (i.capturedAt && i.capturedAt > m) ? i.capturedAt : m), null),
    },
    items,
  };
  if (symbol) out.floor = await require('./agent/instruments').resolve(req.user.userID, { venue, symbol });
  res.json(out);
}));

// The quote read, gated the same way the cost model gates: only quotes captured while the venue
// said the market was OPEN, and never older than the window. A caller cannot ask for the closed one.
router.get('/instruments/quote', authenticateToken, h(async (req, res) => {
  const venue = String(req.query.venue || 'plus500');
  const symbol = String(req.query.symbol || '');
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const maxAgeHours = Math.max(1, Math.min(720, Number(req.query.maxAgeHours) || 72));
  const reg = require('./store/instruments');
  const usable = await reg.getUsableQuote(req.user.userID, { venue, symbol, maxAgeHours });
  const recent = await reg.listQuotes(req.user.userID, { venue, symbol, limit: 20 });
  res.json({
    venue, symbol, maxAgeHours,
    usable: usable ? { buy: usable.buy, sell: usable.sell, spread: usable.spread, capturedAt: usable.capturedAt } : null,
    // Why it is unusable, when it is — "no open-market quote" and "no quote at all" are different
    // facts and the second one means nobody has captured this instrument yet.
    reason: usable ? null : (recent.length ? `no open-market quote in the last ${maxAgeHours}h (${recent.length} quote(s) on file, newest marketState=${recent[0].marketState})` : 'no quotes captured for this symbol'),
    recent: recent.slice(0, 5),
  });
}));

// --- TRD-10: strategy registry + Meta Ultimate shadow + multi-factor --------
router.get('/strategies', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const strategies = require('./agent/strategies');
  const analytics = require('./agent/analytics');
  const s = settings.strategies || {};
  const enabled = s.enabled || [];
  const symbolScope = s.symbolScope || {};
  // TRD-91 (2026-09-18): THE EFFECTIVE SET, not `enabled`. An explicit symbolScope entry REPLACES the
  // global enabled list for that symbol, so `list()`'s `enabled: enabled.includes(id)` reported rsi2 as
  // OFF in this very tab while rsi2 was LIVE on Bitcoin and holding the largest closed sample on the
  // desk. The panel that is supposed to say what the desk may trade said the opposite of the truth.
  // Computed with the SAME helper the parity harness uses, so the display and the safety net cannot
  // disagree about what is live (the F21 lesson: one source of truth per fact).
  const items = strategies.list(settings);
  const wl = ((settings.watchlist || {}).symbols || []).map((x) => x.symbol).filter(Boolean);
  // TRD-116 (2026-09-25): THE UNIVERSE IS THE WATCHLIST, because only a watchlist symbol can trade. It is
  // passed in because "can this strategy run anywhere" cannot be answered without it — the previous version
  // answered from the two settings lists alone and called an enabled strategy on an absent scope key
  // unreachable, while the resolver ran it on every unlisted symbol.
  const { isLive, scopeSymbolsFor, reachableAnywhere, othersDefault, reachabilityKnown } =
    analytics.strategyLiveness(enabled, symbolScope, wl);
  const scopeSymbols = Object.keys(symbolScope).filter((k) => k !== 'others' && k !== '*');
  const symbols = [...new Set([...wl, ...scopeSymbols])];
  const quant = require('./agent/quant');
  const perSymbol = symbols.map((sym) => ({
    symbol: sym,
    strategies: quant.scopedStrategyIds(enabled, symbolScope, sym),
    viaScope: Object.prototype.hasOwnProperty.call(symbolScope, sym),
  })).filter((r) => r.strategies.length || r.viaScope);
  const notes = [];
  for (const it of items) {
    const via = scopeSymbolsFor(it.id);
    // Same three cases as the parity harness, and the third is NOT a defect (TRD-91): a scope entry naming a
    // strategy absent from `enabled` REPLACES the global list, so the strategy is live and tradeable.
    const viaDefault = !enabled.includes(it.id) && Array.isArray(othersDefault) && othersDefault.includes(it.id);
    if (via.length && !enabled.includes(it.id)) {
      notes.push({ level: 'warn', strategy: it.id, reason: `LIVE on ${via.join(', ')} through symbolScope while NOT in strategies.enabled — the enable checkbox below does not control this` });
    } else if (viaDefault) {
      notes.push({ level: 'warn', strategy: it.id, reason: `LIVE through the symbolScope DEFAULT key (${JSON.stringify(othersDefault)}) while NOT in strategies.enabled — the same override applied to every symbol without an explicit entry` });
    } else if (enabled.includes(it.id) && reachabilityKnown && !reachableAnywhere(it.id)) {
      // ★ Gated on `reachabilityKnown`: with an unreadable watchlist this claim would be an absence nobody
      // measured, which is the precise failure this check was corrected for on 2026-09-25.
      notes.push({ level: 'warn', strategy: it.id, reason: `in strategies.enabled but it can run on NONE of the ${wl.length} watchlist symbol(s) — so the setting does nothing` });
    }
  }
  res.json({
    items: items.map((it) => ({ ...it, live: isLive(it.id), viaScope: scopeSymbolsFor(it.id) })),
    enabled, symbolScope, othersDefault, perSymbol, notes,
  });
}));

// --- TRD-75: the instrument <-> (strategy, params) BINDING, and the independent reviewer -----------
// GET is read-only: the current binding with the provenance of every parameter, the config problems,
// what physical telemetry exists and what the desk is BLIND to, and the last proposal with its verdict.
router.get('/binding', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const symbols = ((settings.watchlist || {}).symbols || []).map((s) => s.symbol);
  const binding = require('./agent/binding');
  const registry = require('./agent/strategies');
  const telemetry = require('./agent/telemetrySources');
  const proposer = require('./agent/bindingProposer');
  const last = await store.listEvents(req.user.userID, { kind: 'binding_proposal', limit: 1 }).catch(() => []);
  // TRD-84 question 2 (2026-09-22): SHOULD A REFUSAL BE VISIBLE? It was RECORDED AND READ BY NOBODY - the
  // wake logs `binding_proposer_skipped` and nothing anywhere consumed it, so a reviewer that was refused (or
  // simply not due) was indistinguishable from a reviewer that had nothing to say. That is the same shape as
  // TRD-77: a control that fails silently needs a detector. The read is a SOURCE-filtered latest event, which
  // is what F32 added `source` to `latestEvent` for - filtering in SQL rather than paging rows and hoping the
  // skip is inside the page.
  const lastSkip = await store.latestEvent(req.user.userID, 'telemetry', { source: 'binding_proposer_skipped' })
    .then((e) => (e ? { at: e.createdAt, reason: (e.payload && e.payload.reason) || null, stranded: !!(e.payload && e.payload.stranded) } : null))
    .catch(() => null);
  const cfg = settings.bindingProposer || {};
  res.json({
    table: binding.bindingTable(settings, { symbols, registry }),
    problems: binding.validate(settings, { symbols, registry }),
    telemetry: telemetry.coverage(symbols),
    telemetrySummary: telemetry.describe(symbols),
    proposer: { enabled: cfg.enabled === true, minIntervalH: Number(cfg.minIntervalH) || 12, promptVersion: proposer.PROMPT_VERSION },
    lastProposal: last && last[0] ? { at: last[0].createdAt, payload: last[0].payload } : null,
    lastSkip,
  });
}));

// POST runs the reviewer. It PROPOSES and RECORDS and writes no settings - `wouldWrite` is what it
// would have written, and applying it stays a deliberate act.
router.post('/binding/propose', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const out = await require('./agent/bindingProposer').propose(req.user.userID, settings, { force: !!(req.body && req.body.force) });
  res.json(out);
}));

// --- TRD-76: the WIRED physical sources, their recorded values, and the pull -----------------------
// GET is read-only: which sources are wired, what they last returned, and what the reviewer would be
// shown. The values carry their own as-of and age, recomputed at READ time so a figure cannot be
// presented as current because it was recorded recently.
router.get('/telemetry/values', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const symbols = ((settings.watchlist || {}).symbols || []).map((s) => s.symbol);
  const values = require('./agent/telemetry/values');
  const latest = await values.latest(req.user.userID, { days: Number(req.query.days) || 30 });
  res.json({
    wired: require('./agent/telemetry').ids(),
    coverage: require('./agent/telemetrySources').describe(symbols),
    latest,
    forReviewer: values.render(latest, symbols),
  });
}));

// POST pulls every wired source now. Deliberate act: the wake path calls the same function on a 12h
// cadence, so this exists to prove the pipeline on demand rather than to be the normal driver.
router.post('/telemetry/collect', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const symbols = ((settings.watchlist || {}).symbols || []).map((s) => s.symbol);
  const out = await require('./agent/telemetry/values').record(req.user.userID, { symbols, store });
  res.json({ collected: out.written.length, results: out.written.map((w) => ({ sourceId: w.sourceId, ok: w.ok, reason: w.reason, asOf: w.asOf, rows: w.rows })) });
}));

router.get('/meta', authenticateToken, h(async (req, res) => {
  const items = await store.listEvents(req.user.userID, { limit: 20, kind: 'meta' });
  res.json({ latest: items[0] || null, items });
}));

router.get('/multi', authenticateToken, h(async (req, res) => {
  const items = await store.listEvents(req.user.userID, { limit: 10, kind: 'multi_signal' });
  res.json({ latest: items[0] || null, items });
}));

// --- TRD-11: market pulse + central AI + paper trading ----------------------
router.get('/pulse', authenticateToken, h(async (req, res) => {
  const items = await store.listEvents(req.user.userID, { limit: 20, kind: 'pulse' });
  const errs = await store.listEvents(req.user.userID, { limit: 10, kind: 'error' });
  const lastError = (errs || []).find((e) => e.payload && e.payload.where === 'pulse');
  res.json({ latest: items[0] || null, items, lastError: lastError || null });
}));

router.post('/pulse/run', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const scope = req.body && req.body.scope != null ? String(req.body.scope) : 'all';
  const pulse = await require('./agent/pulse').generatePulse(req.user.userID, settings, { force: true, scope });
  res.json(pulse);
}));
// 2026-09-11: alternative-proxy agent — for an instrument the desk cannot
// evaluate, propose correlated tradable alternatives (and pulse the best).
router.post('/alternatives', authenticateToken, h(async (req, res) => {
  const symbol = String((req.body && req.body.symbol) || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  const settings = await store.getSettings(req.user.userID);
  res.json(await require('./agent/alternatives').suggest(req.user.userID, settings, {
    symbol,
    reason: String((req.body && req.body.reason) || 'manual').slice(0, 60),
    pulse: req.body.pulse !== false,
    force: req.body.force === true,
  }));
}));

router.get('/alternatives', authenticateToken, h(async (req, res) => {
  res.json({ items: await store.listEvents(req.user.userID, { limit: 10, kind: 'alternatives' }) });
}));
// TRD-11: rebase the kill-switch baseline to the CURRENT demo equity.
router.post('/kill/baseline', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const live = require('./agent/accountPoller').getLive();
  const equity = live && live.equity != null ? live.equity : null;
  if (equity == null) return res.status(400).json({ error: 'no live account strip yet — bridge must be on the Plus500 page' });
  await store.saveSettings(req.user.userID, { ...settings, kill: { ...settings.kill, initialEquity: equity } });
  res.json({ initialEquity: equity });
}));

router.get('/paper', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const paper = require('./agent/paper');
  const [equity, open, closed, central, errs] = await Promise.all([
    paper.equity(req.user.userID, settings),
    store.listPaperTrades(req.user.userID, { status: 'open', limit: 50 }),
    store.listPaperTrades(req.user.userID, { status: 'closed', limit: 50 }),
    store.latestEvent(req.user.userID, 'central'),
    store.listEvents(req.user.userID, { limit: 10, kind: 'error' }),
  ]);
  const lastError = (errs || []).find((e) => e.payload && ['central', 'paper_execute'].includes(e.payload.where));
  res.json({
    enabled: !!(settings.paper && settings.paper.enabled),
    config: settings.paper,
    centralThinking: !!(settings.central && settings.central.thinking !== false),
    equity,
    open,
    closed,
    lastCentral: central || null,
    lastError: lastError || null,
  });
}));

// Manual paper trade from the dashboard (feedback = the open row + event).
router.post('/paper/open', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  const symbol = String(b.symbol || '').trim();
  if (!symbol || !['buy', 'sell'].includes(b.direction)) {
    return res.status(400).json({ error: 'symbol + direction (buy|sell) required' });
  }
  const settings = await store.getSettings(req.user.userID);
  const row = await require('./agent/paper').openManual(req.user.userID, settings, {
    symbol, direction: b.direction, sizePct: b.sizePct != null ? Number(b.sizePct) : null,
  });
  res.status(201).json({ ok: true, trade: row });
}));

// TRD-11: Plus500 demo account strip — live mirror (in-memory) + history.
router.get('/account', authenticateToken, h(async (req, res) => {
  const items = await store.listEvents(req.user.userID, { limit: 20, kind: 'account' });
  res.json({
    latest: items[0] || null,
    live: require('./agent/accountPoller').getLive(),
    items,
  });
}));

// TRD-11: one machine-state tree (central AI + dashboard + concierge).
router.get('/state', authenticateToken, h(async (req, res) => {
  res.json(await require('./agent/stateTree').buildStateTree(req.user.userID));
}));

// Owner Q&A — "what are you doing?" (fact-grounded from the state tree).
router.post('/ask', authenticateToken, h(async (req, res) => {
  res.json(await require('./agent/ask').askQuestion(req.user.userID, req.body && req.body.question));
}));

// TRD-12: one-by-one exit review of open positions (manual trigger).
router.post('/review/run', authenticateToken, h(async (req, res) => {
  const userId = req.user.userID;
  const settings = await store.getSettings(userId);
  const sim = !!(settings.paper && settings.paper.enabled);
  // Manual run = review EVERY open position (the background loop stays
  // round-robin one-per-cycle).
  const r = sim
    ? await require('./agent/review').reviewSim(userId, settings, { all: true })
    : await require('./agent/review').reviewDemo(userId, settings, { all: true });
  res.json(r);
}));

// TRD-12: background-script inventory (what runs, cadence, what navigates).
router.get('/scripts', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json({ items: await require('./agent/scripts').inventory(req.user.userID, settings) });
}));

// F32 (2026-09-18): THE HEADER'S SECOND QUESTION — is the desk's DATA still arriving?
//
// The banner's `Data` chip used to be computed entirely in the browser, from whether each panel's own API
// call had succeeded. That is a true and useless answer: during the 2026-09-17 outage every panel loaded
// fine, so the chip read `fresh` for ~16 hours while the venue feed was frozen. This route answers the
// question the operator was actually asking, from stored facts only (it never touches the bridge, because
// a health check that needs the thing it checks is not a check).
router.get('/data-plane', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const scripts = require('./agent/scripts');
  const dataPlane = require('./agent/dataPlane');
  // The registry is passed in rather than read inside the verdict: `overdue` is decided in ONE place
  // (`scripts.inventory`), so the card and this chip can never disagree about whether a process has stopped.
  const items = await scripts.inventory(req.user.userID, settings);
  const verdict = await dataPlane.status(req.user.userID, settings, { scripts: items });
  res.json({ ...verdict, chip: dataPlane.chipText(verdict) });
}));

// TRD-12 Phase 1: quarantine review + flagged-bar rebuild.
router.get('/quarantine', authenticateToken, h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  res.json({ items: await store.listQuarantined(req.user.userID, limit) });
}));

router.post('/bars/rebuild', authenticateToken, h(async (req, res) => {
  const userId = req.user.userID;
  const deleted = await store.deleteFlaggedBars(userId);
  // Rebuild hourly/daily from the now-validated tick store.
  const built = await require('./agent/bars').buildAll(userId);
  await store.logEvent(userId, 'telemetry', { source: 'bars_rebuild', deletedFlagged: deleted, ...built });
  res.json({ deletedFlagged: deleted, rebuilt: built });
}));

// --- TRD-12 Phase 2: learning loop + risk + whitepaper + budget --------------
router.get('/equity', authenticateToken, h(async (req, res) => {
  const mode = req.query.mode === 'sim' ? 'sim' : 'demo';
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  res.json({ items: await require('./agent/analytics').equityCurve(req.user.userID, { mode, limit }) });
}));

// 2026-09-11: live equity strip history (kind 'account' events) — the fine-
// grained series behind the equity chart (>=30s cadence, no payload bloat).
// Now ALSO serves the persisted fine ticks (EquityTicks, <=5s): ticks are the
// series of record where they exist; account events only fill the span BEFORE
// the first tick, so a page reload shows the same fine curve as the live tab.
router.get('/equity/live', authenticateToken, h(async (req, res) => {
  const hours = Number(req.query.hours) || 48;
  const limit = Number(req.query.limit) || 4000;
  // 2026-09-24: the chart grew 6h/1d/3d/1w, so this must be able to serve ~80k fine ticks
  // (MEASURED 1w = 80,220 rows on 2026-09-24). `limit` above is the COARSE events cap; ticks get
  // their own, larger one. Before this the route called listEquityTicks without a limit, so the
  // store default (40,000) applied — and reusing the events `limit` here would have cut a week to
  // its newest 4,000 rows.
  const tickLimit = Math.min(Math.max(Number(req.query.tickLimit) || 40000, 10), 200000);
  const [events, ticks] = await Promise.all([
    store.listAccountEquity(req.user.userID, { hours, limit }),
    store.listEquityTicks(req.user.userID, { hours, limit: tickLimit }).catch(() => []),
  ]);
  const firstTickAt = ticks.length ? new Date(ticks[0].at).getTime() : Infinity;
  const olderEvents = events.filter((e) => new Date(e.createdAt).getTime() < firstTickAt);
  // ⚠ SAY WHEN THE SERIES WAS CLIPPED. listEquityTicks is `TOP(@limit) ... ORDER BY at DESC`, so an
  // over-cap window returns its NEWEST rows and drops the OLDEST — a full-width axis over a
  // half-populated series, which is the silent lie the F7 right-edge pin exists to prevent.
  // `>=` can raise a false alarm when the window holds exactly tickLimit rows; that direction is
  // deliberate, because a spurious "incomplete" is cheap and a silent truncation is not.
  res.json({ events: olderEvents, ticks, items: olderEvents, truncated: { ticks: ticks.length >= tickLimit } });
}));

router.get('/analytics/strategies', authenticateToken, h(async (req, res) => {
  const analytics = require('./agent/analytics');
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  // ★ `week=1` = week-to-date from Monday 00:00 UTC, resolved HERE rather than in the browser (one
  // definition, one clock). The three modes are mutually exclusive and the response says which one ran, so
  // a number on the dashboard can never be read against the wrong window.
  const wantWeek = String(req.query.week || '') === '1';
  const sinceRaw = req.query.since ? new Date(String(req.query.since)) : null;
  const since = wantWeek
    ? analytics.weekStartUtc()
    : (sinceRaw && Number.isFinite(sinceRaw.getTime()) ? sinceRaw : null);
  const out = await analytics.drift(req.user.userID, { days, since });
  res.json({
    ...out,
    window: {
      mode: wantWeek ? 'week_to_date' : (since ? 'since' : 'rolling_days'),
      days,
      since: since ? since.toISOString() : null,
      label: wantWeek
        ? `this week (since ${since.toISOString().slice(0, 16).replace('T', ' ')} UTC)`
        : (since ? `since ${since.toISOString().slice(0, 16).replace('T', ' ')} UTC` : `last ${days} days`),
    },
  });
}));

router.post('/autopsy/backfill', authenticateToken, h(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.body && req.body.limit) || 50, 1), 500);
  // `force` recomputes rows that already carry metrics — used once to repair the
  // shorts whose MFE/MAE were inverted before 2026-09-12.
  const force = !!(req.body && req.body.force);
  res.json(await require('./agent/autopsy').backfill(req.user.userID, { limit, force }));
}));

router.get('/whitepaper', authenticateToken, h(async (req, res) => {
  const events = await store.listEvents(req.user.userID, { kind: 'whitepaper', limit: 30 });
  const byTier = {};
  for (const e of events) if (!byTier[e.payload?.tier]) byTier[e.payload.tier] = e.payload;
  res.json({ latest: byTier, history: events.slice(0, 10) });
}));

router.post('/whitepaper/generate', authenticateToken, h(async (req, res) => {
  // TRD-WP-1 (#1502): `{ force: true }` REWRITES the current-period tiers. The dashboard button sends it (an
  // explicit human action); wake-path calls remain period-throttled, so no cadence logic rewrites silently.
  const force = (req.body || {}).force === true;
  res.json({ generated: await require('./agent/whitepaper').ensureCurrent(req.user.userID, await store.getSettings(req.user.userID), { force }), forced: force });
}));

// ★ THE PER-INSTRUMENT COST FLOOR FOR THE STOP CAP (2026-09-25). The owner asked for a slider to move the stop
// cap, and a slider alone would be a trap: `stopPolicy.costShareCheck` computes
//     costShare = venue round trip % / stop cap %
// so a TIGHTER cap RAISES the cost share, and past the ceiling the risk gate REFUSES the entry outright. The
// minimum cap an instrument can carry is therefore `roundTrip / ceiling` — a measured number, not a taste.
//
// MEASURED on 2026-09-25 at cap 0.30% / ceiling 0.65: Silver's round trip is 0.1936% → costShare 0.6453, i.e.
// 0.002 of a percentage point below the ceiling, and **Bitcoin's 0.25% gives 0.8333, which is OVER it** — so
// Bitcoin is refused by the cost ceiling at the cap the desk was running. That is exactly the "positions getting
// capped, then rejected" the owner observed, and it is why this endpoint exists: the control must be able to say
// which instruments a given cap would exclude BEFORE it is saved.
//
// ⚠ THERE ARE TWO CAP RULES AND THE FLOOR IS THE STRICTER OF THEM, not one of them:
//   (a) `adverseStopCap` REFUSES the cap itself (falling back to the declared stop) when `cap < costPct x
//       maxAdverseCostMultiple`; and
//   (b) `cappedStopDistance` -> `costShareCheck` refuses the trade when `costPct / cap > maxCostShareOfR`.
// So `minCapPct = max(costPct / ceiling, costPct x mult)`. Live values are ceiling 0.65 (-> x1.5385) and mult
// 1.5, so (b) binds — but if the owner ever LOOSENS the ceiling past 0.667 the `x1.5` floor takes over, and an
// endpoint that only knew rule (b) would then under-report the floor and bless a cap that silently refuses.
router.get('/risk/cost-floors', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const stopPolicy = require('./agent/stopPolicy');
  const ceiling = stopPolicy.costCeiling(settings);
  const mult = Number((settings.risk || {}).maxAdverseCostMultiple) || 1.5;
  const backtest = require('./agent/backtest');
  const venueComparability = require('./agent/venueComparability');
  const universe = require('./scopeResolution').watchlistSymbols(settings.watchlist);
  const items = [];
  for (const symbol of universe) {
    let costPct = null;
    let basisLabel = null;
    try {
      const cfg = backtest.costCfgFor(symbol);
      const bps = venueComparability.roundTripBpsFromCfg(cfg);
      if (Number.isFinite(bps)) costPct = bps / 100;
      // WHY a symbol is expensive is as actionable as how expensive — a captured venue spread is a fact and
      // must not be "fixed", a flat v1 fallback is a gap that can be filled.
      basisLabel = (cfg && cfg.costModelBasis && (cfg.costModelBasis.label || cfg.costModelBasis.origin)) || cfg.costModelVersion || null;
    } catch { costPct = null; }
    items.push({
      symbol,
      costPct,
      basis: basisLabel,
      // null, never 0, when there is no cost basis: "no basis" is a state, not a zero.
      minCapPct: costPct == null ? null : +Math.max(costPct / ceiling.share, costPct * mult).toFixed(4),
      capFloorPct: costPct == null ? null : +(costPct * mult).toFixed(4),
      ceilingFloorPct: costPct == null ? null : +(costPct / ceiling.share).toFixed(4),
    });
  }
  // Worst first: the instrument that constrains the slider is the one with the highest floor.
  items.sort((a, b) => (b.minCapPct == null ? -1 : b.minCapPct) - (a.minCapPct == null ? -1 : a.minCapPct));
  res.json({
    ceiling: ceiling.share, ceilingFrom: ceiling.from, capMultiple: mult,
    currentCapPct: Number((settings.risk || {}).maxAdversePct) || 0,
    currentTpOffsetPct: Number((settings.risk || {}).takeProfitOffsetPct) || 0,
    // What a GLOBAL cap must be for nothing to be excluded — the one number the slider needs.
    globalMinCapPct: items.reduce((m, x) => (x.minCapPct != null && x.minCapPct > m ? x.minCapPct : m), 0) || null,
    items,
  });
}));

router.get('/budget', authenticateToken, h(async (req, res) => {
  res.json(await require('./agent/budget').summary(req.user.userID, await store.getSettings(req.user.userID)));
}));

// ★★ TRD-LLM-1: the MONEY half of the LLM ledger.
//
// `/budget` answers "how many tokens, against which caps". This answers "what did they cost, and over what
// period is that even knowable" — which the desk could not answer at all before it recorded a price. The
// window is a parameter because the honest answer changes with it, and `?since=` is how a caller states
// the window it is claiming.
//
// IT RETURNS ITS OWN COVERAGE rather than only a total, for the reason `spend()` documents: rows written
// with no rate configured, and rows written before cost recording existed, are NOT zero, and folding them
// into a total would render an unpriced era as a cheap one.
router.get('/llm/spend', authenticateToken, h(async (req, res) => {
  const budget = require('./agent/budget');
  const settings = await store.getSettings(req.user.userID);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  if (since && Number.isNaN(since.getTime())) return res.status(400).json({ error: 'since must be an ISO timestamp' });
  const spend = await budget.spend(req.user.userID, { since });

  // ⚠⚠ THE GAIN IS NOT DERIVED HERE, AND THAT IS THE SECOND FIX TO THIS ROUTE.
  //
  // First version read `risk.initialEquity` as the account's opening balance and printed a gain of
  // **1429.51** against a true ~113.21 — `initialEquity` (2685.76) is a RISK baseline for the daily-loss
  // halt, not where the demo account opened (4002.51). That put the breakeven rate at **$1504.99/M instead
  // of $15.91/M, a factor of 95**, and would have been read as "LLM spend cannot possibly matter" — a
  // conclusion resting on a number that means something else.
  //
  // The second version reached for the equity curve instead, and that is ALSO not safe: the desk has TWO
  // equity series (`EquitySnapshots` via `listEquity`, `EquityTicks` via `listEquityTicks`), they open at
  // different values, and `listEquity` SILENTLY CLAMPS limit to 5000. Picking one silently is how a 95x
  // error gets made, so the gain is now a CALLER-SUPPLIED input and its absence is stated rather than
  // guessed at. The spend half — which is what this row is actually about — needs no gain at all.
  const gainParam = req.query.gainUsd;
  const gainUsd = gainParam != null && gainParam !== '' ? Number(gainParam) : null;
  if (gainParam != null && gainParam !== '' && !Number.isFinite(gainUsd)) {
    return res.status(400).json({ error: 'gainUsd must be a number' });
  }
  res.json({
    window: { since: since ? since.toISOString() : null, note: 'no `since` means the newest page the store will return, which is a FLOOR, not a total' },
    pricing: budget.pricingOf(settings),
    spend,
    // The desk-owned form of "do the LLMs pay for themselves": a RATE, not a verdict. Above it the spend
    // would cancel the gain; below it, it cannot. Supplied gain only — see above for why it is not inferred.
    breakeven: Number.isFinite(gainUsd)
      ? {
        gainUsd,
        basis: 'SUPPLIED by the caller via ?gainUsd= — not inferred, because the desk holds two equity series that open at different values and choosing one silently is how this route was wrong by 95x.',
        rate: budget.breakevenRatePerM({ gainUsd, tokens: spend.totalTokens }),
      }
      : {
        rate: null,
        note: 'Pass ?gainUsd= to get a breakeven rate. The desk records the token counts and (once priced) the cost; '
          + 'it does not choose which equity series is "the" gain, because it holds two and they disagree.',
      },
  });
}));

// Self-health (Phase 1 of implied goal): latest snapshot + force-run.
router.get('/self-health', authenticateToken, h(async (req, res) => {
  const liveSnap = require('./agent/selfHealth').latest();
  if (liveSnap) return res.json({ latest: liveSnap });
  const ev = await store.latestEvent(req.user.userID, 'self_health');
  res.json({ latest: ev ? ev.payload : null });
}));

router.post('/self-health/run', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json(await require('./agent/selfHealth').run(req.user.userID, settings, { force: true }));
}));

// Self-tuning (Phase 2 of implied goal): status, force-run, history, revert.
router.get('/tuner', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const last = await store.latestEvent(req.user.userID, 'tune');
  res.json({
    config: settings.tuner || {},
    paperMode: !!(settings.paper && settings.paper.enabled),
    parityValidated: !!(settings.learning && settings.learning.parityValidated),
    last: last ? { eventId: last.id, at: last.createdAt, ...last.payload } : null,
  });
}));

router.post('/tuner/run', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json(await require('./agent/tuner').run(req.user.userID, settings, { force: true }));
}));

router.get('/tuner/history', authenticateToken, h(async (req, res) => {
  const events = await store.listEvents(req.user.userID, { kind: 'tune', limit: 20 });
  res.json({
    items: events.map((e) => ({
      eventId: e.id, at: e.createdAt, model: e.payload?.model,
      // ★ TRD-TUN-1: the panel must be able to tell a PROPOSAL from an APPLIED change, or it offers a Revert
      // control that can only fail. `dryRun` was on the event payload all along and simply was not forwarded.
      dryRun: e.payload?.dryRun === true,
      skipped: e.payload?.skipped || null, changes: e.payload?.changes || [], rejected: e.payload?.rejected || [],
    })),
  });
}));

router.post('/tuner/revert', authenticateToken, h(async (req, res) => {
  const { eventId, index } = req.body || {};
  const r = await require('./agent/tuner').revert(req.user.userID, { eventId, index });
  // ⚠ TRD-TUN-1: a REFUSAL is not a MISS. The old mapping sent every `{ error }` to 404, so "that proposal was
  // never applied" was logged as "not found" — the same class of mislabelling this task is about.
  if (r.refused) return res.status(409).json({ error: r.error });
  if (r.error) return res.status(404).json({ error: r.error });
  res.json(r);
}));

router.put('/budget', authenticateToken, h(async (req, res) => {
  const patch = {};
  const b = req.body || {};
  if (b.totalDaily != null) patch.totalDaily = Math.max(1000, Number(b.totalDaily));
  if (b.warnPct != null) patch.warnPct = Math.min(Math.max(Number(b.warnPct), 10), 100);
  if (b.boostUntil !== undefined) patch.boostUntil = b.boostUntil ? new Date(b.boostUntil).toISOString() : null;
  if (b.perConsumer && typeof b.perConsumer === 'object') patch.perConsumer = b.perConsumer;
  await store.saveSettings(req.user.userID, { budget: patch });
  res.json(await require('./agent/budget').summary(req.user.userID, await store.getSettings(req.user.userID)));
}));

// TRD-12 Phase 0: pipeline state mirror — in-flight wake step timeline,
// last wake per-step timings, and bridge-page conflicts.
router.get('/pipeline', authenticateToken, h(async (req, res) => {
  res.json(require('./agent/wakePipeline').pipelineStatus());
}));

// TRD-12 Phase 3: live href map discovered from the app (link-first nav
// groundwork) and the sim-vs-demo divergence check.
// Premium-analyses capture (TRD-PRM-1 P1, built 2026-10-04): one sweep of the analyses pages into
// the WRITE-ONLY ledger (AnalysesNotes + AnalysisLevels; NO consumer). Lock: tryAcquire('analyses')
// skip-class (never waits on the tab; parks back on /open-positions in its finally). The scheduled
// path is the 6h tick in server.js (self-throttled ~20h via the ledger); this route is for
// on-demand capture + verification runs.
router.post('/analyses/capture', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const out = await require('./plus500/analysesCapture').captureOnce(req.user.userID, settings, {});
  res.json({ ok: true, ...out });
}));

router.get('/bridge/hrefmap', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const map = (settings.bridge || {}).hrefMap || {};
  res.json({ at: map.at || null, hrefs: map.hrefs || [], mode: settings.bridge?.mode || null });
}));

router.get('/divergence', authenticateToken, h(async (req, res) => {
  res.json(await require('./agent/divergence').check(req.user.userID, await store.getSettings(req.user.userID)));
}));

router.post('/paper/reset', authenticateToken, h(async (req, res) => {
  await require('./agent/paper').reset(req.user.userID);
  res.json({ ok: true });
}));

// --- TRD-11: Congress Buys (Quiver) ------------------------------------------
router.get('/congress', authenticateToken, h(async (req, res) => {
  const [pull, signal] = await Promise.all([
    store.latestEvent(req.user.userID, 'congress'),
    store.latestEvent(req.user.userID, 'congress_signal'),
  ]);
  res.json({ latestPull: pull || null, latestSignal: signal || null });
}));

router.post('/providers/congress/pull', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const token = (req.body && req.body.token) || (settings.congress && settings.congress.token) || process.env.QUIVER_API_KEY || null;
  if (!token) return res.status(400).json({ error: 'congress.token missing — get a free key at quiverquant.com/dashboard' });
  const withToken = { ...settings, congress: { ...(settings.congress || {}), token } };
  const payload = await require('./agent/providers/congress').pullCongressTrades(req.user.userID, withToken);
  const rank = await require('./agent/strategies/congress').rank(req.user.userID, withToken);
  res.json({ pull: payload, rank });
}));

router.post('/watchdog/run', authenticateToken, h(async (req, res) => {
  res.json(await watchdog.runNow(req.user.userID));
}));

router.get('/digest', authenticateToken, h(async (req, res) => {
  res.json(await store.latestEvent(req.user.userID, 'digest'));
}));

// --- Plus500 bridge (TRD-2) ---------------------------------------------------
const bridgeBrowser = require('./plus500/browser');
const bridgeHealth = require('./plus500/health');
const bridgeCapture = require('./plus500/capture');
const webtrader = require('./plus500/webtrader');

router.get('/bridge', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json({
    browser: bridgeBrowser.status(),
    chromeAlive: await bridgeBrowser.chromeAlive(),
    paused: bridgeHealth.isPaused(settings),
    parked: !!(settings.bridge || {}).parked, // 2026-10-03: operator park (analysis quiet)
    consecutiveFails: (settings.bridge || {}).consecutiveFails || 0,
    watchlist: settings.watchlist,
  });
}));

router.post('/bridge/resume', authenticateToken, h(async (req, res) => {
  await bridgeHealth.resume(req.user.userID);
  res.json({ ok: true });
}));

// 2026-10-03 OPERATOR PARK (owner-authorized build): one switch that stops every browser-facing
// loop — scheduled/alert/manual wakes, captures (and their Chrome cold-start), the mirror cycle, the
// account strip poller, and the sessionFeed re-attach — while leaving every trading mechanism
// untouched. Dormant when off (unparked behaviour byte-identical). Not a kill: writes no kill tier
// and no policy key (`bridge.*` is outside the guard's policy regex); engage/clear freely.
router.post('/bridge/park', authenticateToken, h(async (req, res) => {
  const on = !!(req.body || {}).on;
  const settings = await store.getSettings(req.user.userID);
  const bridge = { ...(settings.bridge || {}), parked: on, parkedAt: on ? new Date().toISOString() : null };
  await store.saveSettings(req.user.userID, { bridge });
  const sf = require('./plus500/sessionFeed');
  if (on) { try { sf.detach(); } catch { /* not bound */ } }
  else { try { await sf.attach('unpark'); } catch { /* chrome off — attach resumes by itself */ } }
  await store.logEvent(req.user.userID, 'system', { kind: on ? 'bridge_park' : 'bridge_unpark' });
  res.json({ parked: on });
}));

// TRD-46: reclaim the shared tab's leaked memory. A reload is the ONLY thing that reclaims it (the
// footprint bursts on navigation then plateaus — two samples 4 min apart read 1,515 MB then 1,509.8
// MB), and the page cannot be closed instead, because closing it exits Chrome.
//
// WHY THIS IS A ROUTE AND NOT A SCRIPT YOU RUN FROM A SHELL: `pageLock` is IN-PROCESS state, so a
// reload issued by an outside node process would take no lock at all and could land mid-ticket. Only
// a call that arrives here, inside the desk, contends with the desk's own flows.
router.post('/bridge/maintenance-reload', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  // Bounded wait: the caller is asking to interleave with live trading, so it must be able to give up
  // rather than hold a request open indefinitely behind a ticket flow.
  const waitMs = Math.min(Math.max(Number(b.waitMs) || 180000, 1000), 600000);
  res.json(await require('./plus500/maintenance').reloadSharedTab(req.user.userID, {
    reason: String(b.reason || 'api').slice(0, 120),
    waitMs,
    dryRun: b.dryRun === true || req.query.dryRun === '1',
  }));
}));

// Read-only memory footprint of the bridge's own Chrome tree, so the plateau can be watched between
// reloads instead of re-measured by hand.
router.get('/bridge/memory', authenticateToken, h(async (_req, res) => {
  res.json(require('./plus500/maintenance').memoryReport());
}));

router.post('/capture', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json(await bridgeCapture.captureOnce(req.user.userID, settings));
}));

router.post('/watchlist/discover', authenticateToken, h(async (req, res) => {
  const script = path.join(__dirname, 'scripts', 'discover-instruments.js');
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { windowsHide: true, cwd: path.join(__dirname, 'scripts') });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 240000);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((stderr || stdout || 'discover exited ' + code).trim().slice(0, 800)));
      resolve(stdout.trim());
    });
  });
  let parsed;
  try { parsed = JSON.parse(out); } catch { return res.status(500).json({ error: 'discover returned non-JSON output: ' + out.slice(0, 400) }); }
  if (!parsed.ok) return res.status(400).json({ error: parsed.error || 'discovery failed' });
  const settings = await store.getSettings(req.user.userID);
  await store.saveSettings(req.user.userID, { watchlist: { ...(settings.watchlist || {}), candidates: parsed.candidates } });
  res.json({ candidates: parsed.candidates });
}));

router.get('/watchlist', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json({
    symbols: settings.watchlist?.symbols || [],
    candidates: settings.watchlist?.candidates || [],
    universe: settings.watchlist?.universe || [],
    mode: settings.watchlist?.mode || 'dynamic',
  });
}));

router.post('/watchlist/confirm', authenticateToken, h(async (req, res) => {
  const symbols = Array.isArray((req.body || {}).symbols) ? (req.body || {}).symbols : null;
  if (!symbols) return res.status(400).json({ error: 'symbols array required: [{symbol, venue}]' });
  for (const s of symbols) {
    if (!s || !s.symbol || !s.venue) return res.status(400).json({ error: 'each watchlist entry needs symbol + venue' });
  }
  const settings = await store.getSettings(req.user.userID);
  await store.saveSettings(req.user.userID, { watchlist: { ...(settings.watchlist || {}), symbols } });
  res.json({ ok: true, symbols });
}));

// Open a watchlist symbol in the Plus500 chart (click-through, no order).
//
// ★ TRD-66 (2026-09-22): THIS ROUTE IS HALF OF A RACE, AND IT CANNOT BE FIXED FROM HERE.
//
// The pattern it was written for is `POST /watchlist/open` THEN `POST /instruments/probe`. pageLock is
// IN-PROCESS state, so neither the server nor any client can hold the shared tab across two HTTP calls, and
// the desk's own mirror pollers move that tab freely in between. Measured on 2026-09-22, 6 symbols at the
// pacing that originally failed:
//     3 of 6 second requests ARRIVED at a route the caller never asked for
//       (/open-positions, /trade/all-commodities, /trade/all-popular)
//     symbol #3 returned the original symptom verbatim: `not_demo: page has no content (0 chars)`
// The one-call shape `POST /instruments/probe {symbol}` holds the lock across open+read and walked ALL 12
// symbols cleanly at the same pacing. That is the shape the desk uses, and it is the only safe one.
//
// The route is kept because the probe's scan/click paths and the dashboard still use it, but the response now
// carries a machine-readable `warning` so the next client does not rediscover this the expensive way.
const WATCHLIST_OPEN_RACE_WARNING =
  'this route is half of a two-call race: the shared tab can move between this call and a following '
  + '/instruments/probe, and a blank page then reads as not_demo. Use POST /instruments/probe {symbol} '
  + 'instead — it holds the page lock across the open AND the read, so the pair cannot be split.';

router.post('/watchlist/open', authenticateToken, h(async (req, res) => {
  const symbol = String((req.body || {}).symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const settings = await store.getSettings(req.user.userID);
  const page = await bridgeBrowser.newPage();
  try {
    let demo = await webtrader.assertDemo(page, settings);
    // ONE RECOVERY ATTEMPT ON A DEAD RENDER (2026-09-14). `demo.blank` is not a statement about the
    // account — it means the shared tab has not rendered at all, and the caller cannot tell the two
    // apart from the status code. Without this, one dead render becomes a 400 that a batch caller
    // reads as "this symbol is unusable", so the symbols in flight when the page blanked stay
    // uncapturable even after the page recovers on its own. The recovery is a single navigation,
    // and the guard runs AGAIN afterwards, so a genuine non-demo account is still refused.
    if (!demo.demo && demo.blank) {
      const rec = await webtrader.recoverTradePage(page).catch(() => ({ ok: false }));
      if (rec.ok) {
        demo = await webtrader.assertDemo(page, settings);
        if (!demo.demo) return res.status(400).json({ error: 'not_demo: ' + (demo.detail || 'demo marker missing'), recovered: rec });
        const r = await webtrader.openInstrument(page, settings, symbol);
        await store.logEvent(req.user.userID, 'telemetry', { source: 'watchlist_open', symbol, chartTitle: r.chartTitle, recoveredBlankPage: rec });
        return res.json({ ...r, recoveredBlankPage: true, warning: WATCHLIST_OPEN_RACE_WARNING });
      }
    }
    if (!demo.demo) return res.status(400).json({ error: 'not_demo: ' + (demo.detail || 'demo marker missing') });
    const r = await webtrader.openInstrument(page, settings, symbol);
    await store.logEvent(req.user.userID, 'telemetry', { source: 'watchlist_open', symbol, chartTitle: r.chartTitle });
    return res.json({ ...r, warning: WATCHLIST_OPEN_RACE_WARNING });
  } finally {
    // NOTE: no bridgeBrowser.disconnect() — the mirror pollers share this
    // persistent bridge connection; disconnecting would kill their page handles.
    // 4.12 (2026-10-03): PARK the shared tab — every other consumer assumes it rests on
    // /open-positions (mirror + account pollers read positions/account strip there; the watchdog's
    // in-place login fast path assumes a parked page). The probes' own idiom: unconditional,
    // failure-swallowing, and it survives a throw because it lives in the finally.
    await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  }
}));

// Toggle a symbol in/out of the curated watchlist (searchable add/unadd).
router.post('/watchlist/toggle', authenticateToken, h(async (req, res) => {
  const symbol = String((req.body || {}).symbol || '').trim();
  const venue = String((req.body || {}).venue || 'plus500').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const settings = await store.getSettings(req.user.userID);
  const symbols = (settings.watchlist?.symbols || []).slice();
  const idx = symbols.findIndex((s) => s.symbol.toLowerCase() === symbol.toLowerCase() && s.venue === venue);
  let removed = false;
  if (idx !== -1) {
    symbols.splice(idx, 1);
    removed = true;
  } else {
    symbols.push({ symbol, venue, source: 'manual', addedAt: new Date().toISOString() });
  }
  await store.saveSettings(req.user.userID, { watchlist: { symbols } });
  res.json({ ok: true, removed, added: !removed, symbols });
}));

// AI watchlist discoverer: run once now. force=true ignores the interval
// throttle AND the enabled flag, but NEVER the kill/pause/paper gates.
router.post('/watchlist/discover-ai', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const force = !!(req.body || {}).force;
  const r = await require('./agent/discoverer').runDiscovery(req.user.userID, settings, { force });
  res.json(r);
}));

// Last AI discovery run summary (from the discover_signal event).
router.get('/watchlist/discover', authenticateToken, h(async (req, res) => {
  const last = await store.latestEvent(req.user.userID, 'discover_signal');
  res.json(last ? { at: last.createdAt, ...last.payload } : { at: null, runs: 0 });
}));

// ---------------------------------------------------------------------------
// Economic calendar (TRD-2): high-impact events -> CorporateEvents halts.
// ---------------------------------------------------------------------------
router.get('/calendar', authenticateToken, h(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 30);
  res.json({ items: await calendar.upcomingHaltEvents(req.user.userID, { days }) });
}));

router.post('/calendar/import', authenticateToken, h(async (req, res) => {
  const days = Math.min(Math.max(Number((req.body || {}).days) || 7, 1), 14);
  res.json(await calendar.importCalendar(req.user.userID, { days }));
}));

// ---------------------------------------------------------------------------
// TRD-3: kill switch + executor (demo-only).
// ---------------------------------------------------------------------------
router.get('/kill', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json({
    tier: settings.kill?.tier || 'off',
    autoClose: !!settings.kill?.autoClose,
    disasterFloorPct: settings.kill?.disasterFloorPct,
    // TRD-11: baseline lives in kill.initialEquity (legacy fallback: risk).
    initialEquity: settings.kill?.initialEquity ?? settings.risk?.initialEquity ?? null,
  });
}));

// F19 (2026-09-18): START the hard tier's auto-close, do not await it.
//
// A close is a TICKET — it waits up to 240s for the shared Plus500 page — so the operator's
// acknowledgement must not be hostage to the bridge (that is the same trade the capture's budget already
// got wrong in the other direction). It is not fire-and-forget either: `autoCloseSweep` writes a
// `kill_auto_close` event with its outcome either way, and the wake guard re-attempts it on every wake
// while the tier stays hard. That retry is what makes the promise survive a busy bridge, a restart, or
// both — the two ways the old single-shot consumer could be lost.
function startAutoCloseSweep(userId, caller) {
  // Never rejects by construction (it traces its own failure), but a floating promise must not be able to
  // take the process down if that ever stops being true.
  executor.autoCloseSweep(userId, { caller, actor: 'system:kill' })
    .catch((e) => require('./agent/log').error(userId, 'auto_close_sweep_start', e, {}));
}

router.post('/kill', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  if (!killswitch.TIERS.includes(b.tier)) return res.status(400).json({ error: 'tier must be off | soft | hard' });
  const settings = await store.getSettings(req.user.userID);
  const next = await killswitch.setTier(req.user.userID, settings, b.tier, {
    reason: String(b.reason || 'manual').slice(0, 255),
    autoClose: b.autoClose,
    alert: b.alert !== false && b.tier !== 'off',
    actor: `human:${req.user.userID}`,
  });
  // F19 (2026-09-18): THE TIER IS PERSISTED FIRST (above), so the safety state never depends on the
  // bridge — and only THEN is the close started. Until this existed, `autoClose` was recorded and never
  // acted on while hard: the dialog said "closes 1 open position(s) at market" and the position stayed
  // open behind a venue stop 3.05% away.
  const sweeping = next.kill?.tier === 'hard' && !!next.kill?.autoClose;
  if (sweeping) startAutoCloseSweep(req.user.userID, 'route:kill');
  // The response states what was STARTED, not what is hoped for. The outcome arrives as a `kill_auto_close`
  // event; the wake guard re-attempts the sweep on every wake while the tier stays hard.
  res.json({ ok: true, kill: next.kill, autoCloseSweep: sweeping ? 'started' : null });
}));

router.post('/orders/open', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const b = req.body || {};
  // TRD-43 (a): the dashboard's size box is `#trade-amount` and it posts `amount` — the venue's
  // own name for that field — while `executor.openTrade` reads `size`. `Number(undefined)` is NaN,
  // so every dashboard order was refused with `size_must_be_positive`: a dead control that
  // returned a plausible-looking error, which is why it went unnoticed. Accept both names.
  const size = b.size != null ? b.size : b.amount;
  // TRD-43 (b): a desk-opened position with no stop is an UNMEASURED RISK position, not a
  // risk-free one. The desk does not refuse the owner's order, but it will not pretend the risk
  // is zero either — the absence is stamped on the row so `stopCoverage` can attribute it and
  // self-health's `stops` check can page on it. Silence here is what allowed 6 such rows to sit
  // in the ledger as a permanent asterisk.
  const noStop = b.stopPrice == null || b.stopPrice === '';
  const note = noStop
    ? `manual order — NO STOP DECLARED (TRD-43)${b.note ? ` — ${b.note}` : ''}`
    : (b.note || null);
  // Dashboard-submitted = the OWNER's order, not an agent decision — the
  // origin must say so (2026-09-10 tagger fix: these used to be 'agent').
  const r = await executor.openTrade(req.user.userID, settings, { ...b, size, origin: 'manual', note });
  if (r.placed && noStop) {
    await store.logEvent(req.user.userID, 'order_no_stop', {
      tradeId: r.tradeId, symbol: b.symbol, direction: b.direction, size,
      note: 'manual order accepted with no declared risk — excluded from every R-based metric',
    }, { actor: `human:${req.user.userID}`, level: 'warn' }).catch(() => {});
  }
  res.status(r.placed ? 200 : 400).json(r);
}));

router.post('/orders/close', authenticateToken, h(async (req, res) => {
  const tradeId = Number((req.body || {}).tradeId);
  if (!Number.isInteger(tradeId)) return res.status(400).json({ error: 'tradeId required' });
  const settings = await store.getSettings(req.user.userID);
  const r = await executor.closeTrade(req.user.userID, settings, tradeId, { source: 'api' });
  res.status(r.closed ? 200 : 400).json(r);
}));

router.post('/reconcile', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  res.json(await executor.reconcile(req.user.userID, settings, { keepOpen: true }));
}));

// 2026-09-12: venue-close reconciliation. Reads Plus500's own /closed-positions
// and writes the real close (price, P&L, reason, time) onto any trade we could
// not account for — the phantom rows and the `closed` rows with no captured
// P&L that the venue closed itself via SL/TP or at session end.
router.post('/trades/sync-closes', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const browser = require('./plus500/browser');
  if (!(await browser.chromeAlive())) return res.status(503).json({ error: 'bridge chrome is not running' });
  const pageLock = require('./plus500/pageLock');
  // Never navigate the shared tab out from under a ticket flow or a wake capture.
  if (!pageLock.tryAcquire('close-sync')) {
    return res.status(409).json({ error: 'bridge busy', heldBy: pageLock.status().holder });
  }
  // GOTCHA (2026-09-12, cost the bridge its life once): `browser.newPage()`
  // PREFERS the bridge's existing Plus500 tab — it hands back the SHARED page the
  // 1s account poller reads and the mirror parks on /open-positions. Closing it
  // closes the last tab, so Chrome exits and the whole venue feed dies. Borrow
  // it, and put it back where the pollers expect it.
  const page = await browser.newPage();
  try {
    const closed = await require('./plus500/webtrader').readClosedPositions(page);
    const r = await require('./agent/venueClose').syncVenueCloses(req.user.userID, closed.items, {
      settings,
      dryRun: req.query.dryRun === '1',
    });
    res.json({ ...r, venueRows: closed.items.length, dryRun: req.query.dryRun === '1' });
  } finally {
    pageLock.release('close-sync');
    await page.goto('https://app.plus500.com/open-positions', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
  }
}));

router.post('/monitor', authenticateToken, h(async (req, res) => {
  const settings = await store.getSettings(req.user.userID);
  const mon = await executor.monitorFloor(req.user.userID, settings);
  // F19: a manual floor check can BE the thing that sets the hard tier, so it starts the same sweep the
  // wake guard and the kill route start — one rule (`killswitch.autoClosePlan`) decides whether it applies.
  if (mon.tier === 'hard') startAutoCloseSweep(req.user.userID, 'route:monitor');
  res.json(mon);
}));
router.get('/alerts', authenticateToken, h(async (req, res) => {
  res.json({ items: await store.listAlerts(req.user.userID) });
}));

// --- TRD-11: Plus500 alerts mirror (Plus500 = source of truth) ---------------
// Sync: read the REAL alerts list (app.plus500.com/trade/alerts sidebar) and
// mirror rows into local TradingAlerts (note 'mirrored:plus500').
async function plus500AlertSync(userId) {
  const browser = require('./plus500/browser');
  const webtrader = require('./plus500/webtrader');
  const alive = await browser.chromeAlive();
  if (!alive) return { ok: false, error: 'bridge Chrome off — restore the Plus500 page first' };
  const page = await browser.newPage();
  const list = await webtrader.readPlus500Alerts(page);
  const added = await require('./agent/mirrorPoller').upsertMirroredAlerts(userId, list.items || []);
  return { ok: true, listed: (list.items || []).length, added, items: list.items };
}

router.post('/alerts/plus500/sync', authenticateToken, h(async (req, res) => {
  res.json(await plus500AlertSync(req.user.userID));
}));

// Create a PRICE alert on Plus500 (sidebar automation), then mirror it into
// the local alert table so the wake loop also reacts to it.
router.post('/alerts/plus500/create', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  const symbol = String(b.symbol || '').trim();
  const value = Number(b.value);
  if (!symbol || !Number.isFinite(value)) return res.status(400).json({ error: 'symbol + numeric value required' });
  const settings = await store.getSettings(req.user.userID);
  const browser = require('./plus500/browser');
  const webtrader = require('./plus500/webtrader');
  const page = await browser.newPage();
  await webtrader.gotoPage(page, 'trade', settings);
  const hit = await webtrader.searchInstrument(page, symbol, settings);
  if (!hit || !hit.hit) return res.status(400).json({ error: `instrument ${symbol} not found on Plus500` });
  const bell = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid^="InstrumentRow."][data-testid$=".Button.Alert"]')];
    const visible = btns.find((x) => x.getBoundingClientRect().width > 0);
    return visible ? visible.getAttribute('data-testid') : null;
  });
  if (!bell) return res.status(400).json({ error: 'alert bell not visible for ' + symbol });
  await page.click(`[data-testid="${bell}"]`);
  await page.waitForTimeout(1500);
  const created = await webtrader.createPriceAlert(page, { value, side: b.side === 'sell' ? 'sell' : 'buy' });
  const id = await store.createAlert(req.user.userID, {
    symbol, direction: b.side === 'sell' ? 'below' : 'above', threshold: value, note: 'mirrored:plus500',
  });
  res.json({ ok: true, plus500: created, localId: id });
}));

router.post('/alerts', authenticateToken, h(async (req, res) => {
  const b = req.body || {};
  const dirOk = ['above', 'below', 'crosses'].includes(b.direction);
  if (!b.symbol || !dirOk || b.threshold == null || Number.isNaN(Number(b.threshold))) {
    return res.status(400).json({ error: 'symbol, direction (above|below|crosses) and threshold are required' });
  }
  const id = await store.createAlert(req.user.userID, b);
  res.status(201).json({ id });
}));

router.put('/alerts/:id', authenticateToken, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const ok = await store.updateAlert(req.user.userID, id, req.body || {});
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Not found' });
}));

router.delete('/alerts/:id', authenticateToken, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const ok = await store.deleteAlert(req.user.userID, id);
  res.status(ok ? 204 : 404).end();
}));

module.exports = router;
