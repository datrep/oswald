// trading/scripts/repro/rev-gate-replay.js — TRD-REV-1, OBSERVE MODE. READ-ONLY: writes nothing, gates
// nothing, changes no live behaviour. It replays the STORED reviews against the pre-registered rule and
// reports what the gate WOULD have done.
//
// THE RULE BEING REPLAYED (registered 2026-09-23, docs/trd-evd-1-... is the other one; this one is §3 of
// the session plan and its numbers are measured in trading/scripts/repro/review-gate-thresholds.js):
//
//     suppress a review while  distance-to-nearest-level > P*   AND   time-since-last-convened < CEILING
//
//   P* = 0.25% absolute   — two independent measurements agree: the hazard table's last non-negligible
//                           bucket is 0.2-0.3% (1.2%), and the desk's own p99 5-minute travel is 0.244%.
//   CEILING = 90 min      — the p90 dwell of "nothing is near" at P*=0.25%. Below 0.115% no measurement
//                           supports a number at all.
//
// ★ THE TWO NUMBERS THAT MATTER, AND THEY PULL OPPOSITE WAYS:
//   1. CALLS SAVED — the point of the gate. Each suppressed review is one LLM call not made, and that
//      mapping is MEASURED, not assumed: 96.2% of non-skipped reviews have a paired llm_call within 90s
//      (n=397), and `market_closed` reviews already cost zero, so they are excluded as already-free.
//   2. DECISIONS MISSED — the cost. A suppressed review is a MISSED DECISION if the trade closed within
//      the next review interval AND that close was NOT the venue's own level acting. A venue level close
//      is not a decision the chair makes — the bracket fires regardless — so only a discretionary close
//      counts. This is the measure of whether the gate's silence ever mattered.
//
// ★ A SKIPPED REVIEW IS A MAX-CONFIDENCE HOLD, and it is recorded here rather than dropped: every
// suppressed review is counted in the output with the distance that justified it. Silence that leaves no
// trace is the failure mode the whole design is arranged against.
//
// ⚠ COVERAGE IS BOUNDED BY TICK RETENTION (7 days) AND BY THE SAME CENSORING W3 FOUND. `position_poll`
// stops when the position closes, so a review in the last seconds of a trade may have no nearby tick. The
// script reports its own coverage rather than quietly computing on a subset.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const USER = 1;
const P_STAR = 0.25;          // % absolute — the registered proximity threshold
const CEILING_MIN = 90;       // the registered ceiling
const STEP_MIN = 5;           // the desk's review interval (measured: exactly 300s)
const TICK_TOL_SEC = 120;     // how far from a review instant a tick may be and still price it
// Sources, best first. `position_poll` is the venue's OWN rate during a hold and is single-sided (bid==ask
// == currentRate), so there is no side to choose; `plus500_frontend` is two-sided and the side matters
// (W3: a SELL is closed at the ASK), which is handled in `priceFor`.
const SOURCE_RANK = { position_poll: 0, plus500_frontend: 1, plus500_chart: 2 };

// The price the VENUE would act on. For a flat poll row there is no spread to choose; for a two-sided row,
// a sell is closed at the ask and a buy at the bid (W3's correction — mid sits on the wrong side).
function priceFor(dir, t) {
  const b = t.bid == null ? null : Number(t.bid);
  const a = t.ask == null ? null : Number(t.ask);
  if (b != null && a != null && b === a && b > 0) return { p: b, basis: 'flat_venue_rate' };
  const side = dir === 'sell' ? a : b;
  if (side != null && Number.isFinite(side) && side > 0) return { p: side, basis: dir === 'sell' ? 'ask' : 'bid' };
  if (b > 0 && a > 0) return { p: (a + b) / 2, basis: 'mid_fallback' };
  return null;
}

