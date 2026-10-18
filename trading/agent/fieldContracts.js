// trading/agent/fieldContracts.js — assert that a field's VALUE matches its LABEL.
//
// A test pins today's behaviour. A contract asserts that the NAME still means what it says —
// units, horizon, sign, magnitude, referent. Every defect found between 2026-09-10 and 09-13
// was a value that had silently drifted from its label, and none of them threw:
//
//   prompt chgPct     labelled a 5m move        computed over 120 bars (~16h)   [TRD-36]
//   trailing stop     labelled "trailing"       anchored to PRE-ENTRY bars      [TRD-33]
//   mfePct / maePct   labelled favourable/adverse   inverted for shorts         [TRD-31]
//   holdingMinutes    labelled minutes          (report F4: a 10.6h hold on a mis-stated clock)
//   backtest winRate  labelled a win rate       from a 0- or 1-trade run        [TRD-44]
//   strategyId        labelled the same strategy   a different name space       [TRD-44]
//   riskPerTradePct   labelled risk per trade   inert while the notional cap binds [S1]
//
// The desk already has this instinct in one place — selfHealth check 9, "never trust the model
// pin alone", added when the API silently aliased the requested model. This module generalises
// it from one field to the fields that have actually lied.
//
// DELIBERATE DESIGN CHOICE — contracts needing a LIVE artifact say "NOT CHECKED" rather than
// judging stale data. A prompt from two days ago is not evidence about the code running now,
// and a check that reports a permanent false positive is one the operator learns to ignore.
// Read-only: never mutates settings, never navigates the bridge.
'use strict';

const { getPool, sql } = require('../db');
const { LEVEL_RR, realisedRR } = require('./exitLevels');
// ★ TRD-F20-EPOCH (2026-09-28): the boundary this file's level check has to respect comes from the epoch
// REGISTRY, imported by reference. `stop-cap` is the feature whose own `invalidates` says it: "Trades before
// this carry UNcapped geometry: their `stopPrice` is the declared 2xATR, so a reward:risk computed from them
// describes a stop the venue never received." That is this check's exact subject, so the cap is the honest
// boundary — NOT the policy epoch, which is three days later and would throw away 09-19/09-20 rows whose
// geometry IS comparable. Imported rather than restated: a literal date here would drift from the registry.
const epoch = require('./epoch');
const GEOMETRY_SINCE = (epoch.FEATURES.find((f) => f.id === 'stop-cap') || {}).landedAt || epoch.EPOCH;

// `standing` is set by a contract whose non-ok row describes something NO ACTION CAN CLEAR — an irreversible
// historical row, or a value that is inert BY DESIGN. It stays in the card (and in the logged event) but it
// does not set the overall status or page anyone: a banner that can never go out is the failure mode this
// desk has already been bitten by twice (TRD-65, and the F20 row itself). See selfHealth.check.
const CHECK = (id, label, status, detail, standing) => ({ id, label, status, detail, ...(standing ? { standing: true } : {}) });

