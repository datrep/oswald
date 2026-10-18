// test/tuner-revert-guard.test.js — TRD-TUN-1 (#1392): a dry run applied nothing, so there is nothing to undo.
//
// ★ THE DEFECT. `tuner.run()` guards every write with `if (!dryRun)`, so a dry run writes NO settings, NO telegram
// and NO application — but it still logs a `tune` event carrying the full proposed before/after, and the Strategy
// tab renders that event with a working Revert button. `tuner.revert()` never inspected `payload.dryRun`, so:
//
//   · TODAY it is a NO-OP that still writes a `tune_revert` row — a record asserting a live change was undone
//     when nothing was changed and nothing needed undoing. Measured: event 4544, a stub-model dry run whose
//     `before` map already equals the live settings of userId 1, so reverting it moves no value and still claims
//     an undo.
//   · IN GENERAL `params.before` is the FULL effective map AT THE TIME OF THE PROPOSAL, so if settings have moved
//     since, reverting a dry run SILENTLY ADOPTS parameters from a proposal that was never executed — a settings
//     mutation with no gate, wearing the provenance of an ordinary undo.
//
// ★ WHY THERE IS A NEGATIVE CONTROL BELOW. A guard that refused EVERY revert would satisfy "refuses a dry run"
// and be far worse than the defect. The second test exists so the first cannot pass on a blanket refusal.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../trading/store');
const tuner = require('../trading/agent/tuner');
const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const tunerSrc = nl(code('trading/agent/tuner.js'));
const routesSrc = nl(code('trading/routes.js'));
const appSrc = nl(code('trading/public/js/app.js'));

// A stub store: records every WRITE so "a refusal writes nothing" is measurable rather than asserted from prose.
function withStub(event, settings = { strategies: { enabled: ['survgold'], params: {} } }) {
  const saved = [];
  const logged = [];
  const orig = {
    listEvents: store.listEvents, getSettings: store.getSettings,
    saveSettings: store.saveSettings, logEvent: store.logEvent,
  };
  store.listEvents = async () => [event];
  store.getSettings = async () => settings;
  store.saveSettings = async (u, s) => { saved.push(s); };
  store.logEvent = async (...a) => { logged.push(a); };
  return {
    saved, logged,
    restore: () => Object.assign(store, orig),
  };
}

const APPLIED = {
  id: 3586,
  payload: {
    dryRun: false,
    changes: [{
      strategy: 'rsi2',
      params: { before: { low: 10, high: 90 }, after: { low: 8, high: 88 } },
      enabled: { before: false, after: true },
    }],
  },
};

const PROPOSAL = { // event 4544, verbatim shape: a stub-model dry run
  id: 4544,
  payload: {
    dryRun: true, model: 'stub', latencyMs: 0,
    changes: [{
      strategy: 'rsi2',
      params: { before: { rsiPeriod: 2, low: 10, high: 90, smaExitPeriod: 5, riskPerTradePct: 0.5 }, after: { low: 8, high: 88 } },
      enabled: { before: false, after: true },
    }],
  },
};

test('revert REFUSES a dry-run proposal, and writes NOTHING', async () => {
  const s = withStub(PROPOSAL);
  try {
    const r = await tuner.revert(1, { eventId: 4544, index: 0 });
    assert.equal(r.refused, true, 'the refusal must be machine-distinguishable from a miss');
    assert.match(r.error, /DRY RUN/);
    assert.equal(r.reverted, undefined, 'a refusal must not report a reverted strategy');
    assert.equal(s.saved.length, 0, 'a refusal must NOT write settings');
    assert.equal(s.logged.length, 0, 'a refusal must NOT log a tune_revert — the refusal must not become a record');
  } finally { s.restore(); }
});

