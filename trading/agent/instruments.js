// trading/agent/instruments.js — TRD-45 Phase 1: resolve a DESK symbol to the VENUE's contract.
//
// WHAT PROBLEM THIS SOLVES. `risk.js` computes `size = equity x riskPct / stopDist` and stops
// there. That formula has no FLOOR: it can return 0.4 units of an instrument whose smallest tradeable
// amount is 15. Phase 0 measured the real spread of minimums on ONE chain — the Gold spot CFD starts
// at 0.025 Troy Ounces while the twenty options around the same underlying start between 1.5 and 15
// "Options". The desk has been sizing against a minimum of zero and a unit of one.
//
// WHY IT VETOES INSTEAD OF RAISING THE SIZE. The tempting fix is "clamp up to the minimum". That
// silently takes MORE risk than `riskPerTradePct` promised — the floor would override the dial the
// owner set, and it would do it precisely on the trades whose stops are so tight that the risk-based
// size came out smallest. A minimum the desk cannot satisfy is a reason not to take the trade, not a
// licence to enlarge it. So: below the floor is a VETO, with both numbers named.
//
// WHAT IT DOES WHEN THE MINIMUM IS UNKNOWN. It allows the trade and says so. The registry starts
// empty, and refusing every entry until a human browses twenty instruments would be a bigger
// intervention than the defect. But an unknown minimum is REPORTED (`venue_minimum_unknown`) and
// carried into the decision log, because the failure mode this whole phase exists to end is a
// missing fact being indistinguishable from a satisfied one (TRD-43).
'use strict';

const registry = require('../store/instruments');
// The one absent-rejecting coercion in this codebase (plus500/instrumentSpec). `Number(null) === 0`
// is the single most repeated defect in this repo — it has now been hit five times — so there is no
// local copy of the guard here to drift from the original. The whole module is required (not just
// `num`) because the capture path reuses the same parse rules the contract does, deliberately: a
// second parser would be a second place for a minimum trade size to be misread.
const spec = require('../plus500/instrumentSpec');
const { num, parseLeverage, parsePercent } = spec;

// L1 (rev 5, 2026-09-29) — THE VENUE'S LEVERAGE IS A FIRST-CLASS RISK INPUT, NOT A FOOTNOTE.
//
// Until now `parseLeverage` was used for exactly one thing: to CHECK that the venue's stated margin
// percent agreed with its stated ratio. The desk never consumed the ratio, and that was the gap. The
// ratio is what turns a stop distance into a maximum admissible risk — `ceiling = L x stopPct` (rev 4's
// finding) — so leverage is what decides whether an ambitious risk dial is reachable at all: Gold at
// L = 5 caps a 0.550% stop at 2.75%, while Bitcoin at L = 1.67 caps it at 1.16%. A desk that does not
// carry `L` cannot state its own ceiling, and a desk that cannot state its ceiling cannot say which
// control decided a size.
//
// READ FROM THE SAME ROW AS THE MINIMUM, and carried on the ABSENT shape too. This module's whole
// discipline is that a caller must not be able to learn one half of the contract without seeing whether
// the other half was known; leverage is now one of those halves, so it is present-and-null rather than
// missing when there is no row.
//
// `leverageRaw` is the venue's own '1:5' string and stays a PARSED ratio, never a stored multiplier —
// the string is the evidence, the number is the reading, and a stored number would be a second place
// for the two to disagree (the cross-check in `initialMarginPct` exists for the same reason).
function venueLeverage(row) {
  const r = row || {};
  return {
    leverage: parseLeverage(r.leverageRaw),
    // The venue's own string, carried as EVIDENCE beside the parsed number — the same discipline as
    // `unitAmountLabel` above. The number is the reading; the string is what the venue actually said,
    // and keeping both is how a misread is catchable without a second capture.
    // ★ (2026-10-01) THE CONTRACT SCALE. `pointValue` converts a RAW QUOTE into instrument currency PER UNIT:
    // Gold is `1.000000` (dollars per ounce), Soybeans is `0.010000` (the quote is in CENTS per bushel). It rides
    // HERE because every return path of `resolve()` already spreads `venueLeverage(...)` — including the failure
    // paths — so one addition reaches the sizing arithmetic without inventing a second channel.
    // ⚠ `1` FOR AN UNKNOWN ROW IS THE IDENTITY, NEVER A ZERO. A `pointValue` of 0 would zero every notional and
    // read as "this instrument is free" — the `Number(null) === 0` trap wearing a multiplier.
    pointValue: Number.isFinite(Number(r.pointValue)) && Number(r.pointValue) > 0 ? Number(r.pointValue) : 1,
    leverageRaw: r.leverageRaw || null,
    initialMarginPct: parsePercent(r.initialMarginPct),
    maintenanceMarginPct: parsePercent(r.maintenanceMarginPct),
  };
}

// L3 (rev 5, 2026-09-29) — THE MARGIN RATE THE VENUE ACTUALLY CHARGES, AND WHICH OF ITS TWO STATEMENTS
// SUPPLIED IT. This is the guard's DENOMINATOR, so it is the one number in the layer that must not be a
// guess.
//
// ⚠ USE `initialMarginPct`, NOT `maintenanceMarginPct`. Measured on the registry, maintenance is exactly
// HALF of initial on every row (60/30, 20/10, 10/5). The venue opens a position against the INITIAL
// requirement, so pricing capacity off the maintenance figure would understate every position by 2x and
// let the book commit twice the margin the guard believes it has.
//
// ⚠ THE STATED PERCENT IS PRIMARY; THE RATIO IS THE FALLBACK ONLY, and the measurement is why. `leverageRaw`
// is a 2dp DISPLAY of the same contract: Bitcoin states `1:1.67` and `60.00%`, and `100/1.67 = 59.8802` —
// 0.12 points adrift of what the venue says, which is 12x the tolerance the old validator allowed. So the
// answer carries `from`, and a report can tell a margin read from the venue's own figure from one derived
// out of its rounded display. `pct: null` is a REAL answer — the caller fails closed on it.
function marginRatePct(floor) {
  const f = floor || {};
  const stated = parsePercent(f.initialMarginPct);
  if (Number.isFinite(stated) && stated > 0) return { pct: stated, from: 'initialMarginPct' };
  const lev = Number(f.leverage);
  if (Number.isFinite(lev) && lev > 0) return { pct: Math.round((100 / lev) * 10000) / 10000, from: 'leverage' };
  return { pct: null, from: null };
}

