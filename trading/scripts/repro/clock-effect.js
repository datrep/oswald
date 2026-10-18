// trading/scripts/repro/clock-effect.js — TRD-49: how much does the venue funding clock actually move?
//
// TRD-49 changed every cost path from counting UTC MIDNIGHTS to counting crossings of the venue's
// published overnight-funding time (05:00 SGT = 21:00 UTC = minute 1260). That is a change to the
// numbers behind every stored backtest, so it needed a measurement rather than an assurance — and the
// first attempt at one was worthless: a single fixture showed "0 trades disagree", which is not
// evidence that the change is a no-op. The honest question is the RATE across many holds.
//
// Runs the strategies OFFLINE against the same bars, once with the venue clock and once with the
// legacy midnight count, and reports per-trade disagreements. No BacktestRuns are written, so this can
// scan many fixtures instead of betting the question on one lucky sample.
//
// RESULTS 2026-09-14 (1257 trades, 8 fixtures): on Gold — the ONLY symbol the registry has a row for —
// 52 of 378 trades (13.8%) get a different count across turtle/macd/meanrev over a year of 1h bars,
// net +6 nights and roughly S$200 of carry on a 10k account. Every other fixture reads unchanged
// because the registry holds no spot row for it, so it is not on the venue basis at all (TRD-50). The
// two counts differ by AT MOST ONE NIGHT per hold — a hold straddling one clock and not the other — so
// the correct claim is "each affected charge was off by up to one night", NOT "every charge was wrong".
//
// Usage (from the repo root):
//   node trading/scripts/repro/clock-effect.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const bt = require('../../agent/backtest');
const strategies = require('../../agent/strategies');
const instr = require('../../agent/instruments');

const USER = Number(process.env.TRADING_SCRIPT_USER) || 1;
// Provider data, because the desk's own captured 1h history is ~53 bars per symbol (collection started
// 2026-09-08), which is far too thin to span the funding instant often enough to say anything.
const CASES = [
  { symbol: 'Gold', venue: 'yahoo', strategy: 'turtle' },
  { symbol: 'Gold', venue: 'yahoo', strategy: 'macd' },
  { symbol: 'Gold', venue: 'yahoo', strategy: 'meanrev' },
  { symbol: 'Bitcoin', venue: 'binance', strategy: 'turtle' },
  { symbol: 'Bitcoin', venue: 'binance', strategy: 'rsi2' },
  { symbol: 'Oil', venue: 'yahoo', strategy: 'turtle' },
  { symbol: 'Oil', venue: 'yahoo', strategy: 'meanrev' },
  { symbol: 'Silver', venue: 'yahoo', strategy: 'mtftrend' },
];

(async () => {
  const seeded = await instr.seedBacktestCostBasis(USER).catch(() => ({ seeded: 0 }));
  console.log(`venue basis seeded for ${seeded.seeded} symbols from the registry`);
  const fmtTime = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');

  let allTrades = 0;
  let allDiff = 0;
  let allExtraNights = 0;
  let venued = 0;
  // Counted SEPARATELY from `allTrades`. A fixture whose symbol is not on the venue basis is identical
  // by construction — the clock was never supplied — so folding it into the headline rate dilutes the
  // measurement toward zero and would understate the change. The rate that means something is over the
  // trades the clock could actually reach.
  let basisTrades = 0;
  let basisDiff = 0;

  for (const cs of CASES) {
    const cfg = { ...bt.DEFAULTS, ...bt.costCfgFor(cs.symbol), strategy: cs.strategy, capital: 10000 };
    const strat = strategies.get(cs.strategy);
    if (!strat || !strat.backtest) { console.log(`${cs.symbol}/${cs.strategy}: no such strategy`); continue; }
    const loaded = await bt.loadSeries(USER, { symbol: cs.symbol, venue: cs.venue, timeframe: '1h', range: '1y', refreshData: true });
    if (loaded.error) { console.log(`${cs.symbol}/${cs.strategy} (${cs.venue}): ${loaded.error}`); continue; }

    const clock = cfg.cfdSwapClockMinuteUtc;
    const onVenueBasis = clock != null;
    if (onVenueBasis) venued += 1;
    const rate = bt.swapPctFor(cfg, 'buy');
    // The ONLY difference between the two runs is the clock, so any change in the trade STREAM is a bug
    // rather than a cost — asserted below, because "cost must never move the signal" is the invariant
    // that keeps a swap correction from silently becoming a strategy change.
    const legacy = strat.backtest(loaded.series, { ...cfg, cfdSwapClockMinuteUtc: null });
    const clocked = strat.backtest(loaded.series, { ...cfg, cfdSwapClockMinuteUtc: clock });

    let diff = 0;
    let extra = 0;
    let swapDelta = 0;
    const samples = [];
    for (let i = 0; i < legacy.trades.length; i++) {
      const l = legacy.trades[i];
      const k = clocked.trades[i];
      if (l.entryTime !== k.entryTime || l.exitTime !== k.exitTime) {
        console.log(`  !! ${cs.symbol}/${cs.strategy}: the clock changed the trade stream — that is a bug, not a cost`);
        break;
      }
      allTrades++;
      if (onVenueBasis) basisTrades++;
      if (l.nights !== k.nights) {
        diff++; allDiff++;
        const d = k.nights - l.nights;
        extra += d; allExtraNights += d;
        swapDelta += Math.abs(d) * (l.size * l.entryPrice) * (rate / 100);
        if (samples.length < 3) samples.push(`      ${fmtTime(l.entryTime)} -> ${fmtTime(l.exitTime)}  midnight ${l.nights} vs clock ${k.nights}`);
      }
    }
    console.log(`${cs.symbol.padEnd(9)} ${cs.strategy.padEnd(10)} bars=${String(loaded.series.length).padStart(5)} trades=${String(legacy.trades.length).padStart(4)} disagree=${String(diff).padStart(3)}  net extra nights=${extra >= 0 ? '+' : ''}${extra}  swap moved ~${swapDelta.toFixed(2)}`);
    for (const s of samples) console.log(s);
    console.log(`      (basis: ${(cfg.costModelBasis && cfg.costModelBasis.swapClock) || 'n/a'} @ ${clock} UTC-min, buy rate ${rate}%)`);
  }

  console.log('');
  console.log('=== summary ===');
  console.log(`trades measured                     : ${allTrades}`);
  console.log(`trades the clock could reach        : ${basisTrades} (${venued} of ${CASES.length} fixtures are on the venue basis)`);
  console.log(`trades the clock actually changes   : ${allDiff} of ${basisTrades} = ${basisTrades ? ((allDiff / basisTrades) * 100).toFixed(1) : '0'}% of the reachable trades (${allTrades ? ((allDiff / allTrades) * 100).toFixed(1) : '0'}% of all)`);
  console.log(`net nights added by the venue clock : ${allExtraNights >= 0 ? '+' : ''}${allExtraNights}`);
  console.log('A fixture reading 0 is NOT evidence the clock does not matter — it means the registry has no');
  console.log('row for that symbol, so nothing supplied a funding time (see TRD-50).');
  console.log('The two counts differ by AT MOST ONE night per hold, so the correct claim for this change is');
  console.log('"each affected charge was off by up to one night", not "every charge was wrong".');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message, e.stack); process.exit(1); });
