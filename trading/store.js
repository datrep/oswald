// trading/store.js — data access for the Trading Agent.
// Phase 0: schema probe + settings + events. TRD-1 adds prompts, prompt errors,
// alerts, price-tick reads, and trade reads for the wake cycle. All queries are
// owner-scoped (userId).
'use strict';

const { getPool, sql } = require('./db');
// TRD-12 Phase 1: ticks + bars live in their own repositories (validated
// ingest + flagged bars); re-exported below for callers.
const ticksRepo = require('./store/ticks');
const barsRepo = require('./store/bars');
// TRD-116 option (b), 2026-09-25: the scope rule, so a settings write can tell whether it just orphaned an
// enabled strategy. `scopeResolution` has NO eager dependencies of its own (it resolves the strategy registry
// lazily) precisely so this low-level module can require it without closing a require cycle.
const scopeResolution = require('./scopeResolution');
// TRD-RSK-8: the settings-write diff (pure — no DB, no logger — so the redaction and the no-op rule are
// testable without a database).
const settingsDiff = require('./settingsDiff');
// 2026-10-18 (owner: weekend trades are a separate class inside the same era): every trade is stamped with
// the session class of its ENTRY here, at the ONE choke point every writer passes through — deriving it at
// each call site is the fix that gets applied at four of five sites.
const { sessionClassOf } = require('./lib/sessionClass');

const NVMAX = sql.NVarChar(sql.MAX);

