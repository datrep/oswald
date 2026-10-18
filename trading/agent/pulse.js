// trading/agent/pulse.js — TRD-11: market pulse narrative ("why is the market
// moving"). A LONG-form, throttled model pass (the slow cousin of the waker):
// aggregates 24h/7d moves across every symbol with daily bars, the Meta
// verdict, the multi-factor top/bottom, the digest, and open/closed P&L, then
// asks the LLM for a human-readable explanation: headline, sentiment,
// movers with reasons, drivers, risks, watch list. Stored as a TradingEvent
// kind 'pulse' (+ a TradingPrompts row for the wake log) and injected into
// every chair bundle so deliberations are informed by WHY, not just lines.
'use strict';

const { getPool, sql } = require('../db');
const { callChat, DEFAULT_MODEL } = require('./deepseek');
const store = require('../store');
const { SYMBOL_MAP } = require('./providers');

// Category marker for a display symbol (powers the UI category chips).
function categorize(name) {
  const entry = SYMBOL_MAP[name] || {};
  if (entry.binance) return 'crypto';
  const y = String(entry.yahoo || '');
  if (y.endsWith('=F')) return 'commodities';
  if (y.endsWith('.SI')) return 'singapore';
  if (y.endsWith('.HK')) return 'hong-kong';
  if (/bitcoin|ethereum|solana|bnb|ripple|stellar|cardano|chainlink|litecoin|polkadot|polygon|filecoin|avalanche|toncoin|tron|uniswap|pax|crypto/i.test(name)) return 'crypto';
  if (/gold|silver|oil|gas|copper|palladium|platinum|corn|soybean|wheat|sugar|coffee|hogs|cattle|aluminum|heating/i.test(name)) return 'commodities';
  if (name === 'SGX') return 'singapore';
  return 'equities';
}

const PULSE_SYSTEM = [
  'You are the MARKET PULSE analyst for a demo trading agent (paper money only).',
  'Your job: explain WHAT is moving and WHY it might be moving — macro forces, sentiment,',
  'technical context, correlations. Never recommend trades; never invent numbers.',
  'If the data is thin or you cannot judge, say so honestly.',
  'Reply with a single JSON object exactly in the shape:',
  '{"headline":"one sentence","sentiment":"risk-on|risk-off|neutral",',
  '"movers":[{"symbol":"BTC","pct":3.2,"why":"short sentence"}],',
  '"drivers":["..."],"risks":["..."],"watch":["..."]}',
  'Limit movers to 8, drivers/risks/watch to 3 items each.',
].join('\n');

function round2(n) { return Math.round(n * 100) / 100; }
function pct(a, b) { return a && b ? round2(((a - b) / b) * 100) : null; }

// One SQL pass: last close + 1-day-ago + 7-days-ago close per venue/symbol
// with daily bars, so movers cover the whole universe, not just the watchlist.
async function dailyMoves(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(`
    SELECT venue, symbol, lastClose, prevClose, weekClose FROM (
      SELECT venue, symbol, closePrice AS lastClose,
             LEAD(closePrice, 1) OVER (PARTITION BY venue, symbol ORDER BY barStart DESC) AS prevClose,
             LEAD(closePrice, 7) OVER (PARTITION BY venue, symbol ORDER BY barStart DESC) AS weekClose,
             ROW_NUMBER() OVER (PARTITION BY venue, symbol ORDER BY barStart DESC) AS rn
      FROM PriceBars
      WHERE userId = @userId AND timeframe = '1d'
    ) t WHERE rn = 1`);
  return r.recordset.map((x) => ({
    symbol: x.symbol,
    venue: x.venue,
    pct24: pct(x.lastClose, x.prevClose),
    pct7d: pct(x.lastClose, x.weekClose),
    last: Number(x.lastClose),
  }));
}

async function buildContext(userId, settings, scope = 'all') {
  const moves = await dailyMoves(userId);
  // Scope: 'all' (default) | 'watchlist' | any other string = symbol query.
  let poolMoves = moves;
  let focus = null;
  if (scope === 'watchlist') {
    const wl = new Set((settings.watchlist?.symbols || []).map((s) => s.symbol.toLowerCase()));
    poolMoves = moves.filter((m) => wl.has(m.symbol.toLowerCase()));
    focus = 'watchlist only';
  } else if (scope && scope !== 'all') {
    const q = String(scope).toLowerCase();
    poolMoves = moves.filter((m) => m.symbol.toLowerCase().includes(q));
    focus = `user query: "${String(scope).slice(0, 80)}"`;
  }
  const ranked = poolMoves.filter((m) => m.pct24 != null).sort((a, b) => Math.abs(b.pct24) - Math.abs(a.pct24));
  const movers = ranked.slice(0, 12).map((m) => ({
    symbol: m.symbol, venue: m.venue, pct24: m.pct24, pct7d: m.pct7d, last: round2(m.last),
  }));

  const meta = await store.latestEvent(userId, 'meta');
  const multi = await store.latestEvent(userId, 'multi_signal');
  const digest = await store.latestEvent(userId, 'digest');
  const open = await store.getOpenTrades(userId);
  const closed = await store.getClosedTrades(userId, 5);
  const watchlist = (settings.watchlist?.symbols || []).map((s) => s.symbol);

  const openSnapshot = [];
  for (const t of open) {
    const m = moves.find((x) => x.symbol === t.symbol && x.venue === t.venue);
    openSnapshot.push({ symbol: t.symbol, direction: t.direction, size: t.size, openPrice: t.openPrice, last: m?.last ?? null });
  }

  return {
    at: new Date().toISOString(),
    watchlist,
    focus: focus || 'whole universe',
    movers,
    meta: meta?.payload || null,
    multiTop: multi?.payload?.top?.slice(0, 3) || null,
    multiBottom: multi?.payload?.bottom?.slice(0, 3) || null,
    digest: digest?.payload?.bullets || null,
    openPositions: openSnapshot,
    closedPnlRecent: closed.map((t) => ({ symbol: t.symbol, pnl: t.grossPnl, status: t.status })),
  };
}

