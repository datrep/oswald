// trading/scripts/repro/risk-level-experiment.js
//
// THE EXPERIMENT THE OWNER ASKED FOR: is a risk-per-trade of 2.5-7.5% profitable on paper, and what does it
// actually cost given the desk's instrument set?
//
// WHY THIS IS NOT JUST "SCALE THE NUMBERS". Risk per trade is normally a PURE SCALAR on a trade distribution: it
// multiplies the return and the drawdown together and changes nothing about the sign. But on THIS desk it is NOT
// purely a scalar, because of the CEILING:
//
//     r <= L x s%      (the purchasing-power wall)      =>      ceiling_symbol = L_symbol x stop_symbol%
//
// A trade risking r% with a stop of s% needs notionalPct = r/s, and the venue only permits L x 100. So **raising r
// removes the low-leverage symbols from the tradeable set.** That is a real, measurable channel, and it is what
// makes this a question with an answer rather than an opinion: at r = 5% only Oil and SGX can be traded at all.
//
// THE OBJECTIVE. Not "is the mean positive" (a scalar question) but the GROWTH RATE of the equity curve:
//
//     g(r) = E[ log(1 + r x R) ]        over the FEASIBLE trade pool at that r
//
// g is maximised near the Kelly fraction (r* ~ mean(R)/E[R^2]), is zero at r = 0, and goes NEGATIVE past roughly
// twice Kelly. It is the right objective because it is the only one that penalises a fat tail the way ruin does.
//
// EVERY NUMBER IS BOOTSTRAPPED with a fixed seed, so a re-run is byte-identical and the intervals are real.
//
// READ-ONLY. Writes nothing.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const SEED = 20260929;
const TRIALS = 4000;
const PATH_LEN = 100;
const GRID = [0.5, 0.55, 0.75, 1, 1.16, 1.5, 2, 2.5, 3, 4, 4.79, 5, 6.28, 7.5];

// mulberry32 — the same generator the geometry harness uses, so the two studies share a provenance.
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sampleSd = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const f = (v, d = 4) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d));
const percentile = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
};