// Per-user defaults, merged under stored settings (stored wins). The watchlist
// starts EMPTY — nothing trades until the user confirms symbols (P2 auto-fill).
const DEFAULT_SETTINGS = {
  kill: { tier: 'off', disasterFloorPct: -8, autoClose: false }, // tier: off | soft | hard
  risk: {
    initialEquity: 2685.76,
    maxPositions: 3,
    maxEquityPerPositionPct: 5,
    maxNewTradesPerDay: 6, // was 3 — multi-symbol wakes burned it before Oil could enter (2026-09-10)
    // F17 (2026-09-18): how stale the venue feed may be before the AGENT refuses to open a position. It
    // is an absolute number of minutes so the owner can set it without knowing the cadence arithmetic;
    // `null` (the default) DERIVES it as 3 × the wake interval, which is the same threshold the data-plane
    // chip uses — so "the chip is red" and "entries are refused" are one fact, not two that can drift.
    maxEntryTickAgeMin: null,
    // F20 (2026-09-18): the levels are anchored to the DECISION price and the fill lands 13-142s later
    // (TRD-37), so the geometry the desk declares (1.5R) is not always the geometry the position has.
    // `Trades #1046` filled 1.56% away from its anchor and carried a REALISED R:R of **0.22** — a position
    // risking ~4.5× its expected reward. This is the floor, as a PERCENTAGE of the declared R:R so it does
    // not drift if the declared ratio changes. `0` disables the check.
    minRealisedRrPct: 50,
    // TRD-114 (2026-09-21): THE VENUE ROUND TRIP AS A SHARE OF THE RISK UNIT — computed in stopPolicy,
    // printed in the risk notes, and read by NO rule until now, while live trades ran at 60.8% / 68.3% of R
    // in cost. `maxAdverseCostMultiple` (1.5) was ALREADY this dial: `cap >= 1.5 x costPct` is the same
    // inequality as `costPct/stopPct <= 66.7%`, so this names the quantity instead of implying it. The
    // multiple survives only as the legacy fallback, and WHICH one supplied the number is reported.
    //
    // ⚠ 0.65 IS BOUNDED BY THE MEASURED OPTIMUM, NOT CHOSEN FREELY. The round trip is a fixed % of price,
    // so tightening the stop RAISES its share of R — the opposite direction to `maxAdversePct`, which is the
    // measured-best lever (temp/sweep-stop-cap.js: cap 0.30% nets -28.89 / E -0.932, vs -46.93 / E -1.514 at
    // the 0.40% a 30% ceiling would demand, vs -72.15 uncapped). Any ceiling below Oil's ~58% either refuses
    // Oil outright or forces that worse stop. 0.65 sits clear of every instrument on the book (Gold 39.8%,
    // Oil ~60% capped), so it guards against a cost basis BLOWING OUT rather than filtering trades.
    // Tightening it is a strategy decision, not a tuning one; the table is in temp/sweep-cost-share.js.
    maxCostShareOfR: 0.65,
  // 2026-09-25: pull the TAKE-PROFIT in by this percentage of its own distance, so a near-miss books a win
  // instead of becoming a loss. 0 = OFF (the geometry the survivors were validated with). See entryLevels.
  takeProfitOffsetPct: 0,
  // ★ TRD-TP-1 route (2) (2026-09-28): WHERE THE TAKE-PROFIT IS MEASURED FROM.
  //   'declared' (this default) — 1.5 x the 2xATR the strategy asked for. A capped stop then leaves the target
  //      further away, so the ticket carries MORE than 1.5R: measured post-cap, the tickets at 3.0R or wider
  //      touched their target 0 times in 10, and 24 of 27 carried more than the declared 1.5R.
  //   'placed'   — anchored to the stop the venue ACTUALLY receives, so every ticket carries the declared 1.5R.
  //      Replayed on the 25 trades that ran past 1.6R: +0.46R per trade better.
  // Ships as 'declared' because these levels belong to a FROZEN forward-validation candidate (TRD-29) whose
  // contract says any retuning voids it, and that track is the only reason survgold/survoil are trusted. The
  // dial is on the risk panel; moving it is annotated on every capped ticket so the track stays separable.
  takeProfitAnchor: 'declared',
    // ★ 2026-09-28 — ACCEPT THE VENUE FLOOR'S RISK INSTEAD OF REFUSING THE TICKET. Default **FALSE**, i.e.
    // the veto in `instruments.checkSize` is unchanged unless an owner turns this on.
    //
    // WHAT IT DOES: when the computed size is below the venue's own minimum tradable unit, raise the size to
    // the floor and DISCLOSE the exceedance, rather than vetoing on `venue_minimum`. The module header's
    // objection to clamping is that it would do so *"quietly"* — so this names it in `reasons`, carries it on
    // `venueFloor.accepted` with its multiple, prints it in the TICKET GEOMETRY note the seat reads, and
    // records it on the decision row.
    //
    // THE MEASURED MOTIVE: SGX's 20-Share floor forces **0.1640%** of equity against this desk's 0.07% dial —
    // **2.34x** — while every other symbol's floor sits at 0.11x-0.78x. The alternatives were this, dropping
    // SGX from scope, or raising a dial that has no per-symbol form. Measured: the `venue_minimum` veto fired
    // **18 times in 2h24m** on 2026-09-28, every one of them SGX.
    acceptVenueFloor: false,
    // ★ TRD-EXE-10 (2026-09-30) — SIZE ON THE LOSS THE STOP ACTUALLY TAKES, NOT THE DISTANCE IT SITS AT.
    // The venue's stop fills ~1.305x its own distance from entry. MEASURED over the desk's whole journal: 24
    // venue stop-outs across 14 days, each carrying BOTH the venue's quoted rate and the real fill, compared ON
    // THE SAME TRADE — the RATE sits on the level (median 1.006x) and the FILL is what travels (median 1.305x,
    // p90 1.431, max 4.370). The take-profit side moves by the same 1.294x, which is why this is a DE-LEVER and
    // not a source of return: a TP is a LIMIT and can fill past its level, a stop becomes a STOP-MARKET and fills
    // short of it.
    //
    // WHAT IT CHANGES: the size is divided by `riskStopDist x this` instead of `riskStopDist`, and the same
    // distance is used for the `maxRiskPerTradePct` cap and for `resolvedRiskPct`. So `riskPerTradePct: 3` now
    // realises ~3% on a stop-out instead of ~3.9%. The stop LEVEL is untouched, and a value below 1 is REFUSED
    // in the open rather than clamped (a control that silently ignores its setting is this repo's oldest defect).
    // ROLLBACK: set it to 1, which reproduces the previous behaviour exactly.
    stopSlippageFactor: 1.305,
    // ★★ TRD-EXE-13 (2026-10-01): THE ENTRY-SIDE TWIN OF THE ABOVE, and the same shape throughout — measured,
    // refused below 1, rolled back by setting it to 1.
    //
    // WHY IT EXISTS. `stopSlippageFactor` corrects the distance the loss travels on the way OUT. This corrects the
    // way IN. Measured over the 73 recorded `entry_reanchored` events, each carrying BOTH the decision price and
    // the sized stop distance: **74% of entries fill ADVERSE to the decision price** (54 of 73; under a symmetric
    // null that is p ~ 2e-5, so it is a skew and not noise), so the stop the position actually sits behind is
    // further away than the one it was sized against — realised/sized distance averages **1.083x**, min 0.486x,
    // max 2.518x.
    //
    // ⚠ DEFAULT 1 IS THE DECISION, NOT AN UNFILLED PLACEHOLDER. Turning it on makes sizes ~8% smaller and it
    // COMPOUNDS with the currency correction (~22%), so it is a live posture change that belongs to the owner
    // rather than to a hardening pass. The capability, the test and the record are all in place; switching it on
    // is one key. Above 1 shrinks the size; below 1 is REFUSED and reported in the open, because it would assert
    // entries fill BETTER than the decision price on average, which 54 of 73 rows disprove.
    entryDriftFactor: 1,
    riskPerTradePct: 1,      // Turtle: capital x 1% / (2 x ATR)
    atrStopMultiple: 2,
    correlationVeto: 0.7, // P1-9 (2026-09-10): threshold for the 30-day log-returns correlation veto (was 0.9 on raw price levels)
    // TRD-12 Phase 2: portfolio-level guards (granular UI in Deliberation).
    exposureCapPct: 15,      // total open exposure (incl. mirrored) budget vs equity
    dailyLossHaltPct: 3,     // -3% vs day-start equity blocks NEW entries (auto-release next UTC day)
    // ★ L5 (2026-09-29): WHICH DAY THE HALT BELONGS TO. `'utc_midnight'` reproduces the long-standing behaviour
    // exactly; `'venue_session'` anchors to the venue's own 21:00 UTC boundary, which is the desk's trading day.
    //
    // THE DEFECT THE DEFAULT LEAVES IN PLACE, stated so it is a decision rather than an oversight: UTC midnight
    // falls INSIDE a live session, so one session spans two halt-days and the halt RESETS MID-SESSION with the
    // market open. Measured, the two anchors differ only between 21:00 UTC and midnight — where the session
    // anchor has just reset and the UTC one has not — so switching is stricter for 21 hours and looser for three.
    // The anchor travels on every `day_start` row (`anchorMinuteUtc`), so a baseline can always be re-derived.
    dailyHaltAnchor: 'utc_midnight',
    // ★ L3 (rev 5, 2026-09-29): THE VENUE'S CAPACITY, WHICH IS NOT THE SAME LIMIT AS THE NOTIONAL CAPS.
    //
    // `maxEquityPerPositionPct` and `exposureCapPct` are denominated in NOTIONAL, but the venue's real limit
    // is `Σ (notional_i × marginRate_i) ≤ equity × maxMarginUtilisationPct` — and a notional is not a margin.
    // Gold at 1:5 costs 20% of its notional in margin; Bitcoin at 1:1.67 costs 60%. So a book can be inside
    // every notional cap and still have no room to open anything, and vice versa. This is the second limit.
    //
    // ⚠ PRESENT IN DEFAULTS IS THE POINT, not a convenience. `risk.js` ARMS the guard only when this number
    // is finite and positive (`marginArmed`), and an absent key is indistinguishable from a switched-off
    // one — the `maxRiskPerTradePct` precedent, where a missing key silently disabled a guard while the code
    // read as though it were armed. 80 is the owner's decision (§L3.c): at 60% the guard prices the desk out
    // of its own 3% target on EVERY symbol, and at 95% a gap through the stop is a margin call rather than a
    // loss. It is deliberately NOT a profile key (`trading/riskProfile.js`) — see the note there.
    //
    // ⚠ IT RESIZES, IT DOES NOT WIDEN: the last sizing control to act, and the only one whose binding is a
    // CAPACITY fact. It cannot fire while `maxEquityPerPositionPct` is 80 (the largest possible margin is
    // Bitcoin's 80% × 60% = 48%), which is why L3 is safe to land before L2 raises that cap.
    maxMarginUtilisationPct: 80,
    reentryCooldownBars: 6,  // implied goal: no same-symbol/direction re-entry within N 1h bars of a close
    // Small-loss tolerance (2026-09-10): when an EXIT decision fires but the
    // floating loss is within maxLossAtR x ATR (spread/noise zone), HOLD the
    // position instead of churning small losses. The venue-native stop
    // (atrStopMultiple x ATR) stays the hard floor.
    exitTolerance: { enabled: true, maxLossAtR: 0.5 },
    // TRD-ANC-1 (2026-09-25): THE ANCHOR-AGE GATE — **OFF**, and deliberately so.
    //
    // The levels are anchored to a snapshot price; the fill lands a median **65s** later (max 524s), and the
    // drift grows with that lag (|drift| 0.016% youngest half vs 0.043% oldest, Spearman +0.305, n=30). The
    // venue's `priceTickStale` cannot catch it — `TICK_SLA_MS` is 15 MINUTES, so it returned false on a
    // 427-second-old price (#1082, the largest drift measured). And the F20 re-anchor is structurally inert:
    // measured, **0 venue ticks existed between the anchor price and the fill in 30 of 30 entries**, so
    // there is nothing newer for it to read.
    //
    // `null` (or absent, or <= 0) means NOT GATED — exactly the pre-existing behaviour, the same
    // three-valued contract `quant.pickTick` states for `allowedVenues`: "A flag that is off must not change
    // a single price." When set, an entry whose anchor is older than this many seconds is REFUSED (not
    // clamped — `risk.js` vetoes rather than clamps) and logged as `order_blocked`/`anchor_too_old`.
    //
    // ★ THE VALUE IS AN OWNER DECISION FROM THE MEASURED DISTRIBUTION, NOT A DEFAULT I PICKED. On the 30
    // entries measured: 120s would have refused 4 (13%, incl. #1082 at 524s — the worst drift); 300s would
    // have refused 1 (3%). Every entry is recorded with `anchorAgeSec` and `anchorAgeWouldRefuse` whether or
    // not the gate is on, so the threshold can be chosen from data after the fact.
    maxAnchorAgeSec: null,
    // TRD-TRL-2 (#1485): the VENUE-NATIVE trailing stop. **OFF BY DEFAULT, and inert until switched on** — the
    // executor then asks for nothing and the bridge never opens the ticket card.
    //
    // The venue stop stays the MANDATORY exit and the trail sits ON it. At `distanceMultiple: 1` (the default) the
    // trail lands exactly on the stop's own level at any price, so it does not move the level the sizing was
    // computed against. ⚠ `distanceMultiple < 1` places a trail TIGHTER than that level and is REFUSED unless
    // `allowTighterThanStop` says otherwise, because the venue arbitrates between the two levels and the tighter
    // one fires first — a tighter trail REPLACES the stop rather than adding to it, and every `R` on this desk
    // divides by that same stop distance. Measured 2026-09-30: both instruments checked had a trail set TIGHTER
    // than their stop, so this is not a hypothetical.
    trailingStop: {
      enabled: false,
      distanceMultiple: 1,
      allowTighterThanStop: false,
      // The count the desk sets FIRST, purely to observe the venue's own read-back and scale from it. The desk
      // deliberately never learns the pip size — a controlled pair measured 0.010004 on Bitcoin, i.e. a cent.
      // A read-back under S$1.00 is refused rather than scaled from, because the span prints 2 decimals.
      probePips: 100000,
      verifyTolerancePct: 2,
      // ★ TRD-TRL-9 (2026-10-08): THE POST-ENTRY ENGAGE — lock075_t15, the best exit config on record (fresh-n
      // re-checked 2026-10-08: both Δ tails' 90% lower bounds positive). When the favourable excursion touches
      // `lockR` stop-distances, the stop moves to that lock level and a trail engages `trailR` behind the peak
      // (venue-native: one stop write + one trail count, engaged together through the Edit card).
      // ⚠ OFF BY DEFAULT, AND OFF AT DEPLOY: while `enabled !== true`, `agent/trailEngage` returns on its first
      // line and NOTHING about the desk's exits changes. The first live engage is deliberately held for the
      // owner walkthrough; the read-only verification (`POST /orders/edit-trail-probe`) runs first.
      engageOnTouch: { enabled: false, lockR: 0.75, trailR: 0.15 },
    },
  },
  wake: {
    enabled: true, intervalMinutes: 10, jitterPct: 30, marketHoursOnly: true, paused: false,
    // implied goal #4: stop/TP-proximity micro-wakes (bounded cadence)
    microWake: { enabled: true, minIntervalMin: 2, proximityPct: 0.25, checkEverySec: 30 },
  },
  // TRD-92 (2026-09-21): PriceTicks retention, and the archive that makes the prune non-destructive.
  // The window used to be a literal 7 in agent/bars.js (with a second silent 7 in store/bars.js), which is
  // why the 2026-09-19 excursions and TRD-108's 21 autopsies could not be re-derived afterwards. Read by
  // `agent/tickArchive.archiveAndPrune`; resolved by `agent/retention.resolveTickDays`, which REFUSES an
  // unusable value loudly instead of substituting one quietly. Cost basis measured 2026-09-21: 19,761 rows
  // / ~1.9 MB per 7 days, so 90 days is ~25 MB.
  retention: {
    tickDays: 7,           // days of PriceTicks to keep; <= 0 or non-numeric is refused -> 7, with a note
    archive: true,         // write the expiring rows to gzipped JSONL BEFORE deleting them
    archiveDir: null,      // null -> trading/archive/ticks
    archiveMinRows: 200,   // only write a batch once this many rows are waiting (avoids ~1,000 tiny files/wk)
    archiveMaxFiles: 400,  // keep the newest N batch files (0 = keep all)
  },
  watchdog: { enabled: true, loginCheckMinutes: 5, staleWakeFactor: 3, telegram: true }, // TRD-8: zombie watchdog (login-death + waker-stale Telegram paging)
  deliberation: { // TRD-9 H: configurable deliberators (weights normalize per group)
    quantPanel: [
      { type: 'turtle', weight: 1 },
      { type: 'adx', weight: 0.5 },
      { type: 'meanrev', weight: 0.5 },
      { type: 'macd', weight: 0.5 },
      { type: 'rsi2', weight: 0.5 },
    ],
    chairs: [
      { id: 'chair-1', model: null, temperature: null, weight: 1 },
    ],
    // TRD-VET-1 (2026-09-20, owner decision): a chair MAJORITY vetoes an ENTRY, and only an entry.
    // `{ enabled: false }` restores the previous behaviour exactly (a pure 50/50 blend where a unanimous
    // quant panel outvotes any dissent). See `committeeVerdict` in agent/aggregator.js for the rule and the
    // measured case for it. Exits are exempt BY CONSTRUCTION — a vetoed exit holds a position.
    chairVeto: { enabled: true },
    // TRD-12: one-by-one exit review of open positions (separate LLM call per
    // position, round-robin across wakes — token cost stays flat via maxPerWake).
    positionReview: {
      enabled: true,
      maxPerWake: 1,      // review at most N positions per cycle (round-robin)
      reviewMinutes: 5,   // dedicated lightweight loop cadence (not tied to wakes)
      minConfidence: 0.7, // chair confidence needed to actually close
      closeMirrored: false, // mirrored = user's manual Plus500 trades: advisory vote only unless true
      maxTokens: 1000,    // per-review response cap (2026-09-11; re-probed 2026-09-12: the served tiers bill THINKING tokens inside max_tokens — the old 250 cap left every review empty/'unparseable')
      // TRD-EXI-1 (#1490): the floor under a "cut before the stop" exit, in R. Measured over 25 such cuts on
      // 2026-09-30: the review is RIGHT 14 times and WRONG twice and STILL LOSES, because a correct cut saves
      // only ~0.158R (the 0.25% proximity band cuts just inside the stop) while a wrong cut forfeits the target
      // (~2.70R) that the VENUE really would have booked. Break-even needs a 94% hit rate; it achieves 87.5%,
      // i.e. -0.20R per cut. A cut saving `s` needs `2.7/(2.7+s)`: 94% at 0.158R (loses), 81% at 0.50R (wins).
      // So this refuses the cuts that bank almost nothing and lets the VENUE STOP do what it is there for.
      // 0 is an explicit OFF switch; the suppression and the saving it was based on are both recorded on the
      // `position_review` event, so the floor can be tuned from the records it produces.
      // 2026-10-08 (T2, TRD-EXI-1c Sec 3.1): 0.3 -> 0.20 - 0.3 was inert (observed savingR 0.101-0.299 across 17
      // refusals); the settings key deliberation.positionReview.minCutSavingR is the enforced value.
      minCutSavingR: 0.2,
    },
    // Degraded entries (2026-09-10): when every chair abstained ONLY because
    // of the chair token budget (not LLM errors), allow quant-only entries at
    // sizeFactor of the computed size instead of the fail-secure block.
    chairDegraded: { enabled: true, sizeFactor: 0.5 },
  },
  strategies: { enabled: ['turtle'], params: {}, symbolScope: {}, retired: [] }, // TRD-10: strategy registry (multi = shadow-only, opt-in). symbolScope: per-symbol strategy allowlist (symbol -> ids) — overrides the global enabled list for that symbol (P0-1c, 2026-09-10). retired: ids a retire removed DELIBERATELY, so the unattended scope widener cannot put them back (TRD-91, 2026-09-20) — a retire writes this list, and applyScope refuses anything naming it.
  pulse: { enabled: true, intervalHours: 4, model: null }, // TRD-11: market pulse narrative (why the market is moving); null model = llm.model
  central: { enabled: false, model: null, thinking: true }, // TRD-11: central AI for paper mode (null = llm.model; both served tiers are thinking models as of 2026-09-12)
  congress: { token: null, watchPoliticians: ['Dan Meuser', 'Tim Moore'] }, // TRD-11: QuiverQuant free-tier token + named-politician following (13F investors like Burry need SEC EDGAR — future)
  account: { enabled: true, pollSeconds: 1, currency: 'SGD' }, // TRD-11: live mirror of the demo account strip (read-only, 1s cadence). TRD-PNL-4 (#1484): `currency` is THE declaration of the unit every equity, margin and P&L figure is in — read through agent/accountCurrency.js, never restated as a literal at a call site. `instrumentCurrency` is deliberately absent: an unrecorded instrument REFUSES a conversion rather than defaulting to USD, which is the mistake that inflated 60 venue closes.
  mirror: { enabled: true, pollSeconds: 60 }, // TRD-11: Plus500 positions + alerts mirror (read-only, source of truth)
  paper: { enabled: false, initialCapital: 10000, maxPositions: 4, sizePct: 5, feePct: 0.05, slippagePct: 0.05, minOrder: 50 }, // TRD-11: simulated broker (separate from Plus500 demo)
  capture: { universeRefreshHours: 24 }, // TRD-8: search-bar capture; full category sweep only this often (0 = only on first run/misses)
  // TRD-12 Phase 2
  learning: {
    autopsyLossPct: 3,       // LLM autopsy write-up threshold (% MAE vs entry)
    parityValidated: false,  // implied goal: run-in half-risk until the parity harness validates the engine
    // TRD-80 (2026-09-20): WHICH strategies earned full size, written by the parity harness and read per
    // strategy by `risk.runInFactorFor`. The boolean above answers "did anyone accept" and was being spent
    // on every symbol; this list is the answer to "did THIS strategy accept".
    validatedStrategies: [],
    parity: { enabled: true, minTrades: 10, winRateLagPp: 20 }, // weekly live-vs-backtest check; retires lagging strategies
  },
  // C3 (2026-09-15): may a tick from a DIFFERENT venue stand in for the venue of record? Default OFF,
  // and off means the price path is not touched at all (venueAdmission returns null without a read).
  // When on, the allowlist is measured per (symbol, venue) from stored bars and DERIVED from each
  // symbol's own round-trip cost — see docs/trading-venue-admission-2026-09-15.md.
  //
  // MEASURED 2026-09-15: 3 of 61 (symbol, venue) pairs are admissible as-is — Bitcoin/okx,
  // Bitcoin/yahoo and SGX/yahoo. Bitcoin/BINANCE is refused (|diff| p90 33.48 bps against a 25.00 bps
  // round trip), so "Bitcoin admits its venues" is not the claim; two of three is. Gold and Oil admit
  // NOBODY, so for them the flag means "no substitute price", which is also the current behaviour.
  // Most symbols cannot be admitted at all: only 12 are calibrated in the cost model, and the rest have
  // no cost basis — which is a refusal, not a zero budget.
  venueComparability: { enabled: false, ttlHours: 6 },

  // TRD-75 / B5: the independent binding reviewer. `enabled` buys an LLM call per proposal; default OFF.
  // `autoTighten` is the ONLY thing that lets the desk change a binding with NO human in the loop, and
  // it can only ever NARROW — see agent/binding.js (the classifier) and agent/bindingApply.js (the four
  // guards). Default OFF, and `=== true` is a literal check so a truthy string out of a settings
  // round-trip cannot arm a writer.
  bindingProposer: { enabled: false, autoTighten: false },
  budget: {                               // granular LLM token budget
    totalDaily: 150000,
    // TRD-96: `shadow` and `binding` are both in budget.js CONSUMERS but were absent here and in the
    // live row, so neither had a sub-cap — see the capFor comment. They are present now so a fresh
    // install does not start with two uncapped consumers. These two values are sized to THIS default
    // total (~13% each, matching the existing default scale), not measured; the live row carries the
    // measured values.
    perConsumer: { chair: 30000, central: 40000, review: 15000, pulse: 10000, digest: 3000, whitepaper: 20000, ask: 10000, autopsy: 3000, strategy_tune: 15000, shadow: 20000, binding: 20000 },
    warnPct: 80,
    boostUntil: null,                     // ISO timestamp — 3x caps until then
    // ★★ TRD-LLM-1: the token PRICE. Three rates, because the meter already records the three
    // quantities that need them (`promptCacheHitTokens`, `promptCacheMissTokens`, `completionTokens` —
    // TRD-107 kept that split precisely so cost-per-call would be computable).
    //
    // ⚠ LEFT NULL ON PURPOSE. A default rate here would be an INVENTED number, and `costUsd: 0` would
    // then read as "the LLMs are free" rather than "nobody has priced them". With `pricing: null` every
    // call is written with `unpriced: true` and no cost field at all, and `budget.spend()` reports the
    // unpriced calls separately instead of folding them into a total. Set it to ENABLE the money ledger:
    //   pricing: { inputHitPerM: 0.07, inputMissPerM: 0.27, outputPerM: 1.10 }
    // Those three are an EXTERNAL list price (DeepSeek-class), given as a shape example only — the desk
    // does not own them, so it must not ship them as a default.
    pricing: null,
  },
  whitepaper: { model: 'deepseek-flash', maxTokens: 1500, blackSwanGapPct: 10 }, // tiered market white paper (weekly/monthly/yearly)
  llm: {
    model: 'deepseek-flash',   // 2026-09-12 REROUTE (replaces the 2026-09-10 'deepseek-v4-pro' pin). Live probe: /models = deepseek-flash | deepseek-v4-pro, BOTH served as requested, BOTH bill reasoning INSIDE max_tokens (cap 5 -> empty, finish_reason=length) so the caps below are unchanged. Keep in sync with agent/deepseek.js DEFAULT_MODEL (env DEEPSEEK_MODEL overrides at runtime).
    temperature: 0.1,
    maxRetries: 2,           // A11: hard retry cap per wake cycle
    timeoutMs: 30000,
    maxTokens: 2000,         // 2026-09-11: thinking-model headroom (was 500 — risk/macro chair reasoning crossed it and content returned EMPTY)
    stub: '',                // '' = real API | '1' = valid yes | 'garbage' = malformed | 'no' = valid no
  },
  watchlist: { symbols: [], candidates: [], universe: [], mode: 'dynamic', dynamicQuantCap: 24 }, // mode: dynamic (capture fills the universe; user curates symbols) | fixed (user-confirmed list)
  // AI watchlist discoverer (2026-09-10): second pillar beside the manual
  // watchlist. Default OFF — opt-in. AI-added symbols carry source:'ai'+addedAt
  // and are capped/evicted/faded; manual entries are never touched.
  discover: { enabled: false, intervalHours: 12, maxAiSymbols: 5, noSignalDays: 14 },
  // Phase 1 of the implied goal (2026-09-10): periodic self-inspection pass —
  // decision-vs-fill drift, rejections, tick/bridge/waker/budget freshness.
  // Read-only, self-throttled; Telegram alert on warn/bad transition.
  selfHealth: { enabled: true, intervalMinutes: 15, alertOnBad: true },
  // Phase 2 of the implied goal (2026-09-10): bounded self-tuning. Default OFF
  // — opt-in. Rails live in agent/tuner.js (delta bounds, registry clamps,
  // ≥1 enabled, parity gate, budget consumer strategy_tune).
  tuner: { enabled: false, intervalHours: 24, maxChangesPerRun: 3, model: null },
  providers: { enabled: ['binance', 'okx', 'yahoo'], minIntervalSec: 60 }, // TRD-5: public REST market data + 60s staleness gate; TRD-9 adds yahoo
  bridge: { paused: false, pausedAt: null, consecutiveFails: 0, captureOnWake: true }, // A1 UI fallback pause
  selectors: { version: 1, map: {} }, // A1: hot-patchable selector map (P2)
};