// L4 (2026-09-29) — THE CEILING: the most risk the venue's leverage permits for a given stop.
//
//     ceiling = L x stopPct        (§5 of the report, and §L3.c's `r_effective = min(r, u x ceiling)`)
//
// It lives here rather than in `risk.js` because it is arithmetic over THE RECORD'S OWN FIELDS, and the pin in
// `test/venue-leverage.test.js` holds those fields to exactly one accessor — so the sizing path never dots into
// the object and `instruments.js` stays the single place that decides what a venue's capacity means. Without
// that pin this would have been written inline as `v.venueFloor.leverage * stopPct`, which is the second reader
// the pin exists to forbid.
//
// ⚠ NULL, NEVER 0. An unread ratio or an unusable stop must produce an ABSENCE: a ceiling of 0% is the claim
// "this instrument permits no risk at all", which is a different and much louder statement than "we could not
// read it" — and at 0% the dial would look unreachable on every symbol.
function ceilingPctFor(floor, stopPct) {
  const lev = Number((floor || {}).leverage);
  const stop = Number(stopPct);
  if (!Number.isFinite(lev) || lev <= 0) return null;
  if (!Number.isFinite(stop) || stop <= 0) return null;
  return Math.round(lev * stop * 10000) / 10000;
}

// PURE. The policy, separated from the read so it is testable without a database.
//
//   unknown === true   -> allow, reason `venue_minimum_unknown` (reported, never silent)
//   size < minUnits    -> veto,  reason `below_venue_minimum`
//   otherwise          -> allow
//
// `minUnits` must be a POSITIVE number to count as known, and that is checked on the VALUE alone.
// There is deliberately no separate `known` flag to disagree with it: an earlier draft accepted one,
// and `{ known: true, minUnits: null }` then fell through every comparison (anything vs NaN is
// false) and returned `above_venue_minimum` — an absent minimum reported as a satisfied floor, which
// is the exact inversion of the truth. `Number(null) === 0` is the same trap wearing a different
// coat, which is why the guard rejects absence before coercing.
function floorVerdict({ size, minUnits, unitKind = null } = {}) {
  const s = num(size);
  const m = num(minUnits);
  const isKnown = Number.isFinite(m) && m > 0;
  if (!isKnown) return { ok: true, reason: 'venue_minimum_unknown', detail: null, minUnits: null, unitKind };
  if (!Number.isFinite(s) || s <= 0) return { ok: true, reason: 'size_unavailable', detail: null, minUnits: m, unitKind };
  if (s < m) {
    return {
      ok: false,
      reason: 'below_venue_minimum',
      detail: `computed ${round4(s)} < venue minimum ${round4(m)}${unitKind ? ` ${unitKind}` : ''}`,
      minUnits: m,
      unitKind,
    };
  }
  return { ok: true, reason: 'above_venue_minimum', detail: null, minUnits: m, unitKind };
}

function round4(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 10000) / 10000 : null; }

// ★★ TRD-EXE-3 (2026-09-30) — THE VENUE'S STEP, WHICH IS NOT MERELY ITS MINIMUM.
//
// `docs/INSTRUMENT_MIRROR.md` §9.2 states that Phase 0 "found `unitAmount` is a **minimum, not a step**,
// so no rounding to a multiple is implemented — inventing a granularity the venue never stated would be
// the same class of error". The desk's own venue mirror falsifies that sentence. Measured 2026-09-30 over
// every position that carries an observed venue size: **32 of 32 were EXACT integer multiples of this
// floor, 0 counterexamples**, and `round(size / floor) * floor` reproduced the venue's held size on
// **28 of 28** divergent rows. A granularity the venue applies on every fill is a granularity the venue
// stated, whatever the sidebar's wording was.
//
// WHAT IT COSTS WHEN IT IS SKIPPED. `Trades.size` is the desk's number and `position_pnl.size` is the
// venue's; they differ on 28 of those 32 rows — median 3.99%, max +100% — and every R in the record
// (`resolvedRiskPct`, the exit tolerance, the cost share of R) is computed from the desk's number.
// #1106 is the worked case: the desk recorded and SENT 10 SGX against a 20-Share floor, the venue held
// 20, and the decision recorded the position as carrying 0.07% of equity while it carried 0.164%.
//
// ⚠ IT IS RISK-NEUTRAL BY CONSTRUCTION, AND THAT IS THE ONLY REASON IT MAY TOUCH A LIVE SIZE. The venue
// already applies this exact function, so the size returned here is the size the venue would have held
// anyway. It changes what the desk RECORDS, never what the desk GETS. A caller that used it to RAISE a
// size toward a floor it had not been granted would be re-implementing the clamp that `acceptVenueFloor`
// gates — so this function is applied only where the floor verdict has already passed, or where the
// caller has already been granted the floor by that dial.
//
// NEVER ZERO. `Math.max(1, ...)` is load-bearing: the nearest multiple of a floor to a size BELOW it is
// 0, and a zero-unit order is not what the venue does — a sub-floor order comes back at ONE step, which
// is what `#1106` and `#1113` both show. Deciding whether a sub-floor size may be SENT at all stays with
// `floorVerdict` / `risk.acceptVenueFloor`; this function only decides what a size already allowed
// settles on.
//
// ABSENCE IS NOT A STEP OF ONE. An unknown floor returns the size UNCHANGED and says `step_unknown`,
// because "we could not read the venue's step" must stay distinguishable from "the venue's step is
// whatever we computed" — the same present-and-null discipline the rest of this module keeps.
function snapToVenueStep(size, minUnits) {
  const s = num(size);
  const m = num(minUnits);
  if (!(Number.isFinite(m) && m > 0)) {
    return { size: Number.isFinite(s) ? s : null, snapped: false, reason: 'step_unknown', steps: null, minUnits: null };
  }
  if (!Number.isFinite(s) || s <= 0) {
    return { size: Number.isFinite(s) ? s : null, snapped: false, reason: 'size_unavailable', steps: null, minUnits: m };
  }
  const rawSteps = s / m;
  const steps = Math.max(1, Math.round(rawSteps));
  const snappedSize = round4(steps * m);
  return {
    size: snappedSize,
    snapped: Math.abs(snappedSize - s) > 1e-9,
    // `half_up` is named rather than left to `Math.round`'s behaviour: the exact-half case is real in this
    // book (#1106 is 0.5 steps and the venue resolved it UP to one step), and a reader of the record should
    // not have to know that JavaScript rounds .5 upward to interpret it.
    reason: Math.abs(steps - rawSteps) < 1e-9 ? 'on_step' : (Math.abs(rawSteps % 1) === 0.5 ? 'half_up' : 'snapped'),
    steps,
    minUnits: m,
  };
}

