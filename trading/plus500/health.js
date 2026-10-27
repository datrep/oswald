// trading/plus500/health.js — Selector Health Check + UI Fallback Pause (A1).
// Runs the health check BEFORE every trading action. 3 consecutive failures ->
// "UI Fallback Pause": no new entries, positions held, external (Binance/OKX)
// capture continues. The pause flag lives in TradingSettings (live-read), so the
// waker/aggregator honor it without a restart. No AI auto-heal of selectors ever.
'use strict';

const store = require('../store');

const MAX_FAILS = 3;

// ⚠⚠ TRD-OPS-1 (2026-10-01): A PAUSE IS SILENT, AND IT LATCHES. THAT COMBINATION IS THE PROBLEM.
//
// The UI Fallback Pause stops all new entries. It LATCHES ("stay latched once paused", owner patch 2026-09-11):
// only a manual `resume()` clears it, so ONE bad poll can hold the desk down until a human notices. Over an
// unattended fortnight that is the failure that lasts longest, because nothing about it is loud.
//
// ⚠ THE ORIGINAL ALERT RULE WAS "ON THE TRANSITION ONLY", and the reason recorded here was that alerting on every
// failed poll becomes noise. That reasoning is sound and it produced the exact failure it was guarding against:
// measured 2026-10-26, the desk sat LATCHED FROM 15:13 UNTIL 21:14 — nearly six hours, 7 entries refused — after a
// single alert at the transition. A rule that fires once for a condition that persists is silence with a receipt.
//
// ★ SO THE RULE IS NOW "ON THE TRANSITION, AND WHILE THE STATE IS HELD" (2026-10-27), which is still not per-poll:
// a re-page only happens when the pause has been held longer than `REALERT_AFTER_MS` AND no page has gone out in
// that window. One page an hour for a stuck desk is information; thirty pages an hour is noise.
//
// ⚠ AND `pausedAt` WAS BEING REWRITTEN ON EVERY FAILURE. The journal shows 12 writes in 4 days against 2 changes
// of `paused` itself, each write's `before` being the previous timestamp:
//     15:13:11 -> 15:21:09 -> 15:29:28 -> 20:39:42
// so the field read like "when this pause began" and actually recorded "when it last failed". `selfHealth` prints
// `pauseAgeLabel(b.pausedAt)`, which means the health panel has been reporting a pause minutes old for one that had
// been latched for hours — an age computed from a moving number. `pausedSince` now holds the start (set once, on
// the transition, never while latched) and `lastFailAt` holds the freshness. `pausedAt` is kept in step with
// `pausedSince` so existing readers become correct without being changed.
const REALERT_AFTER_MS = 60 * 60 * 1000;

// ★ 2026-10-27 — A FAILURE DOES NOT NEED A SETTINGS WRITE TO BE COUNTED.
//
// The journal recorded `bridge.consecutiveFails` written **22 times in 4 days** against 2 actual changes of
// `bridge.paused`. Every one of those writes is a `MERGE` plus a journal row plus a dead-scope scan, to record a
// NUMBER that is only ever consumed to decide whether it has reached `MAX_FAILS` (3). Worse, it made the settings
// journal unreadable: 22 rows about one integer buried whatever else changed.
//
// So the streak lives IN PROCESS and the persisted value is a checkpoint. `shouldPersistBridge` (pure, below) decides
// when the checkpoint moves; between checkpoints the count is still correct in memory and still returned to the
// caller, and the LATCH (`paused`) is never held only in memory — a change of `paused` always persists.
//
// ⚠ THE TRADE, STATED: a restart mid-streak loses at most `MAX_FAILS - 1` unpersisted failures, so the desk would
// need up to two more bad polls to latch. The latch itself is persisted and cannot be lost, and restarts here are
// operator-driven and rare. The alternative — writing on every failure — is what produced the churn.
const STREAK = new Map();
function streakOf(userId, persisted) {
  const n = STREAK.get(userId);
  if (n != null) return n;
  const seed = Number(persisted) || 0;
  STREAK.set(userId, seed);
  return seed;
}
const setStreak = (userId, n) => { STREAK.set(userId, n); return n; };

