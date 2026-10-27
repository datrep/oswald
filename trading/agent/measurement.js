'use strict';
// trading/agent/measurement.js — A NUMBER IS NOT A FACT UNTIL IT SAYS WHAT IT IS, OVER WHAT, AND FROM HOW MANY.
//
// ★★ WHY THIS EXISTS: THREE NUMBERS IN THIS REPO WERE COMPUTED CORRECTLY AND REPORTED AS SOMETHING ELSE.
//
//   1. `2026-09-21` — the first TRD-79 derivation used a FULL spread where the model wanted a HALF spread and
//      reported "the curated table is twice the derived value". Fixed by `spreadDerivation.guard 2`.
//   2. `2026-10-27` — the same class again: a ROUND TRIP (`2 x (spread + slip) x 100` = 11.94 bps for Gold) was
//      compared against a SPREAD-ONLY figure (1.77 bps). Every published ratio reproduced exactly as
//      `(curated + 0.05) / live`, i.e. the "6.76x error in the spread" WAS THE SLIPPAGE TERM. The repo already
//      held both the guard (`spreadDerivation.reproductionVerdict`) and, in `roundTripBpsFromCfg`'s own comment,
//      the decomposition `Gold 2 x (0.0097 + 0.05) x 100 = 11.94`. Neither was consulted, because a script can
//      always re-derive a comparison inline and nothing forces it to import the check.
//   3. `2026-10-27`, an hour later — a unit-clean comparison still failed: Gold's p75 half-spread over 14 days of
//      ticks is 0.0563 and the venue's own ticket label at submit is 0.0098. Both are `half_spread_pct_per_side`,
//      both are arithmetically correct, and they differ by **5.72x** because one population includes overnight
//      widening and the other is read when the desk trades.
//
// So there are TWO independent ways to be wrong, and a units-only guard catches one of them:
//
//   UNIT        — what the number measures (half vs round trip, percent vs bps, spread vs spread+slippage)
//   POPULATION  — which rows, chosen how (all-hours p75 vs at-submit ticket vs curated constant)
//
// A measurement is therefore a RECORD carrying `quantity`, `unit`, `population`, `n`, `window` and `value`, and
// `compare()` REFUSES unless unit AND population match. Conversion is allowed but EXPLICIT and marked, so a
// derived number cannot silently wear the provenance of the thing it was derived from.
//
// WHAT THIS IS NOT: a statistics library, a units-of-measure framework, or a validator of definitions. It cannot
// know that `0.0098` is the right Gold number. It can only refuse to subtract it from `0.0563` and call the
// result a discrepancy.
//
// PURE: no DB, no clock, no settings, no logging. Callers pass values; callers store claims.

// ── UNITS ────────────────────────────────────────────────────────────────────────────────────────────────────
// `family` groups units that measure the same physical thing, so a cross-family comparison is never a unit
// conversion — it is a category error and the message says so. `per` distinguishes the half from the round trip,
// which is the 2x that has now cost this repo twice. `scale` is percent -> bps.
const UNITS = {
  half_spread_pct: { family: 'spread', per: 'side', scale: 1, label: '% of mid, per side' },
  round_trip_spread_pct: { family: 'spread', per: 'roundTrip', scale: 1, label: '% of mid, round trip' },
  half_spread_bps: { family: 'spread', per: 'side', scale: 100, label: 'bps, per side' },
  round_trip_spread_bps: { family: 'spread', per: 'roundTrip', scale: 100, label: 'bps, round trip' },
  slippage_pct: { family: 'slippage', per: 'side', scale: 1, label: '% of price, per side' },
  slippage_bps: { family: 'slippage', per: 'side', scale: 100, label: 'bps, per side' },
  round_trip_cost_bps: { family: 'cost', per: 'roundTrip', scale: 100, label: 'bps, spread + slippage' },
};

// The bps sibling of each family, so `asBps` never has to cross one.
const BPS_OF = { spread: 'half_spread_bps', slippage: 'slippage_bps', cost: 'round_trip_cost_bps' };
const BPS_OF_ROUND_TRIP = { spread: 'round_trip_spread_bps', cost: 'round_trip_cost_bps' };

// ── POPULATIONS ──────────────────────────────────────────────────────────────────────────────────────────────
// WHICH ROWS, CHOSEN HOW. Two numbers in the same unit from different populations are NOT comparable, and that
// is not pedantry: it is the 5.72x Gold discrepancy in item 3 above.
const POPULATIONS = {
  curated_table: 'a hand-calibrated constant; n is the sample it was calibrated on',
  tick_all_hours: 'every two-sided tick in the window, including closed and overnight hours',
  tick_quote_source: 'two-sided ticks from a QUOTE source at the desk venue (spreadDerivation guard 1+3)',
  venue_open_market_capture: 'a quote read from the venue while it said the market was OPEN',
  venue_ticket_at_submit: "the venue's own Buy/Sell labels on a ticket, read inside placeOrder",
  decision_time_tick: 'the desk tick nearest a decision',
  fill_realised: 'a realised fill price against its reference price',
};

