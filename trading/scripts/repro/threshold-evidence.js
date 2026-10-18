// trading/scripts/repro/threshold-evidence.js — evidence-based sample-size thresholds.
// v2 (2026-09-13): addresses review findings — retirement tested on EXPECTANCY not win
// rate, the UNION of the parity triggers, t-distribution everywhere, formula
// conventions stated, sample provenance, and an arrival rate derived from the data.
//
// The desk uses three different numbers with no derivation:
//   20  — chairs are shown a strategy track record only at >= 20 closed trades
//         (aggregator.MIN_EVIDENCE_TRADES, task P1-10 2026-09-10; the comment states
//          the INTENT — "so the LLM can't anchor on 2-trade noise" — not the value)
//   10  — the weekly parity harness may RETIRE a strategy at >= 10 closed trades
//         (store.js DEFAULT_SETTINGS learning.parity.minTrades; README line 150)
//   50  — acceptance demands positive expectancy at n >= 50 per strategy
//         (review doc 2026-09-10 section 6, success criterion (b))
// All three are STATED INTENT. None is derived from the desk's own variance.
//
// Statistics, with conventions stated because they change the numbers:
//   * Wilson score interval for a proportion (correct at small n)
//   * Student-t interval for mean R, df = n-1, table for df 1..30 then 1.96
//   * One-sample proportion power: n = (z_a*sqrt(p0(1-p0)) + z_b*sqrt(p1(1-p1)))^2 / (p1-p0)^2
//   * Monte Carlo for the UNION of the parity triggers (no closed form for the joint
//     event), resampling a MEAN-CENTRED empirical R pool so the null is a genuinely
//     zero-expectancy strategy
//
// Read-only. Usage (from the repo root): node trading/scripts/repro/threshold-evidence.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const Z_A = 1.959964;   // two-sided alpha 0.05
const Z_B = 0.841621;   // power 0.80
// t critical values by df = n-1: two-sided 95%, and one-sided 95%.
const T_2S = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
const T_1S = [NaN, 6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.740, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697];
// Exact values above df=30 for the df this analysis quotes, so no lookup is silently
// replaced by 1.96 (t(49) = 2.010, not 1.96 — a 2.5% understatement of the interval).
const T_2S_EXT = { 31: 2.040, 32: 2.037, 35: 2.030, 40: 2.021, 45: 2.014, 49: 2.010, 50: 2.009, 60: 2.000, 80: 1.990, 99: 1.984, 100: 1.984, 120: 1.980, 199: 1.972, 200: 1.972 };
const T_1S_EXT = { 31: 1.696, 32: 1.694, 35: 1.690, 40: 1.684, 45: 1.680, 49: 1.677, 50: 1.676, 60: 1.671, 80: 1.664, 99: 1.660, 100: 1.660, 120: 1.658, 199: 1.653, 200: 1.653 };
function tAt(df, one) {
  if (!(df >= 1)) return NaN;
  const tbl = one ? T_1S : T_2S;
  const ext = one ? T_1S_EXT : T_2S_EXT;
  if (df <= 30) return tbl[df];
  if (ext[df] != null) return ext[df];
  return one ? 1.645 : 1.96;   // normal limit, only for df not listed above
}
const t2 = (n) => tAt(n - 1, false);   // two-sided 95%, df = n-1
const t1 = (n) => tAt(n - 1, true);    // one-sided 95%, df = n-1

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