function mergeSettings(stored) {
  return deepMerge(DEFAULT_SETTINGS, stored);}

// Migration 024 applied? (presence of TradingSettings is the marker)
async function schemaProbe() {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT COUNT(*) AS cnt FROM sys.tables WHERE name = 'TradingSettings'`
    );
    return Number(r.recordset[0]?.cnt) > 0;
  } catch {
    return false;
  }
}

// Per-user settings (kill tiers, caps, watchlist mapping, selector map, etc.)
async function getSettings(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query('SELECT settings FROM TradingSettings WHERE userId = @userId');
  const row = r.recordset[0];
  let stored = {};
  if (row) { try { stored = JSON.parse(row.settings || '{}'); } catch { stored = {}; } }
  return mergeSettings(stored);
}

async function saveSettings(userId, settings) {
  const pool = await getPool();
  // Deep-merge the patch over the existing stored settings so partial updates
  // (e.g. {risk:{maxPositions:0}}) don't wipe the watchlist / llm blocks.
  const cur = await pool.request().input('userId', sql.Int, userId)
    .query('SELECT settings FROM TradingSettings WHERE userId = @userId');
  let existing = {};
  try { existing = JSON.parse(cur.recordset[0]?.settings || '{}'); } catch { existing = {}; }
  const merged = deepMerge(existing, settings ?? {});
  const json = JSON.stringify(merged);
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('settings', NVMAX, json)
    .query(`
      MERGE TradingSettings AS t
      USING (SELECT @userId AS userId, @settings AS settings) AS s
        ON t.userId = s.userId
      WHEN MATCHED THEN UPDATE SET settings = s.settings, updatedAt = GETUTCDATE()
      WHEN NOT MATCHED THEN INSERT (userId, settings) VALUES (s.userId, s.settings);`);
  // Best-effort, and AFTER the write so it can never block or fail one.
  // ★ TRD-RSK-8: the JOURNAL is written FIRST of the two, because it is the one record that cannot be
  // reconstructed from anything else — the dead-scope report can be recomputed from the settings, the fact
  // that a write happened cannot.
  await journalSettingsWrite(userId, existing, merged).catch(() => {});
  await reportDeadScopeWrite(userId, existing, merged).catch(() => {});
  return getSettings(userId);
}

// ★ TRD-RSK-8 (2026-09-28): THE SETTINGS JOURNAL — the one live input that had no record of itself.
//
// WHY. Measured: `risk.maxAdversePct` was changed 0.3 -> 1.5 at 2026-09-28T06:51:16.553Z and NOTHING recorded it.
// TradingEvents carries 52 distinct kinds and the only settings-ish one was `tune_skipped` — there was no
// settings-write event kind at all, so a save left no trace beyond a nullable `updatedAt`, which cannot say
// WHAT changed, when, or by whom. The cost is not hypothetical: prompt #5407 (06:50:22Z) told the chair
// "Venue stop CAP: 0.3% of price" and prompt #5408 (06:56:28Z) told it 1.5%, so one wake ran a rule the chair
// had not been told about — and the switch is not reconstructible from the log afterwards. Unlike the
// dead-scope report, which can be RECOMPUTED from the settings, the fact that a write happened cannot.
//
// WHY HERE. `saveSettings` is the ONE chokepoint every writer shares — the route, the discoverer, the tuner,
// `accountPoller` and `bindingApply`'s widener. Same argument as TRD-116, and TRD-103 is why it matters: an
// automated writer reverted a human twelve minutes later, and a route-level guard would not have seen it.
//
// ⚠ The diff/redaction/caps live in `settingsDiff.js` (pure, no DB, no logger) so the rule is testable directly.
// Secrets are NEVER copied here — see that module's header.
async function journalSettingsWrite(userId, before, after) {
  const payload = settingsDiff.settingsWriteEvent(before, after);
  if (!payload) return null;   // a no-op save is not a signal
  await logEvent(userId, 'settings_write', Object.assign({}, payload, {
    note: 'every settings write is journalled because TradingSettings has no other record: updatedAt cannot say '
      + 'what changed or by whom. Credential-looking keys record the change and never the value (TRD-RSK-8).',
  }));
  return payload;
}

// TRD-116, option (b) — "keep both but VALIDATE them" — taken 2026-09-25 because the check that was
// SUPPOSED to cover this (self-health 15) was itself reporting the wrong set, and because the row's residual
// was that the contradiction is "currently OBSERVED, not PREVENTED".
//
// ★ WHY HERE, AND WHY ONLY THE DIRECTION THAT IS A DEFECT. `saveSettings` is the ONE chokepoint every writer
// shares — the route, the discoverer, the tuner, `bindingApply`'s scope widener. TRD-103's lesson is exactly
// that an AUTOMATED writer re-added a retired pair twelve minutes after a human removed it, and a route-level
// guard would not have seen it. The opposite direction (a scope entry naming a strategy absent from `enabled`)
// is NOT a defect — an explicit entry replaces the global list, which is TRD-91's design — so a guard on it
// would refuse legitimate settings.
//
// ★ IT FIRES ON THE WRITE THAT CREATES THE DEAD SETTING, NOT ON EVERY SUBSEQUENT SAVE. The desk's own
// convention is that an event is a SIGNAL and not a stream; a state-based warning would re-log on every
// settings write forever, and `accountPoller` writes settings on each new position. So the comparison is
// BEFORE vs AFTER, and only newly-orphaned ids are reported.
async function reportDeadScopeWrite(userId, before, after) {
  const universe = scopeResolution.watchlistSymbols(after && after.watchlist);
  if (!universe.length) return null; // reachability is UNMEASURED, and an unmeasured absence is not a finding
  const introduced = scopeResolution.newlyDeadIds(before, after, universe);
  if (!introduced.length) return null;
  await logEvent(userId, 'strategy_scope_dead', {
    introduced,
    universe: universe.length,
    symbols: universe,
    note: 'a settings write left these strategies ENABLED and able to run on NO watchlist symbol, so the '
      + 'setting does nothing while every surface showing `enabled` alone reads it as live. The write was NOT '
      + 'refused — the state is reportable and adjustable, and a refusal here would fail a live save on a '
      + 'health question. Correct it by scoping the strategy to a symbol, or by removing it from `enabled`.',
  });
  return introduced;
}

function deepMerge(base, patch) {
  const out = JSON.parse(JSON.stringify(base || {}));
  if (patch && typeof patch === 'object') {
    for (const k of Object.keys(patch)) {
      if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
        out[k] = deepMerge(out[k], patch[k]);
      } else {
        out[k] = patch[k];
      }
    }
  }
  return out;
}

// Append a telemetry / note / memory / system event.
async function logEvent(userId, kind, payload) {
  // DESIGN BIBLE v1 Phase A: every event carries the shared envelope
  // (stream/level/actor/action/correlationId/causationId/redacted) INSIDE
  // the payload. Enrichment is additive + idempotent, so legacy payload
  // fields and all existing consumers are untouched.
  const { enrich } = require('./agent/log');
  const enveloped = enrich(kind, payload);
  const pool = await getPool();
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('kind', sql.NVarChar(32), kind)
    .input('payload', NVMAX, enveloped == null ? null : JSON.stringify(enveloped))
    .query('INSERT INTO TradingEvents (userId, kind, payload) VALUES (@userId, @kind, @payload)');
}

// The page cap for event reads. TRD-77: this was a bare 500 in two places, so a caller asking for
// more SILENTLY received less and could not tell a TOTAL from a FLOOR - budget.todayUsage() asked for
// 2000 and got at most 500, then reported the sum with full confidence. Exported as one number so the
// clamp and anything that wants to detect it cannot drift apart.
const EVENT_QUERY_CAP = 500;

// `since` is optional and additive. Without it the read is "the newest N events", which is the wrong
// question for a daily accumulator: budget.todayUsage() was paging the newest 500 llm_usage rows and
// filtering them down to today in JS, so its 500-row budget was shared with every previous day and the
// page could saturate while the day itself was quiet (TRD-77). With `since`, the cap applies to the
// window that is actually being summed.
// `beforeId` is a KEYSET CURSOR, added 2026-09-30 so a population larger than the page cap can be
// walked instead of silently truncated to its newest page. It is additive and defaults to null, so
// every existing caller keeps the exact behaviour it had (the newest N, full stop). Keyset rather
// than OFFSET because `id` is the IDENTITY the read already orders by, so a page cannot skip or
// repeat a row when another insert lands mid-walk.
async function listEvents(userId, { limit = 50, kind = null, since = null, beforeId = null } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId).input('limit', sql.Int, Math.min(Number(limit) || 50, EVENT_QUERY_CAP));
  let where = 'userId = @userId';
  if (kind) { where += ' AND kind = @kind'; req.input('kind', sql.NVarChar(32), kind); }
  if (since) { where += ' AND createdAt >= @since'; req.input('since', sql.DateTime2, new Date(since)); }
  if (beforeId != null) { where += ' AND id < @beforeId'; req.input('beforeId', sql.Int, Number(beforeId)); }
  const r = await req.query(`SELECT TOP (@limit) * FROM TradingEvents WHERE ${where} ORDER BY id DESC`);
  return r.recordset.map((e) => ({ ...e, payload: safeJson(e.payload) }));
}

// ★★ 2026-09-30: THE PAGE CAP IS NOT A TOTAL, and this is the read that stops pretending it is.
//
// `listEvents` returns AT MOST EVENT_QUERY_CAP rows; that is the right answer for "the newest N" and
// the wrong answer for an ACCUMULATOR. `budget.todayUsage()` summed one page and published the result
// as the day's total, so on any day whose llm_usage rows outnumber the cap the meter read a FLOOR.
// Measured before the fix: 2026-09-29 had 549 calls and the meter read 500 (71,086 tokens, 5.3% of
// the day, invisible); 2026-09-28 had 624 and read 500; 2026-09-23 had 547. Because the caps are
// PER-CONSUMER the loss is not spread evenly — on 2026-09-29 shadow's real 270,022 (90.0% of its
// cap) was reported as 243,093 (81.0%), so the gate saw 9 points of headroom that did not exist,
// and digest's only call was invisible entirely. 3 of the previous 8 days were over the cap, so this
// was not a rare edge: it was a meter that would under-report the moment the desk got busy.
//
// RETURNS AN OBJECT, NOT AN ARRAY, on purpose. A caller that wants rows can have them, but it cannot
// get them without its own `pages`/`truncated` in hand — the same reason `todayUsage` reports its own
// shape. `truncated` means the walk stopped at `maxPages` with a full page still in front of it: the
// rows returned are then a FLOOR, and the caller is told so rather than left to infer it.
async function listEventsAll(userId, { kind = null, since = null, pageSize = EVENT_QUERY_CAP, maxPages = 40 } = {}) {
  const size = Math.min(Math.max(1, Number(pageSize) || EVENT_QUERY_CAP), EVENT_QUERY_CAP);
  const cap = Math.max(1, Number(maxPages) || 1);
  const rows = [];
  let beforeId = null;
  let pages = 0;
  let truncated = false;
  for (;;) {
    const page = await listEvents(userId, { kind, since, limit: size, beforeId });
    pages += 1;
    for (const r of page) rows.push(r);
    if (page.length < size) break;
    const oldest = page[page.length - 1];
    const cursor = oldest && oldest.id != null ? oldest.id : null;
    if (cursor == null) { truncated = true; break; }
    beforeId = cursor;
    if (pages >= cap) { truncated = true; break; }
  }
  return { rows, pages, truncated, pageSize: size };
}

// News S2 (open-work 4.19, built 2026-10-03): the digest's read side. Newest first, bounded by age -
// the panel shows "as of" and the digest carries its own window, so a stale panel reads as stale.
// Read-only; nothing here writes.
async function listRecentNewsItems(userId, { sinceHours = 48, limit = 300 } = {}) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('hours', sql.Int, Math.max(1, Number(sinceHours) || 48))
    .input('limit', sql.Int, Math.min(Math.max(1, Number(limit) || 300), 1000))
    .query(`SELECT TOP (@limit) * FROM NewsItems
            WHERE userId = @userId AND createdAt >= DATEADD(hour, -@hours, GETUTCDATE())
            ORDER BY id DESC`);
  return r.recordset;
}

// TRD-PRM-1 P1 (2026-10-04): the premium-analyses ledger's WRITE side (open-work §4.24; migration 047).
// Append-only by convention — corrections are NEW rows; nothing here updates or deletes. No consumer.
async function insertAnalysesNote(userId, note) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('kind', sql.NVarChar(24), note.kind)
    .input('symbol', sql.NVarChar(64), note.symbol || null)
    .input('title', sql.NVarChar(400), note.title || null)
    .input('url', sql.NVarChar(700), note.url || null)
    .input('source', sql.NVarChar(32), note.source || 'capture')
    .input('rawText', sql.NVarChar(sql.MAX), note.rawText || null)
    .input('parseStatus', sql.NVarChar(40), note.parseStatus || 'manual')
    .input('note', sql.NVarChar(600), note.note || null)
    .query(`INSERT INTO AnalysesNotes (userId, kind, symbol, title, url, source, rawText, parseStatus, note)
            OUTPUT INSERTED.id
            VALUES (@userId, @kind, @symbol, @title, @url, @source, @rawText, @parseStatus, @note)`);
  return Number(r.recordset[0] && r.recordset[0].id) || null;
}

async function insertAnalysisLevels(userId, noteId, levels) {
  if (!Array.isArray(levels) || !levels.length) return 0;
  const pool = await getPool();
  let inserted = 0;
  for (const l of levels) {
    const price = Number(l.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    await pool.request()
      .input('noteId', sql.Int, noteId)
      .input('userId', sql.Int, userId)
      .input('symbol', sql.NVarChar(64), l.symbol || null)
      .input('price', sql.Decimal(18, 6), price)
      .input('levelKind', sql.NVarChar(24), l.levelKind || 'level')
      .input('label', sql.NVarChar(200), l.label || null)
      .input('timeframeHint', sql.NVarChar(24), l.timeframeHint || null)
      .input('snippet', sql.NVarChar(400), l.snippet || null)
      .query(`INSERT INTO AnalysisLevels (noteId, userId, symbol, price, levelKind, label, timeframeHint, snippet)
              VALUES (@noteId, @userId, @symbol, @price, @levelKind, @label, @timeframeHint, @snippet)`);
    inserted++;
  }
  return inserted;
}

// The scheduled path's throttle reads the LEDGER (capturedAt), not process memory — a restart
// cannot cause a double sweep inside the window.
async function countRecentAnalyses(userId, hours = 20) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('hours', sql.Int, Math.max(1, Number(hours) || 20))
    .query(`SELECT COUNT(*) AS cnt FROM AnalysesNotes WHERE userId = @userId AND capturedAt >= DATEADD(hour, -@hours, GETUTCDATE())`);
  return Number(r.recordset[0] && r.recordset[0].cnt) || 0;
}

// TRD-77: count llm_usage CALLS and sum their token fields IN SQL, without the meter's paginated JS
// loop and without reading the meter's code path at all. This is what makes a detector of the meter
// possible: pagination, the `Number(x) || 0` coercion and the field names are all bypassed, so a meter
// that is blind to its own input cannot hide that fact from this read.
//
// TRY_CAST matters: a redacted field holds the STRING '[REDACTED]', which casts to NULL and sums as 0.
// That is precisely the four-day failure (rows existed, tokens read zero), so the caller can compare
// `events > 0 && tokens === 0` instead of guessing whether the desk was merely idle.
async function llmUsageSince(userId, since) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('since', sql.DateTime2, new Date(since))
    .query(`SELECT COUNT(*) AS events,
                   ISNULL(SUM(ISNULL(TRY_CAST(JSON_VALUE(payload, '$.completionTokens') AS INT), 0)
                            + ISNULL(TRY_CAST(JSON_VALUE(payload, '$.promptTokens') AS INT), 0)), 0) AS tokens
              FROM TradingEvents
             WHERE userId = @userId AND kind = 'llm_usage' AND createdAt >= @since`);
  const row = r.recordset[0] || {};
  return { events: Number(row.events) || 0, tokens: Number(row.tokens) || 0 };
}

// F32 (2026-09-18): the optional `source` filter is what makes a PRODUCER's liveness readable.
//
// `telemetry` alone carries dozens of sources, so "the latest telemetry event" answers a question nobody
// asked — and the scripts card asked it, then discarded the answer when the source disagreed, which is
// why its liveness column read `—` for exactly the five processes whose liveness mattered most (the price
// capture, the positions mirror, the instrument discover, the alert watch, the congress pull). Reading in
// SQL instead of paging 200 rows and filtering in JS also means the answer cannot depend on page size.
async function latestEvent(userId, kind, { source = null } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId).input('kind', sql.NVarChar(32), kind);
  let where = 'userId = @userId AND kind = @kind';
  if (source) {
    where += " AND JSON_VALUE(payload, '$.source') = @source";
    req.input('source', sql.NVarChar(64), String(source));
  }
  const r = await req.query(`SELECT TOP (1) * FROM TradingEvents WHERE ${where} ORDER BY id DESC`);
  const row = r.recordset[0];
  return row ? { ...row, payload: safeJson(row.payload) } : null;
}

// DESIGN BIBLE v1 Phase A: filtered, cursor-paginated log query.
// Filters on the ENVELOPE fields (JSON_VALUE over payload). Cursor = last
// returned event id (stable under concurrent writes; no offset).
async function queryEvents(userId, { stream = null, level = null, actor = null, action = null, correlationId = null, since = null, until = null, limit = 100, cursor = null } = {}) {
  const pool = await getPool();
  const lim = Math.min(Math.max(1, Number(limit) || 100), EVENT_QUERY_CAP);
  const where = ['userId = @userId'];
  const binds = [];
  if (cursor) { where.push('id < @cursor'); binds.push(['cursor', sql.Int, Math.max(1, Number(cursor))]); }
  if (since) { where.push('createdAt >= @since'); binds.push(['since', sql.DateTime2, new Date(since)]); }
  if (until) { where.push('createdAt <= @until'); binds.push(['until', sql.DateTime2, new Date(until)]); }
  const jsonFilters = [
    ['stream', stream], ['level', level], ['action', action], ['correlationId', correlationId],
  ];
  for (const [f, v] of jsonFilters) {
    if (v) { where.push(`JSON_VALUE(payload, '$.${f}') = @${f}`); binds.push([f, sql.NVarChar(64), String(v)]); }
  }
  if (actor) { where.push(`JSON_VALUE(payload, '$.actor') LIKE @actor`); binds.push(['actor', sql.NVarChar(128), `%${String(actor)}%`]); }
  const whereSql = where.join(' AND ');
  const makeReq = (withLimit) => {
    const req = pool.request().input('userId', sql.Int, userId);
    if (withLimit) req.input('limit', sql.Int, lim);
    for (const [n, t, v] of binds) req.input(n, t, v);
    return req;
  };
  const [countR, rowsR] = await Promise.all([
    makeReq(false).query(`SELECT COUNT(*) AS n FROM TradingEvents WHERE ${whereSql}`),
    makeReq(true).query(`SELECT TOP (@limit) * FROM TradingEvents WHERE ${whereSql} ORDER BY id DESC`),
  ]);
  const items = rowsR.recordset.map((e) => ({ id: e.id, ts: e.createdAt, kind: e.kind, ...(safeJson(e.payload) || {}) }));
  const total = Number(countR.recordset[0].n);
  return {
    items, total, hasMore: items.length === lim && items.length < total,
    nextCursor: items.length ? items[items.length - 1].id : null,
  };
}

// --- paper ledger (TRD-11, migration 025) -------------------------------------
const PAPER_FIELDS = ['closePrice', 'closeAt', 'pnl', 'fees', 'status', 'reason', 'reasoning', 'takeProfitPrice'];

async function listPaperTrades(userId, { status = null, limit = 100 } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId).input('limit', sql.Int, Math.min(Number(limit) || 100, 2000));
  let where = 'userId = @userId';
  if (status) { where += ' AND status = @status'; req.input('status', sql.NVarChar(16), status); }
  const r = await req.query(`SELECT TOP (@limit) * FROM PaperTrades WHERE ${where} ORDER BY id DESC`);
  return r.recordset;
}

async function createPaperTrade(userId, { symbol, venue, direction, size, openPrice, reason, decisionId, reasoning, takeProfitPrice, strategyId = null }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('symbol', sql.NVarChar(64), symbol)
    .input('venue', sql.NVarChar(32), venue || 'yahoo')
    .input('direction', sql.NVarChar(8), direction)
    .input('size', sql.Decimal(18, 6), size)
    .input('openPrice', sql.Decimal(18, 6), openPrice)
    .input('reason', sql.NVarChar(255), reason ?? null)
    .input('decisionId', sql.Int, decisionId ?? null)
    .input('reasoning', NVMAX, reasoning ?? null)
    .input('takeProfitPrice', sql.Decimal(18, 6), takeProfitPrice ?? null)
    // TRD-89 (2026-09-18): the PaperTrades table has always had a strategyId column and the writer never
    // filled it, so every sim position was untaggable. That made the sim desk unable to answer "which
    // strategy did this?" — the same blind spot as the untagged live closes in the 'unknown' bucket — and
    // it meant a sim position could never inherit its strategy's review authority.
    .input('strategyId', sql.NVarChar(32), strategyId)
    .query(`INSERT INTO PaperTrades (userId, symbol, venue, direction, size, openPrice, reason, decisionId, reasoning, takeProfitPrice, strategyId)
            OUTPUT INSERTED.id, INSERTED.symbol, INSERTED.venue, INSERTED.direction, INSERTED.size, INSERTED.openPrice, INSERTED.openAt, INSERTED.status, INSERTED.strategyId
            VALUES (@userId, @symbol, @venue, @direction, @size, @openPrice, @reason, @decisionId, @reasoning, @takeProfitPrice, @strategyId)`);
  return r.recordset[0];
}

async function updatePaperTrade(userId, id, fields) {
  const sets = [];
  return (async () => {
    const pool = await getPool();
    const request = pool.request().input('id', sql.Int, id).input('userId', sql.Int, userId);
    for (const k of PAPER_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(fields, k) || fields[k] === undefined) continue;
      sets.push(`${k} = @${k}`);
      if (k === 'pnl' || k === 'fees' || k === 'closePrice') request.input(k, sql.Decimal(18, 6), fields[k]);
      else if (k === 'closeAt') request.input(k, sql.DateTime2, fields[k]);
      else request.input(k, k === 'reasoning' ? NVMAX : sql.NVarChar(k === 'reason' ? 255 : 16), fields[k]);
    }
    if (!sets.length) return null;
    sets.push('updatedAt = GETUTCDATE()');
    const r = await request.query(`UPDATE PaperTrades SET ${sets.join(', ')}
      OUTPUT INSERTED.id, INSERTED.symbol, INSERTED.direction, INSERTED.closePrice, INSERTED.closeAt, INSERTED.pnl, INSERTED.fees, INSERTED.status
      WHERE id = @id AND userId = @userId`);
    return r.recordset[0] || null;
  })();
}

async function clearPaperTrades(userId) {
  const pool = await getPool();
  await pool.request().input('userId', sql.Int, userId).query('DELETE FROM PaperTrades WHERE userId = @userId');
}


function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// --- prompts ------------------------------------------------------------------
async function createPrompt(userId, { triggerType, bundle, response, decision, model, usage, latencyMs }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('triggerType', sql.NVarChar(32), triggerType)
    .input('bundle', NVMAX, bundle == null ? null : (typeof bundle === 'string' ? bundle : JSON.stringify(bundle)))
    .input('response', NVMAX, response ?? null)
    .input('decision', NVMAX, decision == null ? null : (typeof decision === 'string' ? decision : JSON.stringify(decision)))
    .input('model', sql.NVarChar(64), model ?? null)
    .input('usage', NVMAX, usage == null ? null : (typeof usage === 'string' ? usage : JSON.stringify(usage)))
    .input('latencyMs', sql.Int, latencyMs ?? null)
    .query(`INSERT INTO TradingPrompts (userId, triggerType, bundle, response, decision, model, usage, latencyMs)
            OUTPUT INSERTED.id
            VALUES (@userId, @triggerType, @bundle, @response, @decision, @model, @usage, @latencyMs)`);
  return r.recordset[0].id;
}

async function listPrompts(userId, { limit = 50 } = {}) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 50, 500))
    .query(`SELECT TOP (@limit) * FROM TradingPrompts WHERE userId = @userId ORDER BY id DESC`);
  return r.recordset.map((p) => ({
    ...p,
    bundle: safeJson(p.bundle), decision: safeJson(p.decision), usage: safeJson(p.usage),
  }));
}

// Merge a patch into a prompt row's decision JSON (e.g. execution outcomes
// land AFTER deliberation, so the wakes UI can show why a fill didn't land).
async function patchPromptDecision(userId, promptId, patch) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('promptId', sql.Int, promptId)
    .query('SELECT decision FROM TradingPrompts WHERE id = @promptId AND userId = @userId');
  const row = r.recordset[0];
  if (!row) return false;
  const cur = (safeJson(row.decision) && typeof safeJson(row.decision) === 'object') ? safeJson(row.decision) : {};
  const merged = { ...cur, ...patch };
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('promptId', sql.Int, promptId)
    .input('decision', NVMAX, JSON.stringify(merged))
    .query('UPDATE TradingPrompts SET decision = @decision WHERE id = @promptId AND userId = @userId');
  return true;
}

async function logPromptError(userId, { promptId = null, raw = null, error = null }) {
  const pool = await getPool();
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('promptId', sql.Int, promptId)
    .input('raw', NVMAX, raw == null ? null : String(raw).slice(0, 8000))
    .input('error', sql.NVarChar(255), error == null ? null : String(error).slice(0, 255))
    .query('INSERT INTO PromptErrors (userId, promptId, raw, error) VALUES (@userId, @promptId, @raw, @error)');
}

// --- alerts -------------------------------------------------------------------
async function listAlerts(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query('SELECT * FROM TradingAlerts WHERE userId = @userId ORDER BY id DESC');
  return r.recordset;
}

async function createAlert(userId, data) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('symbol', sql.NVarChar(64), data.symbol)
    .input('venue', sql.NVarChar(32), data.venue || 'plus500')
    .input('direction', sql.NVarChar(16), data.direction)
    .input('threshold', sql.Decimal(18, 6), Number(data.threshold))
    .input('enabled', sql.Bit, data.enabled === false ? 0 : 1)
    .input('cooldownMinutes', sql.Int, Number(data.cooldownMinutes) || 60)
    .input('note', sql.NVarChar(255), data.note ?? null)
    .input('metric', sql.NVarChar(16), data.metric || 'price')
    .query(`INSERT INTO TradingAlerts (userId, symbol, venue, direction, threshold, enabled, cooldownMinutes, note, metric)
            OUTPUT INSERTED.id
            VALUES (@userId, @symbol, @venue, @direction, @threshold, @enabled, @cooldownMinutes, @note, @metric)`);
  return r.recordset[0].id;
}

async function updateAlert(userId, id, data) {
  const cur = (await listAlerts(userId)).find((a) => a.id === Number(id));
  if (!cur) return false;
  const merged = { ...cur, ...data };
  const pool = await getPool();
  await pool.request()
    .input('userId', sql.Int, userId).input('id', sql.Int, id)
    .input('symbol', sql.NVarChar(64), merged.symbol)
    .input('venue', sql.NVarChar(32), merged.venue)
    .input('direction', sql.NVarChar(16), merged.direction)
    .input('threshold', sql.Decimal(18, 6), Number(merged.threshold))
    .input('enabled', sql.Bit, merged.enabled ? 1 : 0)
    .input('cooldownMinutes', sql.Int, Number(merged.cooldownMinutes) || 60)
    .input('note', sql.NVarChar(255), merged.note ?? null)
    .input('metric', sql.NVarChar(16), merged.metric || 'price')
    .query(`UPDATE TradingAlerts SET symbol=@symbol, venue=@venue, direction=@direction, threshold=@threshold,
              enabled=@enabled, cooldownMinutes=@cooldownMinutes, note=@note, metric=@metric, updatedAt=GETUTCDATE()
            WHERE id=@id AND userId=@userId`);
  return true;
}

async function deleteAlert(userId, id) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .query('DELETE FROM TradingAlerts WHERE id=@id AND userId=@userId');
  return r.rowsAffected[0] > 0;
}

async function markAlertTriggered(userId, id) {
  const pool = await getPool();
  await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .query('UPDATE TradingAlerts SET lastTriggeredAt = GETUTCDATE() WHERE id=@id AND userId=@userId');
}

// --- price ticks + bars live in store/ticks.js and store/bars.js (TRD-12
// Phase 1 repository split; validated ingest + flagged bars). Re-exported
// below so existing callers keep working unchanged.

// --- trades (read-only in P1; executor writes in P3) ---------------------------
async function getOpenTrades(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`SELECT * FROM Trades WHERE userId = @userId AND status = 'open' ORDER BY id DESC`);
  return r.recordset;
}

async function getClosedTrades(userId, limit = 3) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 3, 20))
    .query(`SELECT TOP (@limit) * FROM Trades WHERE userId = @userId AND status IN ('closed','cancelled','rejected')
            ORDER BY COALESCE(closeAt, updatedAt) DESC`);
  return r.recordset;
}

async function countNewTradesToday(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`SELECT COUNT(*) AS cnt FROM Trades
            WHERE userId = @userId AND status IN ('open','closed')
              AND (origin IS NULL OR origin = 'agent')
              AND openAt >= CAST(GETUTCDATE() AS DATE)`);
  return Number(r.recordset[0]?.cnt) || 0;
}

// --- trade writes (executor, P3) ----------------------------------------------
async function createTrade(userId, fields) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), fields.venue || 'plus500')
    .input('symbol', sql.NVarChar(64), fields.symbol)
    .input('direction', sql.NVarChar(8), fields.direction)
    .input('size', sql.Decimal(18, 6), fields.size)
    .input('units', sql.NVarChar(32), fields.units ?? null)
    .input('openPrice', sql.Decimal(18, 6), fields.openPrice ?? null)
    .input('openAt', sql.DateTime2, fields.openAt ?? new Date())
    .input('status', sql.NVarChar(16), fields.status || 'open')
    .input('plus500PositionId', sql.NVarChar(64), fields.plus500PositionId ?? null)
    .input('decisionId', sql.Int, fields.decisionId ?? null)
    .input('note', sql.NVarChar(255), fields.note ?? null)
    .input('currentRate', sql.Decimal(18, 6), fields.currentRate ?? null)
    .input('floatingPnl', sql.Decimal(18, 6), fields.floatingPnl ?? null)
    .input('origin', sql.NVarChar(20), fields.origin ?? null)
    .input('stopPrice', sql.Decimal(18, 6), fields.stopPrice ?? null)
    .input('takeProfitPrice', sql.Decimal(18, 6), fields.takeProfitPrice ?? null)
    .input('filledAt', sql.DateTime2, fields.filledAt ?? null)
    .input('rejectReason', sql.NVarChar(120), fields.rejectReason ?? null)
    .input('fillDelayMs', sql.Int, fields.fillDelayMs ?? null)
    .input('strategyId', sql.NVarChar(32), fields.strategyId ?? null)
    .input('slippagePct', sql.Decimal(18, 6), fields.slippagePct ?? null)
    .input('pairId', sql.NVarChar(64), fields.pairId ?? null)
    .input('closeSource', sql.NVarChar(32), fields.closeSource ?? null)
    // 2026-10-05: spread + latency telemetry (trading/sql/2026-10-05-spread-latency-telemetry.sql). Additive and
    // NULLable — sign/unit conventions live in that file's extended property. No backfill; absent = unknown.
    .input('spreadSignalPct', sql.Decimal(18, 6), fields.spreadSignalPct ?? null)
    .input('signalTickAgeSec', sql.Int, fields.signalTickAgeSec ?? null)
    .input('spreadSubmitPct', sql.Decimal(18, 6), fields.spreadSubmitPct ?? null)
    .input('spreadSubmitSource', sql.NVarChar(32), fields.spreadSubmitSource ?? null)
    .input('signalToFillSec', sql.Int, fields.signalToFillSec ?? null)
    .input('anchorAgeSec', sql.Decimal(18, 3), fields.anchorAgeSec ?? null)
    // 2026-10-18 (migration 050): 'weekend' | 'weekday' derived from the ENTRY time unless the caller states
    // it. Nullable column, but this writer never leaves it NULL for a new row.
    .input('sessionClass', sql.NVarChar(24), fields.sessionClass ?? sessionClassOf(fields.openAt ?? new Date()))
    .query(`INSERT INTO Trades (userId, venue, symbol, direction, size, units, openPrice, openAt, status, plus500PositionId, decisionId, note, currentRate, floatingPnl, origin, stopPrice, takeProfitPrice, filledAt, rejectReason, fillDelayMs, strategyId, slippagePct, pairId, closeSource, spreadSignalPct, signalTickAgeSec, spreadSubmitPct, spreadSubmitSource, signalToFillSec, anchorAgeSec, sessionClass)
            OUTPUT INSERTED.id
            VALUES (@userId, @venue, @symbol, @direction, @size, @units, @openPrice, @openAt, @status, @plus500PositionId, @decisionId, @note, @currentRate, @floatingPnl, @origin, @stopPrice, @takeProfitPrice, @filledAt, @rejectReason, @fillDelayMs, @strategyId, @slippagePct, @pairId, @closeSource, @spreadSignalPct, @signalTickAgeSec, @spreadSubmitPct, @spreadSubmitSource, @signalToFillSec, @anchorAgeSec, @sessionClass)`);
  return Number(r.recordset[0]?.id);
}

async function updateTrade(userId, id, fields) {
  // Phase 3 (036): the realised-funding quartet. Written at CLOSE time, so they are updatable-only —
  // there is nothing to record about carry at the moment a position is opened. `fundingSource` must be
  // written alongside `fundingCost` every time: a cost with no provenance is exactly the ambiguous
  // number the column was added to eliminate.
  //
  // TRD-108 (2026-09-21): the close-fill pair joins under the SAME discipline. `closePrice` means two
  // different facts depending on who closed the trade — the fill (executor) or the venue's stated RATE, i.e.
  // the level it closed at (venue) — so `closePriceSource` must be written whenever `closePrice` is, and
  // `closeFillPrice` carries the actual fill (NULL when underivable).
  const updatable = ['direction', 'size', 'units', 'openPrice', 'openAt', 'closePrice', 'closeAt', 'closeAtSource', 'grossPnl', 'fees', 'status', 'plus500PositionId', 'note', 'currentRate', 'floatingPnl', 'origin', 'stopPrice', 'takeProfitPrice', 'filledAt', 'rejectReason', 'fillDelayMs', 'strategyId', 'mfePct', 'maePct', 'holdingMinutes', 'slippagePct', 'pairId', 'fundingCost', 'fundingSource', 'fundingRatePct', 'swapNights', 'closeFillPrice', 'closePriceSource', 'mfeSource', 'maeSource', 'netPnlTerminal', 'closeSource'];
  const sets = [];
  const req = new sql.Request();
  req.input('userId', sql.Int, userId).input('id', sql.Int, id);
  for (const k of updatable) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
    sets.push(`${k} = @${k}`);
    req.input(k, fields[k]);
  }
  // ★★ TRD-PNL-1 (2026-09-27): THE NET P/L PATH, TRACKED WHERE EVERY WRITER MUST PASS THROUGH.
  //
  // `Trades.floatingPnl` IS the venue's NetPL — dynamic spread and overnight funding are already inside it
  // (executor.js says so at the write site). It was read every ~2.4s and **overwritten**, so every earlier
  // sample of a trade's path was discarded. The owner asked for a min/max range and was right that it is
  // cheap: the value is already in hand at this exact point.
  //
  // WHAT WAS WRONG WITH THE EXISTING RANGE. `mfePct`/`maePct` DO record a min and a max, but they are
  // percentages of the ENTRY PRICE, they are GROSS (no fees, funding or swap), and they sit on a SAMPLED
  // tick path. So no currency P/L range existed anywhere — and `maePct` is CIRCULAR on a loss-exit row,
  // because the close is appended to the path and then dominates the minimum (measured: 23 of 39 rows
  // carrying `maePct` had it exactly equal to the close excursion to 4dp).
  //
  // ⚠ WHY THE TRACKING LIVES HERE rather than at each write site: there are FIVE places that write
  // `floatingPnl` (executor.js reconcile + two mirror paths, accountPoller, and the mirror upgrade), and a
  // fix applied at five sites is a fix that will be applied at four. Every one of them goes through this
  // function, so this is the only placement that cannot be forgotten.
  //
  // ⚠ AND WHY min/max ARE DERIVED, NOT SETTABLE. They are deliberately NOT in `updatable`: a caller that
  // could pass `netPnlMax` could also LOWER it, and a maximum that can go down is not a maximum. The SQL
  // below can only ever widen them. That is also why the comparison happens in SQL rather than in JS —
  // read-modify-write across two writers would race, and the desk samples this every ~2.4s.
  //
  // `netPnlSamples` counts the observations, so a range over ONE sample is distinguishable from a range
  // over five hundred. Without it, "min == max" reads identically whether the trade never moved or was
  // merely never sampled — and a range whose coverage is unknown is the defect class this desk keeps fixing.
  if (Object.prototype.hasOwnProperty.call(fields, 'floatingPnl') && fields.floatingPnl != null) {
    sets.push('netPnlMin = CASE WHEN netPnlMin IS NULL OR @floatingPnl < netPnlMin THEN @floatingPnl ELSE netPnlMin END');
    sets.push('netPnlMax = CASE WHEN netPnlMax IS NULL OR @floatingPnl > netPnlMax THEN @floatingPnl ELSE netPnlMax END');
    sets.push('netPnlSamples = ISNULL(netPnlSamples, 0) + 1');
  }
  // ★ `netPnlTerminal` FREEZES ON THE FIRST CLOSE AND IS NEVER REWRITTEN. It reads the OLD `floatingPnl`
  // (the last sample before the close) rather than any new value in the same statement, which is the value
  // that was actually in force when the position ended. `ISNULL(netPnlTerminal, ...)` is what makes it
  // idempotent: a re-reconcile of an already-closed row cannot move a terminal value, because a terminal
  // value that can change is a current value with a misleading name.
  if (fields.status === 'closed') {
    sets.push('netPnlTerminal = ISNULL(netPnlTerminal, floatingPnl)');
  }
  if (!sets.length) return false;
  sets.push(`updatedAt = GETUTCDATE()`);
  const r = await req.query(`UPDATE Trades SET ${sets.join(', ')} WHERE id = @id AND userId = @userId; SELECT @@ROWCOUNT AS cnt`);
  return Number(r.recordset?.[r.recordset.length - 1]?.cnt) > 0;
}

async function getTradeById(userId, id) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .query(`SELECT * FROM Trades WHERE id = @id AND userId = @userId`);
  return r.recordset[0] || null;
}

// P1-10 (2026-09-10): per-strategy live track record for evidence-weighted
// chair bundles — closed rows with a strategy tag, grouped by strategyId.
async function listStrategyStats(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(`
    SELECT strategyId, COUNT(*) AS n,
           SUM(CASE WHEN grossPnl > 0 THEN 1 ELSE 0 END) AS wins,
           ROUND(SUM(ISNULL(grossPnl, 0)), 2) AS pnl,
           ROUND(SUM(CASE WHEN grossPnl > 0 THEN grossPnl ELSE 0 END), 2) AS grossWin,
           ROUND(SUM(CASE WHEN grossPnl < 0 THEN -grossPnl ELSE 0 END), 2) AS grossLoss
    FROM Trades
    WHERE userId = @userId AND status = 'closed' AND strategyId IS NOT NULL
    GROUP BY strategyId`);
  return r.recordset.map((x) => ({
    strategyId: x.strategyId,
    n: Number(x.n),
    wins: Number(x.wins),
    pnl: Number(x.pnl),
    grossWin: Number(x.grossWin),
    grossLoss: Number(x.grossLoss),
    winRate: Number(x.n) > 0 ? Math.round((Number(x.wins) / Number(x.n)) * 100) : 0,
  }));
}

// plus500PositionIds already recorded as phantom (reconciliation dedupe).
async function getPhantomPositionIds(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`SELECT plus500PositionId FROM Trades
            WHERE userId = @userId AND status = 'phantom' AND plus500PositionId IS NOT NULL`);
  return new Set(r.recordset.map((x) => String(x.plus500PositionId)).filter(Boolean));
}

// ★★ TRD-EXE-3 residual (2026-09-30) — THE TRADES THAT CAN BE MATCHED TO A VENUE POSITION BY ITS EXACT ID.
//
// The reconciliation this serves is the post-submit READ-BACK that row #1463 named as its residual: the
// venue's size is the only statement of what is actually held, and until this existed `Trades.size` was the
// desk's own computed number, written once at submit and never checked again. `unconfirmed.matchVenuePosition`
// could not serve it — that path matches on SIZE within 2%, which is exactly what fails when the venue snaps
// the size to its increment (measured: 11.9862 submitted, 15 held, +25.1%). The venue's own id needs no
// tolerance, so this returns the rows that carry one.
//
// ⚠ `status = 'open'` is not a convenience filter. `position_pnl` can only see OPEN positions, so a closed
// trade cannot be corrected from it; a row that closes between two polls keeps whatever size it held when it
// was last observed, and that limit is stated rather than papered over.
async function listOpenTradesWithPositionIds(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`SELECT id, symbol, direction, size, units, plus500PositionId, strategyId
              FROM Trades
             WHERE userId = @userId AND status = 'open' AND plus500PositionId IS NOT NULL`);
  return r.recordset;
}

// Events of a given kind within the last N minutes (circuit breaker, P3).
async function countEventsSince(userId, kind, sinceMinutes = 30) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('kind', sql.NVarChar(32), kind)
    .input('since', sql.Int, Math.max(1, Number(sinceMinutes) || 30))
    .query(`SELECT COUNT(*) AS cnt FROM TradingEvents
            WHERE userId = @userId AND kind = @kind AND createdAt >= DATEADD(MINUTE, -@since, GETUTCDATE())`);
  return Number(r.recordset[0]?.cnt) || 0;
}

// ★★ TRD-OPS-3 (2026-10-02) — REJECTIONS MEASURED BY BREADTH, NOT BY VOLUME.
//
// `maybeTripBreaker` counted RAW `order_rejected` events in a rolling 30 min with no de-duplication, so ONE
// broken instrument produced five rejections and soft-killed the WHOLE DESK. Measured 2026-10-01: Natural Gas
// failed five order attempts in 30 min — three `order ticket did not open` (26.6-27.2 s each) and two
// `#trade-button` timeouts — and the desk stopped for 62 minutes. A single unreachable symbol, presented to
// the breaker as a systemic fault.
//
// ⚠ WHY BREADTH IS THE RIGHT SHAPE. The breaker exists for the failures no per-instrument guard can see: the
// venue logged us out, the bridge died, the session feed went blind. Those break MANY symbols at once. A
// broken instrument breaks ONE symbol repeatedly — and the desk already has the correct response to that
// (scope the symbol out), so tripping the desk is the wrong instrument at the wrong scale.
//
// ⚠ A REJECTION WITH NO `symbol` IS ITS OWN BUCKET. `COALESCE(..., '<unattributed>')` groups every
// unattributable failure together, so they can still contribute to the count but can never masquerade as five
// different instruments. `raw` is returned BESIDE `symbols` so a caller can say WHICH number tripped it — a
// breaker that cannot explain itself is the defect class this workstream keeps re-finding.
async function countRejectedSymbolsSince(userId, sinceMinutes = 30) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('since', sql.Int, Math.max(1, Number(sinceMinutes) || 30))
    .query(`SELECT COUNT(*) AS raw,
                   COUNT(DISTINCT COALESCE(JSON_VALUE(payload, '$.symbol'), '<unattributed>')) AS symbols
              FROM TradingEvents
             WHERE userId = @userId AND kind = 'order_rejected'
               AND createdAt >= DATEADD(MINUTE, -@since, GETUTCDATE())`);
  const row = r.recordset[0] || {};
  return { raw: Number(row.raw) || 0, symbols: Number(row.symbols) || 0 };
}

