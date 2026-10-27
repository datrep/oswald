// test/account-reset-ledger.test.js — 2026-10-26.
//
// A demo reset to 4,000 happened on 2026-10-16 and NOTHING recorded it. Reconstructing the boundary by eye cost
// two wrong readings in a row: a "+$45 over two weeks" that averaged across two account lives, and a post-reset
// window that swallowed two pre-reset option closes. These tests pin the three things that would let that recur.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { findResets, RESET_KIND, DEFAULT_UP_JUMP_PCT } = require('../trading/agent/accountResets');

const s = (at, equity, id) => ({ id, equity, capturedAt: new Date(at), source: 'test' });

test('THE REAL ONE: 2,632.98 -> 4,000 is detected, and carries the before/after balances', () => {
  const found = findResets([
    s('2026-10-16T12:06:10Z', 2632.98, 10688),
    s('2026-10-16T12:21:54Z', 4000, 10689),
  ]);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].from, 2632.98);
  assert.strictEqual(found[0].to, 4000);
  assert.ok(Math.abs(found[0].pct - 51.92) < 0.01);
  // the snapshot that CARRIES the new balance is the dedupe key — not the timestamp, because several samples
  // share a minute and a timestamp key would write the same reset twice
  assert.strictEqual(found[0].snapshotId, 10689);
});

test('a bad day is NOT a reset — the 2026-10-16 options losses must stay trading', () => {
  // The same day's real drawdown, which a symmetric detector would have called a reset and then used to cut the
  // ledger in half. Downward moves are never resets; a reset DOWN is indistinguishable from a large loss and has
  // to be stated by hand.
  const found = findResets([
    s('2026-10-16T09:00:00Z', 2954.43, 10670),
    s('2026-10-16T12:06:10Z', 2632.98, 10688),
  ]);
  assert.deepStrictEqual(found, []);
});

test('ordinary trading noise produces nothing', () => {
  const found = findResets([
    s('2026-10-22T02:00:00Z', 3939.53, 13001),
    s('2026-10-22T19:05:00Z', 4043.53, 13100), // +2.6% over 17h — the desk's best recent session
    s('2026-10-23T06:02:00Z', 4034.95, 13200),
  ]);
  assert.deepStrictEqual(found, []);
});

test('a zero balance is a missing read, not a reset', () => {
  // `0 -> 4000` would read as +Infinity% and `4000 -> 0` as -100%. Both are corrupt samples, and a detector that
  // fired on them would paper over a data problem as an account event.
  assert.deepStrictEqual(findResets([s('2026-10-16T12:00:00Z', 0, 1), s('2026-10-16T12:01:00Z', 4000, 2)]), []);
  assert.deepStrictEqual(findResets([s('2026-10-16T12:00:00Z', 4000, 1), s('2026-10-16T12:01:00Z', 0, 2)]), []);
});

test('the threshold is a floor, not a target: just under it is silent, just over it fires', () => {
  assert.strictEqual(DEFAULT_UP_JUMP_PCT, 10);
  assert.deepStrictEqual(findResets([s('2026-10-16T12:00:00Z', 1000, 1), s('2026-10-16T12:01:00Z', 1099, 2)]), []);
  assert.strictEqual(findResets([s('2026-10-16T12:00:00Z', 1000, 1), s('2026-10-16T12:01:00Z', 1101, 2)]).length, 1);
});

test('the event kind is named, and the detector is wired into the boot block', () => {
  assert.strictEqual(RESET_KIND, 'account_reset');
  const code = fs.readFileSync(path.join(__dirname, '..', 'trading', 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.ok(/agent\/accountResets'\)\.detectAndRecord\(/.test(code),
    'server.js must run the reset detector — a detector that is never called is how the 2026-10-16 reset went '
    + 'unrecorded in the first place');
});

test('venue-origin P&L is withheld at the write path, not merely filtered from reports', () => {
  // Filtering in a report is a convention every future query can forget; withholding at the write path means the
  // column that sums cannot produce an order-of-magnitude-wrong answer at all. 12 venue rows summed to
  // -1,120.97 while the account moved +55.69 over the same span, because `openPrice` is the mirror price.
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'venueClose.js'), 'utf8');
  assert.ok(/withholdPnl\s*=\s*trade\.origin === 'venue'/.test(src), 'venueClose must compute withholdPnl');
  assert.ok(/grossPnl:\s*withholdPnl \? null/.test(src), 'venueClose must store null for venue-origin closes');
  // and the number is not destroyed: the venue's own figure still rides on the event
  assert.ok(/netPnl: row\.netPnl/.test(src), 'the venue figure must survive on the trade_closed event');
});