// --- helpers -----------------------------------------------------------------
async function q(fn) {
  const db = await getPool();
  return fn(db);
}
function pct(a, b) { return b ? (a / b) * 100 : NaN; }
const round = (x, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

// --- pure verdict functions ---------------------------------------------------
// Separated from the DB wrappers so they can be TESTED. A contract encodes an assumption about
// a label; if the assumption is wrong the contract lies, and the first version of both of the
// functions below did exactly that (ten false failures on legitimate signed excursions, twelve
// on arithmetically perfect levels). Pure functions with error CODES are testable; formatted
// strings are not.
const dirOf = (d) => (String(d).toLowerCase() === 'sell' || String(d).toLowerCase() === 'short' ? -1 : 1);

// Invariants that actually hold for SIGNED excursions:
//   MAE <= MFE          (catches the TRD-31 favourable/adverse swap)
//   MAE <= achieved <= MFE   (the close is on the sampled path)
function excursionViolations(t, tol = 0.05) {
  const out = [];
  const mfe = Number(t.mfePct), mae = Number(t.maePct);
  if (!Number.isFinite(mfe) || !Number.isFinite(mae)) return out;
  if (mae > mfe + tol) return ['mae_above_mfe'];
  if (t.openPrice && t.closePrice) {
    const achieved = pct((t.closePrice - t.openPrice) * dirOf(t.direction), t.openPrice);
    if (achieved < mae - tol || achieved > mfe + tol) return ['achieved_outside_path'];
  }
  return out;
}

// The levels are anchored to the DECISION price, not the fill (TRD-37), so the anchor is derived
// from the geometry rather than compared against openPrice.
//
// ASSERTING THE R:R RATIO WOULD BE TAUTOLOGICAL, and an earlier version of this function did
// assert it: if stopDist is DEFINED as span/(1+RR) then tpDist/stopDist === RR identically, for
// every input. A check that cannot fail is the "control that reports success by doing nothing"
// pattern this codebase keeps producing, so it is not asserted here.
//
// ★ TRD-GEO-1 (2026-09-25): the PARAGRAPH THAT USED TO SIT HERE SAID THE INDEPENDENT DISTANCE WAS OUT OF
// REACH — "a cross-field check, not a within-row one, and it needs a link the schema may not carry."
// THE LINK EXISTS and has all along, only its parent was mis-recorded: `Trades.decisionId` references
// **`TradingPrompts.id`**, NOT `TradingEvents.id` (joined to the latter it returns unrelated rows and no
// error at all). The independent distance is also already logged by value on `TradingEvents` —
// `stop_capped.declaredStopDist` and `entry_reanchored.decisionPrice`/`stopDist`. So the drift and the
// intended distance are both READABLE, and are now read rather than derived (see `venueLevelGeometry`).
//
// What IS falsifiable here:
//   long_levels_bad_side / short_levels_bad_side   the levels must straddle the fill on the
//                                                 correct sides; this catches sign errors
//   anchored_off_fill                              the known TRD-37 drift, as a WARN
function levelGeometry(t, { rr = LEVEL_RR, driftPct = 0.05, floor = null, anchorPrice = null } = {}) {
  const dir = dirOf(t.direction);
  const bad = [];
  const drift = [];
  const unmeasurable = [];
  const belowFloor = [];
  const span = Math.abs(Number(t.takeProfitPrice) - Number(t.stopPrice));
  const stopDist = span / (1 + rr);
  // ★ TRD-GEO-1 (2026-09-25): THIS IS A DEFINITION, NOT A MEASUREMENT. On a ticket whose stop was capped
  // by `maxAdversePct`, `exitLevels.entryLevels` builds the span as `cappedStopDist + LEVEL_RR x declared`
  // — the cap tightens the STOP while the take-profit keeps the DECLARED distance — so `span / (1 + rr)`
  // reproduces neither quantity. Measured 2026-09-25: 27 of the 30 agent entries in 2026-09-11..09-24
  // carried a `stop_capped` event, so this derivation was wrong on 27 of 30 rows it was used for. It is
  // KEPT (callers and tests rely on the value) and LABELLED, so nothing downstream can treat it as read.
  const derivedAnchor = Number(t.stopPrice) + dir * stopDist;
  // `anchorPrice == null` is checked BEFORE coercion: `Number(null) === 0` would otherwise become a
  // confident anchor at zero and a drift of −100%.
  const observed = anchorPrice == null || anchorPrice === '' ? NaN : Number(anchorPrice);
  const observedOk = Number.isFinite(observed) && observed > 0;
  const anchor = observedOk ? observed : derivedAnchor;
  const anchorSource = observedOk ? 'observed' : 'derived_from_levels';
  // ★ 2026-09-30: COMPUTED ONCE, REPORTED BY TWO BRANCHES. This is the anchor's distance from the FILL —
  // the venue's fill, which is the only quantity that moves a ticket's realised geometry (the anchor is
  // 1-3s old at the snapshot; the fill lands a median 65s later). It was already computed here for the
  // TRD-37 `anchored_off_fill` WARN; the F20 floor breach below reports it now too, because without it a
  // reader cannot tell a MIS-BUILT ticket from a correctly-built one the venue filled away from - and the
  // two need opposite responses. `fillDriftPct` is reported as a MAGNITUDE on purpose: `driftPct` is signed
  // on PRICE, so its meaning flips with direction (a sell filling lower is a worse entry AND a wider stop),
  // and the sign is not needed to explain a breach.
  const anchorMovePct = observedOk ? pct(anchor - Number(t.openPrice), Number(t.openPrice)) : null;
  const fillDriftPct = Number.isFinite(anchorMovePct) ? Math.abs(anchorMovePct) : null;
  if (dir > 0 && !(t.stopPrice < t.openPrice && t.takeProfitPrice > t.openPrice)) bad.push('long_levels_bad_side');
  if (dir < 0 && !(t.stopPrice > t.openPrice && t.takeProfitPrice < t.openPrice)) bad.push('short_levels_bad_side');
  if (observedOk) {
    if (Number.isFinite(anchorMovePct) && Math.abs(anchorMovePct) > driftPct) {
      drift.push({ code: 'anchored_off_fill', pct: anchorMovePct, anchorSource, realisedRR: Math.abs(Number(t.takeProfitPrice) - Number(t.openPrice)) / Math.abs(Number(t.openPrice) - Number(t.stopPrice)) });
    }
  } else {
    // ★ REFUSE RATHER THAN FABRICATE. A drift computed from an anchor derived FROM THE LEVELS UNDER TEST
    // cannot be wrong in a visible way — it is wrong by a multiple on capped tickets and silent about it.
    // Reporting nothing is the honest answer; the caller counts these, so the gap is visible instead of
    // reading as a clean result.
    unmeasurable.push({ code: 'drift_unmeasurable', reason: 'anchor_not_observed',
      note: 'no observed decision price for this trade, so the drift is NOT measured rather than derived from the levels under test' });
  }
  // F20 (2026-09-18): the REALISED geometry, measured from the fill, against a floor.
  //
  // This is the difference between a note and a state. `anchored_off_fill` above says the anchor moved;
  // this says the position is NOT THE ONE THE DESK DECIDED ON, which is the thing that costs money. It is
  // computed independently of the drift percentage on purpose: a 3% anchor move can still leave an
  // unusable ratio, and a large move in the FAVOURABLE direction (the #1046 case: a sell that filled 1.56%
  // below its anchor) leaves a huge stop and a tiny target.
  //
  // `rr === null` from realisedRR means the stop sits on the WRONG SIDE of the fill — unmeasurable is the
  // worst case of this class, not an exemption from it.
  const real = realisedRR(t.direction, t.openPrice, t.stopPrice, t.takeProfitPrice, rr);
  const limit = Number(floor) > 0 ? Number(floor) : null;
  if (limit != null && (!real || real.rr == null || real.rr < limit)) {
    // ★ 2026-09-30: THE BREACH CARRIES ITS CAUSE. Measured on 54 entries that recorded both: realised R:R
    // falls monotonically with |fill drift| - avg 1.831R under 0.05%, 1.587R at 0.05-0.15%, 0.866R at
    // 0.15-0.30%, 0.809R at or above 0.30% - and EVERY entry below 0.9R is a `worseEntry` row whose drift
    // exceeds 0.19%. So on this desk a floor breach is a FILL-DRIFT fact long before it is a placement
    // error, and the branch that says "this is not the position the desk decided on" should say which.
    belowFloor.push({ code: 'realised_rr_below_floor', rr: real ? real.rr : null, floor: limit, anchorSource, fillDriftPct });
  }
  return { bad, drift, unmeasurable, belowFloor, anchor, anchorSource, stopDist, realised: real };
}

// --- 1. holdingMinutes really is minutes between open and close --------------
async function holdingMinutes(userId, { limit = 50 } = {}) {
  const r = await q((db) => db.request()
    .input('userId', sql.Int, userId).input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) id, holdingMinutes,
                   DATEDIFF_BIG(second, openAt, closeAt) AS secs
              FROM Trades
             WHERE userId = @userId AND closeAt IS NOT NULL AND openAt IS NOT NULL
             ORDER BY id DESC`));
  const bad = r.recordset.filter((t) => {
    const mins = t.secs / 60;
    return t.holdingMinutes == null || Math.abs(t.holdingMinutes - mins) > 1.5;
  });
  if (!r.recordset.length) return CHECK('field_holding', 'holdingMinutes = minutes open→close', 'ok', 'NOT CHECKED — no closed trades');
  return bad.length
    ? CHECK('field_holding', 'holdingMinutes = minutes open→close', 'bad',
      `${bad.length}/${r.recordset.length} disagree with (closeAt - openAt): ` +
      bad.slice(0, 3).map((t) => `#${t.id} says ${t.holdingMinutes}m, clock says ${(t.secs / 60).toFixed(1)}m`).join(' · '))
    : CHECK('field_holding', 'holdingMinutes = minutes open→close', 'ok',
      `${r.recordset.length} checked, all within 1.5 min of the clock`);
}

// --- 2. mfePct/maePct really are the favourable/adverse extremes of the path ----
// NOTE ON THE CONVENTION, read from autopsy.js rather than assumed: the stored values are
// SIGNED returns at the extremes —
//   mfePct = ((favourable - open) * dir) / open * 100
//   maePct = ((adverse    - open) * dir) / open * 100
// so MFE is legitimately NEGATIVE for a trade that never went favourable (#1031: -0.2754%)
// and MAE is legitimately POSITIVE for one that never went adverse (#1032: +0.1602%).
// A first version of this contract asserted mfePct >= 0 and produced ten FALSE failures — a
// contract encodes an assumption about a label, and a wrong assumption makes the contract lie.
// The invariants that actually hold, and that catch the TRD-31 inversion:
//   1. MAE <= MFE        (the adverse extreme cannot be better than the favourable one; if the
//                         two were swapped, this fails)
//   2. MAE <= achieved <= MFE   (the close is on the sampled path — the fix that stopped MFE
//                         reading lower than the achieved move)
async function excursionSigns(userId, { limit = 50 } = {}) {
  const r = await q((db) => db.request()
    .input('userId', sql.Int, userId).input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) id, direction, openPrice, closePrice, mfePct, maePct
              FROM Trades
             WHERE userId = @userId AND closeAt IS NOT NULL AND mfePct IS NOT NULL AND maePct IS NOT NULL
             ORDER BY id DESC`));
  const bad = [];
  for (const t of r.recordset) {
    const v = excursionViolations(t);
    for (const code of v) {
      bad.push(code === 'mae_above_mfe'
        ? `#${t.id} MAE ${t.maePct}% > MFE ${t.mfePct}% — the adverse extreme cannot be better than the favourable one (TRD-31 signature: favourable/adverse swapped)`
        : `#${t.id} achieved ${round(pct((t.closePrice - t.openPrice) * dirOf(t.direction), t.openPrice), 3)}% lies outside [MAE ${t.maePct}%, MFE ${t.mfePct}%] — the close must be on the sampled path`);
    }
  }
  if (!r.recordset.length) return CHECK('field_excursion', 'MAE <= achieved <= MFE', 'ok', 'NOT CHECKED — no trades with excursions');
  return bad.length
    ? CHECK('field_excursion', 'MAE <= achieved <= MFE', 'bad', `${bad.length} violation(s): ${bad.slice(0, 3).join(' · ')}`)
    : CHECK('field_excursion', 'MAE <= achieved <= MFE', 'ok', `${r.recordset.length} checked, signed extremes consistent with the path`);
}

