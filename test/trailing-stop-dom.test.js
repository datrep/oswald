// test/trailing-stop-dom.test.js — TRD-TRL-2 (#1485), the DOM half.
//
// ⚠ WHAT THIS FILE CAN AND CANNOT DO. The bridge attaches to the live Chrome, so it cannot be required from a
// unit test — the arithmetic lives in `agent/trailingStop.js` and is tested behaviourally in
// `trailing-stop.test.js`. What is left is a set of properties whose violation is silent and expensive, and those
// are pinned against the SOURCE: the ORDER of the steps, the SELECTORS, and the delegation boundary that keeps a
// second copy of the arithmetic from appearing on the DOM side. Same shape as `micro-wake-entry-lock.test.js`,
// which pins the entry-lock rule for the same reason.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const WEBTRADER = code('trading/plus500/webtrader.js');
const EXECUTOR = code('trading/agent/executor.js');
const BROWSER = code('trading/connector/browser.js');

const idx = (hay, needle) => {
  const i = hay.indexOf(needle);
  assert.notStrictEqual(i, -1, `expected the source to contain: ${needle}`);
  return i;
};

test('the bridge drives the trailing card through the SAME helper as the stop and the target', () => {
  // a fourth Set Limits card of a shape already proven live twice; reusing toggleLimit inherits its two traps
  idx(WEBTRADER, "toggleLimit(page, 'TradeSetLimits.TrailingStopHeader', 'TradeSetLimits.TrailingStopExpandable', '#trailing-stop-pips')");
  // and it is inside placeOrder, not some post-entry path that has not been built
  assert.ok(idx(WEBTRADER, "toggleLimit(page, 'TradeSetLimits.TrailingStopHeader'") < idx(WEBTRADER, 'async function closePosition'));
});

