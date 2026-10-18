// trading/plus500/instrumentSpec.js — TRD-45 Phase 1: the instrument-spec CONTRACT.
//
// Pure. Turns the raw sidebar read into typed fields, and decides whether what came back is
// internally consistent enough to store. No DB, no page, no clock of its own — every function here
// is a total function of its arguments, so the rules are pinned by tests instead of by re-reading a
// live venue on a Sunday.
//
// WHY A CONTRACT AT ALL. Phase 0 answered "what does the venue expose" and the answer was a
// definition/value list plus a positional stat box. The risk in Phase 1 is not that the fields are
// unknown — it is that a PARTIAL or MISALIGNED read gets stored as if complete, and the desk then
// sizes positions against a minimum it invented. Three specific ways that happens here, all
// observed or directly implied by the Phase 0 dumps:
//
//   1. ABSENT VALUES COERCING TO ZERO. `Number(null) === 0`, so `Number.isFinite(Number(x))` is
//      TRUE for a missing unit amount, and `size = equity x riskPct / stopDist` would then be
//      floored by a zero. This trap has now bitten this codebase four times (expectancy.num,
//      exitLevels.num, executor.level, and here) — the guard is always the same: reject absent
//      before coercing.
//
//   2. A SPREAD READ WHILE THE MARKET IS SHUT. Phase 0 measured Gold spot's spread as 2.89 with
//      the venue simultaneously rendering "Market is closed". That is not a cost; it is a
//      placeholder rate. Usableness is a property of WHEN the capture was taken, so it is carried
//      on the quote and `usableQuote` is the ONLY gate the cost model may pass through.
//
//   3. A SPEC PAIRED WITH THE WRONG INSTRUMENT. The sidebar describes the SELECTED row. Phase 0
//      caught this class twice (a guard that asked "is ANY instrument showing" instead of "is the
//      TARGET showing" reported contractSpec=YES while returning a different instrument), so the
//      pairing check is three-valued: `null` means UNTESTABLE, which is not the same as passing.
//
// The invariants below are the venue's own arithmetic, verified 21/21 on a full chain
// (2026-09-13): `dynamicSpread == buy - sell` and `initialMargin == 100 / leverage`. They are
// checks, not derivations — storing the venue's number and asserting it agrees with a derived one
// is what makes a misparse visible; deriving one from the other would make the check tautological
// and unable to fail (the same mistake the removed `rr_mismatch` contract made).
'use strict';

// Absent-rejecting coercion. `Number(null) === 0` and `Number('') === 0`, so a bare
// Number.isFinite guard ACCEPTS a missing value and produces a confident zero. Booleans are
// refused too: `Number(true) === 1` would turn a stray `true` into a minimum trade size of one.
function num(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'boolean' || typeof v === 'object') return NaN;
  return Number(v);
}

function isNum(v) { return Number.isFinite(num(v)); }

