// trading/agent/promptBuilder.js — sliding context window (amendment A9).
// Always: current snapshot (price/ATR/ADX/Donchian), <=5 active positions,
// last 3 closed trades (P&L + exit reason), latest daily digest.
// NEVER raw tick history to the LLM — that's the quant's job.
// A6 staleness rule is printed verbatim in the bundle: data older than the
// SIGNAL cadence (1h bars -> 4h window, implied goal) is invalid for trading.
'use strict';

const STALENESS_MS = 4 * 3600000; // 1h signal bars; must match quant.BAR_FRESH_MS
// Phase 2: the venue's carry/minimum facts are rendered by the module that owns them, so the wording
// and the numbers cannot drift apart. Requiring it here (rather than passing pre-rendered strings)
// keeps `promptBuilder` a formatter instead of a second place that decides what a funding rate means.
const { costFactLines } = require('./instruments');
// TRD-PNL-4 (#1484): the unit every equity/margin/P&L figure in this bundle is denominated in. Declared in
// settings, read through one helper, so no formatter here can invent a unit for a number it did not earn.
const { currencyOf } = require('./accountCurrency');

function fmt(n) { return n == null ? 'n/a' : Number(n).toFixed(4); }

// ---------------------------------------------------------------------------
// TRD-PRC-1 (2026-09-14): EVERY PRICE NOW CARRIES ITS SOURCE AND AGE.
//
// THE DEFECT THIS FIXES. The bundle printed a live tick (`mid=`) next to bar-derived numbers
// (prev, ATR, Donchian bounds, the whole BIG PICTURE block) with NO ages on either side. A
// chair comparing them therefore always found a disagreement, and the panel always outvoted
// it, because the panel had scored the live number.
//
// MEASURED, and it inverted my own first reading. Latest-vs-latest looked alarming — Gold
// 73.2 bps, Oil 66.8, Sands China 730.8, several times the round-trip cost (Gold 11.9, Oil
// 17.3 bps). Re-measured LIKE-FOR-LIKE (each bar close against the tick AT THAT BAR END,
// ±900s, 3 days) only TWO rows survive: Sugar +13.9 bps and Gasoline -12.2 bps, both
// plus500_chart. Gold, Oil, Silver and Bitcoin do not appear at all. The alarming figures
// were STALENESS, not source error — the sources agree.
//
// So the fix is not to pick a winning venue (TRD-35 already established the venue is right
// about its fills while the bar series is right about structure). The fix is to make the two
// clocks legible: name the source, state the age, and tell the reader not to compare across
// them. At Gold's volatility an hour of drift is several times the round trip, so an unlabelled
// comparison is guaranteed to look like a conflict.
//
// In trade 1036 the chair cited 102.66 as truer than the live 103.625. On this evidence
// 102.66 was the STALER number: the dissent was right that the two disagree and wrong about
// which side was stale.
// ---------------------------------------------------------------------------

const SOURCE_LABEL = { tick: 'live tick', bar_close: 'bar close', bar: 'bar close' };

