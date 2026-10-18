// trading/scripts/repro/chair-override-value.js — the chair override, measured.
//
// THE QUESTION THIS ANSWERS. `aggregator.decide` blends the deterministic panel and
// the chairs: `total = 0.5 * quantScore + 0.5 * chairScore`, approved when `total > 0`.
// A panel at +1 therefore contributes +0.5, which means THREE dissenting chairs score
// -0.5 and the trade still passes. **A chair majority cannot veto.** The decision row
// then reads `chairVote: "no"` next to `action: "entry"` — which is not a display bug,
// it is the blend working as written, and it is the only row where you can see it.
//
// WHY IT MATTERS TO BYP-2 / BYP-3. Those tasks were queued to REMOVE the chair check
// (a strong-setup bypass). TRD-BYP-1 found the veto informative — proposals it blocked
// counterfactually averaged -1.33R. This script measures the mirror image:
// **what happened when the chairs said no and the desk traded anyway.**
//
// AND IT NEEDS NO COUNTERFACTUAL, which is what makes it stronger evidence than BYP-1:
// those trades actually happened, so the ledger holds their real P&L. The
// counterfactual is computed too, only so the two populations are comparable on the
// same footing.
//
//   node trading/scripts/repro/chair-override-value.js
'use strict';

const path = require('path');
const fs = require('fs');
const repo = path.join(__dirname, '..', '..', '..');
require('dotenv').config({ path: path.join(repo, '.env') });

const store = require('../../store');
const { excursionOf, rOf, riskPctOf, sliceHorizon } = require('../../agent/shadowScore');
const { bootstrapMean } = require('../../agent/shadowGate');

const HORIZON_BARS = 24;
const USER_ID = 1;
const VENUES = ['plus500', 'yahoo', 'binance', 'okx', 'plus500_chart'];

const q = (n, dp = 4) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ci = (xs) => (xs.length >= 2 ? (() => {
  const b = bootstrapMean(xs, { trials: 5000 });
  // `b.p` is (resamples <= 0 + 1) / (trials + 1) — the probability the mean is AT OR
  // BELOW ZERO. An earlier version of this script printed it as "P(mean > 0)", which
  // is the opposite of what the number means. Read it as evidence FOR a negative mean.
  return { lower: q(b.lower), upper: q(b.upper), pMeanAtOrBelowZero: q(b.p, 4) };
})() : null);

// Every decision row that went to the chairs, so `chairVote` is meaningful (a row
// with an empty chairVotes list was never deliberated — it has no vote to override).
function collectProposals(prompts) {
  const out = [];
  for (const p of prompts) {
    for (const d of ((p.decision || {}).decisions || [])) {
      const cv = d.votes && d.votes.chairVotes;
      if (!Array.isArray(cv) || !cv.length) continue;
      out.push({
        promptId: p.id,
        at: p.createdAt,
        symbol: d.symbol || null,
        direction: d.direction || null,
        action: d.action || null,
        chairVote: d.chairVote || null,
        chairScore: d.votes ? d.votes.chairScore : null,
        quantScore: d.votes ? d.votes.quantScore : null,
        seats: cv.map((v) => ({ persona: v.persona || null, vote: v.vote, reason: v.reason || null })),
        stopDistance: d.stopDistance == null ? null : Number(d.stopDistance),
        atrFromCalc: d.sizeCalc && d.sizeCalc.atr != null ? Number(d.sizeCalc.atr) : null,
        reason: d.reason || null,
      });
    }
  }
  return out;
}

