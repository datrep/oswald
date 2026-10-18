// trading/agent/strategies/survGoldStruct.js — S3: the structure-gated clone of the Gold survivor.
//
// ★ THE HYPOTHESIS, AND IT IS THE ONLY THING THIS CANDIDATE EXISTS TO TEST (design doc §12 S3):
//
//        does a structure gate improve the win rate on this signal?
//
// Its CONTROL is its ungated sibling `survgold` — same instrument, same frozen turtle parameters, same
// signal. The gate is the single difference, which is what makes the comparison mean anything at all. A
// candidate that differed in two ways would answer nothing (§10 Q3).
//
// ★ THE PREDICATE WAS CHOSEN BY MEASUREMENT, NOT PREFERENCE.
// `trading/scripts/repro/gate-predicate-screen.js` screened three candidates against the 110 entries
// `survgold` itself produces on Gold's 1,139 chart bars, on the question a filter must answer before it is
// worth testing at all — HOW OFTEN DOES IT BIND? A gate that blocks 2% cannot show an effect at n >= 50; one
// that blocks 96% has thrown the signal away and is testing a different strategy.
//
//   (a) direction agrees          blocks 35%  <- CHOSEN
//   (b) BOS agrees, lag <= L      blocks 36%, and (a)&(b) allowed 70 of 70: DOMINATED — it adds no
//                                 information to (a). Its `lag <= L` is also INERT: identical at L=3, L=10
//                                 and unbounded, because `bos` at an entry bar is almost always the current
//                                 bar. It would have registered a parameter that does nothing.
//   (c) no sweep against, lag<=L  31% at L=3 vs 55% at L=10 — the answer is set by an un-derived L.
//   (d) not premium/discount      blocks 96% — 4 surviving entries is not an experiment.
//
// ★ AND THE PREDICATE CARRIES NO NEW PARAMETER. `direction` is derived from the already-registered `k=4`.
// That matters because `d`, `r` and the OTE band are still un-derived; adding to that debt in the same step
// as the hypothesis would make the two unfalsifiable together.
//
// ★ EXITS ARE NEVER GATED (the TRD-71 rule). The gate decides whether a position may be OPENED. A gate that
// could refuse a trailing stop would trap a position in order to prove a point about eligibility.
'use strict';

const turtle = require('./turtleUltimate');
const { computeStructure } = require('../structure');

// The survivors' frozen set, copied EXACTLY from survGold. This candidate must differ from its control in
// ONE way; anything that differs here would silently make it a different strategy and void the comparison.
const FROZEN = { donchianPeriod: 20, adxPeriod: 14, adxGate: 0, atrPeriod: 14, atrStopMultiple: 2, riskPerTradePct: 1 };

// ★ THE PRE-REGISTRATION, AS CODE (design doc §14). Declared 2026-09-23 BEFORE any candidate was registered or
// scored, so a later reader can tell whether a result was obtained under the REGISTERED set or a convenient one.
// `test/s3-preregistration.test.js` pins every value here AND the structure engine's own DEFAULTS; changing
// either fails a test. That is the point — a pre-registration that can drift silently is not a pre-registration,
// and this desk has already had one invalidated by a later change (TRD-72).
const SENSITIVITY_GRID = Object.freeze({
  k: [3, 4, 5, 6],                    // the k-flip is a known input to this grid (§10 Q4)
  d: [1.0, 1.5, 2.0],
  r: [1.0, 1.5, 2.0],
  n: [10, 20, 30],
  ote: [[0.62, 0.79], [0.618, 0.786], [0.5, 0.88]], // the FIRST is the primary: a grid that omits its own
  // primary cannot say whether the primary is a lucky cell. The first two differ only by ROUNDING (the engine
  // defaults are the rounded form), so that pair is a rounding check rather than a sensitivity axis — the third
  // is the genuinely different band.
  // The predicates the binding-rate screen ELIMINATED (§12). They are run as DIAGNOSTICS so the grid can answer
  // a different question from "does the gate work": is the finding specific to (a), or would any filter do?
  altPredicates: ['bos_agrees', 'no_sweep_against'],
});

// ★ THE PREDICATE, deliberately ONE comparison. `range` is excluded BY CONSTRUCTION (it equals neither
// direction), which is why there is no separate "and not range" clause: the screen measured `range` at 0 of
// 110 entries, and a branch that cannot fire reads like cover.
function structureAgrees(structure, direction) {
  const want = direction === 'buy' ? 'bullish' : 'bearish';
  return !!structure && structure.state === 'ok' && structure.direction === want;
}

// ★ THE LAB'S SERIES AND THIS ENGINE SPEAK DIFFERENT FIELD NAMES, and it is not cosmetic.
//
//   `backtest.loadSeries` produces  { open, high, low, close, time }   (backtest.js:401)
//   `computeStructure` reads        openPrice / high / low / closePrice / barStart
//
// Wiring the gate straight onto the lab series would have read `closePrice` as undefined on EVERY bar, so
// every structure result would have been `NaN`-driven and the gate would have failed CLOSED on every trade.
// The candidate would have reported ZERO trades and that would have looked like a finding — "the gate
// suppresses everything" — rather than a field-name mismatch. Normalising explicitly is what stops that.
function toStructureBars(series) {
  return (series || []).map((b) => ({
    barStart: b.barStart || b.time,
    openPrice: b.openPrice !== undefined ? b.openPrice : b.open,
    high: b.high,
    low: b.low,
    closePrice: b.closePrice !== undefined ? b.closePrice : b.close,
  }));
}