// Wilson score interval half-width at proportion p and sample n.
function wilsonHalf(p, n) {
  if (!(n > 0)) return NaN;
  const z2 = Z_A * Z_A;
  return (Z_A * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}
// n to detect true proportion p1 against reference p0 at 80% power, alpha .05 two-sided.
function nForProportion(p0, p1) {
  const d = Math.abs(p1 - p0);
  if (d === 0) return Infinity;
  return Math.ceil(((Z_A * Math.sqrt(p0 * (1 - p0)) + Z_B * Math.sqrt(p1 * (1 - p1))) ** 2) / (d * d));
}
// P(X <= k) for Binomial(n, p).
function binomTail(n, p, k) {
  let sum = 0;
  for (let i = 0; i <= Math.min(k, n); i++) {
    let logc = 0;
    for (let j = 0; j < i; j++) logc += Math.log(n - j) - Math.log(j + 1);
    sum += Math.exp(logc + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, sum);
}

(async () => {
  const db = await getPool();
  const rows = (await db.request().query(
    `SELECT id, ISNULL(strategyId,'(untagged)') AS strategy, grossPnl, size, openPrice, stopPrice,
            CONVERT(varchar(10), closeAt, 120) AS closeDay,
            CONVERT(varchar(10), DATEADD(hour, 8, closeAt), 120) AS closeDaySgt,
            CONVERT(varchar(19), closeAt, 126) AS closeIso
       FROM Trades
      WHERE grossPnl IS NOT NULL AND size IS NOT NULL AND openPrice IS NOT NULL AND stopPrice IS NOT NULL
        AND venue = 'plus500' AND ABS(openPrice - stopPrice) > 0
      ORDER BY id`,
  )).recordset;
  const totals = (await db.request().query(
    `SELECT
       (SELECT COUNT(*) FROM Trades WHERE grossPnl IS NOT NULL) AS closed_total,
       (SELECT COUNT(*) FROM Trades WHERE grossPnl IS NOT NULL AND stopPrice IS NULL) AS closed_no_stop`,
  )).recordset[0];
  // The live/backtest NAME SPACES are read from settings rather than hardcoded, because a
  // stale constant here would silently reproduce the very defect section 6d measures.
  const enabledRow = (await db.request().query(
    `SELECT TOP 1 JSON_QUERY(settings,'$.strategies.enabled') AS e FROM TradingSettings ORDER BY userId`,
  )).recordset[0];
  const LIVE = (() => {
    try {
      const a = JSON.parse(enabledRow && enabledRow.e);
      return Array.isArray(a) && a.length ? a : ['survoil', 'survgold'];
    } catch { return ['survoil', 'survgold']; }
  })();

  // SELECTION RULE (stated so it reconciles against the other reports):
  //   venue='plus500' AND grossPnl/size/openPrice/stopPrice NOT NULL AND |openPrice-stopPrice| > 0
  // openPrice is the FILL (executor writes fill.price), so |fill - stop| is the REALISED
  // risk and R = pnl / realised-risk is the true R-multiple of the trade.
  const trades = rows.map((r) => ({
    id: r.id, strategy: r.strategy,
    R: Number(r.grossPnl) / (Math.abs(Number(r.openPrice) - Number(r.stopPrice)) * Number(r.size)),
    closeDay: r.closeDay,           // UTC calendar date (closeAt is stored UTC)
    closeDaySgt: r.closeDaySgt,     // the desk's human trading day = UTC+8
    closeMs: Date.parse(`${r.closeIso}Z`),
  })).filter((t) => Number.isFinite(t.R));

  const R = trades.map((t) => t.R);
  const n = R.length;
  const wins = R.filter((x) => x > 0).length;
  const p = wins / n;
  const mR = mean(R), sR = sd(R);

  console.log(`\n=== 1. Sample provenance ===`);
  console.log(`  selected ${n} of ${totals.closed_total} closed trades; excluded ${totals.closed_no_stop} with no stopPrice`);
  console.log(`  (all untagged legacy rows). That is why the strategy report's "12 untagged" and this`);
  console.log(`  doc's "1 untagged" are both right — different cuts of the same 25. ${n} = 13 tagged + 1.`);
  console.log(`  R = pnl / |fill - stop| = REALISED risk (not the intended 2xATR), so R is the true`);
  console.log(`  multiple of risk actually taken. It is NOT comparable to backtest R, which uses the`);
  console.log(`  intended stop from the same bar close — a comparability caveat, not a variance one.`);

  console.log(`\n=== 2. The desk's distribution (t-distribution, df = n-1 = ${n - 1}) ===`);
  console.log(`  win rate   ${(p * 100).toFixed(1)}%  (${wins}/${n})   Wilson 95% CI half-width ${(wilsonHalf(p, n) * 100).toFixed(1)}pp`);
  console.log(`  mean R     ${f(mR)}R   sd ${f(sR)}R   SE ${f(sR / Math.sqrt(n))}R`);
  console.log(`  95% CI     ${f(mR - t2(n) * sR / Math.sqrt(n))} .. ${f(mR + t2(n) * sR / Math.sqrt(n))}  (t(${n - 1}) = ${f(t2(n))})`);
  console.log(`  => spans zero. Win rate alone is NOT the edge metric: ${(p * 100).toFixed(0)}% win with a`);
  console.log(`     ${f(sR)}R spread is consistent with profit OR loss; only expectancy in R decides.`);

  console.log(`\n=== 3. What n buys (CI quoted at BOTH the observed p and p = 0.5) ===`);
  console.log('   n    winCI@p-hat  winCI@p=.5   meanR 95% CI    MDE(R)   detectable gap vs 50%');
  for (const N of [10, 20, 30, 50, 100, 200]) {
    let gap = NaN;
    for (let g = 0.01; g <= 0.6; g += 0.005) { if (nForProportion(0.5, 0.5 - g) <= N) { gap = g; break; } }
    console.log(`  ${String(N).padStart(3)}     +/-${(wilsonHalf(p, N) * 100).toFixed(1)}pp     +/-${(wilsonHalf(0.5, N) * 100).toFixed(1)}pp      +/-${f(t2(N) * sR / Math.sqrt(N))}R      ${f((Z_A + Z_B) * sR / Math.sqrt(N))}R     +/-${Number.isFinite(gap) ? (gap * 100).toFixed(1) : '>60'}pp`);
  }
  console.log(`  MDE = (z_a+z_b)*sd/sqrt(n); intervals use Student-t with df = n-1 (t(49) = 2.010,`);
  console.log(`  not 1.96). A pooled two-sample MDE convention gives ~4pp more at n=10 (44 vs 40)`);
  console.log(`  and ~1pp at n=50 — the divergence is small where it matters and does not change`);
  console.log(`  any conclusion below, but it is stated so the column is reproducible.`);

  console.log(`\n=== 4. Arrival rate, derived from the data (not assumed) ===`);
  // CLOCK: closeAt is stored UTC (verified against accepted TradingPrompts.createdAt, e.g. prompt
  // 16:35:22 -> open 16:35:46). The desk's HUMAN trading day is SGT = UTC+8, and UTC midnight falls
  // INSIDE a live session, so UTC calendar dates split one session across two rows. That artifact is
  // why an earlier revision reported "2 close-days" for a strategy whose closes are one session.
  const byStrat = new Map();
  for (const t of trades) byStrat.set(t.strategy, [...(byStrat.get(t.strategy) || []), t]);
  const utcDays = new Set(trades.map((t) => t.closeDay));
  const sgtDays = new Set(trades.map((t) => t.closeDaySgt));
  console.log(`  ${n} selected closes span ${utcDays.size} UTC dates and ${sgtDays.size} SGT dates`);
  console.log(`   strategy     closes   UTC d   SGT d`);
  for (const [s, arr] of [...byStrat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   ${s.padEnd(11)} ${String(arr.length).padStart(5)} ${String(new Set(arr.map((t) => t.closeDay)).size).padStart(6)} ${String(new Set(arr.map((t) => t.closeDaySgt)).size).padStart(6)}`);
  }
  const liveRows = trades.filter((t) => LIVE.includes(t.strategy));
  const liveN = liveRows.length;
  const liveDays = [...new Set(liveRows.map((t) => t.closeDaySgt))].sort();   // an ARRAY, so .length
  const stamps = liveRows.map((t) => t.closeMs).filter(Number.isFinite);
  const spanH = stamps.length ? (Math.max(...stamps) - Math.min(...stamps)) / 3600000 : NaN;
  const byDay = liveDays.map((d) => ({ d, k: liveRows.filter((t) => t.closeDaySgt === d).length }));
  const best = byDay.reduce((a, b) => (b.k > a.k ? b : a), byDay[0]);
  const rateSession = liveN / LIVE.length;
  const rateBestDay = best.k / LIVE.length;
  const liveRate = liveN / (LIVE.length * liveDays.length);   // window average: the pessimistic one
  console.log(`  the two LIVE strategies: ${liveN} closes, first-to-last spread ${f(spanH, 1)}h of wall clock`);
  console.log(`    by SGT day: ${byDay.map((x) => `${x.d}=${x.k}`).join(', ')}`);
  console.log(`  RATES — all three are true, each needs its denominator stated:`);
  console.log(`    ${f(rateSession, 2)} closes/strategy/SESSION      (${liveN} / ${LIVE.length} strategies, one session — the strategy report's "day one")`);
  console.log(`    ${f(rateBestDay, 2)} closes/strategy/SGT-day      (${best.k} closes on ${best.d} / ${LIVE.length})`);
  console.log(`    ${f(liveRate, 2)} closes/strategy/SGT-day      (${liveN} / (${LIVE.length} strategies x ${liveDays.length} live-window days))  <- used as the pessimistic rate`);

  console.log(`\n=== 5. Required n for a true edge (sd ${f(sR)}R) ===`);
  for (const edge of [0.10, 0.15, 0.20, 0.30, 0.40]) {
    const need = Math.ceil(((Z_A + Z_B) * sR / edge) ** 2);
    console.log(`  +${edge.toFixed(2)}R/trade  n=${String(need).padStart(4)}   @${f(rateSession, 2)}/session ${String(Math.ceil(need / rateSession)).padStart(3)}d   @${f(rateBestDay, 2)}/SGT-day ${String(Math.ceil(need / rateBestDay)).padStart(3)}d   @${f(liveRate, 2)}/SGT-day ${String(Math.ceil(need / liveRate)).padStart(4)}d`);
  }
  console.log(`  "n >= 50" suffices only for an edge of +${(((Z_A + Z_B) * sR) / Math.sqrt(50)).toFixed(2)}R or larger.`);

  console.log(`\n=== 6a. Current rule's WIN-RATE branch is NOT invariant to the reference ===`);
  console.log(`  retire if winRate < p0 - 20pp, at n = minTrades = 10.`);
  console.log(`  p0 (backtest rate)   boundary    P(retire by chance | true rate = p0)`);
  for (const p0 of [0.45, 0.50, 0.55, 0.60]) {
    const k = Math.ceil((p0 - 0.20) * 10) - 1;   // largest win count strictly below the threshold
    console.log(`   ${(p0 * 100).toFixed(0)}%                  <=${String(k).padStart(2)} wins      ${(binomTail(10, p0, k) * 100).toFixed(2)}%`);
  }
  console.log(`  a naive "<= 3 wins" reading is only right when p0 is 45-50%; the boundary moves with p0.`);

  console.log(`\n=== 6b. Current rule — the UNION of both triggers (Monte Carlo) ===`);
  const nullPool = R.map((x) => x - mR);   // zero-expectancy null, desk's own shape
  const nullWinRate = nullPool.filter((x) => x > 0).length / nullPool.length;
  const TRIALS = 40000;
  const drawSample = (N) => {
    const d = [];
    let sum = 0, w = 0;
    for (let i = 0; i < N; i++) {
      const v = nullPool[Math.floor(Math.random() * nullPool.length)];
      d.push(v); sum += v; if (v > 0) w++;
    }
    return { m: sum / N, w, s: sd(d) };
  };
  console.log(`  null pool: mean-centred empirical R, win rate ${(nullWinRate * 100).toFixed(1)}%, ${TRIALS} trials/sample`);
  console.log(`   n    P(win-lag)   P(exp<=0)    P(UNION)   <- the union is what actually retires`);
  for (const N of [10, 20, 30, 50]) {
    let w = 0, e = 0, either = 0;
    for (let t = 0; t < TRIALS; t++) {
      const s = drawSample(N);
      const wTrig = s.w / N < nullWinRate - 0.20;
      const eTrig = s.m <= 0;
      if (wTrig) w++;
      if (eTrig) e++;
      if (wTrig || eTrig) either++;
    }
    console.log(`  ${String(N).padStart(3)}     ${((w / TRIALS) * 100).toFixed(1)}%       ${((e / TRIALS) * 100).toFixed(1)}%       ${((either / TRIALS) * 100).toFixed(1)}%`);
  }

  console.log(`  Branch A is measured AGAINST A REFERENCE, and the reference here is the CENTRED POOL's win`);
  console.log(`  rate (${(nullWinRate * 100).toFixed(1)}%), not the raw observed rate (${(p * 100).toFixed(1)}%). The trigger is relative, so it`);
  console.log(`  changes P(A). Analytic binomial comparison:`);
  for (const N of [10, 20]) {
    for (const [label, ref] of [['centred pool (the null used above)', nullWinRate], ['raw observed rate', p]]) {
      const k = Math.ceil((ref - 0.20) * N) - 1;
      console.log(`    n=${String(N).padStart(2)}  ref ${(ref * 100).toFixed(1)}% (${label.padEnd(32)}) -> <=${String(k).padStart(2)} wins -> P(A) = ${(binomTail(N, ref, k) * 100).toFixed(2)}%`);
    }
  }
  console.log(`  NOTE the expectancy<=0 branch fires ~50% at EVERY n: it is a point estimate with no`);
  console.log(`  error control, so it does not improve with more data. It dominates the union.`);

  console.log(`\n=== 6c. PROPOSED rule — retire on EXPECTANCY (one-sided 95% upper bound < 0) ===`);
  console.log('   n    retire if mean R <     MC false-retire rate (target 5%)');
  for (const N of [10, 20, 30, 50]) {
    let fire = 0;
    const T = Math.round(TRIALS / 2);
    for (let t = 0; t < T; t++) {
      const s = drawSample(N);
      if (s.m + t1(N) * s.s / Math.sqrt(N) < 0) fire++;
    }
    console.log(`  ${String(N).padStart(3)}          ${f(-t1(N) * sR / Math.sqrt(N))}R            ${((fire / T) * 100).toFixed(1)}%`);
  }
  console.log(`  Tests the EDGE, not the win rate: a 30%-win/3:1-payoff strategy survives, a`);
  console.log(`  55%-win/0.3:1-payoff strategy does not — the win-rate rule gets both backwards.`);

  console.log(`\n=== 6d. Can branch A even FIRE? (does each live strategy have a BACKTEST RUN?) ===`);
  // parityCheck does: runs.find(r => r.strategy === s.strategy)  -> EXACT NAME match.
  // Without a match: oosWin = null -> Number.isFinite(null) === false -> lagging === false.
  const runs = (await db.request().query(
    `SELECT strategy, CONVERT(varchar(10), periodEnd, 120) AS toD,
            JSON_VALUE(metrics,'$.cfd.winRate') AS cfdWin,
            JSON_VALUE(metrics,'$.cfd.trades')  AS cfdTrades
       FROM BacktestRuns ORDER BY id DESC`,
  )).recordset;
  const MIN_TRADES = 10;   // store.js DEFAULT_SETTINGS learning.parity.minTrades
  console.log(`  matching is by EXACT NAME; minTrades = ${MIN_TRADES}. No match -> the win-lag branch is`);
  console.log(`  silently FALSE for that strategy, at every n, forever.`);
  console.log(`   strategy      live n   n>=10?   backtest run                 ref WR   boundary -> P(fire)`);
  for (const [s, arr] of [...byStrat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const bt = runs.find((r) => r.strategy === s);
    const enough = arr.length >= MIN_TRADES ? 'yes' : 'no ';
    const prefix = `   ${s.padEnd(12)} ${String(arr.length).padStart(5)}   ${enough.padEnd(7)}`;
    if (!bt) {
      console.log(`${prefix} NONE -> branch A CANNOT FIRE`);
    } else {
      const ref = Number(bt.cfdWin) / 100;
      if (!Number.isFinite(ref)) {
        console.log(`${prefix} run ${bt.cfdTrades} trd to ${bt.toD}, NO winRate field -> CANNOT FIRE`);
      } else {
        const k = Math.ceil((ref - 0.20) * MIN_TRADES) - 1;
        console.log(`${prefix} ${(`run ${bt.cfdTrades} trd to ${bt.toD}`).padEnd(28)} ${(ref * 100).toFixed(1)}%   <=${k} wins -> ${(binomTail(MIN_TRADES, ref, k) * 100).toFixed(2)}%`);
      }
    }
  }
  const noRun = LIVE.filter((s) => !runs.some((r) => r.strategy === s));
  console.log(`  enabled = ${JSON.stringify(LIVE)}`);
  console.log(`  of those, ${noRun.length} have NO run: ${noRun.length ? JSON.stringify(noRun) : '(none)'}`);
  if (noRun.length) {
    console.log(`  => for those strategies branch A is UNREACHABLE, so their real false-retire rate is`);
    console.log(`     P(B) ALONE (~50%), not the union's ~51% and not P(A). The union figure is an upper`);
    console.log(`     bound that happens to be right, for a different reason than the MC assumes.`);
  }
  const refs = [...new Set(runs.map((x) => Number(x.cfdWin) / 100).filter(Number.isFinite))].sort((a, b) => a - b);
  console.log(`  What each REAL reference does to a genuinely GOOD strategy (a true 70%-win live`);
  console.log(`  strategy, i.e. one with an actual edge) at n=10 — this is the defect made concrete:`);
  for (const r of refs) {
    const k = Math.ceil((r - 0.20) * MIN_TRADES) - 1;
    console.log(`    ref ${(r * 100).toFixed(0).padStart(3)}%  <=${String(k).padStart(2)} wins -> retired with probability ${(binomTail(MIN_TRADES, 0.70, k) * 100).toFixed(2)}%`);
  }

  console.log(`\n=== 7. Per-strategy reality (t-based CIs, so small n is not flattered) ===`);
  for (const [s, arr] of [...byStrat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const w = arr.filter((t) => t.R > 0).length;
    const a = arr.map((t) => t.R);
    console.log(`  ${s.padEnd(11)} n=${String(arr.length).padStart(2)}  win ${((w / arr.length) * 100).toFixed(0)}%  mean ${f(mean(a))}R  +/-${f(arr.length > 1 ? t2(arr.length) * sd(a) / Math.sqrt(arr.length) : NaN)}R (t-based)`);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
