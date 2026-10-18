// trading/agent/shadowScore.js — TRD-SHW-2 (2026-09-14).
//
// The FORWARD scorer. Walks shadow rows whose horizon has elapsed, reads the bars
// that FOLLOWED the call, and fills the outcome columns. It never touches a row
// whose horizon has not elapsed, and it never reads a bar from before the call —
// forward-only is the whole point (the model's training data contaminates any
// historical replay, so a row can only ever be scored on data the market produced
// AFTER the question was asked).
//
// THE RISK UNIT. A shadow call has no stop, so an R needs a denominator or it means
// nothing. The desk's own convention is a 2 x ATR14 stop, so
//     riskPct = 2 * ATR14(at the call) / price(at the call) * 100
// and realisedR = signedClosePct / riskPct. A call that would have hit that stop
// reads -1R. The denominator is captured from the ROW, not recomputed from later
// bars, so it cannot drift as the market moves.
//
// THE THREE BASELINES, and where each lives (§3.5):
//   A confirmedByStrategy — a real entry decision in the same symbol+direction
//                           between the call and the horizon. Measures EARLINESS.
//   B benchmarkLongR      — the UNMIRRORED long return of the same window. Answers
//                           "did the asset just drift in the calls favour?".
//   C                     — the same rule at randomised timestamps. SAMPLE-level, so
//                           it belongs to the report and is deliberately not a column.
//
// ★ THE FIELD BOUNDARY (TRD-SHW-4, found 2026-09-23). This scorer consumes store rows
// directly, and `PriceBars` calls its opening price `openPrice` — `store.listBars` runs
// `SELECT TOP (@limit) *`, so a row carries the COLUMN names verbatim, with no aliasing.
// The first version read `b.open`, which is undefined on every real row, so
// `excursionOf` returned null (realisedR/mfePct/maePct all NULL on all 62 directional
// calls for seven days) and `benchmarkLongPct` returned null. Those tests passed because
// their FIXTURES also used `open`: a fixture built from the code's belief instead of the
// producer's contract cannot fail. `barOpen` below is the single place that knows the
// name, and it tolerates both, matching `lab.normalize` and `survGoldStruct.toStructureBars`.
'use strict';

const store = require('../store');
const shadow = require('./shadow');

const HORIZON_BARS = shadow.HORIZON_BARS; // 24 — fixed before collection

function signOf(direction) {
  if (direction === 'buy') return 1;
  if (direction === 'sell') return -1;
  return 0;
}

// The desk's stop convention, as a percentage of price.
function riskPctOf(atr14, price) {
  const a = Number(atr14), p = Number(price);
  if (!Number.isFinite(a) || !Number.isFinite(p) || p <= 0 || a <= 0) return null;
  return (2 * a) / p * 100;
}

function rOf(pct, riskPct) {
  // ★ GUARD ABSENCE BEFORE COERCION. `Number(null) === 0` and `Number('') === 0`, so
  // checking `Number.isFinite` AFTER coercing turns "not measured" into a legitimate
  // 0R. That is how `benchmarkLongR` was stored as 0.000000 on 45 rows while `realisedR`
  // was NULL — a fabricated number `isNum()` accepts, so baseline B would have silently
  // redefined its own test the moment the field name was fixed. Found 2026-09-23.
  if (pct == null || pct === '' || riskPct == null || riskPct === '') return null;
  const v = Number(pct), r = Number(riskPct);
  if (!Number.isFinite(v) || !Number.isFinite(r) || r <= 0) return null;
  return Math.round((v / r) * 1e6) / 1e6;
}

// The opening price of a store row, from the name the PRODUCER emits. Kept as a function
// so the contract has exactly one home: a reader looking for "how does this file read a
// bar" finds it here rather than in two `map` callbacks. `b.open` remains accepted so the
// repro scripts that inject it keep working.
function barOpen(b) {
  if (!b) return null;
  const v = b.openPrice != null ? b.openPrice : b.open;
  return v == null ? null : Number(v);
}

const barTime = (b) => new Date(b.barStart || b.capturedAt || 0).getTime();

// The bars that FOLLOW the call: strictly after it, capped at the horizon length.
// Returns [] when not enough have formed yet, which is how "not ready" is expressed.
function sliceHorizon(bars, fromIso, n = HORIZON_BARS) {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return [];
  const after = (bars || []).filter((b) => barTime(b) > from).sort((a, b) => barTime(a) - barTime(b));
  if (after.length < n) return [];
  return after.slice(0, n);
}

