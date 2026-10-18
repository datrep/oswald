// trading/agent/spreadDerivation.js — TRD-79: a symbol's half-spread, DERIVED from the desk's own
// two-sided tick history instead of curated by hand.
//
// WHY THIS EXISTS. `CALIBRATED_SPREAD_HALF_PCT` (backtest.js) has 12 entries, so `costCfgFor` answers
// `{ costModelVersion: 'v1-flat' }` for everything else — no spread, no slippage, therefore
// `roundTripBpsFromCfg` → null, `admit()` → `no_cost_basis`, venue REFUSED. The refusal itself is
// correct (a missing cost must fail closed — `Number(null) === 0` would be the most permissive budget
// possible), but for ~90 symbols it is a BOOKKEEPING refusal and not a measurement, and a gate that is
// permanently shut for a bookkeeping reason reads as "we checked and it is unsafe" — a different and
// false claim. This module lets a symbol earn a budget from its own captured ticks.
//
// ⚠ THREE WAYS TO GET THIS WRONG. Each was measured on the desk's own data (2026-09-21), each is
// guarded here, and the first is the expensive one.
//
// 1. A SINGLE-SIDED FEED DERIVES A ZERO SPREAD — the MOST PERMISSIVE BUDGET POSSIBLE.
//    Measured over 7 days of PriceTicks: `yahoo` 4,431 ticks of which 4,431 have `ask == bid` (its
//    REST quote is a single MID price), `plus500` 17,087 of which 5,159 are flat, `okx` and `binance`
//    fully two-sided. plus500's flat rows are ALL `source='position_poll'`; the 11,928 two-sided ones
//    are `plus500_frontend`. A p75 over a mid-only feed is 0.00000% → a 0.00 bps round trip → every
//    venue admitted on a cost of ZERO. That is the `Number(null) === 0` failure this repo has paid for
//    four times, arriving through a new door. So: TWO-SIDED ROWS ONLY, from a QUOTE source, and a feed
//    with no usable row is REFUSED with the counts that prove which feed it was (guard 1).
//
// 2. THE HALF-DIVISOR / UNIT. `cfdSpreadPct` is a HALF-spread (as % of price, per side), so the
//    quantity is `(ask - bid) / 2 / mid * 100`. A FULL spread is 2x that, and the two are
//    indistinguishable in a column of small numbers. The first measurement of TRD-79 used the full
//    spread and reported "the curated table is twice the derived value"; `reproductionVerdict` below is
//    the check that caught it, and it is EXPORTED so the harness and the tests share the same test
//    rather than each re-deriving it (guard 2).
//
// 3. VENUE. The provider venues are a DIFFERENT MARKET, not a cheaper one: measured 2.77x apart
//    (Gold/okx) to 11,475x (Bitcoin/binance) against the desk's reference. A derivation is scoped to
//    the venue the desk TRADES; rows from another venue are EXCLUDED AND COUNTED rather than averaged
//    in, and a feed built only from them is refused (guard 3).
//
// ⚠ AND WHAT THIS IS NOT: a SPREAD is not a ROUND TRIP. The budget is
// `roundTripBpsFromCfg = 2 x (spread + slip) x 100`; this module covers the spread term ONLY, so its
// result must be composed with the slippage term by that function and never used as a budget directly.
// Every result therefore carries `covers: 'spread_only'` and `unit: 'half_spread_pct_per_side'`, and
// NO result here is ever expressed in bps — a bps number that is not a round trip is exactly the value
// that would loosen venue admission, the net-edge screen and the TRD-114 cost ceiling at once.
//
// READ-ONLY and PURE: no DB handle, no clock, no settings. A caller passes rows; a caller stores the
// result (see `instruments.seedDerivedSpreadBasis`).
'use strict';

// What the returned number IS. Carried on every result so a consumer cannot read a half-spread as a
// round trip (or vice versa) without contradicting a field that says otherwise.
const UNIT = 'half_spread_pct_per_side';
const COVERS = 'spread_only';

// The venue whose ticks may set a budget: the one the desk trades. Named here rather than imported from
// the instrument registry so this module stays pure; the seeder passes the registry's own default.
const DESK_VENUE = 'plus500';

