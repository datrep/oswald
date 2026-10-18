// trading/agent/watchdog.js — zombie watchdog (TRD-8).
// The agent is "unattended automation with a Telegram pager". This module
// catches the failure modes that DON'T throw errors:
//   1. Plus500 login-death  — the session silently expired / got signed out.
//      The bridge keeps "working" (pages load) but nothing is tradable.
//   2. Waker zombie          — the wake loop stopped completing cycles
//      (stuck capture, hung LLM call, blocked timer).
// On each transition it sends a human-readable Telegram alert ONCE (with
// cooldowns) and logs a TradingEvent. No auto-healing beyond reporting —
// the operator decides.
'use strict';

const store = require('../store');
const { telegramAlert } = require('../lib/http');
const { loginDeathText, loginRecoveredText, staleWakerText } = require('./alerts');

const state = {
  running: false,
  lastRunAt: null,
  login: { alive: null, lastCheckedAt: null, alertSentAt: null },
  waker: { lastAlertAt: null },
};

function status() {
  return { ...state, timer: undefined };
}

function settingsOf(settings) {
  const w = settings.watchdog || {};
  return {
    enabled: w.enabled !== false,
    loginCheckMinutes: Math.max(1, Number(w.loginCheckMinutes) || 5),
    staleWakeFactor: Math.max(2, Number(w.staleWakeFactor) || 3),
    telegram: w.telegram !== false,
    loginRealertMinutes: Math.max(5, Number(w.loginRealertMinutes) || 30),
    staleRealertMinutes: Math.max(15, Number(w.staleRealertMinutes) || 60),
  };
}

// A wake cycle in flight? Never open browser pages under it.
async function wakeInProgress() {
  try {
    const waker = require('./waker');
    return !!waker.status().inProgress;
  } catch {
    return false;
  }
}

// --- 1. Plus500 login-death check -------------------------------------------
// Pure decision, so the policy is pinned by tests instead of only being observed in production.
//
// Deliberately ASYMMETRIC about evidence:
//   - a POSITIVE in-place read is TRUSTED — the account banner is rendered, so the session is alive;
//   - a NEGATIVE is NOT trusted, because isLoggedIn looks for that banner and any route that does
//     not render it reads as "signed out" — and this module PAGES THE OWNER on that verdict.
// A false login-death alert costs more than a navigation, so only a definitive true short-circuits.
// ★ THE WATCHDOG MUST NEVER STARVE A FEED (2026-09-17).
//
// This is a periodic login ping whose next attempt is ~5 minutes away, so it may SKIP and it must
// never hold the shared tab for long. `tryAcquire` below already delivers the skipping half. What it
// did not bound was the HOLD: `gotoPage`'s worst case is `timeout*2 + content*2` = 45+15+45+15 = 120s,
// which is EXACTLY the capture's `waitMs: 120000` — so a page that rendered slowly took the bridge for
// the full budget of the desk's own market-data feed, every 5 minutes, and the feed starved:
//   telemetry { source: 'plus500_frontend', captured: 0, reason: 'bridge busy (watchdog) - lock wait exceeded for capture' }
// Observed for ~16 h on 2026-09-16/17, with the desk continuing to trade on the frozen data.
//
// The budget below keeps the worst-case hold at 2*12000 + 2*4000 = 32s, comfortably inside the
// capture's wait. The invariant is pinned by test/watchdog-hold-budget.test.js, which reads BOTH files
// so the two numbers cannot drift apart again.
const WATCHDOG_NAV_TIMEOUT_MS = 12000;
const WATCHDOG_CONTENT_WAIT_MS = 4000;
// ★ THE SETTLE BUDGET (2026-10-03). After the verify navigation the page may still be mid-boot for a
// few seconds (see webtrader.waitForLogin's header). Polling that window costs time but buys the
// thing this module exists for — no false login-death page. Budget arithmetic (pinned by
// test/watchdog-hold-budget.test.js): 2*12000 + 2*4000 + 8000 = 40000 ms, still far under the
// capture's 120000 ms wait, so a slow verify can never starve the feed.
const WATCHDOG_SETTLE_WAIT_MS = 8000;