// Trades whose close was never accounted for: flagged phantom (venue position
// vanished) or closed with NO captured P&L (the venue closed it and we lost the
// fill). These are what the venue-close sync heals (agent/venueClose.js).
async function getUnresolvedTrades(userId, limit = 200) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 200, 500))
    .query(`SELECT TOP (@limit) * FROM Trades
            WHERE userId = @userId
              AND (status = 'phantom' OR (status = 'closed' AND grossPnl IS NULL))
            ORDER BY id DESC`);
  return r.recordset;
}

// TRD-52: submits whose outcome the venue never confirmed. Deliberately NOT folded into
// getUnresolvedTrades — that list is fed to the venue-CLOSE sync, and an unconfirmed OPEN has no close
// to reconcile; mixing them would ask the close path to heal a position that never existed. These rows
// are resolved by reconcile (matched to a venue position, or expired), never by the close sync.
async function getUnconfirmedTrades(userId, limit = 50) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 50, 200))
    .query(`SELECT TOP (@limit) * FROM Trades
            WHERE userId = @userId AND status = 'unconfirmed'
            ORDER BY id ASC`);
  return r.recordset;
}

// --- trades ledger (P4) -------------------------------------------------------
//
// ★ `status` IS A REAL FILTER, AND UNKNOWN OPTIONS ARE REJECTED (2026-09-23).
//
// This function took `{ limit }` and IGNORED everything else it was handed. So
// `listTrades(userId, { status: 'open' })` — the natural way to ask "is the book flat?" before touching a
// running service — returned the most recent rows REGARDLESS of status, and listed closed and rejected trades
// as live positions. It did exactly that on this desk: a pre-restart check reported **20 open trades** against
// a book with **no open rows at all** (status breakdown: closed 66, rejected 12). One more edge and it would
// have hidden a real position past the row limit instead of inventing ones.
//
// A parameter that is accepted and discarded is worse than one that does not exist, because it reads like
// control. This is the THIRD instance of that class here — the others being `/analytics/strategies?days=N`
// reaching a `drift()` that hardcoded 30 days, and an omitted `minBars` in `resolveStructureVenue` silently
// selecting the fallback. So the fix is not only to implement `status`; it is to REJECT unknown keys, which is
// what stops the class recurring silently.
const LIST_TRADES_OPTS = ['limit', 'status'];

