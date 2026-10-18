// trading/scripts/repro/review-gate-thresholds.js — READ-ONLY. Derives the two parameters of a
// boundary-triggered position review FROM THE DESK'S OWN TICK DATA, so neither is a guess.
//
// THE QUESTION. A position review costs an LLM call every `positionReview.reviewMinutes` (5). The chair
// can only HOLD or CLOSE, its levels are fixed at the venue at entry, and the desk's own measurements
// say early exits lose money — so the review is only worth convening when something could change the
// answer. The candidate gate: convene only when the price is within P% of the stop or the take-profit.
//
// WHY A HAZARD RATE IS THE RIGHT MEASUREMENT. The venue's SL/TP act venue-side the instant they are
// touched, and that CLOSES the position. So the review's only opportunity is the window BEFORE a level
// is reached — when the desk could exit at a better price than the level. Therefore:
//
//     suppress while P(level touched before the next review | current distance) is negligible
//
// which is directly measurable. `P` is the probability the gate would have been wrong to stay silent.
//
// THE TWO PARAMETERS IT DERIVES:
//   1. PROXIMITY P* — the smallest distance at which the false-silence rate is within budget.
//   2. CEILING     — the p90/p95 DWELL time: how long "nothing is near" actually persists. The gate must
//                    not stay silent longer than the geometry it is reasoning about survives.
//
// ★ CENSORING CORRECTION — THE SECOND ZERO WAS AN ARTIFACT TOO, AND A WORSE ONE.
// The desk's feed is driven by POSITION POLLING: when the position closes, the ticks stop. So the very
// moment a level is reached is the one moment the record never contains. Trade #1067 was filled at
// 4373.85 while its last recorded feed price was 4371.81 — 0.047% short — and nine of the twenty-two
// tradable paths close in exactly that posture: within 0.014%-0.60% of the level, then silence. A hazard
// rate read only from [openAt, closeAt] is therefore zero BY CONSTRUCTION, and its bias is concentrated
// in the nearest distance buckets — the only ones the threshold depends on.
// FIX: read a post-close TAIL (the watchlist keeps quoting the symbol after the position is gone) so a
// step whose 5-minute horizon runs past the close can still be judged. A step whose horizon outruns ALL
// available data is reported as UNRESOLVED, never silently counted as quiet.
//
// CAVEATS STATED, NOT HIDDEN: (a) the feed is sampled, so a touch between samples is under-read — the
// hazard is a LOWER bound; (b) only trades whose ticks survived the 7-day retention are usable;
// (c) closed trades are conditional on having closed (survivorship); (d) the venue of record is pinned
// to `trade.venue` per TRD-101 — reading by symbol alone measures the spread between venues;
// (e) the desk's own feed goes STALE (observed stalls up to 433 min), so a long silence in the path may
// be UNOBSERVED rather than genuinely quiet. §0 prints each path's worst stall so this stays visible.
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const USER = 1;
const BUDGET = 0.01;      // the false-silence budget the threshold is chosen against (1%)
const TAIL_MIN = 60;      // how far past the close to read, so a horizon over the close can be judged

// Explicit absent-value guard. `Number(null) === 0` has produced a fabricated number in this codebase
// six times; a null bid must never become a mid of half the ask.
function mid(bid, ask) {
  if (bid == null || ask == null || bid === '' || ask === '') return null;
  const b = Number(bid); const a = Number(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a) || b <= 0 || a <= 0) return null;
  return (b + a) / 2;
}

