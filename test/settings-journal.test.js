// test/settings-journal.test.js — TRD-RSK-8 pins:
//   "a settings write is recorded, and a credential in settings never reaches the record."
//
// The defect this encodes: on 2026-09-28 `risk.maxAdversePct` was changed 0.3 -> 1.5 at 06:51:16.553Z and
// NOTHING recorded it. `TradingSettings` was the only live input on the desk with no journal — no settings-write
// event kind existed at all, so the switch is not reconstructible from the log afterwards.
//
// The rule is a PURE function (`trading/settingsDiff.js`) so it is testable without a database; the wiring is
// checked structurally because requiring `trading/store.js` outside a live environment buys nothing here.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { diffSettings, settingsWriteEvent, JOURNAL_MAX_KEYS } = require('../trading/settingsDiff');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Assertions run against CODE, not prose — a `doesNotMatch` that matches the comment explaining a thing is a
// test that fails on its own documentation.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const STORE = 'trading/store.js';

// ---------------------------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------------------------

test('a flat change is reported with both sides', () => {
  const d = diffSettings({ risk: { maxAdversePct: 0.3 } }, { risk: { maxAdversePct: 1.5 } });
  assert.equal(d.length, 1);
  assert.equal(d[0].key, 'risk.maxAdversePct');
  assert.equal(d[0].before, 0.3);
  assert.equal(d[0].after, 1.5);
});

test('a change to nothing produces NO event — an event is a signal, not a stream', () => {
  // `accountPoller` writes settings whenever it sees a new position, so a state-based journal would log
  // forever. This is the pin that keeps the journal proportional to real changes.
  const same = { risk: { maxAdversePct: 1.5, maxPositions: 10 }, wake: { paused: false } };
  assert.deepEqual(diffSettings(same, JSON.parse(JSON.stringify(same))), []);
  assert.equal(settingsWriteEvent(same, JSON.parse(JSON.stringify(same))), null);
});