async function listTrades(userId, opts = {}) {
  const o = opts || {};
  const unknown = Object.keys(o).filter((k) => !LIST_TRADES_OPTS.includes(k));
  if (unknown.length) {
    throw new RangeError(
      `listTrades: unknown option(s) ${unknown.join(', ')} — this function will not silently ignore a filter it `
      + `was given (accepted: ${LIST_TRADES_OPTS.join(', ')})`);
  }
  const { limit = 100, status = null } = o;
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 100, 500));
  let where = 'userId = @userId';
  if (status) {
    // ★ WIDER THAN THE COLUMN ON PURPOSE. A filter value longer than the parameter's declared length makes
    // tedious reject the whole RPC ("invalid data length or metadata length") rather than returning no rows —
    // so a too-narrow declaration turns a harmless query into a hard error.
    req.input('status', sql.NVarChar(64), String(status));
    where += ' AND status = @status';
  }
  const r = await req.query(`SELECT TOP (@limit) * FROM Trades WHERE ${where} ORDER BY id DESC`);
  return r.recordset;
}

// --- tick retention + price bars: store/bars.js (TRD-12 Phase 1) --------------

// --- backtest runs (TRD-6) ----------------------------------------------------
async function createBacktestRun(userId, { strategy, symbols, periodStart, periodEnd, config, metrics, worksheetSpot, worksheetCfd, provenance }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('strategy', sql.NVarChar(64), strategy)
    .input('symbols', NVMAX, symbols ?? null)
    .input('periodStart', sql.DateTime2, periodStart ?? null)
    .input('periodEnd', sql.DateTime2, periodEnd ?? null)
    .input('config', NVMAX, config ?? null)
    .input('metrics', NVMAX, metrics ?? null)
    .input('worksheetSpot', NVMAX, worksheetSpot ?? null)
    .input('worksheetCfd', NVMAX, worksheetCfd ?? null)
    .input('provenance', NVMAX, provenance ?? null)
    .query(`INSERT INTO BacktestRuns (userId, strategy, symbols, periodStart, periodEnd, config, metrics, worksheetSpot, worksheetCfd, provenance)
            OUTPUT INSERTED.id
            VALUES (@userId, @strategy, @symbols, @periodStart, @periodEnd, @config, @metrics, @worksheetSpot, @worksheetCfd, @provenance)`);
  return Number(r.recordset[0]?.id);
}

