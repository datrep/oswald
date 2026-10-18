// fileserver/sync.js — FS-3: one-way mirror sync engine (SYNC-1: direction-aware).
//
// Mirrors a configured source folder to a LOCAL destination (source wins),
// optionally deleting extraneous files (rsync --delete semantics). Fast
// comparison by size + mtime; per-file temp+rename writes so a crash never
// leaves a half-written file; preserves source mtimes (so re-runs see
// "unchanged"); collects per-file errors instead of aborting the whole run.
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');

let running = false;
let lastReport = null;

// Collect every regular file under dir as { rel (posix), abs }.
function walk(dir, rel, files) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of items) {
    if (it.isSymbolicLink()) continue; // skip symlinks — avoids cycles/escapes
    const full = path.join(dir, it.name);
    const r = rel ? `${rel}/${it.name}` : it.name;
    if (it.isDirectory()) walk(full, r, files);
    else files.push({ rel: r, abs: full });
  }
}

// Does the destination need updating? (missing, size differs, mtime differs >1s)
function needsUpdate(srcAbs, dstAbs) {
  if (!fs.existsSync(dstAbs)) return true;
  const s = fs.statSync(srcAbs);
  const d = fs.statSync(dstAbs);
  if (s.size !== d.size) return true;
  return Math.abs(s.mtimeMs - d.mtimeMs) > 1000;
}

async function runSync(direction = 'push') {
  if (running) {
    return { ...(lastReport || {}), skippedDueToRunning: true };
  }
  running = true;
  const startedAt = new Date();
  const c = getConfig();
  const dir = direction === 'collect' ? 'collect' : 'push';
  // push:    canonical resources -> sync area (the tester's working copy)
  // collect: sync area -> canonical resources (the tester's drops land in Oswald)
  // Destructive deletes are Phase B (client-side tombstones); for now BOTH
  // directions are add/update-only. sync.deleteExtraneous (config) is honored
  // for push only, never collect (we never delete the canonical side).
  const source = dir === 'collect' ? c.sync?.destination : c.sync?.source;
  const destination = dir === 'collect' ? c.sync?.source : c.sync?.destination;
  const deleteExtraneous = c.sync?.deleteExtraneous === true && dir === 'push';

  const report = {
    startedAt: startedAt.toISOString(),
    direction: dir,
    source,
    destination,
    added: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    errors: [],
  };

  try {
    if (!source || !destination) throw new Error('sync.source / sync.destination not configured');
    if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) {
      throw new Error('source and destination are the same folder');
    }
    if (!fs.existsSync(source)) throw new Error(`source not found: ${source}`);

    fs.mkdirSync(destination, { recursive: true });

    const srcFiles = [];
    walk(source, '', srcFiles);
    const destSeen = new Set();

    for (const f of srcFiles) {
      const dstAbs = path.join(destination, f.rel.split('/').join(path.sep));
      destSeen.add(f.rel);
      try {
        if (!needsUpdate(f.abs, dstAbs)) {
          report.unchanged++;
          continue;
        }
        const existed = fs.existsSync(dstAbs);
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        const tmp = `${dstAbs}.fs-sync-tmp`;
        fs.copyFileSync(f.abs, tmp);
        const st = fs.statSync(f.abs);
        fs.utimesSync(tmp, st.atime, st.mtime); // preserve source mtime
        fs.renameSync(tmp, dstAbs);
        if (existed) report.updated++;
        else report.added++;
      } catch (err) {
        report.errors.push(`${f.rel}: ${err.message}`);
      }
    }

    if (deleteExtraneous) {
      const removeExtra = (dir, rel) => {
        let items;
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const it of items) {
          const full = path.join(dir, it.name);
          const r = rel ? `${rel}/${it.name}` : it.name;
          if (it.isDirectory()) {
            removeExtra(full, r);
          } else if (!destSeen.has(r)) {
            try {
              fs.unlinkSync(full);
              report.deleted++;
            } catch (err) {
              report.errors.push(`${r}: ${err.message}`);
            }
          }
        }
        try {
          if (rel !== '' && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch { /* ignore */ }
      };
      removeExtra(destination, '');
    }
  } catch (err) {
    report.error = err.message;
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  lastReport = report;
  running = false;
  return report;
}

function getStatus() {
  return { running, lastRun: lastReport, config: getConfig().sync || null };
}

module.exports = { runSync, getStatus };
