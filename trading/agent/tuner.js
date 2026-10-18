// trading/agent/tuner.js — Phase 2 of the implied goal: bounded self-tuning.
// A periodic LLM pass that may tweak strategy params and enable/disable
// strategies WITHIN declared rails. The LLM proposes; the code enforces.
//
// Rails (hard, server-side — LLM output is clamped, never trusted):
//   * only params declared in the strategy's PARAMS (each has min/max/step)
//   * each param delta <= 20% of its declared range per run
//   * at most maxChangesPerRun (default 3) applied per pass
//   * >= 1 strategy always stays enabled (turtle is the last-resort floor)
//   * never touches risk / kill / watchlist / budget blocks
//   * runs ONLY when tuner.enabled AND (sim desk OR learning.parityValidated)
//   * kill HARD = skip · intervalHours throttle · budget consumer 'strategy_tune'
//
// Every applied pass logs a `tune` event with per-change before/after JSON so
// the Strategy tab can list AI adjustments with one-click revert. Reverts log
// `tune_revert` for the audit trail.
'use strict';

const store = require('../store');

const live = { last: null, running: false };
const DELTA_PCT = 0.2;
const DEFAULT_MAX_CHANGES = 3;

// Clamp one param: hard min/max from the registry + delta bound + step snap.
function clampChange(p, current, proposed) {
  let v = Number(proposed);
  if (!Number.isFinite(v)) return null;
  const min = Number(p.min);
  const max = Number(p.max);
  const range = Math.abs(max - min);
  const bound = Math.max(range * DELTA_PCT, Math.abs(Number(p.step) || 1) * 1.0001);
  v = Math.min(Math.max(v, current - bound), current + bound); // per-run delta bound
  v = Math.min(Math.max(v, min), max);                          // declared hard bounds
  const step = Number(p.step);
  if (Number.isFinite(step) && step > 0) v = Math.round(v / step) * step;
  v = Math.min(Math.max(v, min), max);
  return Number(v.toFixed(6));
}

function parseTunerJson(text) {
  if (!text) return null;
  let candidate = String(text).trim();
  candidate = candidate.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
  try {
    const obj = JSON.parse(candidate);
    if (obj && Array.isArray(obj.changes)) return obj;
  } catch { /* fall through */ }
  const m = candidate.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && Array.isArray(obj.changes)) return obj;
    } catch { /* fall through */ }
  }
  return null;
}

