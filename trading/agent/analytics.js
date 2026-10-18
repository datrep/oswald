// trading/agent/analytics.js — TRD-12 Phase 2: per-strategy performance,
// equity curve, and drift detection (live vs backtest).
'use strict';

const store = require('../store');
const { rStats, expectancyVerdict, driftFlag } = require('./expectancy');
const stopCoverage = require('./stopCoverage');
const scopeResolution = require('../scopeResolution');

function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }
function round4(n) { return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null; }

// Per-strategy stats from closed trades in the window.
//
// ★ TWO WAYS TO SAY "THE WINDOW", and the second exists because the first CANNOT EXPRESS A WEEK. `days` is a
// rolling count and it is an INT end to end, so "this week" — 2.02 days elapsed on a Wednesday — would be
// silently rounded to 2 and the caller would have no way to know it got a different window. `since` is an
// absolute instant and is exact. The caller resolves it; this function does not guess (TRD-92).
async function strategyStats(userId, { days = 30, since = null } = {}) {
  const rows = await store.listClosedTradesForStats(userId, { days, since });
  const byStrategy = new Map();
  for (const t of rows) {
    const key = t.strategyId || 'unknown';
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(t);
  }
  const out = [];
  for (const [strategy, trades] of byStrategy) {
    const wins = trades.filter((t) => Number(t.grossPnl) > 0);
    const losses = trades.filter((t) => Number(t.grossPnl) <= 0);
    const grossWin = wins.reduce((s, t) => s + Number(t.grossPnl), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.grossPnl), 0));
    const pnls = trades.map((t) => Number(t.grossPnl));
    // Risk-adjusted statistics. `expectancy` above is in CURRENCY; an edge can only be tested
    // in R-multiples, because a strategy that risks twice as much per trade should not look
    // twice as good. rExcluded counts the trades with no usable stop, which no R-based test can
    // include — 11 of the desk's 25 closed trades are in that state (TRD-43), so the count is
    // reported rather than silently absorbed.
    const rs = rStats(trades);
    // TRD-43: and the exclusion is ATTRIBUTED, because a bare count presents two structurally
    // different things as one. `mirrored` is a position the desk never opened — reconcile adopted
    // it from the venue, so there was never a desk-side level to record and the venue exposes no
    // stop column to mirror. `deskOpened` is a position the DESK opened with no recorded risk:
    // a control failure whose risk is UNKNOWN, not zero. Only the second is actionable, so it
    // must not be summed into the first.
    const cov = stopCoverage.summarise(trades);
    out.push({
      strategy,
      trades: trades.length,
      rTrades: rs.n,
      rExcluded: rs.excluded,
      rExcludedByReason: {
        mirrored: cov.mirrored_unmeasured,
        // TRD-RSK-9: its own bucket, NOT folded into `mirrored`. These are rows the desk CLOSED — adopted
        // as strangers and then traded — so they were unmeasured risk the desk was actively managing, and
        // summing them with the untouched residue would report a control failure as somebody else's mess.
        mirroredTraded: cov.mirrored_traded,
        deskOpened: cov.missing_stop + cov.zero_distance,
      },
      rDefectTrades: cov.defects.length,
      // NOT rounded: these feed the retirement verdict, and the boundaries in
      // EVIDENCE_THRESHOLDS.md are quoted to 3dp. Consumers round for display.
      meanR: rs.meanR,
      sdR: rs.sdR,
      winRate: round2(trades.length ? (wins.length / trades.length) * 100 : 0),
      profitFactor: round2(grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0),
      expectancy: round2(trades.length ? pnls.reduce((a, b) => a + b, 0) / trades.length : 0),
      totalPnl: round2(pnls.reduce((a, b) => a + b, 0)),
      avgHoldingMin: round2(trades.reduce((s, t) => s + (Number(t.holdingMinutes) || 0), 0) / (trades.length || 1)),
      avgMfePct: round2(trades.reduce((s, t) => s + (Number(t.mfePct) || 0), 0) / (trades.length || 1)),
      avgMaePct: round2(trades.reduce((s, t) => s + (Number(t.maePct) || 0), 0) / (trades.length || 1)),
    });
  }
  return out.sort((a, b) => b.trades - a.trades);
}