// ★ THE REGISTERED PARAMETERS MUST BE THE PARAMETERS THAT RUN (2026-09-23).
//
// `computeStructure` called with no `params` uses the ENGINE'S DEFAULTS. The candidate row carries a `params`
// blob and `scoreCandidate` merges that blob into `cfg` — so without this, the row's numbers would be a RECORD
// OF INTENT while the gate quietly ran on whatever `structure.js` DEFAULTS happened to be. That is the
// recorded-vs-actual mismatch this project keeps finding, and it is worst in this exact place: **a
// pre-registration whose numbers are not the numbers that ran is not a pre-registration.**
//
// Only DEFINED numeric keys are forwarded. `{ k: undefined }` would NOT fall back to the default —
// `{ ...DEFAULTS, ...{ k: undefined } }` sets `k` to undefined and the engine then throws on `k < 1`.
const STRUCTURE_PARAM_KEYS = [
  'k', 'd', 'r', 'n', 'm', 'eqHi', 'eqLo', 'oteLow', 'oteHigh', 'atrPeriod', 'minBars', 'sweepLookback',
];

function structureParamsFrom(cfg) {
  const out = {};
  for (const key of STRUCTURE_PARAM_KEYS) {
    const v = cfg && cfg[key];
    if (v !== undefined && v !== null && Number.isFinite(Number(v))) out[key] = Number(v);
  }
  return Object.keys(out).length ? out : null; // null means "the engine's own DEFAULTS"
}

// The gate as it is applied in the BACKTEST: structure at the last CLOSED bar before the crossing bar.
// The same convention the live path uses — `quant` passes `asOf = structBars.length - 2`, i.e. the bar
// before the forming bar that is making the crossing. Keeping the two on one convention is §7 rule 4.
function gateAt(series, i, direction, params = null) {
  if (!Number.isInteger(i) || i < 1) return false;
  try {
    const s = computeStructure({ bars: toStructureBars(series), asOf: i - 1, params: params || undefined });
    return structureAgrees(s, direction);
  } catch {
    return false; // FAILS CLOSED — see the header of `liveSignal` below
  }
}

module.exports = {
  // ★ LOWERCASE, matching every other registered id (`regturtle`, `mtftrend`, `survgold`). The FILE is
  // camelCase because that is the filename convention; the ID is lowercase because it is a key people type
  // and because `lab/gate.js` lowercases it before lookup — a camelCase id would make `UNCOVERED` and the
  // registry disagree unless the comparison were also loosened, and loosening a comparison to accommodate a
  // new key is how two spellings of one thing start.
  id: 'survgoldstruct',
  name: 'Turtle · Gold survivor A + structure gate (S3 candidate)',
  description: 'S3 hypothesis test. CONTROL = survgold (ungated) on the same instrument and the same frozen turtle parameters; the ONLY difference is that an entry must agree with market structure direction. Not promoted: measured on the lockbox first.',
  // TRACK-BOUND, exactly like its control. A Gold-tuned frozen set may never evaluate another instrument
  // (the 2026-09-11 scope-leak fix).
  symbols: ['Gold'],
  DEFAULTS: { ...FROZEN },
  params: [], // frozen — the control is a frozen survivor, so its clone must be frozen too
  paramsWith: turtle.paramsWith,

  // ★ FAILS CLOSED. No structure, or not enough history, means NO TRADE. For a candidate whose whole purpose
  // is to be MEASURED, refusing to act on what cannot be measured is the only honest default — and it is the
  // opposite of the fail-open guards this desk has been burned by (obv on a zero-volume series, the venue
  // floor falling back to a stale equity). The cost is real and is the first thing to check in the results:
  // a gate that abstains too often does not trade enough to be judged.
  liveSignal: (ctx) => {
    const r = turtle.liveSignal({ ...ctx, params: { ...(ctx && ctx.params), ...FROZEN } });
    if (!r || r.type !== 'entry') return r; // EXITS PASS THROUGH UNGATED
    return structureAgrees(ctx && ctx.structure, r.direction)
      ? r
      : { type: null, donchian: r.donchian, gated: 'structure_disagrees' };
  },

  // The SAME predicate in the same loop that decides the entry, rather than a post-filter on the trade list
  // — filtering outcomes would gate the RESULT instead of the DECISION and could not reproduce live.
  backtest: (series, cfg, lab) => turtle.backtest(series, { ...cfg, ...FROZEN }, lab, {
    entryFilter: ({ bars, i, direction }) => gateAt(bars, i, direction, structureParamsFrom(cfg)),
  }),

  // Exported for the tests and for the pre-registration record.
  structureAgrees,
  gateAt,
  toStructureBars,
  structureParamsFrom,
  STRUCTURE_PARAM_KEYS,
  SENSITIVITY_GRID,
};
