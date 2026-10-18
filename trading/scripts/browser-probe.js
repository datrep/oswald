// trading/scripts/browser-probe.js — Phase 0 browser spike (v2).
// Verifies the Trading Agent can drive a REAL headed browser:
//   1. LibreWolf (Firefox family): spawn with --remote-debugging-port, connect
//      via Playwright WebDriver BiDi (firefox.connect over the WebSocket).
//      NOTE: Firefox's remote agent does NOT serve /json/version — readiness is
//      detected by TCP-connecting to the debug port, not by HTTP.
//   2. Fallback (user-approved): Chromium-family (Chrome/Edge) via connectOverCDP.
// Prints a single JSON object to stdout. Exit 0 = drivable, 1 = nothing drivable.
// Diagnostics on stderr. A browser the probe SPAWNED is killed on every path; a browser that was ALREADY
// listening before the probe ran is only read, never killed and never closed (see main()) — this script
// shares the desk bridge's port and profile, so anything else would let a health check take down the very
// browser it is measuring.
'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TRADING_BROWSER_PORT || 9224);
const PROFILE_DIR = process.env.TRADING_BROWSER_PROFILE || path.join(ROOT, '.librewolf-profile');
const CHROME_PROFILE_DIR = path.join(ROOT, '.chrome-profile');
const EXE_ENV = process.env.TRADING_BROWSER_EXE || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('bad json from ' + url)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

async function waitFor(check, tries, delayMs) {
  for (let i = 0; i < tries; i++) {
    try { if (await check()) return true; } catch { /* keep waiting */ }
    await sleep(delayMs);
  }
  return false;
}

// Firefox's remote agent does NOT serve /json/version — detect readiness by TCP.
function tcpUp(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve(false); });
  });
}

async function killChild(child) {
  if (!child) return;
  // Windows: force-kill the whole tree (LibreWolf spawns child processes that
  // survive child.kill() and keep the debug port held).
  await new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
  try { if (!child.killed) child.kill(); } catch { /* ignore */ }
}

// LibreWolf's launcher BREAKS AWAY from the spawned tree — the browser process
// holding the debug port survives taskkill /T on our child. Find whoever
// LISTENs on the port and force-kill it (only browser-named processes).
async function killPortHolder(port) {
  try {
    const out = await new Promise((resolve) => {
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (e, so) => resolve(String(so || '')));
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
    for (const pid of pids) {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true }, () => resolve());
      });
      console.error(`[probe] killed port holder pid ${pid}`);
    }
    await sleep(500);
    return pids.size > 0;
  } catch (e) {
    console.error('[probe] killPortHolder failed:', e.message || e);
    return false;
  }
}

// Firefox/LibreWolf: enable the remote agent (WebDriver BiDi) in this profile.
// LibreWolf's privacy defaults may disable it or leave it CDP-only.
function ensureRemotePrefs(profileDir) {
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    const prefsFile = path.join(profileDir, 'user.js');
    const prefs = [
      'user_pref("remote.enabled", true);',
      'user_pref("remote.agent.enabled", true);',
      'user_pref("remote.active-protocols", 1);',
      'user_pref("remote.fission.enabled", false);',
      'user_pref("webdriver.bidi.log.level", "Warn");',
      'user_pref("browser.tabs.remote.autostart", true);',
    ].join('\n') + '\n';
    if (!fs.existsSync(prefsFile) || fs.readFileSync(prefsFile, 'utf8').trim() !== prefs.trim()) {
      fs.writeFileSync(prefsFile, prefs);
      return true;
    }
    return false;
  } catch (e) {
    console.error('[probe] user.js prefs write failed:', e.message || e);
    return false;
  }
}

