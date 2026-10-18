// trading/plus500/browser.js — Chrome CDP browser manager for the Plus500 bridge.
// Pattern: listings/scripts/pull-carousell-insights.js — spawn a REAL Chrome with
// a persistent profile (no automation flags that break Google/OAuth flows) and
// drive it via Playwright connectOverCDP. LibreWolf (BiDi) failed the P0 spike,
// so Chromium is the approved fallback (user decision).
//
// ─── CONTINUITY EDITS 2026-10-11 (laptop continuity run; rationale in docs/10-ARCHITECTURE-NOTES.md) ───
//  1. newPage() refuses while TRADING_PLUS500_DISABLED=1. This is the AUTHORITATIVE sever: every
//     navigable page is obtained through newPage() (capture, webtrader page objects, connector, routes),
//     so one refusal neutralises all goto()/reload()/bringToFront() sites at once (ADR-10).
//     ensureBrowser()/status() stay open so connection health is still inspectable.
//  2. newPage() bounds bringToFront() to 3 s. It never returns when the window is not focusable, which
//     silently stalled EVERY capture with no result and no error (ADR-8). Keep both edits.
'use strict';

const { spawn, execFile, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { getConfig } = require('../config');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, '.chrome-profile');

const state = {
  browser: null,      // playwright Browser (CDP)
  child: null,        // spawned chrome.exe
  port: 0,
  busy: false,
  connects: 0,        // successful (re)connections — 1 on first attach
};