// Stub path for smoke/tests (no network): a canned narrative.
function stubPulse(ctx) {
  return {
    headline: 'stub pulse — markets flat, nothing notable',
    sentiment: 'neutral',
    movers: (ctx.movers || []).slice(0, 3).map((m) => ({ symbol: m.symbol, pct: m.pct24 ?? 0, why: 'stub' })),
    drivers: ['stub'], risks: ['stub'], watch: ['stub'],
  };
}

async function generatePulse(userId, settings, { force = false, scope = 'all' } = {}) {
  const p = settings.pulse || {};
  if (!force && p.enabled === false) return { skipped: 'pulse_disabled' };
  const intervalHours = Math.max(0.25, Number(p.intervalHours) || 4);
  const last = await store.latestEvent(userId, 'pulse');
  const ageMin = last ? (Date.now() - new Date(last.createdAt).getTime()) / 60000 : Infinity;
  if (!force && ageMin < intervalHours * 60) return { skipped: 'recent', ageMin: Math.round(ageMin), latestAt: last.createdAt };

  const ctx = await buildContext(userId, settings, scope);
  const stub = (settings.llm || {}).stub;
  const started = Date.now();
  let pulse, model = 'stub', usage = null, raw = null;
  if (stub) {
    pulse = stubPulse(ctx);
  } else {
    // TRD-12 Phase 2: token budget soft-gate.
    const budget = require('./budget');
    const gate = await budget.allow(userId, settings, 'pulse');
    if (!gate.allowed) return { skipped: 'budget_cap' };
    // 2026-09-11: thinking-model discipline — v4-pro bills reasoning INSIDE
    // max_tokens; the old 800 cap left some pulses empty/unparseable ("pulse
    // parse failure" evidence events). Retry once with headroom on the
    // empty-truncation signature (deepseek.isTruncatedEmpty).
    const parsePulse = (t) => {
      let parsed = null;
      try { parsed = JSON.parse(String(t).trim()); } catch { /* fallthrough */ }
      if (!parsed) {
        const m = String(t || '').match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch { /* */ } }
      }
      return parsed;
    };
    let r = null;
    let parsed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cap = attempt === 0 ? 2000 : 6000;
      r = await callChat(
        [
          {
            role: 'system',
            content: PULSE_SYSTEM + (ctx.focus && ctx.focus !== 'whole universe'
              ? `\nSCOPE: analyze only ${ctx.focus} — movers/drivers/risks must come from those symbols.`
              : ''),
          },
          { role: 'user', content: 'Context JSON: ' + JSON.stringify(ctx) },
        ],
        {
          model: p.model || (settings.llm || {}).model || DEFAULT_MODEL,
          label: 'pulse',
          temperature: 0.3,
          maxTokens: cap,
          timeoutMs: 60000,
          userId,
        }
      );
      model = r.model;
      usage = r.usage;
      raw = r.text;
      budget.record(userId, 'pulse', r.usage, { settings }).catch(() => {});
      parsed = parsePulse(r.text);
      if (parsed) break;
      if (!require('./deepseek').isTruncatedEmpty(r, cap)) break; // real gibberish — fail loudly
      if (!(await budget.allow(userId, settings, 'pulse')).allowed) break; // no double-spend past the cap
    }
    if (!parsed) {
      // Diagnosis: keep the RAW response as a prompt row so failures are
      // visible in the UI (Decisions tab) instead of vanishing.
      await store.createPrompt(userId, {
        triggerType: 'pulse', bundle: { context: ctx }, response: raw,
        decision: { parseFailure: true, headline: 'pulse parse failure' },
        model, usage, latencyMs: Date.now() - started,
      });
      throw new Error('pulse parse failure (raw response stored as a prompt)');
    }
    // LLM movers often come back empty — fall back to the biggest computed
    // daily movers so the card always shows WHAT moved even without a why.
    const llmMovers = (Array.isArray(parsed.movers) ? parsed.movers : []).slice(0, 8)
      .map((m) => ({ ...m, cat: categorize(String(m.symbol || '')) }));
    const movers = llmMovers.length
      ? llmMovers
      : (ctx.movers || []).slice(0, 5).map((m) => ({ symbol: m.symbol, pct: m.pct24 ?? 0, why: '', cat: categorize(m.symbol) }));
    pulse = {
      headline: String(parsed.headline || 'n/a').slice(0, 300),
      sentiment: ['risk-on', 'risk-off', 'neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
      movers,
      drivers: (Array.isArray(parsed.drivers) ? parsed.drivers : []).slice(0, 3),
      risks: (Array.isArray(parsed.risks) ? parsed.risks : []).slice(0, 3),
      watch: (Array.isArray(parsed.watch) ? parsed.watch : []).slice(0, 3),
    };
  }
  const latencyMs = Date.now() - started;
  pulse.at = new Date().toISOString();
  pulse.model = model;

  const promptId = await store.createPrompt(userId, {
    triggerType: 'pulse',
    bundle: { context: ctx },
    response: raw,
    decision: pulse,
    model,
    usage,
    latencyMs,
  });
  await store.logEvent(userId, 'pulse', { ...pulse, promptId, actor: `llm:${model || 'unknown'}:${promptId}`, rationale: pulse.headline });
  return { ...pulse, promptId, latencyMs };
}

module.exports = { generatePulse, dailyMoves, buildContext, categorize };
