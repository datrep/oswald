// test/hrefmap-noise.test.js — 4.11 (2026-10-03): the hrefMap journal churn.
//
// THE DEFECT: `readHrefMap` stamps `at` fresh on every read, and the capture guard compared
// `JSON.stringify({at, hrefs})` — so `prev !== next` was ALWAYS true and a saveSettings + href_map
// telemetry fired every wake. Measured 2026-10-03: 313 of 410 `settings_write` rows in 72 h (76%)
// were `bridge.hrefMap.at`-only, burying ~32/day of REAL settings changes.
//
// THE PINS: (1) the pure guard ignores the stamp and fires on content only; (2) the capture block
// actually USES it (the old always-true full-JSON compare must not return).
//
// Run with: npm run test:unit  (or: node --test test/hrefmap-noise.test.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { code } = require('./_source');
const { hrefMapChanged } = require('../trading/plus500/capture');

test('hrefMapChanged — stamp-only differences do NOT save; content differences DO', () => {
  assert.equal(hrefMapChanged({ at: 'T1', hrefs: ['a', 'b'] }, ['a', 'b']), false, 'equal hrefs, different at -> no save');
  assert.equal(hrefMapChanged({ at: 'T2', hrefs: ['a', 'b'] }, ['a', 'b']), false, 'the stamp must never drive a save');
  assert.equal(hrefMapChanged({ at: 'T1', hrefs: ['a', 'b'] }, ['a', 'c']), true, 'hrefs changed -> save');
  assert.equal(hrefMapChanged({}, []), false, 'absent stored map + empty next = no change');
  assert.equal(hrefMapChanged(undefined, []), false);
  assert.equal(hrefMapChanged({ hrefs: ['a'] }, []), true, 'hrefs lost -> save (the map shrank)');
  assert.equal(hrefMapChanged({ hrefs: [] }, ['a']), true);
});

test('the capture guard compares CONTENT — the always-true {at,hrefs} compare must not return', () => {
  const capture = code('trading/plus500/capture.js').replace(/\r\n/g, '\n');
  assert.match(capture, /hrefMapChanged\(\(settings\.bridge \|\| \{\}\)\.hrefMap, map\.hrefs\)/, 'the guard must use the content-only helper');
  assert.doesNotMatch(capture, /JSON\.stringify\(\{\s*at: map\.at/, 'the full-JSON {at,hrefs} guard must not return');
});
