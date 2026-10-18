// trading/agent/fxRate.js — TRD-PNL-7 / P1a: the USD->SGD rate, DERIVED from the venue's own numbers.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A CONSTANT. The desk's controls compare a notional in the INSTRUMENT's
// currency against an equity in the ACCOUNT's, and there is no conversion anywhere in the codebase (checked
// 2026-10-01: every occurrence of `1.2812` is prose). That unit error is why a `35%` position cap has been
// binding at `35% x fx` — measured, not inferred: cap 40 -> 51.25% against fills at 50.0-50.9%, and cap 35 ->
// 44.84% against fills at 44.0-44.3%.
//
// ⚠ THE RATE IS DYNAMIC (owner, 2026-10-01), so it must be read at the moment of the comparison. The two samples
// on record — `1.2812` (the 09-30 record) and `1.2774` (a live Gold ticket on 10-01) — are 0.30% apart and BOTH
// are correct. A hardcoded rate would therefore be wrong by whatever the drift happens to be, which is exactly
// the "assume a currency" mistake `accountCurrency.js` exists to prevent.
//
// HOW IT IS DERIVED, AND WHY PAIRS RATHER THAN SINGLE SAMPLES.
// `position_pnl` rows already carry everything needed:
//     { size, direction, pnl, currentRate, openingRate }   <- pnl in the ACCOUNT's currency, rates in the INSTRUMENT's
// so a single sample implies `pnl / (size x dir x (currentRate - openingRate))`. That ratio is CONTAMINATED:
// `pnl` is the venue's NetPL and carries spread and commission, which are roughly CONSTANT while a position is
// open. Differencing two samples of the SAME position cancels that constant, leaving only the price move:
//     fx = (pnlB - pnlA) / (size x dirSign x (rateB - rateA))
//
// MEASURED 2026-10-01 over the recorded history (44 positions, first-vs-last sample):
//     |usd move| >= $0.50   n=41   range 0.9524-1.9542   avg 1.2953
//     |usd move| >= $1.00   n=37   range 1.2600-1.4058   avg 1.2877
//     |usd move| >= $3.00   n=25   range 1.2600-1.3107   avg 1.2788
//     |usd move| >= $10.0   n= 9   range 1.2687-1.2880   avg 1.2758   <- vs the venue's own printed 1.2774
// So the estimator converges on the venue's own figure, and THAT is what sets the gate below: `pnl` and the
// rates are rounded to 2 decimals, so the ratio is only meaningful once the move in VALUE terms is many times
// the rounding quantum. A small move does not merely add noise, it adds BIAS — which is why there is a gate
// rather than a weighted average.
//
// ⚠ THE OUTLIERS ARE STRUCTURAL, NOT RANDOM. Every value outside 1.26-1.31 in the >= $0.50 set had a tiny
// denominator (Gold at a 1.92 move, Oil at 0.12). A median is used rather than a mean for the same reason:
// one thin position must not move the answer.
//
// PURE: rows in, value out. No store, no clock, no network. The caller already has the rows in hand.
'use strict';

// The signal-to-rounding gate, in the INSTRUMENT's currency. $10 keeps the spread under 1%; $3 is the fallback
// when too few positions clear the first gate. Below $3 the derived value is reported but NOT trusted.
const GATE_STRONG = 10;
const GATE_WEAK = 3;

// A sanity band, NOT a policy. USD/SGD has traded roughly 1.2-1.45 for years; the band is deliberately wider
// than that so a real regime move is REPORTED rather than clipped, and anything outside it is a refusal
// carrying the observed value — the same shape as `accountCurrency.convertible()`, which refuses rather than
// guesses. Clamping here would turn a wrong derivation into a plausible number, which is the whole defect.
const PLAUSIBLE_MIN = 1.10;
const PLAUSIBLE_MAX = 1.55;

// Enough independent positions that one bad row cannot be the answer.
const MIN_SAMPLES = 3;

function dirSign(direction) {
  const d = typeof direction === 'string' ? direction.trim().toLowerCase() : '';
  if (d === 'buy' || d === 'long') return 1;
  if (d === 'sell' || d === 'short') return -1;
  return null; // an unread direction is not a guess
}

function finite(v) {
  // ⚠ The `Number(null) === 0` trap: an unread field must be null, never zero. Same guard as
  // `pnlRangeObserve` and `positionPnlPlan`.
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// One position's two samples -> one implied rate. `a` is the earlier, `b` the later; order matters only to the
// sign of the delta, and the sign cancels because both the P&L and the price move it against. Null when the
// pair cannot speak: a missing field, a flat price, or a direction nobody recorded.
function pairRate(a, b) {
  if (!a || !b) return null;
  const size = finite(a.size);
  const sign = dirSign(a.direction);
  const pnlA = finite(a.pnl);
  const pnlB = finite(b.pnl);
  const rateA = finite(a.rate);
  const rateB = finite(b.rate);
  if (size == null || size <= 0 || sign == null) return null;
  if (pnlA == null || pnlB == null || rateA == null || rateB == null) return null;
  const usdMove = size * sign * (rateB - rateA);
  if (!(Math.abs(usdMove) > 0)) return null; // a flat price implies nothing and must not divide
  const rate = (pnlB - pnlA) / usdMove;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return { rate, usdMove, symbol: a.symbol || null };
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// `pairs` = array of {a, b} sample pairs, one per position, from `pairRate`-shaped inputs.
// Returns a rate or a NAMED refusal. Never throws, never clamps.
function deriveRate(pairs) {
  const all = [];
  const rejected = [];
  for (const p of pairs || []) {
    const r = pairRate(p && p.a, p && p.b);
    if (!r) { rejected.push({ symbol: (p && p.a && p.a.symbol) || null, why: 'pair_unusable' }); continue; }
    all.push(r);
  }
  if (!all.length) return { ok: false, reason: 'no_usable_pairs', n: 0 };

  let gate = GATE_STRONG;
  let usable = all.filter((r) => Math.abs(r.usdMove) >= gate);
  let gateUsed = 'strong';
  if (usable.length < MIN_SAMPLES) {
    gate = GATE_WEAK;
    usable = all.filter((r) => Math.abs(r.usdMove) >= gate);
    gateUsed = 'weak';
  }
  if (usable.length < MIN_SAMPLES) {
    // Refuse rather than fall back to an ungated average: an ungated set is the biased one, and a biased rate
    // silently resizes every ticket. The caller must handle this, not the module.
    return { ok: false, reason: 'insufficient_signal', n: usable.length, candidates: all.length,
      gate: gateUsed, need: MIN_SAMPLES };
  }

  const rates = usable.map((r) => r.rate);
  const rate = median(rates);
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const out = {
    ok: true, rate, n: usable.length, candidates: all.length, gate: gateUsed,
    usdMoveMin: Math.min(...usable.map((r) => Math.abs(r.usdMove))),
    lo, hi, spreadPct: +(((hi - lo) / rate) * 100).toFixed(2),
    rejected: rejected.length,
  };
  if (!(rate >= PLAUSIBLE_MIN && rate <= PLAUSIBLE_MAX)) {
    // REPORTED, not clipped. The observed value travels with the refusal so the operator can see what the
    // desk thinks the rate is, instead of a plausible number standing in for a wrong one.
    return { ...out, ok: false, reason: 'outside_plausible_band', band: [PLAUSIBLE_MIN, PLAUSIBLE_MAX] };
  }
  return out;
}

module.exports = {
  pairRate, deriveRate, dirSign,
  GATE_STRONG, GATE_WEAK, PLAUSIBLE_MIN, PLAUSIBLE_MAX, MIN_SAMPLES,
};
