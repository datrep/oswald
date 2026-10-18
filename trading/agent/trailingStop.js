// trading/agent/trailingStop.js — TRD-TRL-2: the venue-native trailing stop, DECIDED and CHECKED.
//
// WHY THIS IS A PURE MODULE AND NOT PART OF THE BRIDGE. The DOM half lives in `plus500/webtrader.js`, which
// attaches to the live Chrome on :9224 and therefore cannot be required from a unit test (`test/_source.js` says
// so). The half that can be wrong in a way that COSTS MONEY is the arithmetic and the refusal rules, so they live
// here where a test pins them. The same split as `deliberationScope` (TRD-TRL-1 defect 1(b)) and `stopPolicy`.
//
// ★★ WHAT THE VENUE ACTUALLY REPORTS, measured 2026-09-30 from two owner dumps of the Oil position (#1134, sell,
// entry 89.76, size 15, venue stop 90.9704). The widget exposes two spans:
//
//     [data-currency]   S$ -6.90      <- the P&L IF THE TRAIL TRIGGERED NOW
//     [data-percent]    -0.40%
//
// The FIRST one is exact and reproducible: (trailLevel - entry) x size x profitSign.
//     dump B: (90.22 - 89.76) x 15 x -1 = -6.90    <- to the cent
//     dump A: (90.13 - 89.76) x 15 x -1 = -5.56    <- to the cent
// Both imply a trail level of `price + d`, i.e. on the STOP side, which is where a trailing stop belongs.
//
// ★★ THE PERCENT SPAN IS NOW IDENTIFIED - AND IT IS THE BETTER ROUTE, BECAUSE IT NEEDS NEITHER THE FX RATE NOR
// THE PIP SIZE. `percent = money / (size x price x fx)`, i.e. **the P&L if triggered as a percentage of the
// position's value in the account currency**. Two independent confirmations:
//     Oil, closed-position panel: notional $1,346.25 x 1.2833 = S$1,728 and money/percent was S$1,725-1,737
//     Bitcoin #1131:              0.007 x 83,568.7 = $585 x 1.2833 = S$751 and money/percent was S$749
// Because the size and the fx cancel, `trailLevel = entry + percent x price x profitSign` and therefore
//
//     distance = |entry - price + (percent x price x profitSign x profitSign)| = |(entry - price) + percent x price|
//
// ⚠ THE SELL SIGN IS THE TRAP: `percent` carries the P&L sign, so for a SELL a loss is NEGATIVE and the level is
// `entry - percent x price`. Get that backwards and the trail lands on the wrong side of the price entirely.
//
// ★ SO THE DESK NEVER NEEDS A PIP SIZE - IT INVERTS A READING INTO A LEVEL AND SCALES ON THE DISTANCE:
//
//     trailLevel = entry + moneyRead / (size x profitSign x fx)   <- invert the venue's own print
//     distance   = |trailLevel - price|                           <- price read in the SAME breath
//     pips*      = probePips x distanceTarget / distanceRead      <- one correction step
//
// ⚠⚠ **THE MONEY SPAN IS IN THE ACCOUNT CURRENCY, SO IT NEEDS `fx` - AND THIS MODULE GOT THAT WRONG FIRST.**
// The venue prints `S$-5.09` on a USD-denominated instrument, so `(level - entry) x size` is a USD figure that
// must be multiplied by the CNY/SGD-per-USD rate before it can be compared with the span. **The first version of
// this module compared a USD-computed number against an SGD-displayed one** - the exact "two different
// quantities" defect this desk keeps repeating. The RATIOS this module uses are unaffected (fx cancels in
// money2/money1), which is why the scaling still works; the ABSOLUTE level is not, which is why
// `distanceFromPercent` exists and is preferred whenever the price is known.
//
// ⚠ WHY DISTANCE AND NOT MONEY, which is a correction this module made against itself: the venue's money is
// measured FROM THE ENTRY, so it moves every time the market ticks even when the trail has not. A 2-cent move on
// 15 barrels of Oil is 1.65% of the money target - enough to trip a 2% tolerance on a trail that is exactly
// right. The distance is the quantity the desk actually asks for, and it is what a venue trail re-anchors to.
//
// ⚠ TWO GUARDS, because the alternative is a level whose size the desk cannot state:
//   1. THE PROBE MUST BE BIG. Inverting the money to a level divides by `size`, so a reading that rounds to zero
//      becomes a bogus level. The probe defaults to 100000 and a reading under S$1.00 is REJECTED, not scaled
//      from. That floor is size-free: the level's rounding error and its signal both scale by 1/size, so
//      S$1.00 is a ~200x margin over the 2-decimal display for every instrument.
//   2. THE VERIFICATION IS MANDATORY. After setting pips*, the money AND the price are read AGAIN and the
//      distance must match inside `tolerancePct`; otherwise the caller must CLEAR the trail and leave the venue
//      stop governing. There is no path that submits a trail whose size the desk cannot state.
//
// ★ AND `d >= stopDist` IS ENFORCED, NOT DOCUMENTED. The trail coexists with the venue stop and the VENUE
// arbitrates, so the tighter level always wins. A trail with `d < stopDist` therefore does not add protection:
// it silently REPLACES the stop the sizing was computed against, and every R multiple on this desk divides by
// that same stopDist (report section 2). A tighter trail is allowed only when the caller says so explicitly.
'use strict';

