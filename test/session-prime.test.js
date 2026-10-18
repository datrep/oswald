// test/session-prime.test.js — TRD-EXE-16 (2026-10-01): supply the session EVIDENCE, do not lower the standard.
//
// THE PROBLEM. The session feed's only rich source is `OPositionsList` — the desk's OWN open positions — so
// `feed.isOpen(symbol)` is `null` for every instrument the desk does not already hold. `feedUsable` requires a
// NON-EMPTY registry, so the moment the desk holds anything the gate arms and refuses every candidate outside the
// book. Measured 2026-10-01: with Silver/Bitcoin/Arabica/Gold held, Oil and Sugar were refused at 00:32:58,
// 00:40:33/36/47 and 00:44:35, while the same call on Gold — held — passed in the same minute.
//
// WHAT I ALMOST DID, AND WHY THIS FILE EXISTS. I first relaxed the gate to block only on a positive CLOSED.
// `test/venue-session-guard.test.js` documents that "unknown -> allow" WAS the original defect — an owner-raised
// incident ("it is buying Arabica Coffee even though the market is closed") whose measurement was: every submit
// for a HELD symbol succeeded, every submit for a symbol with NO position failed `ambiguous` after ~45s
// (Arabica x4, Sugar x3), each leaving a venue order the desk could not see. My case for relaxing had ZERO
// measured occurrences of an entry actually lost. A story is not evidence.
//
// SO THE FIX SUPPLIES THE EVIDENCE. The venue publishes a session on `SingleTradeInstrument` whenever the page
// FOCUSES an instrument, and the harvest already reads that payload. Focusing is navigation only.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const WEB = 'trading/plus500/webtrader.js';
const CONN = 'trading/connector/browser.js';
const EXEC = 'trading/agent/executor.js';

const fnSlice = (src, name) => {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name} must exist`);
  // to the next top-level boundary. ⚠ `module.exports` IS a boundary and must be listed: without it a function
  // declared immediately above the export block slices to END OF FILE, and the "must not touch placeOrder"
  // assertion below then fails on the export LIST rather than on the body — which is a test bug, not a finding.
  const cuts = ['\nasync function ', '\nfunction ', '\nmodule.exports']
    .map((m) => src.indexOf(m, start + 10)).filter((i) => i > start);
  return src.slice(start, cuts.length ? Math.min(...cuts) : undefined);
};

test('★★ the guard STILL demands a positive verdict — the relaxation is refused, on the record', () => {
  const exec = code(EXEC);
  // two occurrences now: the probe is entered only when the verdict is not true, and the block is entered again
  // if it is STILL not true after the probe. Both must demand `true`.
  const gate = exec.match(/feedUsable && feed\.isOpen\(symbol\) !== true/g) || [];
  assert.ok(gate.length >= 2, `the gate must be asked both before AND after the probe (found ${gate.length})`);
  assert.match(exec, /reason: 'venue_session_unconfirmed'/,
    'the original refusal must survive; relaxing it was measured against and rejected');
});

test('the probe runs BEFORE the refusal, and the refusal before the order', () => {
  const exec = code(EXEC);
  const fn = exec.indexOf('async function openTrade');
  assert.ok(fn > -1);
  const probe = exec.indexOf('session_probe', fn);
  const block = exec.indexOf("reason: 'venue_session_unconfirmed'", fn);
  const send = exec.indexOf('connector.placeOrder(', fn);
  assert.ok(probe > -1 && block > -1 && send > -1);
  assert.ok(probe < block, 'the probe is only useful if it runs before the decision it informs');
  assert.ok(block < send, 'the guard must still precede placeOrder');
});

test('the probe is NAVIGATION ONLY — it must not touch the ticket', () => {
  const body = fnSlice(code(WEB), 'probeSession');
  assert.match(body, /openInstrument\(page, settings, symbol\)/, 'it focuses the instrument');
  // ⚠ THE WHOLE SAFETY ARGUMENT. If the probe can write a size, a level or click Buy/Sell, it is an ORDER path
  // with none of an order path's safeguards (reliability wrapper, journal, unresolved-submit guard).
  for (const forbidden of ['placeOrder', 'fillPips', '#amount-input', 'button-buy', 'button-sell', 'fillRate']) {
    assert.ok(!body.includes(forbidden), `probeSession must NOT touch ${forbidden}`);
  }
});

test('★ the probe is FAIL-OPEN, and confirms it actually LANDED', () => {
  const body = fnSlice(code(WEB), 'probeSession');
  assert.match(body, /catch \(err\)/, 'a throwing probe would turn a coverage gap into a failed order path');
  assert.match(body, /focused: false/, 'failure is reported, not thrown');
  // ⚠ WITHOUT THE TITLE CHECK a probe that silently did nothing is indistinguishable from one that landed, and the
  // caller then reads a STALE session with fresh confidence — the exact defect class this row exists to remove.
  assert.match(body, /readChartTitle/, 'the landing must be confirmed from the page, not assumed');
  assert.match(body, /title_mismatch/, 'and a mismatch is named rather than treated as success');
});

test('★ the probe must NOT go through the order-reliability wrapper', () => {
  const body = fnSlice(code(CONN), 'probeSession');
  // `withOrderReliability` journals attempts and feeds the unresolved-submit retry guard, which exists for
  // ORDERS (TRD-EXE-1: one unresolved submit per symbol). A navigation recorded as an order attempt would
  // corrupt that guard and could block a real entry later.
  assert.ok(!body.includes('withOrderReliability'),
    'a probe is not an order; routing it through the order wrapper corrupts the retry guard');
  assert.match(body, /demoPage\(settings\)/, 'it follows the getPositions shape: demoPage + a read');
  assert.ok(!body.includes('disconnect()'), 'SHARED-BRIDGE RULE: never disconnect the shared page');
});

test('the probe is kill-switchable without a code change', () => {
  const exec = code(EXEC);
  // ⚠ ABSENT MEANS ENABLED, and that is deliberate: the default direction of failure here is a wasted
  // navigation, not a bad order. Only an explicit `false` restores the pre-EXE-16 behaviour, so a settings row
  // written for any other reason cannot silently switch it off.
  assert.match(exec, /settings\.risk\.sessionPrime === false/,
    'only an explicit false may disable it — absent must mean enabled');
  assert.match(exec, /else primeNote = 'disabled'/, 'and the disabled path must be recorded, not silent');
});

test('the refresh is BOUNDED — it polls the feed, it does not wait forever', () => {
  const exec = code(EXEC);
  assert.match(exec, /for \(let i = 0; i < \d+ && feed\.isOpen\(symbol\) !== true; i\+\+\)/,
    'the wait must stop as soon as the verdict arrives, and must have a ceiling');
  assert.match(exec, /setTimeout\(r, \d+\)/, 'and it yields between polls');
});

test('the outcome is RECORDED either way', () => {
  const exec = code(EXEC);
  assert.match(exec, /'session_probe'/, 'a probe that ran and did not help must be visible, not silent');
  assert.match(exec, /sessionProbe: primeNote/, 'and the refusal carries why the probe did not resolve it');
});