// F20: the floor, as a PERCENTAGE of the declared R:R (`risk.minRealisedRrPct`, default 50%).
// Expressed as a fraction of the declaration rather than an absolute number so it cannot drift out of
// agreement with `LEVEL_RR` — the audit's case (#1046) came in at 0.22 against a declared 1.5, i.e. 15% of
// the declaration. `0` (or anything non-positive) disables the check, which is how an owner who has decided
// to accept the TRD-37 drift says so.
function rrFloor(settings) {
  const raw = settings && settings.risk ? settings.risk.minRealisedRrPct : null;
  const pct = Number(raw);
  // Explicit zero is a DECISION ("I accept the TRD-37 drift"), so it disables the check. An unset or
  // malformed value is a missing decision, which means the default — never an accidental zero, because a
  // floor of 0 silently disables the check that exists to make an invisible risk visible.
  if (raw != null && raw !== '' && Number.isFinite(pct) && pct === 0) return 0;
  const p = Number.isFinite(pct) && pct > 0 ? pct : 50;
  return LEVEL_RR * (p / 100);
}

// --- 3. the venue levels really are the R:R they are labelled as -------------
// NOTE ON THE ANCHOR, again read rather than assumed: the levels are computed from the DECISION
// price, while Trades.openPrice is the FILL 13-142s later (TRD-37). So |TP - stop| is NOT
// (1+RR) * |fill - stop| — a first version of this contract used the fill and reported twelve
// false failures against levels that are arithmetically perfect.
// What is TRUE and assertable:
//   1. the geometry implies tpDist / stopDist === LEVEL_RR exactly (anchor-independent)
//   2. the levels straddle the fill on the correct side
//   3. the implied anchor vs the fill is the known drift, reported as a WARN with the realised
//      R:R, not as a violation.
async function venueLevelGeometry(userId, { limit = 50, driftPct = 0.05, settings = null, since = GEOMETRY_SINCE } = {}) {
  const floor = rrFloor(settings);
  // ⚠ THE SCOPE IS IN THE `WHERE`, NOT IN A POST-FILTER, AND THAT IS LOAD-BEARING. `TOP (@limit)` takes the
  // newest 50 level-bearing rows BEFORE any date filter ran, so a post-filter would keep reading a window that
  // is 46% pre-epoch (measured 2026-09-28: 23 of those 50) and could let pre-epoch rows crowd a LIVE violation
  // out of the sample entirely. A check that hides a defect because of the era of its neighbours is worse than
  // the contamination it was meant to fix.
  const scopeWhere = (scope) => (!since
    ? ''
    : scope === 'live'
      // `openAt IS NULL` is INCLUDED rather than dropped: an undateable row cannot be shown to be historical,
      // so it is measured conservatively (it may still flag) instead of being quietly excused.
      ? 'AND (t.openAt IS NULL OR t.openAt >= @since)'
      : 'AND t.openAt IS NOT NULL AND t.openAt < @since');
  const read = (scope) => q((db) => db.request()
    .input('userId', sql.Int, userId).input('limit', sql.Int, limit)
    .input('since', sql.DateTime2, since ? new Date(since) : null)
    .query(`SELECT ${scope === 'live' ? 'TOP (@limit) ' : ''}t.id, t.direction, t.openAt, t.openPrice, t.stopPrice, t.takeProfitPrice,
                   CAST(JSON_VALUE(ev.payload,'$.decisionPrice') AS FLOAT) AS decisionPrice
              FROM Trades t
              OUTER APPLY (
                SELECT TOP (1) payload FROM TradingEvents e
                 WHERE e.userId = t.userId AND e.kind = 'entry_reanchored'
                   AND CAST(JSON_VALUE(e.payload,'$.tradeId') AS INT) = t.id
                 ORDER BY e.id DESC
              ) ev
             WHERE t.userId = @userId AND t.openPrice IS NOT NULL AND t.stopPrice IS NOT NULL
               AND t.takeProfitPrice IS NOT NULL AND ABS(t.openPrice - t.stopPrice) > 0
               ${scopeWhere(scope)}
             ORDER BY t.id DESC`));
  // ONE implementation of the rule, applied to both populations, so the excluded rows are judged by the same
  // code that judges the live ones. A second, SQL-side copy of "below the floor" is how two definitions start
  // disagreeing (the `realisedRR` sign convention is subtle: it is direction-signed, so an ABS() ratio in SQL
  // reports a number where the rule reports "stop on the wrong side of the fill").
  const measure = (rows) => {
    const out = { bad: [], drift: [], belowFloor: [], unmeasurable: 0, measured: 0 };
    for (const t of rows) {
      // ★ TRD-GEO-1: the OBSERVED anchor, read from the event that recorded it, instead of one inferred from
      // the levels this check is validating. A row without one reports no drift at all rather than a number
      // that cannot look wrong.
      const g = levelGeometry(t, { driftPct, floor, anchorPrice: t.decisionPrice });
      if (g.anchorSource === 'observed') out.measured += 1; else out.unmeasurable += 1;
      for (const code of g.bad) out.bad.push(`#${t.id} ${code.replace(/_/g, ' ')}`);
      for (const d of g.drift) {
        out.drift.push(`#${t.id} anchored ${round(d.pct, 3)}% from the fill → realised R:R ${round(d.realisedRR, 3)}`);
      }
      for (const f of g.belowFloor) {
        out.belowFloor.push(`#${t.id} realised R:R ${f.rr == null ? 'unmeasurable (stop on the wrong side of the fill)' : round(f.rr, 3)} against a floor of ${round(f.floor, 2)}`
          + (f.fillDriftPct != null
            ? ` - the FILL landed ${round(f.fillDriftPct, 3)}% from the ${f.anchorSource === 'observed' ? 'observed' : 'DERIVED'} anchor that built the levels`
            : ' - no observed anchor, so the fill drift is NOT measured'));
      }
    }
    return out;
  };
  const liveRows = await read('live');
  const priorRows = since ? await read('prior') : { recordset: [] };
  const live = measure(liveRows.recordset);
  const prior = measure(priorRows.recordset);
  // ★ THE EXCLUSION IS NAMED, EVERY TIME. The whole failure this file's sibling `epoch.js` was written to stop
  // is a measurement that silently includes another regime; an exclusion that is not stated is the same defect
  // pointing the other way ("an absent measurement reads as a clean result"). So the count and the offenders
  // ride along in the detail of EVERY verdict, including `ok`.
  const priorNote = priorRows.recordset.length
    ? ` · ${priorRows.recordset.length} PRE-EPOCH row(s) (opened before ${String(since).slice(0, 10)}) are EXCLUDED from this status and measured the same way: ${prior.belowFloor.length
      ? `${prior.belowFloor.length} below the floor — ${prior.belowFloor.slice(0, 3).join(' · ')}`
      : 'none below the floor'}`
    : '';
  if (!liveRows.recordset.length) {
    return CHECK('field_levels', `venue levels = ${LEVEL_RR}R as declared`, 'ok',
      `NOT CHECKED — no post-epoch trade with both levels${priorNote}`);
  }
  if (live.bad.length) return CHECK('field_levels', `venue levels = ${LEVEL_RR}R as declared`, 'bad', `${live.bad.length} violation(s): ${live.bad.slice(0, 3).join(' · ')}${priorNote}`);
  // F20: a position whose REALISED ratio is under the floor is not the trade the desk decided on — its risk
  // is a multiple of what was intended. `bad`, not `warn`: it is the one label mismatch in this file that
  // costs money while the position is open, and `warn` is where it has sat, unread, since TRD-37.
  // ⚠ THIS BRANCH IS THE POINT OF THE EPOCH SCOPE: it must still fire. It is not demoted, not softened and not
  // made `standing` — a post-epoch row below the floor is a LIVE defect and the check exists to catch it. The
  // scope only ever removes rows the `stop-cap` registry entry says are not comparable with it.
  if (live.belowFloor.length) {
    return CHECK('field_levels', `venue levels = ${LEVEL_RR}R as declared`, 'bad',
      `${live.belowFloor.length}/${liveRows.recordset.length} POSITION(S) BELOW THE DECLARED FLOOR (F20): ${live.belowFloor.slice(0, 3).join(' · ')}${priorNote}`);
  }
  if (live.drift.length) {
    // ★ TRD-GEO-1: the unmeasured rows are named HERE too. Reporting "11/30" without saying that a further
    // 20 rows had no anchor at all invites reading 30 as the sample, when it is only the MEASURABLE part
    // of it — the same "an absent measurement reads as a clean result" failure the branch below exists for.
    const gap = live.unmeasurable
      ? ` (${live.unmeasurable} further row(s) had no observed anchor and were NOT measured)`
      : '';
    return CHECK('field_levels', `venue levels = ${LEVEL_RR}R as declared`, 'warn',
      `geometry is exact, but ${live.drift.length}/${live.measured} measured row(s) were anchored away from the fill (TRD-37, known): ${live.drift.slice(0, 3).join(' · ')}${gap}${priorNote}`);
  }
  // ★ TRD-GEO-1: SAY WHAT WAS NOT MEASURED. An absent measurement that is not named reads as a clean
  // result, which is how the fabricated drift went unnoticed on 27 of 30 rows.
  if (live.unmeasurable) {
    return CHECK('field_levels', `venue levels = ${LEVEL_RR}R as declared`, 'warn',
      `geometry is exact, but the drift was NOT measured for ${live.unmeasurable}/${liveRows.recordset.length} row(s) `
      + '(no observed decision price; deriving one from the levels under test is wrong on every capped ticket - TRD-GEO-1)'
      + priorNote);
  }
  return CHECK('field_levels', `venue levels = ${LEVEL_RR}R as declared`, 'ok',
    `${live.measured} post-epoch row(s) checked, geometry exact and anchored on the fill${priorNote}`);
}

