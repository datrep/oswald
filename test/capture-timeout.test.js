// TRD-EXE-16 (#1504, 2026-10-02): a capture that cannot return must FAIL NAMED, not hang forever.
// The measured case: a half-dead CDP session where page.evaluate never settles held pageLock for ~8-9 minutes
// (twice). The fix: a 90 s race → named `capture_timeout` error, the wedged page discarded, the lock released.
// ★ 2026-10-05 (#1511): the discard became a TAB SWAP — TRD-EXE-16's page.close() hit the bridge tab, which is
// normally Chrome's ONLY tab, so every wedged sweep EXITED Chrome. Fresh tab first, close second, never the last.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { withTimeout, CAPTURE_HARD_TIMEOUT_MS } = require('../trading/plus500/capture');

test('withTimeout passes a normal result through', async () => {
  const r = await withTimeout(Promise.resolve('ok'), 1000, 't');
  assert.equal(r, 'ok');
});

test('★ a promise that NEVER settles rejects with a NAMED, countable error', async () => {
  const never = new Promise(() => {});
  await assert.rejects(() => withTimeout(never, 60, 'capture'), (e) => {
    assert.equal(e.captureTimeout, true, 'flag set for the catch branch');
    assert.match(e.message, /capture_timeout: no return within 60ms/);
    assert.match(e.message, /TRD-EXE-16/);
    return true;
  });
});

test('the write path wraps the steps, discards the wedged page, and cannot leak the lock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'capture.js'), 'utf8');
  // 2026-10-18: the race may hand its result to a local (`const result = await withTimeout(...)`) because
  // the chart rotation now runs AFTER the quote race on its own budget — the invariant is that the steps run
  // under the race and the race is awaited, not that the return is literal.
  assert.match(src, /await withTimeout\(\(async \(\) => \{/, 'the steps run under the race');
  assert.match(src, /CAPTURE_HARD_TIMEOUT_MS, 'capture'\);/, 'closed with the named constant');
  assert.match(src, /if \(e && e\.captureTimeout\) \{/, 'the named branch exists');
  // ★ 2026-10-05 (#1511): the discard must NEVER close Chrome's last tab. A bare page.close() here exited
  // Chrome (the shared bridge tab is normally the only tab) — measured: 17 desk-caused Chrome exits.
  assert.doesNotMatch(src, /if \(page\) page\.close\(\)\.catch\(\(\) => \{\}\)/, 'no bare close of the shared page');
  assert.match(src, /wedged page recycled via tab swap/, 'the swap path exists');
  assert.match(src, /ctx\.newPage\(\)/, 'a fresh tab is opened before anything is closed');
  assert.match(src, /closing NOTHING \(a dead Chrome is worse than a wedged page\)/, 'fallback: nothing is closed when the swap cannot start');
  assert.match(src, /require\('\.\/pageLock'\)\.release\('capture'\)/, 'release stays in finally — a timeout cannot leak the lock');
  assert.equal(CAPTURE_HARD_TIMEOUT_MS, 90000, '90 s, ~5x the worst healthy capture (lock waits are reported separately)');
});