// -------------------------------------------------------------------------------------------------
// RECONNECT NOTIFICATION (2026-09-15).
//
// ★ WHY THIS EXISTS. `ensureBrowser` sets `state.browser = null` when Chrome disconnects, so the next
// `newPage()` builds a BRAND NEW Playwright Browser with brand new Page objects. Any long-lived
// `page.on(...)` listener registered by a consumer is attached to the OLD, dead page and simply stops
// firing — with no error anywhere. `sessionFeed.startTracking()` guarded with `if (state.tracking)
// return`, so it never re-registered: the venue session registry froze permanently the first time
// Chrome blipped. On 2026-09-15 that silence was invisible for hours and, once the stale entries
// expired, the session guard fell through to a corporate-event row and stopped the desk.
//
// A consumer that wants to survive a reconnect subscribes here instead of guarding against re-entry.
const reconnectListeners = new Set();
function onConnect(fn) {
  if (typeof fn !== 'function') return () => {};
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}
function announceConnect(browser) {
  state.connects += 1;
  for (const fn of [...reconnectListeners]) {
    // A listener must not be able to break the connection that just succeeded.
    try { fn(browser, state.connects); } catch (e) { console.warn('[trading.browser] connect listener failed:', e.message || e); }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function debugPort() {
  return Number(getConfig().browser?.debugPort) || 9224;
}

function chromeCandidates() {
  const exe = (getConfig().browser?.executable || process.env.TRADING_BROWSER_EXE || '').trim();
  const local = process.env.LOCALAPPDATA || '';
  const prog = process.env.PROGRAMFILES || 'C:\\Program Files';
  const prog86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const list = [];
  if (exe) list.push(exe);
  list.push(
    path.join(prog, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(prog86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    path.join(prog, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(prog86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  );
  return list.filter(Boolean);
}

function firstExisting(candidates) {
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function tcpUp(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve(false); });
  });
}

// 2026-09-11: 1.5s was too tight on the WinToGo box under load — a healthy
// Chrome answering slowly (e.g. mid-boot, next to a second launcher) must not
// be killed as a "stale port holder" and lose its logged-in tab. 3s to answer.
function httpGetJson(url, timeoutMs = 3000) {
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

// ★ NEVER KILL A HEALTHY CHROME FOR ANSWERING SLOWLY (2026-09-16).
//
// `/json/version` used to get ONE 3s shot. Any slower answer threw, the `catch` fell through, and
// `killPortHolder` TASKKILLED whatever held the debug port — which is the desk's own Chrome. Killing
// it destroys the logged-in session and every open tab, and the desk then relaunches a blank one.
//
// Measured 2026-09-15: the live Chrome tree's root was spawned at 19:14:19Z with THIS file's launch
// arguments and an `about:blank` tab — the exact second a mirror read reported
// `page...has been closed` — while the desk's log shows it only ever "attached to existing Chrome".
// A healthy Chrome was classified as a stale port holder and replaced. The pressure that made the
// probe time out came from connector/browser.js closing the shared handle on every wake (fixed).
//
// A slow answer is NOT evidence of a stale port. So: probe repeatedly with a generous deadline, and
// treat only TWO things as permission to kill — an answer that is definitively not a CDP endpoint,
// and silence across every probe (~16s), which no healthy Chrome on this box produces.
const CDP_PROBE_ATTEMPTS = 3;
const CDP_PROBE_TIMEOUT_MS = 5000;
const CDP_PROBE_GAP_MS = 700;
const CDP_CONNECT_ATTEMPTS = 2;

// Exported for its unit test: the RETRY is the whole point, so it has to be exercisable without a
// real Chrome. A fake endpoint that answers slowly is precisely the regression being pinned.
async function probeExistingCdp(port, opts = {}) {
  const attempts = Number(opts.attempts) || CDP_PROBE_ATTEMPTS;
  const timeoutMs = Number(opts.timeoutMs) || CDP_PROBE_TIMEOUT_MS;
  const gapMs = opts.gapMs == null ? CDP_PROBE_GAP_MS : Number(opts.gapMs);
  const startedAt = Date.now();
  for (let i = 1; i <= attempts; i++) {
    let version = null;
    try {
      version = await httpGetJson(`http://127.0.0.1:${port}/json/version`, timeoutMs);
    } catch { /* timeout / refused / not json — INCONCLUSIVE, never permission to kill on its own */ }
    if (version && version.webSocketDebuggerUrl) return { ok: true, version, attempts: i, waitedMs: Date.now() - startedAt };
    // A well-formed answer WITHOUT a debugger URL is something that is not drivable as CDP.
    if (version) return { ok: false, answered: true, attempts: i, waitedMs: Date.now() - startedAt };
    if (i < attempts && gapMs > 0) await sleep(gapMs);
  }
  return { ok: false, answered: false, attempts, waitedMs: Date.now() - startedAt };
}

async function killPortHolder(port) {
  try {
    const out = await new Promise((resolve) => {
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (e, so) => resolve(String(so || '')));
    });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === port) {
        await new Promise((resolve) => {
          execFile('taskkill', ['/PID', m[2], '/T', '/F'], { windowsHide: true }, () => resolve());
        });
        console.error(`[trading.browser] killed stale port holder pid ${m[2]}`);
      }
    }
    await sleep(500);
  } catch { /* ignore */ }
}

async function connectOrLaunch() {
  const port = debugPort();
  const { chromium } = require('playwright-core');

  // 1. Attach to an existing healthy CDP endpoint on our port.
  if (await tcpUp(port)) {
    const probe = await probeExistingCdp(port);
    if (probe.ok) {
      for (let i = 1; i <= CDP_CONNECT_ATTEMPTS; i++) {
        try {
          const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
          console.error(`[trading.browser] attached to existing Chrome on :${port}`);
          return { browser, launched: false, child: null };
        } catch (e) {
          const msg = String((e && e.message) || e).slice(0, 120);
          if (i >= CDP_CONNECT_ATTEMPTS) console.error(`[trading.browser] CDP endpoint on :${port} answered but the connect failed ${i}× (${msg}) — clearing the holder`);
          else {
            console.error(`[trading.browser] CDP connect attempt ${i} failed on :${port} (${msg}) — retrying`);
            await sleep(1000);
          }
        }
      }
    } else if (probe.answered) {
      console.error(`[trading.browser] port ${port} answered but is NOT a CDP endpoint — clearing the holder`);
    } else {
      console.error(`[trading.browser] port ${port} answered nothing in ${probe.attempts} probe(s) over ${Math.round(probe.waitedMs / 1000)}s — treating the holder as wedged`);
    }
    // Port held by something that is not a healthy CDP endpoint -> clear it and launch fresh.
    await killPortHolder(port);
  }

  // 2. Launch a real Chrome (persistent profile, headful). detached:true +
  // unref() so the browser SURVIVES the caller's exit (it must persist across
  // API calls and serve the whole service lifetime).
  const exe = firstExisting(chromeCandidates());
  if (!exe) throw new Error('no chromium-family browser found (chrome/msedge)');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(exe, [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + PROFILE_DIR,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: false, detached: true });
  child.unref();

  for (let i = 0; i < 120; i++) {
    if (await tcpUp(port)) break;
    await sleep(500);
  }
  const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`).catch(() => null);
  if (!version || !version.webSocketDebuggerUrl) {
    await killPortHolder(port);
    throw new Error('chrome launched but its CDP endpoint did not come up');
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
  console.error(`[trading.browser] launched Chrome on :${port} (profile ${PROFILE_DIR})`);
  return { browser, launched: true, child };
}

// CONTINUITY 2026-10-11: master kill switch for the Plus500 bridge. Every caller that can navigate the
// live WebTrader tab obtains its page here, so refusing in newPage() severs all automated navigation in
// one place (ADR-10). Used by the laptop's capture-only mode; inert in normal desk operation.
function assertEnabled() {
  if (process.env.TRADING_PLUS500_DISABLED === '1') {
    const e = new Error(
      'Plus500 bridge disabled (TRADING_PLUS500_DISABLED=1) — refusing to obtain a page and touch the live session'
    );
    e.bridgeDisabled = true;
    throw e;
  }
}

// Singleton access — one browser for the whole service.
async function ensureBrowser() {
  if (state.browser) {
    try {
      if (state.browser.isConnected()) return state.browser;
    } catch { /* gone */ }
  }
  if (state.busy) {
    // wait for the concurrent launcher
    for (let i = 0; i < 60; i++) {
      if (state.browser) return state.browser;
      await sleep(500);
    }
    throw new Error('browser launch timed out (concurrent)');
  }
  state.busy = true;
  try {
    const { browser, child } = await connectOrLaunch();
    state.browser = browser;
    state.child = child;
    state.port = debugPort();
    browser.on('disconnected', () => {
      console.warn('[trading.browser] Chrome disconnected');
      state.browser = null;
      state.child = null;
    });
    // Announce AFTER the singleton is set, so a listener that immediately calls newPage() gets THIS
    // browser rather than racing the assignment.
    announceConnect(browser);
    return browser;
  } finally {
    state.busy = false;
  }
}

async function newPage() {
  assertEnabled();
  const browser = await ensureBrowser();
  const context = browser.contexts()[0] || (await browser.newContext());
  const pages = context.pages();
  // Prefer the Plus500 tab (there may be stray tabs: about:blank, chrome://extensions);
  // never pick an internal chrome:// page.
  let page = pages.find((p) => /app\.plus500\.com/.test(p.url()))
    || pages.find((p) => !/^chrome:\/\//.test(p.url()))
    || pages[0];
  if (!page) page = await context.newPage();
  // CONTINUITY 2026-10-10: bringToFront() can hang indefinitely when the target window is not
  // focusable (minimised, behind a locked session, another virtual desktop) — that stalled every
  // capture with no result and no error. Activation is a nicety for CDP-driven reads, not a
  // requirement: bound it instead of awaiting it unbounded.
  await Promise.race([
    page.bringToFront().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  return page;
}

// Graceful close: disconnect only (never kill a user session with saved cookies).
//
// ★ CALLERS BEWARE (2026-09-16): "disconnect only" is still enough to break every OTHER consumer of
// this singleton — the handle goes away with it and their Page objects die mid-flight. Nothing in
// the running service may call this: see the SHARED-BRIDGE RULE in connector/browser.js. It is here
// for process shutdown and standalone scripts, and it now says so out loud when it is used.
async function disconnect(why = 'unspecified caller') {
  if (state.browser) console.error(`[trading.browser] disconnect() called by ${why} — closing the SHARED handle (every bridge consumer loses its page)`);
  if (state.browser) {
    try { await state.browser.close(); } catch { /* disconnect only */ }
  }
  state.browser = null;
  state.child = null;
}

function status() {
  return {
    connected: !!(state.browser && (() => { try { return state.browser.isConnected(); } catch { return false; } })()),
    port: state.port || debugPort(),
    profileDir: PROFILE_DIR,
  };
}

// Is a Chrome instance actually listening on the debug port right now?
function chromeAlive() {
  return tcpUp(debugPort());
}

// TRD-46: the bridge's OWN memory footprint, measured at the OS rather than the page.
//
// Why not `page.evaluate(() => performance.memory)`: that reports the JS heap only, and the 875 MB
// renderer the measurement found was DOM/compositor memory, which is exactly the part a reload
// reclaims. Reporting the JS heap would have shown a small number and "proved" there was nothing to
// fix. Why not a bare `tasklist`: it counts EVERY chrome.exe on the machine, so the number would move
// when the user opens their own browser and the before/after of a reload would be meaningless. The
// profile directory is on the command line of every child Chrome spawns, so filtering on it isolates
// this tree without needing the process tree.
//
// Returns null rather than throwing: a measurement must never be able to break the maintenance action
// that wants it. Windows-only, because that is the only place this desk runs.
function profileMemoryMb() {
  if (process.platform !== 'win32') return null;
  const needle = PROFILE_DIR.replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
    + `Where-Object { $_.CommandLine -like '*${needle}*' } | `
    + `ForEach-Object { "$($_.ProcessId)|$($_.WorkingSetSize)|$($_.PrivatePageCount)" }`;
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0 || !r.stdout) return null;
    const rows = r.stdout.trim().split(/\r?\n/).filter(Boolean)
      .map((l) => l.split('|').map((n) => Number(n)))
      .filter((x) => x.length === 3 && Number.isFinite(x[1]));
    if (!rows.length) return null;
    const sum = (i) => Math.round(rows.reduce((s, x) => s + (x[i] || 0), 0) / 1048576);
    return {
      processes: rows.length,
      workingSetMb: sum(1),
      privateMb: sum(2),
      largestMb: Math.round(Math.max(...rows.map((x) => x[1] || 0)) / 1048576),
      at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

module.exports = { ensureBrowser, newPage, disconnect, status, chromeAlive, debugPort, onConnect, PROFILE_DIR, profileMemoryMb, probeExistingCdp };
