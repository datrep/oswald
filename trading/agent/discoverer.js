// trading/agent/discoverer.js — AI watchlist discoverer (second pillar, 2026-09-10).
// Periodic, safety-gated job: gather "interesting" tickers from feeds the desk
// already consumes (congress trades, multi-factor ranks, pulse movers), probe
// Plus500 for each via a lightweight search (searchExists — no chart nav),
// and auto-add matches to the watchlist tagged source:'ai'.
// Safety rails: skipped on kill HARD / bridge paused / paper mode; bridgeUse
// claim; maxAiSymbols cap with oldest-ai-first eviction; age-based fade;
// viability gate (2026-09-11 — aged AI symbols without a usable 1h series are
// evicted, see partitionViable) ; manual (source!=='ai') symbols are NEVER
// touched.
'use strict';

const store = require('../store');
const quant = require('./quant');

const MAX_CANDIDATES = 10;

// Candidate tickers from the latest desk feeds. congress/multi/pulse events
// are already throttled by the waker's telemetry step (12h/6h/4h).
function candidatesFromFeeds(userId, _settings) {
  return Promise.all([
    store.latestEvent(userId, 'congress_signal'),
    store.latestEvent(userId, 'multi_signal'),
    store.latestEvent(userId, 'pulse'),
  ]).then(([congress, multi, pulse]) => {
    const out = new Map();
    const add = (query, source, score) => {
      const q = String(query || '').trim();
      if (!q || q.length > 40) return;
      const prev = out.get(q.toLowerCase());
      if (!prev || prev.score < score) out.set(q.toLowerCase(), { query: q, source, score: Number(score) || 0 });
    };
    for (const r of ((congress && congress.payload && congress.payload.top) || []).slice(0, 5)) {
      add(r.symbol || r.ticker, 'congress', (Number(r.score) || 0) + 1);
    }
    for (const r of ((multi && multi.payload && multi.payload.top) || []).slice(0, 5)) {
      add(r.symbol, 'multi', (Number(r.score) || 0) + 1);
    }
    for (const m of ((pulse && pulse.payload && pulse.payload.movers) || []).slice(0, 5)) {
      add(m.symbol, 'pulse', Math.abs(Number(m.pct) || 0) / 10);
    }
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
  });
}

// Evict oldest AI entries + fade old ones. Returns {ai, evicted, faded}.
function pruneAi(aiEntries, maxAiSymbols, noSignalDays, now) {
  const max = Math.max(0, Math.min(20, Number(maxAiSymbols) || 5));
  const fadeDays = Math.max(1, Number(noSignalDays) || 14) * 2; // age-based fade until signal-tracking lands
  let faded = 0;
  let ai = aiEntries.filter((s) => {
    const at = s.addedAt ? new Date(s.addedAt).getTime() : null;
    if (at && now - at > fadeDays * 86400000) { faded++; return false; }
    return true;
  });
  ai = ai.sort((a, b) => new Date(a.addedAt || 0) - new Date(b.addedAt || 0)); // oldest first
  const evicted = Math.max(0, ai.length - max);
  ai = ai.slice(evicted);
  return { ai, evicted, faded };
}

// 2026-09-11 viability gate. The signal engine (quant.evaluateSymbol) needs
// >= MIN_BARS 1h bars; exchange-hours instruments added by discovery only
// collect a thin 1h series when markets are shut (and some venue-only
// instruments can never reach the minimum at all). An AI symbol that still
// can't clear the bar after a grace period is dead weight — it inflates every
// wake's capture and never produces a signal — so evict it.
const VIABILITY_GRACE_HOURS = 12;
const VIABILITY_VENUES = ['yahoo', 'plus500_chart', 'plus500', 'binance', 'okx'];

// PURE: split AI entries into { keep, unviable } from a per-symbol 1h count.
function partitionViable(aiEntries, barsBySymbol, now = Date.now(), graceHours = VIABILITY_GRACE_HOURS) {
  const keep = [];
  const unviable = [];
  for (const s of aiEntries) {
    const added = s.addedAt ? new Date(s.addedAt).getTime() : 0;
    const young = added > 0 && now - added < graceHours * 3600000;
    const bars = Number(barsBySymbol[String(s.symbol || '').toLowerCase()] || 0);
    if (young || bars >= quant.MIN_BARS) keep.push(s);
    else unviable.push(s);
  }
  return { keep, unviable };
}

// Largest 1h series across venues (stops at the bar minimum — cheap probe).
async function countHourlyBars(userId, symbol) {
  let best = 0;
  for (const v of VIABILITY_VENUES) {
    const rows = await store.listBars(userId, { timeframe: '1h', symbol, venue: v, limit: quant.MIN_BARS }).catch(() => []);
    if (rows.length > best) best = rows.length;
    if (best >= quant.MIN_BARS) break;
  }
  return best;
}

// Probe Plus500 for each candidate and keep the matches (venue display name).
async function matchOnPlus500(userId, settings, candidates) {
  const bridge = require('../plus500/browser');
  const webtrader = require('../plus500/webtrader');
  const health = require('../plus500/health');
  const { bridgeUse } = require('./wakePipeline');
  const page = await bridge.newPage();
  const matches = [];
  bridgeUse('discover', true);
  try {
    await webtrader.gotoPage(page, 'trade', settings);
    await webtrader.assertDemo(page, settings);
    await health.checkAndGate(userId, settings, page).catch(() => {});
    for (const c of candidates) {
      try {
        const r = await webtrader.searchExists(page, c.query, settings);
        matches.push({ ...c, found: r.found, name: r.name || null, full: r.full || null });
        await new Promise((res) => setTimeout(res, 350 + Math.random() * 450));
      } catch (e) {
        matches.push({ ...c, found: false, error: String(e.message || e).slice(0, 120) });
      }
    }
  } finally {
    bridgeUse('discover', false);
    // ★ No bridge.disconnect() — see the SHARED-BRIDGE RULE in connector/browser.js. 'discover'
    // BORROWS the service's shared bridge; it does not own it. Closing it took the venue feed, the
    // mirror pollers and the watchdog down at once while Chrome kept running — the same mistake
    // watchdog.js, maintenance.js, instrumentProbe.js and routes.js each have a note about.
  }
  return matches;
}