// --- 4. a "backtest win rate" needs a backtest that can support one ----------
// 0-trade and 1-trade runs record winRate 0% and 100% — numbers with no referent.
async function backtestReference(userId) {
  const r = await q((db) => db.request().query(
    `SELECT id, strategy, symbols,
            JSON_VALUE(metrics,'$.cfd.trades')  AS trades,
            JSON_VALUE(metrics,'$.cfd.winRate') AS winRate
       FROM BacktestRuns ORDER BY id DESC`));
  const thin = r.recordset.filter((x) => x.winRate != null && Number(x.trades) < 20);
  const names = new Set(r.recordset.map((x) => x.strategy));
  const settings = await require('../store').getSettings(userId);
  const enabled = (settings.strategies && settings.strategies.enabled) || [];
  const orphan = enabled.filter((s) => !names.has(s));
  const parts = [];
  if (thin.length) parts.push(`${thin.length} run(s) with <20 trades would serve as a reference (worst: ${thin[0].strategy} ${thin[0].winRate}% on ${thin[0].trades} trade(s))`);
  // ⚠⚠ TRD-F20-EPOCH (2026-09-28): THIS LOOP COMPARES TWO NAME SPACES AND CALLED THE RESULT "NO RUN AT ALL".
  //
  // Measured: `settings.strategies.enabled` is 12 `surv*` ids and `BacktestRuns.strategy` holds the MODULE
  // names (`turtle`, `turtle_ultimate`, `mtftrend`, `regturtle`, `rsi2`, `meanrev`, `macd`). The overlap is
  // **0 of 12** — not because the survivors have no backtest behind them (they are the forward-validation
  // survivors of that screen, and `survReplicas.SET_A` IS `survGold.DEFAULTS` by reference), but because a
  // configured INSTANCE and a MODULE cannot share a name. This is TRD-44 ("strategyId labelled the same
  // strategy: a different name space") reproduced INSIDE the contract that exists to catch it, and the prose
  // then overstated it from "I cannot see one" to "there is none".
  //
  // ⚠ I DID NOT RESOLVE IT BY PARAMS EITHER, and the negative result is the reason the wording below is
  // careful: matching on KEY NAMES is worthless here (six of the seven registry names carry the identical key
  // set), and the one comparison I completed on VALUES DISAGREES — the sampled `turtle` config is
  // `adxGate=20` while `survGold.DEFAULTS` is `adxGate=0`. So on today's evidence no stored run carries the
  // survivors' frozen parameter set, and NEITHER direction is established: a family/param map has to be
  // DECLARED before this comparison can mean anything. Filed as a task rather than guessed at here.
  if (orphan.length) {
    parts.push(`${orphan.length}/${enabled.length} enabled strategy id(s) have no run UNDER THAT NAME — the runner records the MODULE `
      + `(${[...names].join(', ')}), and these are configured instances, so this comparison cannot see a run for them either way `
      + `(TRD-44 name space; a declared family/param map is required): ${orphan.join(', ')}. No drift comparison is possible in the meantime`);
  }
  if (!r.recordset.length) return CHECK('field_backtest_ref', 'backtest winRate has a referent', 'ok', 'NOT CHECKED — no backtest runs');
  if (!parts.length) {
    return CHECK('field_backtest_ref', 'backtest winRate has a referent', 'ok', `${r.recordset.length} runs, all ≥20 trades; every enabled strategy has one`);
  }
  // `standing`: the name-space gap is a limitation of the MEASUREMENT, not a live fault, and no run of the
  // desk can clear it — the fix is a declared map, filed as a task. Paging on it every 15 min is how a real
  // alert gets tuned out. It stays in the card and in the logged snapshot; it does not set the status.
  return CHECK('field_backtest_ref', 'backtest winRate has a referent', 'warn', parts.join(' · '), true);
}

