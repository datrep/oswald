// test/page-lock.test.js — bridge tab mutual exclusion (2026-09-11 Oil ticket
// incident: the mirror navigated the shared tab mid set-limits and the entry
// never placed). Pins the lock semantics that keep flows serialized.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const lock = require('../trading/plus500/pageLock');

test('tryAcquire is exclusive; only the owner can release', () => {
  assert.strictEqual(lock.tryAcquire('mirror'), true);
  assert.strictEqual(lock.tryAcquire('ticket'), false);
  assert.strictEqual(lock.held(), true);
  assert.strictEqual(lock.status().holder, 'mirror');
  lock.release('ticket'); // wrong owner: no-op
  assert.strictEqual(lock.status().holder, 'mirror');
  lock.release('mirror');
  assert.strictEqual(lock.held(), false);
  assert.strictEqual(lock.tryAcquire('ticket'), true);
  lock.release('ticket');
});

test('acquire waits for the holder to release, then claims', async () => {
  assert.strictEqual(lock.tryAcquire('mirror'), true);
  const wait = lock.acquire('ticket', { waitMs: 5000 });
  setTimeout(() => lock.release('mirror'), 300);
  const r = await wait;
  assert.ok(r.waitedMs >= 250, `waited ${r.waitedMs}ms`);
  assert.strictEqual(lock.status().holder, 'ticket');
  lock.release('ticket');
});

test('acquire times out instead of hanging forever', async () => {
  assert.strictEqual(lock.tryAcquire('ticket'), true);
  await assert.rejects(() => lock.acquire('capture', { waitMs: 250 }), /bridge busy \(ticket\)/);
  lock.release('ticket');
  assert.strictEqual(lock.held(), false);
});

// --- TRD-83 (2026-09-19): the lock reports WHO it waited behind -----------------
//
// The wake record showed `capture 121325ms` (100x every other step) and was read as "the capture is slow".
// 120 of those seconds are this lock, and the holder is the only actionable part of that number: waiting
// 120s behind a `ticket` is correct back-pressure, waiting it behind a stuck reload is a defect.

test('acquire reports the wait AND the holder it waited on', async () => {
  assert.strictEqual(lock.tryAcquire('ticket'), true);
  const wait = lock.acquire('capture', { waitMs: 5000 });
  setTimeout(() => lock.release('ticket'), 300);
  const r = await wait;
  assert.ok(r.waitedMs >= 250, `waited ${r.waitedMs}ms`);
  assert.deepStrictEqual(r.waitedOn, ['ticket']);
  lock.release('capture');
});

test('an uncontended acquire waited on nobody', async () => {
  const r = await lock.acquire('capture', { waitMs: 1000 });
  assert.deepStrictEqual(r.waitedOn, [], 'an empty list says "we never actually waited", not "unknown"');
  lock.release('capture');
});

test('a timeout still names the holder', async () => {
  assert.strictEqual(lock.tryAcquire('maintenance'), true);
  await assert.rejects(() => lock.acquire('capture', { waitMs: 200 }), /bridge busy \(maintenance\)/);
  lock.release('maintenance');
  assert.strictEqual(lock.held(), false);
});

test('the capture records its own wait instead of leaving it inside the step duration', () => {
  const src = code('trading/plus500/capture.js');
  assert.match(src, /capture_lock_wait/);
  assert.match(src, /lockWaitMs >= CAPTURE_LOCK_REPORT_MS/);
  assert.match(src, /waitedOn: \(lock && lock\.waitedOn\) \|\| \[\]/,
    'the event must name the holder — a duration with no holder is the number that was already there');
});