async function listBacktestRuns(userId, { limit = 20 } = {}) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 20, 100))
    .query(`SELECT TOP (@limit) id, strategy, symbols, periodStart, periodEnd, config, metrics, provenance, createdAt
            FROM BacktestRuns WHERE userId = @userId ORDER BY id DESC`);
  return r.recordset.map((x) => ({
    ...x,
    symbols: safeJson(x.symbols), metrics: safeJson(x.metrics), provenance: safeJson(x.provenance), config: safeJson(x.config),
  }));
}

// --- equity snapshots (TRD-12 Phase 2) ----------------------------------------
async function snapshotEquity(userId, { mode, equity, pnl = null, source = 'wake' }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('mode', sql.NVarChar(8), mode)
    .input('equity', sql.Decimal(18, 6), equity)
    .input('pnl', sql.Decimal(18, 6), pnl ?? null)
    .input('source', sql.NVarChar(32), source)
    .query(`INSERT INTO EquitySnapshots (userId, mode, equity, pnl, source) OUTPUT INSERTED.id
            VALUES (@userId, @mode, @equity, @pnl, @source)`);
  return Number(r.recordset[0]?.id);
}

async function listEquity(userId, { mode = 'demo', limit = 500, since = null } = {}) {
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('mode', sql.NVarChar(8), mode)
    .input('limit', sql.Int, Math.min(Number(limit) || 500, 5000));
  let where = 'userId = @userId AND mode = @mode';
  if (since) { where += ' AND capturedAt >= @since'; req.input('since', sql.DateTime2, new Date(since)); }
  const r = await req.query(`SELECT TOP (@limit) * FROM EquitySnapshots WHERE ${where} ORDER BY capturedAt DESC`);
  return r.recordset.reverse();
}