// Same forward counterfactual the BYP-1 script uses, so the two populations are
// measured with one method rather than two.
async function counterfactual(prop, barCache) {
  if (!prop.symbol) return { skipped: 'no_symbol' };
  if (prop.direction !== 'buy' && prop.direction !== 'sell') return { skipped: 'no_direction' };
  if (!barCache.has(prop.symbol)) {
    let bars = [];
    for (const venue of VENUES) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await store.listBars(USER_ID, { timeframe: '1h', symbol: prop.symbol, venue, limit: 400 }).catch(() => []);
      if (rows && rows.length) { bars = rows; break; }
    }
    barCache.set(prop.symbol, bars);
  }
  const bars = barCache.get(prop.symbol) || [];
  if (bars.length < 30) return { skipped: 'no_bars' };
  const t = new Date(prop.at).getTime();
  const atOrBefore = bars.filter((b) => new Date(b.barStart).getTime() <= t);
  const ref = atOrBefore[atOrBefore.length - 1];
  if (!ref) return { skipped: 'no_bar_at_call' };
  const price = Number(ref.closePrice);
  if (!(price > 0)) return { skipped: 'no_price' };
  const rows = sliceHorizon(bars, prop.at, HORIZON_BARS);
  if (rows.length < HORIZON_BARS) return { skipped: 'horizon_incomplete' };
  const atr = prop.atrFromCalc != null && prop.atrFromCalc > 0 ? prop.atrFromCalc : (() => {
    const idx = bars.indexOf(ref);
    const win = bars.slice(Math.max(0, idx - 14), idx + 1);
    if (win.length < 2) return null;
    const trs = [];
    for (let i = 1; i < win.length; i++) {
      const h = Number(win[i].high); const l = Number(win[i].low); const pc = Number(win[i - 1].closePrice);
      if ([h, l, pc].every(Number.isFinite)) trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return mean(trs);
  })();
  const riskPct = riskPctOf(atr, price);
  const withOpen = rows.map((b, i) => (i === 0 ? { ...b, open: price } : b));
  const ex = excursionOf(withOpen, prop.direction);
  if (!ex) return { skipped: 'no_excursion' };
  return { ok: true, r: rOf(ex.closePct, riskPct), closePct: q(ex.closePct), hitStop: riskPct != null ? (ex.maePct <= -riskPct) : null };
}

