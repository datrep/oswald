// test/kill-autoclose.test.js — F19: the hard tier's promise, pinned (2026-09-18).
//
// WHAT WENT WRONG. `killswitch.setTier` only FLAGS `autoClose`; it closes nothing. The ONE block that
// consumed the flag lived inside the wake's `floor` step — and the `session` step returns
// `skipped: 'kill_switch_hard'` before the floor is ever reached whenever the tier is hard. So the flag's
// only reader was UNREACHABLE in exactly the state that sets it, while the dashboard's own dialog said:
//
//     "This blocks new entries AND closes 1 open position(s) at market."
//
// Verified end-to-end on the live desk 2026-09-17: tier `hard` + `autoClose: true` recorded in
// `settings.kill`, `Trades #1046` still `open`, and ZERO trade_closed / order_attempt / error events. The
// position was protected only by its venue stop, which sat 3.05% away (F20).
//
// THIS IS AN ORDERING DEFECT, so the pin is an ORDERING assertion — the same discipline as
// `watchdog-hold-budget.test.js`, which reads two files to pin a RELATION rather than restating a number.
// Restating "the sweep runs first" as a comment would drift the day the step order is refactored; reading
// the two positions out of the source cannot.
//
// A second defect shares the same root and is pinned here too: the old condition read
// `settings.kill?.autoClose` — a snapshot taken at the TOP of the wake — while `monitorFloor` WRITES the
// hard tier DURING the wake. A floor breach on a desk that was `off` therefore asked for a sweep and then
// evaluated the flag from before the breach. The fix is that the sweep re-reads the kill state itself.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const killswitch = require('../trading/agent/killswitch');
const pipe = require('../trading/agent/wakePipeline');

const PIPELINE = 'trading/agent/wakePipeline.js';
const EXECUTOR = 'trading/agent/executor.js';
const ROUTES = 'trading/routes.js';
const CONCIERGE = 'trading/agent/concierge.js';
const BROWSER_CONN = 'trading/connector/browser.js';
const KILLSWITCH = 'trading/agent/killswitch.js';
const SMOKE = 'trading/scripts/smoke.js';

// --- the rule itself (pure: no store, no venue, no connector) ----------------

test('the sweep applies to exactly one state: hard + autoClose + an open book', () => {
  const hard = { kill: { tier: 'hard', autoClose: true } };
  const book = [{ id: 1046 }];

  const go = killswitch.autoClosePlan(hard, book);
  assert.strictEqual(go.go, true, 'hard + autoClose + a position is the one case the dialog promised');
  assert.deepStrictEqual(go.tradeIds, [1046], 'the plan names the trades, so the event can name them too');

  // Every other state must be a NO-OP, and must say which one it is rather than returning a bare false:
  // "nothing open" and "the flag is off" are different facts about the desk.
  assert.strictEqual(killswitch.autoClosePlan({ kill: { tier: 'soft', autoClose: false } }, book).reason, 'tier_not_hard');
  assert.strictEqual(killswitch.autoClosePlan({ kill: { tier: 'off' } }, book).reason, 'tier_not_hard');
  assert.strictEqual(killswitch.autoClosePlan({ kill: { tier: 'hard', autoClose: false } }, book).reason, 'auto_close_off');
  assert.strictEqual(killswitch.autoClosePlan(hard, []).reason, 'nothing_open');
  assert.strictEqual(killswitch.autoClosePlan(hard, undefined).reason, 'nothing_open');
  assert.strictEqual(killswitch.autoClosePlan(undefined, book).reason, 'tier_not_hard');
});

test('the rule is NOT a one-shot latch: a flat book is what stops it, not a flag', () => {
  // The state that makes repeated calls safe is the BOOK, not a "already swept" bit. A sweep that failed
  // because the bridge was busy must be retried on the next wake rather than remembered as done — and a
  // sweep that succeeded must cost nothing on the next wake. Both fall out of the same rule.
  const hard = { kill: { tier: 'hard', autoClose: true } };
  assert.strictEqual(killswitch.autoClosePlan(hard, [{ id: 1 }]).go, true, 'first call: sweeps');
  assert.strictEqual(killswitch.autoClosePlan(hard, []).go, false, 'after the close: no venue call at all');
});

// --- the ordering defect ----------------------------------------------------

test('the auto-close runs BEFORE the hard-tier early return, which is the whole of F19', () => {
  const src = code(PIPELINE);

  const sweepAt = src.indexOf("step('autoclose'");
  const skipAt = src.indexOf("skipped: 'kill_switch_hard'");

  assert.ok(sweepAt > -1, 'the wake must carry an `autoclose` step');
  assert.ok(skipAt > -1, 'the hard-tier skip must still exist — the sweep does not replace it');
  assert.ok(
    sweepAt < skipAt,
    `the autoclose step (at ${sweepAt}) must come before the kill_switch_hard return (at ${skipAt}): `
    + 'when it came after, the flag had no reachable consumer and the dialog promised a close that never ran',
  );
});