// --- 5. "risk per trade" is the risk the trade actually took -----------------
// The S1 defect: riskPct says one number, the notional cap decides another, and nothing says so.
//
// ★ TRD-RSK-11 (2026-09-29): WHICH CONTROLS COUNT AS AN EXPLANATION, AND WHY IT IS NOT `cappedAtPct`.
// `cappedAtPct` was written unconditionally from the setting, so for every row before the 2026-09-29 fix it is
// present whether or not the cap did anything. A window spanning that fix therefore contains rows whose meaning
// differs, and the old rows would certify themselves. So the claim is taken from the two witnesses that cannot
// be faked, in order of precision:
//   1. `boundBy` (L4) — the ENUM that names the control which actually decided the size. Present from
//      2026-09-29; absent on older rows. Most precise, because a dial-vs-realised gap can be caused by ANY of
//      the four controls and not only the notional cap.
//   2. The writer's own reason string `size capped at N% equity` — pushed in the SAME branch that truncates, so
//      it is evidence in EVERY era. This is the field the 367/402 re-count in TRD-RSK-10 used to find the defect.
// A gap with neither witness is a REAL label mismatch, which is what makes the warn reachable again.
const RISK_UNIT_CONTROL = {
  maxEquityPerPositionPct: 'notional cap',
  maxRiskPerTradePct: 'risk cap',
  exposureCapPct: 'portfolio budget',
  margin_utilisation: 'margin guard',
};
// ⚠ THE SAME FOUR CONTROLS, IN PROSE — AND THE FIRST VERSION ONLY KNEW THE NOTIONAL ONE. Measured 2026-09-29 on
// the newest 200 sizing events: recognising ONLY `size capped at N% equity` re-classified 25 of 200 rows as
// unexplained, and 24 of those 25 carry the RISK cap's prose instead (`size capped at 0.07% risk/trade (implied
// 1.000% of equity)`). A control that bound is a control that bound, whichever one it was — so reading only the
// notional cap's wording would have swapped a false "explained" for a false "unexplained", which is the exact
// failure TRD-RSK-11 warned the two edits must not trade for each other.
const RISK_UNIT_REASONS = [
  { re: /^size capped at ([\d.]+)% equity$/, label: 'notional cap' },
  { re: /^size capped at ([\d.]+)% risk\/trade/, label: 'risk cap' },
];
// ★★ TRD-EXE-19 (2026-10-02) — THE SCALE A SIZE WAS DIVIDED BY, READ FROM THE RECORD.
//
// This module RE-DERIVES the sizing arithmetic to audit it, which makes it a CALL SITE of that arithmetic — a fact
// this workstream learned the hard way: adding `notionalK` to `baseSize` in `risk.js` broke this checker, and it
// reported `bad` live for hours before anyone looked. The auditor is a site.
//
// ⚠ IT READS THE INPUTS (`fx`, `pointValue`) RATHER THAN A PRODUCT, so the audit stays independent of the number
// it is auditing.
// ⚠ `1` IS BOTH THE IDENTITY AND THE ERA RULE: rows written before the change carry neither key, and they were
// sized WITHOUT a scale, so they must keep auditing against the formula they actually used. A missing key must
// never silently change a historic verdict.
function scaleOf(row) {
  const fx = Number(row && row.fx);
  const pv = Number(row && row.pointValue);
  return (Number.isFinite(fx) && fx > 0 ? fx : 1) * (Number.isFinite(pv) && pv > 0 ? pv : 1);
}