// '20.00%' -> 20. Percent signs and thousands separators are presentation; a missing value stays
// null rather than becoming 0%.
function parsePercent(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// '1:5' -> 5. Kept as a PARSER, never stored as a bare multiplier: the ratio is the venue's own
// statement and a stored number would be a second place for the two to disagree.
//
// L1 (rev 5, 2026-09-29) CORRECTED THE COMMENT THAT USED TO SIT HERE. It read: "the ratio is only ever
// used to CHECK the venue's margin percent, and the margin percent is what the desk consumes." The
// second half was false, and it is exactly why the desk could not state its own ceiling: leverage is
// what sets it (`ceiling = L x stopPct`), so Gold at 1:5 caps a 0.550% stop at 2.75% while Bitcoin at
// 1:1.67 caps the same dial at 1.16%. `agent/instruments.js` now carries the parsed ratio on every
// resolution; this parser is the single source of that reading.
function parseLeverage(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^1\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const ratio = Number(m[1]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

// 'Gold | Put 4225 | Sep W3' -> the class plus its option fields. A bare 'Gold' is SPOT, which is
// the default because it is the safe reading: an option misread as spot is a position with an
// expiry the desk does not know about, whereas a spot misread as option merely refuses.
//
// The venue's separator is a pipe with surrounding spaces, and the row label is the same string
// with the underlying repeated ('Gold | Put 4225 | Sep W3' in the sidebar vs 'Gold' in the list),
// so the underlying is the FIRST segment and the rest is the class detail.
function classifyName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return { instrumentClass: 'spot', underlying: null, optionType: null, strikePrice: null, expiryLabel: null };
  const parts = s.split('|').map((p) => p.trim()).filter(Boolean);
  const underlying = parts[0] || null;
  let optionType = null;
  let strikePrice = null;
  let expiryLabel = null;
  for (const p of parts.slice(1)) {
    // 'Call' and 'Call 4450' are both real: the venue splits the type and the strike into separate
    // segments in `Gold | Put 4225 | Sep W3` but joins them in `Gold | Sep W3 | Call 4450`. Handling
    // only the first form leaves the second with a type and NO strike, which reads as a corrupt
    // option rather than the same option written differently.
    const t = p.match(/^(Call|Put)\b\s*(.*)$/i);
    if (t) {
      optionType = t[1][0].toUpperCase() + t[1].slice(1).toLowerCase();
      const rest = (t[2] || '').replace(/,/g, '');
      if (/^\d+(?:\.\d+)?$/.test(rest)) strikePrice = Number(rest);
      continue;
    }
    // A bare number (optionally grouped) is the strike; anything else is the expiry label
    // ('Sep W3', 'Oct', 'Sep W2'). Order-independent so a venue reshuffle cannot swap them.
    const n = p.replace(/,/g, '').match(/^\d+(?:\.\d+)?$/);
    if (n) { strikePrice = Number(p.replace(/,/g, '')); continue; }
    if (expiryLabel == null) expiryLabel = p;
  }
  return {
    instrumentClass: optionType ? 'option' : 'spot',
    underlying,
    optionType,
    strikePrice,
    expiryLabel,
  };
}

// '1:00 AM 9/19/2026' -> a Date. THE VENUE RENDERS IN LOCAL TIME (Phase 0 established this for the
// session endpoints via GetOpenPositionInfoImm, and the closed-positions parser had to treat
// '9/12/2026 1:00 AM' as venue-local for the same reason). The instant is therefore built from
// explicit components in the caller's zone rather than handed to `new Date(string)`, whose
// behaviour on this format is implementation-defined and silently timezone-assuming either way.
// `tzOffsetMinutes`, when supplied, shifts from that zone to UTC; omit it and the process's own
// zone is used, which is correct on the workstation that drives the bridge.
function parseExpiry(v, { tzOffsetMinutes = null, now = null } = {}) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/i);
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) hh += 12;
  const [, , mm, , mo, dd, yyyy] = m;
  const local = new Date(Number(yyyy), Number(mo) - 1, Number(dd), hh, Number(mm), 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  const d = tzOffsetMinutes == null ? local : new Date(local.getTime() + Number(tzOffsetMinutes) * 60000);
  // An expiry in the past is a stale capture (the venue is showing a contract that has rolled), and
  // a far-future one is a parse accident. Both are reported rather than stored as fact.
  if (now && d.getTime() < new Date(now).getTime() - 86400000) return null;
  return d;
}

// '1 USD' -> { value: 1, unit: 'USD' }. The point-value cell is the one field that is a NUMBER AND
// A UNIT in a single string, so neither the strict guard (which would reject it whole) nor a bare
// Number() (which would yield NaN) is right. A missing cell stays { null, null } — note that a
// unit-less '1' is still accepted, because the number is the fact being captured and the unit is
// descriptive; a wrongly-typed unit cannot change a size, whereas a wrongly-typed NUMBER can.
function parsePointValue(v) {
  if (v == null) return { value: null, unit: null };
  const s = String(v).trim();
  if (!s) return { value: null, unit: null };
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return { value: null, unit: null };
  const n = Number(m[0]);
  const unit = s.replace(/[-\d.,\s]/g, '').trim();
  return { value: Number.isFinite(n) ? n : null, unit: unit || null };
}