const DEFAULT_MULTIPLE = 1; // d = multiple x stopDist. 1 == the stop own distance.
const DEFAULT_TOLERANCE_PCT = 2;
const PROBE_PIPS = 100000;
const PROBE_FLOOR = 1.0; // S$ — below this the 2-decimal display is too coarse to scale from

const profitSign = (direction) => (direction === 'buy' ? 1 : -1);

// ⚠ EVERY EXTERNAL VALUE GOES THROUGH THIS, NOT `Number()`.
// `Number(null)` is 0 and `Number('')` is 0, so a DOM read that came back empty does not arrive as a refusal -
// it arrives as the number ZERO, which is a perfectly plausible price, size or money. Left unguarded a missing
// `entry` makes the stop distance equal the absolute stop price (a 90.97-unit trail on Oil) and a missing money
// reads as "the trail sits exactly on the entry". Both would be submitted as a confident ticket.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The trail LEVEL that sits `distance` away on the STOP side. A buy stop lives below the price; a sell stop above.
function trailLevelFor({ direction, price, distance }) {
  const p = num(price);
  const d = num(distance);
  if (direction !== 'buy' && direction !== 'sell') return null;
  if (p == null || d == null || !(p > 0) || !(d > 0)) return null;
  return +(direction === 'buy' ? p - d : p + d).toFixed(8);
}

// The P&L if the trail triggered at `trailLevel`, for a position opened at `entry` with `size`.
// ⚠ THIS IS IN THE INSTRUMENT'S PRICE CURRENCY (USD for Oil/BTC), NOT THE ACCOUNT CURRENCY. The venue's span
// prints SGD, so the two differ by `fx`; `moneyAt` is used for RATIOS (where fx cancels) and for tests, and
// must NOT be compared directly against a value read off the venue's panel.
function moneyAt({ direction, entry, size, trailLevel }) {
  const e = num(entry);
  const s = num(size);
  const t = num(trailLevel);
  if (direction !== 'buy' && direction !== 'sell') return null;
  if (e == null || s == null || t == null) return null;
  return +((t - e) * s * profitSign(direction)).toFixed(4);
}

// The inverse of `moneyAt`: the level the venue just implied with that money. This is how the desk learns what
// the spinner actually did without knowing the pip size.
function trailLevelFromMoney({ direction, entry, size, moneyRead }) {
  const e = num(entry);
  const s = num(size);
  const m = num(moneyRead);
  if (direction !== 'buy' && direction !== 'sell') return null;
  if (e == null || s == null || m == null || s === 0) return null;
  return +(e + m / (s * profitSign(direction))).toFixed(8);
}

