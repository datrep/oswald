// utils/apiLogger.js
// Internal API request logging (#58) — shared by the Oswald dashboard AND the
// fileserver (each process passes its own DB writer so the pool comes from the
// right place).
//
// What it does:
//   - On every matching request it writes one row to ApiLogs (DB, keep-all)
//   - Appends the same line to logs/active-api.<source>.log
//   - On startup, archivePreviousSession(source) zips the PREVIOUS session's
//     active file into logs/archive/<source>-<timestamp>.zip and starts a fresh
//     active file, so each run = one dated, archived session.
//
// FUTURE SCOPE: if the project scope expands, this module is where richer
// logging belongs — structured JSON lines, log levels, route categories,
// configurable retention/pruning, a real log-viewer UI, or shipping to an
// external sink (ELK/Datadog). Keep new observability here so both services
// benefit without duplicating middleware.

const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const archiver = require('archiver');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const ARCHIVE_DIR = path.join(LOG_DIR, 'archive');

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

// Active file is scoped by source + PORT so multiple server instances on one
// machine (e.g. production :8080 and the smoke-test :4099) never write the same
// file concurrently.
function activeFile(source) {
  const port = process.env.PORT ? `.${process.env.PORT}` : '';
  return path.join(LOG_DIR, `active-api.${source}${port}.log`);
}

// Zip the previous session's active file into logs/archive/ (dated) and reset.
// Called once per process at startup. Never throws — archiving is best-effort.
async function archivePreviousSession(source) {
  ensureDirs();
  const active = activeFile(source);
  try {
    const st = await fsp.stat(active);
    if (!st.size) {
      await fsp.unlink(active).catch(() => {});
      return;
    }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const port = process.env.PORT ? `.${process.env.PORT}` : '';
    const outPath = path.join(ARCHIVE_DIR, `${source}${port}-${stamp}.zip`);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.file(active, { name: path.basename(active) });
      archive.finalize();
    });
    await fsp.unlink(active).catch(() => {});
    console.log(`[apiLogger] Archived previous ${source} session -> ${path.basename(outPath)}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[apiLogger] archive failed:`, err.message);
  }
}

// Best-effort append to the active session file. Logging must never throw.
function appendToFile(source, line) {
  try {
    ensureDirs();
    fs.appendFileSync(activeFile(source), line + '\n');
  } catch { /* ignore */ }
}

// Express middleware factory.
//   source  - 'dashboard' | 'fileserver'
//   labelFor - (req) => string used for the [bracket:tag] prefix
//   writeLog - (record) => Promise; injected DB writer (dashboard vs fileserver pool)
// High-frequency polling endpoints are skipped on success only (failures still
// logged) so the log stays about real traffic.
const SKIP_URLS_ON_SUCCESS = new Set(['/api/health', '/api/ips/check', '/api/fs/config']);
function apiLogger({ source, labelFor, writeLog }) {
  return function apiLoggerMw(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
      const url = req.originalUrl || req.url;
      // Only the API surface — static assets (css/js/img/html) would spam it.
      if (!/^\/(api|edicts)\//.test(url.split('?')[0])) return;
      const pathOnly = url.split('?')[0];
      if (res.statusCode < 400 && SKIP_URLS_ON_SUCCESS.has(pathOnly)) return;
      const durationMs = Date.now() - start;
      const label = labelFor ? labelFor(req) : source;
      const line = `[${label}] ${req.method} ${url} ${res.statusCode} ${durationMs}ms`;
      console.log(line);
      appendToFile(source, line);
      const record = {
        source,
        label,
        method: req.method,
        path: url.slice(0, 500),
        status: res.statusCode,
        durationMs,
        userId: req.user ? req.user.userID ?? req.user.id ?? null : null,
      };
      if (writeLog) writeLog(record).catch(() => {});
    });
    next();
  };
}

module.exports = { apiLogger, archivePreviousSession, LOG_DIR, ARCHIVE_DIR };
