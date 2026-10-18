// trading/agent/activity.js — the VOLUME-FREE activity measure (design doc §6, P2 item 1).
//
// ★ WHY THIS RATHER THAN RVOL. `plus500.volume` is a CAPTURE COUNT — how many ticks the sweep banked — and
//   `plus500_chart.volume` is absent for whole instrument classes. Measured 2026-09-22: Gold 0 of 1,135 bars,
//   Silver 0/1,127, Bitcoin 0/1,200, BNB 0/497 — against Oil at 1,119/1,119 on the same venue. So a
//   relative-volume filter is unavailable on the instrument the desk's own survivor (`survgold`) trades.
//   §4.2's conclusion is that the activity signal is nevertheless PRESENT in the data that exists, and this
//   is the form of it that works where volume does not exist at all.
//
// ★ THE MEASURE. Not "how much volume", but "how much MOVEMENT, relative to what this hour normally does":
//   the current closed bar's range and body as a fraction of price, against the MEDIAN of the SAME
//   hour-of-day over the trailing N days.
//
//   Same hour-of-day because intraday range has a strong shape — Bitcoin's mean hourly range runs 251 at
//   20:00 UTC to 557 at 14:00 UTC (§4.2) — so a 14:00 bar measured against a 20:00 baseline would read as
//   "twice as active" on the clock alone. Like hour against like hour is what removes that.
//
// ★ WHY IT IS COMPUTED ON THE VENUE OF RECORD — and the reason is AVAILABILITY, which is NOT the reason I
//   first wrote here. Two corrections from `trading/scripts/repro/activity-check.js` (2026-09-22):
//
//   (1) The same-hour baseline ALREADY cancels any bias that is a stable function of the clock — numerator
//       and denominator are understated together — so the venue choice is not what keeps the measure's
//       CENTRE honest. My stated hypothesis (that the tick-built series would DILUTE THE TAIL) was never
//       tested, because the tick series cannot supply the BASELINE AT ALL: the measure is computable on
//       **84-95% of chart-series bars against 0-13% of tick-series bars**, with a median same-hour sample
//       count of **13-20 against 1-4** against a minimum of 8. And where it CAN be computed on the tick
//       series it is unreliable — median ratio 1.09-1.86 and p90 up to 7.75 on samples of 1-4. A measure
//       that is unavailable, and wrong where available, is not a measure.
//
//   (2) The chart series is also CALIBRATED, and that is the check that matters for a ratio of this shape.
//       Walked over every bar, its **median ratio is 0.97-1.07 across six symbols** — the typical bar is
//       typical for its hour, which is exactly what an unbiased baseline must produce. THAT is the evidence
//       for this design; the venue argument is only why it is computable at all.
//
//   The baseline counts CALENDAR days, so an instrument that closes at weekends sees ~14 samples in a
//   20-day window rather than 20 (measured: median n = 14 for Gold). That is above `minSamples` but it is
//   worth knowing the denominator is weekday-weighted on those symbols.
//
//   Reusing the bars `quant` already resolved for structure makes all of this cost nothing.
//
// ★ RULES IT INHERITS (§7), each one load-bearing:
//   1. Closed bars only, and the caller resolves `asOf` — there is deliberately NO default (§7 rule 1 and
//      the TRD-92 house rule: a default would make "the last bar" an implicit lookahead).
//   2. The baseline EXCLUDES the bar being measured. A bar in its own baseline drags the median toward
//      itself, which shrinks the very ratio the measure exists to report.
//   3. `insufficient_history` is its OWN state, never a blank or a ratio computed from three samples.
//   4. Every result carries its basis (which series) and its params (what N and what minimum).
'use strict';

const DEFAULTS = Object.freeze({
  days: 20,       // trailing window, in days, for the same-hour baseline
  minSamples: 8,  // below this the baseline is a guess — report insufficiency, never a ratio
});