// The reading, turned into the quantity the desk controls. `price` must be read at the SAME moment as the money:
// the venue anchors the trail to the price, so a stale price turns a correct trail into a phantom mismatch.
function distanceFromReadback({ direction, entry, size, moneyRead, price }) {
  const p = num(price);
  if (p == null || !(p > 0)) return { ok: false, reason: 'price_unknown' };
  const trailLevel = trailLevelFromMoney({ direction, entry, size, moneyRead });
  if (trailLevel == null) return { ok: false, reason: 'level_undefined' };
  const distance = +Math.abs(trailLevel - p).toFixed(8);
  if (!(distance > 0)) return { ok: false, reason: 'zero_distance', trailLevel };
  return { ok: true, trailLevel, distance };
}

// ★ THE PREFERRED ROUTE WHEN THE PRICE IS KNOWN: the level from the percentage, with no fx rate and no pip size.
// `percentFraction` is a FRACTION - pass 0.0068 for the venue's `0.68%` - and it CARRIES THE P&L SIGN, so a SELL
// in loss is negative and the level moves UP from the entry.
function distanceFromPercent({ direction, entry, price, percentFraction }) {
  const e = num(entry);
  const p = num(price);
  const q = num(percentFraction);
  if (direction !== 'buy' && direction !== 'sell') return { ok: false, reason: 'bad_direction' };
  if (e == null || p == null || q == null || !(p > 0)) return { ok: false, reason: 'percent_inputs_unusable' };
  // percent = (level - entry) x profitSign / price  ->  level = entry + percent x price x profitSign
  const trailLevel = +(e + q * p * profitSign(direction)).toFixed(8);
  const distance = +Math.abs(trailLevel - p).toFixed(8);
  if (!(distance > 0)) return { ok: false, reason: 'zero_distance', trailLevel };
  return { ok: true, trailLevel, distance };
}

// ★★★ THE CALIBRATION, AND IT NEEDS NO ASSUMPTION AT ALL. Two readings at ONE price pin the pip outright.
//
// With the money affine in the pip count, `money(p) = P - p x pip x size x fx`, where P is the position's own
// unrealised P&L. The two readings give the SLOPE, and the slope extrapolated to p=0 gives P - the anchor
// cancels. The percent gives the position VALUE, because `percent = money / (size x price x fx)`. And since
// `value = price x size x fx` while `P = (entry - price) x size x fx x profitSign`, adding them eliminates the
// price and leaves `size x fx`:
//
//     k        = -dmoney / dpips           S$ per pip     (the slope; positive for a real trailing stop)
//     value    = dmoney / dpercent         the position value in the account currency
//     impliedP = money1 + pips1 x k        the P&L if the trail sat ON the price (p = 0)
//     size x fx = (value + impliedP) / entry
//     pip      = k / (size x fx)           <-- THE ANSWER, in price units per pip
//
// ⚠ THIS IS WHY THE PAIR MUST COME FROM ONE PANEL AT ONE MOMENT: the price cancels only if it did not move
// between the two readings, and a tick mid-pair moves the percent, which is the term carrying the value.
// ⚠ AND IT IS WHY THE PAIR IS WORTH TAKING. Confirmed on Bitcoin #1131, 2026-09-30 - 80,000 pips / S$-5.31 /
// -0.71% against 40,000 / S$-1.75 / -0.23% returns **pip = 0.010004, i.e. A CENT**, plus an implied fx of 1.271
// and an implied price of 83,365. A ROUND PIP IS THE VERIFICATION: the model has three free parameters here and
// nothing forced it to land on a cent.
function pipFromPair({ entry, size = null, readings }) {
  const e = num(entry);
  if (e == null || !(e > 0)) return { ok: false, reason: 'bad_entry' };
  if (!Array.isArray(readings) || readings.length < 2) return { ok: false, reason: 'need_two_readings' };
  const r = readings.map((x) => ({
    pips: num(x && x.pips),
    money: num(x && x.money),
    percentFraction: num(x && x.percentFraction),
  }));
  if (r.some((x) => x.pips == null || x.money == null || x.percentFraction == null)) {
    return { ok: false, reason: 'unreadable_reading' };
  }
  // read the pair from the smallest pip count upward, so the signs below do not depend on the caller's order
  r.sort((a, b) => a.pips - b.pips);
  const [a, b] = r;
  const dpips = b.pips - a.pips;
  if (dpips <= 0) return { ok: false, reason: 'pips_do_not_differ' };
  const dmoney = b.money - a.money;
  const k = -dmoney / dpips; // S$ gained per pip of count
  if (!(k > 0)) return { ok: false, reason: 'not_monotonic', dpips, dmoney };
  const dpercent = b.percentFraction - a.percentFraction;
  if (dpercent === 0) return { ok: false, reason: 'percent_does_not_differ' };
  const value = dmoney / dpercent; // the position value in the account currency
  if (!(value > 0)) return { ok: false, reason: 'implied_value_not_positive', value };
  const impliedP = a.money + a.pips * k; // money at p = 0 == the position's unrealised P&L
  const sizeFx = (value + impliedP) / e; // size x fx
  if (!(sizeFx > 0)) return { ok: false, reason: 'implied_size_fx_not_positive', sizeFx, impliedP, value };
  const pip = k / sizeFx;
  if (!(pip > 0) || !Number.isFinite(pip)) return { ok: false, reason: 'pip_not_positive', pip };
  const s = num(size);
  return {
    ok: true, pip: +pip.toFixed(10), sizeFx: +sizeFx.toFixed(10), impliedP: +impliedP.toFixed(6),
    impliedValue: +value.toFixed(4), impliedPrice: +(value / sizeFx).toFixed(4),
    impliedFx: s != null && s > 0 ? +(sizeFx / s).toFixed(6) : null,
  };
}

