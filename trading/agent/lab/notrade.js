// trading/agent/lab/notrade.js — TRD-23 no-trade convention (§Governance).
// TRD-23 (regime-flat / stand-down) has NO PF (division by zero); it is scored
// on a W1 in-sample diagnostic against the classic strategies' realized
// outcomes:
//   net counterfactual = losses avoided on stand-down trades
//                        - gains forgone on stand-down trades
//   PASS requires net > 0 AND stand-down coverage <= 40% of W1 BARS.
// The coverage cap exists to kill the "stand down everywhere" trivially-good
// answer. TRD-23 is a filter, not a strategy: it cannot promote by itself —
// it gates other candidates (stand down in the identified regimes).
// W1 result (2026-09-10, 3,297 classic trades): stand-down-in-range net
// +48,768 at 50.6% coverage; stand-down-in-trend net +42,429 at 49.4% —
// BOTH FAIL the 40% coverage cap (the harness ADX split is ~50/50, not the
// desk-meta 77/23). Verdict recorded: no stand-down regime is promoted.
'use strict';

const COVERAGE_CAP_PCT = 40;

// trades: [{ pnl }] in the stand-down set. coveragePct: share of W1 bars the
// rule would stand down (percent). Returns the convention's verdict.
function counterfactual(trades, coveragePct) {
  const rows = trades || [];
  let lossesAvoided = 0;
  let gainsForgone = 0;
  for (const t of rows) {
    const pnl = Number(t.pnl);
    if (!Number.isFinite(pnl)) continue;
    if (pnl < 0) lossesAvoided += -pnl;
    else if (pnl > 0) gainsForgone += pnl;
  }
  const net = lossesAvoided - gainsForgone;
  const coverage = Number(coveragePct);
  const coverageOk = Number.isFinite(coverage) && coverage <= COVERAGE_CAP_PCT;
  return {
    standDownTrades: rows.length,
    lossesAvoided, gainsForgone, net,
    coveragePct: coverage,
    coverageCapPct: COVERAGE_CAP_PCT,
    pass: net > 0 && coverageOk,
    verdict: net > 0 && coverageOk ? 'PASS' : net > 0 ? 'FAIL (coverage > 40%)' : 'FAIL (net <= 0)',
  };
}

module.exports = { COVERAGE_CAP_PCT, counterfactual };
