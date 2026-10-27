'use strict';
// trading/plus500/chartIdentity.js — THE VENUE'S INSTRUMENT ID, PARSED FROM THE CHART. Pure.
//
// ⚠ WHY THIS IS ITS OWN MODULE. The rule was written inside `plus500/capture.js`, which was fine while the chart
// identity guard was its only reader. A SECOND reader appeared on 2026-10-27: `webtrader.placeOrder` now records the
// venue's own instrument id on the fill (`Trades.venueInstrumentId`, migration 055). It cannot require `capture.js`
// — capture requires `webtrader`, so that would be a cycle — and copying the regex would give one fact two producers,
// which is the defect this codebase spends most of its comments on. So the rule moved here, requires nothing, and
// `capture.js` re-exports it so its existing callers (`scripts/repro/chart-identity-check.js`,
// `scripts/backfill-chart-identity-registry.js`) do not change.
//
// WHAT THE FIELD ACTUALLY IS. `engine.chart.symbol` is `<venueInstrumentId>_<side>` — Gold is `11_Sell`, Bitcoin
// `3406_Sell`, Sands China `3989_Sell`. It is NOT the desk's name, and the first version of the identity guard
// compared it to a desk symbol and reported `of:12, match:0, mismatch:12` on a capture that was working perfectly.
// It is also the ONLY key that can name an OPTION contract: `Instruments.symbol` holds the underlying, while the desk
// stores the venue's composite name ("Oil | Call 94 | Sep W2"), and nothing else joins the two.

// `11_Sell` -> `11`. Returns null when the venue gives us nothing to parse — and null is NOT a pass.
function chartInstrumentId(chartSymbol) {
  const m = String(chartSymbol == null ? '' : chartSymbol).match(/^\s*(\d+)/);
  return m ? m[1] : null;
}

// Case, spacing and punctuation are not identity, so they are normalised away. `registrySymbol` comes from the
// desk's own registry, so this compares desk-name to desk-name — a mismatch is a real signal, not a naming gap.
const normSymbol = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

// 'match' | 'mismatch' | 'unregistered' | 'unrecorded'. ABSENCE IS NEVER `match`: a chart that does not say
// which instrument it is has told us nothing, and treating silence as agreement is how a guard goes inert.
function chartIdentityVerdict(chartSymbol, deskSymbol, registrySymbol) {
  if (!chartInstrumentId(chartSymbol)) return 'unrecorded';
  const r = normSymbol(registrySymbol);
  if (!r) return 'unregistered';
  return r === normSymbol(deskSymbol) ? 'match' : 'mismatch';
}

module.exports = { chartInstrumentId, chartIdentityVerdict, normSymbol };