// The whole decision, from the live position to the number to type into the spinner.
// Returns `{ ok: false, reason }` for every path that must NOT place a trail - never a defaulted distance.
function plan({ settings, direction, entry, size, price, stopPrice }) {
  const cfg = (settings && settings.risk && settings.risk.trailingStop) || {};
  if (cfg.enabled !== true) return { ok: false, reason: 'disabled' };

  const e = num(entry);
  const sp = num(stopPrice);
  const px = num(price);
  if (e == null || sp == null) return { ok: false, reason: 'stop_distance_unknown' };
  if (px == null || !(px > 0)) return { ok: false, reason: 'price_unknown' };

  // The sizing reference: this is the R denominator of report section 2, and it is NOT the guard below.
  const stopDistFromEntry = Math.abs(e - sp);
  if (!(stopDistFromEntry > 0)) return { ok: false, reason: 'stop_distance_unknown' };

  // ⚠⚠ THE GUARD USES THE STOP'S DISTANCE **FROM THE PRICE**, NOT FROM THE ENTRY - AND THIS MODULE GOT THAT
  // WRONG FIRST. The venue arbitrates between two LEVELS, so the trail is tighter than the stop exactly when
  // its level is nearer the price, i.e. when `d < |stopPrice - price|`. Judging it against `|entry - stopPrice|`
  // instead is CORRECT ONLY WHILE THE PRICE IS AT THE ENTRY. Bitcoin #1131 is the counter-example that caught
  // it: the trail read was 808.4 from the price and the stop 889.0 from it - genuinely 9% TIGHTER, firing first -
  // yet 808.4 > 647.21 = |entry - stop|, so an entry-based guard would have waved it through.
  const stopDist = Math.abs(sp - px);
  if (!(stopDist > 0)) return { ok: false, reason: 'stop_distance_unknown' };

  const configured = num(cfg.distanceMultiple);
  const multiple = configured != null && configured > 0 ? configured : DEFAULT_MULTIPLE;

  // d >= stopDist is enforced, not documented: a trail tighter than the stop is a REPLACEMENT of the level the
  // sizing was computed against, and it needs an explicit opt-in. DEFAULT_MULTIPLE is 1, so by default
  // **the trail starts exactly ON the stop** - wherever the price is - and the venue's own ratchet does the rest.
  if (multiple < 1 && cfg.allowTighterThanStop !== true) {
    return { ok: false, reason: 'tighter_than_stop_requires_explicit_opt_in', multiple, stopDist, stopDistFromEntry };
  }

  const distance = +(multiple * stopDist).toFixed(8);
  const trailLevel = trailLevelFor({ direction, price: px, distance });
  if (trailLevel == null) return { ok: false, reason: 'trail_level_undefined' };

  // ★★ THE INTENDED LEVEL, STATED WITHOUT REFERENCE TO THE PRICE - AND THE REASON IT IS NEEDED.
  //
  // `trailLevel` above is the level the desk MEANS, but it is built from `px`, the price read at plan time. The
  // venue applies a pip count to ITS OWN price a moment later, so the level it actually holds is a different
  // number, and until now nothing in the codebase could say which. `verifyReadback` compares the REALISED
  // DISTANCE against `distanceTarget` - a quantity about the trail's own size - and the trail's size can be
  // perfect while its POSITION is wrong. Measured on trade #1164 (Oil, 2026-10-01): requested 0.875, read back
  // 0.8688, drift 0.709% - comfortably inside the 2% tolerance, so `placed: true`. But the recorded stop was
  // 89.595 and the level landed at 89.6312: for a buy a HIGHER stop is a TIGHTER one, so the trail was 0.0362
  // TIGHTER - 4.1% of the stop distance - and, because the venue fires the tighter level first, it silently
  // REPLACED the stop every R multiple on this desk divides by. Two independent causes, neither of them a bug in
  // the request: the venue snapped 87.5 pips down to 80, and it applied that count to 90.50 while the desk had
  // read 90.47. A ~3-tick gap and a one-pip snap are each harmless; together they crossed a level.
  //
  // So the target level is stated from the STOP, not the price: at `multiple: 1` it is the stop's own level
  // EXACTLY, wherever the price happens to be, and each extra multiple moves it one `stopDistFromEntry` further
  // from the price. That is price-independent, so a read-back can finally be judged on WHERE it landed rather
  // than only on how big it is - `verifyStopRelationship` below.
  const widerBy = (multiple - 1) * stopDistFromEntry;
  const trailLevelTarget = +(direction === 'buy' ? sp - widerBy : sp + widerBy).toFixed(8);

  const configuredTol = num(cfg.verifyTolerancePct);
  const tolerancePct = configuredTol != null && configuredTol > 0 ? configuredTol : DEFAULT_TOLERANCE_PCT;

  return {
    ok: true, multiple, stopDist, stopDistFromEntry, distance, distanceTarget: distance, trailLevel,
    trailLevelTarget, tolerancePct,
    // for the log and for tests, NOT for the verification - see the distance-vs-money note above
    expectedMoney: moneyAt({ direction, entry: e, size, trailLevel }),
    probePips: PROBE_PIPS, tighterThanStop: multiple < 1,
  };
}