// Age of an ISO timestamp as measured at BUNDLE-BUILD time, so it can never be stale relative
// to the `Generated:` line the model reads beside it.
function secsText(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return null;
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
function ageText(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return secsText((nowMs - t) / 1000);
}

// `mid=4294.5000 [live tick, plus500, 3s old]` — a price is never printed without its clock.
// Callers pass the provenance EXPLICITLY rather than the helper guessing from field names,
// because guessing is exactly what conflated the tick with the bar in the first place.
function priced(value, { source = null, asOf = null, venue = null } = {}) {
  if (value == null) return 'n/a';
  const age = ageText(asOf);
  // No provenance to show (older data, or a fixture): print the number alone rather than
  // inventing a label. An honest absence beats a confident "unlabelled".
  if (!source && !age) return fmt(value);
  const label = SOURCE_LABEL[source] || 'unlabelled';
  return `${fmt(value)} [${label}${venue ? `, ${venue}` : ''}${age ? `, ${age} old` : ''}]`;
}

// Provenance from a quant snapshot entry, in one place so the two call sites cannot drift.
const pxOf = (s) => ({ source: s.priceSource, asOf: s.priceAsOf, venue: s.priceVenue });
const prevOf = (s) => ({ source: s.prevPriceSource, asOf: s.prevPriceAsOf });

// ── TRD-72 (2026-09-22): THE SCOPE FILTER ─────────────────────────────────────────────────────────
//
// Measured 2026-09-21 through this builder on the live watchlist: 15,874 chars / ~3,969 tokens, of
// which 77% of MARKET SNAPSHOT and 55% of BIG PICTURE was about symbols NO strategy can trade. A symbol
// with an EMPTY scoped-strategy list cannot be ENTERED (nothing can propose it), so its snapshot,
// indicators, multi-timeframe rows and cost rows cannot change any decision. Dropping them is
// deterministic, free, needs no model call, and is testable — unlike an AI telemetry selector, which by
// the row's own measurement would cost more than it saves if asked every wake (see TRD-73).
//
// MODULE-LEVEL ON PURPOSE: ONE predicate answers "is this symbol in scope" for both renderings.
//
// ⚠⚠ THE FILTER APPLIES TO WHAT THE CHAIR READS, NOT TO WHAT THE DESK RECORDS (corrected 2026-09-23).
// The first version applied it to `buildBundleObj.snapshot` as well, on the argument that a consumer of the
// object "must not get a different picture from the chair". That argument is about a FACT diverging
// (TRD-PRC-1's `priceSource`); applying it to a SET bought nothing at all. The chairs receive the TEXT,
// which filters independently below; `context.centralContext` reads `quantResult.symbols` directly; and
// the ONLY consumer of the stored `.snapshot` is the dashboard (`public/js/app.js:370,566`). So the object
// lost rows, and the Decisions tab silently showed 2 of 12 watchlist symbols the moment this went live on
// a restart — while saving zero prompt tokens. The object now keeps the CENSUS (every symbol evaluated,
// its scope recorded per row) and the omission is still named, so the two can never be confused for one.
//
// ⚠ TWO DELIBERATE SAFETY CHOICES. Both COST tokens, so both are stated rather than buried:
//
// 1. A SYMBOL WITH AN OPEN POSITION IS ALWAYS KEPT, whatever its scope. The row asks for the POSITIONS
//    block to stay unconditional, but the chair also needs the symbol PRICE to judge an EXIT — and
//    scope can be cleared while a position is open (retire a strategy and the position remains).
//    Filtering that symbol would remove the price for a LIVE exit decision, which is the one case where
//    this optimisation could cost money instead of tokens.
//
// 2. AN ABSENT `strategies` FIELD MEANS UNKNOWN, AND UNKNOWN IS INCLUDED (fail-open).
//    `quant.evaluateSymbol` records the list on every result, but a fixture, a replay, or a future
//    caller that omits it must degrade to TODAY BEHAVIOUR — send everything — not to hidden telemetry.
//    An absent field is not evidence of an absent scope.
function makeScopeFilter(quantResult, openTrades) {
  const heldSymbols = new Set((openTrades || []).map((p) => String(p.symbol)));
  const allSymbols = (quantResult && quantResult.symbols) || [];
  const inScope = (s) => {
    if (heldSymbols.has(String(s.symbol))) return true;
    if (!Array.isArray(s.strategies)) return true;
    return s.strategies.length > 0;
  };
  return {
    inScope,
    allCount: allSymbols.length,
    omitted: allSymbols.filter((s) => !inScope(s)).map((s) => String(s.symbol)),
    inScopeSymbols: new Set(allSymbols.filter(inScope).map((s) => String(s.symbol))),
  };
}

// ★ TRD-LLM-2 (2026-09-25): THE CHAIR WAS ASKED TO SIZE A TICKET WITHOUT BEING TOLD THE ACCOUNT OR THE RULES.
//
// Measured on the live bundle: the ONLY account line in the whole prompt was `Account: DEMO (paper).` — no
// equity, no free funds — and NO risk parameter appeared anywhere. Meanwhile the bundle's own instruction is
// `PROPOSED ACTION by quant: ... size=<N>`, i.e. the seat is asked to vote on a size whose formula, caps and
// refusal thresholds it cannot see. `risk.evaluate` had every one of those numbers (`sizeCalc.equity`,
// `riskPerTradePct`, `maxAdversePct`) and none of them reached the prompt.
//
// WHY IT MATTERS RATHER THAN BEING TIDINESS. A seat that cannot see the stop cap cannot know that the risk unit
// it is judging has been TRUNCATED, so it reasons about a 2xATR stop that will never be placed — and a seat
// that cannot see the cost ceiling cannot know that a tight cap is what gets a ticket REFUSED. The owner hit
// both: "does the LLM know the parameters of the risk and position sizing, and the current equity and
// available funds?" — it did not.
//
// ⚠ AN UNREAD EQUITY IS STATED, NEVER PRINTED AS 0. `Number(null) === 0` is the coercion this codebase has
// been bitten by repeatedly (see the note on `stopPolicy.costShareOf`); a chair told "equity 0.00" reads a
// funded account as an empty one and votes accordingly. "Unavailable" is a state, not a zero.
function accountLines(account) {
  const a = account && typeof account === 'object' ? account : {};
  const money = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const eq = money(a.equity), av = money(a.available), mg = money(a.margin), pnl = money(a.pnl);
  if ([eq, av, mg, pnl].every((x) => x == null)) {
    return ['Account: DEMO (paper). Equity UNAVAILABLE this wake — the account strip was not read, so do not'
      + ' assume any particular account size and do not treat the absence as zero.'];
  }
  const part = (label, v) => (v == null ? `${label} n/a` : `${label} ${v.toFixed(2)}`);
  return [`Account: DEMO (paper). ${part('equity', eq)}. ${part('available', av)}. ${part('margin', mg)}. ${part('open P/L', pnl)}.`];
}

// ★★ TRD-LLM-2, CORRECTED 2026-09-27 (#1413). WHICH RISK DIAL BINDS — AND WHAT CAN REFUSE THE TICKET.
//
// THE DEFECT THIS FIXES, found by reading the row back after shipping it. The first version printed
// `size = equity x riskPerTradePct% / effective stop distance` as THE sizing rule. That is not the rule.
// `risk.js` sets the base from `riskPerTradePct`, then RECOMPUTES it from `maxRiskPerTradePct` — and BOTH divide
// by the SAME `riskStopDist`. So the smaller of the two always wins, deterministically, for every symbol and
// every stop distance. On the live config (declared 2%, cap 0.07%) the declared dial is INERT and the realised
// risk per trade is 0.07% of equity, roughly **28x below the number the seat was shown**. The desk's own veto
// text had been printing "size capped at 0.07% risk/trade" all along; the prompt was the one place silent about it.
//
// ⚠ AND THE ORIGINAL TEST CERTIFIED THE OMISSION. It asserted the section CONTAINED the sentence I had just
// written, so it pinned my own wording rather than the completeness of the rule — the same class of mistake as
// pinning prose. The replacement asserts the INERT DISCLOSURE, which is a property of the settings rather than of
// the prose, so it fails if the wording drifts away from the fact.
//
// It also now enumerates every rule that can REFUSE the ticket. That matters more than it looks: on 2026-09-25
// six of eight wakes were refused by the risk gate BEFORE any seat was consulted, so a seat was being asked to
// vote on a proposal whose refusal conditions it could neither see nor influence.
//
// ⚠ EXISTING CLAUSES OUTSIDE THIS SECTION relied on the declared dial reading literally (`a6-print-params` and
// the previous version of this section). They are updated with it, because the whole point is that one number
// stops meaning two things.
//
// Exported so the PROMPT and the UI read ONE computation. A second derivation is how a displayed number drifts
// from an applied one (the TRD-DEL-1 lesson), and here the two agreeing IS the fix.
function effectiveRiskPct(settings) {
  const r = (settings && settings.risk) || {};
  const declared = Number.isFinite(Number(r.riskPerTradePct)) ? Number(r.riskPerTradePct) : 1;
  const rawCap = Number(r.maxRiskPerTradePct);
  const hasCap = Number.isFinite(rawCap) && rawCap > 0;
  // Ties go to the declared dial, so a config with no cap (or a cap equal to it) reads as "not inert".
  const binds = hasCap && rawCap < declared ? 'maxRiskPerTradePct' : 'riskPerTradePct';
  return { declared, maxRisk: hasCap ? rawCap : null, effective: binds === 'maxRiskPerTradePct' ? rawCap : declared, binds, inert: binds === 'maxRiskPerTradePct' };
}

// The rules that SIZE a ticket and the rules that can REFUSE it, stated from the settings that will actually run.
function riskParameterLines(settings) {
  const r = (settings && settings.risk) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const cap = num(r.maxAdversePct, 0);
  const mult = num(r.maxAdverseCostMultiple, 1.5) || 1.5;
  const ceiling = Number(r.maxCostShareOfR) > 0 ? Number(r.maxCostShareOfR) : 1 / mult;
  const tpOffset = num(r.takeProfitOffsetPct, 0);
  const risk = effectiveRiskPct(settings);
  const maxPos = num(r.maxPositions, 3);
  const maxNew = num(r.maxNewTradesPerDay, 3);
  const corr = num(r.correlationVeto, 0.7);
  const halt = num(r.dailyLossHaltPct, 3);
  const cooldown = num(r.reentryCooldownBars, 0);
  const expCap = num(r.exposureCapPct, 15);
  // ★ L3 (2026-09-29): THE BOOK'S CAPACITY — the only control in this list that is not a limit on the TICKET.
  //
  // Every other rule bounds what this proposal may be; this one bounds what the book may already be holding, so the
  // seat cannot infer it from the ticket and could not see it at all before. It is disclosed only when ARMED, for
  // the same reason the cooldown clause is: a control that is switched off cannot refuse anything, so printing its
  // refusal rule would describe a gate that does not exist. (The `risk-veto-codes` disclosure test supplies the
  // setting that arms it rather than accepting a rule whose text never appears.)
  const mgCap = num(r.maxMarginUtilisationPct, 0);

  const lines = [
    `Sizing chain: base size = equity x ${risk.declared}% / effective stop distance — the stop the VENUE enforces, not the one the strategy declared — then multiplied by any run-in half-risk factor (a strategy that is not parity-validated takes half), then reduced by BOTH the position notional cap (${num(r.maxEquityPerPositionPct, 5)}% of equity) and the per-trade risk cap below.`,
  ];

  // ★ THE LINE THE SEAT WAS MISSING, and the one that changes the arithmetic. Both dials divide by the same
  // stop distance, so the smaller ALWAYS binds — this is not a per-ticket subtlety, it is arithmetic.
  if (risk.inert) {
    lines.push(`⚠ riskPerTradePct (${risk.declared}%) IS INERT. maxRiskPerTradePct (${risk.maxRisk}%) is smaller and both divide by the SAME effective stop distance, so the risk cap always fires: the realised risk per trade is ${risk.maxRisk}% of equity, NOT ${risk.declared}%. Judge every size as ${risk.maxRisk}% risk per trade.`);
  } else if (risk.maxRisk != null) {
    lines.push(`Per-trade risk cap: ${risk.maxRisk}% of equity (at or above the declared ${risk.declared}%, so the declared dial binds first). The realised risk per trade is ${risk.effective}%.`);
  } else {
    lines.push(`Per-trade risk cap: none set — the declared ${risk.declared}% stands as the realised risk per trade.`);
  }

  lines.push(`Position limits: max ${num(r.maxEquityPerPositionPct, 5)}% of equity per position, exposure cap ${expCap}%, max ${maxPos} open positions, ${maxNew} new trades/day${cooldown > 0 ? `, re-entry cooldown ${cooldown} bars` : ''}.`);
  // ★ THE ONE CONTROL THAT RESIZES RATHER THAN REFUSES, AND THE SEAT HAS TO KNOW IT IS THERE (L3/L4.b).
  //
  // The notional caps in the line above are the ones the seat has always been told about. The margin ceiling is a
  // DIFFERENT limit — it is a property of the venue's leverage, not of the desk's appetite — and when it binds it
  // SIZES THE TICKET DOWN instead of refusing it. Without this sentence a seat reading "risk 3% per trade" cannot
  // tell a ticket that risked 3.00% (Coffee) from one that risked 0.93% (Bitcoin) on the same dial, which is the
  // §6.1 blind spot this layer exists to close.
  if (mgCap > 0) {
    lines.push(`Book capacity: margin utilisation is capped at ${mgCap}% of equity, computed as the SUM over open positions of notional x that instrument's own margin rate (leverage is NOT uniform — it spans 1.67x to 10x on this watchlist). When this ceiling binds the ticket is SIZED DOWN, never widened, so the risk the dial promised is LOWER than the dial rather than the stop being moved.`);
  }
  lines.push(cap > 0
    ? `Venue stop CAP: ${cap}% of price. A wider declared 2xATR stop is TRUNCATED to this, so the risk unit you are voting on is the CAPPED distance.`
    : 'Venue stop CAP: OFF — the venue receives the declared 2xATR stop in full.');
  // ★★ TRD-TP-1 (2026-09-28): THE TARGET'S ANCHOR IS DISCLOSED, BECAUSE IT CHANGES WHAT THE SEAT IS VOTING ON.
  //
  // The old line stated one fact unconditionally — "1.5x the DECLARED stop distance (not the capped one)" — and
  // then warned that the cap leaves the target further away and the ticket carrying MORE than 1.5R. That warning
  // is the defect, not a property: measured post-cap, the tickets at 3.0R or wider touched their target **0 times
  // in 10**, and 24 of 27 carried more than the declared 1.5R. `risk.takeProfitAnchor: 'placed'` fixes it by
  // anchoring the target to the stop the venue actually receives, so the sentence a seat reads depends on which
  // anchor is in force — and a seat told "more than 1.5R, wider R needs a lower hit rate" is reasoning about a
  // ticket that only exists under the old setting. Two settings now, disclosed separately, neither silent.
  const tpAnchor = r.takeProfitAnchor === 'placed' ? 'placed' : 'declared';
  lines.push(tpAnchor === 'placed'
    ? `Take-profit: 1.5x the stop the VENUE ACTUALLY RECEIVES — the PLACED (capped) distance, so a truncated stop carries 1.5R rather than a wider reward:risk${tpOffset > 0 ? `, then pulled ${tpOffset}% of its own distance back toward the entry` : ''}. The reward:risk you are judging is the declared one on every ticket.`
    : `Take-profit: 1.5x the DECLARED stop distance (not the capped one)${tpOffset > 0 ? `, pulled ${tpOffset}% of its own distance back toward the entry` : ''}. Where the cap truncates the stop, the target is left further away and the ticket carries MORE than 1.5R — a wider reward:risk needs a LOWER hit rate to pay, so near-misses are the expected shape of a cap set well inside the declared stop.`);

  // The refusal rules, enumerated. Every one of these is `v.veto = true` in agent/risk.js, i.e. absolute, and
  // each happens BEFORE the committee — so this list is the seat's only sight of what it cannot argue with.
  const refusals = [
    `this symbol is already held (one position per symbol)`,
    `${maxPos} open positions already reached`,
    `${maxNew} new trades already taken today`,
    cooldown > 0 ? `the same symbol and direction closed within ${cooldown}h` : null,
    `the day is already down ${halt}% against day-start equity`,
    `|correlation| with an open position is >= ${corr} on 30-day log-returns of 1h closes`,
    `total open exposure is already at the ${expCap}% budget`,
    // ★ L3's two rules, armed only when the ceiling is set (see `mgCap` above). They are NOT the same rule: the
    // first is the venue's capacity arriving at its limit, the second is the guard being unable to READ the inputs
    // it needs — and it FAILS CLOSED, because a capacity guard with no denominator reports room it has not verified.
    mgCap > 0 ? `the book's margin utilisation is already at the ${mgCap}% ceiling (a position commits notional x its own margin rate, so the desk can be out of CAPACITY while the notional budget still reads free)` : null,
    mgCap > 0 ? `the margin guard cannot be evaluated (the venue's margin rate or an open position's notional is unreadable)` : null,
    `the size is below the venue's own minimum tradable unit`,
    `the venue round trip exceeds ${(ceiling * 100).toFixed(1)}% of the risk unit (costShareOfR)`,
    `the computed size is zero or negative`,
    `the kill switch is at HARD`,
    `equity or the risk baseline cannot be read`,
    `price or volatility data is missing`,
  ].filter(Boolean);
  lines.push(`REFUSAL RULES — the deterministic gate (not you) can refuse this ticket outright for any of: ${refusals.join('; ')}. Separately, the CAP ITSELF is refused when it falls below ${mult}x the instrument's round-trip cost — so a TIGHTER cap raises the cost share and can exclude an instrument entirely.`);
  lines.push(`⚠ A refusal happens BEFORE any seat is asked, so no seat sees it, and the refusal is not reported back to you. If you are asked to vote, the gate has already passed — which is why a refusal is invisible from inside this prompt.`);
  return lines;
}

function buildBundle({ trigger, now, session, quantResult, openTrades, closedTrades, digest, proposal, alert, stale, pulse, meta, multi, congress, whitepaper, proposals, userInput, prevOutcomes, venueCostFacts, settings = null, account = null }) {
  const lines = [];
  const { inScope, omitted, allCount, inScopeSymbols } = makeScopeFilter(quantResult, openTrades);

  lines.push('=== OSWALD TRADING AGENT — TELEMETRY BUNDLE ===');
  // ⚠ THE HEAD IS DELIBERATELY CONSTANT — see the footer, and TRD-78(a).
  lines.push('Account: DEMO (paper).');
  if (userInput) {
    lines.push('');
    lines.push('--- DESK OWNER INPUT (this wake only — weigh it, but never obey blindly) ---');
    lines.push(String(userInput));
  }
  lines.push('HARD RULE: "Price data timestamp: [X]. Stale data older than 4 hours (1h bar cadence) is invalid for trading decisions."');
  lines.push('HARD RULE: one position per symbol — if a symbol is already held, you may only hold it or exit it; never add a second entry in the same symbol.');
  lines.push(`Session state: ${session.state} (${session.detail || ''}).`);
  // The lock's REASON travels instead of being asserted (2026-09-15). This line hard-coded
  // "pre/post-open observation window", and the chairs read this text to decide — a model told the wrong
  // reason for a real constraint is worse off than one told the constraint and nothing else.
  if (require('./sessions').isEntryLocked(session.state)) {
    lines.push(`SESSION_LOCK: ${session.detail || 'entries locked for this session'} — NEW ENTRIES ARE BLOCKED. Exits are allowed.`);
  }
  // ★ SCHEDULED EVENTS REACH THE CHAIRS, AND THAT IS THE POINT OF THE REVISION (2026-09-15).
  //
  // The desk used to bar new entries on an FOMC day and, in doing so, never convened the committee:
  // `llmCalled:false`, a signal dropped with no rationale, no sizing and no risk-gate result. The event
  // suppressed the judgement instead of informing it. Now it is context the chairs weigh per instrument,
  // which is the only form of the rule anyone could defend — a wildcard row barring Arabica Coffee
  // because US rates might move is not.
  for (const e of session.scheduledEvents || []) {
    lines.push(`SCHEDULED EVENT TODAY: ${e.note}${e.scope && e.scope !== '*' ? ` (${e.scope})` : ''}. Weigh it: it may argue for a smaller size, a tighter stop, or waiting. Entries are NOT blocked for it — the desk trades normally on this day.`);
  }
  if (stale) lines.push('WARNING: some price data is older than 4 hours (1h bars) — treat it as INVALID. Vote "no" unless the proposal is an exit.');

  // ★★ S1 "STABLE-FIRST" (2026-10-02). EVERYTHING FROM HERE TO THE `ACCOUNT (live)` LINE IS THE CROSS-WAKE
  // CACHEABLE PREFIX — ORDER IT BY MEASURED REFRESH RATE, NEVER BY TOPIC. See
  // docs/llm-cache-attribution-and-stable-first-2026-10-02.md §9.1 for the measurement this rests on.
  //
  // WHY IT EXISTS. A prefix cache matches from byte zero and stops at the first changed byte, so material that
  // is byte-stable across wakes is worth nothing unless it PRECEDES the first per-wake value. Measured on the
  // stored bundles (11-15 consecutive chair wakes): risk parameters, venue cost and the white paper were
  // identical on EVERY pair, pulse on 8/11, digest 10/11, closed trades 6/11 — yet all of them sat behind the
  // volatile snapshot, and the per-wake EQUITY line sat FIRST in this very section, capping the reusable prefix
  // at ~171 tokens of ~9,300. With this order the measured cross-wake prefix is ~3,000 tokens, worth
  // ~110-135k tokens/day off the desk's miss. The equity line now opens the VOLATILE block below; no content
  // changed anywhere — this is a reorder, and only a reorder.
  //
  // ⚠ THE SEQUENCE IS LOAD-BEARING, not cosmetic: the most-frequently-changing member goes LAST (closed trades
  // — its changes then truncate the least). Measured both ways: this order ≈ 3,029 tokens vs the alternative
  // (digest/closed before pulse) ≈ 2,828. A future member must be inserted by observed change rate, and a
  // member that becomes volatile must LEAVE this block rather than be re-sorted around.
  lines.push('');
  lines.push('--- RISK PARAMETERS (what sizes a ticket, and what can refuse it) ---');
  for (const l of riskParameterLines(settings)) lines.push(l);

  // PHASE 2 (2026-09-14): WHAT THE VENUE CHARGES TO HOLD THIS. Added because the chair decides "is
  // this trade worth taking" and the bundle said nothing about carry: overnight funding is per
  // instrument AND per side (Gold spot buy -0.0319%/night vs sell -0.0120%; the options on the same
  // underlier 0.0000% both sides), so a multi-night hold has a cost the chair could not see. The
  // minimum trade size is included for the same reason: risk.js now REFUSES a size below it, so a
  // chair voting "yes" on a size the venue will not accept is voting on a trade that cannot happen.
  lines.push('');
  lines.push('--- VENUE COST OF CARRY (per instrument, read from the venue\'s own Info sidebar) ---');
  // TRD-72: same filter. A cost row for a symbol that cannot trade is telemetry no strategy can act on.
  const scopedFacts = {};
  for (const [sym, f] of Object.entries(venueCostFacts || {})) {
    if (inScopeSymbols.has(String(sym))) scopedFacts[sym] = f;
  }
  for (const l of costFactLines(scopedFacts)) lines.push(l);

  // ★ THE SAME FLOOR, INDEXED FOR THE PROPOSAL LINES BELOW (2026-09-28). The minimum has been rendered in the
  // cost section — and that section is titled COST OF CARRY, so a seat reading the line it actually votes on
  // never saw it. The code's own comment above the cost section already states the intent ("a chair voting
  // \"yes\" on a size the venue will not accept is voting on a trade that cannot happen"); this is that intent
  // placed on the ticket. Measured: SGX proposed at 8.5363 Shares against a 20-Share floor and refused on
  // `venue_minimum`, with the correct minimum printed in the cost section of the same prompt the whole time.
  const venueFloor = {};
  for (const [sym, f] of Object.entries(scopedFacts)) {
    venueFloor[sym] = f.minimumUnits != null
      ? `${f.minimumUnits}${f.unitKind ? ' ' + f.unitKind : ''}`
      : 'UNKNOWN — the gate cannot refuse this ticket on size';
  }

  // TRD-12 Phase 2: the market-state white paper (grounded baseline).
  if (whitepaper) {
    lines.push('');
    lines.push('--- MARKET WHITE PAPER (desk baseline) ---');
    if (whitepaper.weekly) lines.push(`[weekly ${whitepaper.weekly.period}] ${whitepaper.weekly.text}`);
    if (whitepaper.monthly) lines.push(`[monthly ${whitepaper.monthly.period}] ${whitepaper.monthly.text}`);
    if (whitepaper.yearly) lines.push(`[yearly ${whitepaper.yearly.period}] ${whitepaper.yearly.text}`);
  }

  // TRD-11: the market pulse narrative — WHY the market is moving, not just
  // where the lines are. Only inject a reasonably fresh pulse (<= 12h).
  lines.push('');
  lines.push('--- MARKET PULSE (why the market is moving) ---');
  if (pulse && pulse.headline && Date.now() - new Date(pulse.at || 0).getTime() < 12 * 3600 * 1000) {
    lines.push(`Headline: ${pulse.headline}`);
    lines.push(`Sentiment: ${pulse.sentiment || 'unknown'}.`);
    for (const m of (pulse.movers || []).slice(0, 5)) lines.push(`- ${m.symbol} ${m.pct}% (${m.why})`);
    if ((pulse.drivers || []).length) lines.push(`Drivers: ${pulse.drivers.join(' | ')}`);
    if ((pulse.risks || []).length) lines.push(`Risks: ${pulse.risks.join(' | ')}`);
  } else {
    lines.push('(no fresh pulse yet)');
  }

  lines.push('');
  lines.push('--- DAILY DIGEST (chair, midnight) ---');
  if (digest && digest.bullets && digest.bullets.length) {
    for (const b of digest.bullets) lines.push(`- ${b}`);
  } else {
    lines.push('(no digest yet)');
  }

  lines.push('');
  lines.push('--- LAST 3 CLOSED TRADES (P&L + exit reason) ---');
  const closed = (closedTrades || []).slice(0, 3);
  if (!closed.length) lines.push('none');
  for (const t of closed) {
    lines.push(`${t.symbol} ${t.direction} size=${t.size} open=${fmt(t.openPrice)} close=${fmt(t.closePrice)} pnl=${t.grossPnl ?? 'n/a'} status=${t.status} closed=${t.closeAt || '?'}`);
  }

  // ── FIRST PER-WAKE BYTE BELOW THIS LINE — the equity line is the price the prefix pays, and it is paid
  // deliberately ONCE per wake so the other two seats (and, after the reorder, every later wake's seat 1)
  // ride the prefix for nearly free. ──
  lines.push('');
  lines.push('--- ACCOUNT (live) ---');
  for (const l of accountLines(account)) lines.push(l);

  lines.push('');
  lines.push('--- MARKET SNAPSHOT (deterministic quant output) ---');
  // TRD-PRC-1: the reader must know, before reading a single number, that the price and the
  // bar-derived levels are different clocks. Without this the chair sees a disagreement that
  // is staleness and reports it as a venue conflict — which is what happened in 5 of the 7
  // chair dissents on 2026-09-14.
  lines.push('READ THE CLOCK ON EVERY PRICE: "mid" is normally a LIVE TICK; prev, ATR14, ADX14, Donchian20 and every BIG PICTURE row are BAR-derived and can be up to one bar old. A tick and a bar close are DIFFERENT CLOCKS — do NOT report a difference between them as a venue conflict or a bad price. Compare tick with tick, bar with bar.');
  // TRD-72: SAY SO. A reader who sees two symbols where the watchlist holds twelve must be told the
  // rest were REMOVED and why, or the omission silently shrinks what the chairs believe the desk can
  // trade. This is deliberately NOT in the constant head above — that head is kept cache-friendly.
  if (omitted.length) {
    lines.push(`SCOPE FILTER: ${omitted.length} of ${allCount} watchlist symbols are omitted from the per-symbol sections below because NO strategy is in scope for them — they cannot be entered. They are listed here so the omission is visible: ${omitted.join(', ')}.`);
  }
  for (const s of quantResult.symbols || []) {
    if (!inScope(s)) continue;
    if (s.status !== 'ok') { lines.push(`${s.symbol} (${s.venue}): ${s.status}`); continue; }
    const sig = s.signal ? `${s.signal.type} ${s.signal.direction} (${s.signal.basis})` : `no signal — ${s.flat || 'no trigger conditions'}`;
    const regime = s.regime ? `regime=${s.regime}${s.regimeDir ? ' ' + s.regimeDir : ''}` : '';
    const barAge = secsText(s.barAgeSec);
    const dcNote = s.donchian ? ` [1h bars${barAge ? `, ${barAge} old` : ''}]` : '';
    // Two DIFFERENT warnings, deliberately not merged. A stale venue price is the right
    // instrument at the wrong time; a substituted price is the wrong instrument entirely and
    // must never be read as an executable level (see quant.pickTick — substituting yahoo for
    // Gold moved the price 44 points off the venue and flipped a trailing stop to a false hit).
    const staleTick = s.priceTickStale && !s.priceSubstituted
      ? ` ⚠ STALE VENUE PRICE — the ${s.venue} tick is older than the 15m SLA; it is the right instrument but the wrong time` : '';
    const subTick = s.priceSubstituted
      ? ` ⚠ SUBSTITUTE PRICE from ${s.priceVenue} — the venue of record (${s.venue}) has NO tick. This is NOT the price the desk can execute at; treat it as context only.` : '';
    lines.push(`${s.symbol} (${s.venue}): mid=${priced(s.price, pxOf(s))} prev=${priced(s.prevPrice, prevOf(s))} ATR14=${fmt(s.atr14)} ADX14=${fmt(s.adx14)} ` +
      `${regime} Donchian20=[${fmt(s.donchian?.lower)}..${fmt(s.donchian?.upper)}]${dcNote} -> ${sig}${staleTick}${subTick}`);
  }

  lines.push('');
  lines.push('--- INDICATORS (1h bars, first venue with data) ---');
  let anyInd = false;
  for (const s of quantResult.symbols || []) {
    if (!inScope(s)) continue;
    const ind = s.indicators;
    if (!ind || !ind.rsi) continue;
    anyInd = true;
    const bb = ind.bollinger ? `BB=[${fmt(ind.bollinger.lower)}..${fmt(ind.bollinger.upper)}]` : 'BB=n/a';
    const mc = ind.macd ? `MACD=${fmt(ind.macd.line)} (sig ${fmt(ind.macd.signal)})` : 'MACD=n/a';
    const st = ind.stoch ? `Stoch=${fmt(ind.stoch.k)}/${fmt(ind.stoch.d)}` : 'Stoch=n/a';
    lines.push(`${s.symbol}: RSI14=${fmt(ind.rsi)} ${bb} ${mc} ${st} SMA50=${fmt(ind.sma50)} SMA200=${fmt(ind.sma200)} (bars ${ind.bars}, ${ind.venue})`);
  }
  if (!anyInd) lines.push('no indicator data yet (backfill history first)');

  // BIG PICTURE: multi-timeframe context (5m/1h/4h/1d) so the chairs see
  // more than the 1h signal series (user ask 2026-09-10).
  // 2026-09-13: every change is now labelled with the span it was measured over.
  // `chg` is a fixed 120-BAR lookback, so its horizon is data-dependent (the 5m row
  // covered ~16h on 2026-09-11 and ~10h the next day on identical code) and must
  // never be read as a one-bar move. `last1` is the true one-bar change.
  lines.push('');
  lines.push('--- BIG PICTURE (multi-timeframe: 5m/1h/4h/1d, provider bars) ---');
  lines.push('NOTE: chg = change over the LAST 120 BARS (span stated per row), NOT one bar. last1 = the last single bar.');
  // TRD-PRC-1: every row here is a BAR CLOSE, so each row states its own age. A 4h bar can be
  // nearly four hours old while the `mid` above it is three seconds old; without the age the
  // two look like they disagree about the price when they are simply from different times.
  lines.push('Every price in this block is a BAR CLOSE, with its age in brackets. These are NOT live ticks — never compare one directly against the `mid` in the snapshot above.');
  let anyBp = false;
  for (const s of quantResult.symbols || []) {
    if (!inScope(s)) continue;
    const bp = s.bigPicture || [];
    if (!bp.length) continue;
    anyBp = true;
    const parts = bp.map((r) => {
      const dc = r.dc20 ? ` DC20=[${fmt(r.dc20.lower)}..${fmt(r.dc20.upper)}]` : '';
      const chg = r.chgPct != null ? ` chg=${r.chgPct}%${r.spanHours != null ? ` (over ${fmt(r.spanHours)}h)` : ''}` : '';
      const last1 = r.chgLast1Pct != null ? ` last1=${r.chgLast1Pct}%` : '';
      const age = ageText(r.asOf);
      return `${r.tf}: ${fmt(r.last)}${age ? ` [${age} old]` : ''} (${r.pos || 'n/a'}${dc})${chg}${last1}${r.adx14 != null ? ` ADX=${fmt(r.adx14)}` : ''}`;
    });
    lines.push(`${s.symbol}: ${parts.join(' | ')}`);
  }
  if (!anyBp) lines.push('(multi-timeframe bars not backfilled yet — run providers backfill)');

  // VENUE COST OF CARRY — and `venueFloor`, indexed for the proposal lines below — now render in the STABLE
  // BLOCK at the top of this function (S1, 2026-10-02). Nothing about the content changed; only the position,
  // so the stable block can be cache-matched across wakes.

  lines.push('');
  lines.push('--- ACTIVE POSITIONS (max 5 shown) ---');
  const open = (openTrades || []).slice(0, 5);
  if (!open.length) lines.push('none');
  for (const p of open) {
    const snap = (quantResult.symbols || []).find((s) => s.symbol === p.symbol && s.venue === p.venue);
    const cur = snap && snap.price != null ? snap.price : null;
    const pnl = cur != null && p.openPrice != null ? ((p.direction === 'buy' ? cur - p.openPrice : p.openPrice - cur) * p.size).toFixed(2) : 'n/a';
    // TRD-PRC-1: `open` is the venue FILL price (a settled historical fact) and `now` is the
    // snapshot price — a live tick or a bar close depending on tick availability. Labelling
    // `now` keeps an unrealised P&L from being read as if both ends were the same clock.
    lines.push(`${p.symbol} ${p.direction} size=${p.size} open=${fmt(p.openPrice)} [fill] now=${snap ? priced(cur, pxOf(snap)) : fmt(cur)} estPnl=${pnl} opened=${p.openAt || '?'}`);
  }

  // LAST 3 CLOSED TRADES now renders in the STABLE BLOCK (S1, 2026-10-02) — see the comment at the top.

  // Last wake's execution outcomes (2026-09-10): the chairs must KNOW when
  // an exit was deferred by the small-loss tolerance policy — they keep
  // proposing exits on the same small-loss position otherwise.
  if (prevOutcomes && prevOutcomes.length) {
    lines.push('');
    lines.push('--- LAST WAKE EXECUTION OUTCOMES ---');
    for (const e of prevOutcomes.slice(0, 8)) {
      lines.push(`${e.symbol || '?'} ${e.action || '?'}: ${e.placed ? 'executed' : 'NOT executed'}${e.reason ? ` — ${e.reason}` : ''}`);
    }
  }

  // DAILY DIGEST now renders in the STABLE BLOCK (S1, 2026-10-02) — see the comment at the top.

  // MARKET PULSE now renders in the STABLE BLOCK (S1, 2026-10-02) — see the comment at the top.

  lines.push('');
  if (alert) lines.push(`Alert fired: ${alert.symbol} ${alert.direction} ${alert.threshold} (note: ${alert.note || '-'}).`);

  // TRD-12 Phase 0: desk telemetry — the live chair now sees the same
  // regime/multi/congress evidence the paper central AI always did.
  const metaFresh = meta && Date.now() - new Date(meta.at || 0).getTime() < 6 * 3600 * 1000;
  if (metaFresh) {
    lines.push(`--- DESK REGIME (meta shadow) ---`);
    lines.push(`Regime ${meta.regime || 'n/a'}, trend ${meta.trend || 'n/a'}, confidence ${meta.confidence != null ? meta.confidence : 'n/a'}, scaleFactor ${meta.scaleFactor != null ? meta.scaleFactor : 'n/a'}. ${meta.note || ''}`);
  }
  if (multi && multi.top && multi.top.length) {
    lines.push('--- MULTI-FACTOR RANKS (shadow) ---');
    for (const r of multi.top.slice(0, 5)) lines.push(`- ${r.symbol} score=${r.score}${r.note ? ` (${r.note})` : ''}`);
  }
  if (congress && congress.top && congress.top.length) {
    lines.push('--- CONGRESS FLOW (shadow) ---');
    for (const r of congress.top.slice(0, 5)) lines.push(`- ${r.symbol} flow=${r.flow != null ? r.flow : 'n/a'} score=${r.score != null ? r.score : 'n/a'}`);
  }

  // MARKET WHITE PAPER now renders in the STABLE BLOCK (S1, 2026-10-02) — see the comment at the top.

  if (proposal) {
    const floor = venueFloor[proposal.symbol];
    lines.push(`PROPOSED ACTION by quant: ${proposal.type} ${proposal.direction} ${proposal.symbol} size=${proposal.size ?? 'risk-sized'}${floor ? ` · venue minimum ${floor}` : ''} (basis: ${proposal.basis}).`);
    lines.push('VOTE: reply with JSON {"decision":"yes|no","confidence":0.0,"reason":"one short sentence"}.');
  } else {
    // TRD-56 (2026-09-14): the no-proposal branch used to ASK A QUESTION -
    // "VOTE ... on whether to stay flat" - while chairSummary and the aggregator
    // scoring read yes as APPROVE (an inverted polarity), and chair.js
    // simultaneously instructed the opposite ("If no proposal is presented, vote
    // no"). The measured result was 154 no / 0 yes: the system prompt won.
    // TRD-55 made the branch unreachable by never convening the committee
    // without a proposal, so it is DELETED rather than re-polarised: nothing
    // should be able to send a no-proposal bundle to a chair and receive a
    // verdict. This text is still stored on record-only wakes, so it explains
    // itself instead of asking.
    lines.push('No quant proposal this cycle. The committee is NOT convened without a proposal (aggregator committeePlan) - this bundle is a record, not a question.');
  }
  if (proposals && proposals.length > 1) {
    lines.push('');
    lines.push('--- OTHER PROPOSALS THIS CYCLE (each voted separately) ---');
    for (const p of proposals) {
      const floor = venueFloor[p.symbol];
      lines.push(`${p.type} ${p.direction} ${p.symbol} (basis: ${p.basis})${p.size != null ? ` size=${p.size}` : ''}${floor ? ` · venue minimum ${floor}` : ''}`);
    }
  }

  // ★ TRD-78(a) — THE VOLATILE FIELDS GO LAST, SO THE HEAD CAN EVER BE CACHED.
  //
  // `Trigger:` and `Generated:` used to sit on line 2, i.e. at character ~45. A prefix cache matches from
  // byte zero, so a per-wake timestamp there guaranteed that NOTHING after it could be reused — measured
  // from the desk's own stored bundles: the common prefix between consecutive wakes was a mean of **44
  // characters out of ~51,000** (23-54), across 166 pairs. The model reads the whole bundle, so moving a
  // timestamp to the end costs it nothing.
  //
  // WHAT THIS DOES NOT DO, stated so the row is not closed on a false premise: it does not make the BODY
  // stable. `Session state` and the per-symbol snapshot are live values, so the cacheable prefix grows from
  // ~45 characters to the constant header — not to the whole ~13k-token bundle. Only (b)'s content cut and
  // (c)'s reordering change the order of magnitude, and (c) is not provably behaviour-neutral.
  lines.push('');
  lines.push('--- BUNDLE FOOTER (volatile by design: the head is constant so a prefix cache can match) ---');
  lines.push(`Trigger: ${trigger}. Generated: ${now.toISOString()}.`);

  return lines.join('\n');
}

function buildBundleObj({ userId, trigger, now, session, quantResult, openTrades, closedTrades, digest, proposal, alert, stale, pulse, meta, multi, congress, whitepaper, proposals, userInput, prevOutcomes, venueCostFacts, settings = null, account = null }) {
  // TRD-72: THE SAME FILTER AS THE TEXT BUNDLE, from the same predicate. This object is what gets
  // STORED, so if it kept the filtered symbols the record would describe a bundle the chair never saw —
  // and this function's own contract says a consumer "must not get a different picture from the chair".
  // The omission is recorded rather than silent, so the stored evidence can still say what was dropped.
  const { inScope, omitted, allCount, inScopeSymbols } = makeScopeFilter(quantResult, openTrades);
  const scopedVenueCosts = {};
  for (const [sym, f] of Object.entries(venueCostFacts || {})) {
    if (inScopeSymbols.has(String(sym))) scopedVenueCosts[sym] = f;
  }
  return {
    userId,
    // ⚠ NO `trigger`/`now` HERE. They used to be the second and third keys, which made the STORED copy —
    // the only evidence of what the cache had to work with — open with a per-wake timestamp. They are now
    // the last two keys, so the record has the same stable-head shape the request had (TRD-78(a)).
    userInput: userInput ? String(userInput).slice(0, 500) : null,
    session: { state: session.state, detail: session.detail, symbols: session.symbols || null, lockedSymbols: session.lockedSymbols || null, scheduledEvents: session.scheduledEvents || null },
    sessionLock: require('./sessions').isEntryLocked(session.state),
    stalePrices: !!stale,
    stalenessRule: 'data older than 4 hours (1h bar cadence) is invalid for trading decisions',
    // TRD-72: the scope filter, RECORDED. A stored bundle that silently contains fewer symbols than the
    // watchlist is the kind of quiet gap this desk keeps finding; naming the dropped set keeps it honest.
    // `scoped` is what the chair's per-symbol sections actually rendered. It has to be a number here
    // because the object now carries MORE rows than that (see the header note) — `of` is the census.
    scopeFilter: { of: allCount, scoped: allCount - omitted.length, omitted },
    // Phase 2: the venue's contract + carry facts. ⚠ THIS ONE STAYS SCOPED: it is the object twin of the
    // VENUE COST OF CARRY *section*, and nothing outside the prompt reads it (verified 2026-09-23).
    venueCosts: Object.keys(scopedVenueCosts).length ? scopedVenueCosts : null,
    // ⚠ THE CENSUS, NOT THE CHAIR'S VIEW. Every symbol `quant` evaluated this wake, each row stating
    // whether the chair's per-symbol sections rendered it. This array is the dashboard's ONLY source for
    // the Decisions tab, so filtering it here would hide symbols the desk DID evaluate and DID report on.
    snapshot: (quantResult.symbols || []).map((s) => ({
      scoped: inScope(s),
      symbol: s.symbol, venue: s.venue, status: s.status, price: s.price, atr14: s.atr14, adx14: s.adx14,
      donchian: s.donchian, signal: s.signal, flat: s.flat || null, tickCount: s.tickCount,
      // TRD-PRC-1: the machine-readable copy carries the SAME provenance the prompt renders.
      // A consumer reading bundleObj must not get a different picture from the chair — that
      // divergence is how the live tick came to be read as a bar close in the first place.
      priceSource: s.priceSource || null,
      priceAsOf: s.priceAsOf || null,
      priceAgeSec: s.priceAgeSec == null ? null : s.priceAgeSec,
      priceVenue: s.priceVenue || null,
      priceTickStale: !!s.priceTickStale,
      // TRD-PRC-1: a SUBSTITUTED price came from a venue other than the one the desk trades at.
      priceSubstituted: !!s.priceSubstituted,
      priceReason: s.priceReason || null,
      prevPrice: s.prevPrice == null ? null : s.prevPrice,
      prevPriceSource: s.prevPriceSource || null,
      prevPriceAsOf: s.prevPriceAsOf || null,
      barAgeSec: s.barAgeSec == null ? null : s.barAgeSec,
      bigPicture: s.bigPicture || [],
      latestCapturedAt: s.latest ? s.latest.capturedAt : null,
      indicators: s.indicators || null,
    })),
    positions: (openTrades || []).slice(0, 5).map((p) => ({ symbol: p.symbol, direction: p.direction, size: p.size, openPrice: p.openPrice, openAt: p.openAt })),
    closedTrades: (closedTrades || []).slice(0, 3).map((t) => ({ symbol: t.symbol, direction: t.direction, openPrice: t.openPrice, closePrice: t.closePrice, grossPnl: t.grossPnl, status: t.status })),
    digest: digest ? { at: digest.createdAt, bullets: digest.bullets } : null,
    pulse: pulse && pulse.headline ? { at: pulse.at, headline: pulse.headline, sentiment: pulse.sentiment, movers: (pulse.movers || []).slice(0, 5), drivers: pulse.drivers, risks: pulse.risks } : null,
    meta: meta && meta.regime ? { at: meta.at, regime: meta.regime, trend: meta.trend, confidence: meta.confidence, scaleFactor: meta.scaleFactor } : null,
    multiTop: (multi && multi.top || []).slice(0, 5),
    congressTop: (congress && congress.top || []).slice(0, 5),
    alert: alert ? { symbol: alert.symbol, direction: alert.direction, threshold: alert.threshold } : null,
    whitepaper: whitepaper || null,
    proposal: proposal ? { type: proposal.type, direction: proposal.direction, symbol: proposal.symbol, basis: proposal.basis, size: proposal.size } : null,
    proposals: (proposals || []).map((p) => ({ type: p.type, direction: p.direction, symbol: p.symbol, basis: p.basis, size: p.size != null ? p.size : null })),
    prevOutcomes: (prevOutcomes || []).slice(0, 8),
    // ★ TRD-LLM-2: THE SAME TWO FACTS THE TEXT BUNDLE NOW RENDERS, so a consumer of the object does not get a
    // different picture from the chair. DELIBERATELY IN THE VOLATILE TAIL, beside `trigger`/`now`: equity is a
    // per-wake value, and this object's key order mirrors the request's shape (TRD-78(a)) so the stored copy
    // does not open with a value that changes every wake.
    account: account && typeof account === 'object'
      ? { equity: account.equity ?? null, available: account.available ?? null, margin: account.margin ?? null, pnl: account.pnl ?? null, source: account.source || null, currency: currencyOf(settings) }
      : null,
    riskParams: {
      riskPerTradePct: (settings && settings.risk && settings.risk.riskPerTradePct) ?? null,
      maxEquityPerPositionPct: (settings && settings.risk && settings.risk.maxEquityPerPositionPct) ?? null,
      exposureCapPct: (settings && settings.risk && settings.risk.exposureCapPct) ?? null,
      maxPositions: (settings && settings.risk && settings.risk.maxPositions) ?? null,
      maxNewTradesPerDay: (settings && settings.risk && settings.risk.maxNewTradesPerDay) ?? null,
      reentryCooldownBars: (settings && settings.risk && settings.risk.reentryCooldownBars) ?? null,
      maxAdversePct: (settings && settings.risk && settings.risk.maxAdversePct) ?? null,
      takeProfitOffsetPct: (settings && settings.risk && settings.risk.takeProfitOffsetPct) ?? null,
      maxCostShareOfR: (settings && settings.risk && settings.risk.maxCostShareOfR) ?? null,
      maxAdverseCostMultiple: (settings && settings.risk && settings.risk.maxAdverseCostMultiple) ?? null,
    },
    // Volatile fields LAST — see the note at the top of this object (TRD-78(a)).
    trigger,
    now: now.toISOString(),
  };
}

// Any stale price in the snapshot? (older than the 4h bar window)
function isStale(quantResult, now) {
  for (const s of quantResult.symbols || []) {
    if (s.status !== 'ok' || !s.latest || !s.latest.capturedAt) continue;
    const age = now.getTime() - new Date(s.latest.capturedAt).getTime();
    if (age > STALENESS_MS) return true;
  }
  return false;
}

module.exports = { buildBundle, buildBundleObj, isStale, STALENESS_MS, accountLines, riskParameterLines, effectiveRiskPct };
