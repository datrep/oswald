// trading/agent/risk.js — deterministic risk gate (amendment A2/A5 + TRD-12).
// Position sizing (Turtle: capital x risk% / stop distance, where the stop
// distance = max(2xATR, minStopToSpread x live spread) — P0-4), caps, daily
// trade limits, correlation veto, portfolio exposure budget (binds by
// resizing — see fitExposureBudget), daily-loss halt.
'use strict';

const { correlation } = require('./indicators');
const store = require('../store');
// L5 (2026-09-29): `dayKeyAt` + the venue's own session minute, so the halt's "day" is a stated value rather
// than `toISOString().slice(0,10)` written inline in the middle of a function.
const { dayKeyAt, DEFAULT_FUNDING_MINUTE_UTC } = require('./time');
// TRD-RSK-7: the per-desk risk profile (pure — no DB, no logger — so the resolution rule is testable,
// and so the gate keeps only the one-line wiring).
const { resolveProfile } = require('../riskProfile');
// ★★ P2 (2026-10-01): the TOP of the plausible-rate band, used as the CONSERVATIVE fallback when no rate is
// available. Imported rather than restated, because a second literal is how two answers to one question start
// — the rule `accountCurrency.js` exists to enforce.
const { PLAUSIBLE_MAX: FX_RATE_PLAUSIBLE_MAX } = require('./fxRate');

// P1-9 (2026-09-10): correlation veto on LOG RETURNS of 1h closes over a
// fixed 30-day window, aligned by barStart intersection (>=30 bars required).
// Price-level correlation (the old method) inflated the readings — the 0.73
// Gold/Silver figure was computed on raw levels over <=120 ticks.
const CORR_VENUE_PREF = ['yahoo', 'binance', 'okx', 'plus500_chart', 'plus500'];
const CORR_MIN_BARS = 30;

