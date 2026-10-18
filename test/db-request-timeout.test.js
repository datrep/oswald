// test/db-request-timeout.test.js — TRD-51 fix 2, 2026-09-14.
//
// shared/db.js set `connectionTimeout: 60000` and NEVER set `requestTimeout`, so the
// mssql/tedious default applied to every query:
//
//     tedious/lib/connection.js:59      const DEFAULT_CLIENT_REQUEST_TIMEOUT = 15 * 1000;
//     mssql/lib/tedious/connection-pool.js:42
//       cfg.options.requestTimeout = cfg.options.requestTimeout
//         ?? this.config.requestTimeout ?? this.config.timeout ?? 15000;
//
// 15000 is not a guess — it is the literal number in every aborted wake on 2026-09-14:
// `{"error":"Timeout: Request failed to complete in 15000ms","code":"ETIMEOUT"}`, eight of
// them from 09:37:45 to 13:05:38 SGT, while the desk's own worst stall in those hours ran
// 11.4 to 11.8 s and peaked at 17.1 s. The timeout was firing on a STALL, not a hang.
//
// These pins are about the SHAPE of the fix, not just the number:
//   * the value must be in the config the driver actually reads (both branches);
//   * it must exceed the old 15 s default (otherwise the fix is cosmetic);
//   * a junk DB_REQUEST_TIMEOUT_MS must NOT silently restore the 15 s default — that
//     would re-create the bug while looking like a configured system;
//   * 0 is a real tedious value meaning NO timeout, and must be honoured when set
//     deliberately, not reached by accident.
//
// The end-to-end proof (a 17 s WAITFOR that a 15 s timeout would have aborted) lives in
// temp/verify-request-timeout.js — it needs a live DB, so it is not a unit test.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// The module computes dbConfig at require time, so a fresh copy is needed to observe any
// env-dependent behaviour without disturbing the shared pool other tests may use.
const MOD = path.join(__dirname, '..', 'shared', 'db.js');
function freshDb(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve(MOD)];
  const mod = require(MOD);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return mod;
}

const DRIVER_DEFAULT_MS = 15000; // tedious DEFAULT_CLIENT_REQUEST_TIMEOUT

test('TRD-51: the tedious branch carries an explicit requestTimeout above the 15s default', () => {
  const { buildDbConfig } = freshDb({ DB_DRIVER: 'sql' });
  const cfg = buildDbConfig();
  assert.ok(cfg.requestTimeout > DRIVER_DEFAULT_MS,
    `requestTimeout must exceed the ${DRIVER_DEFAULT_MS}ms driver default, got ${cfg.requestTimeout}`);
  // tedious reads options.requestTimeout FIRST (connection-pool.js:42), so it must be there too.
  assert.strictEqual(cfg.options.requestTimeout, cfg.requestTimeout,
    'the value tedious actually reads (options.requestTimeout) must match the documented one');
});

test('TRD-51: the LocalDB branch carries it too — the same pool serves every deployment', (t) => {
  // shared/db.js requires the driver AT REQUIRE TIME based on DB_DRIVER, so this branch can
  // only be exercised where msnodesqlv8 is actually installed. Rather than pretend, skip with
  // the reason stated — the LocalDB path is the Windows-To-Go deployment (#73) and must not be
  // silently exempt from a fix that exists because a timeout was wrong.
  let cfg;
  try {
    cfg = freshDb({ DB_DRIVER: 'msnodesqlv8' }).buildDbConfig();
  } catch (e) {
    t.skip(`msnodesqlv8 not installed here (${String(e.code || e.message).slice(0, 60)}) — LocalDB branch unasserted on this machine`);
    return;
  }
  assert.ok(cfg.requestTimeout > DRIVER_DEFAULT_MS,
    `LocalDB requestTimeout must also exceed ${DRIVER_DEFAULT_MS}ms, got ${cfg.requestTimeout}`);
  assert.strictEqual(cfg.options.requestTimeout, cfg.requestTimeout);
});

test('TRD-51: the default leaves real headroom over the WORST MEASURED stall (17.1s)', () => {
  const { REQUEST_TIMEOUT_MS } = freshDb({ DB_DRIVER: 'sql', DB_REQUEST_TIMEOUT_MS: undefined });
  // 17.1s is the 13:00 bucket's peak on 2026-09-14 — the one gap that exceeded 15s and the
  // last failure window before the desk recovered.
  assert.ok(REQUEST_TIMEOUT_MS > 17100,
    `default ${REQUEST_TIMEOUT_MS}ms must clear the worst measured stall (17.1s)`);
  assert.strictEqual(REQUEST_TIMEOUT_MS, 60000, 'default is 60s, matching connectionTimeout');
});

test('TRD-51: a junk DB_REQUEST_TIMEOUT_MS does NOT silently restore the 15s default', () => {
  for (const junk of ['abc', '', '   ', 'NaN', '-1']) {
    const { REQUEST_TIMEOUT_MS } = freshDb({ DB_DRIVER: 'sql', DB_REQUEST_TIMEOUT_MS: junk });
    assert.notStrictEqual(REQUEST_TIMEOUT_MS, DRIVER_DEFAULT_MS,
      `"${junk}" must not fall back to the ${DRIVER_DEFAULT_MS}ms default this exists to remove`);
    assert.ok(REQUEST_TIMEOUT_MS > DRIVER_DEFAULT_MS,
      `"${junk}" must fall back to the safe 60s default, got ${REQUEST_TIMEOUT_MS}`);
  }
});

test('TRD-51: a deliberate numeric override is honoured (the owner can tune without a code change)', () => {
  const { REQUEST_TIMEOUT_MS } = freshDb({ DB_DRIVER: 'sql', DB_REQUEST_TIMEOUT_MS: '90000' });
  assert.strictEqual(REQUEST_TIMEOUT_MS, 90000);
});

test('TRD-51: 0 is a real tedious value (NO timeout) and is reachable only deliberately', () => {
  // connection-pool.js:53 — `requestTimeout === Infinity || < 0` becomes 0, and 0 means no
  // timeout. It must be settable on purpose, and must never be the fallback for junk.
  const { REQUEST_TIMEOUT_MS } = freshDb({ DB_DRIVER: 'sql', DB_REQUEST_TIMEOUT_MS: '0' });
  assert.strictEqual(REQUEST_TIMEOUT_MS, 0);
  const junk = freshDb({ DB_DRIVER: 'sql', DB_REQUEST_TIMEOUT_MS: 'abc' });
  assert.notStrictEqual(junk.REQUEST_TIMEOUT_MS, 0, 'junk must not disable the timeout entirely');
});

test('TRD-51: connectionTimeout is left alone at 60s — this fix adds, it does not redefine', () => {
  const { buildDbConfig } = freshDb({ DB_DRIVER: 'sql' });
  const cfg = buildDbConfig();
  assert.strictEqual(cfg.connectionTimeout, 60000);
  assert.strictEqual(cfg.options.connectionTimeout, 60000);
});
