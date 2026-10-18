// trading/agent/venueComparability.js — is that other venue even the same instrument? (TRD-69)
//
// THE DEFECT THIS ANSWERS. Fixing a dead tick feed (TRD-62), the first pickTick preferred "a fresh
// tick from ANY venue", which selected YAHOO Gold at 4312.90 while the venue's own live quote was
// 4268.35 and stale plus500 was 4294.50. Newest Gold tick per venue, at that moment:
//     binance 4281.65 (149s)   okx 4281.30 (149s)   yahoo 4312.80 (148s)   plus500 4294.50 (9088s)
// binance and okx agree with each other; yahoo sits ~31 off them and ~44 off the venue. The same
// split is in the bars (1h closes: plus500 4294.5 / binance 4285.1 / okx 4284.95 vs yahoo 4312.9).
// Yahoo Gold is a FUTURES series; the desk trades spot. On the open Gold short that "fix" flipped the
// 2xATR trailing stop to a HIT that did not exist - a phantom exit on the wrong instrument.
//
// The conservative repair already shipped: the venue of record wins, fresh or stale, and a substitute
// is used only when the venue of record has NO tick at all, flagged priceSubstituted. That is correct
// but blunt - during a plus500 outage it uses NOBODY, even though binance/okx are ~13 points away.
//
// WHAT THIS MODULE ADDS: a MEASURED comparability verdict, per (symbol, venue) pair, from the desk's
// own stored bar history. It cannot be decided from a venue preference order - yahoo is SECOND in
// VENUE_ORDER, so no reordering fixes it - and it cannot be decided from one price, because a single
// difference has two completely different causes that need opposite responses:
//
//   CONSTANT OFFSET  - a stable gap that does NOT move. That is a different instrument or a different
//                      basis (futures vs spot, a ratio, a different contract month). It will NEVER
//                      converge, and averaging it away would be trading a price that does not exist.
//   DIVERGENCE       - scatter AROUND the reference. That is timing, staleness or microstructure, and
//                      it does converge.
//
// So the verdict is two-dimensional: the MEDIAN says whether there is a level gap, and the DISPERSION
// AROUND THAT MEDIAN says whether the gap is stable. Reporting only one of them is how "yahoo is 44
// points off" and "yahoo is a different instrument" got confused in the first place.
//
// PURE: takes series as data, returns a verdict. No DB, no clock, no network. The measurement script
// (temp/measure-venue-comparability.js) reads the desk's bars and calls this.
'use strict';

const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

// Relative difference in basis points: how far `a` sits from the reference `b`.
const bps = (a, b) => (b ? ((a - b) / b) * 10000 : null);