// ★★★ THE CHECK THE DISTANCE TOLERANCE CANNOT MAKE: WHERE THE TRAIL LANDED RELATIVE TO THE STOP.
//
// `verifyReadback` answers "is the trail the size we asked for?". It cannot answer "is the trail on the correct
// SIDE of the stop?", because a trail can be exactly the requested size and still be tighter - and `tighterThanStop`
// in `plan()` is about the REQUESTED multiple, which is a different question from the REALISED level. The venue's
// pip grid and its own price sit between the two, and this desk has now measured them landing on opposite sides of
// the stop (trade #1164, above).
//
// The margin is SIGNED, and the sign is the whole point: for a buy, `stop - trail > 0` means the trail is BELOW
// the stop, so the stop still fires first and the ratchet is the only thing added. `stop - trail < 0` means the
// trail is ABOVE the stop and therefore REPLACES it. A sell mirrors it. Only the realised LEVEL decides this -
// no multiple, no distance and no tolerance can stand in for it.
//
// The tolerance is expressed as a percentage of `stopDistFromEntry` - the R DENOMINATOR - because that is the
// quantity every R multiple on this desk divides by, so "how much of the sizing did this silently re-cut?" is
// exactly the number the owner needs to see.
function verifyStopRelationship({ direction, stopPrice, trailLevel, multiple, allowTighterThanStop, stopDistFromEntry, tolerancePct }) {
  if (direction !== 'buy' && direction !== 'sell') return { ok: false, reason: 'bad_direction' };
  const sp = num(stopPrice);
  const tl = num(trailLevel);
  if (sp == null || tl == null) return { ok: false, reason: 'level_unknown' };
  // > 0 the trail is WIDER than the stop (harmless: the stop still fires first)
  // < 0 the trail is TIGHTER than the stop (it replaces the level the sizing was computed against)
  const margin = +(direction === 'buy' ? sp - tl : tl - sp).toFixed(8);
  const ref = num(stopDistFromEntry);
  const optIn = multiple != null && multiple < 1 && allowTighterThanStop === true;
  if (margin >= 0) {
    return { ok: true, tighter: false, margin, tighterBy: 0, tighterPctOfStopDist: 0, multiple: multiple ?? null, stopDistFromEntry: ref };
  }
  const tighterBy = +(-margin).toFixed(8);
  const tighterPctOfStopDist = ref != null && ref > 0 ? +((tighterBy / ref) * 100).toFixed(4) : null;
  // An explicit opt-in is the ONLY thing that makes a tighter trail legitimate, and it is reported either way.
  if (optIn) {
    return { ok: true, tighter: true, optIn: true, margin, tighterBy, tighterPctOfStopDist, multiple, stopDistFromEntry: ref };
  }
  const tol = num(tolerancePct);
  const within = tighterPctOfStopDist != null && tol != null && tol > 0 && tighterPctOfStopDist <= tol;
  return {
    ok: within, tighter: true, margin, tighterBy, tighterPctOfStopDist,
    multiple: multiple ?? null, stopDistFromEntry: ref, tolerancePct: tol ?? null,
    reason: within ? 'tighter_within_tolerance' : 'trail_tighter_than_stop',
  };
}