function buildMessages({ registry, stats, driftFlags, equity, paperMode, parityValidated, autopsies }) {
  const system = [
    'You are the STRATEGY TUNER of a disciplined DEMO trading desk.',
    'You propose small, evidence-based adjustments to registered strategies.',
    'ONLY propose changes to the strategies listed in the registry below.',
    'Each change must be justified by the performance evidence provided.',
    'Hard rails (the server clamps anything that violates them):',
    '  - a param may move at most 20% of its declared range per pass',
    '  - every param has a declared min/max/step — stay inside them',
    '  - at most 3 changes per pass',
    '  - at least one strategy must stay enabled',
    '  - never touch risk, kill switch, watchlist or budget settings',
    'If the evidence shows nothing worth changing, return an empty changes array.',
    'Answer with a single JSON object exactly in the shape:',
    '{"reasoning":"one short sentence","changes":[{"strategy":"<id>","params":{"<key>":<number>},"enabled":<bool|null>,"reasoning":"why, citing evidence"}]}',
    'Omit "params" when not changing params; set "enabled" only to flip it.',
  ].join('\n');
  const user = JSON.stringify({
    desk: { paperMode, parityValidated, note: parityValidated ? 'parity validated — tuning allowed on live desk' : 'parity NOT validated — this is the SIM desk' },
    strategies: registry.map((s) => ({
      id: s.id, name: s.name, enabled: s.enabled,
      params: s.params.map((p) => ({ key: p.key, label: p.label, value: p.value, min: p.min, max: p.max, step: p.step })),
    })),
    performance30d: stats,
    driftFlags,
    // P2-15c (2026-09-10): recent loss autopsies are tuner evidence — the
    // tuner should cite WHY recent losses happened before touching params.
    recentAutopsies: (autopsies || []),
    equity: (equity || []).slice(0, 10),
  }, null, 1);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function run(userId, settings, { force = false, dryRun = false } = {}) {
  const cfg = settings.tuner || {};
  const paperMode = !!(settings.paper && settings.paper.enabled);
  const parityValidated = !!(settings.learning && settings.learning.parityValidated);
  // TRD-112 (2026-09-21): EVERY GATE DECISION IS RECORDED, BECAUSE SIX OF THEM WERE SILENT.
  //
  // This scheduler fires every 6h from server.js and self-throttles to `tuner.intervalHours`. The live desk has
  // `tuner.enabled: true` and `learning.parityValidated: false`, so every run was refused at the parity gate and
  // returned a plain object to a caller that discards it — leaving NO event, not even a skip. The row read "the
  // tuner has never run", and the honest measurement was worse: it had been running every 6 hours for eleven
  // days, declining every time, and recording nothing that could say so. A dial that is ON and produces no
  // evidence of its own decisions is the defect (the same one TRD-40 named for the kill switch).
  //
  // One event per run — ~4/day against ~96/day of `self_health`, so the trail is cheap, and a countable
  // heartbeat is exactly what "has it ever run?" needs.
  const skip = (gate, extra = {}) => {
    store.logEvent(userId, 'tune_skipped', {
      at: new Date().toISOString(), gate, paperMode, parityValidated, force: !!force, ...extra,
    }).catch(() => {});
    return { skipped: gate, ...extra };
  };
  if (cfg.enabled === false && !force) return skip('disabled');
  if (live.running) return skip('already_running');
  live.running = true;
  try {
    const lastTune = await store.latestEvent(userId, 'tune');
    const intervalH = Math.max(6, Number(cfg.intervalHours) || 24);
    if (!force && lastTune && lastTune.createdAt
      && (Date.now() - new Date(lastTune.createdAt).getTime()) < intervalH * 3600000) {
      return skip('interval', { latest: lastTune.payload });
    }
    if (settings.kill && settings.kill.tier === 'hard') return skip('kill_switch_hard');
    if (!paperMode && !parityValidated) {
      return skip('parity_not_validated', { hint: 'live desk needs learning.parityValidated; the sim desk is always allowed' });
    }

    const budget = require('./budget');
    const gate = await budget.allow(userId, settings, 'strategy_tune');
    if (!gate.allowed) return skip('budget', { detail: gate.reason });

    const strategies = require('./strategies');
    const analytics = require('./analytics');
    // ★ TRD-TUN-2, second half (2026-09-28): A TUNER MUST NOT PROPOSE A VALUE IT CANNOT MAKE EFFECTIVE.
    //
    // The tuner WRITES `settings.strategies.params.<id>` — the GLOBAL layer. When a strategy runs on symbols
    // that carry a `symbolParams` entry, the PER-SYMBOL layer shadows whatever the tuner writes, so the
    // proposal would be recorded, displayed and ignored: the exact defect the row was raised for, and the
    // shape this desk keeps re-finding (a control that renders but does nothing).
    //
    // ⚠ WHY EXCLUDE RATHER THAN WARN. The row's option (b) is to resolve per scoped symbol and refuse a
    // strategy whose value differs by symbol. A warning beside a written value is not enough here: `binding.js`
    // ALREADY warns for the inert case and the row records that the warning did not prevent the state from
    // being creatable. Excluding removes the proposal from the prompt, so the LLM cannot ask for it at all.
    //
    // ⚠ THE COST IS ZERO TODAY, AND THAT IS NOT THE ARGUMENT. Measured on this desk: the tuner has NEVER
    // written anything — every one of its 19 events is `tune_skipped`, gated on `parity_not_validated`. So this
    // forbids nothing it was doing; it removes a hazard from the day the gate opens.
    const scopeResolution = require('../scopeResolution');
    const watchlist = scopeResolution.watchlistSymbols(settings.watchlist);
    const registryAll = strategies.list(settings);
    const shadowedStrategies = [];
    const registry = registryAll.filter((s) => {
      const symbols = strategies.scopedSymbols(settings, s.id, watchlist);
      const div = strategies.paramDivergence(settings, s.id, symbols);
      if (!div.length) return true;
      shadowedStrategies.push({
        strategy: s.id,
        symbols,
        params: div.map((d) => ({ key: d.key, values: d.values })),
      });
      return false;
    });
    const [stats, driftRes, eq, autopsyEvents] = await Promise.all([
      analytics.strategyStats(userId, { days: 30 }),
      analytics.drift(userId),
      store.listEquity(userId, { mode: paperMode ? 'sim' : 'demo', limit: 10 }),
      store.listEvents(userId, { kind: 'autopsy', limit: 5 }),
    ]);
    const autopsies = autopsyEvents.map((e) => ({
      symbol: e.payload && e.payload.symbol,
      tradeId: e.payload && e.payload.tradeId,
      metrics: e.payload && e.payload.metrics,
      writeup: e.payload && e.payload.writeup ? String(e.payload.writeup).slice(0, 200) : null,
    }));

    const messages = buildMessages({
      registry, stats, driftFlags: driftRes.flags || [], equity: eq, paperMode, parityValidated, autopsies,
    });
    const t0 = Date.now();
    // Stub mode mirrors deepseek's convention: canned JSON for offline tests.
    const stub = (settings.llm || {}).stub;
    const r = stub
      ? {
        text: JSON.stringify({
          reasoning: 'stub tune (offline test)',
          changes: [{ strategy: 'rsi2', params: { low: 8, high: 88 }, enabled: true, reasoning: 'stub narrows the oversold band' }],
        }),
        model: 'stub',
        usage: { promptCacheHitTokens: 3, promptCacheMissTokens: 200, completionTokens: 40 },
      }
      : await require('./deepseek').callChat(messages, {
        model: (settings.tuner && settings.tuner.model) || (settings.llm && settings.llm.model) || require('./deepseek').DEFAULT_MODEL,
        temperature: 0.2,
        maxTokens: 900,
        timeoutMs: 60000,
        jsonMode: true,
        userId,
      });
    const latencyMs = Date.now() - t0;
    if (r.usage) budget.record(userId, 'strategy_tune', r.usage, { settings }).catch(() => {});

    const parsed = parseTunerJson(r.text);
    if (!parsed) {
      const payload = { at: new Date().toISOString(), skipped: 'unparseable_response', raw: String(r.text || '').slice(0, 400), model: r.model, actor: `llm:${r.model}` };
      await store.logEvent(userId, 'tune', payload);
      return payload;
    }

    const cur = settings.strategies || {};
    const curEnabled = (Array.isArray(cur.enabled) ? cur.enabled : []).slice();
    const curParams = JSON.parse(JSON.stringify(cur.params || {}));
    const maxChanges = Math.max(1, Number(cfg.maxChangesPerRun) || DEFAULT_MAX_CHANGES);
    const applied = [];
    const rejected = [];

    for (const ch of (parsed.changes || []).slice(0, maxChanges)) {
      const id = String((ch && ch.strategy) || '').trim();
      const s = strategies.get(id);
      if (!s || !Array.isArray(s.params) || !s.params.length) {
        rejected.push({ strategy: id, reason: 'not_a_registered_strategy' });
        continue;
      }
      // Full EFFECTIVE map (defaults included) so before/after JSON and the
      // one-click revert are exact even when there was no stored override.
      const beforeParams = {};
      for (const p of s.params) {
        beforeParams[p.key] = curParams[id] && curParams[id][p.key] != null
          ? Number(curParams[id][p.key]) : Number(p.def);
      }
      const afterParams = { ...beforeParams };
      let paramChanges = 0;
      if (ch.params && typeof ch.params === 'object') {
        for (const p of s.params) {
          if (!(p.key in ch.params)) continue;
          const curVal = afterParams[p.key] != null ? Number(afterParams[p.key]) : Number(p.def);
          const v = clampChange(p, curVal, ch.params[p.key]);
          if (v == null) { rejected.push({ strategy: id, param: p.key, reason: 'non_numeric' }); continue; }
          if (v === curVal) continue;
          afterParams[p.key] = v;
          paramChanges += 1;
        }
      }
      let enabledChange = null;
      if (typeof ch.enabled === 'boolean') {
        const isOn = curEnabled.includes(id);
        if (ch.enabled !== isOn) enabledChange = { before: isOn, after: ch.enabled };
      }
      if (!paramChanges && !enabledChange) {
        rejected.push({ strategy: id, reason: 'no_effective_change' });
        continue;
      }
      curParams[id] = afterParams;
      if (enabledChange) {
        const set = new Set(curEnabled);
        if (enabledChange.after) set.add(id); else set.delete(id);
        curEnabled.length = 0;
        curEnabled.push(...set);
      }
      applied.push({
        strategy: id,
        params: paramChanges ? { before: beforeParams, after: afterParams } : null,
        enabled: enabledChange,
        reasoning: String(ch.reasoning || '').slice(0, 200),
      });
    }

    // Safety rail: the desk must never end up with zero enabled strategies.
    if (!curEnabled.length) {
      curEnabled.push('turtle');
      applied.push({ strategy: 'turtle', enabled: { before: false, after: true }, params: null, reasoning: 'safety rail: at least one strategy must stay enabled' });
    }

    if (!applied.length) {
      const payload = { at: new Date().toISOString(), model: r.model, changes: [], rejected, skipped: 'no_valid_changes', raw: String(r.text || '').slice(0, 400), actor: `llm:${r.model}`, shadowedStrategies: shadowedStrategies.length ? shadowedStrategies : null };
      await store.logEvent(userId, 'tune', payload);
      return payload;
    }

    if (!dryRun) {
      await store.saveSettings(userId, { strategies: { enabled: curEnabled, params: curParams } });
    }
    const payload = {
      at: new Date().toISOString(), model: r.model, latencyMs,
      changes: applied, rejected, paperMode, parityValidated, dryRun: !!dryRun,
      // ★ TRD-TUN-2: an excluded strategy must be VISIBLE, not merely absent from the prompt — otherwise
      // "the tuner considered it and could not act" is indistinguishable from "the tuner never saw it".
      shadowedStrategies: shadowedStrategies.length ? shadowedStrategies : null,
      shadowedNote: shadowedStrategies.length
        ? 'these strategies were EXCLUDED from the proposal set: their params resolve differently across the symbols they can run on, so a write to the global layer would be shadowed by the per-symbol layer and the change would be recorded, displayed and ignored (TRD-TUN-2)'
        : null,
      actor: `llm:${r.model}`,
    };
    await store.logEvent(userId, 'tune', payload);
    live.last = payload;
    if (!dryRun) {
      await require('../lib/http').telegramAlert(
        `OSWALD self-tune: applied ${applied.length} bounded strategy change(s)${paperMode ? ' (SIM desk)' : ''} — ${applied.map((c) => c.strategy).join(', ')}. Revert from the Strategy tab.`
      ).catch(() => {});
    }
    return payload;
  } finally {
    live.running = false;
  }
}

async function revert(userId, { eventId, index = 0 }) {
  const events = await store.listEvents(userId, { kind: 'tune', limit: 50 });
  const ev = events.find((e) => String(e.id) === String(eventId));
  if (!ev || !ev.payload) return { error: 'tune event not found' };
  // ★ TRD-TUN-1 (2026-09-29): A DRY RUN WROTE NOTHING, SO THERE IS NOTHING TO UNDO. `run()` guards every write
  // with `if (!dryRun)`, but `revert()` never inspected the field at all, so the Strategy tab offered a working
  // Revert on proposals that were never applied. Two distinct harms, and the second is the bad one:
  //   · TODAY it is a no-op that STILL WRITES a `tune_revert` row — a record asserting a live change was undone
  //     when nothing had been changed and nothing needed undoing. Measured: event 4544 (a stub-model dry run)
  //     whose before-map already equals the live settings of userId 1, so reverting it moves no value and still
  //     claims an undo;
  //   · IN GENERAL `params.before` is the FULL effective map AT THE TIME OF THE PROPOSAL, so if the settings
  //     have moved since, reverting a dry run SILENTLY ADOPTS parameters from a proposal that was never
  //     executed — a settings mutation with no gate, wearing the provenance of an ordinary undo.
  // Refusing writes nothing and logs nothing, which is the point: a refused revert must not itself become a
  // record. The guard has the payload in hand already, because this load is how the event was found.
  if (ev.payload.dryRun === true) {
    return {
      refused: true,
      error: 'that tune event was a DRY RUN — it applied nothing, so there is nothing to revert. Reverting it would write the proposal\'s stale before-values into live settings.',
    };
  }
  const changes = (ev.payload.changes || []);
  const idx = Number(index);
  const ch = changes[Number.isFinite(idx) ? idx : 0];
  if (!ch) return { error: 'change not found in that tune event' };

  const settings = await store.getSettings(userId);
  const cur = settings.strategies || {};
  const params = JSON.parse(JSON.stringify(cur.params || {}));
  if (ch.params) {
    // before maps are FULL effective maps — merging restores exact values.
    params[ch.strategy] = { ...(params[ch.strategy] || {}), ...ch.params.before };
  }
  const enabled = new Set((Array.isArray(cur.enabled) ? cur.enabled : []).slice());
  if (ch.enabled) {
    if (ch.enabled.before) enabled.add(ch.strategy); else enabled.delete(ch.strategy);
  }
  const next = Array.from(enabled);
  if (!next.length) next.push('turtle');
  await store.saveSettings(userId, { strategies: { enabled: next, params } });
  await store.logEvent(userId, 'tune_revert', { eventId: ev.id, index: Number(index), strategy: ch.strategy, restored: ch, actor: `human:${userId}` });
  return { reverted: ch.strategy, eventId: ev.id };
}

module.exports = { run, revert, latest: () => live.last };