// One discovery run. Throttled by settings.discover.intervalHours unless forced.
async function runDiscovery(userId, settings, { force = false } = {}) {
  const dc = settings.discover || {};
  if (!force && dc.enabled !== true) return { skipped: 'disabled', matches: [] };
  const last = await store.latestEvent(userId, 'discover_signal');
  if (!force && last && Date.now() - new Date(last.createdAt).getTime() < (Number(dc.intervalHours) || 12) * 3600000) {
    return { skipped: 'within_interval', matches: [] };
  }
  if (settings.kill?.tier === 'hard') {
    await store.logEvent(userId, 'telemetry', { source: 'discover_pause', reason: 'kill_switch_hard' });
    return { skipped: 'kill_switch_hard', matches: [] };
  }
  if (settings.bridge?.paused) {
    await store.logEvent(userId, 'telemetry', { source: 'discover_pause', reason: 'bridge_paused' });
    return { skipped: 'bridge_paused', matches: [] };
  }
  if (settings.paper?.enabled) return { skipped: 'paper_mode', matches: [] };

  const candidates = await candidatesFromFeeds(userId, settings);
  if (!candidates.length) {
    await store.logEvent(userId, 'discover_signal', { candidates: 0, matches: [], added: 0, skippedReason: 'no_candidates', at: new Date().toISOString() });
    return { skipped: 'no_candidates', matches: [] };
  }
  const known = new Set((settings.watchlist?.symbols || []).map((s) => String(s.symbol || '').toLowerCase()));
  const fresh = candidates.filter((c) => !known.has(c.query.toLowerCase()));
  if (!fresh.length) {
    await store.logEvent(userId, 'discover_signal', { candidates: candidates.length, matches: [], added: 0, skippedReason: 'all_already_tracked', at: new Date().toISOString() });
    return { skipped: 'all_already_tracked', matches: [] };
  }

  const matches = await matchOnPlus500(userId, settings, fresh);
  const hits = matches.filter((m) => m.found && m.name);

  // Build the new symbols array: manual entries untouched, AI entries pruned.
  const symbols = settings.watchlist?.symbols || [];
  const manual = symbols.filter((s) => (s.source || 'manual') !== 'ai');
  const prevAi = symbols.filter((s) => (s.source || 'manual') === 'ai');
  const knownNames = new Set(symbols.map((s) => String(s.symbol || '').toLowerCase()));
  const added = [];
  for (const h of hits) {
    const name = String(h.name).trim();
    if (!name || knownNames.has(name.toLowerCase())) continue;
    prevAi.push({ symbol: name, venue: 'plus500', source: 'ai', addedAt: new Date().toISOString(), via: h.source });
    knownNames.add(name.toLowerCase());
    added.push(name);
  }
  const { ai, evicted, faded } = pruneAi(prevAi, dc.maxAiSymbols, dc.noSignalDays, Date.now());
  // Viability gate: aged AI symbols that still can't clear quant.MIN_BARS of
  // 1h bars are unevaluable — evict instead of hauling them through capture.
  let unviable = [];
  let viable = ai;
  if (ai.length) {
    const counts = {};
    for (const s of ai) counts[String(s.symbol || '').toLowerCase()] = await countHourlyBars(userId, s.symbol);
    const part = partitionViable(ai, counts, Date.now(), VIABILITY_GRACE_HOURS);
    viable = part.keep;
    unviable = part.unviable;
  }
  const final = [...manual, ...viable];
  const dropped = unviable.map((s) => s.symbol);

  let applied = false;
  if (added.length || evicted || faded || dropped.length) {
    await store.saveSettings(userId, { watchlist: { symbols: final } });
    applied = true;
  }

  await store.logEvent(userId, 'discover_signal', {
    candidates: candidates.map((c) => c.query),
    matched: hits.map((h) => h.name),
    added, evicted, faded, unviable: dropped, applied, at: new Date().toISOString(),
  });
  await store.logEvent(userId, 'telemetry', { source: 'watchlist_discover', candidates: candidates.length, matches: hits.length, added, evicted, faded, unviable: dropped.length });

  // 2026-09-11: an unviable AI symbol gets the alternative-proxy agent —
  // correlated, evaluable alternatives + a pulse on the best one.
  // Fire-and-forget: discovery must never stall on an LLM call.
  if (unviable.length) {
    require('./alternatives').suggest(userId, settings, { symbol: unviable[0].symbol, reason: 'unviable_no_1h_series' })
      .catch((e) => store.logEvent(userId, 'error', { where: 'alternatives', error: String(e.message || e).slice(0, 160) }).catch(() => {}));
  }
  return { candidates: candidates.length, matches: hits.length, added, evicted, faded, unviable: dropped, applied, matchedNames: hits.map((h) => h.name) };
}

module.exports = { runDiscovery, candidatesFromFeeds, pruneAi, partitionViable, countHourlyBars, VIABILITY_GRACE_HOURS, MAX_CANDIDATES };
