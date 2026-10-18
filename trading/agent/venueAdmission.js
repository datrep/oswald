'use strict';
// trading/agent/venueAdmission.js — C3 / B4 (2026-09-15).
//
// MAY A TICK FROM ANOTHER VENUE STAND IN FOR THE VENUE OF RECORD? This module answers that with DATA,
// so the price path never has to make a judgement call: `quant.pickTick` receives an `allowedVenues`
// list and applies it mechanically, including the case where the list is EMPTY.
//
// WHY THIS IS NOT A TOLERANCE. The 2026-09-15 review refused the tolerance framing: "do not pick the
// number, derive it — a substitutable venue must have residual bias below the round-trip cost, because
// otherwise the substitution costs more than it saves." So there is no admit threshold in this file.
// The threshold is each symbol's OWN round-trip cost, read from the same cost model the backtester
// charges (`backtest.costCfgFor` -> `venueComparability.roundTripBpsFromCfg`), and a venue is admitted
// only when the error it would import is STRICTLY BELOW that. Gold's round trip is 11.94 bps; Bitcoin's
// is 25.00. Identical prices therefore produce DIFFERENT verdicts for Gold and Bitcoin — which is the
// whole point, and is asserted as a test rather than merely intended.
//
// THE FOUR STATES, and why each one has to be distinct:
//   * flag off            -> `resolve()` returns `null` and touches NOTHING, not even the database. A
//     feature that is off must not change a single price, and "off" must not be indistinguishable from
//     "measured and found empty" — the first leaves pickTick ungated, the second gates it shut.
//   * gated, `allowed: []`-> substitutes are REFUSED. This is the measured answer for Gold and Oil, and
//     it has to refuse rather than fall through to the old any-fresh-venue rule, because that rule is
//     exactly the bug this replaced (yahoo "Gold" is a different instrument - see pickTick's notes).
//   * gated, `allowed: [v]`-> only those venues may substitute.
//   * `unavailable: true` -> the measurement could not be taken. FAILS CLOSED, i.e. it behaves as
//     `allowed: []`, because "we could not measure it" is not evidence that substituting is safe. It is
//     also NOT cached: a transient read failure must not blind the gate for the whole TTL.
//
// WHY THE VERDICT IS CACHED. The measurement reads stored bars for every candidate venue of a symbol,
// and it sits on the price path. It changes on the timescale of the microstructure, not of a wake, so a
// TTL (default 6h, `settings.venueComparability.ttlHours`, 0 = measure every time) is the right shape.

const vc = require('./venueComparability');
const backtest = require('./backtest');
const { VENUE_DEFAULT } = require('../store/instruments');

const DEFAULT_TTL_HOURS = 6;
const TIMEFRAME = '1h';
// Enough hourly bars to satisfy `minPoints` with room to spare, and cheap enough to read per wake.
const BAR_LIMIT = 4000;

// `enabled` is compared with `=== true` deliberately. This flag decides whether a price may come from a
// venue the desk does not trade at, and `"false"`, `"no"` and `1` are all truthy strings/numbers that
// would switch it on. A settings round-trip through JSON is exactly how a boolean becomes a string.
function configFrom(settings) {
  const raw = (settings && settings.venueComparability) || {};
  const ttl = Number(raw.ttlHours);
  return {
    enabled: raw.enabled === true,
    ttlHours: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_TTL_HOURS,
  };
}

// Is the candidate the venue of record under another feed name? The live coverage has BOTH `plus500`
// and `plus500_chart` for Gold, and `plus500_chart` is the same broker's chart capture, not a second
// venue. Treating it as a substitute would let a plus500 bar "replace" a plus500 tick — the same
// instrument from the same source, admitted for agreeing with itself, which is the one comparison that
// can never be evidence. Compared on the venue family (`<ref>` or `<ref>_suffix`).
function sameVenue(candidate, reference) {
  const c = String(candidate || '');
  const r = String(reference || '');
  if (!c || !r) return false;
  return c === r || c.startsWith(`${r}_`);
}

