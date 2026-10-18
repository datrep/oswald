// test/s3-preregistration.test.js — the pre-registration must not be able to drift silently.
//
// ★ WHY THIS FILE EXISTS. A pre-registration is only worth anything if the values it names are the values that
// ran. The design doc (§14) declares S3's primary set and sensitivity grid BEFORE any result exists, and states
// the contract: **changing any of them after a result is recorded invalidates that result.** Prose cannot enforce
// that — a later edit to `structure.js` DEFAULTS or to the grid would silently move the goalposts and the
// recorded result would keep its authority. So every registered value is pinned here, and a change fails a test
// instead of quietly invalidating an experiment.
//
// ★ THIS DESK HAS ALREADY PAID FOR THIS ONCE. TRD-72 invalidated the shadow pre-registration by changing the
// bundle the chairs see. The lesson is not "be careful" — it is that a frozen value needs a mechanical guard.
//
// ★ WHAT A FAILURE HERE MEANS. Not "fix the test". It means: either you are deliberately changing the
// pre-registration (in which case update §14, note the date, and treat every result taken under the old set as
// VOID), or you changed something a registered experiment depends on without meaning to.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS: STRUCTURE } = require('../trading/agent/structure');
const { DEFAULTS: ACTIVITY } = require('../trading/agent/activity');
const survGold = require('../trading/agent/strategies/survGold');
const s3 = require('../trading/agent/strategies/survGoldStruct');

const VOID = ' — changing this VOIDS any result recorded under the previous pre-registration (design doc §14)';

const codeOnly = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// A series in the LAB's vocabulary (`open/high/low/close/time`), rising so structure reads bullish.
// Duplicated from `structure-gate-s3.test.js` on purpose: a shared helper module for two fixtures would be a
// third thing to keep in step, and these two files must be able to fail independently.
function labSeries(n = 160, { drift = 1 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const wob = i % 8 === 4 ? 3 : (i % 8 === 0 ? -3 : 0);
    const c = 100 + drift * i + wob;
    out.push({ open: c, high: c + 0.5, low: c - 0.5, close: c, time: new Date(Date.UTC(2026, 0, 1, i)) });
  }
  return out;
}

// ── 1. The engine's own defaults ARE the registered primary — nothing passes them explicitly ───────────
test('§14.2: the structure engine DEFAULTS are the pre-registered primary set', () => {
  // `quant` calls `computeStructure({ bars, asOf, basis })` with NO params, so the engine's DEFAULTS are not a
  // fallback here — they ARE the registered values. A test that pinned nothing would let a DEFAULTS edit change
  // the experiment while §14 kept claiming the old numbers.
  assert.deepStrictEqual({ ...STRUCTURE }, {
    k: 4, d: 1.5, r: 1.5, n: 20, m: 3,
    eqHi: 0.70, eqLo: 0.30, oteLow: 0.62, oteHigh: 0.79,
    atrPeriod: 14, minBars: 60, sweepLookback: 120,
  }, 'the registered primary structure parameters' + VOID);
});

test('§14.2: the clone\'s signal parameters are identical to its control — that IS the experiment', () => {
  assert.deepStrictEqual({ ...s3.DEFAULTS }, { ...survGold.DEFAULTS },
    'S3 tests ONE difference: the gate. Any other divergence makes the comparison answer nothing (§10 Q3)' + VOID);
  assert.deepStrictEqual({ ...s3.DEFAULTS }, {
    donchianPeriod: 20, adxPeriod: 14, adxGate: 0, atrPeriod: 14, atrStopMultiple: 2, riskPerTradePct: 1,
  }, 'and those parameters are the frozen survivor set' + VOID);
});

test('§14.3: the activity measure\'s defaults are registered, and it is NOT part of the gate', () => {
  assert.deepStrictEqual({ ...ACTIVITY }, { days: 20, minSamples: 8 },
    'registered so nobody mistakes varying these for part of the S3 test' + VOID);
});

// ── 2. The grid, executable ───────────────────────────────────────────────────────────────────────────
test('§14.4: the NON-PROMOTIONAL sensitivity grid is pinned exactly', () => {
  assert.deepStrictEqual({ ...s3.SENSITIVITY_GRID }, {
    k: [3, 4, 5, 6],
    d: [1.0, 1.5, 2.0],
    r: [1.0, 1.5, 2.0],
    n: [10, 20, 30],
    ote: [[0.62, 0.79], [0.618, 0.786], [0.5, 0.88]],
    altPredicates: ['bos_agrees', 'no_sweep_against'],
  }, 'the fixed grid' + VOID);
  // The primary must be a MEMBER of its own grid, or the grid cannot say whether the primary is a lucky cell.
  assert.ok(s3.SENSITIVITY_GRID.k.includes(STRUCTURE.k), 'the primary k must appear in the grid');
  assert.ok(s3.SENSITIVITY_GRID.d.includes(STRUCTURE.d), 'the primary d must appear in the grid');
  assert.ok(s3.SENSITIVITY_GRID.r.includes(STRUCTURE.r), 'the primary r must appear in the grid');
  assert.ok(s3.SENSITIVITY_GRID.n.includes(STRUCTURE.n), 'the primary n must appear in the grid');
  assert.ok(s3.SENSITIVITY_GRID.ote.some(([lo, hi]) => lo === STRUCTURE.oteLow && hi === STRUCTURE.oteHigh),
    'the primary OTE band must appear in the grid');
});

