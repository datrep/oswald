// test/field-levels-epoch.test.js — the F20 floor check must not be decided by another era.
//
// WHAT WENT WRONG (measured 2026-09-28): `venueLevelGeometry` read the newest 50 level-bearing trades with NO
// date filter, so 23 of those 50 rows were opened BEFORE the `stop-cap` feature — i.e. their `stopPrice` is the
// UNCAPPED 2xATR and a reward:risk computed from them "describes a stop the venue never received" (the epoch
// registry's own words for that feature). The one row below the floor, #1046 (opened 2026-09-17, realised R:R
// 0.220 against a 0.75 floor), was therefore pinning the DESK DEGRADED banner on every run for ten days — the
// same latch TRD-65 had already had to remove from the ALERT for that exact row.
//
// These tests pin BOTH halves of the fix, because either half alone is a way to get this wrong:
//   1. the population is scoped to the geometry boundary, and the EXCLUSION IS NAMED (not dropped);
//   2. ★ NON-VACUITY: a below-floor row INSIDE the live window must still be `bad`. A fix that clears the
//      banner by weakening the detector would be worse than the banner.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { rrFloor } = require('../trading/agent/fieldContracts');
const { LEVEL_RR } = require('../trading/agent/exitLevels');
const epoch = require('../trading/agent/epoch');

// ⚠ THE POOL HAS TO BE STUBBED THROUGH THE MODULE CACHE, NOT BY REASSIGNING AN EXPORT.
// `fieldContracts` does `const { getPool } = require('../db')` at load time, so a destructured BINDING is
// captured once: assigning `db.getPool = fake` afterwards changes nothing, the real pool is used, and a test
// written that way queries the LIVE DATABASE while asserting against invented rows. (It did, on the first run
// of this file.) So the whole `trading/db` module is swapped in the cache and `fieldContracts` re-required
// against it — `sql` is carried over from the real module because the contract builds real parameter types.
const DB_PATH = require.resolve('../trading/db');
const FC_PATH = require.resolve('../trading/agent/fieldContracts');
const REAL_DB = require(DB_PATH);
const savedDbCache = require.cache[DB_PATH];

function loadContract(poolImpl) {
  require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: { ...REAL_DB, getPool: poolImpl } };
  delete require.cache[FC_PATH];
  try {
    return require(FC_PATH);
  } finally {
    if (savedDbCache) require.cache[DB_PATH] = savedDbCache; else delete require.cache[DB_PATH];
    delete require.cache[FC_PATH];
  }
}

// The contract issues TWO reads — the live window and the pre-epoch residue — and which one it is calling is
// decided by the predicate in the SQL, so the stub routes on the SQL TEXT rather than on call order. Routing on
// call order would pass even if the two queries were swapped.
function withRows({ live = [], prior = [] } = {}) {
  const seen = [];
  const mod = loadContract(async () => ({
    request: () => ({
      input() { return this; },
      query: async (text) => {
        seen.push(String(text).replace(/\s+/g, ' '));
        return { recordset: /< @since/.test(String(text)) ? prior : live };
      },
    }),
  }));
  return { mod, seen };
}

// #1046's real shape: a sell that filled BELOW its anchor, leaving a 0.22 R:R against a declared 1.5.
const belowFloorSell = (openAt) => ({
  id: 1046, direction: 'sell', openAt,
  openPrice: 95.8, stopPrice: 98.7198, takeProfitPrice: 95.1578, decisionPrice: null,
});
// A clean 1.5R ticket: exactly what the label claims.
const exactTicket = (id, openAt) => ({
  id, direction: 'buy', openAt,
  openPrice: 100, stopPrice: 98, takeProfitPrice: 103, decisionPrice: 100,
});

const POST = '2026-09-27T10:00:00Z';   // inside the current regime
const PRE = '2026-09-17T13:26:50Z';    // #1046, before `stop-cap` (2026-09-19)

test('the geometry boundary comes from the epoch registry, not from a literal in this file', () => {
  const cap = epoch.FEATURES.find((f) => f.id === 'stop-cap');
  assert.ok(cap, 'the stop-cap feature is what invalidates pre-cap geometry');
  assert.equal(cap.landedAt, '2026-09-19');
});

