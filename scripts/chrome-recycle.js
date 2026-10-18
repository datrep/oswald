'use strict';
// scripts/chrome-recycle.js — 2026-10-18 (owner approved: "Chrome memory ok").
//
// WHAT: a guarded, at-most-once-per-24h CHROME SWAP for the desk's own browser profile. Measured history:
// memory climbs to a ~4.8 GB crash zone over days (hourly ops samples), and the only thing that reclaims it
// is the swap SOP — a reload does NOT (measured −544 MB of 3.8 GB, 10-04). This automates exactly the SOP the
// desk has used by hand many times: STOP THE DESK FIRST -> kill the profile's Chrome tree -> start the desk
// (it launches Chrome itself, fresh). Killing Chrome under a LIVE desk is the known crash class, which is why
// the desk is stopped first, never after.
//
// GUARDS (all must hold, and any doubt = do nothing):
//   1. venue-quiet: the newest wake event is a `market_closed` skip no older than 30 min (ground truth from
//      the desk's own calendar, not a local-time guess);
//   2. no wake in flight: that newest wake is >= 60 s old (a scheduled wake can start any moment);
//   3. desk healthy: /healthz answers ok, so the restart path is the predictable one;
//   4. profile memory >= THRESHOLD_GB (default 3.5) for THIS check (the lane runs every 15 min, so a spike
//      that passes is caught on a later run rather than acted on immediately);
//   5. not already recycled in the last 24 h (state file logs/chrome-recycle-state.json).
// A failed swap attempt is recorded and does NOT retry within 6 h (a flapping profile must not thrash).
//
// USAGE: node scripts/chrome-recycle.js            (normal scheduled check)
//        node scripts/chrome-recycle.js --force    (bypass ONLY the memory threshold + 24h state; used to
//                                                   prove the mechanism; venue/in-flight/health guards stay)
//        node scripts/chrome-recycle.js --dry-run  (report what WOULD happen)

const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const THRESHOLD_GB = Number(process.env.CHROME_RECYCLE_GB) || 3.5;
const STATE_FILE = path.join(ROOT, 'logs', 'chrome-recycle-state.json');
const LOG_FILE = path.join(ROOT, 'logs', 'chrome-recycle.log');
const RESTART = path.join(ROOT, 'trading', 'scripts', 'restart-trading.ps1');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');

function log(line) {
  const msg = `${new Date().toISOString()}  ${line}`;
  try { fs.appendFileSync(LOG_FILE, msg + '\r\n'); } catch { /* logging must never throw */ }
  console.log(msg);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2)); } catch { /* ignore */ }
}

function psJson(script) {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  const t = String(out).trim();
  return t ? JSON.parse(t) : null;
}

// Sum working set (bytes) of chrome processes using the DESK's profile only — the owner's own browser is
// a different profile and is never touched.
function profileMemoryBytes() {
  const j = psJson(
    "$p = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*chrome-profile*' }; " +
    "@{ count = @($p).Count; bytes = [int64](($p | Measure-Object -Property WorkingSetSize -Sum).Sum) } | ConvertTo-Json -Compress"
  );
  return j ? { count: Number(j.count) || 0, bytes: Number(j.bytes) || 0 } : { count: 0, bytes: 0 };
}

