// TRD-93 — the smoke suite must not be able to touch the live desk, and the reason it could not was
// written in the wrong place for eight days.
//
// THE ROW SAID: "the smoke suite drives the live kill switch — a failed run can leave the real desk
// latched HARD", citing two 2026-09-18 wakes that logged `skipped: kill_switch_hard` with kill reason
// "smoke". The event log says otherwise: EVERY cited event is userId 42 (`trading_smoke`), the live desk
// (user 1) woke normally at 08:57:47Z inside that same window, and the sandboxing shipped on 2026-09-10
// (P1-12b, recorded in docs/trading-agent-review-2026-09-10.md as "the phantom kill-hard blip class is
// dead"). The row was re-derived from a STALE COMMENT in smoke.js that claimed the suite "mutate[s] the
// live desk's settings", plus a wake-skip log line nobody attributed to a user.
//
// So this file pins the isolation itself, which is the only durable answer to "it cannot happen" — the
// comment is now true, and these assertions are what stop it going false again silently.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SMOKE = read('trading/scripts/smoke.js');
const SERVER = read('trading/server.js');
const WAKER = read('trading/agent/waker.js');

test('the smoke suite acts as the SANDBOX user, never the live desk', () => {
  assert.match(SMOKE, /jwt\.sign\(\{ userID: SMOKE_USER_ID/,
    'every authenticated call must carry the sandbox identity');
  // And the sandbox id is RESOLVED, not assumed: Users.id is IDENTITY, so a hard-coded 1 would be a
  // silent passthrough to the live desk's settings row.
  assert.match(SMOKE, /SELECT id FROM Users WHERE username = 'trading_smoke'/);
  assert.match(SMOKE, /SMOKE_USER_ID = Number\(/);
  assert.doesNotMatch(SMOKE, /userID:\s*1\b/, 'no hard-coded live user id');
  assert.doesNotMatch(SMOKE, /userId:\s*1\b/, 'no hard-coded live user id');
});

test('the smoke service boots without a wake loop or a watchdog', () => {
  assert.match(SMOKE, /TRADING_SMOKE: '1'/, 'the child must be flagged as a smoke run');
  const guard = SERVER.slice(SERVER.indexOf("process.env.TRADING_SMOKE === '1'"));
  const beforeWaker = guard.slice(0, guard.indexOf("waker').start"));
  assert.match(beforeWaker, /return;/, 'the guard must RETURN before the waker is started');
});

test('the live waker is single-user, so no second process can wake the real desk', () => {
  assert.match(WAKER, /agentUserId: 1/, 'the waker state carries exactly one user');
  assert.match(SERVER, /waker'\)\.start\(1\)/, 'the service starts the waker for user 1 only');
});

test('a test must never ask the desk to sweep the book', () => {
  // Scoped by the NEXT check, not by a marker that may not exist: an unscoped slice would pass on an
  // `autoClose: false` sent by some other check while the kill cycle omitted it — a pin that cannot fail.
  const start = SMOKE.indexOf("check('kill switch cycle'");
  const end = SMOKE.indexOf("await check('ledgers'", start);
  assert.ok(start > 0 && end > start, 'the kill switch cycle and the check after it must both exist');
  const killCycle = SMOKE.slice(start, end);
  assert.match(killCycle, /tier: 'hard'/, 'the cycle must actually exercise a hard tier');
  assert.match(killCycle, /autoClose: false/,
    'explicit, because on a hard tier an OMITTED flag means "close" (TRD-111) — a test must not be able to sweep');
});

test('the settings snapshot is a sandbox self-restore, and it runs in a finally', () => {
  assert.match(SMOKE, /restoreSettingsHook = \(\) => req\('PUT', '\/api\/trading\/settings'/);
  const main = SMOKE.slice(SMOKE.lastIndexOf('(async () => {'));
  assert.match(main, /finally\s*\{/, 'the restore must survive a thrown check');
  assert.match(main, /if \(restoreSettingsHook\) await restoreSettingsHook\(\)/);
});

test('the comment that seeded the false finding is gone', () => {
  assert.doesNotMatch(SMOKE, /mutate the live desk's settings/,
    'a comment claiming live impact, next to code that is sandboxed, is how TRD-93 was born');
  assert.match(SMOKE, /WHAT THIS SUITE CAN AND CANNOT TOUCH/, 'the correction must be recorded where it was wrong');
});