test('★ NON-VACUITY: a below-floor row INSIDE the live window is still bad', async () => {
  const { mod } = withRows({ live: [belowFloorSell(POST)] });
  const c = await mod.venueLevelGeometry(1, { settings: null });
  assert.equal(c.status, 'bad', 'the detector must still fire on a live violation');
  assert.match(c.detail, /BELOW THE DECLARED FLOOR/);
  assert.match(c.detail, /#1046/);
  assert.ok(!c.standing, 'a live floor violation is never a standing condition');
});

test('the same row OUTSIDE the window does not decide the status, and IS NAMED', async () => {
  const { mod } = withRows({ live: [exactTicket(1090, POST)], prior: [belowFloorSell(PRE)] });
  const c = await mod.venueLevelGeometry(1, { settings: null });
  assert.notEqual(c.status, 'bad', 'a pre-epoch row must not set the status');
  assert.match(c.detail, /PRE-EPOCH row\(s\) \(opened before 2026-09-19\) are EXCLUDED/);
  assert.match(c.detail, /1 below the floor — #1046 realised R:R 0\.22/, 'the excluded offender is named, not dropped');
  assert.match(c.detail, /geometry exact/);
});

test('the exclusion is reported even when the live window is clean and empty of violations', async () => {
  // ⚠ THE `ok` VERDICT CARRIES THE NOTE TOO. An exclusion that is only mentioned when something else is wrong
  // is an exclusion that reads as "no such rows" the rest of the time — the "absent measurement reads as a
  // clean result" failure this same file's branch above exists for.
  const { mod } = withRows({ live: [exactTicket(1091, POST), exactTicket(1092, POST)], prior: [belowFloorSell(PRE)] });
  const c = await mod.venueLevelGeometry(1, { settings: null });
  assert.equal(c.status, 'ok');
  assert.match(c.detail, /2 post-epoch row\(s\) checked/);
  assert.match(c.detail, /#1046/);
});

test('with no pre-epoch rows the note is absent and the phrasing is unchanged', async () => {
  const { mod } = withRows({ live: [exactTicket(1093, POST)] });
  const c = await mod.venueLevelGeometry(1, { settings: null });
  assert.equal(c.status, 'ok');
  assert.doesNotMatch(c.detail, /EXCLUDED/, 'nothing to exclude means nothing to say');
  assert.doesNotMatch(c.detail, /PRE-EPOCH/);
});

test('`since: null` restores the OLD unfiltered population — the defect is reproducible on demand', async () => {
  // Reintroducing the defect is the only proof the fix is load-bearing, and it has to be one call away rather
  // than one revert away. With no boundary the pre-epoch row is measured as live and the banner goes red again.
  const { mod, seen } = withRows({ live: [belowFloorSell(PRE)] });
  const c = await mod.venueLevelGeometry(1, { settings: null, since: null });
  assert.equal(c.status, 'bad', 'without the boundary the old false alarm comes straight back');
  assert.equal(seen.length, 1, 'no boundary means no second population to read');
  assert.doesNotMatch(seen[0], /@since/, 'the predicate must be gone from the SQL, not merely ignored');
});

test('the epoch predicate is in the WHERE clause, not a post-filter over TOP(@limit)', async () => {
  // ⚠ LOAD-BEARING: `TOP (@limit)` runs BEFORE any post-filter would, so a JS-side filter would still read a
  // 46%-pre-epoch window and could let pre-epoch rows crowd a live violation out of the sample entirely.
  const { mod, seen } = withRows({ live: [], prior: [] });
  await mod.venueLevelGeometry(1, { settings: null, limit: 7 });
  assert.equal(seen.length, 2, 'the live window and the residue are separate reads');
  for (const q of seen) {
    assert.match(q, /ABS\(t\.openPrice - t\.stopPrice\) > 0/);
    assert.match(q, /@since/, 'both reads are bounded');
  }
  const [liveQ, priorQ] = seen;
  assert.match(liveQ, /t\.openAt IS NULL OR t\.openAt >= @since/, 'an undateable row is measured, not excused');
  assert.match(priorQ, /t\.openAt IS NOT NULL AND t\.openAt < @since/);
  assert.match(liveQ, /TOP \(@limit\) /);
  assert.doesNotMatch(priorQ, /TOP \(@limit\) /, 'the residue is counted in full or the named count would be a lie');
});

test('the F20 floor still comes from settings, and 0 still disables it', () => {
  assert.equal(rrFloor({ risk: { minRealisedRrPct: 50 } }), LEVEL_RR * 0.5);
  assert.equal(rrFloor({ risk: { minRealisedRrPct: 0 } }), 0);
});