// The price at which the VENUE would close this position — the only price that can reach a level.
// A short is closed by buying at the ask; a long by selling at the bid.
function closeSide(dir, bid, ask) {
  const v = dir === 'sell' ? ask : bid;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// For a SELL the stop is ABOVE the entry and the target BELOW; a BUY is the mirror.
function levelTouched(dir, p, stop, tp) {
  if (dir === 'sell') return p >= stop || p <= tp;
  return p <= stop || p >= tp;
}

async function loadTrades() {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT t.id, t.symbol, t.venue, t.direction, t.openPrice, t.stopPrice, t.takeProfitPrice,
           t.openAt, t.closeAt, t.closePrice, t.note, k.capturedAt, k.bid, k.ask
    FROM Trades t
    JOIN PriceTicks k
      ON k.userId = t.userId AND k.symbol = t.symbol AND k.venue = t.venue
     AND k.capturedAt >= t.openAt AND k.capturedAt <= DATEADD(MINUTE, ${TAIL_MIN}, t.closeAt)
    WHERE t.userId = ${USER} AND t.closeAt IS NOT NULL
      AND t.stopPrice IS NOT NULL AND t.takeProfitPrice IS NOT NULL AND t.direction IS NOT NULL
    ORDER BY t.id, k.capturedAt`);

  const byId = new Map();
  let sideFallbacks = 0;
  for (const row of r.recordset) {
    const m = mid(row.bid, row.ask);
    if (m == null) continue;
    if (!byId.has(row.id)) {
      const stop = Number(row.stopPrice);
      const tp = Number(row.takeProfitPrice);
      const closePrice = row.closePrice == null ? null : Number(row.closePrice);
      // THE VENUE'S OWN GROUND TRUTH. `closePrice` is a FILL, not a feed sample, so unlike every tick it
      // survives the censoring that blinds this measurement. If the position ended at/through a level,
      // the level demonstrably WAS reached — the feed just stopped recording 26 seconds too early.
      const sold = row.direction === 'sell';
      const closedAtLevel = closePrice == null ? false
        : sold ? (closePrice >= stop || closePrice <= tp) : (closePrice <= stop || closePrice >= tp);
      byId.set(row.id, {
        id: row.id, symbol: row.symbol, venue: row.venue, dir: row.direction,
        stop, tp, closePrice,
        note: row.note == null ? '' : String(row.note),
        closedAtLevel,
        closeT: row.closeAt == null ? null : new Date(row.closeAt).getTime(),
        openAt: row.openAt, closeAt: row.closeAt, path: [], tail: [],
      });
    }
    let side = closeSide(row.direction, row.bid, row.ask);
    if (side == null) { sideFallbacks++; side = m; }   // counted, never silent
    const rec = byId.get(row.id);
    const tick = { t: new Date(row.capturedAt).getTime(), mid: m, side };
    // the tail is post-close only: it resolves horizons, it is never part of the position's dwell
    if (rec.closeAt && tick.t > new Date(rec.closeAt).getTime()) rec.tail.push(tick);
    else rec.path.push(tick);
  }
  return { trades: [...byId.values()].filter((x) => x.path.length >= 3), sideFallbacks };
}

async function loadContext() {
  const pool = await getPool();
  const s = await pool.request().query(`
    SELECT ISNULL(JSON_VALUE(settings,'$.deliberation.positionReview.reviewMinutes'),'5') AS reviewMin
    FROM TradingSettings WHERE userId = ${USER}`);
  const c = await pool.request().query(`
    SELECT COUNT(*) AS calls,
           AVG(CAST(ISNULL(JSON_VALUE(payload,'$.promptChars'),0) AS FLOAT)) AS avgChars,
           AVG(CAST(ISNULL(JSON_VALUE(payload,'$.completionTokens'),0) AS FLOAT)) AS avgOut
    FROM TradingEvents WHERE kind = 'llm_call' AND JSON_VALUE(payload,'$.label') = 'review'`);
  return {
    reviewMin: Number(s.recordset[0] && s.recordset[0].reviewMin) || 5,
    calls: c.recordset[0] ? Number(c.recordset[0].calls) : 0,
    avgChars: c.recordset[0] && c.recordset[0].avgChars ? Math.round(Number(c.recordset[0].avgChars)) : null,
  };
}

function buckets() {
  return [
    [0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 0.75],
    [0.75, 1.0], [1.0, 1.5], [1.5, 2.0], [2.0, 3.0], [3.0, Infinity],
  ];
}

function quant(list, f) {
  if (!list.length) return null;
  const r = [...list].sort((a, b) => a - b);
  return r[Math.min(r.length - 1, Math.floor(r.length * f))];
}

async function main() {
  const ctx = await loadContext();
  const pool = await getPool();
  const stepMs = ctx.reviewMin * 60000;
  const { trades, sideFallbacks } = await loadTrades();

  console.log(`review interval in settings: ${ctx.reviewMin} min   (step = ${ctx.reviewMin} min)`);
  console.log(`review LLM calls recorded:   ${ctx.calls}   mean promptChars ${ctx.avgChars ?? 'n/a'}`);
  console.log(`trades with levels AND a usable tick path: ${trades.length}` +
    (sideFallbacks ? `   (${sideFallbacks} ticks had no venue-side quote -> priced on mid)` : ''));
  if (!trades.length) {
    console.log('\nNO USABLE PATHS — the tick retention window covers no closed trade. Nothing below is measurable.');
    return;
  }

  // ---- 0. PATH AUDIT: can this path reach a level at all, and on which price? ----
  console.log('\n=== 0. PATH AUDIT — which price can actually reach the level? ===');
  console.log('  id  dir   stop        extreme(mid)   mid short   extreme(side)  side short   worst stall');
  let midHits = 0; let sideHits = 0; let worstGapMin = 0;
  for (const t of trades) {
    const mids = t.path.map((x) => x.mid);
    const sides = t.path.map((x) => x.side);
    const midExt = t.dir === 'sell' ? Math.max(...mids) : Math.min(...mids);
    const sideExt = t.dir === 'sell' ? Math.max(...sides) : Math.min(...sides);
    const shortfall = (x) => (t.dir === 'sell' ? (t.stop - x) / t.stop * 100 : (x - t.stop) / t.stop * 100);
    if (t.path.some((x) => levelTouched(t.dir, x.mid, t.stop, t.tp))) midHits++;
    if (t.path.some((x) => levelTouched(t.dir, x.side, t.stop, t.tp))) sideHits++;
    let gap = 0;
    for (let i = 1; i < t.path.length; i++) gap = Math.max(gap, t.path[i].t - t.path[i - 1].t);
    worstGapMin = Math.max(worstGapMin, gap / 60000);
    console.log(`  ${String(t.id).padStart(4)} ${t.dir.padEnd(4)} ${String(t.stop).padEnd(10)}  ${midExt.toFixed(5).padStart(12)}   ${shortfall(midExt).toFixed(4).padStart(8)}%  ${sideExt.toFixed(5).padStart(12)}   ${shortfall(sideExt).toFixed(4).padStart(8)}%  ${(gap / 60000).toFixed(1).padStart(8)}m`);
  }
  console.log(`  paths that reach a level, priced on MID: ${midHits}/${trades.length}   on the VENUE'S CLOSE SIDE: ${sideHits}/${trades.length}`);
  console.log(`  worst stall in the feed across all paths: ${worstGapMin.toFixed(1)} min  (a silence longer than this is unobserved, not proven quiet)`);

  // Two independent ground-truth signals that a level acted. Reconcile them instead of assuming either.
  const venueClosed = trades.filter((t) => /venue closed/i.test(t.note));
  const atLevel = trades.filter((t) => t.closedAtLevel);
  const conflicted = atLevel.filter((t) => !/venue closed/i.test(t.note));
  console.log(`  note says the VENUE closed the position: ${venueClosed.length}   closePrice is at/through a level: ${atLevel.length}` +
    `   agree: ${venueClosed.filter((t) => t.closedAtLevel).length}`);
  if (conflicted.length) {
    console.log(`  ⚠ closePrice at a level but the note is not a venue close: ${conflicted.map((t) => `#${t.id} "${t.note}"`).join(', ')}`);
  }

  // ---- 1. HAZARD, priced on the venue's close side, horizons resolved against the post-close tail ----
  const obs = [];   // { d, touched, resolved } — one per review-sized step
  for (const t of trades) {
    let lastT = 0;
    const aheadOf = (i) => t.path.slice(i + 1).concat(t.tail);
    const lastData = aheadOf(t.path.length - 1).length
      ? aheadOf(t.path.length - 1)[aheadOf(t.path.length - 1).length - 1].t
      : t.path[t.path.length - 1].t;
    for (let i = 0; i < t.path.length; i++) {
      if (i > 0 && t.path[i].t - lastT < stepMs) continue;
      lastT = t.path[i].t;
      const p = t.path[i].side;
      const d = Math.min(Math.abs(p - t.stop), Math.abs(p - t.tp)) / p * 100;
      const horizon = t.path[i].t + stepMs;
      const resolved = horizon <= lastData;
      const viaFeed = aheadOf(i).some((x) => x.t > t.path[i].t && x.t <= horizon && levelTouched(t.dir, x.side, t.stop, t.tp));
      // The censored case, recovered from the venue's own fill rather than from the feed. If the position
      // ended AT a level and that close lands inside this horizon, the level WAS reached before the next
      // review — the instrument simply stopped recording exactly then.
      const viaClose = t.closedAtLevel && t.closeT != null && t.closeT > t.path[i].t && t.closeT <= horizon;
      obs.push({ d, touched: viaFeed || viaClose, viaFeed, viaClose, resolved, tradeId: t.id });
    }
  }

  const unres = obs.filter((o) => !o.resolved).length;
  const reached = obs.filter((o) => o.touched);
  console.log(`\nobservations (review-sized steps across all trades): ${obs.length}` +
    `   reached: ${reached.length} (feed ${reached.filter((o) => o.viaFeed).length}, venue fill ${reached.filter((o) => o.viaClose).length})` +
    `   UNRESOLVED: ${unres}`);
  console.log(`  the feed alone sees ${reached.filter((o) => o.viaFeed).length} of these ${reached.length} — the rest are invisible to PriceTicks.`);

  console.log('\n=== 1. HAZARD — P(a level is reached before the next review | current distance) ===');
  console.log('  distance %      steps   reached   unresolved   P(reach)      [resolved steps only]');
  for (const [lo, hi] of buckets()) {
    const inB = obs.filter((o) => o.d >= lo && o.d < hi);
    if (!inB.length) continue;
    const res = inB.filter((o) => o.resolved);
    const n = inB.filter((o) => o.touched).length;
    const u = inB.length - res.length;
    const p = res.length ? (n / res.length * 100).toFixed(2) + '%' : 'n/a';
    console.log(`  ${String(lo).padStart(5)}-${String(hi === Infinity ? '+' : hi).padEnd(5)}  ${String(inB.length).padStart(6)}  ${String(n).padStart(8)}  ${String(u).padStart(11)}   ${p.padStart(8)}`);
  }

  // The budget must gate the CONDITIONAL rate: of the steps the gate silences, how many were wrong to
  // silence? Dividing by every step instead would dilute the rate by the (large, uninformative) share of
  // steps that were never near a level, making any threshold look safe.
  console.log('\n=== 2. THRESHOLD CHOICE — suppress while distance > P* ===');
  console.log('    P*%   reviews kept   silenced   WRONG-WHEN-SILENT (of the silenced, resolved steps)');
  const cands = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0];
  for (const P of cands) {
    const silent = obs.filter((o) => o.d > P && o.resolved);
    const bad = silent.filter((o) => o.touched).length;
    const wrong = silent.length ? bad / silent.length : 0;
    const flag = silent.length && wrong <= BUDGET ? '  <-- within 1% budget' : '';
    console.log(`  ${String(P).padStart(5)}   ${String(obs.length - silent.length).padStart(12)}   ${String(silent.length).padStart(8)}   ${String(bad).padStart(3)}/${String(silent.length).padEnd(4)} = ${(wrong * 100).toFixed(2)}%${flag}`);
  }

  console.log('\n=== 3. CEILING — how long does "nothing is near" actually persist? ===');
  console.log('    P*%   runs   p50 min   p90 min   p95 min   max min');
  for (const P of cands) {
    const r = [];
    for (const t of trades) {
      let start = null;
      for (const x of t.path) {
        const d = Math.min(Math.abs(x.side - t.stop), Math.abs(x.side - t.tp)) / x.side * 100;
        if (d > P) { if (start == null) start = x.t; }
        else if (start != null) { r.push((x.t - start) / 60000); start = null; }
      }
      if (start != null) r.push((t.path[t.path.length - 1].t - start) / 60000);
    }
    if (!r.length) { console.log(`  ${String(P).padStart(5)}      0 runs  (no path ever stood farther than this)`); continue; }
    const q = (f) => quant(r, f).toFixed(0);
    console.log(`  ${String(P).padStart(5)}   ${String(r.length).padStart(4)}   ${q(0.5).padStart(6)}   ${q(0.9).padStart(7)}   ${q(0.95).padStart(7)}   ${Math.max(...r).toFixed(0).padStart(7)}`);
  }

  // ---- 4. WHAT THE THRESHOLD SHOULD BE DENOMINATED IN ----
  // §2 cannot choose P*: with 6 events the 1% budget passes at EVERY candidate, so the budget excludes
  // nothing. The threshold should instead be set against the quantity that actually decides the answer —
  // how far this desk's own venue feed MOVES in one review interval. If the price is farther from the
  // level than a 5-minute move it makes almost never, silence is justified by construction, not by a fit.
  // Read at 10-second resolution from `position_poll` (the venue's own rate while a position is held),
  // which is the only series here fine enough to bracket a 5-minute window.
  console.log('\n=== 4. MEASURED 5-MINUTE TRAVEL — the unit the threshold should be expressed in ===');
  const tr = await pool.request().query(`
    SELECT symbol, capturedAt, bid FROM PriceTicks
    WHERE userId = ${USER} AND source = 'position_poll' AND bid IS NOT NULL
    ORDER BY symbol, capturedAt`);
  const bySym = new Map();
  for (const row of tr.recordset) {
    if (!bySym.has(row.symbol)) bySym.set(row.symbol, []);
    bySym.get(row.symbol).push({ t: new Date(row.capturedAt).getTime(), p: Number(row.bid) });
  }
  console.log('  symbol   pairs     p50      p90      p95      p99      max    5-min travel as % of price');
  const allTravel = [];
  for (const [sym, xs] of bySym) {
    const mv = [];
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length && xs[j].t - xs[i].t <= stepMs + 30000; j++) {
        const dt = xs[j].t - xs[i].t;
        if (dt < stepMs - 30000) continue;
        if (xs[i].p > 0 && xs[j].p > 0) mv.push(Math.abs(xs[j].p - xs[i].p) / xs[i].p * 100);
      }
    }
    if (!mv.length) continue;
    allTravel.push(...mv);
    console.log(`  ${sym.padEnd(8)} ${String(mv.length).padStart(5)}   ${quant(mv, 0.5).toFixed(4).padStart(7)}  ${quant(mv, 0.9).toFixed(4).padStart(7)}  ${quant(mv, 0.95).toFixed(4).padStart(7)}  ${quant(mv, 0.99).toFixed(4).padStart(7)}  ${Math.max(...mv).toFixed(4).padStart(7)}`);
  }
  if (allTravel.length) {
    const p99 = quant(allTravel, 0.99);
    const p90 = quant(allTravel, 0.90);
    console.log(`  ALL      ${String(allTravel.length).padStart(5)}   ${quant(allTravel, 0.5).toFixed(4).padStart(7)}  ${p90.toFixed(4).padStart(7)}  ${quant(allTravel, 0.95).toFixed(4).padStart(7)}  ${p99.toFixed(4).padStart(7)}  ${Math.max(...allTravel).toFixed(4).padStart(7)}`);
    console.log(`\n  ⇒ a review interval buys a move larger than ${p99.toFixed(3)}% about 1% of the time, and larger`);
    console.log(`    than ${p90.toFixed(3)}% about 10% of the time. Those are the two defensible P* values;`);
    console.log(`    anything BELOW ${p90.toFixed(3)}% is a number no measurement here can support.`);
    console.log(`    Recommend P* = ${p99.toFixed(2)}%  (≈ the 1% budget, expressed in the desk's own units).`);
  } else {
    console.log('  NO position_poll pairs — the travel unit cannot be measured either. Do not invent one.');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