// PURE. When does the persisted checkpoint have to move? Each clause is a fact that must survive a restart or that
// a reader depends on; an intermediate count is a fact that does not.
function shouldPersistBridge({ prevCount = 0, nextCount = 0, wasPaused = false, nowPaused = false, reAlert = false } = {}) {
  if (wasPaused !== nowPaused) return true;           // the LATCH changed: the safety-critical fact
  if (reAlert) return true;                            // `pausedAlertAt` must survive, or the retry page repeats
  if (prevCount === 0 && nextCount > 0) return true;   // the first failure of a streak is worth a row
  if (nextCount === 0 && prevCount > 0) return true;   // the recovery to zero is worth a row
  // Past the first, checkpoint once per MAX_FAILS so a long outage still leaves a trail without one row per poll.
  if (nextCount > 0 && Math.floor(nextCount / MAX_FAILS) !== Math.floor(prevCount / MAX_FAILS)) return true;
  return false;
}

// PURE. Extracted so the rule can be tested without Telegram — the same reason `blackSwanVerdict` and
// `findResets` are pure. Returns one of 'transition' | 're_alert' | null, which is more useful to a test (and to a
// log line) than a bare boolean.
function pauseAlertVerdict({ wasPaused, nowPaused, pausedSince, pausedAlertAt, now = Date.now(), reAlertAfterMs = REALERT_AFTER_MS }) {
  if (!nowPaused) return null;
  if (!wasPaused) return 'transition';
  const heldMs = pausedSince ? now - new Date(pausedSince).getTime() : 0;
  const sinceAlertMs = pausedAlertAt ? now - new Date(pausedAlertAt).getTime() : Infinity;
  return (heldMs >= reAlertAfterMs && sinceAlertMs >= reAlertAfterMs) ? 're_alert' : null;
}

// Returns TRUE when a page was actually sent, so the caller can record `pausedAlertAt`.
async function alertOnPause({ wasPaused, nowPaused, detail, pausedSince, pausedAlertAt }) {
  const verdict = pauseAlertVerdict({ wasPaused, nowPaused, pausedSince, pausedAlertAt });
  if (!verdict) return false;
  try {
    await require('../lib/http').telegramAlert(
      'OSWALD: UI FALLBACK PAUSE ARMED — the desk will take NO new entries (existing positions are held) until it '
      + `is resumed by hand. It is a LATCH: it does not clear on its own. Held since ${pausedSince || 'unknown'}. `
      + `Cause: ${detail}. Resume from the dashboard.`);
    return true;
  } catch {
    // telegram is optional; the pause itself must not fail because an alert could not be sent. FALSE, not TRUE:
    // a failed send must not be recorded as an alert that went out, or the hour-long retry would be suppressed.
    return false;
  }
}

// Returns {ok, checks, reason, paused, consecutiveFails}
async function checkAndGate(userId, settings, page) {
  const webtrader = require('./webtrader');
  const result = await webtrader.healthCheck(page, settings);
  let bridge = (settings.bridge || {});
  const prevCount = Number(bridge.consecutiveFails) || 0;
  let consecutiveFails = streakOf(userId, prevCount);
  const wasPaused = !!bridge.paused;
  let paused = wasPaused;

  if (result.ok) {
    if (consecutiveFails > 0) {
      setStreak(userId, 0);
      consecutiveFails = 0;
      bridge = { ...bridge, consecutiveFails: 0 };
      await store.saveSettings(userId, { bridge }, { by: 'machine' });
    }
  } else {
    consecutiveFails += 1;
    setStreak(userId, consecutiveFails);
    paused = paused || consecutiveFails >= MAX_FAILS;
    const nowIso = new Date().toISOString();
    // ⚠ THE START TIME IS SET ONCE. `wasPaused` is the latch, so a failure while already paused updates ONLY
    // `lastFailAt`. A legacy row with no `pausedSince` falls back to its own `pausedAt` (the best evidence there is
    // for a pause that started before this field existed) and only then to now.
    const pausedSince = paused
      ? (wasPaused ? (bridge.pausedSince || bridge.pausedAt || nowIso) : nowIso)
      : (bridge.pausedSince || null);
    bridge = { ...bridge, consecutiveFails, paused, pausedSince, pausedAt: pausedSince, lastFailAt: nowIso };
    if (shouldPersistBridge({ prevCount, nextCount: consecutiveFails, wasPaused, nowPaused: paused })) {
      await store.saveSettings(userId, { bridge }, { by: 'machine' });
    }
    await store.logEvent(userId, paused ? 'system' : 'telemetry', {
      kind: paused ? 'ui_fallback_pause' : 'selector_health_fail',
      consecutiveFails, reason: result.reason,
      // the two facts the event could not previously separate
      pausedSince, lastFailAt: nowIso,
    });
    const sent = await alertOnPause({ wasPaused, nowPaused: paused, pausedSince, pausedAlertAt: bridge.pausedAlertAt, detail: `${consecutiveFails} consecutive selector health failures (${result.reason || 'no reason given'})` });
    if (sent) {
      bridge = { ...bridge, pausedAlertAt: nowIso };
      await store.saveSettings(userId, { bridge }, { by: 'machine' });
    }
  }
  return { ...result, paused, consecutiveFails };
}