// Which `PriceTicks.source` values are QUOTES (two-sided) rather than POSITION READS (single price).
// Evidence: the 5,159 flat plus500 rows are all `position_poll`; the 11,928 two-sided ones are
// `plus500_frontend`. A source outside this list is excluded and counted, never silently included —
// and a feed offering only excluded sources is refused with the breakdown, so adding a new source is a
// visible decision rather than a quiet change of what a budget means.
const QUOTE_SOURCES = ['plus500_frontend'];

// A p75 over three ticks is not a p75. The curated table's own samples were "n>=100 for the lab
// symbols; the extras are thin samples" and it treats thinness as a caveat — so this floor exists to
// make thinness a REFUSAL with the count attached instead of a number someone will paste into a gate.
const MIN_TWO_SIDED = 30;

const DEFAULT_WINDOW_DAYS = 14;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round6 = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);

// P75, NEAREST RANK — deliberately the same estimator as `temp/verify-79-derivation.js`, the harness
// that reproduced the curated table 7/7. An interpolating percentile would return a slightly different
// number for the same rows, and then the reproduction check below would be comparing two estimators
// rather than two bases.
function p75(values) {
  const s = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(0.75 * s.length))];
}

// One row -> the half-spread as a percentage of the mid, per side. `null` when the row is not a
// usable two-sided quote: absent, non-positive, INVERTED (ask < bid), or flat (ask == bid) — a value
// that is not strictly positive is not a spread, and returning the signed arithmetic here would put a
// negative "spread" in reach of a gate. NOTE the divisor: `/2/mid`, not `/mid` — guard 2.
function halfSpreadPct(bid, ask) {
  const b = num(bid);
  const a = num(ask);
  if (b == null || a == null || b <= 0 || a <= 0) return null;
  if (a <= b) return null;
  const mid = (a + b) / 2;
  if (!(mid > 0)) return null;
  const half = ((a - b) / 2 / mid) * 100;
  return half > 0 ? half : null;
}

// The row-level classification, exported so a census can report the SAME buckets the derivation uses
// (a report that counts differently from the gate is a report that cannot explain the gate).
function classifyRow(t, { venue = DESK_VENUE, sources = QUOTE_SOURCES } = {}) {
  if (!t) return { kind: 'malformed', why: 'empty row' };
  const v = t.venue == null ? null : String(t.venue);
  if (v !== String(venue)) return { kind: 'other_venue', venue: v };
  const src = t.source == null ? '(none)' : String(t.source);
  if (sources && !sources.includes(src)) return { kind: 'not_a_quote_source', source: src };
  const b = num(t.bid);
  const a = num(t.ask);
  if (b == null || a == null || b <= 0 || a <= 0) return { kind: 'malformed', why: 'bid/ask absent or non-positive' };
  // `ask == bid` is a single-MID feed: not a zero spread, NO spread. `ask < bid` is not a quote either
  // (ingest refuses it as cheapViolation 'ask_lt_bid', so seeing one here means a writer bypassed that).
  if (a < b) return { kind: 'flat', why: 'ask < bid' };
  if (a === b) return { kind: 'flat', why: 'ask == bid (single-sided / mid feed)' };
  const half = halfSpreadPct(b, a);
  if (half == null) return { kind: 'malformed', why: 'no computable half-spread' };
  return { kind: 'two_sided', half };
}

