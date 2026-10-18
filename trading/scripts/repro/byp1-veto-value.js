// trading/scripts/repro/byp1-veto-value.js — TRD-BYP-1 (2026-09-14).
//
// TWO MEASUREMENTS, and the second is the one §2.0 is BLOCKED on.
//
// (a) THE DISTRIBUTION. `quantVotes.score` over every deliberated proposal, plus what
//     each candidate bypass threshold would have done to the population. The plan
//     (§2.4) requires the threshold to be DERIVED and the intended bypass rate
//     DECLARED IN ADVANCE, because EVIDENCE_THRESHOLDS.md already branded the desk's
//     20/10/50 as "chosen, not derived". This script prints the whole curve rather
//     than a single number precisely so the threshold cannot be picked to fit a story.
//
// (b) THE VETO'S VALUE — the hard half. A veto PREVENTS the trade, so the ledger
//     contains no outcome for it; you cannot measure a veto by looking at what
//     happened, because nothing happened. It has to be COUNTERFACTUAL: replay each
//     vetoed proposal as if it had been taken, on the bars that followed, with the
//     desk's own 2 x ATR risk unit. That is what this script does, reusing the pure
//     scorers from agent/shadowScore so the arithmetic is the same one the shadow
//     ledger uses.
//
// WHAT IT DOES NOT DO: it does not decide anything, it writes nothing except a JSON
// report, and it changes no setting. It is read-only against the desk.
//
//   node trading/scripts/repro/byp1-veto-value.js
'use strict';

const path = require('path');
const fs = require('fs');
const repo = path.join(__dirname, '..', '..', '..');
require('dotenv').config({ path: path.join(repo, '.env') });

const store = require('../../store');
const { excursionOf, rOf, riskPctOf, sliceHorizon } = require('../../agent/shadowScore');

const HORIZON_BARS = 24;                       // fixed, same as the shadow ledger
const USER_ID = 1;
const VENUES = ['plus500', 'yahoo', 'binance', 'okx', 'plus500_chart'];
const THRESHOLDS = [0.5, 0.6, 0.75, 0.9, 1.0];

const q = (n, dp = 4) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

// Every deliberated proposal across the prompt history. A "deliberated proposal" is
// a decision row that actually went to the chairs (chairVotes non-empty).
function collectProposals(prompts) {
  const out = [];
  for (const p of prompts) {
    const dec = p.decision || {};
    for (const d of (dec.decisions || [])) {
      const cv = d.votes && d.votes.chairVotes;
      if (!Array.isArray(cv) || !cv.length) continue;   // never deliberated
      out.push({
        promptId: p.id,
        at: p.createdAt,
        symbol: d.symbol || null,
        venue: d.venue || null,
        direction: d.direction || null,
        type: d.type || null,
        strategy: d.strategy || null,
        action: d.action || null,
        chairVote: d.chairVote || null,
        chairScore: d.votes ? d.votes.chairScore : null,
        quantScore: d.votes ? d.votes.quantScore : null,
        size: d.size == null ? null : Number(d.size),
        riskSize: d.riskSize == null ? null : Number(d.riskSize),
        stopDistance: d.stopDistance == null ? null : Number(d.stopDistance),
        atrFromCalc: d.sizeCalc && d.sizeCalc.atr != null ? Number(d.sizeCalc.atr) : null,
        reason: d.reason || null,
      });
    }
  }
  return out;
}

// Forward counterfactual for one proposal. Price is taken from the 1h bar at or
// before the decision (the same bar the desk could see), and the risk unit from the
// proposal's own sizeCalc when present, else the ATR of that bar.
async function counterfactual(prop, barCache) {
  if (!prop.symbol) return { skipped: 'no_symbol' };
  if (prop.direction !== 'buy' && prop.direction !== 'sell') return { skipped: 'no_direction' };
  const key = prop.symbol;
  if (!barCache.has(key)) {
    let bars = [];
    for (const venue of VENUES) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await store.listBars(USER_ID, { timeframe: '1h', symbol: prop.symbol, venue, limit: 400 }).catch(() => []);
      if (rows && rows.length) { bars = rows; break; }
    }
    barCache.set(key, bars);
  }
  const bars = barCache.get(key) || [];
  if (bars.length < 30) return { skipped: 'no_bars' };

  const t = new Date(prop.at).getTime();
  const atOrBefore = bars.filter((b) => new Date(b.barStart).getTime() <= t);
  const ref = atOrBefore[atOrBefore.length - 1];
  if (!ref) return { skipped: 'no_bar_at_call' };
  const price = Number(ref.closePrice);
  if (!(price > 0)) return { skipped: 'no_price' };

  const rows = sliceHorizon(bars, prop.at, HORIZON_BARS);
  if (rows.length < HORIZON_BARS) return { skipped: 'horizon_incomplete' };

  const atr = prop.atrFromCalc != null && prop.atrFromCalc > 0
    ? prop.atrFromCalc
    : (() => {
        // Fallback: mean true range of the 14 bars preceding the decision.
        const idx = bars.indexOf(ref);
        const win = bars.slice(Math.max(0, idx - 14), idx + 1);
        if (win.length < 2) return null;
        const trs = [];
        for (let i = 1; i < win.length; i++) {
          const h = Number(win[i].high), l = Number(win[i].low), pc = Number(win[i - 1].closePrice);
          if ([h, l, pc].every(Number.isFinite)) trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        }
        return mean(trs);
      })();
  const riskPct = riskPctOf(atr, price);
  // Re-base the excursion on the decision price rather than the first horizon bar's
  // open, so the counterfactual entry is the price the desk could actually see.
  const withOpen = rows.map((b, i) => (i === 0 ? { ...b, open: price } : b));
  const ex = excursionOf(withOpen, prop.direction);
  if (!ex) return { skipped: 'no_excursion' };
  return {
    ok: true,
    price, atr, riskPct,
    mfePct: q(ex.mfePct), maePct: q(ex.maePct),
    closePct: q(ex.closePct),
    r: rOf(ex.closePct, riskPct),
    hitStop: riskPct != null ? (ex.maePct <= -riskPct) : null,
  };
}