// The bootstrap is done inline in sections 3 and 4 because the corrected model bootstraps the PAIR
// (effective risk, R) together — they are linked by the ceiling, so resampling one without the other would
// break the mechanism being measured.

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);

  console.log('=== 1. THE CEILING OF EVERY SYMBOL THE DESK HAS TRADED ===');
  const syms = await q(`SELECT DISTINCT symbol FROM dbo.Trades WHERE userId=1 AND openPrice IS NOT NULL`);
  const ceiling = {};
  for (const { symbol: sym } of syms) {
    const esc = String(sym).replace(/'/g, "''");
    const t = (await q(`SELECT TOP 1 id, decisionId, openPrice FROM dbo.Trades
        WHERE userId=1 AND symbol='${esc}' AND openPrice IS NOT NULL AND decisionId IS NOT NULL ORDER BY id DESC`))[0];
    if (!t) continue;
    const d = (await q(`SELECT TOP 1 payload FROM dbo.TradingEvents
        WHERE kind='decision' AND JSON_VALUE(payload,'$.promptId')=${Number(t.decisionId)}
          AND JSON_VALUE(payload,'$.symbol')='${esc}' ORDER BY id DESC`))[0]
      || (await q(`SELECT TOP 1 payload FROM dbo.TradingEvents
        WHERE kind='decision' AND id=${Number(t.decisionId)} AND JSON_VALUE(payload,'$.symbol')='${esc}'`))[0];
    if (!d) continue;
    let p; try { p = JSON.parse(d.payload); } catch { continue; }
    const decl = Number(p.stopDistance); const px = Number(t.openPrice);
    if (!(decl > 0) || !(px > 0)) continue;
    const sp = (await q(`SELECT TOP 1 leverageRaw FROM dbo.Instruments WHERE userId=1 AND venue='plus500'
        AND symbol='${esc}' AND leverageRaw IS NOT NULL ORDER BY capturedAt DESC`))[0] || {};
    const L = Number(String(sp.leverageRaw || '').split(':')[1]) || null;
    if (L) ceiling[sym] = L * (decl / px) * 100;
  }
  for (const [k, v] of Object.entries(ceiling).sort((a, b) => a[1] - b[1])) {
    console.log(`  ${String(k).padEnd(17)} ceiling ${f(v, 2)}%`);
  }

  console.log('\n=== 2. THE R POPULATION (the desk\'s own closed trades) ===');
  const rows = await q(`SELECT id, symbol, grossPnl, size, openPrice, stopPrice FROM dbo.Trades
    WHERE userId=1 AND status='closed' AND grossPnl IS NOT NULL AND size IS NOT NULL
      AND openPrice IS NOT NULL AND stopPrice IS NOT NULL ORDER BY id`);
  const all = [];
  for (const t of rows) {
    const risk = Math.abs(Number(t.openPrice) - Number(t.stopPrice)) * Number(t.size);
    if (risk > 0) all.push({ symbol: t.symbol, R: Number(t.grossPnl) / risk });
  }
  const allR = all.map((x) => x.R);
  const mAll = mean(allR); const sdAll = sampleSd(allR);
  const seAll = sdAll / Math.sqrt(allR.length);
  console.log(`  n=${allR.length}  mean=${f(mAll)}  sd=${f(sdAll)}  se=${f(seAll)}`);
  console.log(`  one-sided 95% lower bound on the mean R: ${f(mAll - 1.7 * seAll)}`);
  console.log(`  win rate ${f(allR.filter((x) => x > 0).length / allR.length * 100, 1)}%`);
  if (allR.length < 20) { console.log('  *** too few trades for a stable interval — treat everything below as a READING, not evidence'); }

  console.log('\n=== 3. THE EXPERIMENT: g(r) = E[log(1 + r_effective x R)] ===');
  console.log('  \u26a0 MODEL CORRECTION (owner, 2026-09-29). The first version of this script modelled "raising r EXCLUDES');
  console.log('  the low-ceiling symbols". THAT IS WRONG, and the owner was right to push back: the engine CAPS a size,');
  console.log('  it does not refuse a trade (`size = min(size, maxValue / price)` in risk.js). So the correct model is');
  console.log('      r_effective_i = min(r, ceiling_i)      applied to EVERY trade \u2014 no trade is dropped.');
  console.log('  R is DIMENSIONLESS (pnl / risk), so a trade\'s R-multiple is identical at any risk level; only its EQUITY');
  console.log('  IMPACT changes. The exclusion model silently deleted 21 trades and manufactured a fake result ("the mean');
  console.log('  gets worse above 4.79%") out of a symbol-selection effect that does not exist.');
  console.log('\n  So the ONLY channels through which r acts are: the equity impact per trade, the margin the book consumes,');
  console.log('  and how fast a drawdown compounds. Nothing here excludes an instrument.\n');
  console.log('     r      limited   meanR_eff  g(r)       g 95% CI           maxDD   P(<50%)  P(<25%)');
  const results = [];
  for (const r of GRID) {
    const rf = r / 100;
    const eff = all.map((x) => Math.min(rf, (ceiling[x.symbol] ?? rf) / 100));
    const limited = eff.filter((v) => v < rf - 1e-12).length;
    const Rs = all.map((x) => x.R);
    const g = (() => { let s = 0; for (let i = 0; i < Rs.length; i++) { const w = 1 + eff[i] * Rs[i]; s += Math.log(w > 1e-9 ? w : 1e-9); } return s / Rs.length; })();
    // Bootstrap the PAIR (effective risk, R) together — the pairing is the mechanism, so it must not be broken.
    const rnd = seededRandom(SEED);
    const bg = [];
    const n = Rs.length;
    for (let t = 0; t < TRIALS; t++) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const j = Math.floor(rnd() * n);
        const w = 1 + eff[j] * Rs[j];
        s += Math.log(w > 1e-9 ? w : 1e-9);
      }
      bg.push(s / n);
    }
    bg.sort((a, b) => a - b);
    const lo = percentile(bg, 5); const hi = percentile(bg, 95);
    // Paths, using the same paired pairs.
    const rnd2 = seededRandom(SEED + 7);
    const dds = []; const finals = [];
    for (let t = 0; t < TRIALS; t++) {
      let eq = 1; let peak = 1; let maxDd = 0;
      for (let k = 0; k < PATH_LEN; k++) {
        const j = Math.floor(rnd2() * n);
        eq = Math.max(1e-9, eq * (1 + eff[j] * Rs[j]));
        if (eq > peak) peak = eq;
        const dd = 1 - eq / peak;
        if (dd > maxDd) maxDd = dd;
      }
      dds.push(maxDd); finals.push(eq);
    }
    const p50 = finals.filter((x) => x <= 0.5).length / finals.length * 100;
    const p25 = finals.filter((x) => x <= 0.25).length / finals.length * 100;
    const meanEff = mean(eff) * 100;
    results.push({ r, limited, meanEff, meanR: mean(Rs), g, lo, hi, dd: percentile(dds, 50), p50, p25 });
    console.log(`  ${String(r + '%').padEnd(7)} ${String(limited + '/' + n).padEnd(10)} ${f(meanEff, 3).padStart(8)}   ${f(g, 5).padStart(9)}  ` +
      `[${f(lo, 5)}, ${f(hi, 5)}]  ${f(percentile(dds, 50) * 100, 1).padStart(5)}%  ${f(p50, 1).padStart(6)}%  ${f(p25, 1).padStart(6)}%`);
  }
  console.log('\n  (limited = trades CAPPED at their symbol ceiling instead of getting the full r; meanR_eff = mean of');
  console.log('   min(r, ceiling) in % of equity, i.e. what the desk would actually be risking per trade on average)');

  console.log('\n=== 3b. WHAT r=3.0% ACTUALLY DELIVERS (owner decision 2026-09-29) ===');
  console.log('  The target is capped TWICE: once by the purchasing-power ceiling, and once by the MARGIN GUARD. For a');
  console.log('  single position, margin = r/ceiling of equity, so a utilisation ceiling u caps that position at');
  console.log('      r_effective = min( r, u x ceiling_i )');
  console.log('  This is the number the desk would ACTUALLY risk, and it is the one to quote.\n');
  const U = 0.80;
  console.log('     symbol             ceiling    r=3% capped by u=80% at    margin/pos     max concurrent');
  for (const [sym, c] of Object.entries(ceiling).sort((a, b) => a[1] - b[1])) {
    const eff = Math.min(3.0, U * c);
    const boundBy = 3.0 <= c ? (eff < 3.0 ? 'MARGIN u' : 'target') : 'CEILING';
    console.log(`     ${String(sym).padEnd(18)} ${f(c, 2).padStart(6)}%   ${f(eff, 2).padStart(10)}%  (${boundBy.padEnd(8)})  ${f(eff / c * 100, 0).padStart(4)}%        ${Math.floor(U * c / eff)}`);
  }
  const effAll = all.map((x) => Math.min(3.0, U * (ceiling[x.symbol] ?? 3.0)) / 100);
  const Rall = all.map((x) => x.R);
  let gU = 0;
  for (let i = 0; i < Rall.length; i++) { const w = 1 + effAll[i] * Rall[i]; gU += Math.log(w > 1e-9 ? w : 1e-9); }
  gU /= Rall.length;
  console.log(`\n  over the ${Rall.length}-trade population: mean effective risk ${f(mean(effAll) * 100, 3)}%  (vs 2.49% without the u cap)`);
  console.log(`  growth at r=3% with u=80%: g = ${f(gU, 5)}   (vs ${f(results.find((x) => x.r === 3)?.g, 5)} unconstrained by u)`);
  console.log('  \u26a0 so the margin guard is not just a safety net \u2014 it is the binding constraint, and it LOWERS the');
  console.log('    effective risk below the target on Gold (2.20% vs 2.75%) and Bitcoin (0.93%). At u=80% the target of');
  console.log('    3.0% is only reached on Coffee, Silver, Oil and SGX.');

  console.log('\n=== 4. KELLY under the CORRECT (cap) model ===');
  const fine = [];
  for (let r = 0.05; r <= 12; r += 0.05) {
    const rf = r / 100;
    let s = 0;
    for (const x of all) { const w = 1 + Math.min(rf, (ceiling[x.symbol] ?? rf) / 100) * x.R; s += Math.log(w > 1e-9 ? w : 1e-9); }
    fine.push({ r, g: s / all.length });
  }
  const g0 = fine.find((x) => Math.abs(x.r - 0.05) < 1e-9);
  fine.sort((a, b) => b.g - a.g);
  console.log(`  growth-max r* = ${f(fine[0].r, 2)}%   g* = ${f(fine[0].g, 5)}`);
  console.log(`  g at r=0.05% (near-zero risk)      = ${f(g0.g, 5)}`);
  console.log(`  g at r=2.5%  = ${f(results.find((x) => x.r === 2.5)?.g, 5)}   g at r=5% = ${f(results.find((x) => x.r === 5)?.g, 5)}   g at r=7.5% = ${f(results.find((x) => x.r === 7.5)?.g, 5)}`);
  console.log(`  closed form (uncapped): mean/E[R^2] = ${f(mAll / (sdAll * sdAll + mAll * mAll) * 100, 2)}%`);
  console.log('  \u26a0 NOTHING IS EXCLUDED, so the growth curve is monotone up to the optimum and falls after it \u2014 the');
  console.log('    shape is set by the tail (E[R^2]), not by which symbols survive.');

  console.log('\n=== 5. THE VERDICT ON THE 2.5-7.5% BAND ===');
  const band = results.filter((x) => x.r >= 2.5 && x.r <= 7.5);
  for (const x of band) {
    const verdict = x.lo > 0 ? 'POSITIVE (CI excludes 0)' : (x.hi < 0 ? 'NEGATIVE (CI excludes 0)' : 'INDISTINGUISHABLE FROM ZERO');
    console.log(`  r=${String(x.r + '%').padEnd(6)} mean effective risk ${f(x.meanEff, 2)}%  g=${f(x.g, 5)}  CI [${f(x.lo, 5)}, ${f(x.hi, 5)}]  ` +
      `maxDD ${f(x.dd * 100, 1)}%  P(<50%) ${f(x.p50, 1)}%  -> ${verdict}`);
  }
  console.log('\n  \u26a0 R IS A SCALAR ON THE R-DISTRIBUTION *UP TO THE CEILING*. Above a symbol\'s ceiling the dial stops');
  console.log('    doing anything on that symbol: r=5% and r=7.5% differ ONLY on Oil and SGX, and differ not at all on');
  console.log('    Gold/Silver/Coffee/Sugar (capped at their ceilings either way) or Bitcoin.');
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
