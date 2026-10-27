'use strict';
// trading/agent/spreadBasisDrift.js — DOES THE CURATED COST TABLE STILL MATCH THE VENUE?
//
// WHY THIS EXISTS. `CALIBRATED_SPREAD_HALF_PCT` (`backtest.js:93`) is what `costCfgFor` charges, what
// `stopPolicy.adverseStopCap` floors on, and what `costFactLines` now quotes to the chairs. NOTHING re-checked it.
// Measured 2026-10-27 against the desk's own `Trades.spreadSubmitPct` medians: four symbols reproduce to four
// decimal places (Bitcoin 1.00x, Ethereum 1.00x, SGX 1.00x, Arabica Coffee 1.00x) and Gold and Oil sit within 9% —
// but **Silver 1.27x and Sugar 0.88x**. Two entries had drifted while everything downstream kept quoting them.
//
// ⚠⚠ THE UNIT TRAP IS THE POINT, AND IT HAS ALREADY BITTEN ONCE. `cfdSpreadPct` is a HALF-spread per side;
// `spreadSubmitPct` is a ROUND TRIP. `agent/spreadDerivation.js:18-21` records the first TRD-79 measurement using the
// full spread and concluding "the curated table is twice the derived value" — an artefact of the divisor, not a
// finding. The comparison is therefore `curated x 2` against the measured round trip, computed in ONE place, here.
//
// ⚠ AND A SMALL SAMPLE IS NOT SILENCE. Below `minSample` the answer is `insufficient_sample`, which is a VERDICT —
// not a pass. Three fills cannot show a 27% drift, and reporting them as agreement is the failure this repo keeps
// paying for: an absent measurement read as a clean result.
//
// PURE: no SQL, no clock, no I/O. `scripts/spread-basis-drift.js` supplies the rows and does the printing.

const MIN_SAMPLE = 5;
// Wide enough that sampling noise on a handful of fills does not fire, narrow enough that Silver's 27% is caught.
// Stated as a number rather than chosen after seeing the answer.
const TOLERANCE_PCT = 20;

const round = (n, dp) => { const f = 10 ** dp; return Math.round(n * f) / f; };

function driftVerdict({
  symbol = null,
  curatedHalfPct = null,
  measuredRoundTripPct = null,
  n = 0,
  minSample = MIN_SAMPLE,
  tolerancePct = TOLERANCE_PCT,
} = {}) {
  const count = Number(n) || 0;
  if (!(count >= minSample)) return { symbol, n: count, minSample, verdict: 'insufficient_sample' };
  const measured = Number(measuredRoundTripPct);
  if (!Number.isFinite(measured) || measured <= 0) return { symbol, n: count, verdict: 'no_measurement' };
  const curated = Number(curatedHalfPct);
  if (!Number.isFinite(curated) || curated <= 0) return { symbol, n: count, verdict: 'no_curated_value' };

  const curatedRoundTripPct = round(curated * 2, 6);
  const ratio = round(measured / curatedRoundTripPct, 3);
  const driftPct = round((ratio - 1) * 100, 1);
  return {
    symbol,
    n: count,
    curatedHalfPct: curated,
    curatedRoundTripPct,
    measuredRoundTripPct: round(measured, 6),
    ratio,
    driftPct,
    tolerancePct,
    verdict: Math.abs(driftPct) > tolerancePct ? 'drift' : 'agrees',
  };
}

// Does any result require action? Kept separate so a caller cannot decide it by reading a log line.
function actionable(results = []) {
  return (Array.isArray(results) ? results : []).filter((r) => r && r.verdict === 'drift');
}

module.exports = { driftVerdict, actionable, MIN_SAMPLE, TOLERANCE_PCT };