// ── the decision, PURE (no IO) ───────────────────────────────────────────────────────────────────
// `seriesByVenue` is { venue: bars[] } with the reference venue included, because a comparison needs
// both sides. Returns the allowlist `pickTick` consumes AND the evidence for why each venue is or is
// not on it, so a wake can state the refusal instead of leaving a reader to re-derive it from bars.
function admissionFor({ symbol = null, reference = null, seriesByVenue = {}, roundTripBps = null, correctOffset = false } = {}) {
  const refSeries = (reference && seriesByVenue[reference]) || [];
  const candidates = [];
  for (const venue of Object.keys(seriesByVenue || {})) {
    // A venue is not a substitute for itself, in either of its feed names.
    if (!venue || sameVenue(venue, reference)) continue;
    candidates.push({ symbol, venue, pairs: vc.align(refSeries, seriesByVenue[venue]), roundTripBps });
  }
  const table = vc.admissionTable(candidates, { correctOffset });
  const budget = vc.num(roundTripBps);
  return {
    reference,
    correctOffset: !!correctOffset,
    // The derived threshold, reported next to the verdicts. `null` means NO COST BASIS, which is a
    // refusal and not a zero budget - the absent-vs-zero trap this repo has hit three times.
    roundTripBps: Number.isFinite(budget) ? budget : null,
    table,
    allowed: table.admitted.map((r) => String(r.venue)),
    evidence: table.rows.map((r) => ({ venue: r.venue, code: r.code, chargedBps: r.chargedBps, budgetBps: r.budgetBps })),
    line: vc.admitLine(table),
  };
}

// ── the measurement, with the TTL ────────────────────────────────────────────────────────────────
const cache = new Map();
function clearCache() { cache.clear(); }

// deps: { store, coverage, reference, now } — injected by tests; production passes nothing.
async function resolve(userId, symbol, settings, deps = {}) {
  const cfg = configFrom(settings);
  // OFF: return before any read. `null` is what pickTick means by "not gated".
  if (!cfg.enabled) return null;

  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const reference = String(deps.reference || VENUE_DEFAULT);
  const key = `${userId}|${symbol}|${reference}`;
  const hit = cache.get(key);
  const fresh = hit && now - hit.at >= 0 && now - hit.at < cfg.ttlHours * 3600000;
  if (fresh) return { ...hit.value, cached: true };

  const store = deps.store || require('../store');
  try {
    const coverage = deps.coverage || (await store.barsCoverage(userId));
    const venues = [];
    for (const row of coverage || []) {
      if (!row || !row.venue) continue;
      if (String(row.symbol) !== String(symbol)) continue;
      // Bars on another timeframe are a different measurement; mixing 1d into an hourly alignment
      // produces pairs at a cadence the residual was never measured at.
      if (String(row.timeframe || TIMEFRAME) !== TIMEFRAME) continue;
      // The reference venue and its other feeds are not substitutes — see `sameVenue`.
      if (sameVenue(row.venue, reference)) continue;
      if (!(Number(row.bars) > 0)) continue;
      if (!venues.includes(String(row.venue))) venues.push(String(row.venue));
    }

    const seriesByVenue = {};
    seriesByVenue[reference] = (await store.listBars(userId, { symbol, venue: reference, limit: BAR_LIMIT, timeframe: TIMEFRAME })) || [];
    for (const venue of venues) {
      seriesByVenue[venue] = (await store.listBars(userId, { symbol, venue, limit: BAR_LIMIT, timeframe: TIMEFRAME })) || [];
    }

    // The budget is DERIVED from the cost model the backtester charges, never passed in as a number.
    // `deps.costCfg` exists so a test can pin the cost model instead of asserting against whatever the
    // venue basis happens to hold at the moment the test runs.
    const costCfg = (deps.costCfg || backtest.costCfgFor)(symbol);
    const decided = admissionFor({
      symbol, reference, seriesByVenue,
      roundTripBps: vc.roundTripBpsFromCfg(costCfg),
    });

    const value = {
      enabled: true, unavailable: false, symbol, reference,
      allowed: decided.allowed,
      evidence: decided.evidence,
      line: decided.line,
      roundTripBps: decided.roundTripBps,
      referenceBars: seriesByVenue[reference].length,
      candidates: venues,
      ttlHours: cfg.ttlHours,
      measuredAt: new Date(now).toISOString(),
    };
    cache.set(key, { at: now, value });
    return { ...value, cached: false };
  } catch (e) {
    // Fail closed, and do NOT cache: see the four-states note at the top.
    return {
      enabled: true, unavailable: true, symbol, reference,
      allowed: [], evidence: [], cached: false,
      reason: String((e && e.message) || e).slice(0, 160),
    };
  }
}

module.exports = {
  DEFAULT_TTL_HOURS, TIMEFRAME, BAR_LIMIT,
  configFrom, sameVenue, admissionFor, resolve, clearCache,
};