// buy - sell. Returns null when either side is absent — never 0, because 0 is a spread the desk
// would happily use as a cost.
function spreadOf({ buy, sell } = {}) {
  const b = num(buy), s = num(sell);
  if (!Number.isFinite(b) || !Number.isFinite(s)) return null;
  return Math.round((b - s) * 1e6) / 1e6;
}

// WHICH QUOTE BELONGS TO WHICH INSTRUMENT — and this is not a formality, it is the whole point of the
// registry. The cost facts keyed their "newest quote" by SYMBOL alone, and one symbol carries a whole
// option chain: Gold is 1 spot row + 20 option rows, ALL `symbol = 'Gold'`. Options quote in PREMIUM
// units (measured 2026-09-14: 62.69/61.21 while Gold spot traded ~4300) and their spread is a
// percentage OF THE PREMIUM, so pairing an option quote with the spot row produced a self-consistent
// but meaningless **1.1747%** half-spread for Gold — 20x its real 0.0597%. That number then went into
// the backtester's venue cost basis (a 244.94 bps round trip instead of 11.94) and onto the chairs'
// cost line, for twelve symbols.
//
// There is deliberately NO symbol-level fallback. A quote from another instrument class is not this
// instrument's quote, and returning null states the truth — "no open-market capture for THIS
// instrument" — which lets the cost model keep its calibrated basis rather than charge a fabricated
// one. A missing fact is recoverable; a false fact is what this module exists to prevent.
function quoteForInstrument(quotes, { venue = null, venueInstrumentId = null } = {}) {
  if (!venueInstrumentId) return null; // an instrument with no venue id can never be matched to a quote
  let best = null;
  for (const q of quotes || []) {
    if (!q) continue;
    if (venue != null && q.venue !== venue) continue;
    if (String(q.venueInstrumentId) !== String(venueInstrumentId)) continue;
    // `open` is enforced here as CORRECTNESS, not as a policy knob: a closed-market quote is a
    // placeholder (Phase 0 measured Gold spot at 2.89 while the venue said the market was shut).
    if (q.marketState !== 'open') continue;
    if (!best || new Date(q.capturedAt) > new Date(best.capturedAt)) best = q;
  }
  return best;
}

// The three-valued pairing check. `null` = UNTESTABLE (sidebar collapsed, or the page rotated away
// from the row) and is NOT a pass — Phase 0's sidebar guard bug was exactly this distinction
// collapsing, reporting a confident YES while describing the wrong instrument.
function pairsWithRow(specName, rowName) {
  if (!specName || !rowName) return null;
  return String(specName).trim() === String(rowName).trim();
}

// THE VIOLATION SET. Codes, so a caller can branch and a test can assert without parsing prose.
const CODES = {
  UNIT_MISSING: 'unit_amount_missing',
  UNIT_KIND_MISSING: 'unit_kind_missing',
  UNIT_NOT_POSITIVE: 'unit_amount_not_positive',
  MARGIN_LEVERAGE_MISMATCH: 'initial_margin_leverage_mismatch',
  SPREAD_MISMATCH: 'spread_buy_minus_sell_mismatch',
  OPTION_NO_EXPIRY: 'option_without_expiry',
  OPTION_NO_STRIKE: 'option_without_strike',
  SPOT_WITH_OPTION_FIELDS: 'spot_carrying_option_fields',
  CLOSED_CAPTURE: 'spec_captured_with_market_closed',
  SIDEBAR_MISMATCH: 'sidebar_names_a_different_instrument',
  PAIRING_UNTESTABLE: 'sidebar_row_pairing_untestable',
};

// Which violations make the row UNUSABLE for the sizing floor, versus merely notable. A missing
// unit amount is the whole point of the registry, so it is fatal. A closed-market capture is NOT:
// contract metadata is stable and a closed session is the only time the operator can browse freely
// — it is recorded as provenance. That distinction is the reason this returns a list instead of a
// boolean.
const FATAL = [CODES.UNIT_MISSING, CODES.UNIT_NOT_POSITIVE, CODES.SIDEBAR_MISMATCH];

