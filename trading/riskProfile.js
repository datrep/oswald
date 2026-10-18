// trading/riskProfile.js — TRD-RSK-7: PER-DESK RISK AND POSITION SIZING.
//
// OWNER'S ASK, verbatim: *"each with their own risk and position sizing"*. Until now `settings.risk` was ONE
// FLAT GLOBAL OBJECT consulted by one sizing formula, so every capability — the strategies, and options when
// they land — shared one dial. The measurement that made it untenable: SGX's venue floor forces 0.1640% of
// equity against a 0.07% dial (2.34x) while every other symbol's floor sits at 0.11x-0.78x, and the only
// available responses were "accept the risk", "drop the symbol", or "raise a dial that has no per-symbol form".
//
// ★ WHY THIS IS A PURE MODULE. The rule is testable without a database and without the live gate, which is the
// same reason `scopeResolution.js`, `unconfirmed.js` and `settingsDiff.js` are separate. `risk.evaluate` keeps
// only the one-line wiring.
//
// ★★ AND WHY IT REPORTS ITS OWN RESOLUTION. This is the condition the row was written under, and it is not
// decoration. The defect TRD-RSK-6 found was a panel that needed a helper function to explain its own two
// dials; a profile layer whose resolution is invisible would be that same defect with MORE knobs. So
// `resolveProfile` returns `profileId`, the axis it matched on, `overrodeKeys`, and `ignoredKeys` — and the
// gate copies that onto every decision.
'use strict';

// ★ WHICH KEYS A PROFILE MAY OVERRIDE — a WHITELIST, deliberately.
//
// The point of this row is to make the risk configuration LEGIBLE, not to add a second place to hide values.
// An unknown key in a profile is therefore NOT applied; it is REPORTED (`ignoredKeys`), because a setting that
// is silently ignored is the exact defect class this whole thread has been closing.
//
// ⚠ WHAT IS DELIBERATELY ABSENT, and why:
//   - `initialEquity` — the risk BASELINE is an account-level fact. Letting a desk redefine it would make two
//     desks disagree about the same account's floor.
//   - `dailyLossHaltPct` — the daily halt is a PORTFOLIO brake. Per-desk halts would let one desk keep trading
//     through a loss that stopped the others, which is the opposite of what a brake is for.
//   - `maxMarginUtilisationPct` — the margin ceiling (L3, rev 5). Same reason, one step stricter: it is the
//     venue's CAPACITY for ONE account, and a per-desk override would let desk A commit margin that desk B has
//     already spent — the venue liquidates the ACCOUNT, not the desk, so no desk can be allowed to allocate it.
//   - anything under `kill` — the disaster floor is not desk-scoped. `risk.js` reads it from `settings.kill`,
//     which a profile cannot reach by construction.
// The portfolio caps that ARE here (`maxPositions`, `exposureCapPct`) are included because a desk's slot
// economics genuinely differ — options expire and consume a slot differently from a spot CFD — and they are
// read through `fitExposureBudget` in the same gate, so a desk that sets them still gets the portfolio sum
// enforced across desks by the exposure cap itself.
const PROFILE_KEYS = [
  // sizing
  'riskPerTradePct', 'maxRiskPerTradePct', 'atrStopMultiple', 'maxEquityPerPositionPct',
  // stop / target geometry
  'maxAdversePct', 'takeProfitOffsetPct', 'takeProfitAnchor',
  // cost basis
  'maxCostShareOfR', 'maxAdverseCostMultiple',
  // the desk's own caps
  'maxPositions', 'maxNewTradesPerDay', 'exposureCapPct', 'reentryCooldownBars',
  // guards that decide whether THIS desk may enter
  'correlationVeto', 'minRealisedRrPct', 'maxEntryTickAgeMin', 'maxAnchorAgeSec', 'acceptVenueFloor',
];

// Which profile applies? **STRATEGY INNERMOST, then instrument class**, which is the shape the owner chose.
// A proposal naming neither resolves to `default`, which IS today's object — so an install that defines no
// profiles behaves EXACTLY as it does now. That property is the safety of this change: it is inert until a
// profile exists, and the owner can add them one desk at a time.
function profileIdFor(settings, { strategy = null, instrumentClass = null } = {}) {
  const profiles = (settings && settings.risk && settings.risk.profiles) || {};
  const has = (k) => k && Object.prototype.hasOwnProperty.call(profiles, k);
  if (has(strategy)) return { id: strategy, axis: 'strategy' };
  if (has(instrumentClass)) return { id: instrumentClass, axis: 'instrumentClass' };
  return { id: 'default', axis: 'default' };
}

// ⚠ ABSENCE IS `hasOwnProperty`, NOT FALSINESS. `0` and `false` are real risk values — `acceptVenueFloor:
// false` and `takeProfitOffsetPct: 0` are the shipped defaults — so `if (profiles[k])` would skip a profile
// whose whole content is turning something OFF. This is the coercion bug class the desk keeps re-finding.
function resolveProfile(settings, target = {}) {
  const base = (settings && settings.risk) || {};
  const profiles = base.profiles || {};
  const { id, axis } = profileIdFor(settings, target);
  const patch = id === 'default' ? {} : (profiles[id] || {});

  const applied = {};
  const ignoredKeys = [];
  for (const k of Object.keys(patch)) {
    if (!PROFILE_KEYS.includes(k)) { ignoredKeys.push(k); continue; }
    applied[k] = patch[k];
  }

  // ★ THE WHOLE BASE IS SPREAD FIRST, THEN THE PROFILE. Whitelisting the OUTPUT instead would risk dropping a
  // key the gate reads (`exitTolerance`, `minRealisedRrPct`, `initialEquity` …) — and a missing key reads as
  // `undefined`, which several callers turn into a permissive default. Resolving by override cannot lose
  // anything: every key the gate had before, it still has.
  return {
    profileId: id,
    axis,
    overrodeKeys: Object.keys(applied),
    ignoredKeys,
    risk: Object.assign({}, base, applied),
  };
}

module.exports = { resolveProfile, profileIdFor, PROFILE_KEYS };