// One correction step: the trail distance is proportional to the pip count, so the ratio of the target distance
// to the measured distance IS the ratio of the counts. Refuses (rather than scaling from) an unusable probe.
function pipsFromReadback({ probePips, moneyRead, distanceRead, distanceTarget }) {
  const p = num(probePips);
  const m = num(moneyRead);
  const d = num(distanceRead);
  const dt = num(distanceTarget);
  if (p == null || !(p > 0)) return { ok: false, reason: 'bad_probe' };
  if (dt == null || !(dt > 0)) return { ok: false, reason: 'bad_target' };
  if (m == null || Math.abs(m) < PROBE_FLOOR) {
    // A reading that rounds to zero inverts to a level of `entry`, i.e. a distance that is pure artefact.
    return { ok: false, reason: 'probe_reading_too_small', moneyRead: m, floor: PROBE_FLOOR };
  }
  if (d == null || !(d > 0)) return { ok: false, reason: 'bad_readback_distance', distanceRead: d };
  const pips = Math.round(p * (dt / d));
  if (!(pips > 0) || !Number.isFinite(pips)) return { ok: false, reason: 'pips_not_positive', pips };
  return { ok: true, pips };
}

// The mandatory post-set check, on the distance, so a market tick cannot fail a correct trail.
function verifyReadback({ distanceRead, distanceTarget, tolerancePct }) {
  const d = num(distanceRead);
  const dt = num(distanceTarget);
  const tol = num(tolerancePct) > 0 ? num(tolerancePct) : DEFAULT_TOLERANCE_PCT;
  if (d == null || !(dt > 0)) return { ok: false, reason: 'unverifiable' };
  const driftPct = Math.abs((d - dt) / dt) * 100;
  return { ok: driftPct <= tol, driftPct: +driftPct.toFixed(4), tolerancePct: tol, distanceRead: d, distanceTarget: dt };
}