// ★★ TRD-RSK-3 (#1451), 2026-09-28: THE WINDOW IS THE ONE THE REFUSAL NAMES.
//
// The comment above has claimed "a fixed 30-day window" since P1-9, and the refusal the owner reads says
// "correlation X (30d log-returns)" — but the READ carried no date filter at all. `listBars` is
// `SELECT TOP (@limit) ... ORDER BY barStart DESC` with `limit` clamped to 12000, so `limit: 12000` silently
// meant "however far back 12,000 hourly bars happen to reach". Measured 2026-09-28 on Gold|Silver: **11,476
// return pairs spanning 733 days, rho 0.7763**, against **435 pairs over 28.3 days, rho 0.688** for the
// window the sentence names.
//
// WHY THAT IS A DEFECT RATHER THAN A WIDER NET. Not because a long window is wrong — because the NUMBER and
// the SENTENCE describing it disagreed, and the disagreement decided a live refusal: at
// 2026-09-28T05:22:41.900Z Silver was refused at 0.7763, and 0.688 sits BELOW the 0.7 threshold, so the
// refusal would not have fired on the window its own message claimed. A reading that does not mean what it
// says is the defect class this desk keeps closing.
//
// ⚠ ANCHORED AT THE NEWEST PAIRED BAR, NOT AT THE CLOCK. Anchoring at `Date.now()` would silently empty the
// window whenever the feed is stale (a closed market, a dead capture) and return null — which this gate reads
// as "no opinion", so a broken feed would quietly DISABLE the veto. Anchoring on the data's own newest bar
// makes the window always "the last 30 days OF DATA", and a stale series stays visible as stale.
const CORR_WINDOW_DAYS = 30;
const CORR_WINDOW_MS = CORR_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// A number, or NaN when the value is absent or unreadable. NOT `Number(v)`: that turns null and '' into 0,
// and every caller below is asking "is this usable" — 0 is not. Each module carries its own copy of this
// guard (expectancy.js exports one) because the alternative is a require in the sizing path; the important
// half is that it is a MODULE-LOCAL name, so it cannot be silently shadowed.
function finiteNum(v) {
  if (v == null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function returnsCorrelation(userId, symA, symB) {
  const load = async (sym) => {
    for (const v of CORR_VENUE_PREF) {
      const rows = await store.listBars(userId, { timeframe: '1h', symbol: sym, venue: v, limit: 12000 }).catch(() => []);
      if (rows.length >= CORR_MIN_BARS) return rows;
    }
    return null;
  };
  const [a, b] = await Promise.all([load(symA), load(symB)]);
  if (!a || !b) return null;
  const mapB = new Map(
    b.map((r) => [new Date(r.barStart).getTime(), Number(r.closePrice)])
      .filter(([, c]) => Number.isFinite(c) && c > 0)
  );
  const paired = [];
  for (const r of a) {
    const c = Number(r.closePrice);
    if (!Number.isFinite(c) || c <= 0) continue;
    const other = mapB.get(new Date(r.barStart).getTime());
    if (other != null) paired.push({ t: new Date(r.barStart).getTime(), a: c, b: other });
  }
  if (paired.length < CORR_MIN_BARS + 1) return null;
  // ★ TRD-RSK-3: WINDOW THE PAIRED SERIES. `listBars` returns ascending (`recordset.reverse()`), but the
  // window is derived from the DATA's own extremes rather than from that ordering, so this cannot be broken
  // by an upstream `ORDER BY` change: the newest paired bar defines the right edge, and a series that reaches
  // back less than the window is used whole (which is what the old behaviour was, for a young series).
  const newest = paired.reduce((mx, p) => (p.t > mx ? p.t : mx), paired[0].t);
  const from = newest - CORR_WINDOW_MS;
  const windowed = paired.filter((p) => p.t >= from);
  if (windowed.length < CORR_MIN_BARS + 1) return null;
  const ra = []; const rb = [];
  for (let i = 1; i < windowed.length; i++) {
    ra.push(Math.log(windowed[i].a / windowed[i - 1].a));
    rb.push(Math.log(windowed[i].b / windowed[i - 1].b));
  }
  const c = correlation(ra, rb);
  return c == null ? null : +c.toFixed(4);
}

// ★★ TRD-RSK-5 (#1456), 2026-09-28: THE SAME QUESTION, ASKED AGAINST A BOOK THE CALLER CHOOSES.
//
// `evaluate` asks this of the wake's book snapshot, and the snapshot is taken ONCE (`wakePipeline.js:330`).
// Every entry in a wake is therefore judged against the same frozen book, and the only pre-submit re-check
// was symbol-scoped (`already_open_symbol`) — so two correlated entries deliberated in ONE wake were never
// compared to each other. Measured: wake #105365 was handed a 1-position book and opened Gold AND Silver
// together, 12 seconds after this same gate refused Silver against an open Gold (0.7763).
//
// This is the rule in ONE place so the wake can re-ask it with a book that includes what it has already
// approved, instead of growing a second copy that would drift from this one.
//
// Returns null (no clash) rather than throwing: correlation is a soft layer and an error in it must never
// become a new way for an approved entry to die.
//
// TRD-17/24 (carried over with the rule, not dropped): the two legs of ONE pair are SUPPOSED to be
// correlated — `pairExempt` skips the veto BETWEEN THE PAIR'S OWN LEGS ONLY, and it requires BOTH sides to
// carry the same non-null pairId (verified by the forced-pair positive control). A caller that passes no
// proposal (the wake path) has no pairId, so every position is compared, which is the stricter answer and
// the correct one there: nothing in a wake is a declared pair leg.
async function correlationClash(userId, risk, symbol, positions, { proposal = null } = {}) {
  const corrVeto = Number((risk || {}).correlationVeto ?? 0.7);
  if (!symbol) return null;
  const prop = proposal || { symbol };
  for (const pos of positions || []) {
    if (!pos || !pos.symbol) continue;
    if (String(pos.symbol).toLowerCase() === String(symbol).toLowerCase()) continue; // not a correlation question
    if (pairExempt(prop, pos)) continue; // intended pair exposure
    try {
      const c = await returnsCorrelation(userId, symbol, pos.symbol);
      if (c != null && Math.abs(c) >= corrVeto) {
        // ⚠ THE TEXT IS UNCHANGED FROM THE INLINE ORIGINAL, and now it is true: the window it names is the
        // window it used (TRD-RSK-3). Readers key on this sentence; it must not be reworded in passing.
        return { code: 'correlation', c, withSymbol: pos.symbol, threshold: corrVeto,
          text: `correlation ${c} (30d log-returns) with open position ${pos.symbol} >= ${corrVeto}` };
      }
    } catch { /* correlation is a soft layer — skip on error */ }
  }
  return null;
}

// TRD-12 Phase 2: day-start equity (first wake of the UTC day) drives the
// daily-loss halt. Persisted as a TradingEvents 'day_start' row.
//
// TRD-109 (2026-09-20): THE RESOLUTION IS PURE, AND IT FAILS CLOSED.
//
// The old body ended `Number(equity) || Number(settings.kill?.initialEquity) || 0`, so an unavailable equity
// LOGGED A ZERO ROW — and `dailyHaltActive`'s `start <= 0` then read that zero as "not halted". The 3%
// daily halt switched itself off in precisely the state where nothing was known, which is the same shape as
// `floorBreached` answering `false` about a baseline it could not read. Returning null is the difference
// between "the halt does not apply" and "the halt cannot be evaluated", and only the caller can decide
// which of those is safe — so the decision is made here, explicitly, and the I/O below is three lines.
//
// It also REPAIRS rather than honours a logged non-positive value: a row left behind by the old code is not
// evidence about today's equity, so an unusable logged value is re-resolved from the live read and the
// baseline instead of being trusted. One bad row must not cost the day.
function resolveDayStart({ loggedDate, loggedEquity, today, equity, baseline } = {}) {
  const logged = finiteNum(loggedEquity);
  if (loggedDate === today && Number.isFinite(logged) && logged > 0) {
    return { equity: logged, write: false, source: 'logged' };
  }
  const live = finiteNum(equity);
  const base = finiteNum(baseline);
  const hasLive = Number.isFinite(live) && live > 0;
  const hasBase = Number.isFinite(base) && base > 0;
  if (!hasLive && !hasBase) {
    return {
      equity: null, write: false, source: null,
      reason: 'no usable equity: the live read and kill.initialEquity are both unavailable or non-positive',
    };
  }
  return {
    equity: hasLive ? live : base,
    write: true,
    source: hasLive ? 'live' : 'baseline',
    // Present only when a row for today EXISTS and was unusable, i.e. when this write is a repair.
    repairedFrom: loggedDate === today ? logged : undefined,
  };
}

// ★ L5 (2026-09-29): WHICH ANCHOR THE HALT'S DAY USES. Pure, so the choice is testable and the record can name
// it rather than leaving it implied by a date string.
//
//   'utc_midnight'  -> minute 0. **THE DEFAULT, and the behaviour that has always been in force.**
//   'venue_session' -> the venue's own 21:00 UTC boundary (`DEFAULT_FUNDING_MINUTE_UTC`), which IS the desk's
//                      trading day (Fri 21:00 close to Sun 21:00 open): one session, one halt-day, and the reset
//                      lands while the market is shut rather than in the middle of it.
//
// ⚠ THIS IS A RISK DECISION, NOT HOUSEKEEPING, SO THE DEFAULT DOES NOT MOVE. Measured against the live halt
// (`dailyLossHaltPct: 3`), the two anchors differ only in the three hours between 21:00 UTC and midnight: the UTC
// anchor is still carrying the previous day's baseline there, while a session anchor has just reset. So the
// session anchor is STRICTER for 21 hours of the day and LOOSER for the three that follow the venue's close —
// which is exactly why it belongs to the owner rather than to whoever edited the file.
function haltAnchorMinute(settings) {
  const r = (settings && settings.risk) || {};
  return r.dailyHaltAnchor === 'venue_session' ? DEFAULT_FUNDING_MINUTE_UTC : 0;
}

async function dayStartEquity(userId, settings, equity) {
  // ★ L5 (2026-09-29): WHICH DAY, NAMED. The anchor used to be UTC midnight by construction — an
  // `toISOString().slice(0, 10)` inside this function — and UTC midnight falls inside a live session, so one
  // session spanned two halt-days and the halt reset mid-session with the market still open. It is now a
  // stated setting with the LEGACY behaviour as its default, so nothing moves until the owner says so, and the
  // choice is visible in the record instead of implied by a date call.
  const anchorMinuteUtc = haltAnchorMinute(settings);
  const today = dayKeyAt(new Date(), anchorMinuteUtc);
  const last = await store.latestEvent(userId, 'day_start');
  const p = (last && last.payload) || {};
  const d = resolveDayStart({
    loggedDate: p.date ?? null,
    loggedEquity: p.equity ?? null,
    today,
    equity,
    baseline: settings.kill?.initialEquity,
  });
  if (d.write) {
    await store.logEvent(userId, 'day_start', {
      date: today, equity: d.equity, source: d.source,
      // The anchor travels with the row: a baseline without it cannot be re-derived, and a study comparing two
      // eras would have no way to tell which boundary produced which halt-day.
      anchorMinuteUtc,
      ...(d.repairedFrom !== undefined ? { repairedFrom: d.repairedFrom } : {}),
    });
  }
  return d.equity;
}

// Daily-loss halt: entries blocked once equity is >=X% below day-start. Pure, for the same reason
// `floorState` is — the rule is what needs pinning, and the rule is what was fail-open.
function dailyHaltVerdict({ thresholdPct, dayStart, equity } = {}) {
  const pct = finiteNum(thresholdPct);
  if (!Number.isFinite(pct)) return { halted: true, reason: 'dailyLossHaltPct is not a number — the halt cannot be evaluated' };
  // A deliberate 0 is a CONFIGURED off, not a failure to read: it stays off, and says so rather than
  // looking identical to a halt that simply did not trigger.
  if (pct <= 0) return { halted: false, disabled: true, thresholdPct: pct };
  const start = finiteNum(dayStart);
  if (!Number.isFinite(start) || start <= 0) {
    return { halted: true, thresholdPct: pct, reason: 'day-start equity unavailable — the halt cannot be evaluated' };
  }
  const eq = finiteNum(equity);
  if (!Number.isFinite(eq)) {
    return { halted: true, thresholdPct: pct, dayStart: start, reason: 'equity unavailable — the halt cannot be evaluated' };
  }
  const drawdownPct = ((eq - start) / start) * 100;
  return { halted: drawdownPct <= -pct, dayStart: start, drawdownPct: +drawdownPct.toFixed(2), thresholdPct: pct };
}

async function dailyHaltActive(userId, settings, equity) {
  const thresholdPct = settings.risk?.dailyLossHaltPct ?? 3;
  const pct = finiteNum(thresholdPct);
  // A configured 0 needs no day-start row at all; every other threshold does, including the unreadable one
  // (which fails closed rather than skipping the comparison).
  if (Number.isFinite(pct) && pct <= 0) return dailyHaltVerdict({ thresholdPct: pct });
  return dailyHaltVerdict({ thresholdPct, dayStart: await dayStartEquity(userId, settings, equity), equity });
}

// Exposure-budget composition (single sizing formula — caps compose, they do
// not double-apply; plan C.2f). Returns the size FITTED into the REMAINING
// budget:
//   fitted=false                 -> original size already fits (or budget disabled)
//   fitted=true,  size > 0      -> resized to the remaining room (same stop,
//                                  so realized risk is LOWER than target)
//   full=true,    size = 0      -> no room left (caller vetoes)
// Rationale (2026-09-11 Oil/Gold incident): the per-position cap can clamp the
// risk-based size ABOVE the portfolio budget (cap 80% vs budget 50%), and a
// veto there quarantines every tight-stop entry forever. The budget guards
// exposure, not opportunity — so it binds by size.
// ★★ P2 (2026-10-01) — THE ACCOUNT-CURRENCY FACTOR. Resolved ONCE per evaluation so every control below
// compares like with like.
//
// THE DEFECT IT CLOSES. `size * price` is the INSTRUMENT's currency; `equity` is the ACCOUNT's. Every control
// in this file compared the two directly, so their effective ceilings were `capPct x fx` — measured, not
// inferred: a 40% cap bound at 51.25% (fills at 50.0-50.9%) and a 35% cap at 44.84% (fills at 44.0-44.3%),
// across eleven strategy-origin fills in two different weeks.
//
// ⚠ THE FALLBACK IS ASYMMETRIC ON PURPOSE, AND IT IS A DELIBERATE DEVIATION FROM THE PLAN.
// The plan said "refuse or veto" when no rate is available. That was rejected after measuring the consequence:
// the rate is absent for the first minutes after ANY restart and whenever fewer than three positions have moved
// $3, so a veto would stop the desk ENTERING for an unbounded period — a far larger behaviour change than the
// unit correction the owner approved. Instead the factor falls back to the TOP of the plausible band
// (`fxRate.PLAUSIBLE_MAX`), which can only ever OVERSTATE the notional and therefore only ever TIGHTEN the cap.
// It is safe in every case, including a rate below the band, and it cannot permit more risk than policy.
// ⚠ The basis is NAMED on the decision (`fxBasis`) so a conservative fallback is visible in the record rather
// than looking like an ordinary sizing. A silent substitution would be the F32 class this report keeps finding.
function fxFactorFor({ settings, symbol, live }) {
  const acct = require('./accountCurrency');
  const account = acct.currencyOf(settings);
  const instrument = acct.instrumentCurrencyOf(settings, symbol);
  // Currencies not recorded -> the conservative bound. Not 1: an unrecorded instrument is NOT USD by default,
  // and assuming 1 is the assumption that inflated 60 venue closes.
  if (!account || !instrument) {
    return { fx: FX_RATE_PLAUSIBLE_MAX, basis: 'conservative_unrecorded_currency' };
  }
  if (account === instrument) return { fx: 1, basis: 'same_currency' };
  const derived = live && typeof live.fxSgd === 'number' && live.fxSgd > 0 ? live.fxSgd : null;
  if (derived) return { fx: derived, basis: 'derived' };
  return { fx: FX_RATE_PLAUSIBLE_MAX, basis: 'conservative_no_rate' };
}

// ★★ ONE DERIVATION OF THE QUOTE → ACCOUNT MULTIPLIER (2026-10-01).
//
// `notional = size x price x pointValue x fx`. Both extra factors are SCALES, and both were being re-derived at
// every site instead of applied once:
//
//   `fx`         converts the INSTRUMENT's currency into the ACCOUNT's        (P2 fixed this)
//   `pointValue` converts a RAW QUOTE into the instrument currency PER UNIT   (this fix)
//
// ⚠⚠ `pointValue` IS NOT ALWAYS 1, AND WAS INVISIBLE UNTIL IT WASN'T. It is `1.000000` on Gold, Oil, Silver and
// Sugar — every instrument this desk had ever sized — so its absence changed nothing for months. Soybeans quotes
// in CENTS (`pointValue 0.01`, unit `Bushels`), so its notional came out **100x too large**: the 35% per-position
// cap bound at 0.69 instead of ~69, which fell under the venue's 15-bushel minimum, and the desk refused every
// entry while reporting the venue's minimum as "~487% of equity". It was one error seen from both ends.
//
// ⚠ WHAT MAKES THIS THE ONE PLACE IS THAT IT EXISTS AT ALL. The same product was written out SIX times
// (`fitExposureBudget` x2, `fitMarginBudget` x3, the per-position cap, the open-book sum, `finalPct`,
// `notionalPct`), so P2's `fx` sweep reached some of them and this report's sweep found the rest. One function,
// called from every site, is what makes the next missing factor a ONE-LINE change instead of a hunt.
//
// ⚠ FAIL-SAFE ON A NON-POSITIVE FACTOR: 1, not 0. A `pointValue` of 0 would zero every notional and read as "this
// instrument is free", which is the `Number(null) === 0` trap wearing a multiplier. An unreadable factor must
// degrade to the identity scale — the same choice `fxFactorFor` already makes — never to a silent zero.
function notionalFactor(pointValue, fx) {
  const pv = Number(pointValue);
  const f = Number(fx);
  return (Number.isFinite(pv) && pv > 0 ? pv : 1) * (Number.isFinite(f) && f > 0 ? f : 1);
}

function fitExposureBudget({ size, price, exposurePct, exposureCapPct, equity, fx = 1, pointValue = 1 }) {
  const out = { size, fitted: false, full: false, wantedPct: null };
  const cap = Number(exposureCapPct);
  if (!Number.isFinite(cap) || !(Number(equity) > 0) || !(Number(price) > 0)) return out;
  // ★ THE ONE MULTIPLIER. `pointValue = 1` is the identity, so every existing caller and test means what it
  // always meant — which is what makes this change provable rather than merely plausible.
  const k = notionalFactor(pointValue, fx);
  // ★★ P2: converted into the ACCOUNT's currency before it is compared with a percentage of the ACCOUNT's
  // equity. `fx = 1` is the same-currency case, so this is a no-op for an SGD-quoted instrument — and the
  // default keeps every existing direct caller (and its test) meaning what it always meant.
  const wantedPct = (size * price * k) / equity * 100;
  const remainingPct = cap - (Number(exposurePct) || 0);
  out.wantedPct = wantedPct;
  if (wantedPct <= remainingPct + 1e-9) return out; // fits
  if (remainingPct <= 0) { out.full = true; out.size = 0; return out; }
  out.fitted = true;
  // And the inverse: the remaining room is in ACCOUNT currency, so it is divided by `fx` on the way back to
  // an instrument-currency SIZE. Converting one direction only would be a new unit bug in the other.
  // ⚠ FLOOR, NOT ROUND — changed 2026-10-01 with P2, and the same argument `fitMarginBudget` already makes
  // about itself. `Math.round` could land the fitted size ABOVE the ceiling it had just computed (measured:
  // cap 40% fitted to 40.0000249%), which was immaterial while this was a self-imposed budget with nothing
  // enforcing it. It stopped being immaterial the moment the cap became a real, converted limit, so this now
  // fails closed and can only ever under-commit. `Math.floor` on a size is safe in both directions.
  out.size = Math.floor(((equity * (remainingPct / 100)) / (price * k)) * 10000) / 10000;
  return out;
}

// ★★ L3 (rev 5, 2026-09-29) — THE MARGIN GUARD. The control that REPLACES the per-position cap as the brake.
//
//   Σ (notional_i x marginRate_i)  ≤  equity x maxMarginUtilisationPct
//
// WHY THE DESK NEEDED A NEW CONTROL RATHER THAN A BIGGER NUMBER. `maxEquityPerPositionPct` is denominated in
// EQUITY, and `already_held` (one position per symbol) bounds concurrency WITHIN a symbol while nothing at all
// bounds it ACROSS symbols. Measured on the live book, ten positions at today's 80% cap are 16.0% of equity in
// margin each — 160% across the book — and L2's raise to 500% makes ONE Gold position 100% of equity in margin
// on its own. The venue closes positions it cannot cover, so an unguarded cap raise is a SETTINGS-DRIVEN
// MARGIN CALL, which is a different failure from a bad trade: it is the desk being stopped out by its own
// configuration.
//
// IT COMPOSES THE WAY `fitExposureBudget` DOES — resize to the remaining room, veto only when there is none.
// That is not a stylistic choice: the 2026-09-11 Oil/Gold incident is what happens when a portfolio budget
// VETOES where it could resize (both turtle survivors refused while the book was flat, and the rule that did
// it looked correct on every individual ticket). The difference between the two helpers is the UNIT: the
// exposure budget caps NOTIONAL, this caps NOTIONAL x MARGIN RATE — the money the venue actually sets aside.
//
// IT IS ALSO THE LAST SIZING CONTROL, and that placement is load-bearing. Every other cap is satisfied MORE
// easily by a smaller size, so shrinking last cannot break one; and running last means it sees the size that
// will actually be sent, INCLUDING a clamp UP to the venue minimum (`acceptVenueFloor`), which happens after
// the exposure budget and can therefore exceed it. A guard placed before that clamp would be inspecting a size
// the venue never receives — the exact shape of defect this report exists to close.
//
// `unknown` IS A THIRD OUTCOME, NOT A FAILURE TO DECIDE. `pct: null` (no venue rate), `usedMargin: null` (an
// open position whose margin could not be read) and an unusable equity all mean the guard has NO OPINION, and
// a guard with no opinion that reports "fits" is permissive precisely when the data is worst. The caller fails
// CLOSED on `unknown`, names the reason, and journals it — the TRD-109 discipline, applied to capacity.
function fitMarginBudget({ size, price, marginRatePct, usedMargin, capPct, equity, fx = 1, pointValue = 1 }) {
  const out = {
    size, fitted: false, full: false, unknown: false,
    capPct: null, capMargin: null, usedMargin: null, wantedMargin: null, remainingMargin: null,
    usedPct: null, wantedPct: null, finalMargin: null, finalPct: null,
  };
  const cap = Number(capPct);
  // Off, absent, or nonsense = the guard does not exist, exactly as an absent `exposureCapPct` does not.
  if (!Number.isFinite(cap) || cap <= 0) return out;
  out.capPct = cap;
  if (!(Number(equity) > 0)) { out.unknown = true; return out; }
  out.capMargin = equity * (cap / 100);
  // ⚠ `usedMargin == null` BEFORE the coercion. `Number(null) === 0`, so an unreadable book would otherwise
  // present as an EMPTY one — the guard's most permissive possible reading of its worst input.
  if (usedMargin == null) { out.unknown = true; return out; }
  const used = Number(usedMargin);
  if (!Number.isFinite(used) || used < 0) { out.unknown = true; return out; }
  out.usedMargin = used;
  out.usedPct = (used / equity) * 100;
  const rate = Number(marginRatePct);
  if (!Number.isFinite(rate) || rate <= 0) { out.unknown = true; return out; }
  if (!(Number(size) > 0) || !(Number(price) > 0)) { out.unknown = true; return out; }

  // ★★ P2: the venue withholds margin against a NOTIONAL in the instrument's currency while the ceiling is a
  // percentage of an equity in the account's — hence the `x fx` here and its inverse in the fitted size below.
  const k = notionalFactor(pointValue, fx);
  const wanted = size * price * k * (rate / 100);
  out.wantedMargin = wanted;
  out.wantedPct = (wanted / equity) * 100;
  const remaining = out.capMargin - used;
  out.remainingMargin = remaining;

  if (used + wanted <= out.capMargin + 1e-9) {
    out.finalMargin = used + wanted;
    out.finalPct = (out.finalMargin / equity) * 100;
    return out; // fits — untouched
  }
  if (remaining <= 0) {
    out.full = true;
    out.size = 0;
    out.finalMargin = used;
    out.finalPct = (used / equity) * 100;
    return out;
  }
  out.fitted = true;
  // ⚠ FLOOR, NOT ROUND. `fitExposureBudget` above rounds to 4dp, which is immaterial there because its claim
  // is a self-imposed notional budget with nothing enforcing it. Here the claim is an INVARIANT the rest of the
  // design is built on — §L3.c derives `P ≤ u by construction` from "the sum of position margins cannot exceed
  // the ceiling" — and a guard that can land 1.2e-5% ABOVE its own ceiling cannot carry that proof. Measured
  // by the sweep in `risk-margin-guard.test.js`: `equity 500, cap 1%, rate 20%` rounded to 1.0000124%. The
  // floor is the fail-closed direction and it can only ever under-commit, never over.
  out.size = Math.floor(((remaining / (rate / 100)) / (price * k)) * 10000) / 10000;
  out.finalMargin = used + out.size * price * k * (rate / 100);
  out.finalPct = (out.finalMargin / equity) * 100;
  return out;
}

async function evaluate(userId, settings, proposal, openTrades, closedTrades = [], opts = {}) {
  // ★★ TRD-RSK-7: THE PROFILE IS RESOLVED ONCE, HERE, SO EVERY RULE BELOW READS THE SAME EFFECTIVE RISK.
  //
  // Resolving per-rule would let the stop cap and the cost ceiling see DIFFERENT settings — which is exactly
  // the two-sources-of-truth shape this whole thread has been closing (`riskPerTradePct` vs
  // `maxRiskPerTradePct`, and the two strategy resolvers TRD-TUN-2 removed). One resolution, one object.
  //
  // The target is the strategy (innermost) then the instrument class, and a proposal naming neither resolves
  // to `default` = today's object, so with no profiles defined this is inert.
  const profile = resolveProfile(settings, {
    strategy: (proposal && proposal.strategy) || null,
    instrumentClass: (proposal && proposal.instrumentClass) || null,
  });
  const risk = profile.risk;
  // TRD-12: size against the LIVE demo equity (1s mirror), falling back to
  // the rebased kill baseline, then the legacy risk number.
  const accLive = require('./accountPoller').getLive();
  // ★★ P2: ONE factor, resolved once, used by every control below. See `fxFactorFor` for why the fallback is
  // conservative rather than a veto.
  const fxF = fxFactorFor({ settings, symbol: proposal && proposal.symbol, live: accLive });
  const fx = fxF.fx;
  // ⚠ The verdict fields for the factor are stamped BELOW, immediately after `v` is created — not here. Writing
  // them here was a ReferenceError (`const v` is declared lower in this function) and it was caught by reading
  // the order rather than by running it.
  const equity = Number(accLive && accLive.equity)
    || Number(settings.kill?.initialEquity)
    || Number(risk.initialEquity)
    || 0;
  const reasons = [];
  const v = { veto: false, reasons, vetoCodes: [], vetoReasons: [], size: null, units: null, exposurePct: 0 };
  // ★★ P2: the factor travels with the decision, and so does its BASIS — `derived`, `same_currency`, or one of
  // the two declared-only `conservative_*` fallbacks. A conservative factor that is not named in the record is
  // indistinguishable from an ordinary sizing, which is the F32 class this report keeps finding.
  v.fxRate = fx;
  v.fxBasis = fxF.basis;
  // ★ TRD-RSK-7: WHICH PROFILE SIZED THIS TICKET, and what it overrode — beside `vetoCodes` in the same
  // machine-readable channel, for the same reason. The row was written under the condition that the
  // resolution REPORTS itself: a profile layer whose resolution is invisible is the TRD-RSK-6 defect with
  // more knobs. `overrode: []` on a profiled desk is also a finding — it means the profile changed nothing.
  v.riskProfile = { id: profile.profileId, axis: profile.axis, overrode: profile.overrodeKeys };
  if (profile.ignoredKeys.length) v.riskProfile.ignored = profile.ignoredKeys;
  // ★★ TRD-RSK-2 (2026-09-27): A MACHINE-READABLE VETO CODE, BESIDE EVERY PROSE REASON.
  //
  // WHY CODES AND NOT PARSING. A refusal by this gate happens BEFORE the committee, so `llmCalled` is false and no
  // seat is asked anything — the ONLY trace is a prose reason inside one wake event. Attributing "why is the desk
  // not trading" therefore meant reading that prose against this file to find which site set the flag. TRD-RSK-2's
  // own author had to do exactly that and got it WRONG once, naming the cost ceiling where the correlation rule
  // had fired, because "venue cost 0.1936% = 65% of R" reads like a breach of a 65% ceiling and 65% IS that
  // ceiling rounded. (The structured field settled it: costShareOfR 0.6453, i.e. 0.0047 UNDER.)
  //
  // The prose stays: it is what a human reads and it carries the numbers. The code is what a REPORT reads, so
  // attribution stops depending on wording — which is the same lesson as every other prose-parsing pin in this
  // codebase. `vetoCodes` is an array because a single call can refuse for more than one reason, and collapsing
  // that to one code would hide the second.
  //
  // ⚠ ORDER IS SIGNIFICANT: codes are appended in evaluation order and the FIRST is the one that would have been
  // reached first, so `vetoCodes[0]` is stable to read. Nothing here changes WHETHER a veto fires — the helper
  // sets exactly the same flag at exactly the same point, so no rule moves.
  // ⚠⚠ AND THE REFUSAL'S OWN TEXT IS KEPT SEPARATE FROM THE NOTES (TRD-VET-2 follow-up, 2026-09-28).
  //
  // `reasons` is ONE list holding two different kinds of sentence: what refused the ticket, and what the gate
  // DID to it on the way through (the stop cap, the take-profit offset, each size cap). The aggregator built its
  // refusal line as `'risk veto: ' + reasons.join('; ')`, so the line LED WITH WHICHEVER SENTENCE HAPPENED TO BE
  // PUSHED FIRST — and the stop-cap note is pushed long before any veto. Measured on the record: 14 live refusals
  // read `"risk veto: stop capped at 0.3% of price (declared 0.645%), venue cost ..."`, and the 3 newest carry
  // `vetoCodes: ["correlation"]` — i.e. **the prose named a resize the gate had PASSED as the reason it refused**.
  // That is the exact misattribution TRD-RSK-2 was written to end, still live in the prose channel because the
  // codes arrived after it. `vetoReasons` is what the refusal line reads now; `reasons` keeps every element, so
  // no existing consumer or count changes.
  const veto = (code, text) => { v.veto = true; v.vetoCodes.push(code); v.vetoReasons.push(text); reasons.push(text); };

  if (settings.kill && settings.kill.tier === 'hard') {
    veto('kill_switch_hard', 'kill switch: hard evacuation active');
    return v;
  }

  const open = openTrades || [];
  // TRD-12: the cap guards the AGENT's runaway — the user's own mirrored
  // Plus500 positions (note starts with 'mirrored from Plus500') don't
  // count, but they still count toward exposure.
  const agentOpen = open.filter((t) => !String(t.note || '').includes('mirrored from Plus500'));
  // ★★ THE INSTRUMENT'S CONTRACT SCALE (2026-10-01), resolved ONCE here and applied through `notionalFactor` at
  // every site that needs it — never re-derived. `1` is the identity, so Gold / Oil / Silver / Sugar (all
  // `pointValue 1.000000`) are COMPLETELY UNAFFECTED, which is what makes this change provable rather than
  // merely plausible: the whole suite's existing numbers must not move.
  const pointValue = Number.isFinite(Number(opts && opts.pointValue)) && Number(opts.pointValue) > 0
    ? Number(opts.pointValue) : 1;
  const notionalK = notionalFactor(pointValue, fx);
  // ⚠ PER SYMBOL FOR THE OPEN BOOK, for the same reason `fxBySymbol` is per symbol in the margin guard below: the
  // book can mix a cents-quoted contract with a dollar-quoted one, and applying the PROPOSAL's factor to all of
  // them would be a NEW unit error in the opposite direction.
  // ⚠ AN ABSENT MAP MEANS NO BEHAVIOUR CHANGE AT ALL (identity 1), which is what makes this safe to land before
  // every caller supplies one — the open-book sum keeps its exact current arithmetic until the caller threads it.
  const pointValueForSymbol = (sym) => {
    const m = opts && opts.pointValueBySymbol;
    if (!m) return 1;
    const raw = typeof m.get === 'function' ? m.get(sym) : m[sym];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  // ★★ P2: `size * openPrice` is the INSTRUMENT's currency, so the book's exposure was overstated by `fx`. It
  // had to be corrected in the SAME change as `fitExposureBudget`, because the budget compares
  // `cap - exposurePct` against `wantedPct` — converting one and not the other would have been a new unit bug.
  // ⚠ AND THE SAME ARGUMENT APPLIES TO `pointValue`, so it is applied PER POSITION here rather than once.
  v.exposurePct = open.reduce((sum, t) => sum + (Number(t.size) || 0) * (Number(t.openPrice) || 0)
    * notionalFactor(pointValueForSymbol(t.symbol), fx), 0) / (equity || 1) * 100;

  if (!proposal || proposal.type !== 'entry') return v; // exits don't add risk

  // TRD-109 (2026-09-20): FAIL CLOSED WHEN THE RISK BASELINE CANNOT BE EVALUATED.
  //
  // `killswitch.floorBreached` is fail-OPEN by construction: it answers `false` when it cannot compute,
  // which is the same answer as "not breached". With `kill.initialEquity` missing, the chain therefore
  // falls to `risk.initialEquity` — a stale hardcoded 2,685.76 against an equity near 4,000 — so the −8%
  // floor does not fire until roughly −38%, while every surface still reports the desk as armed.
  //
  // ENTRIES are refused in that state; the book is NOT evacuated. A refused entry is reversible and costs
  // an opportunity; a hard kill on missing data closes real positions. That asymmetry is why this sits
  // BELOW the exit short-circuit and why `floorBreached` keeps its old, narrow meaning for the one caller
  // that closes things.
  const floor = require('./killswitch').floorState(settings, equity);
  if (floor.status === 'unusable' || floor.source === 'risk_legacy') {
    veto('baseline_unusable', `risk baseline unusable (${floor.reason}) — entries are refused until a usable baseline is set, because the disaster floor cannot be evaluated`);
  }

  // AND THE SAME QUESTION ABOUT THE EQUITY ITSELF. The chain above ends `|| 0`, and a zero is not a small
  // account — it is an unavailable read that the sizing arithmetic would act on. In the state measured
  // 2026-09-20 the daily halt happened to refuse as well, but it refused with `-100% vs day start`, which
  // describes a drawdown that never happened. A number that does not mean what it says is the defect class
  // this desk keeps closing, so the true cause is stated here.
  if (!(Number(equity) > 0)) {
    veto('equity_unavailable', 'equity unavailable (the live read and both baselines are missing or non-positive) — entries are refused because there is nothing to size against');
  }

  // TRD-12: one position per symbol — a duplicate entry on a held symbol is
  // an absolute veto (this also covers the case where the correlation layer
  // is skipped because no series was provided).
  if (open.some((t) => String(t.symbol || '').toLowerCase() === String(proposal.symbol || '').toLowerCase())) {
    veto('already_held', `already holding ${proposal.symbol} — one position per symbol`);
  }

  // Position count cap
  if (agentOpen.length >= Number(risk.maxPositions ?? 3)) {
    veto('max_positions', `max positions (${risk.maxPositions}) reached`);
  }

  // Daily new-trade cap
  const todayCount = await store.countNewTradesToday(userId);
  if (todayCount >= Number(risk.maxNewTradesPerDay ?? 3)) {
    veto('max_new_trades', `daily new-trade cap (${risk.maxNewTradesPerDay}) reached`);
  }

  // IMPLIED GOAL #3: re-entry cooldown — after a close in the same symbol +
  // direction, block re-entry for N bars (default 6h). Kills turtle whipsaw.
  const cooldownBars = Number(risk.reentryCooldownBars ?? 6);
  if (cooldownBars > 0) {
    const cdMs = cooldownBars * 3600000; // 1h signal bars
    const recentClose = (closedTrades || []).some((t) => t.symbol === proposal.symbol
      && t.direction === proposal.direction && t.closeAt
      && Date.now() - new Date(t.closeAt).getTime() < cdMs);
    if (recentClose) {
      veto('reentry_cooldown', `re-entry cooldown: ${proposal.symbol} ${proposal.direction} closed within ${cooldownBars}h`);
    }
  }

  // TRD-12 Phase 2: daily-loss halt — after a -3% day (default), NO new
  // entries until the next UTC day. Exits/reviews keep running.
  const halt = await dailyHaltActive(userId, settings, equity);
  if (halt.halted) {
    // TRD-109: the halt can also be "cannot be evaluated", which is a different sentence from "-3% was
    // reached" — and the difference is the whole point of the fix, so it is carried into the reason.
    veto('daily_halt', halt.reason
      ? `daily-loss halt: ${halt.reason}`
      : `daily-loss halt: ${halt.drawdownPct}% vs day start (threshold -${halt.thresholdPct}%)`);
  }

  const atrV = Number(proposal.atr14);
  const price = Number(proposal.price);
  if (!atrV || atrV <= 0 || !price || price <= 0) {
    veto('data_missing', 'insufficient volatility/price data for sizing');
    return v;
  }

  // Turtle sizing: size = equity * riskPerTradePct% / stop distance.
  // P0-4 (2026-09-10): stop distance floor = minStopToSpread x live spread —
  // widens the 2xATR stop on thin instruments so a stop can't sit inside
  // spread noise (BTC spread/ATR = 0.46 passes untouched; size shrinks when
  // the floor binds so the per-trade risk stays constant).
  const riskPerTrade = Number(risk.riskPerTradePct ?? 1) / 100;
  const minN = Number(risk.minStopToSpread ?? 3);
  const spread = proposal.spread != null && Number(proposal.spread) > 0 ? Number(proposal.spread) : null;
  // ★★ 2026-10-18: `risk.atrStopMultiple` WAS A DEAD DIAL — PRESENT IN SETTINGS, READ NOWHERE.
  //
  // It has been in `TradingSettings.risk` (value 2) since the schema, and this line hard-coded `2 * atrV`.
  // So the one setting a reader would reach for to change stop width did nothing at all, while looking
  // exactly like the dial that decides it. Measured 2026-10-19 across 17,868 historical breakouts: stop width
  // is the single largest lever the desk has (mean net R improves monotonically from -0.105 at 2xATR to
  // -0.017 at 8xATR, because cost-in-R = spread% / stop% and widening the stop is the only term that shrinks),
  // so a dead dial on exactly that quantity is worse than no dial.
  //
  // ⚠ BEHAVIOUR-NEUTRAL AT ITS CURRENT VALUE. `atrStopMultiple` is 2 today, so `atrMultiple * atrV` is
  // byte-identical to the `2 * atrV` it replaces; absent/invalid/non-positive falls back to 2 for the same
  // reason (`minStopToSpread` above does the same). The change makes the setting REAL; it does not move a stop.
  const atrMultiple = Number(risk.atrStopMultiple) > 0 ? Number(risk.atrStopMultiple) : 2;
  const stopDist = spread && minN > 0 ? Math.max(atrMultiple * atrV, minN * spread) : atrMultiple * atrV;
  // TRD-102 (2026-09-19): SIZE AGAINST THE STOP THE VENUE WILL ACTUALLY USE.
  //
  // TRD-98 capped the venue stop in the entry path while sizing stayed on the declared 2xATR, so every
  // risk number in this block described a position that was never going to exist: `maxRiskPerTradePct:
  // 0.25` produced a REALISED 0.026% of equity on the first live entry (#1066, Oil), and the error was
  // per symbol because declared:capped is Oil 4.7x and Gold 1.9x. That is the TRD-96/TRD-101 defect class
  // again — a number that does not mean what it says. The cap now comes from the one shared place
  // (agent/stopPolicy.js) and `riskStopDist` IS the venue distance, so the risk cap means the risk taken
  // and means the same thing on every symbol.
  //
  // The DECLARED distance is still carried out as `v.stopDistance`, because the take-profit is placed at
  // 1.5 x declared: tightening the stop while leaving the target where it was is exactly what raises the
  // reward:risk, and tightening both would only scale the trade down and change nothing.
  const stopCap = require('./stopPolicy').cappedStopDistance({ declaredStopDist: stopDist, price, settings, symbol: proposal.symbol });
  const riskStopDist = stopCap.cappedBy ? stopCap.stopDist : stopDist;
  if (stopCap.cappedBy) {
    // ⚠ `costPct` IS NOT ROUNDED AT ITS SOURCE — `stopPolicy` returns `rtBps / 100` raw, and every OTHER consumer
    // rounds it at the point of display (`costPct.toFixed(4)` in stopPolicy's own notes and in
    // `aggregator.ticketGeometryNote`). This interpolation was the one that did not, so the OWNER-FACING card read
    // `venue cost 0.11939999999999999% = 40% of R`: seventeen significant figures, on a figure derived from tick
    // percentiles, implying a precision the measurement does not have. Rounded here to match its siblings —
    // 0.1194% is the same number every other surface prints.
    reasons.push(`stop capped at ${stopCap.capPct}% of price (declared ${(stopDist / price * 100).toFixed(3)}%), venue cost ${Number(stopCap.costPct).toFixed(4)}% = ${(stopCap.costPct != null ? (stopCap.costPct / ((riskStopDist / price) * 100) * 100).toFixed(0) : '?')}% of R`);
  } else if (stopCap.note) {
    reasons.push(stopCap.note);
  }
  // ★ THE CHAIR MUST KNOW THE TARGET'S GEOMETRY BEFORE IT VOTES (owner ask 2026-09-25). The offset is a POLICY
  // read from settings, not a per-trade number, so it is knowable at deliberation time — which is what makes it
  // legitimate to surface here. `reasons` is the channel the chair already reads (aggregator builds its sizeNote
  // from it) AND the channel the decision card renders as `riskReasons`, so this one push makes the policy
  // visible to the seat that is voting and to the record afterwards, with no new plumbing.
  // ⚠ It is pushed whether or not it binds, and the note says so, because a chair reasoning about a 2R target
  // that is really 1.8R is reasoning about a trade that does not exist.
  const tpOffset = Number(risk.takeProfitOffsetPct);
  if (Number.isFinite(tpOffset) && tpOffset > 0) {
    reasons.push(`take-profit pulled in ${tpOffset}% of its own distance (owner setting): the target sits closer to the entry so a near-miss books a win, and the effective R:R falls by the same proportion`);
  }
  // TRD-114 (2026-09-21): THE ROUND TRIP AS A SHARE OF THE RISK UNIT IS NOW GATED, not just printed.
  //
  // 2026-09-21: eight consecutive Gold entries were declined by the CHAIRS while the card showed the risk
  // engine's notes ("venue cost 0.1194% = 40% of R") as if they were the reason. They were not — the risk
  // gate had NOT vetoed, and `costShareOfR` was computed in stopPolicy and read by nothing. So the desk
  // spent a full three-seat fan-out per wake reaching a conclusion that is arithmetic, and the reader was
  // told the engine stopped a trade the engine had passed.
  //
  // The share is INVARIANT TO SIZE (notional cancels out of costPct/stopPct), so it cannot be fixed by
  // resizing; and it cannot be fixed by tightening the stop either, because a tighter stop RAISES the
  // share — that is the opposite direction to TRD-98's cap, and the cap is the measured-best lever
  // (-28.89 net at 0.30% vs -46.93 at the 0.40% a tight ceiling would demand). So this REFUSES and never
  // widens: the stop the venue receives stays exactly what stopPolicy decided above.
  const shareCheck = require('./stopPolicy').costShareCheck({
    costPct: stopCap.costPct, stopPct: (riskStopDist / price) * 100, settings,
  });
  // The ceiling is recorded even when the share could NOT be measured, and the share is recorded as null
  // rather than omitted: "no cost basis" is a distinct state from "not checked" and from "zero", which is
  // the same discipline TRD-88 imposed on an unmeasurable excursion.
  v.costShareCeiling = stopCap.ceiling;
  v.costShareOfR = shareCheck ? shareCheck.share : null;
  if (shareCheck && shareCheck.over) {
    veto('cost_ceiling', `cost ceiling: the venue round trip ${stopCap.costPct.toFixed(4)}% is ${(shareCheck.share * 100).toFixed(1)}% of the ${((riskStopDist / price) * 100).toFixed(4)}% risk unit (ceiling ${(shareCheck.ceiling * 100).toFixed(1)}%, from ${shareCheck.from}) — resizing cannot change this ratio and a tighter stop would only raise it`);
    return v;
  }
  // ★★ TRD-EXE-10 (2026-09-30): SIZE AGAINST THE LOSS THE STOP ACTUALLY TAKES, NOT THE DISTANCE IT SITS AT.
  //
  // `riskStopDist` is how far the venue's stop LEVEL sits from entry, and every number in this block used to be
  // derived from it as though a trigger there produced a loss of exactly that size. It does not. MEASURED over
  // the desk's whole journal — 24 venue stop-outs across 14 days, each carrying BOTH the venue's quoted rate AND
  // the real fill, so the two readings could be compared ON THE SAME TRADE:
  //
  //     stop-out, exit at the venue's RATE   median 1.006x the stop distance   <- the trigger IS the level
  //     stop-out, exit at the actual FILL    median 1.305x the stop distance   <- p90 1.431, max 4.370
  //     take-profit, at the venue's RATE     median 1.009x                     <- same shape, both sides
  //     take-profit, at the actual FILL      median 1.294x
  //
  // The symmetry is the tell, and it is right in kind rather than an artifact: the recorded RATE sits ON the
  // level and the FILL is what travels. A take-profit is a LIMIT, so it can fill BETTER when price gaps through
  // it; a stop becomes a STOP-MARKET on trigger, so it fills WORSE. Neither side is level-precise, and price
  // keeps moving ~30% of the intended distance while the close executes. (The 4.37x outlier is #1066, Oil, a
  // 0.284% stop on a weekend — a gap, and the reason the MEDIAN is used rather than the mean, which that one
  // row drags to 1.449.)
  //
  // WHAT IT MEANS: a `riskPerTradePct` of 3 produced a REALISED stop-out loss of ~3.9% of equity. The setting is
  // a risk control, so it must mean the loss it produces — this sizes on the measured loss distance and leaves
  // the stop LEVEL untouched.
  //
  // ⚠ WHAT THIS DOES NOT DO, stated so the row is not closed on a false premise: it does NOT improve the edge.
  // The favourable side overshoots by the same 1.294x, so a uniform shrink scales the whole P&L distribution by
  // that factor — this is a DE-LEVER that makes `riskPerTradePct` true, not a source of return. And the r=3.0%
  // choice is unaffected, because that experiment derived R from `grossPnl`, which already contains the
  // overshoot on both sides.
  //
  // ⚠ AN OUT-OF-RANGE FACTOR IS REPORTED, NEVER SILENTLY CLAMPED. A control that quietly ignores its setting is
  // the defect this repo keeps re-finding. A factor below 1 asserts a stop-out loses LESS than the stop distance,
  // which these 24 rows disprove, so it is refused in the open and 1 is used.
  const lossFactorRaw = Number(risk.stopSlippageFactor);
  const lossFactorUsable = Number.isFinite(lossFactorRaw) && lossFactorRaw >= 1;
  const lossFactor = lossFactorUsable ? lossFactorRaw : 1;
  // ★★ TRD-EXE-13 (2026-10-01) — THE ENTRY-SIDE TWIN OF `lossFactor`, AND INERT UNTIL SWITCHED ON.
  //
  // The block above already sizes against the distance the LOSS travels on the way OUT (`stopSlippageFactor`,
  // measured on 24 stop-outs). This is the same correction for the way IN. Measured over the 73 recorded
  // `entry_reanchored` events, each carrying both the decision price and the sized stop distance:
  //     n=73   adverse fills = 54 (74.0%)   realised/sized distance: avg 1.083x   min 0.486x   max 2.518x
  // so the stop the position actually sits behind is further away than the stop it was sized against, and the
  // risk taken is larger than the dial says. Same shape as the exit side, same shape as TRD-102.
  //
  // ⚠ DEFAULT IS 1, WHICH IS NOT A PLACEHOLDER — IT IS THE DECISION. The plan (P3) split this from its siblings
  // as a DELIBERATE CHOICE rather than prescribed work, because it compounds with P2's ~22% size reduction and it
  // changes live posture. So the CAPABILITY is built, tested and recorded on every decision, and switching it on
  // is one key. Shipping it ON would have been a second unapproved posture change in one session — and the two
  // would then be indistinguishable in the record, which is the conflation this review has already been bitten by.
  //
  // ⚠ BELOW 1 IS REPORTED, NEVER SILENTLY CLAMPED — the same discipline as `stopSlippageFactor` above. A factor
  // under 1 asserts entries fill BETTER than the decision price on average, which 54 of 73 rows disprove.
  const driftRaw = Number(risk.entryDriftFactor);
  const driftUsable = Number.isFinite(driftRaw) && driftRaw >= 1;
  const driftFactor = driftUsable ? driftRaw : 1;
  // Each message reports ONLY its own component: `entryLossDist` is the exit half, `expectedLossDist` the sum.
  // Letting the exit-side message quote the combined figure would label one factor's effect with another's number.
  const entryLossDist = riskStopDist * lossFactor;
  const expectedLossDist = entryLossDist * driftFactor;
  if (Number.isFinite(lossFactorRaw) && !lossFactorUsable) {
    reasons.push(`stopSlippageFactor ${lossFactorRaw} is below 1 and was IGNORED — it would assert a stop-out loses LESS than the stop distance, which the measured 24 stop-outs disprove (median 1.305x); sizing used 1`);
  } else if (lossFactor > 1) {
    reasons.push(`★ sized on the MEASURED LOSS distance, not the stop's level: the venue's stop fills ~${lossFactor.toFixed(3)}x its own distance (24 stop-outs, 14d, median) — the risk unit is ${(entryLossDist / price * 100).toFixed(4)}% of price rather than ${(riskStopDist / price * 100).toFixed(4)}%, so the dial means the loss it produces. The stop LEVEL is unchanged`);
  }
  if (Number.isFinite(driftRaw) && !driftUsable) {
    reasons.push(`entryDriftFactor ${driftRaw} is below 1 and was IGNORED — it would assert entries fill BETTER than the decision price on average, which 54 of 73 measured entries disprove (mean 1.083x); sizing used 1`);
  } else if (driftFactor > 1) {
    reasons.push(`★ sized on the ENTRY DRIFT as well: 74% of 73 entries filled adverse to the decision price and the realised stop distance averages ${driftFactor.toFixed(3)}x the sized one (max 2.518x), so the risk unit is ${(expectedLossDist / price * 100).toFixed(4)}% of price and sizes are ~${((1 - 1 / driftFactor) * 100).toFixed(0)}% smaller than the dial alone would give. The stop LEVEL is unchanged`);
  }
  // ★★ TRD-EXE-19 (2026-10-01) — THE SIZE DERIVATION WAS MISSING `pointValue`. A NINTH SITE, AND ITS SIGN IS
  // THE OPPOSITE OF THE FIRST EIGHT.
  //
  // `size = equity x riskPct / distance` treats ONE QUOTE UNIT as ONE UNIT OF ACCOUNT CURRENCY. It is not. The
  // loss a position actually takes is `size x distance x pointValue x fx` — the notional product with `distance`
  // in place of `price` — so exactly the same two scales are missing, and the error runs the other way:
  //
  //     missing `pointValue` on a NOTIONAL -> the position looks BIGGER than it is -> the caps bind early
  //     missing `pointValue` on the RISK    -> the position comes out SMALLER        -> the venue floor vetoes
  //
  // Soybeans quotes in CENTS (`pointValue 0.01`), so its size came out 1/0.0129 = 77.5x too small once `fx` is
  // included: the dial wanted ~656 bushels, the desk computed **8.4641**, the venue's floor is **15**, and every
  // entry was refused on `venue_minimum`. ⚠ THE REFUSAL SAID SO AND WAS NOT BELIEVED — *"and NOTHING was capped:
  // the size comes out below the minimum on its own"* was TRUE, and it was the signature of this line, printed
  // with the desk's own arithmetic reframed as the venue's fault.
  //
  // ⚠ TWO HELPERS, NOT SIX MULTIPLICATIONS. `size x distance` becomes a risk fraction at six sites in this file,
  // and the expensive version of this defect is the one where five of them get fixed. The previous sweep's own
  // conclusion — *"one function, called from every site, is what makes the next missing factor a ONE-LINE change
  // instead of a hunt"* — is why this was an edit and not a search, and it is what stops the sixth site next time.
  //
  // ⚠ `notionalK` IS NOT RE-DERIVED HERE. It is `notionalFactor(pointValue, fx)` from line 524, 236 lines up, and
  // that function fails safe to a finite value > 0 — so neither helper can divide by zero.
  const riskPctOf = (s, dist) => {
    const n = Number(s);
    const d = Number(dist);
    if (!Number.isFinite(n) || !Number.isFinite(d) || !(Number(equity) > 0)) return null;
    return ((n * d * notionalK) / equity) * 100;
  };
  // The inverse. `frac` is a FRACTION (0.036 means 3.6%), matching how `riskPerTradePct` is used here — passing a
  // percentage and dividing by 100 would round-trip `3.6/100*100` to 3.6000000000000005 and quietly break the
  // identity below.
  const sizeForRisk = (frac, dist) => {
    const d = Number(dist);
    const f = Number(frac);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(f)) return null;
    return (equity * f) / (d * notionalK);
  };
  // ⚠ `notionalK === 1` MUST LEAVE EVERY NUMBER BELOW BYTE-IDENTICAL — the same discipline the notional sweep
  // was held to, and the reason every existing test still means what it always meant.
  let size = sizeForRisk(riskPerTrade, expectedLossDist);
  if (spread && minN * spread > atrMultiple * atrV) reasons.push(`stop widened to ${minN}x spread (${(minN * spread).toFixed(4)} > ${atrMultiple}xATR ${(atrMultiple * atrV).toFixed(4)})`);
  v.stopDistance = Math.round(stopDist * 10000) / 10000;
  // The risk unit the venue will actually enforce, and the cap's disposition — recorded, never inferred.
  v.effectiveStopDistance = Math.round(riskStopDist * 10000) / 10000;
  // ★ TRD-EXE-13: the entry-drift multiplier travels with the decision, so "was the drift modelled?" is
  // answerable from the record instead of from the settings at the time. 1 means it was not.
  v.entryDriftFactor = driftFactor;
  // TRD-EXE-10: the distance the LOSS travels, beside the distance the stop SITS at. Present-and-null discipline
  // does not apply here — both are always numbers once we reach this line.
  v.stopSlippageFactor = lossFactor;
  v.expectedLossDistance = Math.round(expectedLossDist * 10000) / 10000;
  v.stopCap = stopCap.cappedBy
    ? {
      cappedBy: stopCap.cappedBy, capPct: stopCap.capPct, costPct: stopCap.costPct,
      // TRD-114: renamed from `costShareOfR` to the name the gate uses, and carried whether or not the cap
      // bound — a study reading this record should not have to know which branch produced it.
      costShare: stopCap.costShare, ceiling: stopCap.ceiling, ceilingFrom: stopCap.ceilingFrom,
      // ★ L4 (2026-09-29): `floor` IS NOW CARRIED, and it was dropped here until now. `stopPolicy` has always
      // computed it (`costPct x maxAdverseCostMultiple`, the threshold below which the cap is REFUSED outright),
      // and the seat-facing note in `aggregator.ticketGeometryNote` has always had a branch that prints it —
      // against a key this line never copied, so the branch could not fire. That is the "surface that looks
      // authoritative and isn't" class, one layer down from the same defect in the note's `pct`/`capPct` read.
      floor: stopCap.floor,
    }
    : null;

  // IMPLIED GOAL: run-in factor — half risk until the parity harness
  // validates the engine; mean-reversion family always takes half the turtle
  // budget.
  //
  // ⚠ TRD-80 (2026-09-20): AND "THE ENGINE" MEANS *THIS STRATEGY*, NOT THE DESK. This used to read one
  // desk-wide flag that `analytics` derives as "at least one enabled strategy reached accept", so the moment
  // survgold's evidence justified full size, survoil would have been sized on evidence it never earned —
  // 89 weeks of it (`repro/parity-horizon.js` prints the spillover list). `runInFactorFor` reads the
  // strategy's OWN verdict; the desk-wide flag stays as an explicit override and as the tuner's live-desk gate.
  const runInFactor = runInFactorFor(proposal.strategy, settings);
  if (runInFactor < 1) { size *= runInFactor; reasons.push(`run-in factor ${runInFactor} (this strategy is not parity-validated)`); }
  if (proposal.strategy === 'meanrev' || proposal.strategy === 'rsi2') { size *= 0.5; reasons.push(`${proposal.strategy} half risk`); }

  // Cap: position value may not exceed maxEquityPerPositionPct% of equity
  // ★ L4 (2026-09-29): `boundBy` NAMES THE CONTROL THAT DECIDED THE SIZE. Every control below can only ever
  // SHRINK `size`, so the LAST one to shrink it is the tightest constraint — and with five controls composed in
  // a chain, an operator reading four separate notes has to compose the answer themselves (the measured complaint
  // in TRD-RSK-6 / #1457). `cappedAtPct` cannot supply this: it is written UNCONDITIONALLY from the setting, so
  // it reports what the cap IS, never whether it ACTED (§1.1b). Same shape as `stopCap.cappedBy`, which is null
  // when the cap does not act. A run-in or half-risk MULTIPLIER never sets it: it scales the dial rather than
  // bounding the ticket, and it is not one of the enumerated controls.
  let boundBy = null;
  // ★ TRD-RSK-11 (2026-09-29) — `cappedAtPct` USED TO BE WRITTEN UNCONDITIONALLY FROM THE SETTING. It was
  // present whether or not the cap truncated anything, so it reported what the cap IS and never whether it
  // ACTED — and `fieldContracts.riskUnit` read its mere presence as proof the cap bound, which made that
  // contract's `explained` flag ALWAYS TRUE and its warn branch unreachable. A field that is always present is
  // not evidence of anything. It is now set in the branch that truncates, which is the shape `boundBy` and
  // `stopCap.cappedBy` already use (null = did not act).
  // ⚠ THE FIELD AND ITS READER ARE ONE CHANGE: making this nullable without the reader ceasing to treat
  // presence as proof would have swapped a false "explained" for a false "unexplained" (TRD-RSK-11 #1468).
  let cappedAtPct = null;
  // Resolved ONCE so the cap, the field and the reason string cannot print three different numbers.
  const maxEquityPerPositionPct = Number(risk.maxEquityPerPositionPct ?? 5);
  const maxValue = equity * (maxEquityPerPositionPct / 100);
  // ★★ P2 — THE DEFECT ITSELF. `size * price` is the INSTRUMENT's currency and `maxValue` is the ACCOUNT's, so
  // this comparison ran across two currencies and its real ceiling was `capPct x fx`. Measured: cap 40 bound at
  // 51.25% (fills 50.0-50.9%) and cap 35 at 44.84% (fills 44.0-44.3%).
  // ⚠⚠ AND THE SAME OMISSION HID A SECOND FACTOR FOR MONTHS (2026-10-01): the ceiling is a percentage of the
  // ACCOUNT's equity, so the left side must be the ACCOUNT's notional — which needs BOTH scales. `notionalK` is
  // `pointValue x fx`. Without `pointValue`, Soybeans (cents-quoted, 0.01) read 100x too large, this cap bound at
  // 0.69 instead of ~69, and the size fell under the venue's 15-bushel minimum — so the desk refused every entry
  // while REPORTING the venue's minimum as "~487% of equity", which was this arithmetic error wearing authority.
  if (size * price * notionalK > maxValue) {
    size = maxValue / (price * notionalK);
    boundBy = 'maxEquityPerPositionPct';
    cappedAtPct = maxEquityPerPositionPct;
    reasons.push(`size capped at ${maxEquityPerPositionPct}% equity`);
  }

  // TRD-97 (2026-09-19): A NOTIONAL CAP IS PRICE-DEPENDENT; A RISK CAP IS NOT.
  //
  // Measured 2026-09-18: `maxEquityPerPositionPct: 40` is expressed as position VALUE, so it binds on
  // the expensive symbol and not on the cheap one. Gold ($4374) was clamped to 0.2456 units = 0.226% of
  // equity actually at risk, while Oil (~$98) kept its risk-based 9.41 units = 0.553% — 2.4x the risk,
  // on the symbol whose measured edge is NEGATIVE (MFE 0.449% < MAE 0.713% + 0.173% cost). The dial was
  // not merely inert; it was inconsistent, and inconsistent in the wrong direction. This caps the RISK
  // the size implies, which is the same number for every symbol and is what `riskPerTradePct` was always
  // supposed to mean. It can only ever SHRINK a size, and it is applied after the notional cap so the
  // two guards compose downward instead of fighting.
  // TRD-102: this cap is evaluated against `riskStopDist` — the distance the venue stop actually sits at —
  // so `maxRiskPerTradePct` is the realised risk rather than a figure derived from a stop the position
  // will never use. Before this it read the declared distance and under-reported the cap's meaning by the
  // cap ratio (Oil 4.7x, Gold 1.9x), which is how a 0.25% label produced 0.026% of equity at the venue.
  const maxRiskPct = Number(risk.maxRiskPerTradePct);
  if (Number.isFinite(maxRiskPct) && maxRiskPct > 0) {
    const impliedRiskPct = riskPctOf(size, expectedLossDist);
    v.impliedRiskPct = +impliedRiskPct.toFixed(4);
    if (impliedRiskPct > maxRiskPct + 1e-9) {
      size = sizeForRisk(maxRiskPct / 100, expectedLossDist);
      boundBy = 'maxRiskPerTradePct';
      reasons.push(`size capped at ${maxRiskPct}% risk/trade (implied ${impliedRiskPct.toFixed(3)}% of equity)`);
    }
  }
  if (size <= 0) { veto('size_zero', 'computed size <= 0'); return v; }

  // TRD-12 Phase 2 (recomposed 2026-09-11): portfolio exposure budget — total
  // exposure (open + this proposed position) may not exceed exposureCapPct of
  // equity. The budget BINDS BY RESIZING, it does not veto: the per-position
  // cap can clamp the risk-based size ABOVE the budget (cap 80% vs budget
  // 50%), and vetoing there quarantines every tight-stop entry forever (the
  // 2026-09-11 Oil/Gold incident — both survivors vetoed while the book was
  // flat). The trade opens SMALLER at the same stop; the hard veto remains
  // only when the book has no room left.
  const exposureCap = Number(risk.exposureCapPct ?? 15);
  // ★ TRD-EXE-7 (#1475) — THE BUDGET MUST SEE WHAT THIS WAKE HAS ALREADY COMMITTED. `v.exposurePct` is read from
  // the OPEN book, and open positions only exist AFTER a wake places them. So two entries accepted in the SAME wake
  // each saw the pre-wake book and each took the full remaining room: measured 2026-09-29, wake #5661 sized Silver
  // 34.15% and Sugar 34.15% against a 50% cap whose remaining room was 37.29% for EACH, taking the book to 81.01%.
  // The caller now threads `opts.committedPct` — the running notional% of everything this wake has already
  // accepted — and the budget is checked against the SUM.
  //
  // ⚠ THE TWO NUMBERS ARE KEPT APART ON PURPOSE. `v.exposurePct` stays the TRUE open exposure, because a report
  // asking "how exposed is the book" must not be answered with a number that includes tickets never filled. The
  // budget uses the sum; the record carries both, so the difference is visible rather than folded away.
  const committedPct = Number.isFinite(Number(opts && opts.committedPct)) ? Math.max(0, Number(opts.committedPct)) : 0;
  v.exposureCommittedPct = committedPct;
  const budgetPct = v.exposurePct + committedPct;
  const fit = fitExposureBudget({ size, price, exposurePct: budgetPct, exposureCapPct: exposureCap, equity, fx, pointValue });
  if (fit.fitted && fit.size > 0) {
    const finalPct = (fit.size * price * notionalK) / (equity || 1) * 100;
    reasons.push(`sized down to exposure budget: ${v.exposurePct.toFixed(1)}% open + ${committedPct ? `${committedPct.toFixed(1)}% committed this wake + ` : ''}${fit.wantedPct.toFixed(1)}% wanted > ${exposureCap}% cap -> ${finalPct.toFixed(1)}% position`);
    size = fit.size;
    boundBy = 'exposureCapPct';
  } else if (fit.full) {
    veto('exposure_budget', `exposure budget full: ${v.exposurePct.toFixed(1)}% open${committedPct ? ` + ${committedPct.toFixed(1)}% committed this wake` : ''} >= ${exposureCap}% cap`);
  }

  // Correlation veto: proposed symbol vs each open position, on 30-day
  // log-returns of 1h closes (P1-9 method; threshold 0.7 for a 3-slot book).
  //
  // ★ TRD-RSK-3: the window is now ACTUALLY 30 days — see CORR_WINDOW_DAYS. Until 2026-09-28 it read
  // 12,000 bars with no date filter, i.e. 733 days, while this sentence and the refusal both said "30d".
  // ⚠ THE THRESHOLD'S STATED JUSTIFICATION IS STALE AND I HAVE NOT CHANGED THE VALUE. "for a 3-slot book"
  // was written when `maxPositions` defaulted to 3; the live setting is **10**, so 0.7 is not derived from
  // the live slot count and this sentence was the only place that claimed it was. Raising or lowering a live
  // risk threshold is an OWNER decision, not housekeeping, so it is left at 0.7 with the measurement on the
  // record instead: on the correct 30-day window Gold|Silver reads **0.688**, which is 0.012 UNDER this
  // threshold and was 0.7763 under the wrong one. That 0.012 margin is also why the two defects interact —
  // see TRD-RSK-5 / #1456, which is the reason the veto is re-asked below rather than trusted to the snapshot.
  const clash = await correlationClash(userId, risk, proposal.symbol, open, { proposal });
  if (clash) veto('correlation', clash.text);

  // TRD-45 Phase 1 (2026-09-14): THE VENUE'S MINIMUM TRADE SIZE, which this formula has never had a
  // floor for. `size = equity x riskPct / stopDist` can return less than the smallest amount the
  // venue will accept, and Phase 0 measured how wide that gap really is: on one chain the Gold spot
  // CFD starts at 0.025 Troy Ounces while the options around the same underlying start between 1.5
  // and 15 "Options" — a 600x spread in the floor within one instrument family.
  //
  // It VETOES rather than clamping upward. Clamping would quietly exceed the risk `riskPerTradePct`
  // promised, and it would do so exactly on the tightest-stop proposals, which are the ones the
  // formula sizes smallest. An unmeetable minimum means the trade does not fit this dial.
  //
  // An UNKNOWN minimum (empty registry, or a field the capture did not carry) ALLOWS the trade and
  // says so. That is deliberate: the registry starts empty, and the point is that "we don't know" is
  // recorded and distinguishable from "we checked" — the TRD-43 lesson — not that it halts the desk.
  try {
    const floor = await require('./instruments').checkSize(userId, {
      symbol: proposal.symbol, size, instrumentClass: proposal.instrumentClass || 'spot',
    });
    // L1: the venue's ratio, coerced once and proven positive before anything reads it. `Number(null) === 0`
    // would otherwise turn an absent leverage into "the venue permits zero notional".
    const venueLev = Number(floor.resolved ? floor.resolved.leverage : null);
    const venueLevKnown = Number.isFinite(venueLev) && venueLev > 0;
    v.venueFloor = {
      ok: floor.ok, reason: floor.reason, detail: floor.detail || null,
      minUnits: floor.resolved ? floor.resolved.minUnits : null,
      unitKind: floor.resolved ? floor.resolved.unitKind : null,
      instrumentClass: floor.resolved ? floor.resolved.instrumentClass : null,
      // THE INSTRUMENT THIS FLOOR BELONGS TO, carried so the ENTRY can record it (migration 055). `resolve` already
      // returned it and this block dropped it, which is why `constraintAudit` had to re-derive the id by symbol at
      // audit time — a reconstruction, not a record.
      venueInstrumentId: floor.resolved && floor.resolved.venueInstrumentId != null ? String(floor.resolved.venueInstrumentId) : null,
      // PROVENANCE FOR A HUMAN READER, NOT FOR A CONTROL. This is the age of the fact the floor was derived from,
      // and it stays because a later audit has to be able to ask "how old was that minimum when the desk sized against
      // it" without re-reading the registry, which by then holds a newer row.
      // NOTHING ACTS ON THIS FIELD (one write, zero reads). What acts on age is the chair prompt, via
      // instruments.venueCostFacts -> specAgeHours -> costFactLines, which says UNVERIFIED past 168h. Before
      // 2026-10-27 the field was written here and the prompt said nothing, so the age was computed and never judged.
      capturedAt: floor.resolved ? floor.resolved.capturedAt : null,
      // ★ L1 (rev 5, 2026-09-29) — THE VENUE'S CAPACITY, BESIDE THE VENUE'S FLOOR. DATA ONLY: no control
      // below reads these, and no size changes because of them. They are here because the desk has never
      // been able to state what it COULD buy, and that absence is why a control named for "equity" has
      // been read as a fraction of equity when it is a multiple of it — `maxEquityPerPositionPct = 80` is
      // 16% of Gold's purchasing power (§1.1a), and nothing in the desk could say so.
      //
      // `purchasingPower = equity x leverage` is the notional ONE position in this symbol may hold. It is
      // the denominator the per-position cap is silently measured against, and the ratio the ceiling
      // `L x stopPct` (rev 4) is built from: Gold at 1:5 caps a 0.550% stop at 2.75%, Bitcoin at 1:1.67
      // caps it at 1.16% — a 2.4x spread in the ceiling between two symbols on identical settings.
      //
      // PRESENT-AND-NULL, NOT ABSENT. An unread registry row must not present as "leverage 0" or as a
      // field that simply is not there: `Number(null) === 0` is the most repeated defect in this repo,
      // and "we could not read the venue's capacity" has to stay distinguishable from "the venue
      // permits nothing". Same discipline as `minUnits` and `maintenanceMarginPct` above.
      leverage: venueLevKnown ? venueLev : null,
      initialMarginPct: floor.resolved ? floor.resolved.initialMarginPct : null,
      maintenanceMarginPct: floor.resolved ? floor.resolved.maintenanceMarginPct : null,
      purchasingPower: venueLevKnown && Number.isFinite(equity) ? +(equity * venueLev).toFixed(2) : null,
    };
    if (!floor.ok) {
      // ★ 2026-09-28 — THE OWNER ACCEPTED THE FLOOR'S RISK, SO THE CLAMP-UP IS NOW AVAILABLE UNDER A DIAL.
      //
      // This module's header argues against clamping upward, and the argument is specifically about doing it
      // QUIETLY: *"Clamping would quietly exceed the risk `riskPerTradePct` promised."* `risk.acceptVenueFloor`
      // (default FALSE) answers that objection rather than overriding it — the exceedance is named in
      // `reasons`, carried on `venueFloor.accepted` with its multiple, printed in the TICKET GEOMETRY note the
      // SEAT reads, and recorded on every decision row.
      //
      // THE MEASURED MOTIVE: SGX's 20-Share floor forces 0.1640% of equity against the 0.07% dial (2.34x), while
      // every other symbol's floor sits at 0.11x-0.78x. The `venue_minimum` veto fired 18 times in 2h24m on
      // 2026-09-28, every one of them SGX.
      const acceptFloor = risk.acceptVenueFloor === true;
      const minUnits = Number(floor.resolved && floor.resolved.minUnits);
      if (acceptFloor && Number.isFinite(minUnits) && minUnits > 0) {
        const atSizePct = equity > 0 ? (size * riskStopDist / equity) * 100 : null;
        const forcedPct = atSizePct != null && size > 0 ? atSizePct * (minUnits / size) : null;
        const multFloor = forcedPct != null && atSizePct != null && atSizePct > 0 ? forcedPct / atSizePct : null;
        size = minUnits; // <- the clamp. Everything below derives from this, incl. v.size and sizeCalc.finalSize.
        v.venueFloor = {
          ...v.venueFloor,
          accepted: true,
          acceptedSize: minUnits,
          intendedRiskPct: atSizePct,
          forcedRiskPct: forcedPct,
          multiple: multFloor,
        };
        const unit = v.venueFloor.unitKind ? ` ${v.venueFloor.unitKind}` : '';
        reasons.push(`venue floor ACCEPTED (owner setting): the venue's minimum ${minUnits}${unit} exceeds the computed size, so the size was RAISED to the floor — this ticket carries ${forcedPct != null ? forcedPct.toFixed(4) : '?'}% of equity instead of ${atSizePct != null ? atSizePct.toFixed(4) : '?'}% (${multFloor != null ? multFloor.toFixed(2) + 'x' : 'several x'} the intended risk)`);
      } else {
        // ★★ TRD-RSL-1 (2026-09-30) — NAME THE CONSTRAINT THAT ACTUALLY BOUND.
        //
        // The floor was being tested against the size the EXPOSURE BUDGET had already cut down, so the refusal
        // blamed the venue for a constraint the portfolio created. Measured on Sugar: `computed 1.4879 < venue
        // minimum 15 Contracts`, where the budget line on the same ticket reads `70.4% open + 28.9% committed this
        // wake ... > 100% cap`. Sugar's minimum ticket is ~9.0% of equity and the budget had 0.7% left - a 13x
        // shortfall - so no size the budget permitted was ever tradable, and the number in the refusal was never a
        // candidate position. A reader of that sentence concludes the venue is too strict; the truth is the book is
        // at 99.3% of its cap.
        //
        // ⚠ THE CODE STAYS `venue_minimum`, AND THAT IS DELIBERATE. It has exactly one emission site (pinned by
        // test), and two weeks of refusal history is attributed to it - reassigning that history to a new code
        // would make the archive mean something it did not mean when it was written. The DETAIL now carries which
        // control bound and by how much, which is the fact the old sentence was missing.
        const minUnitsNote = Number(floor.resolved && floor.resolved.minUnits);
        // ★★ THE EIGHTH AND MOST MISLEADING SITE (2026-10-01). This note computes the venue's minimum in the
        // ACCOUNT's currency, and it was missing BOTH scales — `pointValue` AND `fx` — so P2's sweep never reached
        // it. It is the one that produced:
        //
        //     "the venue's minimum 15 Bushels is ~487.6% of equity, so no size that control allows is tradable"
        //
        // On Soybeans it evaluated `15 x 1290.98 / 3963.61 = 488.6%` while the truth is `15 x 1290.98 x 0.01 =`
        // $193.65, about 6% of equity. ⚠ A VETO THAT INVENTS A REASON NOT TO TRADE IS WORSE THAN A WRONG NUMBER:
        // it is a wrong number wearing authority, and it told the operator the symbol could never fire when the
        // only thing broken was this line. `riskAtFloorPct` below derives from it and was wrong for the same reason.
        const minNotionalPct = Number.isFinite(minUnitsNote) && minUnitsNote > 0 && Number(price) > 0 && equity > 0
          ? ((minUnitsNote * Number(price) * notionalK) / equity) * 100
          : null;
        const roomPct = Number.isFinite(Number(exposureCap)) ? Number(exposureCap) - budgetPct : null;
        // ★★ EVERY CAUSE, NOT JUST The FIRST ONE FOUND. A size can land below the venue's minimum for four
        // different reasons, and the old sentence reported none of them - it named the SYMPTOM and left the reader
        // to guess whether the desk, the budget or the venue was at fault. `boundBy` already records which control
        // truncated the size (L4), so the refusal can say which one, and the case where NOTHING bound is the most
        // important of the four: it means the risk dial itself sizes below the venue's minimum, so the symbol
        // cannot trade at this dial at all, whatever the book looks like (the TRD-RSK-4 shape).
        const boundLabel = boundBy === 'maxEquityPerPositionPct'
          ? `the per-position cap (${risk.maxEquityPerPositionPct}% of equity in one position)`
          : boundBy === 'maxRiskPerTradePct'
            ? `the per-trade risk cap (${risk.maxRiskPerTradePct}% of equity)`
            : boundBy === 'exposureCapPct'
              ? `the exposure budget (${Math.max(0, roomPct != null ? roomPct : 0).toFixed(1)}% of equity left of the ${exposureCap}% cap)`
              : null;
        const minDetail = minNotionalPct == null ? null : `the venue's minimum ${minUnitsNote}${v.venueFloor.unitKind ? ' ' + v.venueFloor.unitKind : ''} is ~${minNotionalPct.toFixed(1)}% of equity`;
        // the RISK one minimum would take, against the dial — the number that says "this symbol can never fire"
        const riskAtFloorPct = minNotionalPct != null && riskStopDist > 0 && Number(price) > 0
          ? (minNotionalPct * (riskStopDist / Number(price)))
          : null;
        const why = boundLabel && minDetail
          ? ` — and the size got that small because ${boundLabel}, below the venue's floor. ${minDetail}, so no size that control allows is tradable; the binding limit is the desk's own settings, not the venue`
          : (minDetail && riskAtFloorPct != null && Number(risk.riskPerTradePct) > 0)
            ? ` — and NOTHING was capped: the size comes out below the minimum on its own. ${minDetail}, which at the ${risk.riskPerTradePct}% risk dial is ~${riskAtFloorPct.toFixed(2)}% of equity in risk for ONE ticket — ${(riskAtFloorPct / Number(risk.riskPerTradePct)).toFixed(1)}x the dial, so this symbol cannot trade at this setting whatever the book looks like`
            : '';
        veto('venue_minimum', `below venue minimum: ${floor.detail}${why}`);
      }
    } else if (floor.reason === 'venue_minimum_unknown' || floor.reason === 'registry_unavailable') {
      reasons.push(`venue minimum ${floor.reason === 'registry_unavailable' ? 'unreadable' : 'unknown'} for ${proposal.symbol} — size not checked against the venue floor`);
    } else {
      // ★★ TRD-EXE-3 (2026-09-30) — THE SIZE THIS DESK RECORDS MUST BE THE SIZE THE VENUE HOLDS.
      //
      // This branch is reached only when `floorVerdict` has already PASSED (size >= the venue's minimum),
      // which is what makes the snap safe to take here: the verdict owns whether a size may be sent, and
      // this owns what an allowed size settles on. Rounding the size onto the venue's own increment cannot
      // dip below the floor — `size >= m` implies `round(size/m) >= 1` — and so it cannot create a second
      // refusal path or contradict the veto above.
      //
      // WHY IT MATTERS HERE AND NOT LATER: `v.size` (below) is what `Trades.size` is written from and what
      // `resolvedRiskPct`, the exit tolerance and the cost share of R are all computed on. A size off the
      // venue's increment is therefore not a cosmetic divergence in a log — it is the denominator of every
      // risk number this decision publishes. Measured on the live book 2026-09-30: of 32 positions with an
      // observed venue size, 28 held a size the desk had not recorded, median error 3.99%, max 100%.
      const step = require('./instruments').snapToVenueStep(size, floor.resolved ? floor.resolved.minUnits : null);
      // ★ TRD-RSK-4 (2026-09-30) — THE STANDING CHECK FOR A SYMBOL THAT CAN NEVER FIRE.
      //
      // RSK-4 measured SGX at 2.34x the risk budget and asked for "a standing check for this class: a symbol
      // whose venue floor exceeds the risk budget is a symbol that can never fire, and NOTHING ON THE DASHBOARD
      // SAYS SO". These two fields are that check in its data form, recorded on EVERY decision that reaches
      // here rather than only on the ones the clamp fires for:
      //
      //   `riskAtFloorPct`      the percent of equity ONE venue minimum risks at the MEASURED loss distance.
      //                         Compare it with the dial: if it exceeds `riskPerTradePct`, no size in this
      //                         symbol can satisfy the dial and the venue at once. That is the whole test, and
      //                         it is the same number RSK-4 had to compute by hand.
      //   `floorHeadroomMultiple`  how many venue minimums this ticket is worth (>= 1 here by construction,
      //                         because this branch is only reached when the verdict PASSED).
      //
      // ⚠ IT IS A RECORD, NOT A REFUSAL, and the difference is deliberate. The refusal already exists and is
      // the `floorVerdict` veto above; emitting a second one from here would give `venue_minimum` two emission
      // sites and let a report attribute it to the wrong rule. The residual is that a READER still has to look
      // — nothing surfaces it on the dashboard yet, and saying otherwise would be the claim this session keeps
      // being corrected for.
      const floorUnits = Number(floor.resolved && floor.resolved.minUnits);
      const floorKnown = Number.isFinite(floorUnits) && floorUnits > 0;
      v.venueFloor = {
        ...v.venueFloor,
        snapped: step.snapped,
        snapReason: step.reason,
        steps: step.steps,
        snappedFrom: step.snapped ? Math.round(size * 10000) / 10000 : null,
        snappedTo: step.snapped ? step.size : null,
        floorHeadroomMultiple: floorKnown && size > 0 ? Math.round((size / floorUnits) * 10000) / 10000 : null,
        // ★ TRD-EXE-19: this is the SECOND `riskAtFloorPct` in the file and the two DISAGREED — the one in the veto
        // branch derives from `minNotionalPct`, which already carries `notionalK`, while this one spelled the
        // product out without it. Same quantity, two scales. Both now go through `riskPctOf`.
        riskAtFloorPct: floorKnown && Number(equity) > 0
          ? Math.round(riskPctOf(floorUnits, expectedLossDist) * 10000) / 10000
          : null,
      };
      if (step.snapped) {
        const before = Math.round(size * 10000) / 10000;
        size = step.size;
        const unit = v.venueFloor.unitKind ? ` ${v.venueFloor.unitKind}` : '';
        reasons.push(`size SNAPPED onto the venue's step: ${before} -> ${size} (${step.steps} x ${step.minUnits}${unit}${step.reason === 'half_up' ? ', an exact half resolved UP' : ''}) — the venue fills whole multiples of its minimum, so the unsnapped size was never a size that could be filled and every R below would have been computed on it`);
      }
    }
  } catch (e) {
    // L1: same keys, present-and-null, so a reader of `sizeCalc.venueFloor` never has to know which
    // branch produced the record. A throw is an ABSENT capacity, not a zero one.
    v.venueFloor = {
      ok: true, reason: 'floor_check_threw', detail: String(e.message || e).slice(0, 120),
      leverage: null, initialMarginPct: null, maintenanceMarginPct: null, purchasingPower: null,
      venueInstrumentId: null,
    };
    reasons.push('venue minimum check threw — size not checked against the venue floor');
  }

  // ★★ L3 (rev 5, 2026-09-29) — THE MARGIN GUARD. The one control in this gate that measures the VENUE'S
  // CAPACITY rather than the desk's notional, and it runs LAST on purpose: every cap above it is satisfied
  // more easily by a smaller size, so shrinking here cannot break one — and running last means it inspects
  // the size the venue will actually receive, including a clamp UP to the venue minimum, which happens ABOVE
  // this point and can therefore exceed the exposure budget.
  //
  // WHY IT MUST EXIST BEFORE THE CAPS MOVE (L2, still gated on Q7). `maxEquityPerPositionPct` is denominated
  // in EQUITY and `already_held` bounds concurrency only WITHIN a symbol. Measured on the live book: ten
  // positions at today's 80% cap are 16.0% of equity in margin each — 160% across the book — and the planned
  // raise to 500% makes ONE Gold position 100% of equity in margin on its own. A margin call caused by a
  // settings edit is a different failure from a bad trade: it is the desk stopped out by its own configuration.
  //
  // ⚠ IT IS PROVABLY INERT AT TODAY'S SETTINGS, and that is the acceptance test rather than a hope: with
  // `maxEquityPerPositionPct = 80` the largest possible notional is 80% of equity, whose margin is at most
  // 80% x 60% = 48% (Bitcoin, the least levered symbol) and 16% on Gold — under any ceiling of 80%. The guard
  // cannot fire until L2 raises the cap. Measured on the live book 2026-09-29: 2 open positions, 4.01% used.
  const marginCapPctRaw = Number(risk.maxMarginUtilisationPct);
  const marginArmed = Number.isFinite(marginCapPctRaw) && marginCapPctRaw > 0;
  v.marginGuard = {
    armed: marginArmed, capPct: null, capMargin: null, usedMargin: null, usedPct: null,
    wantedMargin: null, wantedPct: null, finalMargin: null, finalPct: null,
    ratePct: null, rateFrom: null, unreadableSymbols: null,
    unknown: false, fitted: false, full: false,
    // ★ TRD-RSK-14 (2026-09-30) — THE THREE THINGS THIS DESK CALLS "MARGIN", NAMED AS THE ROW ASKED.
    //
    // 'usedMargin' stays (pins and readers depend on it), but it is a MODEL, not a reading: it applies the
    // registry's percent to 'size x price', which is denominated in the INSTRUMENT's currency, while the venue
    // withholds margin in the ACCOUNT's. Measured over ~5,000 live books, the venue charges **1.2812x** what
    // this model says — median, 99.2% of books within 0.02 — and the factor does not move with the registry
    // rate (Gold-only x1.2795 at 20% vs Bitcoin-containing x1.2822 at 60%), so it is an EXCHANGE RATE, not a
    // second margin policy. The account is SGD and every symbol this desk trades is quoted USD.
    //
    // 'initialMarginHeld' is the venue's ACTUAL withheld initial margin. It is PRESENT-AND-NULL on purpose and
    // is deliberately NOT read here: the desk does store it ('equity - available' on every 'account' event), but
    // wiring it in changes the arithmetic of the one control the whole purchasing-power design rests on, and
    // that is an owner decision with a number attached. NULL means "the guard does not have this", never "it is
    // zero" — 'Number(null) === 0' is the trap that would turn the guard's worst input into its most permissive
    // reading.
    //
    // ⚠ SO 'capPct' IS A CEILING ON A MODEL, NOT ON THE VENUE. At the live 80% it corresponds to **102.50%** of
    // equity in the margin the venue really withholds — above 100. It cannot bind today (the 35%/50% caps reach
    // only 26.91%), which is exactly why it is recorded and not changed.
    modelledInitialMargin: null,
    initialMarginHeld: null,
  };
  if (marginArmed) {
    const inst = require('./instruments');
    const rate = inst.marginRatePct(v.venueFloor || {});
    // THE OPEN BOOK'S MARGIN, read per SYMBOL. A `Trades` row carries a symbol, a size and a price but NO
    // CONTRACT (TRD-OPT-2 has not landed), so the registry is the only place an open position's rate can
    // come from — and an option resolves AMBIGUOUSLY by design (24 Gold rows share one symbol), which is a
    // reason to fail closed, not a reason to pick one.
    let usedMargin = 0;
    let usedReadable = true;
    const unreadable = [];
    // ★★ P2c (2026-10-01) — THE LAST CURRENCY-BLIND QUANTITY IN THIS FILE. The venue withholds margin against a
    // notional in each position's INSTRUMENT currency, while the ceiling it is compared against is a percentage
    // of an equity in the ACCOUNT's. Summing the book's margin before converting therefore understated it by
    // `fx` — the same defect as `v.exposurePct`, in the guard that is the desk's brake.
    // ⚠ THE FACTOR IS RESOLVED PER SYMBOL, NOT ONCE FROM THE PROPOSAL. The book can mix a USD-quoted instrument
    // with the SGD-quoted one, and applying the proposal's factor to both would be a NEW unit error introduced
    // by the fix — the same mistake in the opposite direction. Memoised because `fxFactorFor` is pure but this
    // loop runs per open position on every evaluation.
    const fxBySymbol = new Map();
    const fxForSymbol = (sym) => {
      const k = String(sym);
      if (!fxBySymbol.has(k)) fxBySymbol.set(k, fxFactorFor({ settings, symbol: sym, live: accLive }).fx);
      return fxBySymbol.get(k);
    };
    if (open.length) {
      const rates = await inst.marginRatesFor(userId, open.map((t) => t.symbol)).catch(() => null);
      for (const t of open) {
        const row = rates && rates[String(t.symbol)];
        const rPct = row && Number.isFinite(row.pct) && row.pct > 0 ? row.pct : null;
        // ★★ THE CONTRACT SCALE, PER POSITION (2026-10-01). Without it a cents-quoted instrument's contribution
        // was overstated 100x — the same defect as the notional cap, in the guard that decides whether there is
        // room for the next entry. ⚠ IT IS NOT THE PROPOSAL'S SCALE: the book can hold a USD-quoted contract
        // beside a cents-quoted one, and applying one factor to both would be a NEW unit error introduced by the
        // fix. `row.pointValue` comes from the registry rows this loop already fetched; the caller-supplied
        // accessor is the fallback, and it is the identity when nothing supplies one.
        const pvRow = row && Number(row.pointValue);
        const pv = Number.isFinite(pvRow) && pvRow > 0 ? pvRow : pointValueForSymbol(t.symbol);
        const n = (Number(t.size) || 0) * (Number(t.openPrice) || 0) * notionalFactor(pv, fxForSymbol(t.symbol));
        // ⚠ A POSITION WITH A SIZE BUT NO PRICE IS NOT A ZERO-MARGIN POSITION — it is an UNREADABLE one. The
        // exposure sum above reads a missing price as zero, which is harmless for a notional total the venue
        // enforces anyway; here it would be the guard's most permissive possible reading of its worst input,
        // so it is named instead.
        if (rPct == null || ((Number(t.size) || 0) > 0 && !(Number(t.openPrice) > 0))) {
          usedReadable = false; unreadable.push(String(t.symbol)); continue;
        }
        usedMargin += n * (rPct / 100);
      }
    }
    const mg = fitMarginBudget({
      size, price, marginRatePct: rate.pct, usedMargin: usedReadable ? usedMargin : null,
      capPct: marginCapPctRaw, equity, fx, pointValue,
    });
    const money = (x) => (x == null ? '?' : x.toFixed(2));
    v.marginGuard = {
      ...v.marginGuard,
      capPct: marginCapPctRaw,
      capMargin: mg.capMargin != null ? +mg.capMargin.toFixed(2) : null,
      usedMargin: mg.usedMargin != null ? +mg.usedMargin.toFixed(2) : null,
      usedPct: mg.usedPct != null ? +mg.usedPct.toFixed(4) : null,
      // TRD-RSK-14: the same number, named for what it IS. 'usedMargin' is kept because pins and readers hold
      // it; this field exists so no reader has to know that the two are the same quantity to see which one the
      // ceiling is applied to.
      modelledInitialMargin: mg.usedMargin != null ? +mg.usedMargin.toFixed(2) : null,
      wantedMargin: mg.wantedMargin != null ? +mg.wantedMargin.toFixed(2) : null,
      wantedPct: mg.wantedPct != null ? +mg.wantedPct.toFixed(4) : null,
      finalMargin: mg.finalMargin != null ? +mg.finalMargin.toFixed(2) : null,
      finalPct: mg.finalPct != null ? +mg.finalPct.toFixed(4) : null,
      ratePct: Number.isFinite(Number(rate.pct)) ? Number(rate.pct) : null,
      rateFrom: rate.from,
      unreadableSymbols: unreadable.length ? unreadable : null,
      unknown: mg.unknown === true,
      fitted: mg.fitted === true,
      full: mg.full === true,
    };
    if (mg.unknown) {
      // ★ FAIL CLOSED (TRD-109's discipline applied to CAPACITY, not to the equity baseline). A capacity guard
      // that cannot read the venue's own margin rate would pass everything while reporting itself satisfied,
      // and "could not read" has to stay distinguishable from "there was room". The refusal names WHICH input
      // failed, because the fix differs for each.
      const why = [];
      if (rate.pct == null) why.push(`the venue's own margin rate for ${proposal.symbol} could not be read`);
      if (unreadable.length) why.push(`the margin rate or notional of an open position could not be read for ${unreadable.join(', ')}`);
      if (!(Number(equity) > 0)) why.push('equity is unavailable');
      if (!why.length) why.push('the sizing inputs are unusable');
      veto('margin_guard_unusable', `margin guard cannot be evaluated (${why.join('; ')}) — entries are refused rather than sized unguarded, because a capacity guard with no denominator reports room it has not verified`);
    } else {
      // ⚠ THE FLOOR TEST IS EVALUATED HERE, NOT IN ITS OWN BRANCH, so `margin_utilisation` is emitted from
      // EXACTLY ONE SITE — the invariant `risk-veto-codes` pins, and the reason a report can attribute the
      // code to one rule. A resized size below the venue's own minimum is refused under the SAME code because
      // the SAME ceiling caused it: the guard has room, but not room the venue will accept a trade in. It is
      // only a NEW refusal when the guard is what pushed the size under the floor — a ticket already under it
      // was refused at the floor check above, and naming this as a second cause would misattribute the first.
      const minUnits = Number(v.venueFloor && v.venueFloor.minUnits);
      const belowFloor = mg.fitted && Number.isFinite(minUnits) && minUnits > 0 && size >= minUnits && mg.size < minUnits;
      if (mg.full || belowFloor) {
        veto('margin_utilisation', mg.full
          ? `margin utilisation full: the open book already holds ${money(mg.usedMargin)} of margin = ${mg.usedPct.toFixed(2)}% of the ${marginCapPctRaw}% ceiling (${money(mg.capMargin)}), and this ticket needs ${money(mg.wantedMargin)} more, so there is no room left`
          : `the ${marginCapPctRaw}% margin-utilisation ceiling leaves ${mg.size} units, below the venue's own minimum ${minUnits}${v.venueFloor && v.venueFloor.unitKind ? ` ${v.venueFloor.unitKind}` : ''} — the ticket cannot be sent at the only size the guard permits`);
      } else if (mg.fitted) {
        const before = size;
        size = mg.size;
        boundBy = 'margin_utilisation';
        reasons.push(`sized down to the ${marginCapPctRaw}% margin-utilisation ceiling: ${mg.usedPct.toFixed(2)}% of equity is already committed as margin + ${mg.wantedPct.toFixed(2)}% wanted > ${marginCapPctRaw}% cap -> ${mg.finalPct.toFixed(2)}% of equity in margin (size ${before} -> ${size}); the risk promised by the dial is LOWER, not the stop`);
        // ★ TRD-RSK-14 (2026-09-30) — SAID HERE BECAUSE THIS IS WHERE IT MATTERS: the moment this control is
        // what BOUND the ticket, the ceiling it enforced was a ceiling on a MODEL. The venue withholds 1.2812x
        // more (measured, ~5,000 books), so at the live 80% the real ceiling is 102.50% of equity. It is
        // unreachable today — the 35%/50% caps reach only 26.91% — and a warning about a state that has not
        // occurred is better unreachable than absent.
        reasons.push('⚠ the ceiling above was applied to the MODELLED initial margin, not to the venue\'s own: the model prices each position in the INSTRUMENT\'s currency while the venue withholds in the ACCOUNT\'s, and the measured factor is 1.2812 (USD/SGD). "initialMarginHeld" is null because the guard does not read the venue\'s figure — see TRD-RSK-14 (#1477).');
      }
    }
  }

  v.size = Math.round(size * 10000) / 10000;
  // ★ TRD-EXE-19: the formula now carries the contract's scales when they are not 1, so the card and the decision
  // log can no longer describe a derivation the code did not use. The `notionalK === 1` branch is byte-identical
  // to the string that was here before, so nothing that reads it changes on a dollar-quoted instrument.
  v.units = notionalK === 1
    ? `risk ${risk.riskPerTradePct}% / (2 x ATR ${atrV})`
    : `risk ${risk.riskPerTradePct}% / (2 x ATR ${atrV}) x contract scale ${notionalK.toFixed(6)}`;
  // ★★ L4 (2026-09-29): THE TRUTH FIELDS — what the dial WANTED, what the venue's purchasing power PERMITS, and
  // what this ticket ACTUALLY risks. See §L4.a.
  //
  // ★ THE FIELD THAT MATTERS MOST IS `riskCappedByCeiling`, because every other quantity in this object
  // describes the dial or a cap, and NONE of them says that on some symbols the dial was never expressible at
  // all. Under `r = 3.0%` a Bitcoin ticket (ceiling 1.16% at a 0.695% stop) and a Coffee ticket (4.67%) would
  // otherwise be indistinguishable in the record — and those are different trades, which is the whole reason
  // §6.1 exists. Measured live 2026-09-29: on 5 of 7 symbols at r = 5% the dial was unreachable.
  //
  // ⚠ `resolvedRiskPct` IS COMPUTED, not realised, and the distinction is deliberate (§L4.a). It is on the SAME
  // stop the sizing used, so it is comparable with the dial; the FILL-ANCHORED realised figure stays on the
  // trade row, where it already lives. Measured on Gold, the record's effective stop and the fill-anchored stop
  // differ by 21% WITHIN A SINGLE TICKET — duplicating one into the other would label a number with the wrong
  // anchor, which is TRD-RSK-1's defect.
  //
  // The dial comes from `promptBuilder.effectiveRiskPct` rather than from a second `Math.min` here: that
  // resolver is the single statement of "which of the two dials wins", it is pinned by test, and a copy would be
  // a second place to disagree — exactly the TRD-TUN-2 defect, one layer up. The require is lazy because
  // `promptBuilder` is not in this module's load path.
  const dial = require('./promptBuilder').effectiveRiskPct(settings);
  const riskDialPct = Number.isFinite(Number(dial.effective)) ? Number(dial.effective) : null;
  const stopPctOfPrice = (riskStopDist / price) * 100;
  // ⚠ Read through the accessor, NEVER by reaching into the venue-floor record with a dot: the pin in
  // `test/venue-leverage.test.js` holds the venue's margin and leverage fields to exactly one read site, and
  // that is what keeps `instruments.js` the only place that decides what a venue's capacity means. My first
  // version of this line did exactly that and the pin failed — correctly, and immediately.
  const ceilingPct = require('./instruments').ceilingPctFor(v.venueFloor, stopPctOfPrice);
  const riskCappedByCeiling = (ceilingPct != null && riskDialPct != null) ? riskDialPct > ceilingPct : null;
  const resolvedRiskPct = Number(equity) > 0 ? Math.round(riskPctOf(v.size, expectedLossDist) * 10000) / 10000 : null;
  // IMPLIED GOAL: the full sizing formula rides along in every decision log
  // so the size is never a mystery (not hardcoded — derived from equity/ATR).
  v.sizeCalc = {
    equity: Math.round(equity * 100) / 100,
    riskPct: Number(risk.riskPerTradePct ?? 1),
    atr: atrV,
    // ★★ TRD-EXE-19 (2026-10-02): THE TWO SCALES THIS SIZE WAS DIVIDED BY, CARRIED AS INPUTS.
    //
    // ⚠ THE AUDITOR FOUND THEM MISSING, NOT A TEST. `fieldContracts.riskUnit` re-derives `baseSize` from
    // `(equity x riskPct) / (atr x stopMultiple)` and compares — an INDEPENDENT check, green for weeks. Adding
    // `notionalK` to `baseSize` made every decision disagree with it by exactly `fx`: measured live on
    // 2026-10-02, `baseSize 3.937 vs 6.102`, ratio **1.5500**.
    //
    // ⚠ SO THE SWEEP MISSED A SITE, AND THE SITE WAS THE ONE THAT CHECKS THE SWEEP. A module that re-derives the
    // same formula is a call site of that formula. It cost a live `bad` self-health check to find, which is the
    // cheapest possible way for this class of omission to surface — and it only surfaced because the checker
    // existed.
    //
    // ⚠ CARRIED AS INPUTS, NOT AS THEIR PRODUCT, so the auditor still does its own arithmetic instead of trusting
    // a number this object also produced.
    // ⚠ `1` FOR AN UNKNOWN SCALE IS THE IDENTITY AND ALSO THE ERA RULE: decisions written before this change
    // carry neither key, so they default to 1 and keep being audited against the formula they were sized by.
    fx: Number(fx) > 0 ? Number(fx) : 1,
    pointValue: Number(pointValue) > 0 ? Number(pointValue) : 1,
    // ★ 2026-10-18: THE STOP MULTIPLE THE SIZE WAS BUILT FROM, WRITTEN DOWN.
    // The self-health contract `field_risk_unit` re-derives this size from the record. Without this field it has
    // to assume a multiple, and an assumed multiple is wrong in whichever era it is not: the check reported
    // "sizing arithmetic drifted: baseSize 2.022 vs 4.044" on the first ticket after `atrStopMultiple` was wired
    // and moved to 4, when the size was exactly right. Carried per-row so each decision is audited against the
    // geometry it was actually sized by, not against whatever the setting says today.
    atrMultiple,
    // ★ TRD-EXE-10: the measured gap between where the stop SITS and what the loss COSTS. `effectiveStopDistance`
    // is the level the venue receives; `expectedLossDistance` is that level times the measured fill factor and is
    // what the size and `resolvedRiskPct` are computed from.
    stopSlippageFactor: lossFactor,
    expectedLossDistance: Math.round(expectedLossDist * 10000) / 10000,
    // ★ TRD-EXE-19: `notionalK` rides here too. This field is "what the dial wanted", and a dial that ignores
    // the contract's own scale is not the number the size above was derived from.
    // ⚠ 2026-10-18: reads the SAME `atrMultiple` the stop above was built from. Hard-coding 2 here would have
    // made this diagnostic disagree with the decision it describes the moment `atrStopMultiple` stopped being 2,
    // which is the "two numbers for one quantity" defect this file already documents twice.
    baseSize: Math.round(sizeForRisk(Number(risk.riskPerTradePct ?? 1) / 100, atrMultiple * atrV) * 10000) / 10000,
    runInFactor: runInFactorFor(proposal.strategy, settings),
    strategyFactor: proposal.strategy === 'meanrev' || proposal.strategy === 'rsi2' ? 0.5 : 1,
    cappedAtPct,
    finalSize: v.size,
    // TRD-45: the venue-floor check rides along with the rest of the arithmetic, so "was this size
    // checked against what the venue actually accepts" is answerable from the decision alone.
    venueFloor: v.venueFloor || null,
    // L3: the same reason, applied to the venue's CAPACITY rather than its floor. Without it the desk can say
    // what it was allowed to BUY but not what it was allowed to COMMIT — and after L2 the margin guard is the
    // only control left that can act, so an un-inspectable guard would be the §1.1b defect a third time.
    marginGuard: v.marginGuard || null,
    // ★ L4 (2026-09-29): the pair the record could not previously state — the dial AS RESOLVED, and the risk the
    // ticket ACTUALLY carries once every cap has finished. Plus the venue's own ceiling for this stop and whether
    // that ceiling is what limited the dial, and which control bound the size at all.
    riskDialPct,
    ceilingPct,
    riskCappedByCeiling,
    resolvedRiskPct,
    boundBy,
    // ★ TRD-EXE-7: the notional THIS ticket will consume, so the caller can carry it into the rest of the wake's
    // budget checks. Published here rather than recomputed by the caller, because `size` has been through the
    // whole chain by now and a caller recomputing it from `finalSize` would be a second place to disagree.
    notionalPct: Number(equity) > 0 && Number.isFinite(Number(v.size)) ? Math.round((v.size * price * notionalK / equity) * 100 * 10000) / 10000 : null,
    reasons: [...reasons],
  };
  return v;
}

// TRD-12 Phase 2: trailing high-water baseline — ratchet kill.initialEquity
// up whenever live equity exceeds it (checked each wake).
async function ratchetBaseline(userId, settings, equity) {
  const base = Number(settings.kill?.initialEquity);
  if (!Number.isFinite(base) || !Number.isFinite(equity) || equity <= base) return { ratcheted: false };
  await store.saveSettings(userId, { kill: { initialEquity: +equity.toFixed(2) } }, { by: 'machine' });
  await store.logEvent(userId, 'telemetry', { source: 'hwm_baseline', from: base, to: +equity.toFixed(2) });
  return { ratcheted: true, from: base, to: +equity.toFixed(2) };
}

// TRD-17/24: same-pairId correlation-veto exemption. Both sides must carry
// the same non-null pairId — a pair's own legs are the ONLY trades skipped;
// everything else still faces the 30-day log-returns veto.
function pairExempt(proposal, pos) {
  const a = proposal && proposal.pairId;
  const b = pos && pos.pairId;
  return !!(a && b && String(a) === String(b));
}

// TRD-80 (2026-09-20): WHOSE EVIDENCE IS THIS SIZE BASED ON?
//
// `learning.parityValidated` is DERIVED by the parity harness as "at least one enabled strategy reached
// accept", and it was then read as ONE multiplier for every symbol. That is a desk-wide answer to a
// per-strategy question: the first strategy to earn full size would hand it to every other enabled
// strategy, including ones with no sample at all. The flag is kept — it is an explicit statement a human
// can make, and the tuner reads it as the live-desk gate — but the DEFAULT is now the strategy's own
// verdict, written by the harness as `learning.validatedStrategies`.
//
// Pure, so the rule is pinned by test rather than inferred from a live decision.
function runInFactorFor(strategyId, settings) {
  const learning = (settings && settings.learning) || {};
  if (learning.parityValidated === true) return 1;
  const validated = Array.isArray(learning.validatedStrategies) ? learning.validatedStrategies.map(String) : [];
  return validated.includes(String(strategyId)) ? 1 : 0.5;
}

// ★ TRD-VET-2 follow-up (2026-09-28): THE REFUSAL, STATED AS A REFUSAL.
//
// WHAT WAS WRONG. The refusal line was `'risk veto: ' + reasons.join('; ')`, and `reasons` holds the gate's
// RESIZE NOTES (the stop cap, the take-profit offset, each size cap) in the same list as the refusal texts, in
// push order. The stop-cap note is pushed while the ticket is still being ADMITTED, so it led almost every veto.
// Measured on the record: 14 refusals read `"risk veto: stop capped at 0.3% of price (declared 0.645%), venue
// cost ..."` while 3 of them carry `vetoCodes: ["correlation"]` — the prose named a resize the gate had PASSED as
// the reason it refused. TRD-RSK-2's own investigation mis-diagnosed a refusal off that sentence once already
// ("venue cost 0.1936% = 65% of R" read as a cost-ceiling breach when the correlation guard had fired).
//
// ⚠ THE SPLIT IS BY SOURCE, NOT BY WORDING: `vetoReasons` is exactly what the `veto()` helper was called with, so
// nothing has to be pattern-matched to build this line. Notes keep their own section rather than being dropped —
// they are what explains the ticket's shape, and a reader who loses them loses the reason the numbers look odd.
//
// ⚠ THE `risk veto:` PREFIX IS PRESERVED VERBATIM: `public/js/app.js` keys its label on `/risk veto/i` and
// `routes.js` classifies on `/^risk veto:/i`, so both keep working. New readers should use `vetoCodes` / the
// decision's `attribution` instead of the prose.
function vetoLine(v) {
  const refusals = Array.isArray(v && v.vetoReasons) ? v.vetoReasons : [];
  const codes = Array.isArray(v && v.vetoCodes) ? v.vetoCodes : [];
  const all = Array.isArray(v && v.reasons) ? v.reasons : [];
  // A row written before `vetoReasons` existed has no split to make, so it falls back to the old shape rather
  // than reporting a refusal with no text at all.
  if (!refusals.length) return `risk veto: ${all.join('; ') || 'vetoed'}`;
  const notes = all.filter((r) => !refusals.includes(r));
  const codePart = codes.length ? ` [${codes.join(', ')}]` : '';
  const notePart = notes.length ? ` — gate notes: ${notes.join('; ')}` : '';
  // ⚠ `risk veto:` — THE COLON MUST FOLLOW `veto` IMMEDIATELY. `routes.js` classifies a refusal with
  // `/^risk veto:/i` and `public/js/app.js` labels it with `/risk veto/i`; putting the code before the colon
  // (`risk veto [x]: …`) kept the second and BROKE the first, silently reclassifying every coded refusal. The
  // code goes after the colon, where it is still the first thing a reader sees and nothing else has to change.
  return `risk veto:${codePart} ${refusals.join('; ')}${notePart}`;
}

module.exports = { evaluate, vetoLine, runInFactorFor, dailyHaltActive, dailyHaltVerdict, dayStartEquity, resolveDayStart, ratchetBaseline, returnsCorrelation, correlationClash, pairExempt, fitExposureBudget, fitMarginBudget, CORR_WINDOW_DAYS, CORR_MIN_BARS };
