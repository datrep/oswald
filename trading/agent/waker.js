// trading/agent/waker.js — the wake loop (OSWALD is the prompter).
// Triggers: schedule (jittered interval + overlap guard), price-cross alerts,
// manual POST /api/trading/wake. A8: MarketSessionGuard — closed market skips
// the LLM entirely (lightweight event only); observation windows lock entries.
// A12-adjacent: midnight digest (chair-generated, 3 bullets) for the sliding
// context window.
'use strict';

const store = require('../store');
// GOTCHA: `require('mssql')` here resolves to trading/node_modules/mssql — a
// DIFFERENT instance than the pool's root copy, so its type classes fail with
// "parameter.type.validate is not a function". Use the pool's own sql export.
const { sql } = require('../db');
const { callChat, DEFAULT_MODEL } = require('./deepseek');

const state = {
  running: false,
  lastResult: null,
  nextWakeAt: null,
  lastWakeAt: null,
  loopTimer: null,
  agentUserId: 1,
};

function status() {
  // TRD-12 Phase 0: live wake state now comes from the instrumented pipeline.
  const pipe = require('./wakePipeline').pipelineStatus();
  return {
    ...state,
    loopTimer: undefined,
    running: state.running || !!pipe.running,
    inProgress: !!pipe.running,
    lastResult: pipe.lastResult || state.lastResult,
    // TRD-51 fix 3: lastWakeAt is the last ATTEMPT. The watchdog must use lastSuccessAt —
    // a wake that threw still advances lastWakeAt (finishWake runs in a `finally`), which is
    // exactly how four hours of failed wakes looked like ten minutes of health.
    lastWakeAt: pipe.lastWakeAt || state.lastWakeAt,
    lastSuccessAt: pipe.lastSuccessAt || null,
    startedAt: pipe.startedAt || null,
    pipeline: pipe,
  };
}

async function runWake(userId, trigger = 'manual', { manual = false, alert = null, userInput = null } = {}) {
  // 2026-10-03 PARK (operator-scope): while parked the desk takes NO wake at all — scheduled, alert
  // or manual — because every wake path can touch the bridge. Checked HERE so no caller can bypass it.
  const parkedSettings = await store.getSettings(userId).catch(() => null);
  if (parkedSettings && parkedSettings.bridge && parkedSettings.bridge.parked) return { skipped: 'parked' };
  // TRD-12 Phase 0: wake orchestration lives in wakePipeline.js (step-
  // instrumented for the pipeline mirror). Scheduling, alert checks and the
  // digest stay in this file.
  return require('./wakePipeline').run(userId, trigger, { manual, alert, userInput });
}

// Alert checks — TRD-11 metric-aware: price (above/below/crosses on ticks),
// changePct (daily % move from 1d bars), buyersPct (Plus500 sentiment feed).
async function checkAlerts(userId) {
  const alerts = await store.listAlerts(userId);
  const fired = [];
  for (const a of alerts) {
    if (!a.enabled) continue;
    const now = Date.now();
    const cdMs = (Number(a.cooldownMinutes) || 60) * 60000;
    if (a.lastTriggeredAt && now - new Date(a.lastTriggeredAt).getTime() < cdMs) continue;
    const metric = a.metric || 'price';
    const threshold = Number(a.threshold);
    let hit = false;
    let value = null;

    if (metric === 'changePct') {
      // Daily change across any venue with 1d bars (prefer yahoo).
      const pool = await require('../db').getPool();
      const r = await pool.request().input('userId', sql.Int, userId).input('symbol', sql.NVarChar(64), a.symbol).query(`
        SELECT TOP 2 closePrice FROM PriceBars
        WHERE userId = @userId AND timeframe = '1d' AND symbol = @symbol
        ORDER BY barStart DESC`);
      const closes = r.recordset.map((x) => Number(x.closePrice));
      if (closes.length >= 2 && closes[1] > 0) {
        value = ((closes[0] - closes[1]) / closes[1]) * 100;
        hit = Math.abs(value) >= Math.abs(threshold);
      }
    } else if (metric === 'buyersPct') {
      // TRD-11: Plus500 does not expose a live current Buyers % (the sidebar
      // only echoes the threshold) — the mirrored alert stays display-only;
      // the Plus500 push notifies the user, who can /wake manually.
      continue;
    } else {
      const tick = await store.latestTick(userId, a.symbol, a.venue);
      if (!tick) continue;
      const mid = ((tick.ask ?? 0) + (tick.bid ?? 0)) / 2 || tick.bid || 0;
      if (!mid) continue;
      value = mid;
      if (a.direction === 'above') hit = mid >= threshold;
      else if (a.direction === 'below') hit = mid <= threshold;
      else if (a.direction === 'crosses') {
        const since = a.lastTriggeredAt ? new Date(a.lastTriggeredAt) : new Date(now - cdMs);
        const ticks = await store.ticksSince(userId, a.symbol, a.venue, since);
        hit = ticks.some((t) => {
          const m = ((t.ask ?? 0) + (t.bid ?? 0)) / 2 || t.bid || 0;
          return (m - threshold) * (mid - threshold) < 0;
        });
      }
    }
    if (hit) {
      await store.markAlertTriggered(userId, a.id);
      await require('./log').write(userId, 'alert', { symbol: a.symbol, venue: a.venue, metric, direction: a.direction, threshold, value, at: new Date().toISOString() }, { actor: 'scheduler', correlationId: require('./log').corrId('alert') });
      fired.push(a);
    }
  }
  return fired;
}

