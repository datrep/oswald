// trading/agent/closeFill.js — TRD-108: what a close actually HAPPENED at, as opposed to what the closer
// reported.
//
// THE DEFECT THIS REMOVES. `Trades.closePrice` means two different facts depending on who closed the trade:
//   * the EXECUTOR closed it  -> closePrice IS the fill the desk got.
//   * the VENUE closed it     -> closePrice is the venue's stated RATE, which is the LEVEL it closed at —
//     the stop on a loss, the take-profit on a win — and it equals that level on most rows:
//       #1064 closePrice 4395.92 vs stopPrice 4395.9244
//       #1036 closePrice 102.48  vs stopPrice 102.4798
//       #1043 closePrice 4276.30 vs takeProfitPrice 4276.3087
//     Meanwhile the MONEY says the fill was beyond it: impliedFill is 0.002 past the take-profit on #1047
//     but 0.235 / 0.568 / 5.46 / 7.76 past the stop on #1036 / #1063 / #1064 / #1052. In R the losses land
//     at 1.22-1.38 — a stop-out that lost 22-38% more than its own stop — which is what market-order
//     slippage on a stop looks like, and why the take-profit that reconciles exactly stays silent.
//
// ★★★ THAT LAST PARAGRAPH WAS WRONG, AND IT WAS WRONG BY EXACTLY ONE CURRENCY RATE. Found 2026-09-30.
// "In R the losses land at 1.22-1.38" is not slippage: **1.22-1.38 IS USD/SGD**, the rate the desk later
// measured as 1.2812 the hard way in TRD-RSK-14 (#1477). The arithmetic below divides a P&L denominated in the
// ACCOUNT's currency (SGD) by a size quoted in the INSTRUMENT's (USD), so the derived exit is dragged
// `fx ×` further from the entry than the trade really went — in BOTH directions, which is why the winners
// looked better and no one noticed.
//
// MEASURED over all 60 venue closes, as (derived fill - open) / (venue rate - open):
//
//     Gold 1.2965 · Oil 1.2978 · Arabica Coffee 1.3262 · Silver 1.2804        <- USD-quoted
//     SGX  1.0482                                                            <- SGD-quoted: NO MISMATCH
//
// The population supplies its own control group: SGX is the one instrument whose P&L currency already matches
// the account's, and it is the one instrument that reads like a fill. Everything else reads like the rate.
// Cross-checked against the venue statement for #1148 (Silver sell 22.5 oz, 60.826 -> 61.205, S$-10.97):
// those three figures are mutually consistent ONLY at fx = 1.2865, and the fill this file derived (61.321556)
// is exactly what you get by spending that S$-10.97 as though it were USD. The venue's own close rate implies
// a fill of 61.205 — so on that row the rate WAS the fill, to within a hundredth of a percent.
//
// THE CONSEQUENCE, recorded rather than quietly fixed: TRD-EXE-10 (#1480) filed "every stop-out realises
// 1.22-1.59x the modelled stop distance (mean 1.36x)" the same day — that range IS this factor, and the
// honest residual after removing it is far smaller. TRD-108 (#1359), whose founding evidence is quoted above,
// rests on the same artifact. The CURRENCY half of the root cause is TRD-PNL-4 (#1484).
//
// So every metric derived from `closePrice` on a venue-closed row was measuring a LEVEL: realised move %,
// realised R, and `slippagePct`, whose entire purpose is comparing the exit against the market.
//
// THE FIX IS "STORE BOTH", which is what the row asked for: `closeFilterPrice`-style derivation lives here
// (the venue's own P&L is the authoritative number, so the fill comes back out of it), and
// `CLOSE_PRICE_SOURCE` names which fact `closePrice` is. A metric reads the FILL and needs no conditional.
//
// Pure: no store, no venue, no clock. Pinned by test against the row's own worked examples.
'use strict';

// Which fact a row's `closePrice` is. Written whenever `closePrice` is.
const CLOSE_PRICE_SOURCE = {
  venueRate: 'venue_rate', // the venue's stated close RATE — the LEVEL it closed at, not the fill
  fill: 'fill',            // the desk closed it, so its own price IS the fill
};

