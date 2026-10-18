// test/reconcile-on-ambiguous-open.test.js — TRD-48.
//
// An `ambiguous` OPEN failure means the desk does not know whether the order landed. The venue may
// hold a position the desk has no row for — an orphan with no stop on either side. TRD-42 wired a
// forced reconciliation into the CLOSE path; the OPEN path logged the rejection and moved on.
//
// Evidence it is real: Trades 1033 / TradingEvents 13379-13380, 2026-09-13T17:14:46Z — a Gold buy of
// size 1 that spent 31.5s in the ticket flow and returned "position row did not appear after submit
// (order may have failed)". Whether the venue held that position was never established by the desk;
// the only reason it did not matter is that the periodic account snapshot happened to show margin 0.
//
// WHY THIS TEST IS STRUCTURAL. `require('../trading/agent/executor')` loads the browser connector,
// which ATTACHES TO THE DESK'S LIVE CHROME on :9224 (it did exactly that once, and the unit test took
// 31.6 seconds and fell through to a real database call). So the wiring is asserted against the source
// text, and the genuinely testable half — the classifier's verdict on the real failure strings — is
// asserted as behaviour below.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { classifyBridgeError, NEEDS_RECONCILIATION } = require('../trading/connector/errorClass');

const SOURCE = fs.readFileSync(require.resolve('../trading/agent/executor'), 'utf8');

// Split the file at the two catch handlers so a match in one path cannot satisfy an assertion about
// the other. This is the whole point of the change: BOTH paths must reconcile.
function sliceFn(src, name, nextName) {
  const a = src.indexOf(`async function ${name}(`);
  const b = nextName ? src.indexOf(`async function ${nextName}(`, a + 1) : src.length;
  assert.ok(a >= 0, `${name} not found in the executor`);
  return src.slice(a, b > a ? b : src.length);
}
const openTrade = sliceFn(SOURCE, 'openTrade', 'closeTrade');
const closeTrade = sliceFn(SOURCE, 'closeTrade', 'closeAll');

test('the real ambiguous OPEN failure classifies into a reconciliation class', () => {
  // The exact string from Trades 1033. If this ever stops mapping to `ambiguous`, TRD-48's wiring
  // becomes dead code and the orphan risk returns silently.
  const cls = classifyBridgeError(new Error('position row did not appear after submit (order may have failed)'));
  assert.equal(cls, 'ambiguous');
  assert.ok(NEEDS_RECONCILIATION.has(cls));
});

test('the OPEN path reconciles when the outcome is unknown', () => {
  assert.match(openTrade, /NEEDS_RECONCILIATION\.has\(cls\)/, 'openTrade must consult the reconciliation contract');
  assert.match(openTrade, /mirrorPoller'\)\.cycle\(userId\)/, 'openTrade must force a mirror cycle');
  // It must be fire-and-forget: a reconciliation failure cannot turn a rejected order into a thrown
  // one, and it must not be awaited inside the catch that is already handling a failure.
  assert.equal(/await require\('\.\/mirrorPoller'\)\.cycle/.test(openTrade), false, 'must not be awaited');
  assert.match(openTrade, /forced_reconcile_after_open_failure/, 'the outcome must be reported, not just attempted');
  // And the failure must be CLASSIFIED at the point of failure, not re-derived later from prose.
  assert.match(openTrade, /classifyBridgeError\(e\)/);
});

test('BOTH paths record which side of the order failed', () => {
  // `order-health.js` groups failures by intent; before TRD-42 closes embedded "close: " in the
  // reason STRING, which is unqueryable, and the open path had no label at all.
  assert.match(openTrade, /intent: 'open'/);
  assert.match(closeTrade, /intent: 'close'/);
  assert.match(closeTrade, /NEEDS_RECONCILIATION\.has\(cls\)/, 'the TRD-42 close wiring must survive');
});

test('a failure that cannot have left a position does NOT reconcile', () => {
  // Reconciliation costs a page lock and a venue read. Firing it on every failure would make the
  // desk chattier for no benefit, so the contract is deliberately narrow: only classes where the
  // desk's belief and the venue's state may have DIVERGED.
  for (const text of [
    'page.goto: Timeout 45000ms exceeded',
    'set-limits field did not enable: #close-at-loss-rate',
    'instrument row not visible for Sugar (category page missing too)',
  ]) {
    const cls = classifyBridgeError(new Error(text));
    assert.equal(NEEDS_RECONCILIATION.has(cls), false, `${cls} must not trigger a reconcile: ${text}`);
  }
  // The two that must.
  for (const text of ['position row did not appear after submit', 'open position not found for Bitcoin buy']) {
    assert.ok(NEEDS_RECONCILIATION.has(classifyBridgeError(new Error(text))), text);
  }
});

// TRD-EXE-8 (2026-09-29) — the CLOSE path must not stamp `rejectReason` on a row that is already
// terminal. `closeTrade` guards `status !== 'open'` ONCE at the top, but the close it then authorises
// can occupy the bridge for a minute or more; a venue-side stop adopted by `venue-close-sync` inside
// that window is invisible to the in-flight attempt. Trades #1130 ended up carrying BOTH
// `status='closed'` (venue_rate / venue_ui_minute, adopted 14:30:11.793Z) AND
// `rejectReason='open position not found for Silver sell'` (written 14:31:47.430Z). Measured, this
// shape has 9 rows on the desk, the oldest being #22 — the row the code itself calls the
// "Bitcoin #22 incident".
test('the CLOSE path re-reads the row and does not stamp rejectReason on a terminal row', () => {
  assert.match(closeTrade, /const alreadyResolved = rowStatusAtFailure != null && rowStatusAtFailure !== 'open'/,
    'the close catch must decide from a FRESH read, not from the trade it was handed');
  // The write must be conditional. A `rejectReason` on a closed row asserts the order was rejected AND
  // that it closed at the venue — two contradictory machine-readable claims in one row.
  assert.match(closeTrade, /if \(!alreadyResolved\) \{\s*\n\s*try \{ await store\.updateTrade\(userId, trade\.id, \{ rejectReason:/,
    'the rejectReason write must be skipped when the row is already terminal');
  // But nothing may become unobservable: the journal event is still written, and now says what it saw.
  assert.match(closeTrade, /reason: 'close: ' \+ String\(e\.message \|\| e\)\.slice\(0, 200\)/);
  assert.match(closeTrade, /alreadyResolved, rowStatus: rowStatusAtFailure/,
    'the journal event must record whether the row was already resolved');
  // And it must NOT quietly change the event KIND. `order_rejected` feeds `maybeTripBreaker` and
  // self-health with no errorClass filter, so re-kinding a close-path `state_stale` is a risk-control
  // decision and must not ride along inside an inert fix.
  assert.match(closeTrade, /'order_rejected', \{/);
});