// 2026-09-11: live equity strip history — the account poller persists kind
// 'account' rows (>=30s when the numbers change). Feeds the fine-grained
// equity chart; same source as the account indicators, so the curve and the
// ticker chip can never disagree.
async function listAccountEquity(userId, { hours = 48, limit = 4000 } = {}) {
  const pool = await getPool();
  const hrs = Math.min(Math.max(1, Number(hours) || 48), 24 * 30);
  const lim = Math.min(Math.max(10, Number(limit) || 4000), 20000);
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('hours', sql.Int, hrs)
    .input('limit', sql.Int, lim)
    .query(`SELECT TOP (@limit) createdAt, CAST(JSON_VALUE(payload, '$.equity') AS DECIMAL(18,6)) AS equity,
                   CAST(JSON_VALUE(payload, '$.pnl') AS DECIMAL(18,6)) AS pnl
            FROM TradingEvents
            WHERE userId = @userId AND kind = 'account'
              AND JSON_VALUE(payload, '$.equity') IS NOT NULL
              AND createdAt >= DATEADD(HOUR, -@hours, GETUTCDATE())
            ORDER BY createdAt DESC`);
  return r.recordset.reverse();
}

// 2026-09-11: fine equity ticks — the equity curve's PERSISTENCE layer. The
// account poller banks one every <=5s so the fine curve survives page reloads
// and desk restarts (before this the sub-30s detail existed only in the tab).
async function addEquityTick(userId, { equity, pnl = null }) {
  const pool = await getPool();
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('equity', sql.Decimal(18, 6), equity)
    .input('pnl', sql.Decimal(18, 6), pnl)
    .query('INSERT INTO EquityTicks (userId, equity, pnl) VALUES (@userId, @equity, @pnl)');
}

async function listEquityTicks(userId, { hours = 48, limit = 40000 } = {}) {
  const pool = await getPool();
  const hrs = Math.min(Math.max(1, Number(hours) || 48), 24 * 30);
  const lim = Math.min(Math.max(10, Number(limit) || 40000), 200000);
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('hours', sql.Int, hrs)
    .input('limit', sql.Int, lim)
    .query(`SELECT TOP (@limit) at, equity, pnl FROM EquityTicks
            WHERE userId = @userId AND at >= DATEADD(HOUR, -@hours, GETUTCDATE())
            ORDER BY at DESC`);
  return r.recordset.reverse();
}

async function pruneEquityTicks(days = 30) {
  const pool = await getPool();
  const d = Math.max(1, Math.min(Number(days) || 30, 365));
  await pool.request().input('days', sql.Int, d)
    .query('DELETE FROM EquityTicks WHERE at < DATEADD(DAY, -@days, GETUTCDATE())');
}

// TRD-SHW-1 (2026-09-14): ShadowSignals — the shadow-call ledger.
// Nothing here is read by any trading path. `addShadowSignal` is the recorder;
// the read/write pair below is what the forward scorer (SHW-2) uses. A row is
// written ONCE, at call time, and its outcome columns stay NULL until the horizon
// has actually elapsed — the recorder never guesses an outcome.
async function addShadowSignal(userId, row = {}) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('promptVersion', sql.NVarChar(32), row.promptVersion || null)
    .input('horizonBars', sql.Int, row.horizonBars == null ? null : row.horizonBars)
    .input('symbol', sql.NVarChar(64), row.symbol)
    .input('venue', sql.NVarChar(32), row.venue)
    .input('evidence', sql.Bit, row.evidence == null ? null : (row.evidence ? 1 : 0))
    .input('direction', sql.NVarChar(8), row.direction || null)
    .input('confidence', sql.Decimal(5, 4), row.confidence == null ? null : row.confidence)
    .input('basis', sql.NVarChar(400), row.basis || null)
    .input('rawResponse', sql.NVarChar(sql.MAX), row.rawResponse == null ? null : String(row.rawResponse))
    .input('priceAtCall', sql.Decimal(18, 6), row.priceAtCall == null ? null : row.priceAtCall)
    .input('atr14', sql.Decimal(18, 6), row.atr14 == null ? null : row.atr14)
    .input('adx14', sql.Decimal(18, 6), row.adx14 == null ? null : row.adx14)
    .input('regime', sql.NVarChar(16), row.regime || null)
    .input('sessionState', sql.NVarChar(24), row.sessionState || null)
    .input('scheduledEvent', sql.NVarChar(64), row.scheduledEvent || null)
    .input('inputTokens', sql.Int, row.inputTokens == null ? null : row.inputTokens)
    .input('outputTokens', sql.Int, row.outputTokens == null ? null : row.outputTokens)
    .query(`INSERT INTO ShadowSignals
      (userId, promptVersion, horizonBars, symbol, venue, evidence, direction, confidence, basis, rawResponse,
       priceAtCall, atr14, adx14, regime, sessionState, scheduledEvent, inputTokens, outputTokens)
      OUTPUT INSERTED.id
      VALUES (@userId, @promptVersion, @horizonBars, @symbol, @venue, @evidence, @direction, @confidence, @basis, @rawResponse,
       @priceAtCall, @atr14, @adx14, @regime, @sessionState, @scheduledEvent, @inputTokens, @outputTokens)`);
  return r.recordset[0] ? r.recordset[0].id : null;
}

async function listShadowSignals(userId, { limit = 200 } = {}) {
  const pool = await getPool();
  const lim = Math.min(Math.max(1, Number(limit) || 200), 5000);
  const r = await pool.request()
    .input('userId', sql.Int, userId).input('limit', sql.Int, lim)
    .query(`SELECT TOP (@limit) * FROM ShadowSignals WHERE userId = @userId ORDER BY id DESC`);
  return r.recordset;
}

// Rows whose horizon cannot have elapsed yet are excluded by the caller's clock,
// not by us — the scorer owns "has it elapsed", because that depends on bars.
async function listUnscoredShadowSignals(userId, { limit = 500 } = {}) {
  const pool = await getPool();
  const lim = Math.min(Math.max(1, Number(limit) || 500), 5000);
  const r = await pool.request()
    .input('userId', sql.Int, userId).input('limit', sql.Int, lim)
    .query(`SELECT TOP (@limit) * FROM ShadowSignals
            WHERE userId = @userId AND scoredAt IS NULL
            ORDER BY id ASC`);
  return r.recordset;
}

// Fill the forward outcome. Only the scorer calls this, and only once per row.
async function scoreShadowSignal(id, row = {}) {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.Int, id)
    .input('barsToHorizon', sql.Int, row.barsToHorizon == null ? null : row.barsToHorizon)
    .input('horizonAt', sql.DateTime2, row.horizonAt ? new Date(row.horizonAt) : null)
    .input('closeAt', sql.DateTime2, row.closeAt ? new Date(row.closeAt) : null)
    .input('mfePct', sql.Decimal(12, 6), row.mfePct == null ? null : row.mfePct)
    .input('maePct', sql.Decimal(12, 6), row.maePct == null ? null : row.maePct)
    .input('realisedR', sql.Decimal(12, 6), row.realisedR == null ? null : row.realisedR)
    .input('benchmarkLongR', sql.Decimal(12, 6), row.benchmarkLongR == null ? null : row.benchmarkLongR)
    .input('confirmedByStrategy', sql.Bit, row.confirmedByStrategy == null ? null : (row.confirmedByStrategy ? 1 : 0))
    .query(`UPDATE ShadowSignals SET barsToHorizon = @barsToHorizon, horizonAt = @horizonAt, closeAt = @closeAt,
              mfePct = @mfePct, maePct = @maePct, realisedR = @realisedR, benchmarkLongR = @benchmarkLongR,
              confirmedByStrategy = @confirmedByStrategy, scoredAt = GETUTCDATE()
            WHERE id = @id`);
}

// The gate populations (plan §3.7): total calls and the DIRECTIONAL subset are
// different numbers, and conflating them is what made rev 2's gate a formality.
async function shadowSignalStats(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`SELECT COUNT(*) AS totalCalls,
                   SUM(CASE WHEN direction IN ('buy','sell') THEN 1 ELSE 0 END) AS directional,
                   SUM(CASE WHEN scoredAt IS NOT NULL THEN 1 ELSE 0 END) AS scored,
                   SUM(CASE WHEN createdAt >= DATEADD(DAY, -1, GETUTCDATE()) THEN 1 ELSE 0 END) AS callsLast24h,
                   MIN(createdAt) AS firstAt, MAX(createdAt) AS lastAt
            FROM ShadowSignals WHERE userId = @userId`);
  const row = r.recordset[0] || {};
  const total = Number(row.totalCalls) || 0;
  const dir = Number(row.directional) || 0;
  return {
    totalCalls: total, directional: dir, scored: Number(row.scored) || 0,
    callsLast24h: Number(row.callsLast24h) || 0,
    yesRatePct: total ? Math.round((dir / total) * 1000) / 10 : null,
    firstAt: row.firstAt || null, lastAt: row.lastAt || null,
  };
}