// IMPLIED GOAL #4: stop/TP-proximity micro-wakes — when the latest price
// drifts within proximityPct of the remaining stop or take-profit distance,
// wake immediately instead of waiting for the schedule. Cheap check with a
// bounded cadence (checkEverySec poll, minIntervalMin between micro-wakes).
const microState = { lastCheckAt: 0, lastWakeAt: 0 };

async function checkMicroWake(userId) {
  const settings = await store.getSettings(userId);
  const mw = (settings.wake && settings.wake.microWake) || {};
  if (mw.enabled === false) return;
  if (settings.kill && settings.kill.tier === 'hard') return;
  const now = Date.now();
  const checkEvery = Math.max(10, Number(mw.checkEverySec) || 30) * 1000;
  if (now - microState.lastCheckAt < checkEvery) return;
  microState.lastCheckAt = now;
  const minGap = Math.max(1, Number(mw.minIntervalMin) || 2) * 60000;
  if (now - microState.lastWakeAt < minGap) return;
  const prox = Math.max(0.05, Math.min(0.9, Number(mw.proximityPct) || 0.25));
  const open = await store.getOpenTrades(userId);
  for (const t of open) {
    if (String(t.note || '').includes('mirrored from Plus500')) continue;
    if (t.stopPrice == null && t.takeProfitPrice == null) continue;
    const tick = await store.latestTick(userId, t.symbol, t.venue).catch(() => null);
    if (!tick) continue;
    const px = (((tick.ask ?? 0) + (tick.bid ?? 0)) / 2) || tick.bid || 0;
    if (px <= 0 || t.openPrice == null) continue;
    let near = false;
    if (t.stopPrice != null) {
      near = Math.abs(px - Number(t.stopPrice)) <= prox * Math.abs(Number(t.stopPrice) - Number(t.openPrice));
    }
    if (!near && t.takeProfitPrice != null) {
      near = Math.abs(px - Number(t.takeProfitPrice)) <= prox * Math.abs(Number(t.takeProfitPrice) - Number(t.openPrice));
    }
    if (near) {
      microState.lastWakeAt = now;
      await store.logEvent(userId, 'telemetry', { source: 'micro_wake', symbol: t.symbol, price: px, prox: +prox.toFixed(2) });
      await runWake(userId, 'micro', { manual: false }).catch(() => {});
      return;
    }
  }
}