// The DB-backed resolution. Returns a SPEC-shaped answer, never a bare number, so a caller cannot
// use a minimum without also having seen whether it was known and how old it is.
//
// `instrumentClass` defaults to 'spot' deliberately: an unknown class must resolve to the PLAIN
// instrument, never to an option. An option misread as spot hides an expiry; a spot misread as
// option merely fails to resolve. TRD-36 (class pinning) exists because the venue's own search
// returns option rows for a spot query, so this default is the same instinct applied to sizing.
async function resolve(userId, { venue = registry.VENUE_DEFAULT, symbol, instrumentClass = 'spot', venueInstrumentId = null } = {}) {
  if (!symbol) return { found: false, reason: 'symbol_required', minUnits: null, unitKind: null, instrumentClass: null, ...venueLeverage(null) };

  // AN EXPLICIT VENUE ID WINS, and needs no ambiguity dance: naming the instrument is exactly the
  // disambiguation. This is the only way to size an OPTION, because 20 of them share one symbol.
  if (venueInstrumentId) {
    const byId = await registry.getInstrumentById(userId, { venue, venueInstrumentId });
    if (!byId) return { found: false, reason: 'no_registry_entry', minUnits: null, unitKind: null, instrumentClass, venueInstrumentId, ...venueLeverage(null) };
    return shaped(byId, null);
  }

  // AMBIGUITY IS REFUSED, NOT RESOLVED. The first replay of the real Phase 0 chain caught this: the
  // resolver was asked for `Gold` + `option` and cheerfully returned `Gold | Put 4425 | Sep W3` — an
  // arbitrary one of twenty contracts, with an arbitrary strike and an arbitrary minimum size (2
  // Options), against minimums that range 1.5-15 across the chain. A confident answer picked off an
  // unordered list is worse than no answer, because the desk would size against a contract it never
  // chose. Spot is unaffected: there is exactly one Gold spot CFD.
  const matches = await registry.countInstruments(userId, { venue, symbol, instrumentClass });
  if (matches > 1) {
    return {
      found: false,
      reason: 'ambiguous_matches',
      detail: `${matches} instruments match ${symbol}/${instrumentClass} — name the venueInstrumentId to size against one`,
      matchCount: matches,
      minUnits: null, unitKind: null, instrumentClass, venueInstrumentId: null,
      ...venueLeverage(null),
    };
  }

  const row = await registry.getInstrument(userId, { venue, symbol, instrumentClass });
  if (!row) {
    return {
      found: false,
      reason: 'no_registry_entry',
      minUnits: null,
      unitKind: null,
      instrumentClass,
      venueInstrumentId: null,
      capturedAt: null,
      ...venueLeverage(null),
    };
  }
  return shaped(row, null);
}

// One shape for every successful resolution, so a caller cannot learn the minimum without also
// learning whether it was known and when it was read.
function shaped(row, reason) {
  const min = row.unitAmount == null ? null : Number(row.unitAmount);
  return {
    found: true,
    reason: reason || (Number.isFinite(min) && min > 0 ? null : 'unit_amount_missing'),
    minUnits: Number.isFinite(min) && min > 0 ? min : null,
    unitKind: row.unitKind || null,
    // Migration 045: the venue's own LABEL for the field the minimum was read from, when the probe could
    // match it. Carried on the resolution rather than looked up again, so a caller cannot learn the
    // minimum without also seeing whether the venue ever named it. NULL = the venue does not label it.
    unitAmountLabel: row.unitAmountLabel || null,
    instrumentClass: row.instrumentClass,
    venueInstrumentId: row.venueInstrumentId,
    // Provenance travels with the number: a minimum read during a closed session is still the
    // venue's stated minimum (contract metadata does not move with the session), but how old the
    // read is decides whether to re-read it.
    capturedAt: row.capturedAt || null,
    marketStateAtCapture: row.marketStateAtCapture || null,
    // L1 (rev 5): the venue's capacity, beside the venue's floor. `leverage` is the ratio the ceiling
    // `L x stopPct` is built from; the two margin fields are the venue's own statement of the same
    // number and the level below which it liquidates. All three ride on the resolution rather than
    // being looked up again, so the sizing path cannot use a leverage the resolution did not carry.
    ...venueLeverage(row),
  };
}

// L3 (rev 5, 2026-09-29) — THE OPEN BOOK'S MARGIN RATES, IN ONE READ.
//
// `risk.js` needs one rate per OPEN POSITION. A `Trades` row carries a symbol, a size and a price but NO
// CONTRACT (TRD-OPT-2 has not landed), so the registry is the only place an open position's rate can come
// from — and for a SPOT symbol the registry is unambiguous, which is the case that has to work.
//
// ⚠ ABSENCE IS AN ANSWER, AND IT IS NOT ZERO. A symbol with no registry row, or with more than one spot row
// (the same ambiguity `resolve()` refuses rather than guesses), maps to `null` — never 0 and never a default.
// The caller fails CLOSED on it, and `Number(null) === 0` would turn the guard's worst input into its most
// permissive possible reading, i.e. "this position consumes no margin at all".
//
// Options are excluded by class for exactly the reason `resolve()` needs a venue id to size one: twenty Gold
// option rows share one symbol, so a symbol-keyed lookup cannot name a contract.
async function marginRatesFor(userId, symbols, { venue = registry.VENUE_DEFAULT } = {}) {
  const wanted = [...new Set((symbols || []).map((s) => String(s == null ? '' : s)).filter(Boolean))];
  const out = {};
  if (!wanted.length) return out;
  const rows = await registry.listInstruments(userId, { venue, limit: 2000 });
  const spots = new Map();
  for (const row of rows) {
    if (String(row.instrumentClass || 'spot') !== 'spot') continue;
    const s = String(row.symbol || '');
    if (!wanted.includes(s)) continue;
    const list = spots.get(s) || [];
    list.push(row);
    spots.set(s, list);
  }
  for (const s of wanted) {
    const list = spots.get(s) || [];
    if (list.length !== 1) { out[s] = null; continue; }
    // ★ (2026-10-01) THE CONTRACT SCALE TRAVELS WITH THE RATE, because the caller's two BOOK-WIDE sums need it
    // and these are the very rows that supply the rate. Returning it here costs nothing — the rows are already
    // read — and it keeps `pointValue` on the accessor path rather than letting a caller re-derive it.
    // ⚠ `1` for an unknown row is the IDENTITY: a `pointValue` of 0 would zero every notional and read as "this
    // position consumes no capital", the same permissive-reading defect the margin `null` above exists to stop.
    const lev = venueLeverage(list[0]);
    const pv = Number(lev.pointValue);
    out[s] = { ...marginRatePct(lev), pointValue: Number.isFinite(pv) && pv > 0 ? pv : 1 };
  }
  return out;
}