(async () => {
  const prompts = await store.listPrompts(USER_ID, { limit: 500 });
  const props = collectProposals(prompts);
  const trades = await store.listTrades(USER_ID, { limit: 500 });

  const tradeByPrompt = new Map();
  for (const t of trades) if (t.decisionId != null) tradeByPrompt.set(Number(t.decisionId), t);

  // The override population: the chairs said no AND the desk acted anyway.
  const overrideProps = props.filter((p) => p.chairVote === 'no' && (p.action === 'entry' || p.action === 'exit'));

  const barCache = new Map();
  const rows = [];
  for (const p of overrideProps) {
    const t = tradeByPrompt.get(Number(p.promptId)) || null;
    // eslint-disable-next-line no-await-in-loop
    const cf = await counterfactual(p, barCache);
    rows.push({
      promptId: p.promptId,
      at: p.at,
      symbol: p.symbol,
      direction: p.direction,
      chairScore: q(p.chairScore, 3),
      quantScore: q(p.quantScore, 3),
      dissent: p.seats.filter((s) => s.vote === 'no').length,
      seats: p.seats.length,
      dissentReasons: p.seats.filter((s) => s.vote === 'no' && s.reason).map((s) => s.persona + ': ' + s.reason.slice(0, 160)),
      tradeId: t ? t.id : null,
      realPnl: t && t.grossPnl != null ? Number(t.grossPnl) : null,
      tradeStatus: t ? t.status : null,
      tradeNote: t ? t.note || null : null,
      cf,
    });
  }

  const filled = rows.filter((r) => r.realPnl != null);
  const pnls = filled.map((r) => r.realPnl);
  // The outlier is named rather than silently included: one trade can decide a
  // total at this n, and hiding that would be the same error as quoting a mean
  // from a single observation.
  const worst = filled.slice().sort((a, b) => a.realPnl - b.realPnl)[0] || null;
  const withoutWorst = worst ? filled.filter((r) => r.tradeId !== worst.tradeId).map((r) => r.realPnl) : [];

  const cfRs = rows.filter((r) => r.cf && r.cf.ok && r.cf.r != null).map((r) => r.cf.r);
  const stoppedOut = rows.filter((r) => r.cf && r.cf.ok && r.cf.hitStop === true).length;
  const cfUsable = rows.filter((r) => r.cf && r.cf.ok).length;

  const report = {
    generatedAt: new Date().toISOString(),
    promptRows: prompts.length,
    deliberatedProposals: props.length,
    overrideProposals: rows.length,
    filledTrades: filled.length,
    realPnl: {
      total: q(pnls.reduce((a, b) => a + b, 0), 2),
      mean: q(mean(pnls), 2),
      median: q(median(pnls), 2),
      winPct: pnls.length ? q((pnls.filter((v) => v > 0).length / pnls.length) * 100, 1) : null,
      largestLoss: worst ? { tradeId: worst.tradeId, symbol: worst.symbol, pnl: q(worst.realPnl, 2) } : null,
      totalExcludingLargestLoss: q(withoutWorst.reduce((a, b) => a + b, 0), 2),
      meanExcludingLargestLoss: q(mean(withoutWorst), 2),
      nExcludingLargestLoss: withoutWorst.length,
      boot95: ci(pnls),
    },
    counterfactualForComparability: {
      usable: cfUsable,
      meanR: q(mean(cfRs)),
      medianR: q(median(cfRs)),
      winPct: cfRs.length ? q((cfRs.filter((v) => v > 0).length / cfRs.length) * 100, 1) : null,
      stoppedOutPct: cfUsable ? q((stoppedOut / cfUsable) * 100, 1) : null,
      boot95: ci(cfRs),
    },
    rows,
  };

  const outDir = path.join(repo, 'temp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'chair-override-value.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('=== the chair override: the chairs said NO and the desk acted anyway ===');
  console.log('');
  console.log(`deliberated proposals: ${props.length}`);
  console.log(`overridden proposals : ${rows.length}   (chairVote = no AND action in entry/exit)`);
  console.log('');
  console.log('  prompt  at(SGT)             symbol     dir   dissent  quant  chair   tradeId   realPnl  status');
  for (const r of rows) {
    const at = new Date(r.at).toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).slice(0, 16);
    console.log(`  ${String(r.promptId).padEnd(6)}  ${at.padEnd(19)}  ${String(r.symbol || '-').padEnd(9)}  ${String(r.direction || '-').padEnd(5)} `
      + `${String(r.dissent + '/' + r.seats).padEnd(7)}  ${String(r.quantScore).padEnd(5)} ${String(r.chairScore).padEnd(6)} `
      + `${String(r.tradeId || '-').padEnd(8)}  ${String(r.realPnl == null ? '-' : r.realPnl.toFixed(2)).padStart(7)}  ${r.tradeStatus || '-'}`);
  }
  console.log('');
  const rp = report.realPnl;
  console.log(`filled: ${filled.length} of ${rows.length}`);
  console.log(`REAL P&L: total ${rp.total}  mean ${rp.mean}  median ${rp.median}  win% ${rp.winPct}`);
  if (rp.largestLoss) {
    console.log(`  largest loss: trade ${rp.largestLoss.tradeId} (${rp.largestLoss.symbol}) ${rp.largestLoss.pnl}`);
    console.log(`  EXCLUDING it: total ${rp.totalExcludingLargestLoss} over n=${rp.nExcludingLargestLoss} (mean ${rp.meanExcludingLargestLoss})`);
  }
  if (rp.boot95) console.log(`  bootstrap 95% on the mean: [${rp.boot95.lower}, ${rp.boot95.upper}]  P(mean <= 0) = ${rp.boot95.pMeanAtOrBelowZero}`);
  console.log('');
  const cf = report.counterfactualForComparability;
  console.log(`for comparability, the same counterfactual BYP-1 used: usable ${cf.usable}  meanR ${cf.meanR}  medianR ${cf.medianR}  win% ${cf.winPct}  stoppedOut% ${cf.stoppedOutPct}`);
  console.log('');
  console.log('what the dissenting chairs actually said (the argument the blend overruled):');
  for (const r of rows.filter((x) => x.dissentReasons.length)) {
    console.log(`  prompt ${r.promptId} (${r.symbol}):`);
    for (const why of r.dissentReasons) console.log(`      ${why}`);
  }
  console.log('');
  console.log(`written: temp/chair-override-value.json`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e && (e.stack || e.message)); process.exit(1); });