test('the pip field gets its own INTEGER filler, because fillRate would send a decimal', () => {
  idx(WEBTRADER, 'const fillPips = async (val) => {');
  // ⚠ the single most likely regression: reaching for the helper that is already there. fillRate does
  // `Number(v).toFixed(2)`, and a pip count is a whole number.
  assert.ok(!/fillRate\('#trailing-stop-pips'/.test(WEBTRADER), 'the pip field must not go through fillRate');
  // and it verifies the venue ACCEPTED the count, because a clamping spinner would invalidate the scaling
  idx(WEBTRADER, 'trailing stop: pip field did not take the count');
});

test('the trail is PLANNED before the card is touched, so every refusal leaves the ticket untouched', () => {
  const plan = idx(WEBTRADER, 'const trailPlan = planTrailingStop(');
  const touch = idx(WEBTRADER, "toggleLimit(page, 'TradeSetLimits.TrailingStopHeader'");
  assert.ok(plan < touch, 'a refusal must return before the card is engaged, not after');
  // and the refusal is REPORTED, not swallowed
  idx(WEBTRADER, "trailResult = { placed: false, reason: trailPlan.reason };");
});

test('the read-back uses the two spans the venue actually prints, read with the rate', () => {
  idx(WEBTRADER, 'TradeSetLimits.TrailingStopCalc');
  idx(WEBTRADER, "'[data-currency]'");
  idx(WEBTRADER, "'[data-percent]'");
  // the rate is read in the SAME function as the spans: the percent is denominated by the position value at the
  // CURRENT price, so a stale rate is a phantom mismatch
  const readTrail = idx(WEBTRADER, 'const readTrail = async () => {');
  const readRate = idx(WEBTRADER, 'const readRate = () => page.evaluate');
  assert.ok(readRate < readTrail);
  idx(WEBTRADER, 'const price = await readRate();');
});

test('the distance comes from the PERCENT span, so this side needs no fx rate', () => {
  idx(WEBTRADER, 'distanceFromPercent({');
  // ⚠ `distanceFromReadback` is the money route and it needs `fx` (the span is SGD, the position is USD). Using
  // it here would compare two different quantities - the defect the module already committed once.
  assert.ok(!/distanceFromReadback\(/.test(WEBTRADER), 'the DOM side must not use the fx-dependent route');
});

test('the bridge DELEGATES the arithmetic instead of keeping a second copy of it', () => {
  idx(WEBTRADER, "} = require('../agent/trailingStop');");
  // ⚠ UPGRADED, NOT RESTORED (TRD-TRL-3, 2026-09-30). This pinned `pipsFromReadback`, which derived a
  // pip-per-count from a read-back. That function is still correct arithmetic and still exported - it is simply
  // no longer how the count is obtained, because the thing it was fed read the symbol's CLAMPED CEILING.
  idx(WEBTRADER, 'pipsForTarget({');
  idx(WEBTRADER, 'verifyReadback({');
  // no arithmetic on the percent here: if this file starts computing with it, the rule has two homes again -
  // which is the failure mode the entry-lock test was upgraded to catch for the same reason
  assert.ok(!/percentFraction\s*[*/+-]/.test(WEBTRADER), 'the percent must be passed through, never computed with');
  // and no hard-coded pip anywhere on this side
  assert.ok(!/\bpip\s*=\s*0?\.0/.test(WEBTRADER), 'the pip size must never be written down');
  // ⚠ a PRESENT but zero entry must not be accepted: `skipReason` is computed in the executor but never
  // returned, so dp = 0 reaches the bridge, and entry 0 makes every derived distance garbage.
  idx(WEBTRADER, 'const entryGuess = Number(trailingStop.entry) > 0 ? Number(trailingStop.entry) : rate0;');
});

test('a trail that cannot be verified fails SAFE, and only aborts when even that fails', () => {
  idx(WEBTRADER, 'const check = verifyReadback({');
  // ⚠⚠ TRD-TRL-4 (2026-10-01): THIS LINE USED TO BE `if (check.ok) {`, AND THIS TEST PINNED THAT EXPRESSION.
  // The size check cannot see WHERE the trail landed, and on trade #1164 the trail crossed the stop by 4% of the
  // stop distance while `check.ok` was still true (drift 0.709% against a 2% tolerance). Pinning the expression
  // enshrined the defect: a green suite is not evidence that the gate is right, only that it is unchanged.
  idx(WEBTRADER, 'if (check.ok && levelCheck.ok) {');
  assert.ok(!WEBTRADER.includes('if (check.ok) {'),
    'the size-only gate must not come back: it accepted a trail that had already crossed the stop');
  idx(WEBTRADER, 'const levelCheck = finalDist.ok');
  idx(WEBTRADER, 'verifyStopRelationship({');
  // ⚠ FAIL-SAFE, NOT FAIL-CLOSED, AND THE REASON IS THE UNATTENDED TENURE. Aborting on every unverifiable trail
  // would silence the desk for the whole run with nobody watching — the very thing the tenure exists to observe.
  // The fallback is a trail set WIDER than the stop, where the stop fires first and nothing changes.
  idx(WEBTRADER, 'const wideTarget = 2 * trailPlan.stopDist;');
  // ⚠ THE FALLBACK NOW HAS TWO TRIGGERS AND THEY MUST BE DISTINGUISHABLE IN THE LOG: a trail that was the wrong
  // SIZE, and a trail that was the right size in the wrong PLACE. The same safe fallback serves both, but an
  // investigation has to be able to tell which one it is looking at — the #1164 crossing looked like a success.
  idx(WEBTRADER, 'reason: check.ok');
  idx(WEBTRADER, "? 'trail_landed_tighter_than_stop_fell_back_wider_than_stop'");
  idx(WEBTRADER, "'verification_failed_fell_back_wider_than_stop',");
  // the abort is now the LAST resort: reached only when the read-back itself is unusable
  idx(WEBTRADER, 'fail-safe could not be verified either');
  idx(WEBTRADER, 'must not be submitted');
  // ⚠ AND A COUNT THE CONTROL CANNOT EXPRESS IS ITS OWN CLASS, handled BEFORE the card is filled (TRD-TRL-3):
  // nothing is written, so the ticket is untouched and the entry is not spent discovering it.
  const plan = idx(WEBTRADER, 'const pipsPlan = pipsForTarget({ symbol, distanceTarget: trailPlan.distanceTarget });');
  idx(WEBTRADER, 'trailResult = { placed: false, reason: `unstateable_${pipsPlan.reason}`, detail: pipsPlan };');
  assert.ok(plan < idx(WEBTRADER, 'await fillPips('), 'the count must be refusable before the card is filled');
  // the fail-safe must not OVERWRITE that refusal with a placed trail
  idx(WEBTRADER, '} else if (pipsPlan.ok) {');
});

test('the write is accepted only when the card reads what THE COUNT means, not merely when it moves', () => {
  // ⚠⚠ THE BUG THIS PINS, AND IT COST EIGHT ENTRIES. "The card moved" was satisfied by a FOURTH-DECIMAL PRICE
  // jitter, so a write the control IGNORED was recorded as a success; the read-back was then judged against a
  // target it had never been asked for, and a good entry died on `wanted 0.744, read 150.39`. The test is now
  // PROPORTIONAL - via the shared table, so the expected value has one home - with a band that forgives jitter
  // (5c or 5%) and cannot forgive a clamp (the measured misses are 200x out, not 5%).
  idx(WEBTRADER, 'const proportional = (expected == null || readDistance == null)');
  idx(WEBTRADER, 'if (proportional) {');
  idx(WEBTRADER, 'distanceForCount({');
  // the method ORDER is measured, not stylistic: only the NATIVE value setter reaches the venue's model here
  idx(WEBTRADER, "for (const how of ['native', 'fill', 'type']) {");
  // and a card that reads right while the venue did not follow says so with BOTH numbers
  idx(WEBTRADER, "the pip field accepted ${want} but the venue's calculation did not `");
});

test('the fallback is WIDER than the stop, so it can only remove the ratchet, never tighten the level', () => {
  // 2x the price-anchored stop distance. ⚠ UPGRADED (TRD-TRL-3): the count used to be derived from a pip-per-count
  // the probe measured - from the clamped ceiling, so it was wrong and the fallback missed too. It now comes from
  // the same table as the primary count, under the same refusal rules: a fallback the control cannot express is
  // not a fallback.
  idx(WEBTRADER, 'const widePlan = pipsForTarget({ symbol, distanceTarget: wideTarget });');
  idx(WEBTRADER, 'const widePips = widePlan.pips;');
  // and a degraded placement is REPORTED as degraded rather than passed off as the requested one
  idx(WEBTRADER, 'degraded: true,');
  idx(WEBTRADER, 'requestedDistance: trailPlan.distanceTarget,');
});

test('the trail outcome is reported on the fill, so it cannot be silently missing', () => {
  idx(WEBTRADER, 'trailingStop: trailResult,');
  // three states, all distinguishable: null (not asked for), refused (nothing touched), placed (verified)
  idx(WEBTRADER, 'let trailResult = null;');
  idx(WEBTRADER, 'placed: true,');
  idx(WEBTRADER, 'driftPct: check.driftPct,');
});

test('the executor asks for the trail from settings and LOGS the outcome either way', () => {
  idx(EXECUTOR, 'trailCfg.enabled === true');
  idx(EXECUTOR, 'trailing_stop_placed');
  idx(EXECUTOR, 'trailing_stop_refused');
  // the degraded case gets its OWN event, so a trail that is merely too wide is not mistaken for a working one
  idx(EXECUTOR, 'trailing_stop_degraded');
  // the trail is best-effort: the venue stop is the mandatory exit, so a refused trail must not stop the order
  idx(EXECUTOR, 'takeProfitPrice: levels.tp, trailingStop }, { keepOpen, userId });');
});

test('the intent survives the connector hop to the page object', () => {
  idx(BROWSER, 'takeProfitPrice = null, trailingStop = null }');
  idx(BROWSER, 'const order = { symbol, direction, size, stopPrice, takeProfitPrice, trailingStop };');
});
