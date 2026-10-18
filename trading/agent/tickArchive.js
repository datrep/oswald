// trading/agent/tickArchive.js — TRD-92 (2026-09-21): ARCHIVE BEFORE PRUNE.
//
// THE PROBLEM IT SOLVES. Retention can be raised, but the ticks already past the window are gone, and every
// study that reached for them came back empty: the 2026-09-19 excursion work was bounded by the 7-day
// window ("measure now or lose it"), and TRD-108's backfill had to leave 21 autopsies on a level-derived
// number because their tick paths had aged out. A window answers "how long do I keep this"; it does not
// answer "can I still re-run the study". This module answers the second one: the rows are written to
// compressed JSONL BEFORE they are deleted, so the prune is no longer destructive.
//
// THE ORDER IS THE GUARANTEE, not a comment. Export, then `DELETE ... WHERE id <= <the max id in the file>
// AND capturedAt < <the same cutoff>`. The delete can therefore never remove a row the file does not
// contain — even if ids are not monotonic with `capturedAt` (a backfill can write an old tick with a high
// id), the worst case is that a row survives one extra wake and is picked up by the next prune. Every
// failure path goes the same way: if the export throws, NOTHING is deleted and the reason is returned. The
// cheap wrong answer here is to delete first and archive afterwards, which is the bug with a bow on it.
//
// BATCHING IS DELIBERATE. At the measured ~2,800 rows/day and a ~10-minute wake cadence, ~12 rows fall out
// of the window per wake — one tiny file every 10 minutes, ~1,000 files a week, to say nothing of the
// overhead. So a prune only runs once at least `archiveMinRows` rows are waiting (default 200, i.e. a few
// hours of lag on a 7-day window, and it is recorded as `skipped` rather than being invisible). The
// alternative — archiving every run — trades a bounded, recorded lag for a directory nobody wants to open.
//
// ONE FILE PER BATCH, named by the timestamps it spans, so a plain lexicographic sort of the directory is a
// chronological sort. `archiveMaxFiles` keeps the newest N (0 disables the sweep) so the archive cannot
// become the new unbounded growth — the trap this whole change is meant to avoid, one level down.
//
// THE FILE IS READABLE BY DESIGN. `readArchive` is exported and round-trip tested, because "a study can be
// re-run" is a claim that has to be checkable, not aspirational. Format: one JSON object per line, the
// PriceTicks columns as stored, gzipped.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { resolveTickDays } = require('./retention');

const DEFAULT_ARCHIVE_MIN_ROWS = 200;
const DEFAULT_ARCHIVE_MAX_FILES = 400;
const PAGE_SIZE = 5000;

// Where the batches go: `retention.archiveDir` when set, else trading/archive/ticks.
// (Gitignored — this is runtime data, not source.)
function archiveDirFor(cfg = {}) {
  const dir = cfg && cfg.archiveDir;
  return dir ? path.resolve(String(dir)) : path.join(__dirname, '..', 'archive', 'ticks');
}

