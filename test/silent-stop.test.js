// test/silent-stop.test.js — TRD-OPS-1 (2026-10-01): an automatic stop must say so.
//
// THE GAP. `killswitch.setTier` takes `alert = false` BY DEFAULT, so a stop is silent unless the caller opts in.
// Auditing the six ways the desk can stop, two automatic ones never asked:
//   * `sim_disaster_floor` — a HARD kill, which blocks entries AND closes the book
//   * the UI Fallback Pause — no `telegramAlert` anywhere in plus500/health.js, and it LATCHES, so one bad poll
//     holds the desk down until a human resumes it
//
// ⚠ WHY THIS IS THE PRE-FLIGHT ITEM AND NOT A NICETY. Everything else in this workstream is the desk doing the
// wrong thing. This is the desk doing NOTHING, quietly, for as long as nobody looks — and over an unattended run
// that is the failure with the worst ratio of harm to detectability. A quiet stop is the one that lasts.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('★ the default is now the SAFE one — the gap this file was written for is closed', () => {
  const ks = code('trading/agent/killswitch.js');
  // ⚠ THIS TEST ORIGINALLY ASSERTED `alert = false` WAS STILL THE DEFAULT — it documented the gap. TRD-OPS-2 closed
  // it, so the pin now asserts the FIX, and the old assertion is asserted ABSENT. Fourth time this session a test
  // had to be updated because it pinned the state being corrected; the lesson is that a pin is a snapshot, and a
  // snapshot of a defect is a defect with a green tick next to it.
  assert.match(ks, /alert = null/, 'the omitted flag must default to null so it stays distinguishable from false');
  assert.match(ks, /resolveAlert/, 'and a rule must decide, following resolveAutoClose in the same file');
  assert.ok(!/alert = false/.test(ks), 'the old silent default must not come back');
});

test('★★ an automatic HARD stop alerts', () => {
  const wp = code('trading/agent/wakePipeline.js');
  assert.match(wp, /reason: 'sim_disaster_floor', alert: true/,
    'the sim disaster floor blocks entries AND closes the book; it must not do so silently');
});

test('★★ the UI Fallback Pause alerts, and plus500/health.js now has an alert path at all', () => {
  const h = code('trading/plus500/health.js');
  assert.match(h, /function alertOnPause/, 'the pause must have a way to say so');
  assert.match(h, /telegramAlert/, 'and it must actually reach Telegram — the file had NO alert before this');
});

test('★ the pause alerts ON THE TRANSITION, not on every failed poll', () => {
  const h = code('trading/plus500/health.js');
  // ⚠ A NOISY ALERT IS ONE THAT STOPS BEING READ, which is how the original silence would return by a different
  // route. Both writers of `paused` must pass the PREVIOUS state, and the helper must return early when it was
  // already paused.
  // ⚠ THE RULE IS UNCHANGED; THE SHAPE MOVED (2026-10-27) so the decision could be tested without Telegram.
  // `pauseAlertVerdict` is pure and `alertOnPause` only sends what the verdict returns. The behavioural cases —
  // silent for the first hour of a held pause, one page at the hour, silent again afterwards — live in
  // `test/pause-alert-verdict.test.js`. This test only proves the helper still CONSULTS that verdict rather than
  // growing a second copy of the rule.
  assert.match(h, /function pauseAlertVerdict\(/, 'the alert decision must be a pure, testable verdict');
  assert.match(h, /const verdict = pauseAlertVerdict\(/, 'alertOnPause must consult the verdict, not re-derive it');
  assert.match(h, /const wasPaused = !!bridge\.paused;/, 'checkAndGate must capture the previous state');
  assert.match(h, /alertOnPause\(\{ wasPaused/, 'both writers must pass the previous state in');
});

test('★ BOTH writers of `paused` are covered — not just the obvious one', () => {
  const h = code('trading/plus500/health.js');
  const calls = h.match(/alertOnPause\(/g) || [];
  // one helper definition + one call per writer. There are TWO writers (`checkAndGate` and
  // `recordConnectionFailure`) and patching one of two is the exact incompleteness that the account-event
  // dual-writer bug produced earlier in this workstream.
  assert.ok(calls.length >= 3, `both writers must call the helper (found ${calls.length} occurrences)`);
});

test('a failed alert never turns a pause into a crash', () => {
  // ⚠ read the RAW file: `code()` strips comments, and the thing being asserted IS the comment's presence —
  // a silent `catch {}` would be indistinguishable from a deliberate one without it.
  const raw = fs.readFileSync(path.join(ROOT, 'trading/plus500/health.js'), 'utf8');
  // ⚠ THE PAUSE IS THE SAFETY BEHAVIOUR; the alert is the courtesy. Wrapping it the wrong way round would make
  // Telegram an availability dependency of the desk's safety control. The comment may be a block or a line comment —
  // what is asserted is that a REASON is written down, so a silent `catch {}` stays distinguishable from a
  // deliberate one.
  assert.match(raw, /catch \{\s*(\/\*|\/\/)\s*telegram is optional/,
    'the alert must be wrapped in a try/catch that says why swallowing is correct');
});