// Signed excursions over the window, using the desk's autopsy convention: MFE is
// positive when the move went the call's way, MAE negative when it went against.
// Invariant MAE <= MFE holds by construction.
function excursionOf(rows, direction) {
  const dir = signOf(direction);
  const opens = rows.map(barOpen).filter(Number.isFinite);
  const highs = rows.map((b) => Number(b.high)).filter(Number.isFinite);
  const lows = rows.map((b) => Number(b.low)).filter(Number.isFinite);
  const closes = rows.map((b) => Number(b.closePrice)).filter(Number.isFinite);
  if (dir === 0 || !opens.length || !closes.length) return null;
  const open = opens[0];
  if (!(open > 0)) return null;
  const peak = highs.length ? Math.max(...highs) : null;
  const trough = lows.length ? Math.min(...lows) : null;
  const close = closes[closes.length - 1];
  const favourable = dir > 0 ? peak : trough;
  const adverse = dir > 0 ? trough : peak;
  const pct = (v) => (v == null ? null : ((v - open) * dir) / open * 100);
  return {
    open, close,
    mfePct: pct(favourable),
    maePct: pct(adverse),
    closePct: ((close - open) * dir) / open * 100,
    bars: rows.length,
    closeAt: rows[rows.length - 1].barStart || null,
  };
}

// Baseline B: the UNMIRRORED long return of the same window. Not the call's
// direction — that is the treatment. A benchmark that mirrors the treatment
// measures nothing.
function benchmarkLongPct(rows) {
  const opens = barOpen(rows && rows[0]);
  const closes = Number(rows && rows[rows.length - 1] && rows[rows.length - 1].closePrice);
  if (!Number.isFinite(opens) || !Number.isFinite(closes) || !(opens > 0)) return null;
  return ((closes - opens) / opens) * 100;
}

// Did a real entry fire in the SAME direction inside the window? (Baseline A.)
function confirmedIn(decisions, symbol, direction, fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Infinity;
  return (decisions || []).some((d) => d.symbol === symbol
    && String(d.direction || '').toLowerCase() === String(direction).toLowerCase()
    && new Date(d.createdAt).getTime() >= from
    && new Date(d.createdAt).getTime() <= to);
}

// Assemble the outcome for one row from its bars. Pure; the job below just wires it
// to the store.
function scoreRow(row, bars, decisions) {
  const rows = sliceHorizon(bars, row.createdAt, HORIZON_BARS);
  if (!rows.length) return { ready: false };
  const riskPct = riskPctOf(row.atr14, row.priceAtCall);
  const ex = excursionOf(rows, row.direction);
  const benchPct = benchmarkLongPct(rows);
  const horizonAt = new Date(new Date(rows[rows.length - 1].barStart).getTime()).toISOString();
  return {
    ready: true,
    barsToHorizon: rows.length,
    horizonAt,
    closeAt: horizonAt,
    mfePct: ex ? ex.mfePct : null,
    maePct: ex ? ex.maePct : null,
    realisedR: ex ? rOf(ex.closePct, riskPct) : null,
    benchmarkLongR: rOf(benchPct, riskPct),
    confirmedByStrategy: confirmedIn(decisions, row.symbol, row.direction, row.createdAt, horizonAt),
    riskPct,
  };
}

// The job. Scores every pending row whose horizon has elapsed; leaves the rest for
// a later pass. Failures are per-row and never abort the sweep.
async function scorePending(userId, { limit = 200 } = {}) {
  const pending = await store.listUnscoredShadowSignals(userId, { limit });
  if (!pending.length) return { pending: 0, scored: 0, notReady: 0, errors: 0 };

  const barCache = new Map();
  const decisions = await store.listDecisionEventsBetween(userId,
    new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(), new Date().toISOString()).catch(() => []);

  let scored = 0, notReady = 0, errors = 0;
  for (const row of pending) {
    // A row with no direction was never a claim; there is nothing to score. Mark it
    // scored so it stops being walked, with nulls throughout.
    if (row.direction !== 'buy' && row.direction !== 'sell') {
      await store.scoreShadowSignal(row.id, {}).catch(() => { errors++; });
      scored++;
      continue;
    }
    const key = `${row.symbol}|${row.venue}`;
    if (!barCache.has(key)) {
      barCache.set(key, await store.listBars(userId, {
        timeframe: '1h', symbol: row.symbol, venue: row.venue, limit: 400,
      }).catch(() => []));
    }
    const out = scoreRow(row, barCache.get(key), decisions);
    if (!out.ready) { notReady++; continue; }
    try {
      await store.scoreShadowSignal(row.id, out);
      scored++;
    } catch (e) {
      errors++;
      await store.logEvent(userId, 'telemetry', {
        source: 'shadow_score_error', id: row.id, symbol: row.symbol, error: String(e.message || e).slice(0, 200),
      }).catch(() => {});
    }
  }
  return { pending: pending.length, scored, notReady, errors };
}

module.exports = {
  scorePending, scoreRow, sliceHorizon, excursionOf, benchmarkLongPct,
  confirmedIn, riskPctOf, rOf, barOpen, HORIZON_BARS,
};
