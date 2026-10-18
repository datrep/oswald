// trading/agent/telemetry/values.js — record physical observations, and read them back for the reviewer.
//
// WHY RECORD AND READ, RATHER THAN FETCH AT DECISION TIME. The reviewer runs inside a wake, and a wake
// that issues a 15-second network call to a third party has borrowed an outage from that third party:
// this desk already lost four hours of wakes to a ten-minute DNS blip. So the network work is done on
// a cadence by a separate step, and the reviewer reads what the desk HAS — which also fixes the as-of
// the prompt cites, so a proposal and the observation it cites cannot drift apart mid-decision.
//
// TWO FRESHNESS CHECKS, DELIBERATELY. The adapter judges freshness when it records; this module judges
// it AGAIN when it reads, from the report's own date. A weekly figure is not made current by having
// been recorded recently — TRD-62/TRD-PRC-1 are the same defect pointed at ticks instead of reports.
'use strict';

const registry = require('./index');

const KIND = 'telemetry_observation';

// Collect from every wired source covering these symbols and journal one event per source.
// Failures are RECORDED, not thrown: a source that broke is a fact the owner needs in the log, and a
// silent absence is indistinguishable from a source that was simply never asked.
async function record(userId, { symbols = [], now = new Date(), fetchImpl = fetch, store = null, ids = null } = {}) {
  const s = store || require('../../store');
  const { results } = await registry.collect({ ids, symbols, now, fetchImpl });
  const written = [];
  for (const r of results) {
    const payload = {
      sourceId: r.id,
      provider: r.provider || null,
      ok: r.ok === true,
      reason: r.reason || null,
      url: r.url || null,
      fetchedAt: r.fetchedAt || new Date(now).toISOString(),
      rows: r.rows != null ? r.rows : null,
      asOf: r.asOf || null,
      cadence: (registry.meta(r.id) || {}).cadence || null,
      observations: r.observations || [],
    };
    try { await s.logEvent(userId, KIND, payload); written.push(payload); } catch { /* journalling must not break the pull */ }
  }
  return { results, written };
}

function ageDaysOf(asOf, now) {
  if (!asOf) return null;
  const d = (new Date(now).getTime() - new Date(asOf).getTime()) / 86400000;
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
}

// PURE. Newest observation per source, with freshness RECOMPUTED at read time from the report's own
// date and the source's cadence allowance. `now` is injected.
function decorate(events, { now = new Date() } = {}) {
  const newest = new Map();
  for (const e of (events || [])) {
    const p = e.payload || {};
    if (!p.sourceId) continue;
    const at = new Date(p.fetchedAt || e.createdAt).getTime();
    const cur = newest.get(p.sourceId);
    if (!cur || at > cur.at) newest.set(p.sourceId, { at, payload: p });
  }
  const out = {};
  for (const [sourceId, { payload }] of newest.entries()) {
    const m = registry.meta(sourceId) || {};
    const allowance = m.staleAfterDays != null ? m.staleAfterDays : null;
    const observations = (payload.observations || []).map((o) => {
      if (o.state !== 'ok') return o;
      const ageDays = ageDaysOf(o.asOf, now);
      return { ...o, ageDays, fresh: allowance != null && ageDays != null ? ageDays <= allowance : null };
    });
    out[sourceId] = {
      sourceId,
      provider: payload.provider || null,
      ok: payload.ok === true,
      reason: payload.reason || null,
      asOf: payload.asOf || null,
      cadence: payload.cadence || m.cadence || null,
      recordedAt: payload.fetchedAt || null,
      ageDays: ageDaysOf(payload.asOf, now),
      staleAfterDays: allowance,
      observations,
    };
  }
  return out;
}

// PURE. The per-symbol value block the reviewer sees: the REAL value with its as-of, cadence and age.
// Availability ("a source exists") and a value ("this is what it says") must not arrive looking alike —
// which is exactly the confusion the catalogue was built to prevent, one level up.
function render(latest, symbols = []) {
  const out = {};
  for (const symbol of symbols) {
    const rows = [];
    for (const source of Object.values(latest || {})) {
      for (const o of (source.observations || [])) {
        if (o.symbol !== symbol) continue;
        if (o.state !== 'ok') {
          rows.push({ source: source.sourceId, state: o.state, reason: o.reason || null, asOf: o.asOf || null, cadence: source.cadence });
          continue;
        }
        rows.push({
          source: source.sourceId,
          asOf: String(o.asOf || '').slice(0, 10),
          ageDays: o.ageDays,
          cadence: source.cadence,
          fresh: o.fresh,
          managedMoneyNet: o.net,
          netPctOfOpenInterest: o.netPctOfOpenInterest,
          netPercentile: o.netPercentile,
          percentileWindowWeeks: o.percentileWindowWeeks,
          changeNet: o.changeNet,
        });
      }
    }
    if (rows.length) out[symbol] = rows;
  }
  return out;
}

// The as-of dates only, for change detection: a NEW report should make the reviewer reconsider, but a
// re-render of the same report should not.
function signatureOf(latest) {
  return Object.fromEntries(Object.entries(latest || {}).map(([id, s]) => [id, s.asOf || null]));
}

async function latest(userId, { days = 30, now = new Date(), store = null } = {}) {
  const s = store || require('../../store');
  const events = await s.listEvents(userId, { kind: KIND, limit: 200 });
  const floor = new Date(now).getTime() - days * 86400000;
  const recent = events.filter((e) => new Date(e.createdAt).getTime() >= floor);
  return decorate(recent, { now });
}

module.exports = { KIND, record, decorate, render, signatureOf, latest, ageDaysOf };