// TRD-SHW-1: scheduled-event lookup for the shadow rows. CorporateEvents already
// holds FOMC meeting days (imported from federalreserve.gov by agent/calendar.js)
// and any halts, so this covers the macro MEETING case. CPI/NFP are NOT covered —
// see the SCOPE LIMIT note in the plan doc; the field stays NULL rather than guessing.
async function listCorporateEvents(userId, { days = 3 } = {}) {
  const pool = await getPool();
  const d = Math.min(Math.max(1, Number(days) || 3), 90);
  const r = await pool.request()
    .input('userId', sql.Int, userId).input('days', sql.Int, d)
    .query(`SELECT eventDate, eventType, note, symbol, source FROM CorporateEvents
            WHERE userId = @userId
              AND eventDate BETWEEN DATEADD(DAY, -@days, GETUTCDATE()) AND DATEADD(DAY, @days, GETUTCDATE())
            ORDER BY eventDate`);
  return r.recordset;
}

// TRD-SHW-2: decisions in a window — baseline A asks whether a REAL entry later
// fired in the shadow call's direction, which is the lead-time question.
async function listDecisionEventsBetween(userId, from, to) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('from', sql.DateTime2, new Date(from))
    .input('to', sql.DateTime2, new Date(to))
    .query(`SELECT createdAt, JSON_VALUE(payload, '$.symbol') AS symbol,
                   JSON_VALUE(payload, '$.direction') AS direction,
                   JSON_VALUE(payload, '$.action') AS action
            FROM TradingEvents
            WHERE userId = @userId AND kind = 'decision'
              AND createdAt >= @from AND createdAt <= @to`);
  return r.recordset;
}

// Closed trades with autopsy metrics for the analytics layer.
// ★ `since` WINS WHEN PROVIDED. `days` is a ROLLING count and it is an INT all the way down, so it cannot
// express "this week": on a Wednesday the elapsed part of the week is 2.02 days, and 2.02 would be silently
// truncated to 2 — a different window that still looks like a plausible number. An absolute instant has no
// such failure mode, so the window a caller actually wants is the window it gets.
async function listClosedTradesForStats(userId, { days = 30, since = null, limit = 500 } = {}) {
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 500, 2000));
  let where = "userId = @userId AND status = 'closed'";
  if (since) {
    req.input('since', sql.DateTime2, new Date(since));
    where += ' AND closeAt >= @since';
  } else {
    req.input('days', sql.Int, Math.max(1, Number(days) || 30));
    where += ' AND closeAt >= DATEADD(day, -@days, GETUTCDATE())';
  }
  const r = await req.query(`SELECT TOP (@limit) * FROM Trades
            WHERE ${where}
            ORDER BY closeAt DESC`);
  return r.recordset;
}

// --- Strategy Lab scoreboard (TRD-14) -----------------------------------------
async function countLabCandidates(userId, { status = null } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId);
  const where = status ? 'userId = @userId AND status = @status' : 'userId = @userId';
  if (status) req.input('status', sql.NVarChar(16), status);
  const r = await req.query(`SELECT COUNT(*) AS cnt FROM LabCandidates WHERE ${where}`);
  return Number(r.recordset[0]?.cnt) || 0;
}

async function createLabCandidate(userId, { strategy, symbol, venue, params, label, registrationNo }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('strategy', sql.NVarChar(64), strategy)
    .input('symbol', sql.NVarChar(64), symbol)
    .input('venue', sql.NVarChar(32), venue || 'yahoo')
    .input('params', NVMAX, params != null ? JSON.stringify(params) : null)
    .input('label', sql.NVarChar(128), label ?? null)
    .input('registrationNo', sql.Int, registrationNo)
    .query(`INSERT INTO LabCandidates (userId, strategy, symbol, venue, params, label, registrationNo)
            OUTPUT INSERTED.id, INSERTED.registrationNo
            VALUES (@userId, @strategy, @symbol, @venue, @params, @label, @registrationNo)`);
  return r.recordset[0];
}

async function getLabCandidate(userId, id) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .query(`SELECT * FROM LabCandidates WHERE userId = @userId AND id = @id`);
  const row = r.recordset[0];
  if (!row) return null;
  return { ...row, params: row.params ? JSON.parse(row.params) : null };
}

async function listLabCandidates(userId, { status = null, statuses = null, limit = 200 } = {}) {
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 200, 1000));
  let where = 'userId = @userId';
  if (Array.isArray(statuses) && statuses.length) {
    const names = statuses.map((_, i) => `@st${i}`);
    statuses.forEach((s, i) => req.input(`st${i}`, sql.NVarChar(16), s));
    where += ` AND status IN (${names.join(',')})`;
  } else if (status) {
    where += ' AND status = @status';
    req.input('status', sql.NVarChar(16), status);
  }
  const r = await req.query(`SELECT TOP (@limit) * FROM LabCandidates WHERE ${where} ORDER BY id ASC`);
  return r.recordset.map((x) => ({ ...x, params: x.params ? safeJson(x.params) : null }));
}

async function updateLabCandidate(userId, id, patch) {
  const sets = [];
  const req = (await getPool()).request().input('userId', sql.Int, userId).input('id', sql.Int, id);
  if (patch.score !== undefined) { sets.push('score = @score'); req.input('score', NVMAX, patch.score != null ? JSON.stringify(patch.score) : null); }
  if (patch.verdict !== undefined) { sets.push('verdict = @verdict'); req.input('verdict', sql.NVarChar(24), patch.verdict); }
  if (patch.status !== undefined) { sets.push('status = @status'); req.input('status', sql.NVarChar(16), patch.status); }
  if (patch.releaseId !== undefined) { sets.push('releaseId = @releaseId'); req.input('releaseId', sql.Int, patch.releaseId); }
  if (patch.frozenAt !== undefined) { sets.push('frozenAt = @frozenAt'); req.input('frozenAt', sql.DateTime2, patch.frozenAt ? new Date(patch.frozenAt) : null); }
  if (patch.archivedAt !== undefined) { sets.push('archivedAt = @archivedAt'); req.input('archivedAt', sql.DateTime2, patch.archivedAt ? new Date(patch.archivedAt) : null); }
  if (!sets.length) return;
  sets.push("updatedAt = SYSUTCDATETIME()");
  await req.query(`UPDATE LabCandidates SET ${sets.join(', ')} WHERE userId = @userId AND id = @id`);
}

async function createLabRelease(userId, { familyType, m, mFrozen, kCounter, q, bhResult, prdsCheck, summary }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('familyType', sql.NVarChar(8), familyType || 'batch')
    .input('m', sql.Int, m)
    .input('mFrozen', sql.Int, mFrozen)
    .input('kCounter', sql.Int, kCounter)
    .input('q', sql.Float, q)
    .input('bhResult', NVMAX, bhResult != null ? JSON.stringify(bhResult) : null)
    .input('prdsCheck', NVMAX, prdsCheck != null ? JSON.stringify(prdsCheck) : null)
    .input('summary', NVMAX, summary != null ? JSON.stringify(summary) : null)
    .query(`INSERT INTO LabReleases (userId, familyType, m, mFrozen, kCounter, q, bhResult, prdsCheck, summary)
            OUTPUT INSERTED.id
            VALUES (@userId, @familyType, @m, @mFrozen, @kCounter, @q, @bhResult, @prdsCheck, @summary)`);
  return { id: Number(r.recordset[0]?.id) };
}

async function listLabReleases(userId, { limit = 20, familyType = null } = {}) {
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 20, 100));
  const where = familyType ? 'userId = @userId AND familyType = @familyType' : 'userId = @userId';
  if (familyType) req.input('familyType', sql.NVarChar(8), familyType);
  const r = await req.query(`SELECT TOP (@limit) * FROM LabReleases WHERE ${where} ORDER BY id DESC`);
  return r.recordset.map((x) => ({ ...x, bhResult: safeJson(x.bhResult), prdsCheck: safeJson(x.prdsCheck), summary: safeJson(x.summary) }));
}

async function countLabReleases(userId, { familyType = null } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId);
  const where = familyType ? 'userId = @userId AND familyType = @familyType' : 'userId = @userId';
  if (familyType) req.input('familyType', sql.NVarChar(8), familyType);
  const r = await req.query(`SELECT COUNT(*) AS cnt FROM LabReleases WHERE ${where}`);
  return Number(r.recordset[0]?.cnt) || 0;
}

module.exports = {
  DEFAULT_SETTINGS, mergeSettings, schemaProbe, BAR_TIMEFRAMES: barsRepo.BAR_TIMEFRAMES,
  getSettings, saveSettings,
  logEvent, listEvents, listEventsAll, latestEvent, queryEvents,
  listRecentNewsItems,
  insertAnalysesNote, insertAnalysisLevels, countRecentAnalyses,
  EVENT_QUERY_CAP, llmUsageSince,
  createPrompt, listPrompts, patchPromptDecision, logPromptError,
  listAlerts, createAlert, updateAlert, deleteAlert, markAlertTriggered,
  // ticks + bars repositories (TRD-12 Phase 1)
  addTicks: ticksRepo.addTicks, getTicks: ticksRepo.getTicks, latestTick: ticksRepo.latestTick, ticksSince: ticksRepo.ticksSince,
  listQuarantined: ticksRepo.listQuarantined,
  // TRD-79: the desk-wide tick history behind the DERIVED spread basis (see agent/spreadDerivation.js).
  spreadTicks: ticksRepo.spreadTicks,
  deleteOldTicks: barsRepo.deleteOldTicks, upsertHourlyBars: barsRepo.upsertHourlyBars, upsertDailyBars: barsRepo.upsertDailyBars,
  // TRD-92: the archive's own read/delete pair — the prune is bounded by what the file actually contains.
  countTicksBefore: barsRepo.countTicksBefore, listTicksBefore: barsRepo.listTicksBefore, deleteTicksThrough: barsRepo.deleteTicksThrough,
  listBars: barsRepo.listBars, upsertProviderBars: barsRepo.upsertProviderBars,
  // TRD-GRD-3: the instrument-swap detector. Re-exported HERE because `agent/bars.js` reaches the store
  // through this index — adding the function to `store/bars.js` alone leaves `store.flagSwappedBars`
  // undefined, which makes `buildAll` throw a TypeError on EVERY wake while any test that reads the call
  // site as TEXT still passes. That is exactly what happened on the first attempt.
  flagSwappedBars: barsRepo.flagSwappedBars, isSwapCandidate: barsRepo.isSwapCandidate,
  tickAgreesWithBar: barsRepo.tickAgreesWithBar, swapVerdict: barsRepo.swapVerdict,
  SWAP_TICK_EPS: barsRepo.SWAP_TICK_EPS,
  // 043: interval provenance. A caller DECLARES the sampling interval of what it writes; any reader can ask
  // whether a bar was NATIVE to its timeframe or aggregated up to it.
  TIMEFRAME_SECONDS: barsRepo.TIMEFRAME_SECONDS, barIntervalProvenance: barsRepo.barIntervalProvenance,
  upsertAggBars: barsRepo.upsertAggBars, barsCoverage: barsRepo.barsCoverage,
  deleteFlaggedBars: barsRepo.deleteFlaggedBars, listFlaggedBars: barsRepo.listFlaggedBars,
  getOpenTrades, getClosedTrades, countNewTradesToday,
  createTrade, updateTrade, getTradeById, getPhantomPositionIds, listOpenTradesWithPositionIds, countEventsSince, countRejectedSymbolsSince,
  listTrades, listStrategyStats, getUnresolvedTrades, getUnconfirmedTrades,
  createBacktestRun, listBacktestRuns,
  snapshotEquity, listEquity, listAccountEquity, addEquityTick, listEquityTicks, pruneEquityTicks, listClosedTradesForStats,
  // TRD-SHW-1: the shadow-call ledger (recorder + the scorer's accessors)
  addShadowSignal, listShadowSignals, listUnscoredShadowSignals, scoreShadowSignal, shadowSignalStats, listCorporateEvents,
  listDecisionEventsBetween,
  listPaperTrades, createPaperTrade, updatePaperTrade, clearPaperTrades, // TRD-11 paper ledger
  // Strategy Lab scoreboard (TRD-14)
  countLabCandidates, createLabCandidate, getLabCandidate, listLabCandidates, updateLabCandidate,
  createLabRelease, listLabReleases, countLabReleases,
};