(async () => {
  const prompts = await store.listPrompts(USER_ID, { limit: 500 });
  const props = collectProposals(prompts);

  // ---------------------------------------------------------------- (a)
  const scored = props.filter((p) => p.quantScore != null);
  const scores = scored.map((p) => p.quantScore);
  const distribution = {
    n: scored.length,
    min: q(Math.min(...scores)), max: q(Math.max(...scores)),
    mean: q(mean(scores)), median: q(median(scores)), sd: q(sd(scores)),
    buckets: {},
  };
  for (const s of scores) {
    const b = (Math.floor(s * 10) / 10).toFixed(1);
    distribution.buckets[b] = (distribution.buckets[b] || 0) + 1;
  }

  const vetoed = scored.filter((p) => p.chairVote === 'no' || p.chairVote === 'abstain' && false);
  const table = THRESHOLDS.map((th) => {
    const bypassed = scored.filter((p) => p.quantScore >= th);
    const wouldHaveOverridden = bypassed.filter((p) => p.chairVote === 'no');
    return {
      threshold: th,
      bypassRatePct: scored.length ? q((bypassed.length / scored.length) * 100, 1) : null,
      bypassed: bypassed.length,
      chairsVetoedAmongThem: wouldHaveOverridden.length,
    };
  });

  // ---------------------------------------------------------------- (b)
  const barCache = new Map();
  const vetoRows = [];
  for (const p of props.filter((x) => x.chairVote === 'no')) {
    // eslint-disable-next-line no-await-in-loop
    const cf = await counterfactual(p, barCache);
    vetoRows.push({ ...p, cf });
  }
  const usableVetoes = vetoRows.filter((r) => r.cf && r.cf.ok);
  const vetoRs = usableVetoes.map((r) => r.cf.r).filter((v) => v != null);
  const stoppedOut = usableVetoes.filter((r) => r.cf.hitStop === true).length;

  const approvedRows = [];
  for (const p of props.filter((x) => x.chairVote === 'yes')) {
    // eslint-disable-next-line no-await-in-loop
    const cf = await counterfactual(p, barCache);
    approvedRows.push({ ...p, cf });
  }
  const usableApproved = approvedRows.filter((r) => r.cf && r.cf.ok);
  const approvedRs = usableApproved.map((r) => r.cf.r).filter((v) => v != null);

  // ★ WHY 55 OF 65 VETOES WERE UNUSABLE, broken out by reason. This is the part
  // that decides whether a larger sample is coming or must be built: a
  // `horizon_incomplete` skip becomes usable on its own as bars arrive, whereas a
  // `no_bars` skip is a hole in the venue data that will never fill itself.
  const skipCounts = {};
  for (const r of vetoRows) {
    const why = r.cf && r.cf.ok ? null : ((r.cf && r.cf.skipped) || 'unknown');
    if (why) skipCounts[why] = (skipCounts[why] || 0) + 1;
  }
  const SELF_HEALING = ['horizon_incomplete', 'no_bar_at_call'];
  const selfHealing = Object.entries(skipCounts)
    .filter(([k]) => SELF_HEALING.includes(k)).reduce((a, [, v]) => a + v, 0);

  // A CI on both populations, because n=10 and n=29 means are not point facts.
  // Bootstrap, not t: the pool is skewed and EVIDENCE_THRESHOLDS.md says so.
  const { bootstrapMean } = require('../../agent/shadowGate');
  const ci = (xs) => (xs.length ? (() => {
    const b = bootstrapMean(xs, { trials: 5000 });
    // `b.p` is (resamples <= 0 + 1) / (trials + 1) — the probability the mean is AT OR
    // BELOW ZERO. An earlier version printed it as "P(mean > 0)", the opposite of what
    // the number means. Read it as evidence FOR a negative mean.
    return { lower: q(b.lower), upper: q(b.upper), pMeanAtOrBelowZero: q(b.p, 4) };
  })() : null);

  const report = {
    generatedAt: new Date().toISOString(),
    horizonBars: HORIZON_BARS,
    promptRows: prompts.length,
    deliberatedProposals: props.length,
    distinctSymbols: [...new Set(props.map((p) => p.symbol).filter(Boolean))],

    A_quantScoreDistribution: distribution,

    A_thresholdTable: table,

    B_vetoCounterfactual: {
      vetoedProposals: vetoRows.length,
      usable: usableVetoes.length,
      skipped: vetoRows.length - usableVetoes.length,
      meanR: q(mean(vetoRs)), medianR: q(median(vetoRs)), sdR: q(sd(vetoRs)),
      winPct: vetoRs.length ? q((vetoRs.filter((v) => v > 0).length / vetoRs.length) * 100, 1) : null,
      stoppedOutPct: usableVetoes.length ? q((stoppedOut / usableVetoes.length) * 100, 1) : null,
      sumR: q(vetoRs.reduce((a, b) => a + b, 0)),
      skipReasons: skipCounts,
      skipsThatWillResolveOnTheirOwn: selfHealing,
      boot95: ci(vetoRs),
    },

    B_approvedCounterfactual: {
      usable: usableApproved.length,
      meanR: q(mean(approvedRs)), medianR: q(median(approvedRs)), sdR: q(sd(approvedRs)),
      winPct: approvedRs.length ? q((approvedRs.filter((v) => v > 0).length / approvedRs.length) * 100, 1) : null,
      boot95: ci(approvedRs),
    },
  };

  const outDir = path.join(repo, 'temp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'byp1-veto-value.json'), JSON.stringify({ report, vetoRows }, null, 2), 'utf8');

  console.log('=== TRD-BYP-1: the veto\'s value and the quantScore distribution ===');
  console.log('');
  console.log(`deliberated proposals: ${props.length}   over ${prompts.length} prompt rows`);
  console.log(`symbols: ${report.distinctSymbols.join(', ')}`);
  console.log('');
  console.log('--- (a) quantScore distribution ---');
  console.log(`n=${distribution.n}  min=${distribution.min}  median=${distribution.median}  mean=${distribution.mean}  max=${distribution.max}  sd=${distribution.sd}`);
  console.log('buckets: ' + Object.entries(distribution.buckets).sort().map(([k, v]) => `${k}:${v}`).join('  '));
  console.log('');
  console.log('--- (a) what each bypass threshold would do (DECLARE the rate before you look at outcomes) ---');
  console.log('  thr   bypass%   bypassed   of which chairs VETOED');
  for (const t of table) {
    console.log(`  ${String(t.threshold).padEnd(5)} ${String(t.bypassRatePct).padStart(7)} ${String(t.bypassed).padStart(10)} ${String(t.chairsVetoedAmongThem).padStart(24)}`);
  }
  console.log('');
  console.log('--- (b) THE VETO COUNTERFACTUAL (what the rejected proposals would have done) ---');
  const vb = report.B_vetoCounterfactual;
  console.log(`vetoed=${vb.vetoedProposals}  usable=${vb.usable}  skipped=${vb.skipped}`);
  console.log(`meanR=${vb.meanR}  medianR=${vb.medianR}  sd=${vb.sdR}  sumR=${vb.sumR}  win%=${vb.winPct}  stoppedOut%=${vb.stoppedOutPct}`);
  if (vb.boot95) {
    console.log(`bootstrap 95% (one-sided each way): meanR in [${vb.boot95.lower}, ${vb.boot95.upper}]`
      + `   P(true mean <= 0) = ${vb.boot95.pMeanAtOrBelowZero}`);
  }
  console.log(`skipped, by reason: ${Object.entries(vb.skipReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`  of those, ${vb.skipsThatWillResolveOnTheirOwn} resolve ON THEIR OWN as bars arrive`
    + ` and ${vb.skipped - vb.skipsThatWillResolveOnTheirOwn} never will (a hole, not a wait)`);
  console.log('');
  console.log('--- (b) the same measure for the proposals the chairs APPROVED ---');
  const ab = report.B_approvedCounterfactual;
  console.log(`usable=${ab.usable}  meanR=${ab.meanR}  medianR=${ab.medianR}  sd=${ab.sdR}  win%=${ab.winPct}`);
  if (ab.boot95) {
    console.log(`bootstrap 95% (one-sided each way): meanR in [${ab.boot95.lower}, ${ab.boot95.upper}]`
      + `   P(true mean > 0) = ${ab.boot95.pMeanAboveZero}`);
  }
  console.log('');
  console.log('--- (b) the two populations compared ---');
  console.log(`  vetoed   ${String(vb.meanR).padStart(8)} R  (n=${vb.usable})`);
  console.log(`  approved ${String(ab.meanR).padStart(8)} R  (n=${ab.usable})`);
  const separable = vb.boot95 && ab.boot95 && vb.boot95.upper < ab.boot95.lower;
  console.log(`  the intervals ${separable ? 'DO' : 'DO NOT'} separate —`
    + ` ${separable ? 'the veto is distinguishable from the approvals' : 'so the gap is suggestive, not separated'}`);
  console.log('');
  console.log('Full detail -> temp/byp1-veto-value.json');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