// One call for the sizing path: resolve, then judge. Kept as a single entry point so risk.js cannot
// accidentally use one half without the other.
async function checkSize(userId, { venue = registry.VENUE_DEFAULT, symbol, instrumentClass = 'spot', venueInstrumentId = null, size } = {}) {
  let res;
  try {
    res = await resolve(userId, { venue, symbol, instrumentClass, venueInstrumentId });
  } catch (e) {
    // A registry read failure must not block trading — but it must be visible as an UNKNOWN, not
    // reported as a satisfied floor.
    return {
      ok: true,
      reason: 'registry_unavailable',
      detail: String(e.message || e).slice(0, 120),
      resolved: null,
    };
  }
  const verdict = floorVerdict({ size, minUnits: res.minUnits, unitKind: res.unitKind });
  return { ...verdict, resolved: res };
}

// Capture a probe/scan observation into the registry. Accepts BOTH shapes the probe produces:
// `scanChain`'s `{ items: [{ instrumentId, name, sell, buy, contract, matched }] }` and a single
// `probeCurrentPage` result carrying `contract` + `rows[]`.
//
// THE ONE REFUSAL: an item whose sidebar pairing is a CONFIRMED mismatch is not stored at all. The
// sidebar describes the row that is selected, so a mismatch means the spec belongs to a different
// instrument — storing it would attach one contract's minimum trade size to another, which is
// worse than storing nothing. Phase 0 hit this class twice (a guard that asked "is ANY instrument
// showing" reported `contractSpec=YES` while returning the wrong instrument), so it is refused on
// the way IN, not caught on the way out. An UNVERIFIABLE pairing (`matched: null`) is stored with
// its violation noted, because the spec itself is still self-consistent.
async function captureFromObservation(userId, obs, { venue = registry.VENUE_DEFAULT } = {}) {
  const o = obs || {};
  // The market state comes from the OBSERVATION first (`market`, as `probeCurrentPage` and `run`
  // write it), then from any item's sidebar banner. Reading only the top-level `contract` block —
  // which a CHAIN SCAN does not have — made the first replay of the real capture record all 21
  // instruments as `unknown` while the fixture plainly said `market: "closed"`, i.e. the capture's
  // provenance was lost precisely where it is the only thing standing between a placeholder spread
  // and a cost constant.
  const fromItems = Array.isArray(o.items)
    ? (o.items.find((it) => it && it.contract && it.contract.closedBanner) ? 'closed' : 'unknown')
    : 'unknown';
  // ★ THE VENUE'S OWN BANNER IS AUTHORITATIVE FOR "CLOSED". See
  // plus500/instrumentSpec.js resolveCaptureMarketState() for the measurement: this used to let
  // the probe's CALENDAR reading beat the venue's sidebar banner, and the first open-market
  // capture recorded SGX as `open` (spread 0.115) while SGX's own banner said CLOSED — a
  // closed-market spread becoming a consumable cost constant, which is the exact hazard
  // usableQuote exists to block. The venue can now only ever DOWNGRADE to closed.
  const resolved = spec.resolveCaptureMarketState({
    calendar: o.market || o.marketState || null,
    venue: spec.marketStateOf(o.contract || {}),
    fromItems,
  });
  const marketState = resolved.marketState;
  const calendarState = resolved.calendarState;
  const venueState = resolved.venueState;
  const marketStateConflict = resolved.conflict;

  // Normalise the two shapes into one list of { instrumentId, rowName, raw, matched }.
  const candidates = [];
  if (Array.isArray(o.items)) {
    for (const it of o.items) {
      if (!it || !it.contract || !it.instrumentId) continue;
      candidates.push({ instrumentId: it.instrumentId, rowName: it.name || null, raw: it.contract, matched: it.matched === true });
    }
  }
  if (o.contract) {
    const sel = (o.rows || []).find((r) => r && r.selected) || null;
    const instrumentId = o.contract.instrumentId || (sel ? sel.instrumentId : null);
    if (instrumentId) {
      candidates.push({
        instrumentId,
        rowName: sel ? sel.name : null,
        raw: o.contract,
        matched: o.sidebarMatchesSelectedRow === true,
      });
    }
  }

  const stored = [];
  const refused = [];
  const violations = [];
  for (const c of candidates) {
    const { spec: row, marketState: state, violations: v } = spec.toRow(c.raw, {
      rowName: c.rowName,
      marketState,
    });
    if (spec.violationsAreFatal(v)) {
      refused.push({ instrumentId: c.instrumentId, venueName: row.venueName, violations: v });
      continue;
    }
    // The venue's own symbol is preferred when the sidebar states one; the name parse is the
    // fallback. They disagree on option rows (`OGSEP26W3P4225` vs `Gold`), and the desk resolves by
    // the UNDERLYING either way, so the parsed name is what sizing looks up.
    const r = await registry.upsertInstrument(userId, {
      ...row,
      venue,
      venueInstrumentId: c.instrumentId,
      symbol: row.symbol || c.raw.symbol,
      marketStateAtCapture: state,
    });
    if (r.ok) stored.push({ instrumentId: c.instrumentId, symbol: row.symbol, instrumentClass: row.instrumentClass, unitAmount: row.unitAmount, unitKind: row.unitKind, violations: v });
    else refused.push({ instrumentId: c.instrumentId, violations: [...v, r.reason] });
  }

  // Quotes: every row that quotes both sides, tagged with WHEN it was taken. A closed-market quote
  // is stored (it is the provenance of the capture) and is never consumable — see usableQuote.
  //
  // ★ WHICH ROWS MAY THE SIDEBAR'S BANNER JUDGE? ONLY THE ONE IT DESCRIBES.
  //
  // The banner is a property of the SELECTED instrument (the sidebar only mounts on selection),
  // but a capture writes a quote for EVERY row on the page. Applying one instrument's banner to
  // all of them was measurably wrong: capturing SGX (banner CLOSED) wrote Gold's quote as
  // `state=closed` at 13:52:17 — a false negative on an unrelated, genuinely-open instrument,
  // which would have made Gold's cost constants unusable. Measured before the scoping fix, in
  // InstrumentQuotes: id 256 Gold|closed (from the SGX/Swire page) sitting directly above
  // id 238 Gold|open (from the Gold page).
  //
  // So the banner is authoritative ONLY for the symbol the sidebar names.
  //
  // ★ AND FOR EVERY OTHER ROW THE HONEST ANSWER IS `unknown`, NOT THE CALENDAR (fixed later the
  // same session). The first version of this scoping left non-selected rows on the calendar, which
  // looked harmless — the scoping at least stopped one instrument's banner poisoning another — but
  // it did not stop the ORIGINAL hazard, it only moved it. Measured, after the per-symbol capture
  // loop had run at 22:52 SGT with the Hong Kong market shut:
  //
  //     Geely Automobile   id 612  state=open  spread 0.120  buy 16.65   14:52:07
  //     China Shenhua      id 586  state=open  spread 0.230  buy 45.53   14:52:03
  //
  // Both were written `open` because they appeared on a page whose SIDEBAR described a different
  // instrument and the desk's calendar said open. `venueCostFacts` filters on `marketState === 'open'`
  // and has no way to tell, so both fed the cost model as `spreadBasis: open_market_capture` — a
  // CLOSED-MARKET spread becoming a cost constant, which is the single thing this registry exists to
  // prevent. It also silently inflated the TRD-50 acceptance: two of the twelve passed on a spread
  // taken while their own market was shut.
  //
  // The calendar is the desk's opinion about the MARKET. It is not evidence about a particular
  // instrument's session, and for any row we did not select we have NO per-instrument evidence.
  // So a non-selected row is recorded `unknown`, and `usableQuote` refuses it. The cost to coverage
  // is nil in practice: the desk captures ONE SYMBOL AT A TIME precisely so that every symbol is the
  // selected one at some point — that is what makes its quote, and only its quote, assertable.
  //
  // RESIDUAL GAP, still open and recorded rather than papered over: the venue exposes no per-row
  // session, so a page-level sweep can never assert more than one instrument. The chain scan's other
  // rows are therefore metadata-only (min size, leverage, funding) and permanently unquotable.
  const sidebarSymbol = o.contract
    ? spec.classifyName(o.contract.name || o.contract.venueName || '').underlying
    : null;
  let quotes = 0;
  const skippedQuotes = [];
  const quoteRows = Array.isArray(o.items)
    ? o.items.map((it) => ({ id: it.instrumentId, name: it.name || (it.contract && it.contract.name), sell: it.sell, buy: it.buy, matched: it.matched === true }))
    : (o.rows || []).map((r) => ({ id: r.instrumentId, name: r.name, sell: r.sell, buy: r.buy, matched: true }));
  for (const q of quoteRows) {
    if (!q.id || q.matched === false) continue;
    // The SYMBOL is derived from the row name and is not optional: `InstrumentQuotes.symbol` is NOT
    // NULL, and the resolver reads quotes BY SYMBOL. The first replay wrote zero quotes because it
    // passed null here and every insert failed a constraint that was doing its job.
    const symbol = spec.classifyName(q.name).underlying;
    if (!symbol) { skippedQuotes.push(q.id); continue; }
    const spread = spec.spreadOf(q);
    // `unknown` for any row the sidebar does not describe — see the note above. Never the calendar:
    // we would be asserting a session we have no evidence for, and the one consumer of this column
    // (`venueCostFacts`, via usableQuote) treats `open` as permission to use the spread as a
    // permanent cost constant.
    const quoteState = spec.quoteStateFor({ sidebarSymbol, symbol, marketState });
    const written = await registry.recordQuote(userId, {
      venue, venueInstrumentId: q.id, symbol,
      buy: spec.isNum(q.buy) ? spec.num(q.buy) : null,
      sell: spec.isNum(q.sell) ? spec.num(q.sell) : null,
      spread, marketState: quoteState,
    }).catch(() => ({ ok: false }));
    if (written.ok) quotes += 1;
  }

  return {
    marketState,
    instruments: stored.length,
    refused,
    quotes,
    skippedQuotes,
    stored,
    // Stated explicitly so a caller cannot read "0 refused" as "everything went in": the scan's own
    // integrity counters decide whether the capture is trustworthy at all.
    checks: o.checks || null,
    // Whether any of this can feed a COST model right now. On the Sunday capture it cannot, and
    // that is the honest answer rather than a number waiting to be misused.
    quotable: marketState === 'open',
    // A capture where the desk's calendar and the venue's own banner disagreed. Recorded, never
    // resolved silently: the venue wins for "closed" (see the note above), but the operator
    // needs to know the two sources are not speaking the same language.
    calendarState,
    venueState,
    marketStateConflict,
  };
}