// THE FILL, DERIVED FROM THE MONEY.
//
// fill = open + dir * pnl / size, using the venue's own NetPL. Verified on #1047 (Oil sell, open 97.08,
// size 12.22, net +28.86): 97.08 - 28.86/12.22 = 94.7183, against a take-profit of 94.7162 — i.e. the money
// lands ON the level for a limit-order exit, which is why a table of these IS a slippage measurement for
// the stop-outs and a no-op for the take-profits.
//
// NULL when it cannot be derived — a missing or non-positive size, a non-numeric P&L, an unknown direction —
// and deliberately not zero and not the level: an invented fill would be the same defect one column over.
// ⚠ THE GUARD THAT MATTERS, and the reason this module carries its own copy of it: `Number(null) === 0` and
// `Number('') === 0`, so a bare numeric coercion accepts a MISSING P&L as a zero one — and a zero P&L returns
// the OPEN PRICE as the fill, i.e. it invents a perfectly-filled trade on a row whose P&L is unknown. This
// desk has hit that trap four times (expectancy.num, exitLevels, stopPolicy, venueComparability each carry
// the guard for the same reason), so absent values are rejected BEFORE any coercion.
function num(v) { return v == null || v === '' ? NaN : Number(v); }

// BOTH CURRENCIES MUST BE STATED, AND EQUAL — OR BOTH STATED AND DIFFERENT WITH A USABLE RATE. A caller that
// cannot name the instrument's currency derives NOTHING; a caller that CAN name both and supplies the recorded
// rate derives the converted fill (see below). Written as a helper and not an inline ternary so the rule is one
// thing, in one place.
const sameCurrency = (a, b) => {
  const x = typeof a === 'string' ? a.trim().toUpperCase() : null;
  const y = typeof b === 'string' ? b.trim().toUpperCase() : null;
  return !!x && !!y && x === y;
};

// ★★★ TRD-PNL-6 RESIDUAL (#1499, 2026-10-02) — THE CONVERSION THE REFUSAL ALWAYS NAMED, USING THE RATE THE
// DESK NOW STORES. The refusal was right about the arithmetic and wrong about ONE premise: it said a conversion
// "would also need the fx rate at the instant of the close, which the desk does not store". Since TRD-PNL-7 /
// P1a+P1b (2026-10-01) every account sample carries `fxSgd`, so the rate at any close IS a lookup.
//
//   `fx` is PNL-currency units per 1 QUOTE-currency unit (SGD-per-USD ≈ 1.2865 on this desk). When both
//   currencies are STATED AND DIFFERENT and `fx` is usable, the P&L is converted into the instrument's
//   currency first (`pnlQuote = pnl / fx`), and the fill is derived from THAT.
//
// VALIDATION, the venue statement's own worked row (#1148, Silver sell 22.5 oz, open 60.826 → close rate
// 61.205, S$-10.97, fx 1.2865): this function now returns 61.204978 — the rate WAS the fill, to a hundredth of
// a percent. The un-converted number lives on in the tests as evidence: 61.321556, "the SGD figure spent as
// USD", which is what the refusal exists to stop.
//
// STILL REFUSED (null): an undeclared currency on either side, a mismatch with no usable rate, and every
// underivable input — a fill with a rate the desk RECORDED is a measurement; an invented one is the defect.
function impliedFillPrice({ openPrice, direction, grossPnl, size, pnlCurrency = null, quoteCurrency = null, fx = null } = {}) {
  const open = num(openPrice);
  const pnl = num(grossPnl);
  const sz = num(size);
  const dir = direction === 'buy' ? 1 : direction === 'sell' ? -1 : 0;
  if (!dir || !(open > 0) || !(sz > 0) || !Number.isFinite(pnl)) return null;
  let pnlQuote = pnl;
  if (!sameCurrency(pnlCurrency, quoteCurrency)) {
    const stated = (v) => typeof v === 'string' && v.trim() !== '';
    if (!stated(pnlCurrency) || !stated(quoteCurrency)) return null; // "cannot name it" is not "defaults to 1"
    const rate = num(fx);
    if (!Number.isFinite(rate) || !(rate > 0)) return null; // a rate-less mismatch: the original refusal, kept
    pnlQuote = pnl / rate;
  }
  return +((open + (dir * pnlQuote) / sz)).toFixed(6);
}

module.exports = { impliedFillPrice, CLOSE_PRICE_SOURCE, sameCurrency };