const VERDICT_BANDS = { reproduces: [0.7, 1.4] };

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (n, dp = 4) => (n == null ? null : Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp));

// ★ ARITHMETIC ON AN ABSENCE IS THE MOST PERMISSIVE ANSWER AVAILABLE. `Number(null) === 0` would turn "we could
// not measure it" into "the cost is zero", which is the coercion this repo has paid for four times. A claim may
// RECORD an absence (`value: null`) so it appears in a census, but it can never be compared or converted.
function claim({ quantity, unit, population, value, n = null, window = null, source = null, note = null } = {}) {
  if (!quantity || typeof quantity !== 'string') throw new Error('claim: `quantity` is required (what is being measured)');
  if (!UNITS[unit]) throw new Error(`claim: unknown unit "${unit}" — add it to UNITS with its family and side, or the comparison it enables is a guess`);
  if (!POPULATIONS[population]) throw new Error(`claim: unknown population "${population}" — add it to POPULATIONS so two numbers can be checked for comparability`);
  const absent = value == null;
  if (!absent && !isFiniteNum(value)) throw new Error(`claim(${quantity}): value must be a finite number or null, got ${JSON.stringify(value)}`);
  // A VALUE FROM ZERO SAMPLES IS NOT A MEASUREMENT. `p75([])` returning 0 is how a single-sided feed produced the
  // most permissive budget possible (spreadDerivation guard 1); this makes it unrepresentable rather than unlikely.
  if (!absent && n != null && !(n > 0)) throw new Error(`claim(${quantity}): value present with n=${n} — a number from no samples is not a measurement`);
  if (n != null && !(Number.isInteger(n) && n >= 0)) throw new Error(`claim(${quantity}): n must be a non-negative integer`);
  return Object.freeze({
    quantity, unit, population, value: absent ? null : value,
    n: n == null ? null : n,
    window: window || null,
    source: source || null,
    note: note || null,
    derivedFrom: null,
  });
}

// ── CONVERSION, ALWAYS EXPLICIT AND ALWAYS MARKED ───────────────────────────────────────────────────────────
// A converted claim keeps its population, n and window — provenance survives — and records `derivedFrom` so a
// later reader can see that the number in front of them is not the number that was measured.
function convert(c, toUnit) {
  if (!c || !UNITS[c.unit]) throw new Error('convert: not a claim');
  if (!UNITS[toUnit]) throw new Error(`convert: unknown unit "${toUnit}"`);
  if (c.value == null) throw new Error(`convert(${c.quantity}): the claim is an ABSENCE — there is nothing to convert, and substituting 0 would be the most permissive possible answer`);
  const from = UNITS[c.unit];
  const to = UNITS[toUnit];
  if (from.family !== to.family) {
    throw new Error(`convert(${c.quantity}): ${c.unit} is a ${from.family} quantity and ${toUnit} is a ${to.family} quantity — that is not a unit conversion`);
  }
  // percent <-> bps is a scale; side <-> roundTrip is a factor of two. Applied separately so the message says
  // WHICH one was applied, because "x2" is exactly the mistake that is indistinguishable in a column of decimals.
  let v = c.value;
  if (from.per !== to.per) {
    if (from.per === 'side' && to.per === 'roundTrip') v *= 2;
    else if (from.per === 'roundTrip' && to.per === 'side') v /= 2;
    else throw new Error(`convert(${c.quantity}): no ${from.per} -> ${to.per} rule`);
  }
  // `scale` is how many of this unit make one percent, so percent -> bps is `* 100`, i.e. `to.scale / from.scale`.
  // The first version of this line was inverted (`from.scale / to.scale`) and turned 12.5 bps into 0.00125 — the
  // exact class of silent 4-order-of-magnitude error this module exists to stop, caught by its own test.
  v = (v * to.scale) / from.scale;
  return Object.freeze({ ...c, unit: toUnit, value: v, derivedFrom: { unit: c.unit, value: c.value } });
}

function asHalf(c) {
  const f = UNITS[c.unit].family;
  if (f !== 'spread') throw new Error(`asHalf(${c.quantity}): ${c.unit} is a ${f} quantity, not a spread`);
  if (UNITS[c.unit].per === 'side') return c;
  return convert(c, UNITS[c.unit].scale === 1 ? 'half_spread_pct' : 'half_spread_bps');
}
function asRoundTrip(c) {
  const f = UNITS[c.unit].family;
  if (f !== 'spread') throw new Error(`asRoundTrip(${c.quantity}): ${c.unit} is a ${f} quantity, not a spread`);
  if (UNITS[c.unit].per === 'roundTrip') return c;
  return convert(c, UNITS[c.unit].scale === 1 ? 'round_trip_spread_pct' : 'round_trip_spread_bps');
}
function asBps(c) {
  const f = UNITS[c.unit].family;
  const target = UNITS[c.unit].per === 'roundTrip' ? BPS_OF_ROUND_TRIP[f] : BPS_OF[f];
  if (!target) throw new Error(`asBps(${c.quantity}): no bps unit for family ${f}`);
  if (UNITS[c.unit].scale === 100) return c;
  return convert(c, target);
}

