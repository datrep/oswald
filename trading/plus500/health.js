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
// The UI Fallback Pause stops all new entries — and this file contains NO alert of any kind; on a pause it writes a
// `ui_fallback_pause` row and nothing else. An event nobody reads is not a notification. And the pause LATCHES
// ("stay latched once paused", owner patch 2026-09-11): only a manual `resume()` clears it, so ONE bad poll can
// hold the desk down until a human notices. Over an unattended fortnight that is the failure that lasts longest,
// because nothing about it is loud.
//
// ⚠ ON THE TRANSITION ONLY. Alerting on every failed poll would make the alert noise, and a noisy alert is one
// that stops being read — which is how the original silence would come back by a different route.
async function alertOnPause(wasPaused, nowPaused, detail) {
  if (wasPaused || !nowPaused) return;
  try {
    await require('../lib/http').telegramAlert(
      'OSWALD: UI FALLBACK PAUSE ARMED — the desk will take NO new entries (existing positions are held) until it '
      + `is resumed by hand. It is a LATCH: it does not clear on its own. Cause: ${detail}. Resume from the dashboard.`);
  } catch { /* telegram is optional; the pause itself must not fail because an alert could not be sent */ }
}

// Returns {ok, checks, reason, paused, consecutiveFails}
async function checkAndGate(userId, settings, page) {
  const webtrader = require('./webtrader');
  const result = await webtrader.healthCheck(page, settings);
  let bridge = (settings.bridge || {});
  let consecutiveFails = Number(bridge.consecutiveFails) || 0;
  const wasPaused = !!bridge.paused;
  let paused = wasPaused;

  if (result.ok) {
    if (consecutiveFails > 0) {
      bridge = { ...bridge, consecutiveFails: 0 };
      await store.saveSettings(userId, { bridge });
    }
  } else {
    consecutiveFails += 1;
    paused = paused || consecutiveFails >= MAX_FAILS;
    bridge = { ...bridge, consecutiveFails, paused, pausedAt: paused ? new Date().toISOString() : bridge.pausedAt };
    await store.saveSettings(userId, { bridge });
    await store.logEvent(userId, paused ? 'system' : 'telemetry', {
      kind: paused ? 'ui_fallback_pause' : 'selector_health_fail',
      consecutiveFails, reason: result.reason,
    });
    await alertOnPause(wasPaused, paused, `${consecutiveFails} consecutive selector health failures (${result.reason || 'no reason given'})`);
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
  const consecutiveFails = Number(bridge.consecutiveFails || 0) + 1;
  // 2026-09-11 (owner patch): stay latched once paused — this used to overwrite
  // `paused` with `fails >= MAX_FAILS`, silently clearing an active UI Fallback
  // Pause on any 1–2 fail streak (inconsistent with checkAndGate; only the
  // manual resume() clears a latch).
  const paused = !!bridge.paused || consecutiveFails >= MAX_FAILS;
  await store.saveSettings(userId, {
    bridge: { ...bridge, consecutiveFails, paused, pausedAt: paused ? new Date().toISOString() : bridge.pausedAt },
  });
  await store.logEvent(userId, paused ? 'system' : 'telemetry', {
    kind: paused ? 'ui_fallback_pause' : 'plus500_connection_error', consecutiveFails,
  });
  await alertOnPause(!!bridge.paused, paused, `${consecutiveFails} consecutive connection errors`);
  return { consecutiveFails, paused };
}

// Manual resume (dashboard button later): clears pause + counters.
async function resume(userId) {
  const settings = await store.getSettings(userId);
  await store.saveSettings(userId, { bridge: { ...(settings.bridge || {}), paused: false, consecutiveFails: 0, pausedAt: null } });
  await store.logEvent(userId, 'system', { kind: 'ui_fallback_resume' });
}

module.exports = { checkAndGate, isPaused, recordConnectionFailure, resume, MAX_FAILS };
