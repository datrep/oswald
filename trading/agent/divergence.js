// trading/agent/divergence.js — TRD-12 Phase 3: sim-vs-demo divergence.
// The sim desk and the demo desk should track each other; a >1% drift in
// same-day P&L means the sim's cost model is off. Loud Telegram alert once/day.
'use strict';

const store = require('../store');
const { telegramAlert } = require('../lib/http');

async function check(userId, settings) {
  try {
    const pct = Number(settings.paper?.divergencePct ?? 1);
    if (!Number.isFinite(pct)) return { ok: true };
    const today = new Date();
    const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const [demo, sim] = await Promise.all([
      store.listEquity(userId, { mode: 'demo', since, limit: 5000 }),
      store.listEquity(userId, { mode: 'sim', since, limit: 5000 }),
    ]);
    if (demo.length < 2 || sim.length < 2) return { ok: true, reason: 'insufficient_snapshots' };
    const pctOf = (rows) => {
      const first = Number(rows[0].equity) || 1;
      const last = Number(rows[rows.length - 1].equity);
      return ((last - first) / first) * 100;
    };
    const demoPct = pctOf(demo);
    const simPct = pctOf(sim);
    const drift = Math.abs(demoPct - simPct);
    if (drift <= pct) return { ok: true, drift: +drift.toFixed(2) };
    const last = await store.latestEvent(userId, 'divergence_alert');
    const dayKey = today.toISOString().slice(0, 10);
    if (!(last && last.payload && last.payload.date === dayKey)) {
      await store.logEvent(userId, 'divergence_alert', { date: dayKey, demoPct: +demoPct.toFixed(2), simPct: +simPct.toFixed(2), drift: +drift.toFixed(2) });
      await telegramAlert(`OSWALD divergence: sim ${simPct.toFixed(2)}% vs demo ${demoPct.toFixed(2)}% today (${drift.toFixed(2)}pp drift > ${pct}% — sim cost model may be off).`).catch(() => {});
    }
    return { ok: false, drift: +drift.toFixed(2), demoPct: +demoPct.toFixed(2), simPct: +simPct.toFixed(2) };
  } catch (e) {
    return { ok: true, error: String(e.message || e).slice(0, 120) };
  }
}

module.exports = { check };