// PHASE 2 (2026-09-14): the venue's own cost and contract facts, gathered for the CHAIR.
//
// The chair decides "is this trade worth taking" from a bundle that contained the market snapshot,
// the indicators, the positions and the pulse — and NOTHING about what the venue charges to hold the
// position. Overnight funding is per instrument AND per side (Gold spot: buy -0.0319%/night, sell
// -0.0120%; the options on the same underlier: 0.0000% both sides), so a chair voting on a
// multi-night hold had no way to know that one side of one instrument carries a cost the other does
// not. The desk's own cost model was no better: `cfdSwapDailyPct: 0.02` is a FLAT placeholder applied
// to every instrument regardless of side.
//
// THE SIGN CONVENTION IS SETTLED BY THE DESK'S OWN CLOSED TRADES, not by reading the venue's help
// pages. Eleven venue-closed positions carry both `netPnl` and `funding`, and:
//   * every one that opened and closed inside the same UTC day has funding EXACTLY 0 (11/11 through
//     #1027 — which also re-confirms calendar-true nights, TRD-25);
//   * the single trade that crossed a UTC midnight (#1027, Gold sell, 09-10 19:10Z -> 09-11 05:46Z)
//     is the single trade with non-zero funding: -0.12 on 802.6 notional = -0.01495%/night, against
//     the venue's own stated sell-side rate of -0.0120% (predicted -0.096);
//   * all eleven values are <= 0, including the large ones (SGX -4 on ~5000 notional, SHEIN -0.87).
// So NEGATIVE = THE TRADER PAYS, and the displayed percentage is the rate applied. n=1 corroborates
// the MAGNITUDE; the sign is corroborated eleven times over, and the sign is what a cost model needs.
//
// `carryPctFor` therefore returns a COST (positive = charged) rather than echoing the venue's sign,
// because every consumer wants "what does a night cost me" and inverting a sign in six places is how
// a credit becomes a charge.
function carryPctFor(facts, direction) {
  if (!facts) return null;
  const raw = direction === 'sell' ? facts.fundingSellPct : facts.fundingBuyPct;
  const n = num(raw);
  if (!Number.isFinite(n)) return null;
  // `-Number(0)` is `-0`, which is `=== 0` but prints as "-0%" in a prompt and is a different value
  // to `Object.is`. Normalise it here so the sign never leaks into a rendered number.
  return n === 0 ? 0 : -n;
}