function stamp(d) {
  return new Date(d).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

function archiveFileBase({ userId, from, to }) {
  return `ticks-u${userId}-${stamp(from)}_${stamp(to)}`;
}

function archiveFileName({ userId, from, to, maxId }) {
  return `${archiveFileBase({ userId, from, to })}-id${maxId}.jsonl.gz`;
}

function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// ---------------------------------------------------------------------------------------------
// The pure decision: is this prune run worth a file?
// ---------------------------------------------------------------------------------------------
function planPrune({ pending, minRows = DEFAULT_ARCHIVE_MIN_ROWS, archiveEnabled = true } = {}) {
  const n = Number(pending) || 0;
  if (n <= 0) return { archive: false, reason: 'nothing_to_prune' };
  if (!archiveEnabled) return { archive: false, reason: 'archive_disabled' };
  if (n < numOr(minRows, DEFAULT_ARCHIVE_MIN_ROWS)) return { archive: false, reason: 'batch_below_min' };
  return { archive: true, reason: null };
}

// The file a failed export can never leave behind: it is written as `<base>.part` and renamed INTO its final
// name only after the stream has closed cleanly. On NTFS and ext4 that rename is atomic, so the directory
// only ever contains complete archives — a truncated file wearing an archive's name is worse than no file,
// because the next reader would treat it as evidence.
function closeStream(s) {
  return new Promise((res) => {
    // A stream that is destroyed before its open resolves still emits `close`; the timer is belt-and-braces
    // so a wedged handle cannot hang a wake step.
    const t = setTimeout(res, 1000);
    s.once('close', () => { clearTimeout(t); res(); });
    s.destroy();
  });
}

// ---------------------------------------------------------------------------------------------
// Export: page the expiring rows into a gzip stream. Memory stays bounded, so the first prune after a
// window is raised (which can be ~250k rows for 90 days) is not a heap event.
//
// Returns `{ file, rows, maxId, bytes }` — `file` is null when nothing was written.
// ---------------------------------------------------------------------------------------------
async function exportTicks(db, userId, { before, dir, base, pageSize = PAGE_SIZE }) {
  await fs.promises.mkdir(dir, { recursive: true });
  const part = path.join(dir, `${base}.part`);
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(part);
  gz.pipe(out);
  // A write error on EITHER stream must reject the export — otherwise a full disk would be read as a
  // successful archive and the rows would be deleted behind it. That is the one failure this file exists
  // to make impossible.
  const failed = new Promise((_, rej) => { gz.on('error', rej); out.on('error', rej); });
  failed.catch(() => {}); // the awaited chain below is what surfaces it; this only stops an unhandled rejection

  let afterId = 0, rows = 0, maxId = 0;
  try {
    for (;;) {
      const page = await db.listTicksBefore(userId, { before, afterId, limit: pageSize });
      if (!page.length) break;
      for (const t of page) {
        if (!gz.write(JSON.stringify(t) + '\n')) await once(gz, 'drain');
        rows++;
        if (Number(t.id) > maxId) maxId = Number(t.id);
      }
      afterId = Number(page[page.length - 1].id);
      if (page.length < pageSize) break;
    }
    const finished = once(out, 'finish');
    gz.end();
    await Promise.race([finished, failed]);
  } catch (e) {
    gz.destroy();
    await closeStream(out);
    await fs.promises.unlink(part).catch(() => {});
    throw e;
  }
  if (rows === 0) {
    await fs.promises.unlink(part).catch(() => {});
    return { file: null, rows: 0, maxId: 0, bytes: 0 };
  }
  // The name states the boundary the DELETE is bounded by, so the file and the delete cannot disagree.
  const file = path.join(dir, archiveFileName({ userId, from: before, to: new Date(), maxId }));
  const bytes = (await fs.promises.stat(part)).size;
  await fs.promises.rename(part, file);
  return { file, rows, maxId, bytes };
}

// Read a batch back. This is the "a study can be re-run" half of the contract, so it is exported and
// round-trip tested rather than left to whoever opens the directory next.
function readArchive(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  return text.split('\n').filter((l) => l.length).map((l) => JSON.parse(l));
}

// The cutoff a batch file is named by: `ticks-u<userId>-<fromISO>_<toISO>-id<maxId>.jsonl.gz`. The file
// holds every tick that was older than `<fromISO>` when it was written, so a batch whose cutoff is at or
// BEFORE the requested window cannot contain anything inside it.
function cutoffFromName(name) {
  const m = /^ticks-u\d+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)_/.exec(name);
  if (!m) return null;
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// Ticks that are NO LONGER IN THE TABLE, read from the batches. This is what makes a counterfactual study
// re-runnable after its paths have aged out of retention (TRD-92's own demonstration: the TRD-38 re-run that
// could only reconstruct 4 of its 12 trades).
async function archivedTicks(userId, { symbol = null, venue = null, since, until = null, dir = null, limit = null } = {}) {
  const d = dir || archiveDirFor({});
  const sinceT = new Date(since).getTime();
  const untilT = until ? new Date(until).getTime() : Infinity;
  let names;
  try {
    names = (await fs.promises.readdir(d))
      .filter((f) => f.startsWith(`ticks-u${userId}-`) && f.endsWith('.jsonl.gz')).sort();
  } catch { return []; }
  const out = [];
  for (const name of names) {
    const from = cutoffFromName(name);
    if (from == null || from <= sinceT) continue; // everything inside it is older than the window
    let rows;
    try { rows = readArchive(path.join(d, name)); } catch { continue; } // a corrupt batch must not kill the study
    for (const t of rows) {
      const at = new Date(t.capturedAt).getTime();
      if (!(at >= sinceT && at < untilT)) continue;
      if (symbol && t.symbol !== symbol) continue;
      if (venue && t.venue !== venue) continue;
      out.push(t);
      if (limit && out.length >= limit) break;
    }
    if (limit && out.length >= limit) break;
  }
  return out.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
}

// The reader a STUDY should use: the table AND the archive, merged. Drop-in for
// `store.ticksSince(userId, symbol, venue, since, until)`.
//
// ⚠ DELIBERATELY NOT WIRED INTO `store.ticksSince` ITSELF. The live path must never open gzip files during a
// wake — that is latency on an armed desk for data it already has — so this stays an explicit study-time
// call with a study's cost. The merge dedupes by id, which matters if a prune ever archived a batch and then
// failed to delete it: the row would be in both places, and a duplicated tick is a fabricated path.
async function ticksForStudy(userId, { symbol = null, venue = null, since, until = null, db = null, dir = null } = {}) {
  const store = db || require('../store');
  const table = await store.ticksSince(userId, symbol, venue, since, until).catch(() => []);
  const archive = await archivedTicks(userId, { symbol, venue, since, until, dir });
  const seen = new Set(table.map((t) => t.id));
  const merged = [...table];
  for (const t of archive) if (!seen.has(t.id)) { merged.push(t); seen.add(t.id); }
  return merged.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
}

// The batch census, so a study can SAY whether it read archived data rather than implying it — the desk's
// rule that a number must carry where it came from.
async function archiveCoverage(userId, { dir = null } = {}) {
  const d = dir || archiveDirFor({});
  let names = [];
  try {
    names = (await fs.promises.readdir(d)).filter((f) => f.startsWith(`ticks-u${userId}-`) && f.endsWith('.jsonl.gz')).sort();
  } catch { return { dir: d, batches: 0, oldest: null, newest: null, bytes: 0 }; }
  let bytes = 0, oldest = null, newest = null;
  for (const n of names) {
    bytes += await fs.promises.stat(path.join(d, n)).then((s) => s.size).catch(() => 0);
    const cut = cutoffFromName(n);
    if (cut == null) continue;
    if (oldest == null || cut < oldest) oldest = cut;
    if (newest == null || cut > newest) newest = cut;
  }
  return {
    dir: d, batches: names.length, bytes,
    oldest: oldest == null ? null : new Date(oldest).toISOString(),
    newest: newest == null ? null : new Date(newest).toISOString(),
  };
}

// Keep the newest `maxFiles` batches. Names begin with an ISO stamp, so a lexicographic sort is chronological.
async function pruneArchiveFiles(dir, maxFiles = DEFAULT_ARCHIVE_MAX_FILES) {
  const keep = numOr(maxFiles, DEFAULT_ARCHIVE_MAX_FILES);
  if (keep <= 0) return { removed: 0, kept: null };
  let names;
  try { names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl.gz')).sort(); }
  catch { return { removed: 0, kept: null }; }
  const excess = names.slice(0, Math.max(0, names.length - keep));
  for (const f of excess) await fs.promises.unlink(path.join(dir, f)).catch(() => {});
  return { removed: excess.length, kept: names.length - excess.length };
}

// ---------------------------------------------------------------------------------------------
// The orchestration. `store` is injectable so the whole path is testable without SQL.
// ---------------------------------------------------------------------------------------------
async function archiveAndPrune(userId, { settings = null, tickDays, now = new Date(), store = null } = {}) {
  const db = store || require('../store');
  const cfg = ((settings && settings.retention) || {});
  const resolved = tickDays === undefined
    ? resolveTickDays(cfg.tickDays, 'settings')
    : resolveTickDays(tickDays, 'override');
  const days = resolved.days;
  const before = new Date(now.getTime() - days * 86400000);
  const base = {
    days, asked: resolved.asked, source: resolved.source, refused: resolved.refused, note: resolved.note,
    before: before.toISOString(),
  };

  const pending = await db.countTicksBefore(userId, { before });
  if (pending === 0) return { ...base, pending: 0, archived: null, deleted: 0, skipped: 'nothing_to_prune' };

  // Explicit opt-out: the owner asked for the pre-TRD-92 behaviour. Recorded, never inferred.
  if (cfg.archive === false) {
    const deleted = await db.deleteOldTicks(userId, days);
    return { ...base, pending, archived: null, deleted, archiveDisabled: true };
  }

  const plan = planPrune({ pending, minRows: numOr(cfg.archiveMinRows, DEFAULT_ARCHIVE_MIN_ROWS), archiveEnabled: true });
  if (!plan.archive) return { ...base, pending, archived: null, deleted: 0, skipped: plan.reason };

  const dir = archiveDirFor(cfg);
  const fileBase = archiveFileBase({ userId, from: before, to: now });
  let written;
  try {
    written = await exportTicks(db, userId, { before, dir, base: fileBase });
  } catch (e) {
    // NOTHING IS DELETED. The desk keeps its ticks and the reason travels with the result.
    return {
      ...base, pending, archived: null, deleted: 0, refused: 'archive_failed',
      error: String((e && e.message) || e).slice(0, 200),
      note2: 'the prune was SKIPPED so the table keeps the rows it could not archive; the next wake retries',
    };
  }
  if (written.rows === 0) {
    return { ...base, pending, archived: null, deleted: 0, skipped: 'nothing_to_prune' };
  }

  const deleted = await db.deleteTicksThrough(userId, { before, maxId: written.maxId });
  const sweep = await pruneArchiveFiles(dir, numOr(cfg.archiveMaxFiles, DEFAULT_ARCHIVE_MAX_FILES));
  return {
    ...base, pending, deleted,
    archived: { file: written.file, rows: written.rows, bytes: written.bytes, maxId: written.maxId, pruned: sweep.removed },
  };
}

module.exports = {
  archiveAndPrune, planPrune, exportTicks, readArchive, pruneArchiveFiles,
  archivedTicks, ticksForStudy, archiveCoverage, cutoffFromName,
  archiveDirFor, archiveFileBase, archiveFileName,
  DEFAULT_ARCHIVE_MIN_ROWS, DEFAULT_ARCHIVE_MAX_FILES,
};
