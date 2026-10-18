// test/rotation-backoff.test.js — 2026-10-18 (feature capture-rotation-backoff): the rotation must stop
// paying a full budget for a venue that banks nothing, and it must come back on its own. Source pins,
// because the decision lives inline in captureOnce (browser-bound); the invariants are structural:
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'capture.js'), 'utf8');

test('backoff constants exist and are small enough to recover fast', () => {
  const m1 = src.match(/const CHART_ZERO_STREAK_LIMIT = (\d+);/);
  const m2 = src.match(/const CHART_SKIP_WAKES = (\d+);/);
  assert.ok(m1, 'the streak limit constant exists');
  assert.ok(m2, 'the skip length constant exists');
  assert.ok(Number(m1[1]) >= 2, 'one zero-bank rotation is not enough evidence — a flake must not engage the backoff');
  assert.ok(Number(m2[1]) <= 3, 'the skip must be short: a reopen has to be picked up within ~20-30 min');
});

test('a skip DECREMENTS rather than resetting, and the attempt path is the only place that runs charts', () => {
  assert.match(src, /if \(chartSkipWakes > 0\) \{[\s\S]{0,400}?chartSkipWakes -= 1;/, 'skip path decrements');
  // The chart visit must sit inside the else branch — otherwise a "skip" wake would still navigate.
  const skipAt = src.indexOf('if (chartSkipWakes > 0) {');
  const attemptAt = src.indexOf('captureBySearch(userId, settings, page, { chartsOnly: true, only: slice })');
  assert.ok(skipAt > -1 && attemptAt > skipAt, 'the chart attempt lives AFTER (inside) the skip decision');
});

test('a banking rotation clears the streak, and the resume is logged exactly once per streak', () => {
  // 900 chars: the resume-event note string sits between the branch and the reset, so the window must cover
  // prose as well as code (measured — 400 truncated inside the note on the first run of this pin).
  assert.match(src, /if \(bars > 0\) \{[\s\S]{0,900}?chartZeroStreak = 0;/, 'a banked rotation clears the streak');
  assert.match(src, /if \(chartZeroStreak >= CHART_ZERO_STREAK_LIMIT\) \{[\s\S]{0,400}?resumed: true/, 'resume event fires only after a streak');
  assert.match(src, /zeroStreak: chartZeroStreak, skipNextWakes: chartSkipWakes/, 'the zero-bank event carries the state, so it is visible not inferred');
});

test('the backoff never touches the quote path', () => {
  // Quotes are what the wake cannot live without; the backoff is downstream of them in captureOnce.
  const quotesAt = src.indexOf('const q = await captureQuotesFromWatchlist(');
  const skipAt = src.indexOf('if (chartSkipWakes > 0) {');
  assert.ok(quotesAt > -1 && skipAt > quotesAt, 'quotes are captured before any rotation decision');
});