// ---------------------------------------------------------------------------
// TRD-105 (2026-09-19): THE NET-EDGE SCREEN — per (strategy, symbol) pair.
// ---------------------------------------------------------------------------
//
// WHY IT EXISTS. The desk selected and retired strategies on WIN RATE (`learning.parity.winRateLagPp`),
// and self-health already reports that reference is unusable — "no referent", and survgold/survoil have no
// backtest run at all. Win rate is not the condition for a positive expectancy in the first place: a book
// can win 30% of the time and make money. This desk proves the converse — it wins 30% and loses, because
// the winners' whole available move is smaller than the losers' plus the venue's charge.
//
// The condition that actually has to hold, per trade, is:
//     MFE  >  |MAE|  +  roundTripCost
// i.e. the favourable extreme the price path ever offers must exceed the adverse extreme BY MORE THAN the
// cost of the round trip. Measured on the desk's own history it separates the strategies exactly as the
// money did: rsi2 MFE 0.038% against |MAE| 0.213% and a 0.250% Bitcoin round trip = -0.425%/trade (its
// entire loss, and a cost 6.6x the whole move it ever made in its favour); survgold 0.390% - 0.309% -
// 0.119% = -0.038%/trade (the only line whose price edge is genuinely positive — it loses because the
// charge is bigger than the edge); survoil 0.449% - 0.713% - 0.173% = -0.437%/trade.
//
// ⚠ WHAT IT IS NOT. MFE and MAE are properties of the PRICE PATH, not of the desk's capture, so a positive
// net edge does NOT promise the desk will realise it — the exits decide that, and the stop-cap sweep
// (2026-09-19) showed they cannot manufacture what the path does not offer. This is a screen on whether an
// entry PREMISE can pay at all, which is the thing the desk had no test for.
//
// ⚠ INSUFFICIENT IS NOT A PASS, and UNPRICED is not a zero. A pair under `minTrades` gets no verdict
// rather than a favourable one, and a symbol with no cost basis is a refusal, not a free trade — the same
// fail-closed rule `venueComparability` applies to admission.
async function netEdge(userId, { days = 90, minTrades = 10, minMeasurableShare = 0.5 } = {}) {
  const rows = await store.listClosedTradesForStats(userId, { days });
  const byPair = new Map();
  for (const t of rows) {
    const key = `${t.strategyId || 'unknown'}:${t.symbol}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(t);
  }
  const out = [];
  for (const [key, trades] of byPair) {
    const [strategy, symbol] = key.split(':');
    // ⚠ `Number(null) === 0` AND 0 IS FINITE, so a naive `Number.isFinite(Number(t.mfePct))` filter counts
    // an UNMEASURED excursion as a measured ZERO. The first version of this function did exactly that and
    // pulled rsi2's mean |MAE| from 0.232% down to 0.095% over the same rows, because 10 of its 17 closed
    // trades carry no autopsy — which makes a negative-edge strategy look closer to break-even, i.e. the
    // error points the dangerous way. This is the fourth appearance of this coercion in the codebase
    // (`venueComparability` "no cost basis is not zero", `exitLevels`, `stopPolicy`), so it is guarded by an
    // explicit absent-value test rather than a numeric one, exactly as those are.
    const measured = (v) => v != null && v !== '' && Number.isFinite(Number(v));
    const withEx = trades.filter((t) => measured(t.mfePct) && measured(t.maePct));
    // TRD-117 (2026-09-22): how much of the |MAE| term rests on a CIRCULAR reading.
    //
    // `maeSource = 'close'` means the adverse extreme WAS the exit price, so that row's maePct restates
    // where the trade ended instead of measuring how far price ran against it — measured at 15 of the 21
    // labelable rows on this book.
    //
    // ⚠ THE VERDICT DELIBERATELY DOES NOT EXCLUDE THEM, and the reason is specific rather than cautious:
    // exclusion here would be CONFOUNDED BY RETENTION. Provenance can only be labelled on rows whose ticks
    // still exist, so a RECENT pair would have its circular rows excluded while an OLDER pair would keep
    // them — the screen's number would then move with data AGE rather than with edge, and it feeds a live
    // refusal (`bindingProposer.scopeEdgeScreen`). So the circularity is REPORTED and the gate is left
    // alone until the label covers the sample it would filter.
    //
    // ⚠⚠ TRD-117 CORRECTION 2026-09-24: "UNTIL THE LABEL COVERS THE SAMPLE" WAS AN UNREACHABLE CONDITION,
    // so it is restated as a MEASURED one. Read literally it required every in-scope row to carry a label,
    // and the pre-2026-09-21 rows can never acquire one: their ticks are pruned, and the tick archive
    // cannot rescue them — measured, `trading/archive/ticks` holds 8551 ticks over 2.6 days (09-14 04:49 to
    // 09-16 18:31) against an unlabelled window of 09-10 to 09-23. A condition that can never be satisfied
    // is indistinguishable from one that was never checked, so the trigger is now the observable below —
    // `labelCoverage`, the share of the sample carrying ANY provenance. The deferral waits on a NUMBER, and
    // a reader can see how far off it is instead of being told to wait for it.
    //
    // The wait is not futile, for the record — coverage on this book by close date ran 09-18 10/18 labelled
    // (3 clean) → 09-21 4/6 → 09-22 3/3 → 09-23 9/9 (6 clean), because the tick cadence jumped at
    // ~2026-09-21 04:00 (190-298 ticks/symbol-hour, against 6-72 before). rsi2 is the exception and CANNOT
    // improve by waiting: it has not traded since 09-18, so its 5 labelable rows of 17 (ONE clean) are
    // frozen, and its screen needs a fresh sample or a different basis rather than more time.
    //
    // `unlabelledMae` is carried for the same reason: it is the size of the part that cannot be judged yet,
    // and a reader is entitled to see it rather than infer that an absent label means a clean one.
    const anchoredMae = withEx.filter((t) => t.maeSource === 'close').length;
    const unlabelledMae = withEx.filter((t) => t.maeSource == null).length;
    let costPct = null;
    try {
      const bps = require('./venueComparability').roundTripBpsFromCfg(require('./backtest').costCfgFor(symbol));
      if (Number.isFinite(bps)) costPct = bps / 100;
    } catch { costPct = null; }
    const n = withEx.length;
    // TRD-117: the observable the exclusion is waiting on — the share of the sample carrying ANY provenance
    // (`mid` or `close`). 1 means every row has been judged and exclusion becomes meaningful; below 1 the
    // excluded set is chosen by RETENTION rather than by circularity, which is the exact confound the
    // deferral exists to avoid. Reported, and NOT gated on, until the threshold is an owner decision.
    const labelCoverage = n ? round4((n - unlabelledMae) / n) : null;
    const avgMfePct = n ? withEx.reduce((s, t) => s + Number(t.mfePct), 0) / n : null;
    // |MAE| per trade, then averaged — NOT the absolute value of the average, which cancels a positive
    // MAE (legitimately positive for a trade that never went adverse, per fieldContracts) against a
    // negative one and understates the adverse extreme.
    const avgAbsMaePct = n ? withEx.reduce((s, t) => s + Math.abs(Number(t.maePct)), 0) / n : null;
    const netEdgePct = (n && costPct != null) ? round4(avgMfePct - avgAbsMaePct - costPct) : null;
    // One word a reader can act on, rather than a count they have to interpret. 'mixed' is the state that
    // matters: it means the number above is PARTLY the exit restated.
    const maeBasis = !n ? null : anchoredMae > 0 ? 'mixed' : unlabelledMae > 0 ? 'partial_unknown' : 'all_mid';
    const circularNote = anchoredMae > 0
      ? ` — but ${anchoredMae} of ${n} MAE value(s) are the EXIT RESTATED (maeSource=close), so this number is partly CIRCULAR (TRD-117)`
      : '';

    let verdict; let why;
    // ⚠ TRD-106 (2026-09-19): THE COUNT AND THE SHARE ARE DIFFERENT TESTS AND BOTH ARE NEEDED. A pure count
    // let rsi2 read `insufficient` on 7 measurable excursions out of 17 closes — i.e. the worst net edge on
    // the book escaped on a data technicality. `insufficient` now means "not enough HISTORY"; a pair with
    // plenty of closes but few measurable ones is `unmeasurable`, which is a DIFFERENT statement and, since
    // 2026-09-19, a refusal signal rather than a neutral absence: an excursion that cannot be measured at
    // the available tick cadence is a trade that never left the spread.
    //
    // ⚠ CORRECTION 2026-09-22 (TRD-106's own follow-up): the cadence claim that used to sit here — "the feed
    // is ~10 minutes apart" — is NO LONGER TRUE while a position is open. `accountPoller.js` writes
    // `position_poll` ticks on a 10-SECOND gate (via a `page.evaluate`, 7ms, not a navigation), and
    // measured on the closed book 0 of the 4 trades opened since that poller began are unmeasurable. The
    // RULE BELOW IS UNCHANGED — a count and a share are still the right tests, and an unmeasurable path is
    // still a finding. Only the explanation of WHY a path goes missing was out of date, and it was
    // user-facing: it is quoted in `why` below.
    const measurableShare = trades.length ? n / trades.length : 0;
    if (trades.length < minTrades) {
      verdict = 'insufficient';
      why = `${trades.length} closed trade(s), floor ${minTrades} — not enough history for any verdict, and INSUFFICIENT IS NOT A PASS`;
    } else if (n < minTrades || measurableShare < minMeasurableShare) {
      verdict = 'unmeasurable';
      why = `${n} of ${trades.length} close(s) carry a recorded excursion (${Math.round(measurableShare * 100)}%, floor ${Math.round(minMeasurableShare * 100)}%) — the path of this pair is mostly UNMEASURABLE, and that is evidence rather than a missing value: a hold that fits between two stored ticks never left the spread (TRD-106)`;
    } else if (costPct == null) {
      verdict = 'unpriced';
      why = `no round-trip cost basis for ${symbol}, so the edge cannot be shown to clear cost — a refusal, not a zero`;
    } else if (netEdgePct <= 0) {
      verdict = 'negative';
      why = `MFE ${avgMfePct.toFixed(3)}% − |MAE| ${avgAbsMaePct.toFixed(3)}% − cost ${costPct.toFixed(4)}% = ${netEdgePct}%/trade${circularNote}`;
    } else {
      verdict = 'positive';
      why = `MFE ${avgMfePct.toFixed(3)}% − |MAE| ${avgAbsMaePct.toFixed(3)}% − cost ${costPct.toFixed(4)}% = +${netEdgePct}%/trade${circularNote}`;
    }
    out.push({
      strategy, symbol, trades: trades.length, tradesWithExcursions: n, measurableShare: round4(measurableShare),
      avgMfePct: round4(avgMfePct), avgAbsMaePct: round4(avgAbsMaePct), costPct,
      netEdgePct, verdict, why,
      // TRD-117: how much of |MAE| is the exit restated, how much cannot be judged yet, and — the
      // observable the exclusion is actually waiting on — what share of the sample carries a label at all.
      anchoredMae, unlabelledMae, maeBasis, labelCoverage,
    });
  }
  // Worst edge first, so a report leads with the pairs that lose on the path alone. Pairs with no verdict
  // (insufficient / unpriced) sort last rather than being ranked as if their null were a zero.
  const rank = (v) => (v.netEdgePct == null ? 999 : v.netEdgePct);
  return out.sort((a, b) => rank(a) - rank(b));
}

// Drift detection: compare recent live win-rate vs the newest backtest for
// the same strategy. Flags when live underperforms by >= 20 percentage points.
//
// 2026-09-13 (TRD-41/TRD-44): routed through expectancy.driftFlag so this shares ONE definition
// of a usable reference with the parity harness. Previously both places accepted any run with a
// `metrics.cfd.winRate`, including a run with ZERO trades (which records 0%) or one trade (which
// records 100%) — against a 100% reference a strategy that genuinely wins 70% of the time looks
// "lagging" 61.7% of the time. Refusals are now reported (`skipped`) rather than silently
// dropping the strategy, so "no flag" can be told apart from "no comparison was possible".
// ★ "THIS WEEK" = SINCE MONDAY 00:00 UTC, and it is resolved SERVER-side so the definition lives in exactly
// one place. A browser computing its own week boundary would disagree with the desk's own weekly rhythms the
// moment a timezone or a clock differed — and both answers would look right, which is the failure mode this
// desk keeps paying for. Monday-start (not Sunday) because the desk's weekly cycle is Mon-Fri trading with
// the pre-open runbook on Sunday evening, so Sunday night belongs to the week that is about to trade.
function weekStartUtc(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7; // 0=Sun..6=Sat -> days since Monday
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}

// ★ THE WINDOW IS A PARAMETER, NOT A CONSTANT. This function used to take NO window and hardcode
// `strategyStats(userId, { days: 30 })`, so `/analytics/strategies?days=N` validated N and then discarded it
// — the card showed 30 days whatever anyone asked for. A parameter that is accepted and thrown away is worse
// than one that does not exist, because it reads like control.
async function drift(userId, { days = 30, since = null } = {}) {
  const stats = await strategyStats(userId, { days, since });
  const runs = await store.listBacktestRuns(userId, { limit: 20 });
  const flags = [];
  const skipped = [];
  for (const s of stats) {
    if (s.strategy === 'unknown') continue;
    const bt = runs.find((r) => r.strategy === s.strategy && r.metrics && r.metrics.cfd);
    const res = driftFlag(s.winRate, bt ? { winRate: bt.metrics.cfd.winRate, trades: bt.metrics.cfd.trades } : null, { lagPp: 20 });
    if (!res.comparable) { skipped.push({ strategy: s.strategy, reason: res.reason }); continue; }
    if (res.lagging) {
      flags.push({ strategy: s.strategy, liveWinRate: s.winRate, backtestWinRate: res.refWinRate, backtestTrades: res.refTrades, note: 'live underperforming backtest' });
    }
  }
  return { strategies: stats, flags, skipped };
}

// Equity curve series for the UI (mode 'demo' | 'sim').
async function equityCurve(userId, { mode = 'demo', limit = 500 } = {}) {
  return store.listEquity(userId, { mode, limit });
}

function isoWeekKey(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return `${x.getUTCFullYear()}-W${Math.ceil((((x - yearStart) / 86400000) + 1) / 7)}`;
}

// TRD-41/TRD-91 (2026-09-18): LIVENESS IS THE EFFECTIVE SET, NOT `enabled`.
//
// An explicit symbolScope entry REPLACES the enabled list for that symbol, so a strategy named only in
// scope is live and tradeable while `enabled.includes(id)` is false. rsi2 was exactly that: live on
// Bitcoin through `symbolScope.Bitcoin`, absent from `enabled`, and the strategy with the LARGEST closed
// sample on the desk (17 R-usable trades). A retire gate keyed on `enabled` therefore cannot act on it,
// and even a flagged retire would have written only `enabled` and left the scope entry keeping it live —
// a retire that reports success and changes nothing. That is the same defect this task was opened for: a
// bucket the safety net structurally cannot act on.
//
// Extracted as a pure function so the rule is testable without a database.
// TRD-116 (2026-09-25): THIS FUNCTION HAD THE SAME WRONG RULE AS CHECK 15, and it fed the same false
// warning into the parity harness and the /strategies panel. It answered "is this id named by a scope entry
// or by the default key" — which IGNORES the third branch of the resolution, the global `enabled` list that
// an ABSENT key falls back to. So an enabled strategy on a symbol with no explicit entry was reported as
// unable to run anywhere, while the resolver the desk trades on ran it on every unlisted symbol.
//
// It also needs a UNIVERSE and the APPLICABILITY filter, neither of which it had: `survoil` is named by the
// global list but `survoil.symbols = ['Oil']`, so it is track-bound away from every other symbol. A
// reachability answer without the universe is not a weaker answer, it is a different question.
function strategyLiveness(enabled = [], scope = {}, symbols = []) {
  // Read from the one module rather than restated: `others`/`*` and the fall-through to the global list are
  // the same rule as `resolveEntry`, and this file restating half of it is how the drift started.
  const othersDefault = scopeResolution.defaultEntryFor(scope);
  // ★ A DEFAULT KEY IS NOT A SYMBOL. This used to return 'others' itself as though it were an instrument, so
  // `viaScope` — rendered as a column of symbols — could read "LIVE on others".
  const scopeSymbolsFor = (id) => Object.entries(scope)
    .filter(([sym, ids]) => !scopeResolution.DEFAULT_KEYS.includes(sym) && Array.isArray(ids) && ids.includes(id))
    .map(([sym]) => sym);
  const universe = Array.isArray(symbols) ? symbols : [];
  // `isLive` keeps its EXACT original meaning (the superset of "enabled, or named anywhere") because it gates
  // the RETIRE path in `parityCheck` — a safety path must not change behaviour as a side effect of a rename.
  // The default-key clause is what preserves the old `scopeSymbolsFor` behaviour now that default keys are
  // excluded from that list.
  const isLive = (id) => enabled.includes(id) || scopeSymbolsFor(id).length > 0
    || (Array.isArray(othersDefault) && othersDefault.includes(id));
  const reachabilityKnown = universe.length > 0;
  return {
    othersDefault,
    scopeSymbolsFor,
    isLive,
    reachabilityKnown,
    // True only when the desk can actually place this strategy somewhere in the universe. When the universe
    // is unknown this is FALSE — it fails QUIET, not loud — so a caller MUST gate any "cannot run" claim on
    // `reachabilityKnown`, or it will assert an absence it never measured.
    reachableAnywhere: (id) => reachabilityKnown
      && scopeResolution.symbolsForId(enabled, scope, id, universe).length > 0,
  };
}

// What a retire must WRITE, as a pure function. Retiring a strategy that is live through symbolScope
// requires removing it from the scope entry as well as from `enabled` — `enabled` never contained it,
// and leaving the scope entry in place keeps the strategy live while the event log reports a successful
// retire. That failure mode reports success and changes nothing, so the effect is pinned by test rather
// than trusted to review.
//
// ★ AND IT MUST BE REMEMBERED, not merely applied (TRD-91, 2026-09-20). Stripping the lists was not
// durable: `bindingApply.applyScope` is the ONE writer that can put a pair into scope without a human,
// and it asks the settings what is allowed — but nothing in the settings said "a human removed this on
// purpose". Measured 2026-09-18: rsi2 was retired and then RE-ADDED by the scope widener twelve minutes
// later (TRD-103). Disarming that widener was a SETTINGS change, so the guard existed only as long as
// nobody flipped a flag back. This list is the missing memory: a retire records the id here, and the
// widener must respect it whatever else it is told.
function stripStrategy(enabled = [], scope = {}, id, retired = []) {
  const nextEnabled = enabled.filter((x) => x !== id);
  const scopePatch = {};
  for (const [sym, ids] of Object.entries(scope)) {
    if (Array.isArray(ids) && ids.includes(id)) scopePatch[sym] = ids.filter((x) => x !== id);
  }
  const removedFrom = [
    ...(enabled.includes(id) ? ['enabled'] : []),
    ...Object.keys(scopePatch).map((sym) => `symbolScope.${sym}`),
  ];
  // Idempotent: retiring an already-retired id must not duplicate it, or the list grows on every pass.
  const nextRetired = [...new Set([...(Array.isArray(retired) ? retired : []).map(String), String(id)])];
  return {
    strategy: {
      enabled: nextEnabled,
      retired: nextRetired,
      ...(Object.keys(scopePatch).length ? { symbolScope: scopePatch } : {}),
    },
    removedFrom,
    // A retire that changes nothing is a BUG, not a no-op: it means the strategy was never reachable
    // through either list, so the verdict was formed about something the desk could not have traded.
    effective: removedFrom.length > 0,
  };
}

// IMPLIED GOAL #7: the parity harness — once per UTC week, judge each live strategy on its own
// closed trades and retire the ones the evidence no longer supports.
//
// REWRITTEN 2026-09-13 (TRD-41; EVIDENCE_THRESHOLDS.md rev 2.2 §4-5). The old rule retired a
// strategy when `expectancy <= 0` OR when its win rate lagged the backtest by 20pp. Measured
// against the desk's own distribution that was a ~51% false-retire at n=10, FLAT in n, because
// `expectancy <= 0` is a point estimate with no error control — for a zero-edge strategy the
// sample mean is negative half the time, at every n. What changed:
//
//   1. RETIREMENT tests the EDGE (mean R) with an explicit, spent error budget
//      (agent/expectancy.js), and gains a third state — undecided / keep observing.
//   2. The win-rate gap is demoted to a DRIFT FLAG: reported, never a trigger. Its false-fire
//      rate is non-monotonic in backtest quality (a 55% reference fires more than a 50% one).
//   3. `parityValidated` is DERIVED from the accept state. Nothing in the codebase wrote it
//      before, which is how the desk ran at full size on an assertion (S4).
//   4. The `'unknown'` bucket still cannot be retired (there is no strategy to retire) but is now
//      REPORTED as a data-quality problem instead of silently skipped — it was the only subject
//      the harness ever judged, which is why the harness looked like it had never run.
async function parityCheck(userId, settings) {
  const p = (settings.learning && settings.learning.parity) || {};
  if (p.enabled === false) return null;
  const week = isoWeekKey();
  const last = await store.latestEvent(userId, 'parity_check');
  if (last && last.payload && last.payload.week === week) return null;

  const minTrades = Math.max(3, Number(p.minTrades) || 10);
  const alpha = Number(p.alpha) || 0.05;
  const lagPp = Number(p.winRateLagPp) || 20;
  const stats = await strategyStats(userId, { days: 90 });
  const runs = await store.listBacktestRuns(userId, { limit: 20 });
  const enabled = (settings.strategies && settings.strategies.enabled) || [];
  const scope = (settings.strategies && settings.strategies.symbolScope) || {};
  // TRD-116: the universe is passed in, because "can this strategy run anywhere" is unanswerable without it.
  const universe = scopeResolution.watchlistSymbols(settings.watchlist);
  const { isLive, scopeSymbolsFor, reachableAnywhere, othersDefault, reachabilityKnown } =
    strategyLiveness(enabled, scope, universe);

  // Alpha is spent across the looks ACTUALLY TAKEN: a per-look 5% compounds against a strategy
  // that stays break-even. Counting the logged parity checks makes the budget data-driven rather
  // than a configured guess, and it tightens as the desk ages, which is what repeated testing
  // should do.
  const priorLooks = await store.countEventsSince(userId, 'parity_check', 365 * 24 * 60).catch(() => 0);
  const looks = Number(priorLooks || 0) + 1;

  const judged = [];
  const retired = [];
  const driftFlags = [];
  const notes = [];

  for (const s of stats) {
    if (s.strategy === 'unknown') {
      notes.push(`${s.trades} closed trade(s) carry no strategyId — untagged trades can be neither credited nor retired, so they are invisible to the learning loop`);
      continue;
    }
    const verdict = expectancyVerdict(
      { n: s.rTrades, meanR: s.meanR, sdR: s.sdR },
      { alpha, looks, minTrades },
    );
    const ref = runs.find((r) => r.strategy === s.strategy && r.metrics && r.metrics.cfd);
    const drift = driftFlag(s.winRate, ref ? { winRate: ref.metrics.cfd.winRate, trades: ref.metrics.cfd.trades } : null, { lagPp });
    const isEnabled = isLive(s.strategy);
    // THREE ways `enabled` and the scope can disagree, and the third is the one that is NOT a defect.
    // Either the strategy is live through an explicit scope entry while `enabled` reads "off" (TRD-91);
    // or it is live through the DEFAULT key, which is the same override applied to every symbol without an
    // explicit entry — it used to be reported as "LIVE on others", a default key printed in a column of
    // instruments; or it sits in `enabled` and can run NOWHERE, which is the only genuine dead setting.
    const viaScope = enabled.includes(s.strategy) ? [] : scopeSymbolsFor(s.strategy);
    const viaDefault = !enabled.includes(s.strategy) && Array.isArray(othersDefault) && othersDefault.includes(s.strategy);
    if (viaScope.length) {
      notes.push(`${s.strategy}: live via symbolScope on ${viaScope.join(', ')} while NOT in strategies.enabled — a scope entry overrides the global list, so "enabled" is not a master switch (TRD-91)`);
    } else if (viaDefault) {
      notes.push(`${s.strategy}: live through the symbolScope DEFAULT key (${JSON.stringify(othersDefault)}) while NOT in strategies.enabled — the same override applied to every symbol without an explicit entry, so "enabled" is not a master switch (TRD-91)`);
    } else if (reachabilityKnown && !reachableAnywhere(s.strategy)) {
      // ★ The claim is now measured against the WATCHLIST through the real resolver. It used to be inferred
      // from "no scope entry names it", which is FALSE for an enabled strategy on an absent key — the desk
      // ran those on every unlisted symbol while this note said the setting did nothing.
      notes.push(`${s.strategy}: listed in strategies.enabled but it can run on NONE of the ${universe.length} watchlist symbol(s) (default key is ${JSON.stringify(othersDefault)}) — so the setting does nothing`);
    }
    if (drift.comparable && drift.lagging) driftFlags.push({ strategy: s.strategy, liveWinRate: s.winRate, ...drift });
    if (s.rExcluded) {
      const by = s.rExcludedByReason || { mirrored: 0, deskOpened: 0 };
      if (by.deskOpened) {
        // Deliberately TWO notes: the first is arithmetic about the sample, the second is the
        // claim that matters — an R-based verdict does not cover these trades at all, and saying
        // "excluded" instead of "unmeasured" reads like a footnote rather than a blind spot.
        notes.push(`${s.strategy}: ${by.deskOpened} desk-opened trade(s) have NO usable stop — their risk is UNKNOWN, not zero, and no R-based verdict covers them`);
      }
      if (by.mirrored) notes.push(`${s.strategy}: ${by.mirrored} trade(s) mirrored from the venue were never the desk's to measure (no stop was ever placed)`);
      notes.push(`${s.strategy}: R sample is ${s.rTrades} of ${s.trades} closed trade(s)`);
    }
    judged.push({
      strategy: s.strategy, enabled: isEnabled, viaScope, trades: s.trades,
      rTrades: s.rTrades, rExcluded: s.rExcluded,
      rExcludedByReason: s.rExcludedByReason, rDefectTrades: s.rDefectTrades,
      winRate: s.winRate, meanR: round4(s.meanR), sdR: round4(s.sdR),
      verdict, drift,
    });

    if (verdict.state === 'retire' && isEnabled) {
      const strip = stripStrategy(enabled, scope, s.strategy, (settings.strategies || {}).retired);
      if (!strip.effective) {
        // Should be unreachable given the gate, but if it ever fires the desk must not log a success.
        notes.push(`${s.strategy}: a retire was warranted but no list contains it — nothing was changed`);
        continue;
      }
      await store.saveSettings(userId, { strategies: strip.strategy });
      await store.logEvent(userId, 'strategy_retired', {
        strategy: s.strategy, week, verdict, removedFrom: strip.removedFrom,
        reason: `expectancy verdict: mean R ${round4(s.meanR)} over n=${s.rTrades} (upper bound ${round4(verdict.upper)}R < 0)${drift.comparable && drift.lagging ? `; also lagging the backtest by ${round2(drift.gapPp)}pp` : ''}`,
      }, { actor: 'system:parity', level: 'warn' });
      await require('../lib/http').telegramAlert(
        `OSWALD parity: retiring ${s.strategy} — the evidence rules out a non-negative edge (mean R ${round4(s.meanR)} over n=${s.rTrades}, upper bound ${round4(verdict.upper)}R < 0 at ${looks} look(s))`,
      ).catch(() => {});
      retired.push({ strategy: s.strategy, reason: 'expectancy', verdict });
    }
  }

  // TRD-43: the per-strategy loop above cannot see this problem, because the `unknown` bucket
  // `continue`s before any R note is written — and EVERY one of the 11 stopless trades is in that
  // bucket. So the coverage is measured over all closed trades, independently of tagging, and
  // stated in the one place someone reading a parity verdict will see it. A verdict that silently
  // omits a chunk of the population is worse than no verdict.
  let coverage = null;
  try {
    coverage = await stopCoverage.report(userId, { days: 90 });
    const v = coverage.verdict;
    if (v.status !== 'ok') notes.push(`stop coverage: ${v.detail}`);
    if (coverage.all.defectCount) {
      notes.push(`stop coverage: risk is UNKNOWN (not zero) for ${coverage.all.defectCount} desk-opened trade(s); every R-based test excludes them`);
    }
  } catch (e) {
    notes.push(`stop coverage unavailable: ${String(e.message || e).slice(0, 120)}`);
  }

  // DERIVE parityValidated instead of trusting a hand-set flag: full size is justified only by a
  // strategy whose LOWER bound on mean R is above zero at the spent alpha. Today no enabled
  // strategy has the sample for that, so this holds the mitigated half-size state rather than
  // changing behaviour — it removes the ability to assert the gate, which is the point.
  const enabledVerdicts = judged.filter((j) => j.enabled);
  const accepted = enabledVerdicts.filter((j) => j.verdict.state === 'accept');
  const nextValidated = accepted.length > 0;
  const prevValidated = !!(settings.learning && settings.learning.parityValidated);
  // ⚠ TRD-80 (2026-09-20): THE LIST IS WRITTEN EVERY RUN, THE FLAG ONLY ON CHANGE.
  //
  // `parityValidated` is a single boolean, so it can only say "some enabled strategy earned full size" — and
  // `risk.js` used to spend that answer on every symbol. The accepting IDs are known HERE and were thrown
  // away, so the list is now persisted for sizing to read per strategy. It must be written on every pass and
  // not inside the change-gated block below: the set can change while the boolean does not (one strategy
  // accepts, another is retired, count identical).
  const acceptedIds = accepted.map((j) => j.strategy).map(String).sort();
  const prevAcceptedIds = Array.isArray(settings.learning && settings.learning.validatedStrategies)
    ? settings.learning.validatedStrategies.map(String).sort() : [];
  if (JSON.stringify(prevAcceptedIds) !== JSON.stringify(acceptedIds)) {
    await store.saveSettings(userId, { learning: { validatedStrategies: acceptedIds } });
    await store.logEvent(userId, 'parity_validated_strategies', {
      week, accepted: acceptedIds, prev: prevAcceptedIds,
    }, { actor: 'system:parity', level: 'info' });
  }
  let validatedChanged = null;
  if (prevValidated !== nextValidated) {
    await store.saveSettings(userId, { learning: { parityValidated: nextValidated } });
    await store.logEvent(userId, 'parity_validated_changed', {
      from: prevValidated, to: nextValidated, week, accepted: accepted.map((j) => j.strategy),
    }, { actor: 'system:parity', level: nextValidated ? 'info' : 'warn' });
    await require('../lib/http').telegramAlert(
      `OSWALD parity: parityValidated -> ${nextValidated} (runInFactor ${nextValidated ? 1 : 0.5}). ${nextValidated ? `Evidence-backed edge on: ${accepted.map((j) => j.strategy).join(', ')}` : 'No enabled strategy has a positive lower bound on mean R.'}`,
    ).catch(() => {});
    validatedChanged = nextValidated;
  }

  const payload = {
    week, looks, alpha, minTrades,
    judged: judged.map((j) => ({
      strategy: j.strategy, enabled: j.enabled, trades: j.trades, rTrades: j.rTrades, rExcluded: j.rExcluded,
      rExcludedByReason: j.rExcludedByReason, rDefectTrades: j.rDefectTrades,
      winRate: j.winRate, meanR: j.meanR, sdR: j.sdR, state: j.verdict.state,
      lower: round4(j.verdict.lower), upper: round4(j.verdict.upper), boundary: round4(j.verdict.boundary),
      why: j.verdict.reason || null,
      drift: j.drift,
    })),
    // TRD-43: the population the verdicts are actually able to speak about, plus the reason each
    // excluded trade was excluded. The per-strategy rows above are the claim; this is the sample.
    stopCoverage: coverage ? {
      closed: coverage.all.closed, measured: coverage.all.measured, coveragePct: coverage.all.coveragePct,
      mirroredUnmeasured: coverage.all.mirrored_unmeasured,
      mirroredTraded: coverage.all.mirrored_traded,
      deskOpenedNoStop: coverage.all.missing_stop + coverage.all.zero_distance,
      defectTradeIds: coverage.all.defects.map((d) => d.id),
      status: coverage.verdict.status,
    } : null,
    retired, driftFlags, notes,
    parityValidated: { before: prevValidated, after: nextValidated, changed: validatedChanged },
  };
  await store.logEvent(userId, 'parity_check', payload, { actor: 'system:parity' });
  return payload;
}

module.exports = { strategyStats, netEdge, drift, equityCurve, parityCheck, strategyLiveness, stripStrategy, weekStartUtc };