// ⚠⚠ THE ERA RULE ABOVE WAS FALSE, AND IT WAS FALSE IN THE DIRECTION THAT PRODUCES A FALSE ALARM (2026-10-02).
//
// `scaleOf` says "rows written before the change carry neither key, and they were sized WITHOUT a scale". That
// is true of rows before the SCALING landed, and true of rows after the INPUTS landed — but between those two
// dates the desk SIZED WITH A SCALE AND DID NOT RECORD IT. Measured on this desk: `baseSize` began carrying a
// scale at 2026-10-01T16:51, while `sizeCalc.fx`/`pointValue` only began being emitted at 2026-10-02T08:24, so
// FIVE decisions (10-01 16:51 → 10-02 00:26) are scaled but key-less.
//
// Those rows match NEITHER formula. The old code called that "sizing arithmetic drifted" and returned `bad` —
// a false alarm on arithmetic that is CORRECT, which is the class this workstream keeps re-finding: a number
// (here, a verdict) that does not mean what it says. And it is not a harmless alarm: a check that cries wolf on
// correct rows is exactly what makes a real regression invisible when it arrives.
//
// ⇒ A key-less row that disagrees with the unscaled formula is a RECORDING GAP, not drift. The two findings have
// different owners and different repairs, so they are collected separately. Drift (the record CARRIES the scale
// and the arithmetic still disagrees) stays `bad`. A recording gap is a `warn` that names itself.
// ⚠ `carriesScale` is tested on the KEYS, not on `scaleOf(...) !== 1`: a legitimate `fx` of 1 is still a
// RECORDED scale, and reading it as "unrecorded" would relabel an auditable row.
function riskUnitArithmetic(rows, { stopMultiple = 2 } = {}) {
  const arithmetic = [];
  const unrecorded = [];
  for (const s of rows || []) {
    if (!s || s.equity == null || s.riskPct == null || s.atr == null || s.baseSize == null) continue;
    const stopDist = Number(s.atr) * stopMultiple;
    // `stopDist * scaleOf(s)` accepts `stopDist` as a non-finite value, which makes `expectedBase` non-finite and
    // the comparison below silently skip the row — an unmeasurable row reported as agreement. Guard it.
    if (!(stopDist > 0)) continue;
    const expectedBase = (Number(s.equity) * Number(s.riskPct) / 100) / (stopDist * scaleOf(s));
    if (!(expectedBase > 0)) continue;
    const agrees = Math.abs(expectedBase - Number(s.baseSize)) / expectedBase <= 0.01;
    if (agrees) continue;
    const scale = scaleOf(s);
    const carriesScale = Number.isFinite(Number(s.fx)) || Number.isFinite(Number(s.pointValue));
    if (carriesScale) {
      arithmetic.push(`baseSize ${round(s.baseSize, 3)} vs ${round(expectedBase, 3)} from (equity x riskPct) / (atr x ${stopMultiple}${scale !== 1 ? ` x scale ${round(scale, 6)}` : ''})`);
    } else {
      // The ratio is reported because a clean constant (e.g. 64.5 = 1/0.0155, or 1.55 = fx) reads as "one scale
      // was applied", while a ragged number reads as "something else is wrong". The reader can tell them apart;
      // a bare verdict could not.
      unrecorded.push(`baseSize ${round(s.baseSize, 3)} vs ${round(expectedBase, 3)} unscaled (ratio ${round(Number(s.baseSize) / expectedBase, 4)})`);
    }
  }
  return { arithmetic, unrecorded };
}