// ── TRD-TRL-3: WHAT A PIP COUNT ACTUALLY BUYS, MEASURED PER INSTRUMENT ───────────────────────────────────────
//
// ⚠ WHY A TABLE NOW, WHEN THIS MODULE ARGUED AGAINST ONE. The module's original case was that a GUESSED pip table
// is worse than no table at all, and that case stands untouched. This is not a guess: every row below was measured
// on 2026-09-30 by reading the control's own consequence at a sweep of counts, on a ticket that was never
// submitted (`scripts/repro/trail-curve-probe.js`; raw curves in `temp/trail-curve-*.json`). The provenance is the
// point - **an instrument that has not been measured is REFUSED, never defaulted.**
//
// THE MODEL, affine rather than proportional because the measurements say so:
//
//     distance(count) = pip x count + offset,   within [minCount, maxCount]
//
// `pip` is 0.01 - ONE CENT - on every instrument measured, which is why the count for a target distance is simply
// `(target - offset) / pip` and the desk needs no scaling probe at all.
//
// ⚠ THE OFFSET IS MEASURED AND ITS CAUSE IS NOT IDENTIFIED, so it is written down as a number rather than
// explained. It is under the display's own resolution on Oil and Sugar (~0.07, ~0.03) and material elsewhere:
// Arabica Coffee ~0.23, and **Bitcoin ~126.6 - 0.15% of its price.** On Bitcoin it cannot be ignored: a trail
// asked for at 800 arrives at ~927, 16% WIDER. So a target at or below the offset is REFUSED rather than turned
// into a count of zero or a negative one.
//
// ⚠ AND THE RANGE IS REAL, WHICH IS THE WHOLE OF THIS ROW. Outside [minCount, maxCount] the control CLAMPS:
// requested 1, 2 and 5 pips on Oil all come back as **7**, and requested 25,000 and 100,000 both come back as
// **15,050**. Every one of the eight refused entries this row exists for was reading the symbol's own MAXIMUM -
// Arabica's two refusals read 266.92/267.00 against a measured ceiling of 266.7, Sugar's three read 31.55/31.54/
// 31.58 against 31.53, Oil's three read 150.70/150.62/150.39 against 150.50.
// ⚠ THE PIP IS PER-INSTRUMENT, AND MEASURING IT REFUTED THE FIRST GUESS. After four instruments every row read
// `pip: 0.01` and the working assumption became "the control counts cents". Silver, measured next, is **0.001** -
// a tenth of that - so the pip is a property of the instrument and is NEVER defaulted or inferred from another
// row. Same for the offset, which spans 0.03 (Sugar) to 126.6 (Bitcoin).
//
// ⚠ AND THE OFFSET IS FITTED FROM A PERCENT THAT IS PRINTED TO TWO DECIMALS, so it carries real uncertainty that
// is recorded rather than hidden. On Gold the four usable points imply 0.891 / 0.687 / 0.914 / 0.664, i.e.
// 0.79 +/- 0.21 - the scatter IS the span's rounding, not noise in the control. It is kept because the residual
// is <1% of any distance the desk asks for, which is far inside the 5% band the read-back is accepted on.
const PIP_UNITS = {
  oil: { pip: 0.01, offset: 0.07, minCount: 7, maxCount: 15050, measuredAt: '2026-09-30' },
  sugar: { pip: 0.01, offset: 0.03, minCount: 2, maxCount: 3150, measuredAt: '2026-09-30' },
  'arabica coffee': { pip: 0.01, offset: 0.23, minCount: 40, maxCount: 26650, measuredAt: '2026-09-30' },
  bitcoin: { pip: 0.01, offset: 126.6, minCount: 1, maxCount: null, measuredAt: '2026-09-30' },
  // Gold: the desk's most-traded instrument (47 of ~150 trades). Floor is a DISTANCE of 2.5134, not a count -
  // counts 1, 2, 5, 10, 20, 50 and 100 ALL read it. No ceiling found: 100,000 still read proportionally.
  gold: { pip: 0.01, offset: 0.79, minCount: 172, maxCount: null, measuredAt: '2026-09-30' },
  // Silver: pip one TENTH of Gold's, floor distance 0.0974, and it DID clamp at 37,850 (the venue rewrote the
  // field to its own maximum), which is the ceiling this row records.
  // ⚠ RE-MEASURED 2026-10-08 (TRD-TRL-8, after the T2.5 read-back abort of 00:49Z): pip and BOTH clamp ends are
  // unchanged (100,000 still rewritten to 37,850; counts <= 20 still floored to 45), but the OFFSET has DRIFTED
  // 0.052 -> ~0.078 (sell-side fits 0.080/0.082/0.083/0.084, buy-side 0.074/0.075/0.077; n=8 rows across four
  // read-only sweeps). Only the offset moved; it is the term the trail's landing check and verifyReadback both
  // derive their expected distance from, and the 09-30 value missed by ~2% at the abort's count - inside the
  // landing band's 0.05 floor but OUTSIDE the 2% verify band, i.e. straight into the fail-safe. Cause unknown;
  // it is a number to re-measure, not an assumption to hold (the same rule the ceiling rows above ran under).
  silver: { pip: 0.001, offset: 0.078, minCount: 45, maxCount: 37850, measuredAt: '2026-10-08' },
};

