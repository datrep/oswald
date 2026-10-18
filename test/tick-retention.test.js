// TRD-92 — the tick retention window is a setting, and the prune archives before it deletes.
//
// Two claims are pinned here, and both are the kind that rot silently if they are only asserted in prose:
//   1. `resolveTickDays` NEVER substitutes a window silently. An ABSENT value gets the default (that is the
//      default doing its job); a PRESENT but unusable one gets the default WITH `refused: true` and a note
//      naming what was refused. The two cases are distinguishable, because collapsing them is the bug.
//   2. The delete is bounded by the export. `deleteTicksThrough` is called with the largest id that is
//      actually in the file, and a failed export deletes NOTHING.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTickDays, DEFAULT_TICK_DAYS, MAX_TICK_DAYS } = require('../trading/agent/retention');
const {
  archiveAndPrune, planPrune, exportTicks, readArchive, archiveDirFor, archiveFileName,
  archivedTicks, ticksForStudy, archiveCoverage, cutoffFromName,
} = require('../trading/agent/tickArchive');
const zlib = require('node:zlib');

// A batch as the writer would produce it: named by its cutoff, holding ticks OLDER than that cutoff.
function writeBatch(dir, { userId = 1, from, to = new Date().toISOString(), maxId, rows }) {
  const file = path.join(dir, archiveFileName({ userId, from, to, maxId }));
  fs.writeFileSync(file, zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  return file;
}
const tick = (id, symbol, at, venue = 'plus500') => ({
  id, userId: 1, venue, symbol, bid: 100 + id, ask: 100.1 + id, source: 'capture', capturedAt: at,
});

// ---------------------------------------------------------------------------------------------
// 1. The window resolver
// ---------------------------------------------------------------------------------------------
test('an ABSENT window is the default, and is not reported as a refusal', () => {
  for (const absent of [undefined, null]) {
    const r = resolveTickDays(absent);
    assert.equal(r.days, DEFAULT_TICK_DAYS);
    assert.equal(r.source, 'default');
    assert.equal(r.refused, false, 'unset is not a refusal — the default is the answer');
    assert.equal(r.note, null);
  }
});

test('a configured window is used as given, and says where it came from', () => {
  const r = resolveTickDays(90);
  assert.equal(r.days, 90);
  assert.equal(r.source, 'settings', 'a settings value reported as an override is one more number that lies');
  assert.equal(r.refused, false);
  assert.equal(r.note, null);
  assert.equal(resolveTickDays(90, 'override').source, 'override');
});

test('a JSON settings blob is read the way the blob actually arrives', () => {
  const r = resolveTickDays('90');
  assert.equal(r.days, 90);
  assert.equal(r.source, 'settings');
  assert.equal(r.asked, '90');
});

test('a PRESENT but unusable window is refused LOUDLY, never silently swallowed', () => {
  const cases = [0, -3, 'abc', '', NaN, Infinity, -Infinity, {}, [], true];
  for (const bad of cases) {
    const r = resolveTickDays(bad);
    assert.equal(r.days, DEFAULT_TICK_DAYS, `${JSON.stringify(bad)} must fall back to the default`);
    assert.equal(r.refused, true, `${JSON.stringify(bad)} must be reported as refused`);
    assert.equal(r.source, 'refused');
    assert.match(r.note, /REFUSED/, `${JSON.stringify(bad)} must say what it did`);
  }
  // 0 is the case worth its own sentence: it is the one value that reads as a legitimate instruction and
  // would delete the ticks the current wake is reading.
  assert.match(resolveTickDays(0).note, /0 would delete every tick/);
});

test('a fractional window floors to whole days, and says so', () => {
  const r = resolveTickDays(1.5);
  assert.equal(r.days, 1);
  assert.equal(r.refused, true);
  assert.match(r.note, /floored/);
  // ...but a fraction below the minimum is refused outright, not floored to the minimum.
  assert.equal(resolveTickDays(0.5).days, DEFAULT_TICK_DAYS);
});

test('an absurd window is clamped to the ceiling, and the ceiling itself is not a refusal', () => {
  const big = resolveTickDays(1e9);
  assert.equal(big.days, MAX_TICK_DAYS);
  assert.equal(big.refused, true);
  assert.match(big.note, /ceiling/);
  assert.equal(resolveTickDays(MAX_TICK_DAYS).refused, false);
});

// ---------------------------------------------------------------------------------------------
// 2. The batch decision
// ---------------------------------------------------------------------------------------------
test('planPrune: nothing to prune, a batch below the floor, and a batch worth a file', () => {
  assert.equal(planPrune({ pending: 0 }).reason, 'nothing_to_prune');
  assert.equal(planPrune({ pending: 12, minRows: 200 }).reason, 'batch_below_min');
  assert.equal(planPrune({ pending: 200, minRows: 200 }).archive, true);
  // An explicit opt-out is its own reason, so "no file" never has to be inferred from a count.
  assert.equal(planPrune({ pending: 5000, archiveEnabled: false }).reason, 'archive_disabled');
});

// ---------------------------------------------------------------------------------------------
// 3. The file
// ---------------------------------------------------------------------------------------------
test('batch file names sort lexicographically in chronological order', () => {
  const a = archiveFileName({ userId: 1, from: '2026-09-14T04:00:00.000Z', to: '2026-09-21T03:00:00.000Z', maxId: 900 });
  const b = archiveFileName({ userId: 1, from: '2026-09-15T04:00:00.000Z', to: '2026-09-22T03:00:00.000Z', maxId: 100 });
  assert.ok(a < b, 'a plain sort of the directory must be a chronological sort');
  assert.match(a, /^ticks-u1-2026-09-14T04-00-00Z_2026-09-21T03-00-00Z-id900\.jsonl\.gz$/);
});

test('exportTicks pages the expiring rows into a gzipped JSONL file, and readArchive reads them back', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-'));
  const rows = Array.from({ length: 7 }, (_, i) => ({
    id: i + 1, userId: 1, venue: 'plus500', symbol: 'Gold',
    bid: 4300 + i, ask: 4300.5 + i, source: 'capture',
    capturedAt: new Date(Date.UTC(2026, 8, 10, i)).toISOString(),
  }));
  // A db that only answers the paged read, at a page size smaller than the set — the cursor is what is
  // being pinned here, not the query.
  let calls = 0;
  const db = {
    async listTicksBefore(userId, { before, afterId, limit }) {
      calls++;
      assert.equal(userId, 1);
      assert.ok(before instanceof Date);
      return rows.filter((r) => r.id > afterId).slice(0, limit);
    },
  };
  const out = await exportTicks(db, 1, { before: new Date(Date.UTC(2026, 8, 21)), dir, base: 'ticks-u1-x', pageSize: 3 });
  assert.equal(out.rows, 7);
  assert.equal(out.maxId, 7, 'the boundary the DELETE will use is the largest id actually written');
  assert.ok(out.bytes > 0);
  assert.ok(calls >= 3, 'the cursor must advance — one page was not enough');
  assert.match(path.basename(out.file), /-id7\.jsonl\.gz$/, 'the file name states the boundary');

  const back = readArchive(out.file);
  assert.deepEqual(back.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(back[0].symbol, 'Gold');
  assert.equal(back[0].capturedAt, rows[0].capturedAt);
  assert.deepEqual(await fs.promises.readdir(dir), [path.basename(out.file)], 'nothing else is left in the directory');
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('an export that could not be read leaves NOTHING behind — no archive, and no `.part`', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-bad-'));
  const db = { async listTicksBefore() { throw new Error('read exploded'); } };
  await assert.rejects(() => exportTicks(db, 1, { before: new Date(), dir, base: 'ticks-u1-x' }), /read exploded/);
  assert.deepEqual(await fs.promises.readdir(dir), [],
    'a half-written file would look like an archive and is not one');
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('an empty export writes no file at all', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-empty-'));
  const db = { async listTicksBefore() { return []; } };
  const out = await exportTicks(db, 1, { before: new Date(), dir, base: 'ticks-u1-x' });
  assert.equal(out.file, null);
  assert.deepEqual(await fs.promises.readdir(dir), []);
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('archiveDirFor honours the setting and defaults under trading/archive/ticks', () => {
  assert.match(archiveDirFor({}), /archive[\\/]ticks$/);
  assert.equal(archiveDirFor({ archiveDir: 'C:\\tmp\\ticks' }), path.resolve('C:\\tmp\\ticks'));
});

// ---------------------------------------------------------------------------------------------
// 4. The orchestration — the ordering property, on a fake store
// ---------------------------------------------------------------------------------------------
function fakeStore(rows, over = {}) {
  const calls = { deletedThrough: [], deletedOld: [], archived: null };
  return {
    calls,
    async countTicksBefore() { return over.pending != null ? over.pending : rows.length; },
    async listTicksBefore(userId, { afterId, limit }) { return rows.filter((r) => r.id > afterId).slice(0, limit); },
    async deleteTicksThrough(userId, args) { calls.deletedThrough.push(args); return over.deleted != null ? over.deleted : rows.length; },
    async deleteOldTicks(userId, days) { calls.deletedOld.push(days); return rows.length; },
  };
}

test('the happy path: archive first, then delete bounded by the archived max id', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-run-'));
  const rows = Array.from({ length: 250 }, (_, i) => ({
    id: i + 1, userId: 1, venue: 'plus500', symbol: 'Gold', bid: 4300, ask: 4300.5,
    source: 'capture', capturedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  }));
  const db = fakeStore(rows);
  const r = await archiveAndPrune(1, {
    settings: { retention: { tickDays: 30, archiveDir: dir, archiveMinRows: 200 } },
    now: new Date(Date.UTC(2026, 8, 21)), store: db,
  });
  assert.equal(r.days, 30, 'the window comes from the settings, not from a literal');
  assert.equal(r.refused, false);
  assert.equal(r.archived.rows, 250);
  assert.equal(r.archived.maxId, 250);
  assert.equal(r.deleted, 250);
  assert.equal(db.calls.deletedThrough.length, 1);
  assert.equal(db.calls.deletedThrough[0].maxId, 250, 'the DELETE must be bounded by what the file holds');
  assert.equal(db.calls.deletedThrough[0].before.toISOString(), r.before);
  assert.equal(db.calls.deletedOld.length, 0, 'the unbounded delete must not be used on the archive path');
  // The file it says it wrote exists, and holds what it says it holds.
  assert.ok(fs.existsSync(r.archived.file));
  assert.match(path.basename(r.archived.file), /-id250\.jsonl\.gz$/);
  assert.equal(readArchive(r.archived.file).length, 250);
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('a batch below the floor is skipped, and NEITHER the file NOR the delete happens', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-min-'));
  const db = fakeStore([{ id: 1 }, { id: 2 }]);
  const r = await archiveAndPrune(1, {
    settings: { retention: { archiveDir: dir, archiveMinRows: 200 } }, store: db,
  });
  assert.equal(r.skipped, 'batch_below_min');
  assert.equal(r.deleted, 0);
  assert.equal(r.archived, null);
  assert.equal(db.calls.deletedThrough.length, 0);
  assert.deepEqual(await fs.promises.readdir(dir), []);
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('nothing to prune is a recorded no-op, not an empty file', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-none-'));
  const db = fakeStore([], { pending: 0 });
  const r = await archiveAndPrune(1, { settings: { retention: { archiveDir: dir } }, store: db });
  assert.equal(r.skipped, 'nothing_to_prune');
  assert.equal(r.deleted, 0);
  assert.deepEqual(await fs.promises.readdir(dir), []);
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('an export failure keeps the ticks: delete is never called, and the reason is carried', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-fail-'));
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, capturedAt: new Date().toISOString() }));
  const db = fakeStore(rows, {});
  db.listTicksBefore = async () => { throw new Error('disk full'); };
  const r = await archiveAndPrune(1, {
    settings: { retention: { archiveDir: dir, archiveMinRows: 200 } }, store: db,
  });
  assert.equal(r.refused, 'archive_failed');
  assert.match(r.error, /disk full/);
  assert.equal(r.deleted, 0);
  assert.equal(db.calls.deletedThrough.length, 0, 'losing the ticks is worse than not pruning');
  assert.deepEqual(await fs.promises.readdir(dir), [], 'and no `.part` is left to be mistaken for an archive');
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('archive:false is an explicit opt-out back to the old behaviour, and says so', async () => {
  const db = fakeStore([{ id: 1 }], { pending: 5000 });
  const r = await archiveAndPrune(1, { settings: { retention: { tickDays: 14, archive: false } }, store: db });
  assert.equal(r.archiveDisabled, true);
  assert.equal(r.archived, null);
  assert.deepEqual(db.calls.deletedOld, [14]);
  assert.equal(db.calls.deletedThrough.length, 0);
});

test('a refused window travels with the result instead of vanishing into the prune', async () => {
  const db = fakeStore([], { pending: 0 });
  const r = await archiveAndPrune(1, { settings: { retention: { tickDays: 0 } }, store: db });
  assert.equal(r.days, DEFAULT_TICK_DAYS);
  assert.equal(r.refused, true);
  assert.match(r.note, /REFUSED/);
});

// ---------------------------------------------------------------------------------------------
// 5. The store-level guard, and the SQL that composes with the archive
// ---------------------------------------------------------------------------------------------
test('deleteOldTicks refuses an unresolved window instead of substituting one', async () => {
  const store = require('../trading/store');
  for (const bad of [undefined, null, 0, -1, 'abc', NaN]) {
    await assert.rejects(() => store.deleteOldTicks(1, bad), RangeError, `${String(bad)} must throw`);
  }
  // The throw is BEFORE any query, so a misconfigured window fails loudly without touching the pool.
  await assert.rejects(() => store.deleteOldTicks(1, 0), /resolveTickDays/);
});

test('the bounded delete composes cutoff AND archived id (a source pin: the predicate is the guarantee)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'store', 'bars.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function deleteTicksThrough'));
  assert.match(fn, /capturedAt < @before AND id <= @maxId AND id > 0/,
    'the archive-then-delete order is only a guarantee while the DELETE cannot reach past the file');
});

test('buildAll reads the window from settings and logs the retention result on the existing event', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'bars.js'), 'utf8');
  const code = raw.replace(/^\s*\/\/.*$/gm, ''); // prose may name the defect; the CODE must not contain it
  assert.match(code, /archiveAndPrune\(userId, \{ settings: cfg, tickDays \}\)/);
  assert.match(code, /store\.getSettings\(userId\)/, 'settings must be READ, never defaulted');
  assert.doesNotMatch(code, /tickDays\s*=\s*7/, 'the literal default that TRD-92 removed must not come back');
  assert.match(code, /store\.logEvent\(userId, 'bars_built'/, 'the result must land on the existing event');
});

// ---------------------------------------------------------------------------------------------
// 5. The reader — TRD-92's promise that a study can be RE-RUN after its window ages out
// ---------------------------------------------------------------------------------------------
test('a batch name yields its cutoff, and junk yields null rather than an epoch', () => {
  const n = archiveFileName({ userId: 1, from: '2026-09-14T05:42:34.000Z', to: '2026-09-21T05:42:34.000Z', maxId: 13726 });
  assert.equal(cutoffFromName(n), Date.parse('2026-09-14T05:42:34Z'));
  assert.equal(cutoffFromName('ticks-u1-nonsense.jsonl.gz'), null, 'a malformed stamp must not read as 1970');
  assert.equal(cutoffFromName('other-file.jsonl.gz'), null);
});

test('archivedTicks filters by window, symbol and venue, and returns them in time order', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-read-'));
  const cutoff = '2026-09-14T05:42:34.000Z';
  writeBatch(dir, {
    from: cutoff, maxId: 5,
    rows: [
      tick(1, 'Gold', '2026-09-14T05:00:00Z'),
      tick(2, 'Gold', '2026-09-14T04:00:00Z'),
      tick(3, 'Oil', '2026-09-14T05:10:00Z'),
      tick(4, 'Gold', '2026-09-14T05:20:00Z'),
      tick(5, 'Gold', '2026-09-14T05:30:00Z', 'otherVenue'),
    ],
  });
  const all = await archivedTicks(1, { since: '2026-09-14T04:30:00Z', until: '2026-09-14T05:15:00Z', dir });
  // Window [04:30, 05:15) at the batch's own venue: id 2 (04:00) is too old, ids 4 and 5 (05:20, 05:30) too
  // new, id 5 is another venue — leaving Gold 05:00 and Oil 05:10, ASCENDING.
  assert.deepEqual(all.map((t) => t.id), [1, 3], 'the window and the venue filter, in time order');
  const gold = await archivedTicks(1, { symbol: 'Gold', since: '2026-09-14T04:30:00Z', until: '2026-09-14T06:00:00Z', dir });
  assert.deepEqual(gold.map((t) => t.id), [1, 4, 5], 'symbol alone: id 5 is Gold on ANOTHER venue, so it belongs');
  const goldPlus = await archivedTicks(1, { symbol: 'Gold', venue: 'plus500', since: '2026-09-14T04:30:00Z', until: '2026-09-14T06:00:00Z', dir });
  assert.deepEqual(goldPlus.map((t) => t.id), [1, 4], 'adding the venue drops the other-venue Gold');
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('a batch whose cutoff is at or before the window is SKIPPED, not read', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-skip-'));
  // Its cutoff is 2026-09-14T05:42Z, so everything it can hold is older than that - a window opening later
  // cannot be answered by it, and reading it would be pure cost on a study that walks 400 batches.
  writeBatch(dir, { from: '2026-09-14T05:42:34.000Z', maxId: 9, rows: [tick(9, 'Gold', '2026-09-14T05:00:00Z')] });
  const none = await archivedTicks(1, { since: '2026-09-20T00:00:00Z', dir });
  assert.deepEqual(none, [], 'a later window must not be served from an older batch');
  const some = await archivedTicks(1, { since: '2026-09-14T04:00:00Z', dir });
  assert.equal(some.length, 1, 'and an earlier window is served');
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('ticksForStudy merges the table and the archive, and DEDUPES by id', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-merge-'));
  writeBatch(dir, {
    from: '2026-09-14T05:42:34.000Z', maxId: 3,
    rows: [tick(1, 'Gold', '2026-09-14T04:00:00Z'), tick(2, 'Gold', '2026-09-14T04:10:00Z'), tick(3, 'Gold', '2026-09-14T04:20:00Z')],
  });
  // Row 3 is in BOTH: the case a prune leaves behind if it archived a batch and then failed to delete it.
  // A duplicated tick is a fabricated path, so the merge must not emit it twice.
  const db = { async ticksSince() { return [tick(3, 'Gold', '2026-09-14T04:20:00Z'), tick(4, 'Gold', '2026-09-14T04:30:00Z')]; } };
  const merged = await ticksForStudy(1, { symbol: 'Gold', since: '2026-09-14T03:00:00Z', until: '2026-09-14T05:00:00Z', db, dir });
  assert.deepEqual(merged.map((t) => t.id), [1, 2, 3, 4], 'table + archive, one copy of each, in time order');
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('a corrupt batch is SKIPPED rather than failing the study', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-corrupt-'));
  fs.writeFileSync(path.join(dir, archiveFileName({ userId: 1, from: '2026-09-14T05:42:34.000Z', to: '2026-09-21T05:42:34.000Z', maxId: 7 })), 'not gzip');
  writeBatch(dir, { from: '2026-09-14T06:00:00.000Z', maxId: 8, rows: [tick(8, 'Gold', '2026-09-14T05:50:00Z')] });
  const rows = await archivedTicks(1, { since: '2026-09-14T05:00:00Z', dir });
  assert.deepEqual(rows.map((t) => t.id), [8], 'the readable batch still answers');
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('archiveCoverage reports the census so a study can SAY it read archived data', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trd92-cov-'));
  writeBatch(dir, { from: '2026-09-14T05:42:34.000Z', maxId: 1, rows: [tick(1, 'Gold', '2026-09-14T05:00:00Z')] });
  writeBatch(dir, { from: '2026-09-14T09:44:53.000Z', maxId: 2, rows: [tick(2, 'Gold', '2026-09-14T09:00:00Z')] });
  writeBatch(dir, { userId: 99, from: '2026-09-14T10:00:00.000Z', maxId: 3, rows: [tick(3, 'Gold', '2026-09-14T09:30:00Z')] });
  const cov = await archiveCoverage(1, { dir });
  assert.equal(cov.batches, 2, "another user's batches are not this user's coverage");
  assert.ok(cov.bytes > 0);
  assert.equal(cov.oldest, '2026-09-14T05:42:34.000Z');
  assert.equal(cov.newest, '2026-09-14T09:44:53.000Z');
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('the live path does NOT read the archive (latency on an armed desk)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'store', 'ticks.js'), 'utf8');
  assert.doesNotMatch(src, /tickArchive/, 'a wake must never open gzip files for data it already has');
});