function decideLoginCheck({ fastLoggedIn, hardKill }) {
  if (fastLoggedIn) return { action: 'report_alive', reason: 'in_place_read' };
  if (hardKill) return { action: 'skip', reason: 'kill_switch_hard_unverified' };
  return { action: 'navigate', reason: 'negative_needs_verification' };
}

async function checkLogin(userId, settings) {
  const browser = require('../plus500/browser');
  const webtrader = require('../plus500/webtrader');
  const pageLock = require('../plus500/pageLock');
  state.login.lastCheckedAt = new Date().toISOString();
  if (!(await browser.chromeAlive())) return { skipped: 'chrome_off' };

  const hardKill = !!(settings && settings.kill && settings.kill.tier === 'hard');

  // SKIP, never wait — the same policy the mirror poller uses. The check is periodic (the next one is
  // ~5 minutes away), so queueing behind a capture or a ticket buys nothing and delays the thing that
  // actually matters. This is the half of TRD-47 that protects a live ticket: without it, a 5-minute
  // timer could navigate the shared tab in the middle of a set-limits flow.
  if (!pageLock.tryAcquire('watchdog')) {
    return { skipped: 'bridge_busy', heldBy: pageLock.status().holder };
  }
  try {
    const page = await browser.newPage();

    // READ BEFORE YOU MOVE (TRD-47). The old version navigated to /trade unconditionally every 5
    // minutes. That silently reverted every operator navigation, destroyed three consecutive
    // instrument-probe reads, and could yank the shared tab out from under a live ticket. The
    // question can normally be answered from the page already loaded, and in normal desk operation
    // the mirror poller has parked that page on /open-positions — so the common case now navigates
    // ZERO times.
    const fastLoggedIn = await webtrader.isLoggedIn(page).catch(() => false);
    const plan = decideLoginCheck({ fastLoggedIn, hardKill });

    if (plan.action === 'report_alive') return { loggedIn: true, mode: 'in_place' };
    if (plan.action === 'skip') {
      // Hard kill = zero bridge navigation, and we must NOT page on an unverified negative.
      // So report NO VERDICT rather than a guess — reactToLogin() ignores anything with `skipped`.
      return { skipped: plan.reason };
    }

    const navStartedAt = Date.now();
    const landed = await webtrader.gotoPage(page, 'trade', settings, {
      timeoutMs: WATCHDOG_NAV_TIMEOUT_MS,
      contentWaitMs: WATCHDOG_CONTENT_WAIT_MS,
    });
    if (landed.loggedIn) return { loggedIn: true, mode: 'navigated', heldMs: Date.now() - navStartedAt };
    // ★ A NEGATIVE ON A PAGE THAT HAS NOT FINISHED RENDERING IS NOT A DEATH VERDICT (2026-10-03).
    // The navigation above OPENS a fresh SPA boot window (~2-3 s of empty innerText); the read after
    // `gotoPage` can land inside it exactly as the in-place read landed in the mirror's own window.
    // Without this wait, `loggedIn:false` reaches reactToLogin and PAGES THE OWNER on a coin flip of
    // render timing (measured false pages on 2026-10-03; docs/incident-2026-10-03-false-login-death.md).
    // `waitForLogin` resolves the three outcomes; only a SETTLED page without account evidence is a
    // logout, and a page that never settles is a known transient state (`blank_render`), reported as
    // a SKIP so neither a death nor a recovery is recorded for it.
    const settled = await webtrader.waitForLogin(page, { timeoutMs: WATCHDOG_SETTLE_WAIT_MS });
    if (settled.loggedIn) return { loggedIn: true, mode: 'navigated_settled', heldMs: Date.now() - navStartedAt, settleWaitMs: settled.waitedMs };
    if (!settled.settled) return { skipped: 'blank_render', bodyLen: settled.bodyLen, heldMs: Date.now() - navStartedAt };
    return { loggedIn: false, mode: 'navigated_settled', heldMs: Date.now() - navStartedAt, settleWaitMs: settled.waitedMs, bodyLen: settled.bodyLen };
  } catch (e) {
    // Connection errors are health.js' job — the watchdog only pages on
    // a CLEAN page load that shows no account.
    const err = e || {};
    return { skipped: err.connError ? 'connection_error' : 'check_error', error: String(err.message || e).slice(0, 120) };
  } finally {
    pageLock.release('watchdog');
  }
  // NOTE: NO browser.disconnect() here — the 1s/60s mirror pollers own the
  // persistent bridge connection; disconnecting killed their page handles
  // every watchdog cycle ("Target page has been closed" + empty reads).
}