function riskUnitExplain(s) {
  const row = s || {};
  const actor = typeof row.boundBy === 'string' && RISK_UNIT_CONTROL[row.boundBy] ? row.boundBy : null;
  if (actor) return { explained: true, why: `${RISK_UNIT_CONTROL[actor]} bound`, by: actor };
  for (const raw of (Array.isArray(row.reasons) ? row.reasons : [])) {
    for (const w of RISK_UNIT_REASONS) {
      const m = w.re.exec(String(raw));
      if (m) return { explained: true, why: `${w.label} bound (${m[1]}%)`, by: 'reason' };
    }
  }
  return { explained: false, why: '', by: null };
}

// ⚠ WHICH STOP THE TICKET ACTUALLY USED — the contract's `realised` was computed with the WRONG one, and that is a
// second, independent reason a gap can look unexplained. It measured realised risk as `finalSize x (atr x
// stopMultiple)`, but the live stop is `max(2xATR, 3x spread)` clamped by `maxAdversePct`, so the two differ
// whenever a spread floor or the cost floor binds — measured 2026-09-29 on event #105926: the contract used
// `atr x 2 = 0.0556` while the reason line records `stop widened to 3x spread (0.3390 > 2xATR 0.0556)`, a 6.1x
// gap. Recomputed with the real stop, that ticket's realised risk is 0.0700% of equity — which is EXACTLY the
// 0.07% the risk cap's own reason names, so the gap was explained all along and only the denominator was wrong.
// Prefer, in order: the writer's `resolvedRiskPct` (L4, and the number this check is trying to reproduce); the
// effective stop the writer recorded in its own reason; the `atr x stopMultiple` approximation (the only thing
// rows before both fixes carry, and now REPORTED so the reader knows which rows rest on it).
function riskUnitRealised(s, { stopMultiple = 2 } = {}) {
  const row = s || {};
  if (Number.isFinite(Number(row.resolvedRiskPct)) && Number(row.resolvedRiskPct) > 0) {
    return { realisedPct: Number(row.resolvedRiskPct), source: 'resolvedRiskPct', stopDist: null };
  }
  for (const raw of (Array.isArray(row.reasons) ? row.reasons : [])) {
    const m = /^stop widened to [\d.]+x spread \(([\d.]+) >/.exec(String(raw));
    if (m) {
      const stopDist = Number(m[1]);
      if (stopDist > 0 && Number(row.equity) > 0) {
        return { realisedPct: (Number(row.finalSize) * stopDist * scaleOf(row) / Number(row.equity)) * 100, source: 'reason:widened', stopDist };
      }
    }
  }
  if (row.atr == null || row.equity == null) return { realisedPct: null, source: 'unreadable', stopDist: null };
  const stopDist = Number(row.atr) * stopMultiple;
  return { realisedPct: (Number(row.finalSize) * stopDist * scaleOf(row) / Number(row.equity)) * 100, source: 'atr', stopDist };
}

async function riskUnit(userId, { stopMultiple = 2, limit = 20 } = {}) {
  const r = await q((db) => db.request()
    .input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) id, JSON_QUERY(payload,'$.sizeCalc') AS sizeCalc
              FROM TradingEvents
             WHERE kind = 'decision' AND JSON_QUERY(payload,'$.sizeCalc') IS NOT NULL
             ORDER BY id DESC`));
  if (!r.recordset.length) return CHECK('field_risk_unit', 'riskPct = risk the trade took', 'ok', 'NOT CHECKED — no sizing event yet');
  const rows = r.recordset.map((x) => { try { return JSON.parse(x.sizeCalc); } catch { return null; } }).filter(Boolean);
  if (!rows.length) return CHECK('field_risk_unit', 'riskPct = risk the trade took', 'ok', 'NOT CHECKED — sizeCalc unparseable');
  const arithmetic = [];
  const inert = [];
  const stopSources = {};
  let unmeasured = 0;
  const { arithmetic: arithFindings, unrecorded } = riskUnitArithmetic(rows, { stopMultiple });
  arithmetic.push(...arithFindings);
  for (const s of rows) {
    if (s.equity == null || s.riskPct == null || s.atr == null || s.baseSize == null) continue;
    // What the trade actually risked, in the same units as riskPct.
    if (Number(s.finalSize) > 0) {
      const got = riskUnitRealised(s, { stopMultiple });
      if (got.realisedPct == null) { unmeasured++; continue; }
      const realisedPct = got.realisedPct;
      stopSources[got.source] = (stopSources[got.source] || 0) + 1;
      const declared = Number(s.riskPct);
      if (realisedPct < declared * 0.9) {
        // ★ TRD-F20-EPOCH (2026-09-28): AN EXPLAINED GAP AND AN UNEXPLAINED GAP ARE NOT THE SAME FINDING, AND
        // THE FIRST VERSION TREATED THEM IDENTICALLY. A gap the desk's OWN CONTROLS account for is a deliberate
        // sizing-down, and this check called it degradation on every run. Only a gap NOTHING accounts for is a
        // real label mismatch worth a warn.
        // ⚠ TRD-RSK-11 (2026-09-29): THAT PREMISE WAS FALSE AS WRITTEN. It defined "explained" as
        // `s.cappedAtPct != null`, and because that field was written unconditionally from the setting it was
        // NEVER null — so every gap was classed explained and the warn below could not fire. The premise is kept
        // (it is the right one); only the evidence for it changed, to witnesses that cannot be faked.
        const { explained, why } = riskUnitExplain(s);
        inert.push({
          text: `${declared}% declared → ${round(realisedPct, 3)}% realised${why ? ` (${why})` : ''}`,
          explained,
        });
      }
    }
  }
  if (arithmetic.length) return CHECK('field_risk_unit', 'riskPct = risk the trade took', 'bad', `sizing arithmetic drifted: ${arithmetic.slice(0, 2).join(' · ')}`);
  // ★ A RECORDING GAP IS NOT DRIFT, AND IT MUST NOT READ AS ONE. These rows were sized WITH a scale that
  // `sizeCalc` does not carry, so they can be audited against neither formula. Reported as a warn that names
  // itself and states the ratio, because the sizes are CORRECT — the record is what is incomplete — and because
  // the fix has already shipped (`fx`/`pointValue` are emitted from 2026-10-02), so the window closes by itself
  // as newer rows arrive. It is still worth a warn: a desk that cannot reproduce one of its own sizes from its
  // own record has a gap, even when the size was right.
  if (unrecorded.length) {
    return CHECK('field_risk_unit', 'riskPct = risk the trade took', 'warn',
      `${unrecorded.length} of ${rows.length} row(s) in this window used a size the record cannot audit — the scale was APPLIED but not WRITTEN: ${unrecorded.slice(0, 2).join(' · ')}`
      + ' — a RECORDING gap, not arithmetic drift (each ratio is a single constant, so one scale was used throughout);'
      + ' `$.sizeCalc.fx`/`pointValue` ship from 2026-10-02, so this window closes as newer rows arrive');
  }
  const unexplained = inert.filter((x) => !x.explained);
  const explainedN = inert.length - unexplained.length;
  // WHICH DENOMINATOR each row's `realised` rests on. Reported rather than silent, because `atr x stopMultiple`
  // is an APPROXIMATION of the stop the ticket used and it is the only one rows before the 2026-09-29 fixes
  // carry. A reader must be able to see when a verdict rests on the approximation.
  const provenance = ` (stop basis: ${Object.entries(stopSources).map(([k, v]) => `${k} x${v}`).join(', ')}`
    + `${unmeasured ? `, ${unmeasured} unmeasurable` : ''})`;
  if (unexplained.length) {
    // ★ THE WARN IS REACHABLE AGAIN. Before 2026-09-29 `explained` was `cappedAtPct != null` and that field was
    // never null, so this branch could not fire on any row.
    return CHECK('field_risk_unit', 'riskPct = risk the trade took', 'warn',
      `the risk dial is INERT while a cap binds — ${unexplained.slice(0, 3).map((x) => x.text).join(' · ')}. `
      + 'The label says "risk per trade"; a cap decides it and NO control accounts for the gap.'
      + (explainedN ? ` (${explainedN} further sizing event(s) a control explains)` : '') + provenance);
  }
  if (explainedN) {
    // `standing`: every gap is one the cap accounts for, and the cap is a deliberate limit — there is no action
    // that would clear this, so it stays visible without holding the desk amber forever.
    return CHECK('field_risk_unit', 'riskPct = risk the trade took', 'warn',
      `the risk dial is INERT while a cap binds — ${inert.slice(0, 3).map((x) => x.text).join(' · ')}. `
      + 'The label says "risk per trade"; a cap decides it, BY DESIGN (the cap is a safety limit, so the dial '
      + `being overridden means the limit is doing its job). ${explainedN}/${rows.length} sizing event(s) in this window.`
      + provenance, true);
  }
  return CHECK('field_risk_unit', 'riskPct = risk the trade took', 'ok', `${rows.length} sizing event(s); realised risk matches the declared dial`);
}

// --- 6. every prompt horizon claim states its horizon ------------------------
// TRD-36: chgPct was a 120-bar lookback printed beside a 5m label with no span.
async function promptHorizon(userId, { staleHours = 6 } = {}) {
  const r = await q((db) => db.request().query(
    `SELECT TOP 1 id, CONVERT(varchar(19), createdAt, 126) AS at, bundle
       FROM TradingPrompts ORDER BY id DESC`));
  const row = r.recordset[0];
  if (!row) return CHECK('field_prompt_horizon', 'prompt horizon claims state a horizon', 'ok', 'NOT CHECKED — no prompts stored');
  const ageH = (Date.now() - new Date(`${row.at}Z`).getTime()) / 3600000;
  if (ageH > staleHours) {
    return CHECK('field_prompt_horizon', 'prompt horizon claims state a horizon', 'ok',
      `NOT CHECKED — newest prompt is ${row.at}Z (${ageH.toFixed(1)}h old); contracts judge the code running now, not history`);
  }
  // Every chg= in the multi-timeframe block must be followed by a span.
  const chg = String(row.bundle).match(/chg=-?\d+(\.\d+)?%/g) || [];
  const spans = String(row.bundle).match(/\(over [\d.]+h\)/g) || [];
  if (!chg.length) return CHECK('field_prompt_horizon', 'prompt horizon claims state a horizon', 'ok', `prompt #${row.id} has no chg= claims`);
  return spans.length >= chg.length
    ? CHECK('field_prompt_horizon', 'prompt horizon claims state a horizon', 'ok', `prompt #${row.id}: ${chg.length} chg claim(s), ${spans.length} span label(s)`)
    : CHECK('field_prompt_horizon', 'prompt horizon claims state a horizon', 'bad',
      `prompt #${row.id} (${ageH.toFixed(1)}h old): ${chg.length} chg= claim(s) but only ${spans.length} span label(s) — a lookback is being presented as a bar move (TRD-36)`);
}

