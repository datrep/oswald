// trading/agent/strategies/survGold.js — TRD-26/TRD-29 forward-validation
// strategy: the Gold survivor from the corrected 324-hunt (turtle dc20, ADX
// gate OFF), FROZEN. Registered for the plus500-demo forward track.
//
// The parameters are immutable BY DESIGN: any retuning voids the candidate
// (rule-L contract, review doc §16.9) — liveSignal therefore overrides the
// resolved params and settings-level param edits are ignored.
'use strict';
const turtle = require('./turtleUltimate');

const FROZEN = { donchianPeriod: 20, adxPeriod: 14, adxGate: 0, atrPeriod: 14, atrStopMultiple: 2, riskPerTradePct: 1 };

module.exports = {
  id: 'survgold',
  // ★★ S5 (2026-10-01): THE FREEZE MARKER, DECLARED HERE BECAUSE THIS IS THE STRATEGY IT DESCRIBES.
  // The hunt for an existing marker found NONE — see `trading/agent/frozenTrack.js` for the full search and the
  // measured reason `params: []` cannot serve (it is true of all 18 survivors AND replicas, since it is a
  // property of the generator). This field is metadata only: `DEFAULTS`, `FROZEN` and `params` are untouched, and
  // nothing reads it except the frozen gate.
  forwardFrozen: 'TRD-29',
  name: 'Turtle · Gold survivor A (frozen)',
  description: 'Forward validation of the Lab survivor: turtle dc20, ADX gate OFF (hunt-frozen 2026-09-10; params immutable; review doc §16.7/§16.9).',
  // 2026-09-11 (scope-leak fix): TRACK-BOUND — a frozen forward-validation
  // wrapper may only ever evaluate its OWN instrument, whatever the scope
  // config says. Prevents an Oil-tuned param set from trading an equity and
  // keeps the TRD-29 forward track clean.
  symbols: ['Gold'],
  DEFAULTS: { ...FROZEN },
  params: [], // frozen — no editable parameters by design
  liveSignal: (ctx) => turtle.liveSignal({ ...ctx, params: { ...(ctx && ctx.params), ...FROZEN } }),
  backtest: (series, cfg, lab) => turtle.backtest(series, { ...cfg, ...FROZEN }, lab),
};