const pipUnitsFor = (symbol) => {
  const row = PIP_UNITS[String(symbol == null ? '' : symbol).trim().toLowerCase()];
  return row ? { ok: true, ...row } : { ok: false, reason: 'instrument_not_measured' };
};

// The count to type for a trail `distanceTarget` away. Every path that cannot be stated REFUSES - an unmeasured
// instrument, a target the control cannot express, a count outside the range the venue accepts - because a count
// the desk cannot justify is the defect this whole row exists to remove.
function pipsForTarget({ symbol, distanceTarget }) {
  const u = pipUnitsFor(symbol);
  if (!u.ok) return { ok: false, reason: u.reason, symbol: symbol == null ? null : String(symbol) };
  const d = num(distanceTarget);
  if (d == null || !(d > 0)) return { ok: false, reason: 'bad_target' };
  if (d <= u.offset) return { ok: false, reason: 'at_or_below_control_offset', offset: u.offset, distanceTarget: d };
  const pips = Math.round((d - u.offset) / u.pip);
  if (!(pips > 0) || !Number.isFinite(pips)) return { ok: false, reason: 'pips_not_positive', pips };
  if (u.minCount != null && pips < u.minCount) {
    return {
      ok: false, reason: 'below_venue_minimum_count', pips, minCount: u.minCount,
      wouldBeDistance: +(u.pip * u.minCount + u.offset).toFixed(4),
    };
  }
  if (u.maxCount != null && pips > u.maxCount) {
    return {
      ok: false, reason: 'above_venue_maximum_count', pips, maxCount: u.maxCount,
      wouldBeDistance: +(u.pip * u.maxCount + u.offset).toFixed(4),
    };
  }
  return {
    ok: true, pips, pip: u.pip, offset: u.offset,
    // what the control should read back - the number the verification is measured against
    expectedDistance: +(u.pip * pips + u.offset).toFixed(4),
    measuredAt: u.measuredAt,
  };
}

// The distance a given count MEANS. The inverse of `pipsForTarget`, and it exists so that the DOM side can ask
// "what should the card read now?" without repeating `pip x count + offset` - a rule with two homes is a rule
// that will disagree with itself, which is how `pipsFromReadback` produced the eight refusals this row replaces.
function distanceForCount({ symbol, count }) {
  const u = pipUnitsFor(symbol);
  if (!u.ok) return { ok: false, reason: u.reason };
  const n = num(count);
  if (n == null) return { ok: false, reason: 'bad_count' };
  return { ok: true, distance: +(u.pip * n + u.offset).toFixed(4), pip: u.pip, offset: u.offset, measuredAt: u.measuredAt };
}

module.exports = {
  trailLevelFor, moneyAt, trailLevelFromMoney, distanceFromReadback, distanceFromPercent, pipFromPair, plan,
  verifyStopRelationship,
  pipsFromReadback, verifyReadback, DEFAULT_MULTIPLE, DEFAULT_TOLERANCE_PCT, PROBE_PIPS, PROBE_FLOOR,
  // TRD-TRL-3: the measured unit table, the count it implies, and what a count means
  PIP_UNITS, pipUnitsFor, pipsForTarget, distanceForCount,
};

// ⚠ THIS BLOCK WAS DUPLICATED BY AN EDIT AND IS DELETED — see git history.