const CONTRACTS = [holdingMinutes, excursionSigns, venueLevelGeometry, backtestReference, riskUnit, promptHorizon];

// Run every contract; returns selfHealth-shaped checks so the caller can push them directly.
async function runAll(userId, opts = {}) {
  const checks = [];
  for (const fn of CONTRACTS) {
    try {
      const c = await fn(userId, opts);
      if (c) checks.push(c);
    } catch (e) {
      checks.push(CHECK(fn.name, `contract ${fn.name}`, 'warn', `contract threw: ${String(e.message || e).slice(0, 140)}`));
    }
  }
  return {
    checks,
    bad: checks.filter((c) => c.status === 'bad').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    // ★ A STANDING non-ok row is reported BESIDE the counts rather than inside them: the caller needs to know
    // it exists (it is in `checks`) without it deciding whether the desk is degraded. See `CHECK`.
    standing: checks.filter((c) => c.standing).length,
    unchecked: checks.filter((c) => /^NOT CHECKED/.test(String(c.detail))).length,
  };
}

module.exports = { runAll, CONTRACTS, excursionViolations, levelGeometry, rrFloor, dirOf, holdingMinutes, excursionSigns, venueLevelGeometry, backtestReference, riskUnit, riskUnitArithmetic, riskUnitExplain, riskUnitRealised, RISK_UNIT_CONTROL, RISK_UNIT_REASONS, promptHorizon };