// ⚠⚠ THE SPECS HAD NO AGE GATE WHILE THE QUOTES HAD A 72h ONE, AND THAT ASYMMETRY IS ITSELF THE DEFECT.
// `venueCostFacts` refuses a quote older than `maxQuoteAgeHours` and the prompt says `no_open_market_capture — NOT
// usable as a cost`. Instrument SPECS had no equivalent: `row.capturedAt` was carried into the result — and into the
// decision record at `risk.js` `venueFloor.capturedAt` — and NOTHING read it, while `costFactLines` printed minimum
// size, funding and leverage with no age at all. Measured 2026-10-28: the registry's newest row was 2026-10-01, so
// every instrument fact the chairs were reading was 27 days old and every one of them looked live.
//
// 168h is `bindingProposer.DEFAULT_MAX_STALE_H`, so "too old to rely on" means ONE thing on this desk.
const MAX_SPEC_AGE_HOURS = 168;

// Two queries, not two-per-symbol: the watchlist is ~10 symbols and the wake path already does a lot
// of I/O, so the registry rows and the consumable quotes are each fetched once and assembled here.
// Only quotes captured while the venue said the market was OPEN are candidates, and the newest wins.
async function venueCostFacts(userId, { venue = registry.VENUE_DEFAULT, symbols = [], maxQuoteAgeHours = 72 } = {}) {
  let rows = [];
  let quotes = [];
  try {
    rows = await registry.listInstruments(userId, { venue });
    quotes = (await registry.listQuotes(userId, { venue, limit: 5000 }))
      .filter((q) => q.marketState === 'open'
        && q.capturedAt && (Date.now() - new Date(q.capturedAt).getTime()) < maxQuoteAgeHours * 3600000);
  } catch {
    // A registry read failure means the facts are UNKNOWN, which the caller must be able to see
    // rather than mistake for "no costs".
    return {};
  }
  // No symbol list means EVERY instrument the registry knows. That is what the cost-model seed wants
  // (a backtest may be run on any symbol); the prompt path passes the watchlist so the bundle stays
  // the size the chairs were tuned for.
  const wanted = (symbols && symbols.length)
    ? new Set(symbols.map((s) => (typeof s === 'string' ? s : s && s.symbol)).filter(Boolean))
    : new Set(rows.map((r) => r.symbol).filter(Boolean));
  if (!wanted.size) return {};
  const out = {};
  for (const symbol of wanted) {
    // The SPOT row is the one the desk trades when it says "Gold". Options share the symbol and are
    // reached by id, never by name (see resolve()).
    const row = rows.filter((r) => r.symbol === symbol && r.instrumentClass === 'spot')
      .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))[0]
      || rows.filter((r) => r.symbol === symbol).sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))[0];
    if (!row) continue;
    // THE QUOTE MUST BELONG TO **THIS** ROW. This used to pick the newest quote for the SYMBOL, which
    // on a symbol carrying an option chain is an option's premium quote (Gold: 20 options vs 1 spot) -
    // a 1.1747% half-spread charged as the spot CFD's cost, 20x the real 0.0597%, seeded into every
    // venue-basis backtest and printed to the chairs. `quoteForInstrument` matches on the row's own
    // venueInstrumentId and returns null rather than borrowing another instrument's quote.
    const q = spec.quoteForInstrument(quotes, { venue, venueInstrumentId: row.venueInstrumentId });
    const min = row.unitAmount == null ? null : Number(row.unitAmount);
    const specCapturedMs = row.capturedAt ? new Date(row.capturedAt).getTime() : NaN;
    // The spread is expressed the SAME WAY the cost model already expresses it — a HALF-spread as a
    // percentage of price per side — so consuming it needs no unit conversion and cannot be silently
    // read as a full round trip. `cfdSpreadPct` in backtest.js is exactly this quantity.
    const mid = q && spec.isNum(q.buy) && spec.isNum(q.sell) ? (spec.num(q.buy) + spec.num(q.sell)) / 2 : null;
    const spreadValue = q && q.spread != null ? Number(q.spread) : null;
    const spreadHalfPct = mid && spreadValue != null && spreadValue > 0
      ? Math.round(((spreadValue / 2) / mid) * 100 * 1e6) / 1e6
      : null;
    out[symbol] = {
      symbol,
      venueInstrumentId: row.venueInstrumentId,
      instrumentClass: row.instrumentClass,
      minimumUnits: Number.isFinite(min) && min > 0 ? min : null,
      unitKind: row.unitKind || null,
      fundingBuyPct: row.fundingBuyPct == null ? null : Number(row.fundingBuyPct),
      fundingSellPct: row.fundingSellPct == null ? null : Number(row.fundingSellPct),
      fundingTime: row.fundingTime || null,
      leverageRaw: row.leverageRaw || null,
      initialMarginPct: row.initialMarginPct == null ? null : Number(row.initialMarginPct),
      // A spread is present ONLY when the venue said the market was open. `null` plus the reason is
      // the honest answer; Phase 0 measured 2.89 for Gold spot while the market was shut.
      spreadValue,
      spreadHalfPct,
      spreadMid: mid,
      spreadCapturedAt: q ? q.capturedAt : null,
      spreadBasis: q ? 'open_market_capture' : 'no_open_market_capture',
      capturedAt: row.capturedAt || null,
      // The age of the SPEC, judged by the caller against MAX_SPEC_AGE_HOURS. Computed here so no consumer has to
      // remember which timestamp to subtract from, or that `capturedAt` is the row's and `spreadCapturedAt` is not.
      specAgeHours: Number.isFinite(specCapturedMs) ? Math.round(((Date.now() - specCapturedMs) / 3600000) * 10) / 10 : null,
      marketStateAtCapture: row.marketStateAtCapture || null,
      // THE COST BASIS THE DESK WILL ACTUALLY PRICE WITH, named BESIDE the venue capture rather than inferred from
      // it. `costFactLines` used to print "spread: no open-market capture - NOT usable as a cost" whenever the quote
      // lane had nothing, while `stopPolicy.adverseStopCap` priced the stop-cap floor from `backtest.costCfgFor` -
      // two answers to one question inside one decision, and neither named the other. The cost model is the one that
      // acts, so that is the one the prompt states; a live capture, when one exists, is corroboration.
      //
      // READ, NOT RE-DERIVED: `costCfgFor` owns this fact - it composes spread and slippage and labels the
      // provenance - so it is copied here rather than recomputed, and the prompt and the risk gate cannot quote
      // different numbers for the same symbol.
      costModel: (() => {
        try {
          const cfg = require('./backtest').costCfgFor(symbol);
          return {
            spreadHalfPct: cfg.cfdSpreadPct == null ? null : Number(cfg.cfdSpreadPct),
            slippagePct: cfg.cfdSlippagePct == null ? null : Number(cfg.cfdSlippagePct),
            spreadBasis: (cfg.costModelBasis && cfg.costModelBasis.spread) || null,
            version: cfg.costModelVersion || null,
          };
        } catch { return null; }
      })(),
    };
  }
  return out;
}

