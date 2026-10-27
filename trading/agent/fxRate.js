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

// ★★ 2026-10-27 — THE BAND AND THE GATE ARE PER-CURRENCY, AND EXACTLY ONE IS DECLARED.
//
// This module derives SGD per ONE UNIT of the instrument's quote currency, so both constants are properties of the
// PAIR, not of the module. The originals were USD/SGD's and were applied to every pair: EUR/SGD (~1.5) sits at the
// top of 1.10-1.55, GBP/SGD and SGD/JPY fall outside it entirely, and "$10 of move" is a different amount of money
// in each. The owner's own case is the one that matters — a French or German stock quotes in EUR, so its rate is
// SGD-per-EUR and nothing about USD/SGD's band applies to it.
//
// ⚠⚠ AND THE DANGEROUS PART WAS NOT THE BAND. `deriveRate` took EVERY pair into one median without grouping, so a
// single EUR position among USD ones would have blended ~1.29 with ~1.50 into a number that still PASSED the band —
// a plausible wrong rate, which is the one outcome this module exists to prevent. Grouping is therefore checked
// before anything else.
//
// ⚠ IT FAILS CLOSED: a currency with no entry is REFUSED by name rather than handed USD's parameters, because
// assuming EUR/SGD trades like USD/SGD is the same "assume a currency" defect `accountCurrency.js` documents.
// Adding a currency here is a deliberate act with a stated band, not an inheritance.
const PAIR_PARAMS = {
  USD: { min: 1.10, max: 1.55, gateStrong: GATE_STRONG, gateWeak: GATE_WEAK },
};
const DEFAULT_CURRENCY = 'USD';

// A sanity band, NOT a policy. USD/SGD has traded roughly 1.2-1.45 for years; the band is deliberately wider
// than that so a real regime move is REPORTED rather than clipped, and anything outside it is a refusal
// carrying the observed value — the same shape as `accountCurrency.convertible()`, which refuses rather than
// guesses. Clamping here would turn a wrong derivation into a plausible number, which is the whole defect.
// ⚠ MOVED INTO `PAIR_PARAMS` (2026-10-27) as the `USD` entry. A single module-level band was a claim that every
// pair trades in USD/SGD's range, which is false for EUR, GBP and JPY — see the header there.
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
  const move = size * sign * (rateB - rateA);
  if (!(Math.abs(move) > 0)) return null; // a flat price implies nothing and must not divide
  const rate = (pnlB - pnlA) / move;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  // ⚠ `move` — NOT `usdMove`. The quantity is a price move in the INSTRUMENT'S quote currency, which is USD only
  // while every instrument happens to be USD-quoted. The old name was a unit claim the code could not keep.
  return { rate, move, symbol: a.symbol || null };
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// `pairs` = array of {a, b} sample pairs, one per position, from `pairRate`-shaped inputs.
// Returns a rate or a NAMED refusal. Never throws, never clamps.
//
// `currency` is the instrument currency the caller WANTS priced. It is optional because today no sample carries one
// (see accountPoller: `settings.account.instrumentCurrency` is unset), and refusing outright would switch the live
// rate off — but the outcome states which it was, so "we knew" and "we assumed" are never the same answer.
function deriveRate(pairs, { currency = null } = {}) {
  const all = [];
  const rejected = [];
  const recorded = new Set();
  for (const p of pairs || []) {
    const cur = p && p.a && p.a.currency ? String(p.a.currency).toUpperCase() : null;
    if (cur) recorded.add(cur);
    const r = pairRate(p && p.a, p && p.b);
    if (!r) { rejected.push({ symbol: (p && p.a && p.a.symbol) || null, why: 'pair_unusable' }); continue; }
    all.push({ ...r, currency: cur });
  }

  // ⚠⚠ BLENDING FIRST — THIS IS THE WHOLE POINT OF THE CURRENCY WORK. Two different quote currencies in one median
  // produces a number that is neither rate and can still pass a plausibility band. Refuse, and name them.
  const distinct = [...recorded].sort();
  if (distinct.length > 1) {
    return { ok: false, reason: 'mixed_currencies', currencies: distinct, n: all.length,
      note: 'positions quoting in different currencies cannot share one rate; derive per currency' };
  }
  if (currency && distinct.length === 1 && distinct[0] !== String(currency).toUpperCase()) {
    return { ok: false, reason: 'currency_mismatch', asked: String(currency).toUpperCase(), recorded: distinct[0] };
  }

  const effective = String(currency || distinct[0] || DEFAULT_CURRENCY).toUpperCase();
  const params = PAIR_PARAMS[effective];
  if (!params) {
    // ⚠ FAIL CLOSED. Handing a GBP pair USD's 1.10-1.55 band would REFUSE a correct rate as implausible, and
    // handing it a wider band would ACCEPT a wrong one. Neither is knowable from here, so neither is guessed.
    return { ok: false, reason: 'currency_parameters_missing', currency: effective, n: all.length,
      note: 'no plausibility band or value gate is declared for this currency — add one deliberately in PAIR_PARAMS rather than inheriting USD\'s' };
  }
  const basis = distinct.length ? 'recorded_currency' : (currency ? 'caller_supplied' : 'assumed_default');

  // A sample with no recorded currency cannot be shown to belong here, but excluding it would silently shrink the
  // population. Counted, so the ambiguity travels with the number instead of being resolved by a guess.
  const unrecorded = all.filter((r) => r.currency == null).length;

  if (!all.length) return { ok: false, reason: 'no_usable_pairs', n: 0, currency: effective, basis };

  let gate = params.gateStrong;
  let usable = all.filter((r) => Math.abs(r.move) >= gate);
  let gateUsed = 'strong';
  if (usable.length < MIN_SAMPLES) {
    gate = params.gateWeak;
    usable = all.filter((r) => Math.abs(r.move) >= gate);
    gateUsed = 'weak';
  }
  if (usable.length < MIN_SAMPLES) {
    // Refuse rather than fall back to an ungated average: an ungated set is the biased one, and a biased rate
    // silently resizes every ticket. The caller must handle this, not the module.
    return { ok: false, reason: 'insufficient_signal', n: usable.length, candidates: all.length,
      gate: gateUsed, need: MIN_SAMPLES, currency: effective, basis };
  }

  const rates = usable.map((r) => r.rate);
  const rate = median(rates);
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const out = {
    ok: true, rate, n: usable.length, candidates: all.length, gate: gateUsed,
    currency: effective, basis, unrecordedSamples: unrecorded,
    moveMin: Math.min(...usable.map((r) => Math.abs(r.move))),
    lo, hi, spreadPct: +(((hi - lo) / rate) * 100).toFixed(2),
    rejected: rejected.length,
  };
  if (!(rate >= params.min && rate <= params.max)) {
    // REPORTED, not clipped. The observed value travels with the refusal so the operator can see what the
    // desk thinks the rate is, instead of a plausible number standing in for a wrong one.
    return { ...out, ok: false, reason: 'outside_plausible_band', band: [params.min, params.max] };
  }
  return out;
}

module.exports = {
  pairRate, deriveRate, dirSign,
  GATE_STRONG, GATE_WEAK, MIN_SAMPLES, PAIR_PARAMS, DEFAULT_CURRENCY,
};
