// test/account-strip-cadence.test.js — TRD-70, 2026-09-14.
//
// The owner asked why the "live demo strip" number had stopped updating every second. Measured:
// it never did. The poller loop was
//
//     await pollOnce(userId);                          // TWO CDP round-trips
//     await sleep(secs * 1000);                        // secs = 1
//
// so the real period was `1s + work`. Sampling GET /api/trading/account once a second for 20s,
// `live.readAt` advanced only NINE times — mean interval 2.4s, stalls to ~6s — while the config
// said `pollSeconds = 1`, the poller header claimed "default 30", and the chart comment claimed
// "live reads normally land every 1s". Three different statements, none matching the code.
//
// There was a second defect behind the first. `live` is only assigned on an ACCEPTED sample, so
// `live.readAt` means "last plausible value" — but the panel read it as "last time we read". A
// stretch of rejected transitional frames therefore froze the number while the poller was reading
// perfectly well, and NOTHING distinguished that from a dead feed. The rejected frame is real and
// the guard is right to refuse it (pnl 0 with equity ≈ prev.equity − prev.pnl); what was wrong is
// that the desk knew and could not say so.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code, read } = require('./_source');
const poller = require('../trading/agent/accountPoller');

// --- the fixed-rate arithmetic ------------------------------------------------

test('★ the period is measured from the START of the cycle, not appended to it', () => {
  // 1s period, 1400ms of work (the measured average) => sleep the REMAINDER, not a full second.
  assert.strictEqual(poller.nextDelayMs(1000, 1400), 0);
  assert.strictEqual(poller.nextDelayMs(1000, 400), 600);
  assert.strictEqual(poller.nextDelayMs(1000, 0), 1000);
});

test('a cycle slower than its period does not accumulate a backlog', () => {
  // Otherwise a permanently slow read would drift further behind with every iteration.
  assert.strictEqual(poller.nextDelayMs(1000, 5000), 0);
});

test('the delay is never negative and never NaN', () => {
  assert.ok(poller.nextDelayMs(1000, 999999) >= 0);
  assert.strictEqual(poller.nextDelayMs(NaN, 100), 0, 'an unusable period must not produce NaN sleep');
  assert.strictEqual(poller.nextDelayMs(1000, NaN), 1000, 'an unmeasurable work time falls back to the full period');
});

// --- read-time vs accepted-value ---------------------------------------------

test('getLive() exposes the read clock, not just the accepted-value clock', () => {
  const live = poller.getLive();
  const status = poller.getStatus();
  // Before any read the poller must say nothing at all rather than invent a value.
  if (live === null) {
    assert.strictEqual(status.lastReadAt, null, 'no read has happened, so lastReadAt must be null too');
    return;
  }
  assert.ok('lastReadAt' in live, 'lastReadAt must travel with the live value');
  assert.ok('rejectedStreak' in live, 'the rejection streak must travel with it too');
});

test('the status object names both clocks', () => {
  const s = poller.getStatus();
  assert.ok('lastReadAt' in s, 'when we READ');
  assert.ok('acceptedAt' in s, 'when we last ACCEPTED');
  assert.ok('rejectedStreak' in s);
  assert.ok('lastRejectAt' in s);
  assert.ok('lastRejectedValue' in s, 'the rejected payload is kept for diagnosis');
});

// --- the ordering that makes the distinction possible ------------------------

// SCOPE MATTERS HERE. `isPlausibleSample` is called in TWO places — `acceptSample` (the
// capture-side path) and `pollOnce` — and acceptSample comes FIRST in the file. A bare
// indexOf('if (!isPlausibleSample...') therefore finds the wrong one and the assertion fails on
// correct code. (It did, on the first run.) Everything below is scoped to pollOnce.
const pollerSrc = code('trading/agent/accountPoller.js');
const pollOnceSrc = pollerSrc.slice(
  pollerSrc.indexOf('async function pollOnce'),
  pollerSrc.indexOf('function nextDelayMs'),
);

test('the pollOnce slice is real (guards every assertion below against a silent empty slice)', () => {
  assert.ok(pollOnceSrc.length > 500, 'the pollOnce slice must not be empty');
  assert.match(pollOnceSrc, /async function pollOnce/);
  assert.ok(!/function nextDelayMs/.test(pollOnceSrc), 'the slice must stop before nextDelayMs');
});