function isPaused(settings) {
  return !!(settings.bridge && settings.bridge.paused);
}

// Plus500 connection errors ("Could not connect to the server") count toward
// the same fallback-pause gate as selector failures — never hammer a possibly
// flagging/flagged endpoint.
async function recordConnectionFailure(userId) {
  const settings = await store.getSettings(userId);
  const bridge = settings.bridge || {};
  const prevCount = Number(bridge.consecutiveFails) || 0;
  const consecutiveFails = streakOf(userId, prevCount) + 1;
  setStreak(userId, consecutiveFails);
  // 2026-09-11 (owner patch): stay latched once paused — this used to overwrite
  // `paused` with `fails >= MAX_FAILS`, silently clearing an active UI Fallback
  // Pause on any 1–2 fail streak (inconsistent with checkAndGate; only the
  // manual resume() clears a latch).
  const paused = !!bridge.paused || consecutiveFails >= MAX_FAILS;
  const wasPaused = !!bridge.paused;
  const nowIso = new Date().toISOString();
  // Same rule as `checkAndGate`: the start time is set once and never while latched.
  const pausedSince = paused
    ? (wasPaused ? (bridge.pausedSince || bridge.pausedAt || nowIso) : nowIso)
    : (bridge.pausedSince || null);
  let next = { ...bridge, consecutiveFails, paused, pausedSince, pausedAt: pausedSince, lastFailAt: nowIso };
  // Same checkpoint rule as `checkAndGate` — a connection failure used to write settings every time as well.
  if (shouldPersistBridge({ prevCount, nextCount: consecutiveFails, wasPaused, nowPaused: paused })) {
    await store.saveSettings(userId, { bridge: next }, { by: 'machine' });
  }
  await store.logEvent(userId, paused ? 'system' : 'telemetry', {
    kind: paused ? 'ui_fallback_pause' : 'plus500_connection_error', consecutiveFails, pausedSince, lastFailAt: nowIso,
  });
  const sent = await alertOnPause({ wasPaused, nowPaused: paused, pausedSince, pausedAlertAt: bridge.pausedAlertAt, detail: `${consecutiveFails} consecutive connection errors` });
  if (sent) {
    next = { ...next, pausedAlertAt: nowIso };
    await store.saveSettings(userId, { bridge: next }, { by: 'machine' });
  }
  return { consecutiveFails, paused };
}

// Manual resume (dashboard button later): clears pause + counters.
// ⚠ ALL FOUR FIELDS CLEAR TOGETHER. Leaving `pausedSince` behind would make the NEXT pause inherit the previous
// one's start time, and leaving `pausedAlertAt` behind would let a stale alert clock suppress the new pause's first
// page — the same silence this file was just fixed for, arriving by a side door.
async function resume(userId) {
  const settings = await store.getSettings(userId);
  // The in-process streak is authoritative for the count, so a resume that cleared only the stored value would leave
  // the next failure incrementing from the stale in-memory one and re-latch immediately.
  setStreak(userId, 0);
  await store.saveSettings(userId, {
    bridge: {
      ...(settings.bridge || {}),
      paused: false, consecutiveFails: 0,
      pausedAt: null, pausedSince: null, lastFailAt: null, pausedAlertAt: null,
    },
  }, { by: 'machine' });
  await store.logEvent(userId, 'system', { kind: 'ui_fallback_resume', clearedPausedSince: (settings.bridge || {}).pausedSince || null });
}

module.exports = { checkAndGate, isPaused, recordConnectionFailure, resume, alertOnPause, pauseAlertVerdict, shouldPersistBridge, MAX_FAILS, REALERT_AFTER_MS };