async function reactToLogin(userId, settings, cfg, result) {
  if (result.skipped) return;
  const prev = state.login.alive;
  state.login.alive = result.loggedIn;

  if (result.loggedIn === false) {
    await store.logEvent(userId, 'watchdog_login_death', { detail: 'plus500 signed out' });
    const since = state.login.alertSentAt ? Date.now() - new Date(state.login.alertSentAt).getTime() : Infinity;
    if (cfg.telegram && since > cfg.loginRealertMinutes * 60000) {
      state.login.alertSentAt = new Date().toISOString();
      try { await telegramAlert(loginDeathText()); } catch { /* telegram optional */ }
    }
  } else if (result.loggedIn === true && prev === false && state.login.alertSentAt) {
    // We had paged about a login death — tell the operator it's fixed.
    await store.logEvent(userId, 'watchdog_login_recovered', {});
    if (cfg.telegram) {
      try { await telegramAlert(loginRecoveredText()); } catch { /* telegram optional */ }
    }
    state.login.alertSentAt = null;
  }
}

// --- 2. Waker-zombie check ---------------------------------------------------
// WHICH CLOCK DOES THE DEAD-MAN SWITCH WATCH? (TRD-51 fix 3, 2026-09-14)
//
// It used to watch `status().lastWakeAt`, and wakePipeline.finishWake() advances that in a
// `finally` — so a wake that THREW reset the very clock that exists to notice it. Measured
// on 2026-09-14: eight consecutive wakes died (09:37:45 -> 13:05:38 SGT, all `bars_build`
// ETIMEOUT, holding a live Gold position) and the age the watchdog compared against
// maxGapMin was ~10 minutes throughout. It only paged at 12:07 because ONE pair of
// consecutive ATTEMPTS happened to straddle 86 minutes; the message then arrived four hours
// in and UNDERSTATED the outage.
//
// The baseline is therefore the last SUCCESSFUL wake, falling back to the first attempt when
// there has never been one — otherwise a desk that failed every wake since boot would read
// `no_wake_yet` and stay silent. Pure, so the policy is pinned by tests rather than only
// observed in production.
function wakerStaleness({ lastWakeAt = null, lastSuccessAt = null, startedAt = null, now = Date.now() } = {}) {
  const ms = (t) => {
    if (!t) return null;
    const v = new Date(t).getTime();
    return Number.isFinite(v) ? v : null;
  };
  const attemptAt = ms(lastWakeAt);
  const successAt = ms(lastSuccessAt);
  const startMs = ms(startedAt);
  const baselineAt = successAt != null ? successAt : startMs;
  const ageMin = baselineAt == null ? null : (now - baselineAt) / 60000;
  return {
    // null means "nothing to measure yet" — the caller must NOT treat that as healthy.
    ageMin,
    baselineAt,
    baselineKind: successAt != null ? 'last_success' : (startMs != null ? 'waker_start' : 'none'),
    neverSucceeded: successAt == null,
    successAgeMin: successAt == null ? null : (now - successAt) / 60000,
    // Reported alongside so the operator sees the distinction the old code hid: "we tried
    // 2 minutes ago and we last WORKED 4 hours ago" is the whole diagnosis.
    attemptAgeMin: attemptAt == null ? null : (now - attemptAt) / 60000,
  };
}