// ── 3. The predicate is (a) and ONLY (a) ──────────────────────────────────────────────────────────────
// ★ ★ THE RECORDED VALUES MUST BE THE VALUES THAT RUN. `scoreCandidate` merges the candidate row's `params`
// into `cfg`; the gate reads the structure parameters back out of `cfg`. If the key list missed one, that
// parameter would silently fall back to the engine default while the row claimed otherwise — the
// recorded-vs-actual mismatch this project keeps finding, in the one place where it is fatal.
test('★ STRUCTURE_PARAM_KEYS covers EVERY registered parameter — none can be silently omitted', () => {
  assert.deepStrictEqual([...s3.STRUCTURE_PARAM_KEYS].sort(), Object.keys(STRUCTURE).sort(),
    'the forwarded key list must be exactly the engine\'s parameter set; a missing key means the row records a '
    + 'value the engine ignores' + VOID);
  assert.deepStrictEqual(s3.structureParamsFrom({ ...STRUCTURE }), { ...STRUCTURE },
    'and forwarding the registered set must reproduce it exactly');
});

test('structureParamsFrom forwards only defined numbers, and never a coerced undefined', () => {
  // `{ k: undefined }` would NOT fall back to the default: `{ ...DEFAULTS, ...{ k: undefined } }` sets k to
  // undefined and the engine throws on `k < 1`. So an absent key must be OMITTED, not passed as undefined.
  assert.strictEqual(s3.structureParamsFrom({}), null, 'nothing usable -> null means "the engine defaults"');
  assert.strictEqual(s3.structureParamsFrom({ k: undefined }), null);
  assert.strictEqual(s3.structureParamsFrom({ k: null }), null);
  assert.strictEqual(s3.structureParamsFrom({ k: 'nonsense' }), null);
  assert.deepStrictEqual(s3.structureParamsFrom({ k: 5, d: undefined }), { k: 5 });
  assert.deepStrictEqual(s3.structureParamsFrom({ k: '5' }), { k: 5 }, 'numeric strings are coerced deliberately');
});

test('★ the forwarded parameters REACH the engine — proved behaviourally, not by reading the source', () => {
  // `minBars` is the cheapest parameter to observe: raise it above the series length and the gate must refuse
  // every entry, which it can only do if the value actually arrived at `computeStructure`.
  const series = labSeries(160, { drift: 1 });
  assert.equal(s3.gateAt(series, 150, 'buy'), true, 'premise: with the defaults this bar is allowed');
  assert.equal(s3.gateAt(series, 150, 'buy', { minBars: 400 }), false,
    'a forwarded minBars above the series length must refuse the entry — otherwise the value never arrived');
  assert.equal(s3.gateAt(series, 150, 'buy', { k: 60 }), false,
    'and a k wide enough to find no swing must also refuse, via the engine rather than the caller');
});
test('★ §14.2: the registered predicate reads DIRECTION ONLY — it is not a composite that drifted', () => {
  // The screen chose (a) over (b)/(c)/(d) on measured binding rate. If a later edit folded `bos` or `sweeps`
  // into this function, the candidate would silently be testing a DIFFERENT hypothesis while §14 still declared
  // (a) — and the recorded comparison against the control would no longer be interpretable.
  const src = codeOnly('trading/agent/strategies/survGoldStruct.js');
  const start = src.indexOf('function structureAgrees(');
  const end = src.indexOf('function gateAt(');
  assert.ok(start >= 0 && end > start, 'premise: the predicate must be locatable, or the pin below proves nothing');
  const body = src.slice(start, end);
  for (const forbidden of ['bos', 'sweeps', 'orderBlock', 'position', 'fvg', 'ote', 'displacement', 'activity', 'volume']) {
    assert.doesNotMatch(body, new RegExp(`\\b${forbidden}\\b`),
      `the registered predicate must not consult \`${forbidden}\` — that would be a different hypothesis` + VOID);
  }
  // ...and the one field it DOES read, stated positively so the pin cannot pass on an empty body.
  assert.match(body, /structure\.direction === want/, 'the comparison must be the registered one');
  assert.match(body, /structure\.state === 'ok'/, 'and it must require a usable structure (fails closed)');
});
