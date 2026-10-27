'use strict';
// test/instrument-probe-verdict.test.js — 2026-10-27. What `ok` means for a probe run.
//
// ⚠ THE DEFECT THIS PINS. Both branches of `instrumentProbe.run()` emitted the literal `ok: true`. Measured
// 2026-10-27: the one scheduled refresh run reported `ok: true, rowsOnPage: 0, scanned: 0` and its caller — keying
// on `!!out` — reset the 23h throttle on the strength of it. A probe that read nothing suppressing its own retry.
//
// ⚠ BOTH DIRECTIONS ARE ASSERTED. A verdict that fails a blank page is cheap; one that also fails a legitimate
// plain page read would be the mirror defect and just as expensive, because the next reader would stop trusting it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { probeVerdict } = require('../trading/plus500/probeVerdict');

// --- the scan path ---------------------------------------------------------------------------
test('★ a scan that found no rows is NOT ok — the exact defect this replaced', () => {
  assert.deepStrictEqual(probeVerdict({ mode: 'scan', rowsOnPage: 0, scanned: 0, withSpec: 0 }),
    { ok: false, reason: 'no_rows' });
});

test('rows present but none walked is still not ok', () => {
  assert.deepStrictEqual(probeVerdict({ mode: 'scan', rowsOnPage: 6, scanned: 0, withSpec: 0 }),
    { ok: false, reason: 'no_rows_scanned' });
});

test('rows walked but no contract read is not ok', () => {
  assert.deepStrictEqual(probeVerdict({ mode: 'scan', rowsOnPage: 6, scanned: 6, withSpec: 0 }),
    { ok: false, reason: 'no_contract_read' });
});

test('an absent withSpec is not treated as a failure', () => {
  // A caller that has not computed the contract count must not be silently failed on it.
  assert.deepStrictEqual(probeVerdict({ mode: 'scan', rowsOnPage: 2, scanned: 2, withSpec: null }),
    { ok: true, reason: 'scanned' });
});

test('a real scan is ok', () => {
  assert.deepStrictEqual(probeVerdict({ mode: 'scan', rowsOnPage: 6, scanned: 6, withSpec: 4 }),
    { ok: true, reason: 'scanned' });
});

// --- the single-probe path -------------------------------------------------------------------
test('a page with no instrument table is not ok, whatever else came back', () => {
  assert.deepStrictEqual(probeVerdict({ mode: 'probe', tableFound: false, contractFound: true }),
    { ok: false, reason: 'no_table' });
});

test('a probe that was asked for a sidebar and got none is not ok', () => {
  assert.deepStrictEqual(probeVerdict({ mode: 'probe', tableFound: true, contractExpected: true, contractFound: false }),
    { ok: false, reason: 'no_contract' });
});

test('★ a PLAIN page read with a table is ok even with no sidebar open — the mirror defect', () => {
  // `contract` is null whenever the sidebar is collapsed, and the desk's own pollers rotate the page every 15-60s.
  // Judging a page-only read on `contract` would report a genuine success as a failure.
  assert.deepStrictEqual(probeVerdict({ mode: 'probe', tableFound: true, contractExpected: false, contractFound: false }),
    { ok: true, reason: 'page_only' });
});

test('a probe that got its sidebar is ok', () => {
  assert.deepStrictEqual(probeVerdict({ mode: 'probe', tableFound: true, contractExpected: true, contractFound: true }),
    { ok: true, reason: 'probed' });
});

test('an unrecognised mode is judged as a plain probe rather than silently passed', () => {
  // Fail-closed on the mode: a typo must not become a third path with no rules.
  assert.equal(probeVerdict({ mode: 'scna', tableFound: false }).ok, false);
});

// --- structural ------------------------------------------------------------------------------
test('the probe DELEGATES the verdict instead of hardcoding it — one call per branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'instrumentProbe.js'), 'utf8');
  assert.equal((src.match(/probeVerdict\(/g) || []).length, 2,
    'expected exactly two probeVerdict() calls (the scan branch and the single-probe branch); a different count means '
    + 'a path was added or removed without a verdict');
});

test('the verdict module is pure — no browser, no db, no fs', () => {
  const src = fs.readFileSync(require.resolve('../trading/plus500/probeVerdict'), 'utf8');
  // It must never grow a dependency on the live Chrome: that is the whole reason it is a separate module.
  assert.doesNotMatch(src, /require\(\s*['"][^'"]*(browser|mssql|store|db)['"]\s*\)/,
    'probeVerdict must stay pure, or it stops being testable without a live venue');
});