test('★ lastReadAt is stamped BEFORE the plausibility check, or the distinction is lost', () => {
  const stampAt = pollOnceSrc.indexOf('status.lastReadAt = new Date().toISOString()');
  const guardAt = pollOnceSrc.indexOf('if (!isPlausibleSample(acc, lastAccepted))');
  assert.ok(stampAt > -1, 'the read clock must be stamped');
  assert.ok(guardAt > -1, 'the flicker guard must still be present');
  assert.ok(stampAt < guardAt,
    'stamping it AFTER the guard would re-create the bug: a rejection would leave no trace of the read');
});

test('a rejected sample still does NOT set live — the value is genuinely unreliable', () => {
  const guardAt = pollOnceSrc.indexOf('if (!isPlausibleSample(acc, lastAccepted))');
  const liveAt = pollOnceSrc.indexOf('live = { ...acc, readAt:');
  assert.ok(guardAt > -1 && liveAt > guardAt,
    'live must be assigned only past the guard, otherwise a transitional frame reaches the curve');
});

test('a rejection streak is recorded, and its length is carried in the reason', () => {
  assert.match(pollOnceSrc, /status\.rejectedStreak = rejected/, 'the streak must be tracked');
  assert.match(pollOnceSrc, /streak: rejected/, 'the telemetry row must carry the streak length');
});

test('★ a sustained streak stays visible instead of one row at its start', () => {
  assert.match(pollOnceSrc, /REJECT_LOG_EVERY/, 'the first-rejection-only rule hid long streaks');
  assert.match(pollOnceSrc, /rejected % REJECT_LOG_EVERY === 0/, 'a long streak must keep reporting');
});

test('recovery is logged, so the duration of a flicker is readable', () => {
  assert.match(pollOnceSrc, /account_sample_recovered/, 'without this a reader cannot tell how long it lasted');
});

// --- the UI must tell the two conditions apart --------------------------------

const app = code('trading/public/js/app.js');

test('★ the panel distinguishes "reading but rejecting" from "not reading"', () => {
  assert.match(app, /const readAgeMs = d\.live && d\.live\.lastReadAt/, 'the UI must read the read clock');
  assert.match(app, /reading && liveAgeMs > 15000/, 'reading + old value is its own condition');
  assert.match(app, /reading · rejected/, 'and it must be NAMED, not shown as stale');
});

test('an unreadable strip still reports stale — the fix must not mask a dead feed', () => {
  assert.match(app, /liveAgeMs > 90000[\s\S]{0,120}chip\('stale'/,
    'a genuinely stale read must still surface as stale');
});

test('the chart only pushes an ACCEPTED, fresh value', () => {
  // The gate that stops a fabricated point on the curve must survive the change.
  assert.match(app, /if \(liveAgeMs <= 15000 && d\.live\.equity != null\) pushEquityTick\(d\.live\.equity\)/);
});

test('the panel shows a live AGE rather than promising a cadence', () => {
  const html = read('trading/public/index.html');
  assert.match(html, /id="eq-age"/, 'the age readout must exist');
  assert.match(app, /\$\('eq-age'\)/, 'and the app must populate it');
});

test('the stale cadence claims are corrected rather than repeated', () => {
  // NOTE: asserting the STRING "default 30" is absent would fail, because the corrected header
  // quotes the old claim to explain it. Assert the substance instead: the code's real default is
  // 1s, and the header now states the measured behaviour.
  const p = read('trading/agent/accountPoller.js');
  assert.match(code('trading/agent/accountPoller.js'), /Math\.max\(1, Number\(cfg\.pollSeconds\) \|\| 1\)/,
    'the code default is 1s and must stay visible');
  assert.match(p, /MEASURED 2026-09-14/, 'the header must carry the measurement');
  assert.match(p, /mean 2\.4s/, 'including the number that made the 1s claim false');
  assert.ok(!/live reads normally land every 1s/.test(app), 'the chart claimed a 1s cadence the loop could not deliver');
});