test('nesting is reported by PATH, so a reader can act on the key', () => {
  const d = diffSettings({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
  assert.deepEqual(d.map((x) => x.key), ['a.b.c']);
});

test('an added key has before null and a removed key has after null', () => {
  const added = diffSettings({ a: 1 }, { a: 1, b: 2 });
  assert.deepEqual(added, [{ key: 'b', before: null, after: 2 }]);
  const removed = diffSettings({ a: 1, b: 2 }, { a: 1 });
  assert.deepEqual(removed, [{ key: 'b', before: 2, after: null }]);
});

test('arrays are compared as WHOLE values — a watchlist edit is one fact, not N', () => {
  const d = diffSettings({ watchlist: ['Gold', 'Oil'] }, { watchlist: ['Gold', 'Silver'] });
  assert.equal(d.length, 1, 'one entry for the array, not one per element');
  assert.equal(d[0].key, 'watchlist');
  assert.deepEqual(d[0].before, ['Gold', 'Oil']);
  // and an unchanged array is silent
  assert.deepEqual(diffSettings({ watchlist: ['Gold'] }, { watchlist: ['Gold'] }), []);
});

test('a false value is a VALUE, not an absence — 0 and false must be reported', () => {
  // The desk's recurring bug class is coercion: `Number(null) === 0` and `if (!v)`. `false`, `0` and `''` are
  // real settings values (0 disables a cap; false disables a feature) and must appear as changes.
  for (const [before, after] of [[true, false], [1, 0], ['x', '']]) {
    const d = diffSettings({ k: before }, { k: after });
    assert.equal(d.length, 1, `${JSON.stringify(before)} -> ${JSON.stringify(after)} must be a change`);
    assert.equal(d[0].after, after);
  }
});

test('diffSettings is defensive about missing or malformed input', () => {
  assert.deepEqual(diffSettings(null, null), []);
  assert.deepEqual(diffSettings(undefined, undefined), []);
  assert.deepEqual(diffSettings({}, null), []);
  assert.equal(settingsWriteEvent(null, null), null);
  // a scalar where an object is expected must not throw
  assert.deepEqual(diffSettings(5, 7), []);
});

// ---------------------------------------------------------------------------------------------
// The secret rule — the one that must never regress
// ---------------------------------------------------------------------------------------------

test('★ a credential-looking KEY records the change and NEVER the value', () => {
  const before = { congress: { token: 'OLD-SECRET-VALUE' } };
  const after = { congress: { token: 'NEW-SECRET-VALUE' } };
  const d = diffSettings(before, after);
  assert.equal(d.length, 1);
  assert.equal(d[0].key, 'congress.token');
  assert.equal(d[0].redacted, true);
  assert.equal(d[0].present, 'set');
  // ★ THE PIN THAT MATTERS: neither value may appear ANYWHERE in what would be written to TradingEvents.
  const payload = JSON.stringify(settingsWriteEvent(before, after));
  assert.ok(!payload.includes('OLD-SECRET-VALUE'), 'the OLD secret leaked into the journal payload');
  assert.ok(!payload.includes('NEW-SECRET-VALUE'), 'the NEW secret leaked into the journal payload');
});

test('the secret rule covers the credential words this desk actually uses', () => {
  for (const k of ['token', 'apiKey', 'api_key', 'secret', 'password', 'passphrase', 'credentials']) {
    const d = diffSettings({ [k]: 'a' }, { [k]: 'b' });
    assert.equal(d.length, 1, k);
    assert.equal(d[0].redacted, true, `${k} must be redacted`);
    assert.ok(!('before' in d[0]) && !('after' in d[0]), `${k} must carry no value at all`);
  }
});

test('a secret being CLEARED is reported as cleared, never as its old value', () => {
  const d = diffSettings({ congress: { token: 'SECRET' } }, { congress: { token: null } });
  assert.equal(d.length, 1);
  assert.equal(d[0].redacted, true);
  assert.equal(d[0].present, 'cleared');
  assert.ok(!JSON.stringify(d).includes('SECRET'));
});

test('a NON-secret key is still fully reported (the redaction must not swallow the journal)', () => {
  const d = diffSettings({ risk: { maxRiskPerTradePct: 0.07 } }, { risk: { maxRiskPerTradePct: 0.05 } });
  assert.equal(d.length, 1);
  assert.equal(d[0].before, 0.07);
  assert.equal(d[0].after, 0.05);
  assert.ok(!d[0].redacted);
});

// ---------------------------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------------------------

test('the journal is BOUNDED, and states the truncation rather than hiding it', () => {
  const before = {}; const after = {};
  for (let i = 0; i < JOURNAL_MAX_KEYS + 7; i++) { before['k' + i] = 0; after['k' + i] = 1; }
  const p = settingsWriteEvent(before, after);
  assert.equal(p.changed, JOURNAL_MAX_KEYS + 7, 'the TRUE count is reported, not the capped one');
  assert.equal(p.truncated, 7);
  assert.equal(p.changes.length, JOURNAL_MAX_KEYS);
  assert.equal(p.keys.length, JOURNAL_MAX_KEYS);
});

// ---------------------------------------------------------------------------------------------
// The wiring — structural
// ---------------------------------------------------------------------------------------------

test('saveSettings journals the write, AFTER the database write, and best-effort', () => {
  const src = code(STORE);
  const merge = src.indexOf('MERGE TradingSettings');
  const journal = src.indexOf('await journalSettingsWrite(userId, existing, merged');
  assert.ok(merge > -1, 'the settings write must still be a MERGE');
  assert.ok(journal > -1, 'saveSettings must journal the write');
  assert.ok(merge < journal, 'the journal is written AFTER the settings are committed');
  // Best-effort: a journaling failure must never fail a live save.
  assert.match(src, /journalSettingsWrite\(userId, existing, merged(?:, settings)?\)\.catch\(\(\) => \{\}\)/,
    'the journal must be best-effort — a failed journal cannot be allowed to fail a settings save');
  // ★ ADR-0001: the REQUESTED patch is passed through so the event can carry the namespaces it touched. The MERGED
  // result cannot supply that: it is the whole settings object, so every write would appear to touch every scope.
  assert.match(src, /journalSettingsWrite\(userId, existing, merged, settings\)/,
    'the requested patch must reach the journal, or `scope` has nothing to classify');
  // ★ ORDER vs the pre-existing reporter: the journal goes FIRST, because the fact that a write happened
  // cannot be recomputed from the settings while the dead-scope report can.
  const dead = src.indexOf('await reportDeadScopeWrite(userId, existing, merged)');
  assert.ok(dead > journal, 'the journal must be attempted before the recomputable report');
});

test('the journal obtains its payload ONLY from the pure module (so the redaction cannot be bypassed)', () => {
  const src = code(STORE);
  const start = src.indexOf('async function journalSettingsWrite');
  const end = src.indexOf('async function reportDeadScopeWrite');
  assert.ok(start > -1 && end > start, 'journalSettingsWrite must exist and be locatable');
  const fn = src.slice(start, end);
  assert.match(fn, /settingsDiff\.settingsWriteEvent\(before, after\)/, 'the payload comes from settingsDiff');
  // A second, inline diff here would be a place the secret rule does not reach.
  assert.doesNotMatch(fn, /JSON\.stringify\(\s*merged/, 'the journal must not serialise the whole settings object');
  assert.match(fn, /if \(!payload\) return null/, 'a no-op save must return without logging');
});

test('the event kind is declared, and mapped to the config-drift stream', () => {
  const log = code('trading/agent/log.js');
  assert.match(log, /settings_write:\s*'sec'/, 'settings_write must be mapped, or it silently falls to app.*');
});

test('settingsDiff has no database and no logger — that is why it is testable', () => {
  const d = code('trading/settingsDiff.js');
  assert.doesNotMatch(d, /require\(/, 'the pure module must require nothing');
});