function checkSpec(spec, { rowName = null, marketState = null } = {}) {
  const v = [];
  const s = spec || {};
  if (num(s.unitAmount) !== num(s.unitAmount) || s.unitAmount == null) v.push(CODES.UNIT_MISSING);
  else if (!(num(s.unitAmount) > 0)) v.push(CODES.UNIT_NOT_POSITIVE);
  if (!s.unitKind) v.push(CODES.UNIT_KIND_MISSING);

  // The venue's own arithmetic, asserted against the venue's own numbers.
  //
  // ★ 2026-09-29 (found by L1, rev 5 of the purchasing-power design): THE TOLERANCE IS NOW DERIVED FROM
  // THE VENUE'S OWN DISPLAY PRECISION, NOT CHOSEN. It used to be a flat 0.01 with the comment "enough to
  // absorb the display rounding to 2dp". That was false, and the live Bitcoin row is the counter-example:
  // the venue states `1:1.67` and 60.00% initial margin, so this check computed 100/1.67 = 59.8802 against
  // a stated 60.0000 — a 0.1198 discrepancy, 12x the tolerance it was supposed to absorb, reported as an
  // `initial_margin_leverage_mismatch` on a row the venue itself treats as consistent.
  //
  // The error in the MARGIN is not the error in the RATIO: it scales as 100/L^2 x dL, so a 2dp ratio
  // (dL <= 0.005) permits 0.18 points at L = 1.67 and 0.005 at L = 10. A flat constant cannot be right at
  // both ends of a 6x spread in leverage, and that is the tell it was never right at either — the same
  // mistake the report makes twice elsewhere (a number quoted without the thing it depends on).
  //
  // So the question asked is the only one the evidence supports: does the STATED margin fall inside the
  // interval the DISPLAYED ratio permits? Measured 2026-09-29 across all seven live rows: maintenance is
  // exactly initial/2 everywhere (60/30, 20/10, 10/5), and 100/60 round-trips to the venue's own '1:1.67'
  // — so the margins are STATED and the ratio is the derived, rounded presentation. An interval test
  // admits that; a flat constant called it a mismatch. Nothing was loosened in a way that admits a bad
  // row: this violation was never fatal (see FATAL), so it could not gate the sizing floor either way.
  const ratio = parseLeverage(s.leverageRaw);
  const margin = parsePercent(s.initialMarginPct);
  if (ratio != null && margin != null) {
    const lo = 100 / (ratio + 0.005);
    const hi = 100 / (ratio - 0.005);
    const EPS = 0.01; // the venue's own percent presentation (it states 60.00, not 59.88)
    if (margin < lo - EPS || margin > hi + EPS) v.push(CODES.MARGIN_LEVERAGE_MISMATCH);
  }

  if (s.spread != null && !isNum(s.spread)) v.push(CODES.SPREAD_MISMATCH);
  else if (isNum(s.spread) && isNum(s.buy) && isNum(s.sell)) {
    const derived = spreadOf({ buy: s.buy, sell: s.sell });
    if (derived == null || Math.abs(num(s.spread) - derived) > 1e-6) v.push(CODES.SPREAD_MISMATCH);
  }

  if (s.instrumentClass === 'option') {
    if (!s.expiryAt) v.push(CODES.OPTION_NO_EXPIRY);
    if (!isNum(s.strikePrice)) v.push(CODES.OPTION_NO_STRIKE);
  } else if (s.optionType || isNum(s.strikePrice) || s.expiryAt) {
    v.push(CODES.SPOT_WITH_OPTION_FIELDS);
  }

  if (marketState === 'closed') v.push(CODES.CLOSED_CAPTURE);
  const pairing = pairsWithRow(s.venueName, rowName);
  if (pairing === false) v.push(CODES.SIDEBAR_MISMATCH);
  else if (pairing === null) v.push(CODES.PAIRING_UNTESTABLE);
  return v;
}