test('the old unreachable shape cannot come back', () => {
  const src = code(PIPELINE);
  // The exact old condition: reading the pre-wake SNAPSHOT of the flag, after the floor read.
  assert.doesNotMatch(
    src,
    /mon\.tier === 'hard' && settings\.kill\?\.autoClose/,
    'the sweep must not be gated on the wake\'s snapshot of a flag the floor step itself may have just written',
  );
  assert.doesNotMatch(
    src,
    /require\('\.\/executor'\)\.closeAll/,
    'the wake must reach the close through `autoCloseSweep` — the one place the rule is applied',
  );
});

test('the sweep itself re-reads the kill state instead of trusting its caller', () => {
  const src = code(EXECUTOR);
  const fn = src.slice(src.indexOf('async function autoCloseSweep'));

  assert.ok(fn.length > 0, 'autoCloseSweep must exist in executor.js');
  assert.match(fn, /const settings = await store\.getSettings\(userId\)/, 'it must read the tier from the store');
  assert.match(fn, /killswitch\.autoClosePlan\(settings, open\)/, 'and decide through the shared rule');
  assert.doesNotMatch(
    fn.slice(0, fn.indexOf('catch')),
    /settings\.kill\?\.autoClose/,
    'the try path must not re-derive the rule inline — that is how the snapshot bug started',
  );
});

// --- the promise must not be able to strand the desk ------------------------

