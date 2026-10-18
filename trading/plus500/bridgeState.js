// trading/plus500/bridgeState.js — the BRIDGE STATE MACHINE, v0 (TRD-BRG-1 #1511).
//
// Design = trading/docs/bridge-state-machine-REPORT-FOR-REFINEMENT-2026-10-03.md Rev 2 (owner-refined):
// TWO TIERS — one MECHANICAL state (what the bridge is physically doing) + orthogonal MODIFIERS
// (parked / health-paused / recovering), mapped to a human CATEGORY (OPERATIONAL / QUIET / DEGRADED / DEAD).
// The category is what a glance should read first.
//
// ★ PURE. `deriveBridgeState(signals, prev)` performs NO I/O and NO polling — every input carries its own
// timestamp and staleness is per-signal (§3.2 of the doc). The observer that FEEDS it lives elsewhere.
// ★ The derivation uses ONLY signals the desk already publishes; nothing new is measured.
'use strict';

const LAUNCH_PATIENCE_MS = 75000;          // 60 s TCP patience (browser.js) + attach margin
const SETTLE_WINDOW_MS = 12000;            // SPA shell boots ~2–3 s; 12 s = NAVIGATING window (§3.1)
const CAPTURE_WEDGE_FRESH_MS = 5 * 60000;  // a capture_timeout stays on the table until reads resume
const LOGIN_VERDICT_FRESH_MS = 15 * 60000; // watchdog cadence is 5 min (§3.2 bound)

const MECHANICAL = ['OFF', 'LAUNCHING', 'RESTING', 'NAVIGATING', 'BLANK_RENDER', 'LOGGED_OUT', 'WEDGED'];

function ageMs(atIso, nowMs) {
  if (!atIso) return null;
  const t = new Date(atIso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

function deriveBridgeState(signals = {}, prev = null) {
  const nowMs = signals.now ? new Date(signals.now).getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const chromeAlive = !!signals.chromeAlive;
  const attached = !!signals.attached;
  const launchAge = ageMs(signals.launchIntentAt, nowMs);
  const navAge = ageMs(signals.lastNavAt, nowMs);
  const loginAge = ageMs(signals.lastLoginCheckAt, nowMs);
  const captureErrAge = ageMs(signals.lastCaptureErr && signals.lastCaptureErr.at, nowMs);
  const silentForMs = Number.isFinite(signals.silentForMs) ? signals.silentForMs : null;
  const recovery = signals.recovery && signals.recovery.active
    ? { active: true, cause: signals.recovery.cause || 'unspecified', startedAt: signals.recovery.startedAt || null }
    : { active: false, cause: null, startedAt: null };

  // ---- mechanical state — exactly one, fixed precedence (doc §1.3) ------------------------------
  let state = 'RESTING';
  let cause = 'attached';
  if (!attached) {
    if (launchAge != null && launchAge <= LAUNCH_PATIENCE_MS) { state = 'LAUNCHING'; cause = 'launch_intent'; }
    else if (launchAge != null) { state = 'WEDGED'; cause = 'attach_timeout'; }
    else if (chromeAlive) { state = 'WEDGED'; cause = 'cdp_unattached'; }
    else { state = 'OFF'; cause = 'no_chrome'; }
  } else if (signals.loginVerdict === 'false' && loginAge != null && loginAge <= LOGIN_VERDICT_FRESH_MS) {
    state = 'LOGGED_OUT'; cause = 'login_check';
  } else if (signals.lastCaptureErr && signals.lastCaptureErr.kind && captureErrAge != null
             && captureErrAge <= CAPTURE_WEDGE_FRESH_MS && !signals.pageLockHeldBy) {
    state = 'WEDGED'; cause = String(signals.lastCaptureErr.kind);
  } else if (navAge != null && navAge <= SETTLE_WINDOW_MS) {
    state = 'NAVIGATING'; cause = 'nav_in_flight';
  } else if (navAge != null && navAge <= SETTLE_WINDOW_MS * 10 && signals.loginVerdict == null && !signals.feedBound) {
    // shell-up-but-not-settled: the exact condition behind the false login deaths; only when there is NO
    // login evidence AND the feed is unbound — otherwise a settled page is the honest reading.
    state = 'BLANK_RENDER'; cause = 'shell_not_settled';
  } else {
    state = 'RESTING'; cause = 'attached';
  }

  // ---- modifiers — orthogonal, never arbitrate (doc §1.2) ---------------------------------------
  const modifiers = {
    isParked: !!signals.parked,
    parkedAt: signals.parkedAt || null,
    healthPaused: !!signals.healthPaused,
    pausedAt: signals.pausedAt || null,
    isRecovering: recovery.active,
    recoveryCause: recovery.cause,
    recoveryStartedAt: recovery.startedAt,
    feedSilentForMs: silentForMs,
    pageLockHeldBy: signals.pageLockHeldBy || null,
  };

  // ---- category — f(state, modifiers); PARKED wins (doc §2, review item 12) ---------------------
  let category;
  if (modifiers.isParked) category = 'QUIET';
  else if (state === 'LOGGED_OUT' || (state === 'WEDGED' && !modifiers.isRecovering) || state === 'OFF') category = 'DEAD';
  else if (modifiers.isRecovering || modifiers.healthPaused || state === 'WEDGED' || state === 'BLANK_RENDER' || state === 'LAUNCHING') category = 'DEGRADED';
  else category = 'OPERATIONAL';

  // ---- since / healthySince (doc §3) ------------------------------------------------------------
  const prevState = prev ? prev.state : null;
  const prevCategory = prev ? prev.category : null;
  const since = prevState === state ? (prev.since || nowIso) : nowIso;
  let healthySince;
  if (category === 'OPERATIONAL') {
    healthySince = prev && prevCategory === 'OPERATIONAL' && prev.healthySince ? prev.healthySince : nowIso;
  } else {
    healthySince = null; // resets on any exit from OPERATIONAL
  }

  return {
    at: nowIso, state, cause, modifiers, category, since, healthySince,
    prevState, prevCategory,
    changed: !!(prev && (prevState !== state || prevCategory !== category)),
  };
}

module.exports = {
  deriveBridgeState, MECHANICAL,
  LAUNCH_PATIENCE_MS, SETTLE_WINDOW_MS, CAPTURE_WEDGE_FRESH_MS, LOGIN_VERDICT_FRESH_MS,
};