function median(xs) {
  const v = xs.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Linear-interpolated quantile. q in [0,1].
function quantile(xs, q) {
  const v = xs.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!v.length) return null;
  const pos = (v.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

// Pair two series on their bar time. Inner join: only buckets BOTH venues have.
// Returns [[refClose, otherClose], ...] in ascending time.
//
// TWO DETAILS THAT ARE EASY TO GET WRONG, both found by running this against the real store:
//   1. THE COLUMN IS closePrice, NOT close (trading/store/bars.js barViolation uses openPrice /
//      closePrice). Reading `close` yields undefined for EVERY row, which aligns to ZERO pairs and
//      looks exactly like "these venues never overlap" - i.e. it fails as a silent empty result.
//      An empty alignment must therefore be reported as insufficient_data, never as comparable.
//   2. NOT EVERY VENUE IS HOUR-ALIGNED. plus500_chart / binance / okx sit on :00, but yahoo's bars
//      land anywhere in the hour (measured minutes 0..47). An exact-timestamp join silently drops
//      yahoo entirely, which is the venue this check most needs to judge.
// So timestamps are floored to a BUCKET (default one hour).
function align(ref, other, { timeKey = 'barStart', valueKey = 'closePrice', bucketMs = 3600000 } = {}) {
  const bucket = (v) => {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? Math.floor(t / bucketMs) * bucketMs : NaN;
  };
  const byTime = new Map();
  for (const r of ref || []) {
    const t = bucket(r[timeKey]);
    const c = Number(r[valueKey]);
    if (Number.isFinite(t) && Number.isFinite(c)) byTime.set(t, c);
  }
  const rows = [];
  for (const o of other || []) {
    const t = bucket(o[timeKey]);
    const b = Number(o[valueKey]);
    if (!Number.isFinite(t) || !byTime.has(t) || !Number.isFinite(b) || b === 0) continue;
    rows.push([t, byTime.get(t), b]);
  }
  return rows.sort((x, y) => x[0] - y[0]).map(([, a, b]) => [a, b]);
}

// The verdict.
//
// THRESHOLDS ARE THE OWNER'S CALL, which is why they are parameters with documented defaults rather
// than constants. The measured facts they have to be set against: a Gold round trip is 11.9 bps, and
// binance/okx sat ~30 bps off the venue - i.e. ABOVE the round trip, so "close enough to substitute"
// is genuinely not settled by this measurement alone. assess() reports the numbers and names the
// verdict; it does not pretend the tolerance is a technical question.
const DEFAULTS = {
  maxMedianBps: 5,      // |median gap| at or under this = same level
  maxDispersionBps: 15, // p90 of |diff - median| at or under this = a stable relationship
  minPoints: 50,        // below this, say so rather than guessing
};

function assess(pairs, opts = {}) {
  const t = { ...DEFAULTS, ...opts };
  const diffs = (pairs || []).map(([a, b]) => bps(a, b)).filter(Number.isFinite);
  const common = { points: diffs.length, thresholds: t };
  if (diffs.length < t.minPoints) {
    return {
      ...common, comparable: false, verdict: 'insufficient_data',
      medianBps: round2(median(diffs)), p90AbsBps: null, residualP90Bps: null,
      reason: `only ${diffs.length} overlapping bars (need ${t.minPoints}) - not enough to say anything`,
    };
  }
  const med = median(diffs);
  const p90Abs = quantile(diffs.map(Math.abs), 0.9);
  // dispersion AFTER removing the level gap: this is what separates a different instrument
  // (stable offset, tiny residual) from a stale/misaligned feed (large residual).
  const residualP90 = quantile(diffs.map((d) => Math.abs(d - med)), 0.9);
  const absMed = Math.abs(med);
  const levelOk = absMed <= t.maxMedianBps;
  const stable = residualP90 <= t.maxDispersionBps;

  // FOUR STATES, not two, and the split was DRIVEN BY THE MEASUREMENT. The first version collapsed
  // everything non-comparable into "divergent ... reads as timing/staleness", which was flatly wrong
  // for Gold/yahoo: a -117 bps MEDIAN is a level gap no amount of alignment removes, and calling it
  // staleness would have been the same confusion that caused the original incident. Measured
  // 2026-09-15 from the desk's own 1h closes (reference plus500_chart):
  //     Gold/yahoo   median -116.84 bps, residual 108.43  -> level_gap_with_scatter
  //     Oil/yahoo    median   -3.67 bps, residual  66.37  -> scatter_only  (same instrument, badly aligned)
  // Same venue, opposite diagnosis, and only the two-dimensional test can tell them apart.
  let verdict; let reason;
  if (levelOk && stable) {
    verdict = 'comparable';
    reason = `tracks the reference within ${t.maxMedianBps} bps (median ${round2(med)} bps, residual p90 ${round2(residualP90)})`;
  } else if (!levelOk && stable) {
    verdict = 'level_gap_stable';
    reason = `a STABLE ${round2(med)} bps level gap (residual only ${round2(residualP90)} bps) - the signature of a different instrument or basis, and it will not converge`;
  } else if (!levelOk && !stable) {
    verdict = 'level_gap_with_scatter';
    reason = `a ${round2(med)} bps LEVEL gap AND ${round2(residualP90)} bps of scatter - the level gap dominates, so treat this as a different instrument until proven otherwise`;
  } else {
    verdict = 'scatter_only';
    reason = `the LEVEL matches (median ${round2(med)} bps) but residual p90 is ${round2(residualP90)} bps - that is timing/staleness, not a different instrument`;
  }

  return {
    ...common,
    comparable: levelOk && stable,
    medianBps: round2(med),
    p90AbsBps: round2(p90Abs),
    residualP90Bps: round2(residualP90),
    levelOk, stable,
    verdict,
    reason,
  };
}

// Convenience: is this venue safe to use as a FALLBACK for this symbol?
//
// NOTE (B4): `comparable` is the DESCRIPTIVE verdict — it answers "is this the same instrument?" against
// the module's own 5/15 bps dials, which are conventions, not costs. A substitute also has to be worth
// using, and that question is answered by `admit()`. They are deliberately not the same function: the
// first is a fact about the pair, the second is a decision about money.
// ⚠ RENAMED 2026-09-22 (TRD-69) FROM `usableAsFallback`. The old name was a TRAP: it asks a question
// about MONEY while implementing a FACT ABOUT THE PAIR — which is precisely the conflation the comment
// two lines up disclaims. It is never called in production (`quant.pickTick` takes its allowlist from
// `venueAdmission.resolve()`, which goes through `admit()`), so a future caller reaching for the obvious
// "can I use this venue as a fallback?" helper would have silently received the DESCRIPTIVE 5/15 bps
// answer instead of the round-trip-derived admission decision — and the two disagree: on the 2026-09-22
// measurement NOT ONE pair is `comparable`, while `admit()` admits 9 of 47 pairs on the derived budget.
// Nothing calls it today, so this is zero-risk; the name is fixed before something does.
const isSameInstrument = (assessment) => !!(assessment && assessment.comparable);

// ── ADMISSION: the number that is DERIVED rather than chosen (B4) ────────────────────────────────────
//
// The 2026-09-15 review settled the tolerance question by REFUSING to answer it as a tolerance:
//   "do not pick the number, derive it — a substitutable venue must have residual bias below the
//    round-trip cost, because otherwise the substitution costs more than it saves."
//
// So there is no admit threshold anywhere below this line. The threshold is the symbol's OWN round-trip
// cost, read from the same cost model the backtester charges (`agent/backtest.costCfgFor`), and a
// candidate is admitted only when the error it would import is STRICTLY BELOW that.
//
// WHY THE CHARGE IS p90 OF |diff|, NOT JUST THE RESIDUAL. `assess()` reports two numbers because they
// need opposite responses; the same split decides what a substitute COSTS:
//   * a LEVEL gap (|median|) is charged IN FULL unless the caller explicitly corrects it, because
//     `pickTick` does not add an offset. Charging only the residual would admit "a different instrument
//     that happens to be stable" — the yahoo-Gold failure, one honest-looking subtraction away.
//   * the RESIDUAL p90 is what no offset can remove, so it is the only thing charged once the caller
//     commits to applying the offset — and `admit()` RETURNS the offset it must apply, so the flag
//     cannot be set without knowing what it commits to.
// Uncorrected -> charge p90|diff|. Corrected -> charge residual p90. One budget for both.
//
// NO COST BASIS => NOT ADMITTED. A missing round-trip cost must fail closed: "we could not find the
// cost" is not "the cost is zero", and `Number(null) === 0` is precisely the coercion that would turn an
// absence into the most permissive possible budget. That trap has now appeared three times in this
// codebase, so it is guarded by an explicit absent-value check rather than a numeric one.
const num = (v) => (v == null || v === '' ? NaN : Number(v));

// The symbol's round-trip cost in bps, from the cost model's own config. `cfdSpreadPct` and
// `cfdSlippagePct` are PER SIDE and in PERCENT, so a round trip is 2 x (spread + slip) and percent -> bps
// is x100. Checked against the calibration of record: Gold 2 x (0.0097 + 0.05) x 100 = 11.94 bps,
// Oil 17.28, Bitcoin 25.00 - which is the 0.119% / 0.173% / 0.250% the evidence doc quotes.
function roundTripBpsFromCfg(cfg) {
  const spread = num(cfg && cfg.cfdSpreadPct);
  const slip = num(cfg && cfg.cfdSlippagePct);
  if (!Number.isFinite(spread) || !Number.isFinite(slip)) return null;
  return round2(2 * (spread + slip) * 100);
}

// One candidate in, one decision out. Fail-closed on every branch, and every branch explains itself.
function admit(assessment, { roundTripBps, correctOffset = false } = {}) {
  const budget = num(roundTripBps);
  const base = {
    budgetBps: Number.isFinite(budget) ? round2(budget) : null,
    correctOffset: !!correctOffset,
  };
  // One shape for every branch, including the refusals: a caller that reads `residualP90Bps` off an
  // admission must not have to know which branch produced it (and must not get `undefined`).
  const nothing = (code, reason) => ({
    ...base, admitted: false, admissibleWithOffset: false, code, reason,
    chargedBps: null, headroomBps: null, needsOffset: false, offsetBps: null, dominant: null,
    residualP90Bps: null, levelGapBps: null, points: null, verdict: null,
  });

  if (!Number.isFinite(budget) || budget <= 0) {
    return nothing('no_cost_basis',
      'no round-trip cost for this symbol - an error cannot be shown to sit below a cost we do not know');
  }
  if (!assessment || assessment.verdict === 'insufficient_data') {
    return nothing('insufficient_data',
      'no comparable history for this pair - an unmeasured venue is not an admitted one');
  }
  const residual = num(assessment.residualP90Bps);
  const levelGap = num(assessment.medianBps);
  const absP90 = num(assessment.p90AbsBps);
  if (!Number.isFinite(residual) || !Number.isFinite(levelGap) || !Number.isFinite(absP90)) {
    return nothing('unmeasured', 'the assessment carries no usable error figure');
  }

  const needsOffset = !assessment.levelOk;
  const offsetBps = needsOffset ? levelGap : null;
  const charged = correctOffset ? residual : absP90;
  const headroom = round2(budget - charged);
  const admitted = charged < budget;
  // Naming which of the two dominates is diagnostic only - it does not change the charge, and it uses
  // no threshold. The comparison is between the two measured quantities themselves.
  const dominant = Math.abs(levelGap) >= residual ? 'level_gap' : 'scatter';

  // Not admitted as-is, but a STABLE offset plus a residual inside budget means an offset-corrected
  // caller would be safe. Kept separate from `admitted` on purpose: `pickTick` does not add offsets, so
  // a conditional answer must never be consumable as an unconditional one.
  const fixable = !admitted && !correctOffset && assessment.stable && residual < budget;

  let code; let reason;
  if (admitted) {
    code = 'admitted';
    reason = `imports ${round2(charged)} bps of error against a ${round2(budget)} bps round trip - ${headroom} bps of headroom`;
  } else if (fixable) {
    code = 'admissible_with_offset';
    reason = `not usable as-is: ${round2(charged)} bps charged against ${round2(budget)} bps, with ${dominant === 'level_gap' ? 'the level gap' : 'scatter'} dominant. It IS stable (residual ${round2(residual)} bps, inside budget${offsetBps != null ? `, offset ${round2(offsetBps)} bps` : ''}), so a caller that explicitly applies the offset would be safe - pickTick does not, so this is not an admission`;
  } else if (!correctOffset && needsOffset && !assessment.stable) {
    code = 'level_gap_unstable';
    reason = `a ${round2(levelGap)} bps level gap WITH ${round2(residual)} bps of scatter - the dominant part cannot be removed by an offset and the residual is not inside a ${round2(budget)} bps round trip. A different instrument until proven otherwise`;
  } else {
    code = 'residual_exceeds_budget';
    reason = `the ${dominant === 'level_gap' ? `level gap (${round2(levelGap)} bps)` : `scatter (residual ${round2(residual)} bps)`} is the dominant error and the charge ${round2(charged)} bps is not below the ${round2(budget)} bps round trip - substituting costs more than it saves`;
  }

  return {
    ...base, admitted, admissibleWithOffset: fixable, code, reason,
    chargedBps: round2(charged), headroomBps: headroom,
    // what the caller is being asked to apply, and what it costs: the level gap it must remove, and the
    // residual it cannot. Returned so the correction is never done from memory. `needsOffset` is true
    // only for the conditional case - an admission that is contingent on work the caller has not done
    // must not read as settled.
    needsOffset: fixable && needsOffset,
    offsetBps: round2(offsetBps), residualP90Bps: round2(residual), levelGapBps: round2(levelGap),
    points: assessment.points, verdict: assessment.verdict, dominant,
  };
}

// Convenience over a whole candidate set: [{ symbol, venue, pairs, roundTripBps }] -> rows + the one line
// the report and the wiring both quote. `admitted` is the strict list (what pickTick may use); the
// offset-conditional ones are named separately so a reader cannot conflate the two.
function admissionTable(candidates = [], opts = {}) {
  const rows = (candidates || []).map((c) => {
    const assessment = c.assessment || assess(c.pairs, opts.assess || {});
    return { symbol: c.symbol, venue: c.venue, assessment, ...admit(assessment, { roundTripBps: c.roundTripBps, correctOffset: opts.correctOffset }) };
  });
  return {
    rows,
    admitted: rows.filter((r) => r.admitted).map((r) => ({ symbol: r.symbol, venue: r.venue })),
    withOffset: rows.filter((r) => r.admissibleWithOffset).map((r) => ({ symbol: r.symbol, venue: r.venue, offsetBps: r.offsetBps })),
  };
}

// The sentence the review asked for: which venues the derivation actually admits. "Nobody" is a result.
function admitLine(table) {
  const a = (table && table.admitted) || [];
  const w = (table && table.withOffset) || [];
  const fmt = (x) => `${x.symbol}/${x.venue}${x.offsetBps != null ? ` (+${x.offsetBps} bps offset)` : ''}`;
  return a.length
    ? `admitted: ${a.map(fmt).join(', ')}${w.length ? ` · admitted only with an applied offset: ${w.map(fmt).join(', ')}` : ''}`
    : `admitted: NOBODY${w.length ? ` (admitted only with an applied offset, which pickTick does not apply: ${w.map(fmt).join(', ')})` : ''}`;
}

// How many venues survive at each candidate tolerance - the sensitivity view the owner needs to pick
// one. Reported rather than assumed, because the answer changes with the tolerance.
function sensitivity(byVenue, tolerances = [5, 10, 15, 30, 50]) {
  const out = [];
  for (const tol of tolerances) {
    const pass = Object.entries(byVenue || {})
      .filter(([, pairs]) => assess(pairs, { maxMedianBps: tol, maxDispersionBps: Math.max(tol * 2, 15) }).comparable)
      .map(([v]) => v);
    out.push({ tolMedianBps: tol, venues: pass });
  }
  return out;
}

module.exports = {
  DEFAULTS, bps, median, quantile, align, assess, isSameInstrument, sensitivity,
  num, roundTripBpsFromCfg, admit, admissionTable, admitLine,
};