async function checkWaker(userId, settings, cfg) {
  const waker = require('./waker');
  const ws = waker.status();
  if (!ws.running) return { skipped: 'waker_off' };
  const clock = wakerStaleness({
    lastWakeAt: ws.lastWakeAt,
    lastSuccessAt: ws.lastSuccessAt,
    startedAt: ws.startedAt,
  });
  if (clock.ageMin == null) return { skipped: 'no_wake_yet' };
  const intervalMin = Number(settings.wake?.intervalMinutes) || 10;
  const maxGapMin = intervalMin * (1 + (Number(settings.wake?.jitterPct) || 30) / 100) * cfg.staleWakeFactor;
  // The verdict is on the SUCCESS clock only. A recent failed attempt is not evidence of
  // health and must not soften the alarm.
  if (clock.ageMin <= maxGapMin) return { ok: true, ageMin: clock.ageMin, ...clock };
  await store.logEvent(userId, 'watchdog_waker_stale', {
    ageMin: clock.ageMin, maxGapMin,
    baselineKind: clock.baselineKind,
    neverSucceeded: clock.neverSucceeded,
    attemptAgeMin: clock.attemptAgeMin,
    successAgeMin: clock.successAgeMin,
    // Kept for continuity with existing rows: the old field name meant "age of lastWakeAt",
    // and that is still what went wrong when someone reads an old row.
    lastWakeAt: ws.lastWakeAt,
    lastSuccessAt: ws.lastSuccessAt,
  });
  const since = state.waker.lastAlertAt ? Date.now() - new Date(state.waker.lastAlertAt).getTime() : Infinity;
  if (cfg.telegram && since > cfg.staleRealertMinutes * 60000) {
    state.waker.lastAlertAt = new Date().toISOString();
    try { await telegramAlert(staleWakerText(clock.ageMin, intervalMin, clock)); } catch { /* telegram optional */ }
  }
  return { stale: true, ageMin: clock.ageMin, maxGapMin, ...clock };
}

// --- cycle --------------------------------------------------------------------
async function runChecks(userId) {
  if (process.env.TRADING_SMOKE === '1') return { skipped: 'smoke_mode' };
  const settings = await store.getSettings(userId);
  const cfg = settingsOf(settings);
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (await wakeInProgress()) return { skipped: 'wake_in_progress' };
  state.lastRunAt = new Date().toISOString();
  const login = await checkLogin(userId, settings);
  await reactToLogin(userId, settings, cfg, login);
  const wakerCheck = await checkWaker(userId, settings, cfg);
  return { login, waker: wakerCheck };
}

let timer = null;

function schedule(settings) {
  if (timer) clearTimeout(timer);
  const cfg = settingsOf(settings);
  const intervalMs = cfg.loginCheckMinutes * 60000;
  timer = setTimeout(async () => {
    try {
      await runChecks(state.userId || 1);
    } catch (e) {
      await store.logEvent(state.userId || 1, 'error', { where: 'watchdog', error: String(e.message || e).slice(0, 200) });
    }
    if (state.running) schedule(settings);
  }, intervalMs);
}

// Start: first login check after a short boot delay, then every loginCheckMinutes.
async function start(userId = 1) {
  state.userId = userId;
  const settings = await store.getSettings(userId);
  if (!settingsOf(settings).enabled) {
    console.log('[trading] watchdog: disabled in settings — not started');
    return;
  }
  state.running = true;
  timer = setTimeout(async () => {
    try {
      await runChecks(userId);
    } catch (e) {
      await store.logEvent(userId, 'error', { where: 'watchdog', error: String(e.message || e).slice(0, 200) });
    }
    if (state.running) schedule(settings);
  }, 60000); // give the service a minute to settle before the first check
  console.log(`[trading] watchdog started (login check every ${settingsOf(settings).loginCheckMinutes}m)`);
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
  state.running = false;
}

// Manual run (dashboard button): full check cycle now.
async function runNow(userId = 1) {
  return runChecks(userId);
}

module.exports = { start, stop, status, runNow, runChecks, decideLoginCheck, wakerStaleness, checkWaker };
