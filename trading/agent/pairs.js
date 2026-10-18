// trading/agent/pairs.js — TRD-24: pair lifecycle management.
// The pair-STATE MACHINE, not a flag. Tags both legs of one pair trade with a
// single pairId and owns the defined policies:
//   - leg B rejected -> ONE re-attempt, then unwind leg A (state failed) + alert;
//   - one leg gone (stop / venue-side rollover / manual) -> auto-unwind the
//     survivor after a grace window; Telegram alarm when it happens;
//   - half-close / leg-size divergence -> alarm (deduped per transition);
//   - status() groups legs by pairId for the dashboard/API.
// Called from the wake pipeline's risk step (best-effort, non-fatal). Entries
// are paused, so this is dormant infrastructure until a pair candidate is
// promoted — but the policy is wired now so promotion cannot bypass it.
'use strict';

const log = require('./log');
const alerts = require('./alerts');

const REATTEMPT = 1;                  // leg-B attempts AFTER the first failure
const UNHEDGED_GRACE_MIN = 10;        // one-leg exposure tolerated this long
const SIZE_TOLERANCE_PCT = 20;        // leg-size divergence alarm threshold

function deps(d) {
  return {
    store: (d && d.store) || require('../store'),
    executor: (d && d.executor) || require('./executor'),
    alert: (d && d.alert) || alerts.sendPairAlert,
    log: (d && d.log) || log,
  };
}