// Midnight digest: deterministic stats -> optional LLM compression to 3 bullets.
async function generateDigest(userId, settings) {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const events = await store.listEvents(userId, { limit: 500 });
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEvents = events.filter((e) => new Date(e.createdAt) >= today);
  const openTrades = await store.getOpenTrades(userId);
  const closedToday = await store.getClosedTrades(userId, 20).then((t) => t.filter((x) => x.closeAt && new Date(x.closeAt) >= today));
  const prices = {};
  for (const s of settings.watchlist?.symbols || []) {
    const t = await store.latestTick(userId, s.symbol, s.venue);
    if (t) prices[s.symbol] = Math.round((((t.ask ?? 0) + (t.bid ?? 0)) / 2 || t.bid || 0) * 100) / 100;
  }
  const stats = {
    eventsToday: todayEvents.length,
    wakeCount: todayEvents.filter((e) => e.kind === 'wake').length,
    decisions: todayEvents.filter((e) => e.kind === 'decision').length,
    openPositions: openTrades.length,
    closedToday: closedToday.length,
    closedPnl: closedToday.reduce((s, t) => s + (Number(t.grossPnl) || 0), 0),
    prices,
    since: dayAgo.toISOString(),
  };

  let bullets = [
    `Trend strength: n/a (no LLM digest)`,
    `Volatility regime: n/a`,
    `Notable events: ${stats.eventsToday} events today (${stats.wakeCount} wakes, ${stats.decisions} decisions), ${stats.openPositions} open positions`,
  ];
  let digestModel = null;
  if (!settings.llm?.stub) {
    try {
      // TRD-12 Phase 2: token budget soft-gate.
      const budget = require('./budget');
      const gate = await budget.allow(userId, settings, 'digest');
      if (gate.allowed) {
        // callChat uses json_object response_format, so the prompt MUST ask for JSON.
        const r = await callChat([
          { role: 'system', content: 'You are the midnight digest writer for a DEMO trading agent. Reply with a JSON object: {"trend":"short trend bullet","volatility":"short volatility bullet","notable":"short events bullet"}. No preamble.' },
          { role: 'user', content: 'Stats JSON: ' + JSON.stringify(stats) },
        ], { model: settings.llm?.model || DEFAULT_MODEL, temperature: 0.2, maxTokens: 800, timeoutMs: 30000, userId, label: 'digest' });
        const parsed = JSON.parse(String(r.text || '{}'));
        const lines = [parsed.trend, parsed.volatility, parsed.notable].map((l) => String(l || '').trim()).filter(Boolean);
        if (lines.length >= 3) bullets = lines.slice(0, 3);
        digestModel = r.model;
        budget.record(userId, 'digest', r.usage, { settings }).catch(() => {});
      }
    } catch (e) {
      bullets[2] += ` (LLM digest failed: ${String(e.message || e).slice(0, 60)})`;
    }
  }
  await store.logEvent(userId, 'digest', { date: today.toISOString().slice(0, 10), bullets, stats, ...(digestModel ? { actor: `llm:${digestModel}` } : {}) });
  return bullets;
}

async function maybeDigest(userId, settings) {
  const last = await store.latestEvent(userId, 'digest');
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  if (last && last.payload && last.payload.date === todayKey) return null;
  if (now.getUTCHours() * 60 + now.getUTCMinutes() < 5) return null; // not past 00:05 UTC yet
  return generateDigest(userId, settings);
}

// Heartbeat-based scheduler (2026-09-09): a 1s interval checks the due time
// instead of a one-shot setTimeout. Evidence showed one-shot timers can be
// silently lost in this process (nextWakeAt passed with nothing fired) while
// setInterval pollers keep running — a missed deadline can no longer strand
// the desk: the heartbeat fires overdue wakes.
// The cadence ACTUALLY used, in ONE place, because the startup log and the scheduler must not be
// able to disagree. `|| 30` means an explicit `jitterPct: 0` is treated as ABSENT and becomes the
// 30% default - so the log used to announce "jitter 0%" while the scheduler jittered by 30%, which
// is exactly the difference between expecting a wake at +10m and finding silence at +11m.
function cadence(settings) {
  const w = (settings && settings.wake) || {};
  return {
    intervalMin: Number(w.intervalMinutes) || 10,
    jitterPct: Math.max(0, Math.min(100, Number(w.jitterPct) || 30)) / 100,
  };
}

function scheduleNext(settings) {
  if (state.loopTimer) clearInterval(state.loopTimer);
  state.loopTimer = null;
  if (settings.wake?.paused || settings.bridge?.parked) {
    // TRD-9 H soft pause: no scheduled wakes until resumed (manual still OK).
    // 2026-10-03 PARK (operator-scope): the same stop, one switch wider.
    state.running = false;
    state.nextWakeAt = null;
    console.log(settings.bridge?.parked ? '[trading] waker stopped (bridge.parked=true — park)' : '[trading] waker paused (wake.paused=true)');
    return;
  }
  const { intervalMin, jitterPct } = cadence(settings);
  const base = intervalMin * 60000;
  const delay = base * (1 - jitterPct) + Math.random() * base * 2 * jitterPct;
  state.nextWakeAt = new Date(Date.now() + delay).toISOString();
  console.log('[trading] waker scheduled next wake at', state.nextWakeAt);
  arm();
}

// Start the 1s poll. Split out of scheduleNext so a tick can re-arm the timer WITHOUT
// recomputing a deadline it has already decided on.
function arm() {
  if (state.loopTimer) clearInterval(state.loopTimer);
  state.loopTimer = setInterval(() => {
    // tick() contains its own failures. This guard exists so that even a rejection from the
    // HANDLING of a failure cannot reach the process as an unhandled one.
    tick().catch((e) => console.log('[trading] waker tick escaped', String((e && e.message) || e).slice(0, 200)));
  }, 1000);
}