test('revert still works on a proposal that WAS applied — the guard is not a blanket refusal', async () => {
  // The live state AFTER the applied change: rsi2 was switched ON by it, so reverting must switch it back OFF
  // (enabled.before = false). The first version of this test asserted the opposite and failed — correctly.
  const s = withStub(APPLIED, { strategies: { enabled: ['survgold', 'rsi2'], params: {} } });
  try {
    const r = await tuner.revert(1, { eventId: 3586, index: 0 });
    assert.equal(r.reverted, 'rsi2');
    assert.equal(r.refused, undefined);
    assert.equal(s.saved.length, 1, 'an applied change must still be revertible');
    assert.equal(s.logged.length, 1);
    assert.equal(s.logged[0][1], 'tune_revert');
    // and the write must restore the before-map
    assert.deepEqual(s.saved[0].strategies.params.rsi2, { low: 10, high: 90 });
    assert.ok(!s.saved[0].strategies.enabled.includes('rsi2'), 'enabled.before=false must REMOVE it again');
    assert.ok(s.saved[0].strategies.enabled.includes('survgold'), 'and must not disturb the others');
  } finally { s.restore(); }
});

test('the guard reads the field the tuner actually writes', async () => {
  // `run()` records `dryRun: !!dryRun` on the payload, so a truthy non-boolean is not a shape the writer can
  // produce; the guard tests `=== true` so an ABSENT field (every event before the flag existed, and every
  // applied event) reads as "applied" rather than as "unknown, refuse". This is the inversion direction that
  // matters: defaulting to refuse would make the whole panel inert.
  assert.match(tunerSrc, /if \(ev\.payload\.dryRun === true\) \{/);
  const s = withStub({ id: 1, payload: { changes: APPLIED.payload.changes } }); // no dryRun key at all
  try {
    const r = await tuner.revert(1, { eventId: 1, index: 0 });
    assert.equal(r.reverted, 'rsi2', 'an event with no dryRun key is an APPLIED event');
  } finally { s.restore(); }
});

test('the refusal is checked BEFORE any settings read or write', () => {
  // Order matters: the guard must not sit after `getSettings`, or a refused revert has already entered the
  // mutation path. Both `store.getSettings` and `store.saveSettings` must come after it.
  const guard = tunerSrc.indexOf('if (ev.payload.dryRun === true)');
  assert.ok(guard > 0, 'the guard must exist');
  const body = tunerSrc.slice(tunerSrc.indexOf('async function revert'));
  const relGuard = guard - tunerSrc.indexOf('async function revert');
  assert.ok(relGuard < body.indexOf('store.getSettings'), 'the guard must precede the settings read');
  assert.ok(relGuard < body.indexOf('store.saveSettings'), 'the guard must precede the settings write');
  assert.ok(relGuard < body.indexOf("'tune_revert'"), 'the guard must precede the audit write');
});

test('the panel can TELL a proposal from an applied change', () => {
  // The history route did not forward `dryRun` at all, so the UI could not have known.
  assert.match(routesSrc, /dryRun: e\.payload\?\.dryRun === true,/);
  // and a refusal is a 409, not a 404 — "never applied" is not the same finding as "not found"
  assert.match(routesSrc, /if \(r\.refused\) return res\.status\(409\)/);
  assert.ok(routesSrc.indexOf('r.refused') < routesSrc.indexOf("if (r.error) return res.status(404)"), 'refused must be mapped before the generic miss');
});

test('the UI does not offer a Revert control on a row that was never applied', () => {
  assert.match(appSrc, /const dry = ev\.dryRun === true;/);
  assert.match(appSrc, /proposal — never applied/);
  // the button must be inside a branch on `dry`, not unconditional
  const i = appSrc.indexOf('const dry = ev.dryRun === true;');
  const call = appSrc.indexOf('data-revert=', i);
  assert.ok(i > 0 && call > i, 'the dry check must precede the button markup');
  const between = appSrc.slice(i, call);
  assert.match(between, /dry\s*\n?\s*\?/, 'the button must be conditional on the dry flag');
});