(async () => {
  const pool = await getPool();

  const t = await pool.request().query(`
    SELECT id, venue, symbol, direction, openAt, closeAt, stopPrice, takeProfitPrice, note, strategyId
    FROM Trades WHERE userId = ${USER} AND closeAt IS NOT NULL
      AND stopPrice IS NOT NULL AND takeProfitPrice IS NOT NULL AND direction IS NOT NULL
    ORDER BY openAt`);
  const trades = new Map(t.recordset.map((r) => [r.id, r]));

  const e = await pool.request().query(`
    SELECT id, createdAt, payload FROM TradingEvents
    WHERE userId = ${USER} AND kind = 'position_review' ORDER BY createdAt`);
  // ★ THE PARSE AND THE tradeId FILTER ARE BOTH COUNTED. A first version filtered to reviews carrying a
  // numeric tradeId and then printed the SURVIVORS as "reviews in the log" — a silent exclusion of roughly
  // half the table, presented as the denominator. That is the same defect class this session has found four
  // times (the scope filter, the unguarded rows, the UQ-key cleanup, the sweep field name): a filter that
  // does not announce itself reads as a fact about the data.
  const raw = e.recordset.map((r) => {
    let j = null;
    try { j = JSON.parse(r.payload); } catch { j = null; }
    return { id: r.id, at: new Date(r.createdAt), payload: j };
  });
  const unparseable = raw.filter((r) => !r.payload).length;
  const noTradeId = raw.filter((r) => r.payload && !Number.isFinite(Number(r.payload.tradeId))).length;
  const reviews = raw.filter((r) => r.payload).map((r) => ({
    id: r.id, at: r.at,
    tradeId: Number.isFinite(Number(r.payload.tradeId)) ? Number(r.payload.tradeId) : null,
    symbol: r.payload.symbol || null,
    skipped: r.payload.skipped || null,
  }));

  // ★ THE MISSING tradeId IS A SCHEMA-ERA BOUNDARY, NOT A RECORD DEFECT — and the difference matters.
  // VERIFIED 2026-09-23: `has tradeId` spans 2026-09-18 15:17 -> now; `no tradeId` spans 2026-09-09 10:07 ->
  // 2026-09-18 15:15. The field was ADDED mid-record, so no review before that carries one. This is the
  // SECOND logging-era boundary in this event family today (the first: `llm_call` events start 2026-09-20).
  // An earlier draft of this script called it "a finding about the review record", which would have been
  // wrong in the direction of inventing a defect.
  //
  // Rather than discard half the record, those reviews are resolved by CONTAINMENT: the review instant must
  // fall inside exactly ONE trade of the review's own symbol. Ambiguity is counted and excluded, never
  // guessed — picking which trade a review concerns would turn a reconstruction into a fabrication.
  const bySymbol = new Map();
  for (const tr of trades.values()) {
    if (!bySymbol.has(tr.symbol)) bySymbol.set(tr.symbol, []);
    bySymbol.get(tr.symbol).push(tr);
  }
  const resolveHow = { tradeId: 0, 'symbol+containment': 0 };
  const ambiguous = { no_containing_trade: 0, no_symbol: 0 };
  function resolveTrade(review) {
    if (review.tradeId != null) { resolveHow.tradeId++; return trades.get(review.tradeId) || null; }
    if (!review.symbol) { ambiguous.no_symbol++; return null; }
    const list = bySymbol.get(review.symbol) || [];
    const hits = list.filter((tr) => {
      const o = tr.openAt ? new Date(tr.openAt).getTime() : -Infinity;
      const c = tr.closeAt ? new Date(tr.closeAt).getTime() : Infinity;
      return review.at.getTime() >= o && review.at.getTime() <= c;
    });
    if (hits.length === 1) { resolveHow['symbol+containment']++; return hits[0]; }
    ambiguous[hits.length === 0 ? 'no_containing_trade' : `ambiguous_${hits.length}`] =
      (ambiguous[hits.length === 0 ? 'no_containing_trade' : `ambiguous_${hits.length}`] || 0) + 1;
    return null;
  }

  // Ticks that can price a review: only the symbols/venues actually reviewed.
  const pairs = [...new Set(reviews.map((r) => `${trades.get(r.tradeId) ? trades.get(r.tradeId).symbol : ''}|${trades.get(r.tradeId) ? trades.get(r.tradeId).venue : ''}`))]
    .filter((k) => !k.startsWith('|'));
  if (!pairs.length) { console.log('no reviews map to a trade with levels'); process.exit(0); }

  const tickRows = [];
  for (const key of pairs) {
    const [symbol, venue] = key.split('|');
    const q = await pool.request().query(`
      SELECT capturedAt, bid, ask, source FROM PriceTicks
      WHERE userId = ${USER} AND symbol = '${symbol.replace(/'/g, "''")}' AND venue = '${venue.replace(/'/g, "''")}'
      ORDER BY capturedAt`);
    for (const row of q.recordset) {
      tickRows.push({ symbol, venue, t: new Date(row.capturedAt).getTime(), bid: row.bid, ask: row.ask, source: row.source });
    }
  }
  const byPair = new Map();
  for (const r of tickRows) {
    const k = `${r.symbol}|${r.venue}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }
  for (const list of byPair.values()) list.sort((a, b) => a.t - b.t);

  // Nearest usable tick to a review instant, preferring the venue's own poll and the closest in time.
  function nearest(symbol, venue, atMs, dir) {
    const list = byPair.get(`${symbol}|${venue}`) || [];
    let best = null;
    for (const r of list) {
      const dt = Math.abs(r.t - atMs);
      if (dt > TICK_TOL_SEC * 1000) continue;
      const pr = priceFor(dir, r);
      if (!pr) continue;
      const rank = SOURCE_RANK[r.source] == null ? 9 : SOURCE_RANK[r.source];
      if (!best || rank < best.rank || (rank === best.rank && dt < best.dt)) best = { ...pr, dt, rank, source: r.source };
    }
    return best;
  }

  // ---- replay --------------------------------------------------------------------------------------
  const out = [];
  let noTrade = 0; let noTick = 0; let alreadyFree = 0;
  const byTrade = new Map();
  for (const rv of reviews) {
    const tr = resolveTrade(rv);
    if (!tr) { noTrade++; continue; }
    if (tr.openAt && rv.at < new Date(tr.openAt)) { noTrade++; continue; }
    if (rv.skipped) { alreadyFree++; continue; }            // market_closed etc. — already costs no call
    const pr = nearest(tr.symbol, tr.venue, rv.at.getTime(), tr.direction);
    if (!pr) { noTick++; continue; }
    const stop = Number(tr.stopPrice); const tp = Number(tr.takeProfitPrice);
    const d = Math.min(Math.abs(pr.p - stop), Math.abs(pr.p - tp)) / pr.p * 100;
    if (!byTrade.has(tr.id)) byTrade.set(tr.id, []);
    byTrade.get(tr.id).push({ ...rv, tr, p: pr.p, basis: pr.basis, source: pr.source, d });
  }
  for (const list of byTrade.values()) list.sort((a, b) => a.at - b.at);

  const base = P_STAR; // rounded grid the plan registered
  for (const list of byTrade.values()) {
    let lastConvened = null;
    for (const rv of list) {
      const tooLong = lastConvened == null || (rv.at.getTime() - lastConvened) / 60000 >= CEILING_MIN;
      const near = rv.d < base;
      const suppress = !tooLong && !near;
      const blockedByCeiling = tooLong;
      if (!suppress) lastConvened = rv.at.getTime();
      out.push({ ...rv, suppress, blockedByCeiling, near });
    }
  }

  // Missed decision: suppressed, and the trade closed within the next review interval by something that
  // was NOT the venue acting.
  //
  // ★ "VENUE ACTED" INCLUDES A MARKET SHUTDOWN. A first version of this test was
  // `venue closed AND NOT market closed`, which counted #1073's market shutdown as a chair decision the
  // gate suppressed. It is not: the venue closed the book because the session ended, and no review verdict
  // could have changed it. That was a false positive of the METRIC, not a finding about the gate, and it is
  // corrected rather than reported as the one miss.
  const venueActed = (note) => /venue closed/i.test(String(note || ''));
  for (const o of out) {
    const closeAt = o.tr.closeAt ? new Date(o.tr.closeAt) : null;
    const within = closeAt && closeAt.getTime() > o.at.getTime()
      && (closeAt.getTime() - o.at.getTime()) / 60000 <= STEP_MIN;
    o.closeWithinStep = !!within;
    o.missedDecision = o.suppress && within && !venueActed(o.tr.note);
  }

  const suppressed = out.filter((o) => o.suppress);
  const missed = out.filter((o) => o.missedDecision);
  const ceilingBlocked = out.filter((o) => o.blockedByCeiling && !o.near).length;

  console.log(`=== TRD-REV-1 OBSERVE-MODE REPLAY — P* = ${P_STAR}%, ceiling = ${CEILING_MIN} min ===`);
  console.log(`  rule: suppress while distance > P* AND time since last convened < ceiling\n`);
  console.log(`  reviews in the log                    : ${raw.length}`);
  console.log(`  excluded — unparseable payload        : ${unparseable}`);
  console.log(`  reviews carrying NO tradeId           : ${noTradeId}   ★ SCHEMA-ERA, not a defect: the field was`);
  console.log(`                                            added 2026-09-18 15:17 (has: 09-18 15:17->now, none: 09-09->09-18 15:15)`);
  console.log(`    of those, resolved by symbol+containment : ${resolveHow['symbol+containment']}`);
  for (const [k, v] of Object.entries(ambiguous)) if (v) console.log(`    excluded — ${k}: ${v}`);
  console.log(`  resolved by tradeId                   : ${resolveHow.tradeId}`);
  console.log(`  excluded — already free (skipped)     : ${alreadyFree}   (market_closed etc.; MEASURED to cost 0 calls)`);
  console.log(`  excluded — no resolvable trade        : ${noTrade}`);
  console.log(`  excluded — NO TICK WITHIN ${TICK_TOL_SEC}s       : ${noTick}   ⚠ coverage limit, reported not hidden`);
  console.log(`  PRICED reviews (the replay's denominator): ${out.length}`);
  console.log(`    by price basis: ${JSON.stringify(out.reduce((a, o) => { a[o.basis] = (a[o.basis] || 0) + 1; return a; }, {}))}`);
  console.log(`    by source     : ${JSON.stringify(out.reduce((a, o) => { a[o.source] = (a[o.source] || 0) + 1; return a; }, {}))}`);

  console.log(`\n=== WHAT THE GATE WOULD DO ===`);
  console.log(`  would convene  : ${out.length - suppressed.length}  (${((out.length - suppressed.length) / (out.length || 1) * 100).toFixed(1)}%)`);
  console.log(`  would SUPPRESS : ${suppressed.length}  (${(suppressed.length / (out.length || 1) * 100).toFixed(1)}%)`);
  console.log(`    of which blocked-by-ceiling episodes that would otherwise have suppressed: ${ceilingBlocked}`);
  console.log(`\n  ★ CALLS SAVED : ${suppressed.length}  (1 suppressed review = 1 call; 96.2% pairing measured)`);
  console.log(`  ★ DECISIONS MISSED : ${missed.length}`);
  if (missed.length) {
    console.log(`    (a suppressed review whose trade then closed within ${STEP_MIN} min by something OTHER than the venue bracket)`);
    for (const m of missed) {
      console.log(`    #${m.tr.id} ${m.tr.symbol} ${m.tr.direction} at ${m.at.toISOString().slice(0, 16)} d=${m.d.toFixed(4)}% note="${m.tr.note}"`);
    }
  } else {
    console.log(`    none. Every suppressed review either had no close nearby, or the close was the venue's own`);
    console.log(`    bracket acting — which fires regardless of any chair decision, so it is not a missed decision.`);
  }

  // The distance distribution of the suppressed set, so the silence leaves a trace.
  const ds = suppressed.map((o) => o.d).sort((a, b) => a - b);
  if (ds.length) {
    const q = (f) => ds[Math.min(ds.length - 1, Math.floor(ds.length * f))];
    console.log(`\n  suppressed reviews' distance-to-nearest-level: p50 ${q(0.5).toFixed(3)}%  p90 ${q(0.9).toFixed(3)}%  min ${ds[0].toFixed(3)}%  max ${ds[ds.length - 1].toFixed(3)}%`);
    console.log(`    (the min is the closest the gate ever stayed silent — the number to check against P*)`);
  }

  // ★ THE COMPARISON THE PRE-REGISTRATION DEMANDS AND THIS SCRIPT ALMOST OMITTED: the false-silence rate
  // against its registered BUDGET. The budget is 1% (review-gate-thresholds.js BUDGET = 0.01) — the
  // probability the gate is wrong to stay silent. Computing the count without dividing by the suppressions
  // would report a number with no denominator, which is the shape of a result without being one.
  const BUDGET = 0.01;
  const missRate = suppressed.length ? missed.length / suppressed.length : null;
  console.log(`\n=== FALSE-SILENCE AGAINST ITS REGISTERED BUDGET ===`);
  if (missRate == null) {
    console.log(`  no suppressions — the rate is undefined, not zero`);
  } else {
    console.log(`  missed decisions / suppressions = ${missed.length} / ${suppressed.length} = ${(missRate * 100).toFixed(2)}%`);
    console.log(`  registered budget               = ${(BUDGET * 100).toFixed(2)}%`);
    console.log(`  → ${missRate <= BUDGET ? 'WITHIN budget' : '★ OUTSIDE budget'}  ${missed.length <= 4 ? '⚠ but with n=' + missed.length + ' the rate is barely estimated — a 95% upper bound is ~' + (3 / suppressed.length * 100).toFixed(2) + '%' : ''}`);
  }

  console.log(`\n★ NOTHING WAS WRITTEN. No gate, no behaviour change, no event. This is a replay of stored reviews.`);
  console.log(`  ⚠ The replay is a LOWER BOUND on suppression: it can only price reviews a tick survived to cover.`);
  process.exit(0);
})().catch((e2) => { console.error('FAILED:', e2.message); process.exit(1); });