// The bundle/prompt projection: ONE line per symbol, and the legend that makes the sign usable.
// Kept here (not in promptBuilder) so the wording and the numbers cannot drift apart.
function costFactLines(factsBySymbol) {
  const facts = Object.values(factsBySymbol || {});
  if (!facts.length) return ['(no instrument registry entries for these symbols yet — the venue\'s minimum trade size, spread and overnight funding are UNKNOWN, not zero)'];
  const out = [
    'Legend: funding is charged per CALENDAR NIGHT held; a NEGATIVE rate means the desk PAYS it, positive means it is credited. The venue states a DIFFERENT rate per side.',
  ];
  for (const f of facts) {
    const bits = [];
    bits.push(f.minimumUnits != null ? `min size ${f.minimumUnits}${f.unitKind ? ' ' + f.unitKind : ''}` : 'min size UNKNOWN');
    // THE COST NUMBER IS THE ONE THE RISK GATE USES, AND IT IS NOT ALWAYS A VENUE CAPTURE. Printing "NOT usable as a
    // cost" whenever the quote lane was empty became FALSE once that lane lapsed: the desk prices from
    // `backtest.costCfgFor`, which resolves a curated constant for these symbols. The line now states that number and
    // its population, and reports a live capture - when there is one - as corroboration rather than as the answer.
    // A `flat_default` basis is called a placeholder out loud, because it is a constant wearing a measurement's name.
    const cm = f.costModel || null;
    if (cm && cm.spreadHalfPct != null) {
      const basisText = cm.spreadBasis === 'venue_open_market' ? 'live open-market capture'
        : cm.spreadBasis === 'flat_default' ? 'PLACEHOLDER, not a measurement'
          : cm.spreadBasis === 'calibrated_table' ? 'curated, not verifiable against ticks'
            : cm.spreadBasis === 'tick_history_p75' ? "p75 of the desk's own two-sided ticks"
              : cm.spreadBasis === 'tick_history_p75_derived' ? 'derived p75 of the desk\'s two-sided ticks'
                : 'basis unstated';
      bits.push(`cost spread ${cm.spreadHalfPct}% per side + ${cm.slippagePct}% slippage (${basisText})`);
      if (f.spreadValue != null && f.spreadHalfPct != null) bits.push(`venue capture ${f.spreadHalfPct}% half-spread of ${f.spreadMid} (corroboration)`);
    } else if (f.spreadValue != null) {
      bits.push(`spread ${f.spreadValue}${f.spreadHalfPct != null ? ` (half-spread ${f.spreadHalfPct}% of ${f.spreadMid})` : ''}`);
    } else {
      bits.push('cost spread UNKNOWN - no cost basis resolved for this symbol');
    }
    const fb = f.fundingBuyPct == null ? 'n/a' : `${f.fundingBuyPct}%`;
    const fs = f.fundingSellPct == null ? 'n/a' : `${f.fundingSellPct}%`;
    bits.push(`overnight funding buy ${fb} / sell ${fs}${f.fundingTime ? ` @ ${f.fundingTime}` : ''}`);
    if (f.leverageRaw) bits.push(`leverage ${f.leverageRaw}${f.initialMarginPct != null ? ` (initial margin ${f.initialMarginPct}%)` : ''}`);
    // ⚠ THE AGE RIDES THE LINE, NOT A FOOTNOTE. A caveat printed once above the block is read once and then skipped;
    // the number it qualifies is per symbol, and the reader is a model deciding whether to act on these costs.
    const stale = f.specAgeHours != null && f.specAgeHours > MAX_SPEC_AGE_HOURS;
    out.push(`${f.symbol}: ${bits.join(' · ')}${f.instrumentClass === 'option' ? ' [option]' : ''}`
      + (stale ? ` ⚠ SPECS ${Math.round(f.specAgeHours)}h OLD — the minimum size, funding and leverage above are UNVERIFIED` : ''));
  }
  return out;
}