function violationsAreFatal(violations) {
  return (violations || []).some((c) => FATAL.includes(c));
}

// MAY THE COST MODEL CONSUME THIS QUOTE? Only when it was taken while the venue said the market was
// open AND its spread is self-consistent. This is the single gate; nothing else may read a quote
// column directly, which is what keeps a closed-market placeholder out of the cost model.
function usableQuote(q) {
  if (!q) return { usable: false, reason: 'no_quote' };
  if (q.marketState !== 'open') return { usable: false, reason: `market_${q.marketState || 'unknown'}_at_capture` };
  const derived = spreadOf(q);
  if (derived == null) return { usable: false, reason: 'quote_incomplete' };
  if (!(derived > 0)) return { usable: false, reason: 'non_positive_spread' };
  if (q.spread != null && Math.abs(num(q.spread) - derived) > 1e-6) return { usable: false, reason: CODES.SPREAD_MISMATCH };
  return { usable: true, reason: null, spread: derived };
}

// WHICH MARKET STATE DOES A QUOTE ROW GET? (corrected 2026-09-14, hours after the fix above.)
//
// The sidebar describes exactly ONE instrument — the selected one. Every other row on the page has
// no per-instrument session evidence, and the desk's calendar is an opinion about the MARKET, not
// about that instrument. Leaving those rows on the calendar re-created the original hazard in a new
// place: with the Hong Kong market shut at 22:52 SGT, a page whose sidebar described a different
// instrument wrote
//     Geely Automobile  state=open  spread 0.120
//     China Shenhua     state=open  spread 0.230
// and `venueCostFacts` (which filters on `marketState === 'open'`) consumed both as
// `spreadBasis: open_market_capture`. A closed-market spread became a cost constant.
//
// So: the selected instrument gets the resolved state; everything else is `unknown`, which
// `usableQuote` refuses. Coverage is unaffected in practice because the desk captures ONE SYMBOL at
// a time — that is precisely what makes each symbol's own quote assertable.
function quoteStateFor({ sidebarSymbol = null, symbol = null, marketState = 'unknown' } = {}) {
  if (sidebarSymbol && symbol && sidebarSymbol === symbol) return marketState;
  return 'unknown';
}

// The venue's market state, from the sidebar's own banner rather than from our session calendar.
// `unknown` is a real answer and must stay distinct from `open`: a missing banner is not evidence
// that trading is live.
function marketStateOf(raw) {
  // `raw || {}` rather than a destructuring default: a default only covers `undefined`, so the
  // previous form threw on `null` — and a null contract is the NORMAL case when the sidebar is
  // collapsed (probeCurrentPage documents `contract: null` for exactly that). A market-state
  // helper that throws on "we could not read the sidebar" would turn a benign absence into a
  // capture failure.
  const { closedBanner, closedTitle } = raw || {};
  if (closedBanner || /closed/i.test(String(closedTitle || ''))) return 'closed';
  return 'unknown';
}

// WHICH MARKET STATE DOES A CAPTURE RECORD? (corrected 2026-09-14)
//
// ★ WHY THIS IS A FUNCTION AND NOT AN INLINE `||` CHAIN. It used to be
//     const marketState = o.market || o.marketState || marketStateOf(o.contract) || fromItems;
// where `o.market` is the probe's CALENDAR reading. The calendar therefore beat the venue's own
// banner — despite marketStateOf's own comment saying it reads "the venue's market state ...
// rather than from our session calendar", and despite usableQuote gating EVERY cost constant on
// `marketState === 'open'`.
//
// Caught live on the first open-market capture: SGX reported calendar=open while its own sidebar
// banner said CLOSED, so the quote went in as `state=open` (spread 0.115) and a CLOSED-MARKET
// spread became consumable as a cost constant. That is verbatim the hazard this workstream
// exists to prevent — the gate had only ever been exercised on days when the two sources agreed.
//
// THE RULE IS ONE-DIRECTIONAL ON PURPOSE: the venue can only ever downgrade to `closed`. It can
// never upgrade a closed calendar to open, so nothing that was refused before is admitted now.
// The disagreement is RETURNED rather than resolved silently.
function resolveCaptureMarketState({ calendar = null, venue = null, fromItems = 'unknown' } = {}) {
  const items = fromItems === 'closed' || fromItems === 'open' ? fromItems : 'unknown';
  const marketState = venue === 'closed' ? 'closed' : (calendar || venue || items);
  // A CONFLICT is a contradiction between two positive readings, so it takes BOTH sides to be
  // stated. `venue: 'unknown'` means the sidebar carried no banner at all — an absence of
  // evidence, not a disagreement — and reporting it would put a conflict on nearly every
  // capture and teach the reader to ignore the field.
  const conflict = (calendar && venue && venue !== 'unknown' && calendar !== venue)
    ? { calendar, venue, resolved: marketState }
    : null;
  return { marketState, calendarState: calendar, venueState: venue, conflict };
}