test('the sweep is bounded and optional, so a bridge that will not answer cannot fail the wake', () => {
  const src = code(PIPELINE);

  assert.match(
    src,
    /step\('autoclose',[\s\S]{0,400}?\{ optional: true, timeoutMs: AUTOCLOSE_STEP_TIMEOUT_MS \}/,
    'the sweep must run as a bounded, optional step — a hard tier still has to record its own skip',
  );
  assert.match(
    src,
    /if \(sweep && sweep\.skipped === 'timeout'\)\s*\{\s*await store\.logEvent\(userId, 'telemetry', \{ source: 'autoclose_sweep_unbounded'/,
    'an abandoned sweep must leave a trace: the abandoned promise may still close the book, but the WAKE could not wait',
  );
});

test('the step reports its VERDICT, not just its duration', () => {
  const src = code(PIPELINE);
  assert.match(src, /return autoCloseVerdict\(r\)/, 'the step result must carry the plan\'s verdict into the mirror');
  assert.match(src, /skipped: \(r && r\.reason\) \|\| 'not_applicable'/, 'a no-op names which no-op it was');
  assert.match(src, /skipped: `closed \$\{r\.closed\}\/\$\{r\.attempted\}`/, 'and a sweep reports what it actually closed');
});

test('the sweep deadline covers the lock wait its own path legitimately does', () => {
  const conn = code(BROWSER_CONN);

  const sweepMs = pipe.AUTOCLOSE_STEP_TIMEOUT_MS;
  assert.ok(sweepMs > 0, 'the sweep deadline must be exported, so it cannot be a hidden default');
  // It is the step default ON PURPOSE (see the derivation in the source): this step only ever runs while
  // the tier is hard, where the wake is abandoned immediately afterwards anyway.
  assert.strictEqual(sweepMs, pipe.DEFAULT_STEP_TIMEOUT_MS, 'and it is the step default, not a taste');

  // Read the ticket budget out of the connector, so the comparison cannot drift: a close IS a ticket,
  // and this is the wait it will actually do before it starts working.
  const ticketWait = Number((conn.match(/pageLock\.acquire\('ticket',\s*\{\s*waitMs:\s*(\d+)/) || [])[1]);
  assert.ok(ticketWait > 0, 'the ticket lock budget must be readable from connector/browser.js');

  assert.ok(
    sweepMs > ticketWait,
    `the sweep deadline ${sweepMs}ms must exceed the ${ticketWait}ms ticket lock wait, or a healthy close `
    + 'on a busy bridge would be abandoned by its own deadline',
  );
});

test('the sweep traces its outcome on BOTH paths, and never throws at its caller', () => {
  const src = code(EXECUTOR);
  const fn = src.slice(src.indexOf('async function autoCloseSweep'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  const writes = body.match(/log\.write\(userId, 'kill_auto_close'/g) || [];
  assert.strictEqual(writes.length, 2, 'one trace when it ran, one when it threw — there is no silent third path');
  assert.match(body, /level: res\.closed === res\.attempted \? 'info' : 'warn'/, 'a close that did not close must be the LOUDER one');
  assert.match(body, /catch \(e\) \{/, 'the failure path must be caught, not propagated');
  assert.match(body, /return \{ attempted: true, closed: 0, error:/, 'and must return a value the caller can report');
});

// --- every door on the hard tier --------------------------------------------

test('the kill route persists the tier FIRST, then starts the close', () => {
  const src = code(ROUTES);
  const tierAt = src.indexOf('await killswitch.setTier(req.user.userID');
  const sweepAt = src.indexOf('startAutoCloseSweep(req.user.userID');

  assert.ok(tierAt > -1 && sweepAt > -1, 'the route must both set the tier and start the sweep');
  assert.ok(tierAt < sweepAt, 'the safety state is written before anything touches the bridge — never contingent on it');
  assert.match(
    src.slice(sweepAt, sweepAt + 120),
    /startAutoCloseSweep\(req\.user\.userID, 'route:kill'\)/,
    'and it must start the sweep that shares the one rule',
  );
});

test('every other door that can set a hard tier also reaches the sweep', () => {
  // The three doorways are pinned by their call sites; the wake guard is the durable one that makes a
  // missed doorway a DELAY rather than a lost close (it re-reads the tier on every wake while hard).
  assert.match(code(ROUTES), /if \(mon\.tier === 'hard'\) startAutoCloseSweep\(req\.user\.userID, 'route:monitor'\)/,
    'a manual floor check can BE the thing that sets hard');
  assert.match(code(CONCIERGE), /require\('\.\/executor'\)\.autoCloseSweep\(userId, \{ caller: 'concierge:\/kill'/,
    'a remote hard kill makes the same promise the dashboard dialog does');
  assert.match(code(PIPELINE), /caller: `wake:\$\{trigger\}`/,
    'and the wake guard re-attempts it, which is what survives a restart or a busy bridge');
});

// --- TRD-111 (2026-09-20): an OMITTED autoClose on a hard kill means CLOSE ----
//
// The defect was one character class wide and silent. `autoClose !== null ? !!autoClose : true` applies the
// `true` default only when the key is ABSENT from the options object — and `undefined`, which is exactly
// what a request body without the field produces, is `!== null`. So `POST /kill {"tier":"hard"}` stored
// `autoClose: false`, the route computed `sweeping = false`, every sweep trigger then refused with
// `auto_close_off`, and the book stayed open behind its venue stops. The outcome is the 2026-09-17 incident
// reached by a different road, and it was reachable precisely by the caller who has no time to read a
// schema: an operator with curl during an incident.

test('only an explicit boolean false opts OUT of the hard-tier sweep (TRD-111)', () => {
  assert.strictEqual(killswitch.resolveAutoClose('hard', undefined), true, 'OMITTED = close: this is the whole fix');
  assert.strictEqual(killswitch.resolveAutoClose('hard', null), true, 'null is the signature default, and it means "did not say"');
  assert.strictEqual(killswitch.resolveAutoClose('hard', true), true);
  assert.strictEqual(killswitch.resolveAutoClose('hard', false), false, 'an explicit false is the ONLY opt-out');

  // Anything that is not a boolean is "you did not say", and not-saying must never mean "do not close".
  // The direction is deliberate: the safe reading of an ambiguous flag on a hard kill is the destructive
  // one, because the destructive one is the promise the tier makes.
  for (const v of ['false', 'no', 0, 1, '', {}, []]) {
    assert.strictEqual(killswitch.resolveAutoClose('hard', v), true, `${JSON.stringify(v)} is not an explicit opt-out`);
  }

  // No other tier closes anything, whatever it is handed.
  for (const t of ['off', 'soft', undefined, 'nope']) {
    for (const v of [true, false, null, undefined]) {
      assert.strictEqual(killswitch.resolveAutoClose(t, v), false, `tier ${t} never sweeps`);
    }
  }
});

test('setTier takes the rule from resolveAutoClose rather than re-deriving it inline', () => {
  const src = code(KILLSWITCH);
  assert.match(src, /const nextAutoClose = resolveAutoClose\(tier, autoClose\);/,
    'the flag and the rule it encodes must be written down once');
  assert.ok(src.indexOf('autoClose !== null') === -1,
    'the expression that read `undefined` as an explicit `false` must be gone, not merely corrected nearby');
});

test('the suite can no longer sweep by omission, and the concierge now sweeps as it always claimed', () => {
  // smoke posted `{tier:'hard'}` with no autoClose. After this change an omission MEANS close, so the suite
  // has to state its intent: a test must never ask the desk to close a book, and relying on "the sandbox book
  // happens to be empty" is the implicit assumption this suite has already been bitten by.
  const smoke = code(SMOKE);
  const at = smoke.indexOf("tier: 'hard'");
  assert.ok(at > -1, 'the smoke kill cycle must still exercise the hard tier');
  assert.match(smoke.slice(at, at + 160), /autoClose: false/, "smoke's hard kill must opt out explicitly");

  // The telegram concierge deliberately does NOT pass the flag — and its own comment already claimed it
  // "starts the same sweep". Until this fix that sentence was false; now it is the behaviour.
  const conc = code(CONCIERGE);
  const call = conc.slice(conc.indexOf('setTier(userId, settings, tier'));
  assert.ok(!/autoClose/.test(call.slice(0, 160)), 'the concierge lets the default mean CLOSE, on purpose');
  assert.match(conc, /const sweeping = next\.kill\?\.tier === 'hard' && !!next\.kill\?\.autoClose;/, 'and it still reports what it started');
});
