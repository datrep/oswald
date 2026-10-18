// test/wake-failure-row.test.js — TRD-51 fix 1, 2026-09-14.
//
// THE DEFECT: the wake list is built from TradingPrompts rows, and a wake that threw before
// deliberation wrote NOTHING to that table. So the operator surface could not represent a
// failed wake at all — it rendered an outage as silence.
//
// Measured 2026-09-14, 09:37:45 -> 13:05:38 SGT: eight scheduled wakes died at the `bars_build`
// step, every one `{"error":"Timeout: Request failed to complete in 15000ms","code":"ETIMEOUT"}`.
// TradingPrompts rows written in that window: ZERO. The owner saw wake rows at 09:01:04 and
// 13:20:14 with a 4h19m hole between them and asked "wait.. what?".
//
// WHY A TRADINGPROMPTS ROW AND NOT A NEW SURFACE: `llmCalled: false` is already the established
// convention for a prompt row that never reached the model — the no-proposal committee skip and
// the kill-switch row both use it. A failed wake joins the SAME stream the UI already reads, in
// time order, so the fix needs no second list and no join.
//
// The catch block cannot be exercised without a full wake (bridge, DB, LLM), so the WRITER is
// pinned structurally and the RENDERER is pinned by simulating its decision logic. The structural
// half uses test/_source.js for the CRLF-safe comment strip — a naive strip matches nothing on
// this repo's CRLF sources and would make these assertions pass on the comments alone.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code, read } = require('./_source');

// --- the writer: wakePipeline's failure path --------------------------------

const pipeline = code('trading/agent/wakePipeline.js');

test('TRD-51: a failed wake writes a prompt row (the thing the list actually reads)', () => {
  assert.match(pipeline, /createPrompt\(/,
    'the failure path must write a TradingPrompts row — without it the wake is invisible');
  assert.match(pipeline, /failed:\s*true/,
    'the row must be flagged failed so the renderer can tell it apart from a quiet wake');
});

test('TRD-51: the failure row names the failing step and keeps the error text', () => {
  assert.match(pipeline, /failedStep/, 'the failing step must be recorded — "wake failed" alone is not actionable');
  assert.match(pipeline, /failedStepMs/, 'how long the step ran before it died is the difference between slow and hung');
  assert.match(pipeline, /failingStep\(\)/, 'the step name must come from the step records, not be guessed');
});

test('TRD-51: the failure row is marked as never having reached the model', () => {
  assert.match(pipeline, /llmCalled:\s*false/,
    'llmCalled:false is the existing convention for "no LLM call" — reuse it so the UI logic is unchanged');
});

test('TRD-51: writing the failure row cannot lose or mask the original error', () => {
  // If the DB is what broke, the failure row's own insert fails too. The original error must
  // survive (it is already assigned to `outcome`) and the second failure is logged separately.
  assert.match(pipeline, /wake_failure_row/,
    'a failure to WRITE the failure row must be logged under its own name, not thrown');
  assert.match(pipeline, /outcome\s*=\s*\{\s*error:/,
    'the original error must be captured before the row is attempted');
});

test('TRD-51: a failed wake also writes a wake EVENT carrying failed:true', () => {
  // The event is the second, independent surface (the events tab / DB forensics). The original
  // code logged only an `error` event, so a reader had to know the ETIMEOUT string to find it.
  assert.match(pipeline, /logEvent\(userId,\s*'wake'/);
  assert.match(pipeline, /failed:\s*true/);
});

test('TRD-51: finishWake is told the wake failed, so the success clock is not advanced', () => {
  assert.match(pipeline, /finishWake\(outcome,\s*\{\s*failed\s*\}\)/,
    'finishWake must receive the failure flag — otherwise lastSuccessAt advances on a dead wake');
});

test('TRD-51: a SUCCESSFUL wake is still not marked failed', () => {
  // The success path must pass no failure flag. `outcome = await body()` is the only assignment
  // outside the catch, so `failed` must still be false there.
  assert.match(pipeline, /let failed = false;/, 'failed starts false');
  assert.match(pipeline, /outcome = await body\(\)/, 'the success path is unchanged');
});

// --- the renderer: trading/public/js/app.js ---------------------------------

const app = code('trading/public/js/app.js');

test('TRD-51: the wake list renders a FAILED row rather than the generic fallback', () => {
  assert.match(app, /dec\.failed === true/, 'the renderer must look for the failed flag');
  assert.match(app, /chip rejected">FAILED</, 'a failed wake must be a visible red FAILED chip');
});

test('TRD-51: a FAILED wake is never collapsed as a quiet wake', () => {
  // A failure has zero acted signals and zero signals, so `quiet` was true and the row started
  // COLLAPSED — the fix would have been invisible. This is the assertion that keeps it visible.
  assert.match(app, /const quiet = !failed && actedCount === 0 && sigCount === 0;/,
    'quiet must exclude failures, or the failed row renders collapsed and the defect survives the fix');
});

test('TRD-51: the collapsed-by-default rule still applies to genuinely quiet wakes', () => {
  // The 2026-09-12 owner ask ("too big for the amount of data shown") must not be undone.
  assert.match(app, /data-quiet="\$\{quiet \? 1 : 0\}"/);
  assert.match(app, /setOpen\(head\.dataset\.quiet !== '1'\)/);
});

test('TRD-51: the failure row shows the step, the duration and the error', () => {
  assert.match(app, /dec\.failedStepMs/, 'the renderer must surface how long the step ran');
  assert.match(app, /dec\.error \|\| dec\.reason/, 'the error text must be rendered, not just the word FAILED');
});

test('TRD-51: a failed wake is tinted at row level, not only chipped', () => {
  const html = read('trading/public/index.html');
  assert.match(html, /tr\.wake-failed > td/, 'a chip alone can be scrolled past; the row is tinted');
});

// --- cross-check: the flag the writer sets is the flag the reader looks for ---

test('TRD-51: writer and renderer agree on the field names', () => {
  for (const field of ['failed', 'failedStep']) {
    assert.match(pipeline, new RegExp(`${field}:`), `wakePipeline must set ${field}`);
    assert.match(app, new RegExp(`dec\\.${field}`), `the renderer must read dec.${field}`);
  }
});

test('TRD-51: the CRLF comment stripper is not a silent no-op on these files', () => {
  // Guards the guard. If the strip silently failed, every negative assertion above would be
  // testing prose instead of code — the failure mode that made this helper necessary.
  assert.ok(!app.includes('// '), 'the stripped app.js still contains a // comment — the stripper no-opped');
  assert.ok(!pipeline.includes('// '), 'the stripped wakePipeline.js still contains a // comment');
});