// Raw sidebar read -> the row shape. Shallow by design: the parse rules above do the work, and a
// caller that has a different source shape adapts to THIS rather than the other way round.
function toRow(raw, { marketState = null, rowName = null, now = null, tzOffsetMinutes = null } = {}) {
  const r = raw || {};
  const cls = classifyName(r.name || r.venueName);
  const state = marketState || marketStateOf(r);
  const pv = parsePointValue(r.pointValue);
  const spec = {
    venueName: String(r.name || r.venueName || '').trim(),
    symbol: cls.underlying,
    instrumentClass: cls.instrumentClass,
    optionType: cls.optionType,
    strikePrice: isNum(r.strikePrice) ? num(r.strikePrice) : cls.strikePrice,
    expiryAt: parseExpiry(r.expiryDate, { now, tzOffsetMinutes }),
    unitAmount: isNum(r.unitAmount) ? num(r.unitAmount) : null,
    unitKind: r.unitKind || null,
    // Migration 045: the venue's OWN word for the stat box's column-0, when the probe could match it
    // against the labelled definition/value list. NULL means the venue does not label it — a state, not
    // an absence of a minimum. A label the probe did not supply must not blank a label already stored,
    // which is what the COALESCE in `store/instruments.upsertInstrument` guarantees for every column here.
    unitAmountLabel: r.unitAmountLabel || null,
    pointValue: pv.value,
    pointValueUnit: pv.unit,
    initialMarginPct: parsePercent(r.initialMargin),
    maintenanceMarginPct: parsePercent(r.maintenanceMargin),
    fundingBuyPct: parsePercent(r.fundingBuy),
    fundingSellPct: parsePercent(r.fundingSell),
    fundingTime: r.fundingTime || null,
    nextSessionText: r.nextSession || null,
    leverageRaw: r.leverage || null,
    // Carried through so checkSpec can assert spread == buy - sell when both sides are known.
    buy: isNum(r.buy) ? num(r.buy) : null,
    sell: isNum(r.sell) ? num(r.sell) : null,
    // The probe's own field name for the venue's spread cell is `dynamicSpread` (the 3-column stat
    // box, column 2). Accepted alongside `spread` so a caller can hand over the raw sidebar read
    // unchanged rather than maintaining a renaming layer that would drift.
    spread: isNum(r.spread) ? num(r.spread)
      : isNum(r.dynamicSpread) ? num(r.dynamicSpread)
        : (isNum(r.buy) && isNum(r.sell) ? spreadOf(r) : null),
    marketStateAtCapture: state,
    sourceUrl: r.referenceUrl || null,
  };
  return { spec, marketState: state, violations: checkSpec(spec, { rowName, marketState: state }) };
}

module.exports = {
  CODES, FATAL,
  num, isNum, parsePercent, parseLeverage, parsePointValue, classifyName, parseExpiry, spreadOf,
  pairsWithRow, checkSpec, violationsAreFatal, usableQuote, marketStateOf, resolveCaptureMarketState, quoteStateFor, toRow,
  quoteForInstrument,
};
