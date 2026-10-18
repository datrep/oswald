// trading/lib/crash.js — make the desk's death audible (TRD-40 / implied goal F).
//
// The desk has stopped twice with `trading/server.err.log` SILENT and no exception anywhere:
//   2026-09-12T16:51:54Z  (found during the weekend verification pass)
//   2026-09-12T18:11:54Z  (found 2026-09-13 — roughly an hour after a restart)
// In both cases the operator discovered it by hand, hours later, with nothing to read.
//
// The reason nothing was written:
//   * an uncaught throw in an async context kills the process leaving only a stack trace on
//     a stream nobody tails, and
//   * a process killed from OUTSIDE (SIGKILL, OOM, parent teardown) gets no chance to write
//     anything at all.
//
// This module gives the out-of-process supervisor (`scripts/supervise.js`) something to read,
// and — more importantly — lets it DISTINGUISH the cases:
//
//   exit.json has an exit record      -> it exited, and here is the event, code and reason
//   heartbeat stale, no exit record   -> it was killed abruptly (never got to write)
//   heartbeat fresh, port unresponsive-> the event loop is blocked (hung, not dead)
//
// The third case is invisible to a port probe alone, which is why the heartbeat exists.
//
// POLICY — exceptions do NOT kill the desk. Rationale: this is a DEMO forward book whose
// scarcest resource is SAMPLE SIZE (n=14 closes, and the acceptance criterion wants n>=50).
// Exiting on the first uncaught error costs evidence, and node's own default (exit) is what
// produced the silent stops above. So we log, we page, we count — and we only exit if the
// errors are RECURRING (more than 5 in 10 minutes), which means the process is genuinely
// broken rather than unlucky. REVISIT THIS for a live-money book, where an unknown-state
// process is the bigger risk.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'crash');
const EXIT_FILE = path.join(DIR, 'exit.json');
const HEARTBEAT_FILE = path.join(DIR, 'heartbeat.json');
const HEARTBEAT_MS = 30000;
const REPEAT_WINDOW_MS = 10 * 60000;
const REPEAT_LIMIT = 5;

const startedAt = Date.now();
const recent = [];           // timestamps of recent uncaught errors
let installed = false;

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* best effort */ }
}

// Atomic write: a reader (the supervisor) must never see a half-written file.
function writeJson(file, obj) {
  try {
    ensureDir();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* bookkeeping must never be what kills the process */ }
}

function record(event, extra) {
  return {
    at: new Date().toISOString(),
    event,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
    ...extra,
  };
}

function note(event, extra) {
  const rec = record(event, extra);
  writeJson(EXIT_FILE, rec);
  return rec;
}

function safeTelegram(text) {
  try {
    const { telegramAlert } = require('./http');
    Promise.resolve(telegramAlert(text)).catch(() => { /* optional */ });
  } catch { /* optional */ }
}

function install({ label = 'trading', telegram = true } = {}) {
  if (installed) return;
  installed = true;
  note('start');

  // The heartbeat proves the EVENT LOOP is turning — not merely that the port is bound.
  // unref() so it can never hold the process open at shutdown.
  const hb = setInterval(() => writeJson(HEARTBEAT_FILE, record('heartbeat')), HEARTBEAT_MS);
  if (hb.unref) hb.unref();

  const classify = (err) => {
    const e = err || {};
    return {
      message: String(e.message || e).slice(0, 400),
      stack: String(e.stack || '').split('\n').slice(0, 12).join('\n'),
    };
  };

  const onError = (event, err) => {
    const info = classify(err);
    const rec = note(event, info);
    console.error(`[crash] ${event}: ${info.stack || info.message}`);
    recent.push(Date.now());
    while (recent.length && Date.now() - recent[0] > REPEAT_WINDOW_MS) recent.shift();
    if (telegram) {
      const n = recent.length;
      safeTelegram(`OSWALD ${label}: ${event} — ${info.message.slice(0, 180)}\n(${n} uncaught in the last ${Math.round(REPEAT_WINDOW_MS / 60000)}min; still running — see trading/crash/exit.json)`);
    }
    if (recent.length > REPEAT_LIMIT) {
      // Recurring errors mean an unknown state, not bad luck. Exit loudly; the supervisor
      // will see the exit record and page with the reason.
      note('exit', { code: 1, reason: `recurring ${event} (${recent.length} in ${Math.round(REPEAT_WINDOW_MS / 60000)}min)` });
      if (telegram) safeTelegram(`OSWALD ${label}: EXITING — ${recent.length} ${event} in ${Math.round(REPEAT_WINDOW_MS / 60000)}min. Needs a human.`);
      setTimeout(() => process.exit(1), 400);
    }
    return rec;
  };

  process.on('uncaughtException', (err) => onError('uncaughtException', err));
  process.on('unhandledRejection', (reason) => onError('unhandledRejection', reason));

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      note('signal', { signal: sig });
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
  process.on('exit', (code) => {
    // Only synchronous work is legal here — writeJson is synchronous by design.
    writeJson(EXIT_FILE, record('exit', { code }));
  });
}

module.exports = { install, note, record, paths: { DIR, EXIT_FILE, HEARTBEAT_FILE }, HEARTBEAT_MS };
