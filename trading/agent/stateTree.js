// trading/agent/stateTree.js — TRD-11: ONE machine-state tree.
// A single JSON snapshot of everything the desk knows, consumed by the
// central AI (machineState), the dashboard (GET /state), and the Telegram
// concierge (/status). Killed drift between hand-picked context fields.
'use strict';

const store = require('../store');
const { status: wakerStatus } = require('./waker');

const pick = (ev, keys) => {
  const p = ev && ev.payload;
  if (!p) return null;
  const out = {};
  for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
  return out;
};

const iso = (d) => (d == null ? null : (d instanceof Date ? d.toISOString() : String(d)));

async function buildStateTree(userId) {
  const settings = await store.getSettings(userId);
  const sim = !!(settings.paper && settings.paper.enabled);
  const w = wakerStatus();

  const [account, pulse, meta, multi, congress, central, lastWake, errors, alerts, recentEvents] = await Promise.all([
    store.latestEvent(userId, 'account'),
    store.latestEvent(userId, 'pulse'),
    store.latestEvent(userId, 'meta'),
    store.latestEvent(userId, 'multi_signal'),
    store.latestEvent(userId, 'congress_signal'),
    store.latestEvent(userId, 'central'),
    store.latestEvent(userId, 'wake'),
    store.listEvents(userId, { kind: 'error', limit: 5 }),
    store.listAlerts(userId),
    store.listEvents(userId, { limit: 120 }),
  ]);

  // DESIGN BIBLE v1 Phase A: bounded recent-activity window — last action,
  // last error, last state change, each referencing the full-log id.
  const ACTION_KINDS = ['wake', 'decision', 'trade_opened', 'trade_closed', 'order_rejected', 'position_review', 'paper_trade', 'alert', 'ask', 'kill'];
  const STATE_KINDS = ['kill', 'paper_trade', 'trade_opened', 'trade_closed'];
  const latestOf = (kinds) => (recentEvents || []).find((e) => kinds.includes(e.kind)) || null;
  const actionEv = latestOf(ACTION_KINDS);
  const stateEv = latestOf(STATE_KINDS);
  const window = {
    lastAction: actionEv ? {
      id: actionEv.id, ts: iso(actionEv.createdAt),
      actor: (actionEv.payload && actionEv.payload.actor) || 'system',
      action: (actionEv.payload && actionEv.payload.action) || actionEv.kind,
      result: (actionEv.payload && actionEv.payload.result && actionEv.payload.result.status) || (actionEv.payload && actionEv.payload.skipped ? 'skipped' : 'ok'),
    } : null,
    lastError: errors && errors.length ? {
      id: errors[0].id, ts: iso(errors[0].createdAt),
      code: (errors[0].payload && errors[0].payload.code) || 'system_error',
      message: (errors[0].payload && errors[0].payload.error) || '',
    } : null,
    lastStateChange: stateEv ? { id: stateEv.id, ts: iso(stateEv.createdAt), action: stateEv.kind, sequence: stateEv.id } : null,
  };

  const openDemo = await store.getOpenTrades(userId);
  const openSim = sim ? await store.listPaperTrades(userId, { status: 'open', limit: 20 }) : [];
  const paperState = sim ? await require('./paper').equity(userId, settings) : null;

  const liveAccount = require('./accountPoller').getLive();
  return {
    at: new Date().toISOString(),
    mode: sim ? 'sim' : 'plus500_demo',
    kill: {
      tier: (settings.kill && settings.kill.tier) || 'off',
      autoClose: !!settings.kill?.autoClose,
      disasterFloorPct: settings.kill?.disasterFloorPct ?? null,
      initialEquity: settings.kill?.initialEquity ?? null,
    },
    waker: {
      running: w.running, inProgress: w.inProgress,
      // Pause lives in settings (source of truth), not waker state.
      paused: !!settings.wake?.paused,
      lastWakeAt: iso(w.lastWakeAt),
      nextWakeAt: iso(w.nextWakeAt),
      intervalMinutes: settings.wake?.intervalMinutes ?? 10,
    },
    account: liveAccount || (account ? { ...account.payload, at: account.createdAt } : null),
    positions: {
      demo: openDemo.map((t) => ({ symbol: t.symbol, direction: t.direction, size: t.size, openPrice: t.openPrice, status: t.status, currentRate: t.currentRate ?? null, floatingPnl: t.floatingPnl ?? null, stopPrice: t.stopPrice ?? null, takeProfitPrice: t.takeProfitPrice ?? null })),
      sim: openSim.map((t) => ({ symbol: t.symbol, direction: t.direction, size: t.size, openPrice: t.openPrice, takeProfitPrice: t.takeProfitPrice ?? null })),
    },
    paper: paperState,
    lastDecision: pick(lastWake, ['trigger', 'mode', 'action', 'skipped', 'stance', 'confidence', 'headline', 'opened', 'closed', 'equity', 'reason']),
    central: central ? (central.payload.parseFailure
      ? { parseFailure: true, model: central.payload.model }
      : pick(central, ['stance', 'confidence', 'headline', 'actions', 'model', 'thinking'])) : null,
    pulse: pick(pulse, ['headline', 'sentiment', 'at', 'movers']),
    meta: pick(meta, ['regime', 'trend', 'confidence', 'scaleFactor', 'winRate', 'symbol', 'venue']),
    multiTop: (multi && multi.payload && multi.payload.top || []).slice(0, 3),
    congressTop: (congress && congress.payload && congress.payload.top || []).slice(0, 3),
    alerts: {
      count: alerts.length,
      active: alerts.filter((a) => !a.triggeredAt).map((a) => ({ symbol: a.symbol, direction: a.direction, threshold: a.threshold, note: a.note })),
    },
    errors: (errors || []).map((e) => ({
      at: e.createdAt,
      where: (e.payload && e.payload.where) || 'unknown',
      error: String((e.payload && e.payload.error) || JSON.stringify(e.payload || {})).slice(0, 200),
    })),
    window,
    strategies: (settings.strategies && settings.strategies.enabled) || [],
    // TRD-12: venue-reported per-symbol trading sessions (passive feed).
    sessions: require('../plus500/sessionFeed').summary(),
  };
}

module.exports = { buildStateTree };
