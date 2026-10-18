// trading/agent/strategies/survOil.js — TRD-26/TRD-29 forward-validation
// strategy: the Oil survivor from the corrected 324-hunt (turtle dc5, ADX
// gate 20), FROZEN. Registered for the plus500-demo forward track.
//
// The parameters are immutable BY DESIGN: any retuning voids the candidate
// (rule-L contract, review doc §16.9) — liveSignal therefore overrides the
// resolved params and settings-level param edits are ignored.
'use strict';
const turtle = require('./turtleUltimate');

const FROZEN = { donchianPeriod: 5, adxPeriod: 14, adxGate: 20, atrPeriod: 14, atrStopMultiple: 2, riskPerTradePct: 1 };

module.exports = {
  id: 'survoil',
  // ★★ S5 (2026-10-01): THE FREEZE MARKER — see survGold.js and `trading/agent/frozenTrack.js`.
  forwardFrozen: 'TRD-29',
  name: 'Turtle · Oil survivor C (frozen)',
  description: 'Forward validation of the Lab survivor: turtle dc5, ADX gate 20 (hunt-frozen 2026-09-10; params immutable; review doc §16.7/§16.9).',
  // 2026-09-11 (scope-leak fix): TRACK-BOUND — see survGold.js. An Oil-tuned
  // frozen param set must never evaluate another instrument.
  symbols: ['Oil'],
  DEFAULTS: { ...FROZEN },
  params: [], // frozen — no editable parameters by design
  liveSignal: (ctx) => turtle.liveSignal({ ...ctx, params: { ...(ctx && ctx.params), ...FROZEN } }),
  backtest: (series, cfg, lab) => turtle.backtest(series, { ...cfg, ...FROZEN }, lab),
};