// SEEDING THE BACKTEST COST MODEL, in one call. Splitting "read the facts" from "hand them to the
// cost model" is how a run silently keeps the flat placeholder dial while its operator believes it is
// on the venue basis — and a stored backtest whose cost basis changes without its label changing is
// the mistake this repo already paid for once (the TRD-25 double-count erratum). One function, so the
// two halves cannot come apart. Returns how many symbols were seeded, which the caller should surface.
async function seedBacktestCostBasis(userId, { venue = registry.VENUE_DEFAULT, symbols = null } = {}) {
  const facts = await venueCostFacts(userId, { venue, symbols: symbols || [] });
  const seeded = require('./backtest').setVenueCostBasis(facts);
  return { seeded, symbols: Object.keys(facts), facts };
}

// TRD-79: put a DERIVED spread basis (a P75 half-spread from the desk's own two-sided ticks) in front
// of the cost model, for every symbol the tick history can measure.
//
// ⚠ THIS IS THE ONLY FUNCTION THAT MAY CALL `setSpreadDerivation`, for the same reason
// `seedBacktestCostBasis` is the only caller of `setVenueCostBasis`: reading the facts and handing them
// to the cost model are two halves of one decision, and a half-done version (read but not applied, or
// applied from a stale read) looks exactly like a symbol that simply has no history.
//
// ⚠ AND IT SEEDS NOTHING WHEN THE READ FAILS. A failed read is IGNORANCE, not evidence of absence: the
// audit's `unverifiable` list is a claim ABOUT the ticks we could read, and seeding an empty census
// would relabel every curated symbol `calibrated_table` on the strength of a database hiccup. So the
// failure path returns before touching the model, and says which failure it was.
//
// `unverifiable` = the curated entries the derivation could NOT reach with two-sided rows. Those keep
// their number (a curated decision of record is not deleted) but stop being labelled as if they were
// measured — the honest split TRD-79 asked for.
async function seedDerivedSpreadBasis(userId, { venue = registry.VENUE_DEFAULT, days = null, minTwoSided = null } = {}) {
  const backtest = require('./backtest');
  const derivation = require('./spreadDerivation');
  const windowDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : derivation.DEFAULT_WINDOW_DAYS;
  let ticks;
  try {
    ticks = await require('../store/ticks').spreadTicks(userId, { venue, days: windowDays });
  } catch (e) {
    return { seeded: 0, audited: false, error: `tick history unreadable: ${e.message || e}` };
  }
  if (!Array.isArray(ticks)) return { seeded: 0, audited: false, error: 'tick history unreadable: not a row list' };
  const census = derivation.deriveSpreadBasis(ticks, { venue, windowDays, minTwoSided });
  const bySymbol = new Map(census.results.map((r) => [r.symbol, r]));
  const unverifiable = Object.keys(backtest.CALIBRATED_SPREAD_HALF_PCT)
    .filter((s) => { const r = bySymbol.get(s); return !r || !r.ok; });
  const applied = backtest.setSpreadDerivation({
    derived: census.basis,
    unverifiable,
    provenance: { venue, days: windowDays, minTwoSided: census.minTwoSided, rows: ticks.length, at: new Date().toISOString() },
  });
  return {
    seeded: applied.derived,
    audited: applied.audited,
    venue,
    days: windowDays,
    rows: ticks.length,
    symbolsSeen: census.results.length,
    unverifiable,
    refused: census.refused,
    results: census.results,
  };
}

// TRD-114 (2026-10-27): seed the SLIPPAGE basis from the desk's own fills. Same shape and same rules as
// `seedDerivedSpreadBasis` above — read the rows, derive purely, apply in ONE call — because the two terms feed the
// same budget and must never be half-applied.
//
// ⚠ IT SEEDS NOTHING WHEN THE READ FAILS, and a thin symbol is REFUSED BY NAME rather than priced from a handful of
// fills. A refused symbol keeps `CALIBRATED_SLIP_PCT` and its `calibrated_placeholder` label: wrong, but stated.
async function seedDerivedSlipBasis(userId, { days = 120, minFills = null } = {}) {
  const backtest = require('./backtest');
  const derivation = require('./slipDerivation');
  const windowDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 120;
  let rows;
  try {
    // THE SQL LIVES IN THE STORE LAYER (`store/fills.js`). `test/venue-cost-basis.test.js` scans THIS FILE for
    // ad-hoc database access and fails the build, and the first version of this seeder violated it. The guard exists
    // because a second place that queries a table is a second place that can forget the filter — here the NOT NULL
    // pair that defines a measurable fill. ⚠ The scan reads COMMENTS too, so the check cannot be named literally
    // here; that is why this paragraph describes it rather than quoting it.
    rows = await require('../store/fills').slipRows(userId, { days: windowDays });
  } catch (e) {
    return { seeded: 0, error: `fill telemetry unreadable: ${e.message || e}` };
  }
  if (!Array.isArray(rows)) return { seeded: 0, error: 'fill telemetry unreadable: not a row list' };
  const census = derivation.deriveSlipBasis(rows, minFills == null ? undefined : { minN: Number(minFills) });
  const seeded = backtest.setSlipDerivation({
    derived: census.basis,
    provenance: { days: windowDays, fills: rows.length, minN: census.minN, at: new Date().toISOString() },
  });
  return { seeded, days: windowDays, fills: rows.length, refused: census.refused, results: census.results };
}

// ★ 2026-10-27 — THE QUOTE CURRENCY OF AN INSTRUMENT, resolved through THIS module because it is a per-instrument
// fact. `test/architecture-conformance.test.js` invariant A already forbids `instrumentCurrencyOf(` outside this
// file, and it is right to: a symbol -> currency lookup is a per-instrument fact, and a second one is a second
// answer that can disagree with the first.
//
// ⚠ IT CAN RETURN NULL, AND NULL IS THE ANSWER when `settings.account.instrumentCurrency` has no entry. The caller
// must be able to tell "nobody said" from "USD" — that assumption is the defect `accountCurrency.js` documents.
function quoteCurrencyOf(settings, symbol) {
  const { instrumentCurrencyOf } = require('./accountCurrency');
  return instrumentCurrencyOf(settings, symbol);
}

module.exports = { MAX_SPEC_AGE_HOURS, floorVerdict, snapToVenueStep, venueLeverage, marginRatePct, marginRatesFor, ceilingPctFor, resolve, checkSize, captureFromObservation, venueCostFacts, carryPctFor, costFactLines, seedBacktestCostBasis, seedDerivedSpreadBasis, seedDerivedSlipBasis, quoteCurrencyOf };