function newPairId() {
  return `pair-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Pure classifier (unit-tested): what state is this set of legs in?
//   pending (no rows) | open | half_closed | unhedged | failed | closed
function pairState(legs) {
  const rows = legs || [];
  const open = rows.filter((t) => t.status === 'open');
  const rejected = rows.filter((t) => t.status === 'rejected');
  if (!rows.length) return { state: 'pending', openLegs: 0, rejectedLegs: 0 };
  if (open.length === 2) {
    const a = Number(open[0].size) || 0;
    const b = Number(open[1].size) || 0;
    const denom = Math.max(a, b) || 1;
    const divergencePct = Math.round((Math.abs(a - b) / denom) * 1000) / 10;
    return {
      state: divergencePct > SIZE_TOLERANCE_PCT ? 'half_closed' : 'open',
      openLegs: 2, rejectedLegs: rejected.length, divergencePct,
    };
  }
  if (open.length === 1) {
    return { state: 'unhedged', openLegs: 1, rejectedLegs: rejected.length, survivor: open[0] };
  }
  return { state: rejected.length ? 'failed' : 'closed', openLegs: 0, rejectedLegs: rejected.length };
}

// Open a pair: leg A first, then leg B with ONE re-attempt. If leg B still
// fails, the defined policy is to UNWIND leg A — never leave a naked leg.
async function openPair(userId, settings, { pairId = null, legA, legB, note = 'pair' }, d = {}) {
  const { executor, alert, log: logw } = deps(d);
  const id = pairId ? String(pairId) : newPairId();
  const tag = `${note} [${id}]`;
  if (!legA || !legB || !legA.symbol || !legB.symbol) return { opened: false, pairId: id, state: 'failed', reason: 'both_legs_required' };

  const a = await executor.openTrade(userId, settings, { ...legA, pairId: id, note: `${tag} leg A` });
  if (!a.placed) {
    await logw.write(userId, 'pair_failed', { pairId: id, leg: 'A', reason: a.reason }, { actor: 'system:pairs', level: 'warn' });
    return { opened: false, pairId: id, state: 'failed', reason: `legA_${a.reason || 'rejected'}` };
  }

  let b = null;
  for (let attempt = 0; attempt <= REATTEMPT; attempt++) {
    b = await executor.openTrade(userId, settings, { ...legB, pairId: id, note: `${tag} leg B${attempt ? ' (retry)' : ''}` });
    if (b.placed) break;
  }
  if (!b || !b.placed) {
    const unw = await executor.closeTrade(userId, settings, a.tradeId, { source: `pairs:${id}` })
      .catch((e) => ({ closed: false, reason: String(e.message || e) }));
    await logw.write(userId, 'pair_failed', { pairId: id, leg: 'B', reason: b && b.reason, unwoundLegA: !!unw.closed }, { actor: 'system:pairs', level: 'warn' });
    await alert(alerts.pairFailedText(id, legA, b && b.reason, !!unw.closed)).catch(() => {});
    return { opened: false, pairId: id, state: 'failed', legATradeId: a.tradeId, reason: 'legB_rejected_after_retry', unwound: !!unw.closed };
  }

  await logw.write(userId, 'pair_opened', {
    pairId: id, legA: a.tradeId, legB: b.tradeId,
    symbolA: legA.symbol, symbolB: legB.symbol,
  }, { actor: 'system:pairs' });
  return { opened: true, pairId: id, state: 'open', legA: a.tradeId, legB: b.tradeId };
}

// In-process transition memory so an ongoing anomaly alerts ONCE, not every
// sweep. Cleared when the pair returns to a normal state.
const alerted = new Map();

// Periodic sweep (from the wake pipeline). Two duties:
//   1. unhedged exposure: a pair with exactly one open leg past the grace
//      window is auto-unwound (venue-side rollovers, one-leg stops, manual
//      closes all land here) + alarm;
//   2. half-close / divergence alarm between the legs.
async function sweep(userId, settings, d = {}) {
  const { store, executor, alert, log: logw } = deps(d);
  const open = await store.getOpenTrades(userId);
  const byPair = new Map();
  for (const t of open) {
    if (!t.pairId) continue;
    const key = String(t.pairId);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(t);
  }
  const out = [];
  for (const [pairId, legs] of byPair) {
    const st = pairState(legs);
    if (st.state === 'unhedged') {
      const ageMin = (Date.now() - new Date(st.survivor.openAt).getTime()) / 60000;
      if (ageMin > UNHEDGED_GRACE_MIN) {
        const unw = await executor.closeTrade(userId, settings, st.survivor.id, { source: `pairs:${pairId}` })
          .catch((e) => ({ closed: false, reason: String(e.message || e) }));
        await logw.write(userId, 'pair_unhedged_unwind', {
          pairId, symbol: st.survivor.symbol, ageMin: Math.round(ageMin), closed: !!unw.closed,
        }, { actor: 'system:pairs', level: 'warn' });
        await alert(alerts.pairUnhedgedText(pairId, st.survivor, Math.round(ageMin), !!unw.closed)).catch(() => {});
        alerted.delete(`${pairId}:unhedged`);
        out.push({ pairId, state: 'unhedged_unwound', closed: !!unw.closed });
      } else {
        const key = `${pairId}:unhedged`;
        if (!alerted.has(key)) {
          alerted.set(key, Date.now());
          await logw.write(userId, 'pair_unhedged', { pairId, symbol: st.survivor.symbol, ageMin: Math.round(ageMin), graceMin: UNHEDGED_GRACE_MIN }, { actor: 'system:pairs', level: 'warn' });
        }
        out.push({ pairId, state: 'unhedged', ageMin: Math.round(ageMin) });
      }
    } else if (st.state === 'half_closed') {
      const key = `${pairId}:half`;
      if (!alerted.has(key)) {
        alerted.set(key, Date.now());
        await logw.write(userId, 'pair_half_closed', { pairId, divergencePct: st.divergencePct }, { actor: 'system:pairs', level: 'warn' });
        await alert(alerts.pairHalfClosedText(pairId, st.divergencePct)).catch(() => {});
      }
      out.push({ pairId, state: 'half_closed', divergencePct: st.divergencePct });
    } else {
      alerted.delete(`${pairId}:unhedged`);
      alerted.delete(`${pairId}:half`);
      out.push({ pairId, state: st.state });
    }
  }
  return { pairs: out.length, items: out };
}

// Group ALL trades (open + recent closed/rejected) by pairId for the API.
async function status(userId, d = {}) {
  const { store } = deps(d);
  const [open, closed] = await Promise.all([
    store.getOpenTrades(userId),
    store.getClosedTrades(userId, 200),
  ]);
  const all = [...open, ...closed].filter((t) => t.pairId);
  const byPair = new Map();
  for (const t of all) {
    const key = String(t.pairId);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(t);
  }
  const pairs = [];
  for (const [pairId, legs] of byPair) {
    const st = pairState(legs);
    pairs.push({
      pairId, state: st.state, divergencePct: st.divergencePct || null,
      legs: legs.map((t) => ({
        id: t.id, symbol: t.symbol, direction: t.direction, size: t.size,
        status: t.status, openAt: t.openAt, closeAt: t.closeAt, note: t.note,
      })),
    });
  }
  return { count: pairs.length, pairs };
}

module.exports = { REATTEMPT, UNHEDGED_GRACE_MIN, SIZE_TOLERANCE_PCT, newPairId, pairState, openPair, sweep, status };