function firstExisting(candidates) {
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function libreWolfCandidates() {
  const local = process.env.LOCALAPPDATA || '';
  const list = [];
  if (EXE_ENV) list.push(EXE_ENV);
  list.push(
    'C:\\Program Files\\LibreWolf\\librewolf.exe',
    'C:\\Program Files (x86)\\LibreWolf\\librewolf.exe',
    local ? path.join(local, 'LibreWolf', 'librewolf.exe') : '',
  );
  return list;
}

function chromiumCandidates() {
  const local = process.env.LOCALAPPDATA || '';
  const prog = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const prog86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const list = [];
  if (EXE_ENV) list.push(EXE_ENV);
  list.push(
    path.join(prog, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(prog86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    path.join(prog, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(prog86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  );
  return list;
}

// --- LibreWolf (BiDi) ---------------------------------------------------------
async function tryLibreWolf() {
  const exe = firstExisting(libreWolfCandidates());
  if (!exe) return { ok: false, error: 'librewolf.exe not found' };
  let child = null;
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    ensureRemotePrefs(PROFILE_DIR);
    child = spawn(exe, [
      '--remote-debugging-port=' + PORT,
      '--new-instance',
      '-profile', PROFILE_DIR,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: false, detached: false });

    // Firefox's remote agent doesn't serve /json/version — readiness = TCP connect.
    const up = await waitFor(() => tcpUp(PORT), 120, 500); // up to 60s cold start
    if (!up) return { ok: false, error: 'LibreWolf launched but its debug port never opened (TCP ' + PORT + ' closed)' };

    const { firefox } = require('playwright-core');
    let browser = null;
    let endpointUsed = '';
    for (const ws of [`ws://127.0.0.1:${PORT}/session`, `ws://127.0.0.1:${PORT}`]) {
      try {
        browser = await firefox.connect(ws, { timeout: 10000 });
        endpointUsed = ws;
        break;
      } catch (e) {
        console.error(`[probe] firefox.connect ${ws} failed: ${e.message || e}`);
      }
    }
    if (!browser) return { ok: false, error: 'LibreWolf debug port opened but Playwright BiDi connect failed on all endpoints' };

    // Prove it actually drives: open a page and read a value.
    let evidence = '';
    try {
      const page = await browser.newPage();
      await page.setContent('<title>bidi-ok</title><p>probe</p>', { waitUntil: 'load' });
      evidence = await page.title();
      await page.close();
    } catch (e) {
      console.error(`[probe] page smoke failed: ${e.message || e}`);
    }

    const result = { ok: true, engine: 'bidi', browser: 'librewolf', exe, endpoint: endpointUsed, evidence };
    try { await browser.close(); } catch { /* disconnect only */ }
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  } finally {
    await killChild(child);
  }
}

// --- Chromium fallback (CDP) --------------------------------------------------
async function tryChromium(preexisting = false) {
  const exe = firstExisting(chromiumCandidates());
  if (!exe) return { ok: false, error: 'no chromium-family browser found (chrome/msedge)' };
  let child = null;
  try {
    fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
    child = spawn(exe, [
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + CHROME_PROFILE_DIR,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: false, detached: false });

    const up = await waitFor(() => tcpUp(PORT), 120, 500);
    if (!up) return { ok: false, error: 'chromium launched but its debug port never opened' };
    const versionInfo = await httpGetJson(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
    if (!versionInfo) return { ok: false, error: 'chromium debug port opened but /json/version unavailable' };

    const { chromium } = require('playwright-core');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 });
    let evidence = '';
    try {
      const page = await browser.newPage();
      await page.setContent('<title>cdp-ok</title><p>probe</p>', { waitUntil: 'load' });
      evidence = await page.title();
      await page.close();
    } catch (e) {
      console.error(`[probe] page smoke failed: ${e.message || e}`);
    }

    const result = { ok: true, engine: 'cdp', browser: 'chromium', exe, evidence, reused: preexisting };
    // ★ CLOSING A BROWSER WE DID NOT LAUNCH IS HOW THIS PROBE KILLED THE DESK. This script uses the desk
    // bridge's own port (9224) and profile, so when the desk's Chrome is already up the spawn above cannot
    // take the port, `tcpUp()` succeeds AGAINST THE DESK'S BROWSER, and connectOverCDP attaches to it. The
    // cleanup then shut that browser down and the desk lost its venue feed. Only a browser this probe
    // actually started is the probe's to close.
    if (!preexisting) {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
      await sleep(800);
    }
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  } finally {
    await killChild(child);
  }
}

async function main() {
  // ★ WHOSE BROWSER IS IT? (2026-09-15) This probe uses the SAME port (9224) and the SAME profile
  // (.chrome-profile) as the live desk bridge, which makes every 'cleanup' step a loaded gun:
  //
  //   - `killPortHolder(PORT)` taskkilled whatever held 9224 — which is the DESK'S Chrome whenever the
  //     desk is running, i.e. the normal case. `routes.js` records the bridge 'losing its life' to exactly
  //     this cleanup (2026-09-12).
  //   - `Browser.close` in tryChromium then shut down the browser it had just attached to.
  //
  // So a health check could take down the thing it was measuring, and the desk was left to relaunch and
  // re-attach. The rule now: a browser that was ALREADY LISTENING before this probe started is READ, never
  // killed, never closed. Only what the probe itself created is the probe's to destroy.
  const preexisting = await tcpUp(PORT);
  const result = await tryLibreWolf();
  if (result.ok) {
    process.stdout.write(JSON.stringify({ ...result, fallback: false, reused: preexisting }));
    process.exit(0);
  }
  console.error(`[probe] LibreWolf failed: ${result.error}`);
  // LibreWolf orphans can survive the tree kill — but only when LibreWolf was actually started here. If
  // something was already on the port it is NOT ours to clear.
  if (!preexisting) await killPortHolder(PORT);
  await sleep(1500);
  const fb = await tryChromium(preexisting);
  process.stdout.write(JSON.stringify({ ...fb, fallback: true, libreWolfError: result.error }));
  process.exit(fb.ok ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
  process.exit(1);
});