// ── COMPARISON, WHICH REFUSES ───────────────────────────────────────────────────────────────────────────────
// Returns `{ ratio: a.value / b.value, verdict, unit, population }`. THROWS when the two claims are not the same
// kind of number. The throw is the feature: both failures in this module's header would have been exceptions here.
function compare(a, b, { label = 'comparison' } = {}) {
  for (const [name, c] of [['a', a], ['b', b]]) {
    if (!c || !UNITS[c.unit]) throw new Error(`compare(${label}): ${name} is not a claim`);
    if (c.value == null) throw new Error(`compare(${label}): ${name} (${c.quantity}) is an ABSENCE and cannot be divided`);
  }
  if (a.unit !== b.unit) {
    throw new Error(
      `compare(${label}): refusing — "${a.unit}" vs "${b.unit}". These are different quantities, and their ratio `
      + 'is not a discrepancy. Convert explicitly (asHalf/asRoundTrip/asBps) and say which one the answer is in.',
    );
  }
  if (a.population !== b.population) {
    throw new Error(
      `compare(${label}): refusing — same unit ("${a.unit}") but different POPULATION: "${a.population}" vs `
      + `"${b.population}". Different rows are not a discrepancy either. Measured 2026-10-27: Gold tick_all_hours `
      + '0.0563 vs venue_ticket_at_submit 0.0098 — both correct, 5.72x apart.',
    );
  }
  if (!(b.value !== 0)) throw new Error(`compare(${label}): b is zero, the ratio is unbounded`);
  const ratio = a.value / b.value;
  const [lo, hi] = VERDICT_BANDS.reproduces;
  return { ratio, verdict: ratio > lo && ratio < hi ? 'reproduces' : 'differs', unit: a.unit, population: a.population, label };
}

// ★★ A CROSS-POPULATION CHECK IS NEEDED, AND IT IS NOT A RATIO OF LIKE QUANTITIES — so it gets its own name.
//
// "Does the curated constant track what the venue quoted?" is a legitimate and necessary question, and its two
// sides are ALWAYS from different populations. The first version of `compare` refused that outright, which would
// have made the check impossible and pushed the next author back to an inline division — the exact behaviour this
// module exists to end. The distinction being enforced is therefore not "never cross populations" but **"say
// which of the two operations you are performing"**:
//
//   compare()     — same unit AND same population. The ratio is a like-for-like discrepancy.
//   agreesWith()  — same unit, populations MAY differ. The ratio is a TOLERANCE TEST against a baseline, and the
//                   result carries both population names so a reader cannot mistake it for the former.
//
// ⚠ AND IT IS ONE-SIDED IN ITS HONESTY: `agreesWith` passing does not mean the baseline is right. A constant that
// was calibrated on 100 samples agreeing with 14 tickets is evidence, not proof — the `n` on both sides travels
// with the verdict so the reader can weigh it.
function agreesWith(baseline, measured, { tolerance = VERDICT_BANDS.reproduces, label = 'agreement' } = {}) {
  for (const [name, c] of [['baseline', baseline], ['measured', measured]]) {
    if (!c || !UNITS[c.unit]) throw new Error(`agreesWith(${label}): ${name} is not a claim`);
    if (c.value == null) throw new Error(`agreesWith(${label}): ${name} (${c.quantity}) is an ABSENCE and cannot be tested`);
  }
  if (baseline.unit !== measured.unit) {
    throw new Error(
      `agreesWith(${label}): refusing — "${baseline.unit}" vs "${measured.unit}". Agreement is only meaningful in `
      + 'ONE unit; convert explicitly first and record which unit the verdict is in.',
    );
  }
  if (!(measured.value !== 0)) throw new Error(`agreesWith(${label}): measured value is zero, the ratio is unbounded`);
  const ratio = baseline.value / measured.value;
  return {
    ratio,
    verdict: ratio > tolerance[0] && ratio < tolerance[1] ? 'agrees' : 'differs',
    unit: baseline.unit,
    baselinePopulation: baseline.population,
    measuredPopulation: measured.population,
    crossPopulation: baseline.population !== measured.population,
    baselineN: baseline.n,
    measuredN: measured.n,
    tolerance: [...tolerance],
    label,
  };
}

// The ONE-LINE rendering. Every surface that prints a measurement should print it through here, because the
// defect is never the digits — it is a digit without its unit and population beside it.
function render(c) {
  if (!c || !c.unit) return '(not a measurement)';
  const v = c.value == null ? 'ABSENT' : `${round(c.value, 4)} ${c.unit}`;
  const bits = [v, `population ${c.population}`];
  if (c.n != null) bits.push(`n=${c.n}`);
  if (c.window) bits.push(`window ${c.window}`);
  if (c.derivedFrom) bits.push(`derived from ${round(c.derivedFrom.value, 4)} ${c.derivedFrom.unit}`);
  return bits.join(' · ');
}

module.exports = { UNITS, POPULATIONS, VERDICT_BANDS, claim, convert, asHalf, asRoundTrip, asBps, compare, agreesWith, render };