function healthz() {
  return new Promise((resolve) => {
    const req = require('http').get('http://127.0.0.1:8115/healthz', { timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(res.statusCode === 200 && /^ok/.test(b)));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function newestWake() {
  const store = require(path.join(ROOT, 'trading', 'store'));
  const ev = await store.latestEvent(1, 'wake');
  if (!ev) return null;
  const p = ev.payload || ev;
  const at = new Date(ev.createdAt || p.at || 0).getTime();
  const detail = String(p.detail || '');
  return { at, ageMs: Date.now() - at, skipped: String(p.skipped || ''), marketClosed: /market_closed/.test(String(p.skipped || '')) || /all 10 venues closed/.test(detail) };
}

function telegram(text) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return;
    const body = JSON.stringify({ chat_id: chat, text });
    const req = https.request({ host: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body); req.end();
  } catch { /* notifications are best-effort */ }
}

function stopDesk() {
  const j = psJson(
    "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*trading\\server.js*' }; " +
    "@($p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }) | ConvertTo-Json -Compress"
  );
  const pids = j == null ? [] : (Array.isArray(j) ? j : [j]);
  return pids;
}

function killProfileChrome() {
  const j = psJson(
    "$p = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*chrome-profile*' }; " +
    "@($p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }) | ConvertTo-Json -Compress"
  );
  const pids = j == null ? [] : (Array.isArray(j) ? j : [j]);
  return pids;
}

(async () => {
  const state = readState();
  const mem = profileMemoryBytes();
  const gb = mem.bytes / (1024 ** 3);
  const base = { memGb: Number(gb.toFixed(2)), chromeProcs: mem.count };

  if (!FORCE && state.lastRecycleAt && Date.now() - new Date(state.lastRecycleAt).getTime() < 24 * 3600 * 1000) {
    log(`skip: recycled within 24h (last ${state.lastRecycleAt}); mem ${base.memGb} GB`);
    return process.exit(0);
  }
  if (state.lastFailureAt && Date.now() - new Date(state.lastFailureAt).getTime() < 6 * 3600 * 1000 && !FORCE) {
    log(`skip: a swap failed ${state.lastFailureAt}; not retrying within 6h`);
    return process.exit(0);
  }
  if (!FORCE && gb < THRESHOLD_GB) {
    log(`skip: profile memory ${base.memGb} GB below ${THRESHOLD_GB} GB (${mem.count} procs)`);
    return process.exit(0);
  }

  const wake = await newestWake();
  if (!wake || !wake.marketClosed || wake.ageMs > 30 * 60 * 1000) {
    log(`skip: not venue-quiet (newest wake ${wake ? `${wake.skipped || 'n/a'} @ ${new Date(wake.at).toISOString()}` : 'none'})`);
    return process.exit(0);
  }
  if (wake.ageMs < 60 * 1000) {
    log(`skip: a wake fired ${Math.round(wake.ageMs / 1000)}s ago — too close to a scheduled wake`);
    return process.exit(0);
  }
  if (!(await healthz())) {
    log('skip: desk healthz not ok — the service watchdog owns that failure, not this lane');
    return process.exit(0);
  }

  log(`SWAP ${DRY ? '(dry-run) ' : ''}starting: profile ${base.memGb} GB across ${mem.count} procs; newest wake ${wake.skipped} @ ${new Date(wake.at).toISOString()}`);
  if (DRY) return process.exit(0);

  try {
    const deskPids = stopDesk();
    log(`desk stopped pid(s): ${deskPids.join(', ') || '(none found)'}`);
    const chromePids = killProfileChrome();
    log(`profile Chrome killed pid(s): ${chromePids.length}`);
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RESTART], { stdio: 'ignore', cwd: ROOT });
    await new Promise((r) => setTimeout(r, 6000));
    const ok = await healthz();
    const after = profileMemoryBytes();
    const afterGb = Number((after.bytes / (1024 ** 3)).toFixed(2));
    if (!ok) throw new Error('desk did not answer healthz after restart');
    writeState({ lastRecycleAt: new Date().toISOString(), beforeGb: base.memGb, afterGb, chromeProcsAfter: after.count });
    log(`SWAP done: ${base.memGb} GB -> ${afterGb} GB (${after.count} procs); desk healthy`);
    telegram(`Oswald: Chrome recycled (quiet hour) — profile memory ${base.memGb} GB -> ${afterGb} GB. Desk restarted and healthy; the venue session survives this by design.`);
    process.exit(0);
  } catch (e) {
    writeState({ lastFailureAt: new Date().toISOString(), error: String(e.message || e).slice(0, 200) });
    log(`SWAP FAILED: ${e.message}`);
    telegram(`Oswald: Chrome recycle FAILED at ${new Date().toISOString()} — ${String(e.message || e).slice(0, 160)}. The service watchdog owns recovery; check logs/chrome-recycle.log.`);
    process.exit(1);
  }
})();
