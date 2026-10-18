// trading/agent/strategies/survReplicas.js — the two PROVEN survivor sets, reproduced for four instruments.
//
// ★ WHY THIS REPLACES THE CROSS-PRODUCT WRAPPERS (owner instruction, 2026-09-25). The previous four wrappers
// picked a cell each from a 4-cell grid (dc{5,20} x gate{0,20}) measured on a 1-year window of current bars.
// The owner's ruling: DO NOT TRUST THAT BASIS — the measurements predate the current policy set — and the only
// two strategies with a live record are `survgold` and `survoil`. So this file does not derive anything. It
// REPRODUCES those two, verbatim, on Silver / Sugar / Bitcoin / SGX.
//
// ★★ THE FROZEN SET IS IMPORTED, NOT COPIED, AND THAT IS THE WHOLE DESIGN. A replica that restated
// `{donchianPeriod: 20, adxGate: 0, ...}` as a literal would be a DIFFERENT strategy the moment its source was
// ever re-frozen, and nothing would notice. `SET_A` IS `survGold.DEFAULTS` by reference:
//
//     const SET_A = require('./survGold').DEFAULTS;   // survivor A — turtle dc20, ADX gate OFF
//     const SET_C = require('./survOil').DEFAULTS;    // survivor C — turtle dc5,  ADX gate 20
//
// so drift is impossible by construction rather than caught by a test. `test/coverage-replicas.test.js` then
// asserts the identity as well, because "impossible by construction" is a claim about today's code.
//
// ★ WHAT A REPLICA IS AND IS NOT.
//   · It IS the same signal, the same window, the same gate, the same stop multiple and the same risk fraction
//     as the survivor it names — the only thing that changed is the instrument.
//   · It is NOT a claim that those parameters work on the new instrument. A window that suits Gold is a
//     statement about Gold. The transfer is the EXPERIMENT, which is exactly why the replica is track-bound
//     (below) and why it does not touch the survivor it copies.
//   · It does NOT touch `survgold`/`survoil` themselves: those keep the forward track that made them the
//     survivors, and adding four instruments to their instruments would have voided that track (rule-L).
//
// ★ TRACK-BOUND, as the survivors are: `symbols: [one symbol]`, so a per-instrument replica can only ever
// evaluate its own instrument (the 2026-09-11 scope-leak fix). Without it, eight replicas carrying two
// parameter sets would all be applicable to EVERY scope-listed symbol — i.e. Gold's exact window applied to
// Sugar because Sugar's scope entry named something else.
//
// ★ `reviewAuthority` IS DELIBERATELY NOT SET. `survgold`/`survoil` are `decider` by TRD-89's ruling that the
// trend survivors keep their safety net, and the default is `decider` — so a replica inherits that by staying
// silent rather than by restating it, and a future change to the default reaches the replicas too.
'use strict';

const turtle = require('./turtleUltimate');

// ⚠ BY REFERENCE. See the header: copying these numbers would let the replicas drift from the survivors.
const SET_A = require('./survGold').DEFAULTS; // survivor A (Gold): turtle dc20, ADX gate OFF
const SET_C = require('./survOil').DEFAULTS;  // survivor C (Oil):  turtle dc5,  ADX gate 20

const SURVIVORS = Object.freeze({
  a: Object.freeze({ id: 'survgold', label: 'Gold survivor A', set: SET_A }),
  c: Object.freeze({ id: 'survoil', label: 'Oil survivor C', set: SET_C }),
});

// ⚠ `Arabica Coffee` joins the four from the first pass, on the owner's instruction (2026-09-25): it is the
// other watchlist commodity whose scope list is empty, so it has the same blocker and the same fix. The id is
// generated, so it arrives as `survaarabicacoffee` / `survcarabicacoffee` without a special case here.
const INSTRUMENTS = ['Silver', 'Sugar', 'Bitcoin', 'SGX', 'Arabica Coffee',
  // 2026-09-30 (owner ask): the three instruments added to the watchlist that morning - Ethereum, Soybeans and
  // Natural Gas - join on exactly the same terms as the rest: two replicas each, track-bound, the survivor sets
  // imported by reference. Nothing here is tuned for them, and the caveat above applies unchanged: the transfer
  // IS the experiment.
  //
  // ⚠⚠ AND THEY DO NOT START FROM THE SAME PLACE, WHICH MATTERS BEFORE A QUIET WEEK IS READ AS A VERDICT.
  // Measured 2026-09-30: **Ethereum** has 307 hourly bars (yahoo 303 / binance 307 / okx 307) and is tradeable
  // immediately; **Natural Gas** has 18 (plus500_chart) and **Soybeans** 7, both UNDER the scan 30-bar floor -
  // so their replicas are registered and scoped but CANNOT SIGNAL until the series fills. That is a bar count,
  // not a strategy result, and the scout row now shows exactly how many bars are left (TRD-UI-8 / #1495).
  'Ethereum', 'Soybeans', 'Natural Gas'];

// The id encodes BOTH halves so a log line is self-describing: `surv` + the survivor letter + the instrument.
const REPLICAS = INSTRUMENTS.flatMap((symbol) => ['a', 'c'].map((letter) => ({
  symbol,
  letter,
  id: `surv${letter}${symbol.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`,
})));

function build(r) {
  const src = SURVIVORS[r.letter];
  return {
    id: r.id,
    name: `${src.label} set · ${r.symbol} replica (frozen)`,
    // The description is the field `strategies.list()` renders, so the provenance and the caveat are where a
    // reader of the UI actually meets them rather than in a module property nothing consumes.
    description: `Reproduces ${src.label}'s frozen turtle set (dc${src.set.donchianPeriod}, ADX gate `
      + `${src.set.adxGate || 'OFF'}) on ${r.symbol}. The frozen set is the SURVIVOR'S OWN, imported by reference, `
      + `so this is the same signal on a different instrument — NOT a claim that the set is qualified for `
      + `${r.symbol}, and not a retune of the survivor it copies.`,
    // TRACK-BOUND: a replica may only ever evaluate its own instrument.
    symbols: [r.symbol],
    DEFAULTS: { ...src.set },
    params: [], // frozen — no editable parameters by design
    liveSignal: (ctx) => turtle.liveSignal({ ...ctx, params: { ...(ctx && ctx.params), ...src.set } }),
    backtest: (series, cfg, lab) => turtle.backtest(series, { ...cfg, ...src.set }, lab),
    // Not read by the engine — carried so the report, the scope script and the test read ONE source.
    replicates: src.id,
  };
}

const MODULES = REPLICAS.map(build);
const REGISTRY = Object.fromEntries(MODULES.map((m) => [m.id, m]));

// ★ THE TWO SETS, ONE ENTRY PER INSTRUMENT. Every replica is scope-ready: the owner's instruction is to give
// the four instruments the two strategies that are known to work, and the transfer onto a new instrument is the
// experiment. The measured screen from earlier on 2026-09-25 is NOT used to filter this list — the owner
// ruled that basis out — but it is preserved in the report rather than deleted, so a reader can see it.
const SCOPE = Object.freeze(INSTRUMENTS.map((symbol) => ({
  symbol,
  ids: MODULES.filter((m) => m.symbols[0] === symbol).map((m) => m.id),
})));

module.exports = { REGISTRY, MODULES, REPLICAS, SCOPE, SURVIVORS, INSTRUMENTS, SET_A, SET_C };