// Range and body as BASIS POINTS of the close, so the two are comparable across instruments and a shared
// threshold can exist at all. Range uses the close as its denominator (not the open) so that a bar whose
// open is the extreme does not move the denominator as well as the numerator.
function rangeBps(b) {
  const h = Number(b.high), l = Number(b.low), c = Number(b.closePrice);
  if (![h, l, c].every(Number.isFinite) || c <= 0) return null;
  return ((h - l) / c) * 10000;
}
function bodyBps(b) {
  const o = Number(b.openPrice), c = Number(b.closePrice);
  if (![o, c].every(Number.isFinite) || c <= 0) return null;
  return (Math.abs(c - o) / c) * 10000;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// A ratio against a baseline of ZERO is not a large number, it is an undefined one: a run of perfectly
// flat bars at this hour makes the denominator 0, and `x / 0` would report Infinity as activity.
function ratio(now, base) {
  if (now == null || base == null || !(base > 0)) return null;
  return now / base;
}

// `asOf` is the index of the CLOSED bar being measured. The caller resolves it (quant passes the same bar
// structure uses), because the engine states its own rule rather than inheriting one (§4.4).
function computeActivity({ bars, asOf, params, basis } = {}) {
  if (!Array.isArray(bars)) throw new TypeError('activity: bars must be an array');
  if (!Number.isInteger(asOf)) {
    throw new TypeError('activity: asOf is required and must be an integer index (there is deliberately no '
      + 'default — a default would make "the last bar" an implicit lookahead)');
  }
  if (asOf < 0 || asOf >= bars.length) throw new RangeError(`activity: asOf ${asOf} is outside 0..${bars.length - 1}`);

  const p = { ...DEFAULTS, ...(params || {}) };
  const days = Number(p.days);
  const minSamples = Number(p.minSamples);
  if (!Number.isFinite(days) || days < 1) throw new RangeError(`activity: days must be a finite number >= 1 (got ${JSON.stringify(p.days)})`);
  if (!Number.isFinite(minSamples) || minSamples < 1) throw new RangeError(`activity: minSamples must be a finite number >= 1 (got ${JSON.stringify(p.minSamples)})`);

  const outBasis = {
    venue: (basis && basis.venue) || null,
    venueWhy: (basis && basis.venueWhy) || null,
    timeframe: (basis && basis.timeframe) || null,
    sourceIntervalSec: (basis && basis.sourceIntervalSec) || null,
    asOf,
    asOfBarStart: bars[asOf] ? bars[asOf].barStart : null,
  };
  const shape = { state: null, basis: outBasis, params: p, hourUtc: null, samples: 0, range: null, body: null, reason: null };

  const bar = bars[asOf];
  const at = bar && bar.barStart ? new Date(bar.barStart) : null;
  if (!at || !Number.isFinite(at.getTime())) {
    return { ...shape, state: 'insufficient_history', reason: 'the bar being measured has no usable barStart' };
  }
  const hourUtc = at.getUTCHours();
  shape.hourUtc = hourUtc;
  const floorMs = at.getTime() - days * 86400000;

  const base = [];
  for (let i = 0; i < asOf; i++) { // ★ i < asOf — the bar being measured is NOT in its own baseline
    const b = bars[i];
    if (!b || !b.barStart) continue;
    const t = new Date(b.barStart);
    if (!Number.isFinite(t.getTime())) continue;
    if (t.getTime() < floorMs) continue;
    if (t.getUTCHours() !== hourUtc) continue;
    const r = rangeBps(b);
    if (r == null) continue;
    base.push({ r, body: bodyBps(b) });
  }
  shape.samples = base.length;

  if (base.length < minSamples) {
    return { ...shape, state: 'insufficient_history', reason: `${base.length} same-hour bar(s) in the trailing ${days}d at ${String(hourUtc).padStart(2, '0')}:00Z < minSamples ${minSamples}` };
  }

  const nowRange = rangeBps(bar);
  const nowBody = bodyBps(bar);
  const baseRanges = base.map((x) => x.r);
  const baseBodies = base.map((x) => x.body).filter((v) => v != null);
  const medRange = median(baseRanges);
  const medBody = median(baseBodies);

  return {
    ...shape,
    state: 'ok',
    range: {
      nowBps: nowRange,
      medianBps: medRange,
      ratio: ratio(nowRange, medRange),
      // Stated as a percentile as well as a ratio: a ratio answers "how much bigger", a percentile answers
      // "how unusual", and with 20-40 samples the second is the more honest of the two.
      percentile: nowRange == null ? null : baseRanges.filter((r) => r <= nowRange).length / baseRanges.length,
    },
    body: { nowBps: nowBody, medianBps: medBody, ratio: ratio(nowBody, medBody) },
  };
}

module.exports = { computeActivity, DEFAULTS, rangeBps, bodyBps };