// ONE scheduler tick.
//
// WHY THIS IS A NAMED FUNCTION AND NOT AN INLINE setInterval BODY (2026-09-15). The previous
// shape was a single async callback whose LAST statement re-armed the loop, with
// `await store.getSettings()` above that statement and OUTSIDE the try - and the timer had
// ALREADY been cleared before the await. So one rejected settings read left the desk with no
// timer, no deadline and no re-arm; and because the rejection escaped an async callback, it
// left no error record either. Every other loop kept running, /healthz kept answering, and only
// the staleness alarm eventually noticed. Measured on the live desk: the last wake COMPLETED
// normally at 10:18:26 (action none, llmCalled false), telemetry was still landing at 10:30:24,
// and no wake ever fired again - the desk looked alive while it had stopped waking.
//
// THE INVARIANT: once a tick has stopped the timer, it must re-arm it on the way out, whatever
// happened. The `finally` below is that guarantee, and `test/waker-schedule.test.js` fails if the
// re-arm is moved back out of it. A failed settings read is NOT grounds for stopping the desk:
// scheduleNext falls back to the default cadence, and the next tick re-reads.
async function tick({
  readSettings = (uid) => store.getSettings(uid),
  micro = checkMicroWake,
} = {}) {
  const uid = state.agentUserId;
  // IMPLIED GOAL #4: stop/TP-proximity micro-wakes (self-throttled).
  micro(uid).catch(() => {});
  // TRD-12: never let a manual wake supersede a scheduled one (or vice
  // versa). While ANY wake is in flight, keep the overdue deadline and let
  // the next tick fire it right after the in-flight wake completes.
  if (require('./wakePipeline').pipelineStatus().running) return;
  if (!state.nextWakeAt || Date.now() < new Date(state.nextWakeAt).getTime()) return;

  // The deadline is DUE. Stop the poll for the duration of the wake; from here on this tick
  // owns re-arming the loop.
  if (state.loopTimer) clearInterval(state.loopTimer);
  state.loopTimer = null;
  state.nextWakeAt = null;

  let s = null;
  try {
    s = await readSettings(uid);
    console.log('[trading] wake heartbeat fired', new Date().toISOString(), 'enabled=', !!(s.wake && s.wake.enabled));
    // TRD-9 H soft pause: a paused (or disabled) waker STOPS rather than re-arms, which is why
    // this clears `running` first - the `finally` reads it to decide.
    if (!s.wake?.enabled || s.wake?.paused || s.bridge?.parked) { state.running = false; return; } // 2026-10-03: park stops scheduled wakes too
    const fired = await checkAlerts(uid);
    console.log('[trading] wake alerts checked, fired=', fired.length);
    if (fired.length) {
      for (const a of fired.slice(0, 1)) await runWake(uid, 'alert', { alert: a });
    } else {
      await runWake(uid, 'schedule');
    }
    await maybeDigest(uid, s);
  } catch (e) {
    await require('./log').error(uid, 'wake_loop', e);
    console.log('[trading] wake loop error', String(e.message || e).slice(0, 200));
  } finally {
    // UNCONDITIONAL RE-ARM. `s` is null when the settings read itself failed; scheduleNext then
    // uses the default cadence, which is strictly better than a desk that never wakes again.
    if (state.running) scheduleNext(s || {});
  }
}

async function start(userId = 1) {
  state.agentUserId = userId;
  const settings = await store.getSettings(userId);
  if (!settings.wake?.enabled) {
    console.log('[trading] waker: wake.enabled=false — loop not started');
    return;
  }
  if (settings.wake?.paused || settings.bridge?.parked) {
    console.log(settings.bridge?.parked ? '[trading] waker: bridge.parked=true — loop not started (unpark to resume)' : '[trading] waker: wake.paused=true — loop paused (resume from dashboard)');
    return;
  }
  state.running = true;
  scheduleNext(settings);
  const c = cadence(settings);
  console.log(`[trading] waker started for user ${userId} (interval ${c.intervalMin}m, jitter ${Math.round(c.jitterPct * 100)}%)`);
}

function stop() {
  if (state.loopTimer) clearInterval(state.loopTimer);
  state.loopTimer = null;
  state.running = false;
  state.nextWakeAt = null;
}

module.exports = { start, stop, status, runWake, checkAlerts, generateDigest, maybeDigest, state, tick, scheduleNext, arm, cadence };