// ONE symbol's derivation. `ticks` is a row list; grouping is the caller's job (see deriveSpreadBasis).
function deriveHalfSpread(ticks, opts = {}) {
  const venue = opts.venue == null ? DESK_VENUE : String(opts.venue);
  const sources = opts.sources == null ? QUOTE_SOURCES : opts.sources;
  const minTwoSided = num(opts.minTwoSided) == null ? MIN_TWO_SIDED : num(opts.minTwoSided);
  const rows = Array.isArray(ticks) ? ticks : [];

  const excludedBySource = {};
  const excludedByVenue = {};
  let flat = 0;
  let malformed = 0;
  const halves = [];
  for (const t of rows) {
    const c = classifyRow(t, { venue, sources });
    if (c.kind === 'other_venue') { const k = c.venue || '(none)'; excludedByVenue[k] = (excludedByVenue[k] || 0) + 1; continue; }
    if (c.kind === 'not_a_quote_source') { excludedBySource[c.source] = (excludedBySource[c.source] || 0) + 1; continue; }
    if (c.kind === 'malformed') { malformed += 1; continue; }
    if (c.kind === 'flat') { flat += 1; continue; }
    halves.push(c.half);
  }

  const base = {
    venue,
    windowDays: num(opts.windowDays),
    unit: UNIT,
    covers: COVERS,
    sources: sources ? [...sources] : null,
    rows: rows.length,
    twoSided: halves.length,
    flat,
    malformed,
    excludedBySource,
    excludedByVenue,
    minTwoSided,
  };

  if (!halves.length) {
    // The refusal has to say WHICH it was: a structurally single-sided feed (yahoo), a feed whose only
    // rows are position reads, or simply nothing stored. All three derive "no spread"; only two of them
    // would derive a zero one if the guard were absent.
    const reason = flat ? 'single_sided_feed'
      : Object.keys(excludedBySource).length ? 'no_quote_source_rows'
        : Object.keys(excludedByVenue).length ? 'no_rows_at_desk_venue'
          : 'no_usable_ticks';
    return { ok: false, reason, halfPct: null, ...base };
  }
  if (halves.length < minTwoSided) {
    return { ok: false, reason: 'below_min_sample', halfPct: null, ...base };
  }
  const halfPct = round6(p75(halves));
  return {
    ok: true,
    halfPct,
    // Carried for display only, so a reader can SEE that the half and the full differ by exactly 2x
    // instead of having to remember which one the column was. Never consumed as a basis.
    fullPct: round6(halfPct * 2),
    ...base,
  };
}

// THE UNIT TEST THAT CAUGHT MY OWN 2x ERROR, kept where both the harness and the test can call it.
// `curated` is `CALIBRATED_SPREAD_HALF_PCT[symbol]`, `derived` is a half-spread from deriveHalfSpread.
function reproductionVerdict(derived, curated) {
  const d = num(derived);
  const c = num(curated);
  if (!(d > 0) || !(c > 0)) return { ratio: null, verdict: 'not_comparable' };
  const ratio = c / d;
  if (ratio > 0.7 && ratio < 1.4) return { ratio, verdict: 'reproduces' };
  // 2x means a FULL spread was compared against a HALF spread; 0.5x is the same error the other way.
  if (Math.abs(ratio - 2) < 0.25) return { ratio, verdict: 'unit_mismatch_2x' };
  if (Math.abs(ratio - 0.5) < 0.1) return { ratio, verdict: 'unit_mismatch_half' };
  return { ratio, verdict: 'differs' };
}

// MANY symbols at once: group by symbol, run the ONE derivation per group, and hand back both the
// consumable map and the census that explains every refusal. The map holds ONLY `ok` results, so a
// refused symbol is ABSENT rather than present-as-zero — absence is how the cost model already spells
// "no basis", and a 0 in this map would be a free trade.
function deriveSpreadBasis(ticks, opts = {}) {
  const rows = Array.isArray(ticks) ? ticks : [];
  const bySymbol = new Map();
  for (const t of rows) {
    const s = t && t.symbol != null ? String(t.symbol) : null;
    if (!s) continue;
    if (!bySymbol.has(s)) bySymbol.set(s, []);
    bySymbol.get(s).push(t);
  }
  const basis = {};
  const results = [];
  const refused = {};
  for (const [symbol, group] of bySymbol) {
    const r = deriveHalfSpread(group, opts);
    results.push({ symbol, ...r });
    if (r.ok) {
      basis[symbol] = { halfPct: r.halfPct, n: r.twoSided, flat: r.flat, windowDays: r.windowDays, venue: r.venue };
    } else {
      if (!refused[r.reason]) refused[r.reason] = [];
      refused[r.reason].push(symbol);
    }
  }
  results.sort((a, b) => b.twoSided - a.twoSided);
  return {
    venue: opts.venue == null ? DESK_VENUE : String(opts.venue),
    windowDays: num(opts.windowDays),
    minTwoSided: num(opts.minTwoSided) == null ? MIN_TWO_SIDED : num(opts.minTwoSided),
    basis,
    results,
    refused,
  };
}

module.exports = {
  UNIT, COVERS, DESK_VENUE, QUOTE_SOURCES, MIN_TWO_SIDED, DEFAULT_WINDOW_DAYS,
  classifyRow, halfSpreadPct, p75, deriveHalfSpread, deriveSpreadBasis, reproductionVerdict,
};
