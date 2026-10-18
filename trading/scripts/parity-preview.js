// trading/scripts/parity-preview.js — what would the parity harness decide RIGHT NOW?
//
// Prints the decision the new rule (agent/expectancy.js) reaches for every live strategy, with
// the arithmetic, and writes NOTHING: no settings change, no retirement, no event, no alert.
// The point is to make the learning loop's reasoning inspectable before it is trusted to act —
// the old rule could not be previewed because it had no reasoning to show, only a threshold.
//
// Usage: node trading/scripts/parity-preview.js [--user 1] [--looks N]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const store = require('../store');
const { strategyStats } = require('../agent/analytics');
const { expectancyVerdict, requiredSample, driftFlag } = require('../agent/expectancy');

const argv = process.argv.slice(2);
const ui = argv.indexOf('--user');
const userId = ui >= 0 ? Number(argv[ui + 1]) || 1 : 1;
const li = argv.indexOf('--looks');
const looksArg = li >= 0 ? Number(argv[li + 1]) : null;

const r4 = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : x);
const r2 = (x) => (Number.isFinite(x) ? Number(x.toFixed(2)) : x);

(async () => {
  const settings = await store.getSettings(userId);
  const p = (settings.learning && settings.learning.parity) || {};
  const minTrades = Math.max(3, Number(p.minTrades) || 10);
  const alpha = Number(p.alpha) || 0.05;
  const lagPp = Number(p.winRateLagPp) || 20;
  const enabled = (settings.strategies && settings.strategies.enabled) || [];

  const priorLooks = await store.countEventsSince(userId, 'parity_check', 365 * 24 * 60).catch(() => 0);
  const looks = looksArg != null ? looksArg : Number(priorLooks || 0) + 1;

  const stats = await strategyStats(userId, { days: 90 });
  const runs = await store.listBacktestRuns(userId, { limit: 20 });

  console.log(`parity preview — user ${userId}, alpha ${alpha}, looks ${looks} (${priorLooks} prior parity check(s) logged)`);
  console.log(`minTrades ${minTrades}   enabled: ${enabled.length ? enabled.join(', ') : '(none)'}`);
  console.log('NOTHING IS WRITTEN. This is the decision the harness would reach.\n');

  const t = (s, w) => String(s).padEnd(w);
  console.log(`  ${t('strategy', 12)} ${t('enabled', 8)} ${t('trades', 7)} ${t('R n', 5)} ${t('no stop', 8)} ${t('mean R', 9)} ${t('sd R', 8)} ${t('state', 13)} ${t('boundary', 9)} ${t('for accept', 10)}`);
  let anyAccept = 0;
  let wouldRetire = [];
  for (const s of stats) {
    if (s.strategy === 'unknown') {
      console.log(`  ${t('(untagged)', 12)} ${t('-', 8)} ${t(s.trades, 7)} ${t('-', 5)} ${t('-', 8)} ${t('-', 9)} ${t('-', 8)} ${t('not retireable', 13)}`);
      continue;
    }
    const v = expectancyVerdict({ n: s.rTrades, meanR: s.meanR, sdR: s.sdR }, { alpha, looks, minTrades });
    // TRD-41: WHAT IT WOULD TAKE. The verdict today is `insufficient` for every strategy, which says
    // nothing about whether the evidence EVER arrives. This holds the observed mean/sd fixed and scans
    // n until the real verdict flips — so "is this 30 trades away or 3000" is answerable.
    const need = requiredSample({ meanR: s.meanR, sdR: s.sdR }, { alpha, looks, minTrades });
    const ref = runs.find((r) => r.strategy === s.strategy && r.metrics && r.metrics.cfd);
    const drift = driftFlag(s.winRate, ref ? { winRate: ref.metrics.cfd.winRate, trades: ref.metrics.cfd.trades } : null, { lagPp });
    const isEnabled = enabled.includes(s.strategy);
    if (v.state === 'accept' && isEnabled) anyAccept += 1;
    if (v.state === 'retire' && isEnabled) wouldRetire.push(s.strategy);
    console.log(`  ${t(s.strategy, 12)} ${t(isEnabled ? 'yes' : 'no', 8)} ${t(s.trades, 7)} ${t(s.rTrades, 5)} ${t(s.rExcluded, 8)} ${t(r4(s.meanR), 9)} ${t(r4(s.sdR), 8)} ${t(v.state, 13)} ${t(r4(v.boundary), 9)} ${t(need.acceptAt == null ? (need.unreachable ? 'never' : '?' + (need.verdictAt == null ? '>5000' : need.verdictAt)) : 'n=' + need.acceptAt, 10)}`);
    const bits = [];
    if (v.reason) bits.push(v.reason);
    if (Number.isFinite(v.lower)) bits.push(`95% CI on mean R [${r4(v.lower)}, ${r4(v.upper)}]`);
    if (drift.comparable) bits.push(`drift: live ${s.winRate}% vs backtest ${drift.refWinRate}% over ${drift.refTrades} trades${drift.lagging ? ' — LAGGING (flag only, does not retire)' : ''}`);
    else bits.push(`drift: not comparable — ${drift.reason}`);
    console.log(`               ${bits.join('\n               ')}`);
  }

  console.log(`\nwould retire: ${wouldRetire.length ? wouldRetire.join(', ') : 'none'}`);

  // TRD-41: THE TARGET MOVES AWAY AS YOU WAIT. Every logged parity check spends alpha, and a tighter
  // critical value needs MORE trades to clear the same observed edge. So the schedule is not neutral:
  // a weekly check on a desk that is still accruing data raises the bar faster than the data arrives,
  // and running the harness "just to look" permanently inflates its own requirement.
  const enabledStats = stats.filter((s) => enabled.includes(s.strategy) && Number.isFinite(s.meanR));
  if (enabledStats.length) {
    console.log('\n  the alpha-spending schedule (acceptance target at each look count):');
    for (const s of enabledStats) {
      const at = [looks, looks + 4, looks + 12, looks + 25, looks + 51]
        .map((L) => `L${L}: ${requiredSample({ meanR: s.meanR, sdR: s.sdR }, { alpha, looks: L, minTrades }).acceptAt == null ? (s.meanR <= 0 ? 'never' : '>5000') : 'n=' + requiredSample({ meanR: s.meanR, sdR: s.sdR }, { alpha, looks: L, minTrades }).acceptAt}`)
        .join('  ·  ');
      console.log(`    ${t(s.strategy, 12)} ${at}`);
    }
    console.log('    (L = parity checks logged in the last year. Every look SPENDS alpha, so a later verdict needs a bigger sample.)');
  }

  console.log(`parityValidated would become: ${anyAccept > 0}  (currently ${!!(settings.learning && settings.learning.parityValidated)}; drives runInFactor 1 vs 0.5)`);
  console.log(`  -> full size is justified only by a strategy whose LOWER bound on mean R is above zero.`);
  process.exit(0);
})().catch((e) => {
  console.error(`failed: ${String(e.stack || e.message || e)}`);
  process.exit(3);
});
