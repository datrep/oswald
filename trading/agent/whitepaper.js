// trading/agent/whitepaper.js — TRD-12 Phase 2: the market-state white paper.
// Three tiers, per user spec:
//   yearly  (restart baseline; the yearly draft pulls from the last 12 monthlies)
//   monthly (the working base)
//   weekly  (additive events layer)
// Authored by deepseek-v4-pro over DESK FACTS (never generalities).
// Stored as TradingEvents kind 'whitepaper' {tier, period, text, at}.
// Black-swan refresh: extreme moves (>10% daily gap) or sector-fundamental
// events (CorporateEvents halt/earnings today) regenerate all tiers on demand.
'use strict';

const store = require('../store');
const deepseek = require('./deepseek');
const { telegramAlert } = require('../lib/http');

const generating = new Set(); // per-tier in-process lock

function periodFor(now, tier) {
  if (tier === 'yearly') return String(now.getUTCFullYear());
  if (tier === 'monthly') return now.toISOString().slice(0, 7); // YYYY-MM
  // ISO week
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function latest(userId, tier) {
  const events = await store.listEvents(userId, { kind: 'whitepaper', limit: 30 });
  return events.find((e) => e.payload && e.payload.tier === tier) || null;
}

// TRD-WP-1 (#1502, 2026-10-02): the period gate as a PURE decision, so the one rule is testable without the
// LLM or the store. `force` bypasses it — the owner's manual key (Generate now / black swan); auto paths stay
// throttled, so a paper is never rewritten silently by cadence logic.
const periodGate = (existing, period, force) => !force && !!(existing && existing.payload && existing.payload.period === period);

// Generate ONE tier. Yearly drafts pull in the last 12 monthlies as the base.
// `force: true` REWRITES a current-period tier (TRD-WP-1: before this, nothing could — the message on the
// dashboard stayed stale until the period rolled, and the black-swan path that claimed to force was a no-op).
async function generate(userId, settings, tier, { force = false } = {}) {
  const period = periodFor(new Date(), tier);
  const existing = await latest(userId, tier);
  if (periodGate(existing, period, force)) return existing; // current period already written (unless forced)
  if (generating.has(tier)) return existing; // another wake is already writing it
  generating.add(tier);

  const tree = await require('./stateTree').buildStateTree(userId);
  const facts = require('./context').deskFacts(tree, require('./strategies'));

  // TRD-12 Phase 2: token budget soft-gate (whitepaper is the most expensive
  // consumer — the reasoner).
  const budget = require('./budget');
  const gate = await budget.allow(userId, settings, 'whitepaper');
  if (!gate.allowed) throw new Error('budget_cap');

  let historyNote = '';
  if (tier === 'yearly') {
    const monthlies = (await store.listEvents(userId, { kind: 'whitepaper', limit: 30 }))
      .filter((e) => e.payload && e.payload.tier === 'monthly').slice(0, 12);
    if (monthlies.length) {
      historyNote = '\n\nPAST MONTHLY WHITE PAPERS (chronological, use as the base):\n' +
        monthlies.reverse().map((e) => `[${e.payload.period}] ${String(e.payload.text).slice(0, 500)}`).join('\n\n');
    }
  }

  const system = tier === 'yearly'
    ? 'You are the market-state white-paper writer for a trading desk. Write the YEARLY strategic baseline: macro regime, structural trends, what a full year of trading should assume. Use ONLY the desk facts + past monthlies below. Grounded, no invented numbers. 200-300 words, plain text.'
    : tier === 'monthly'
      ? 'You are the market-state white-paper writer for a trading desk. Write the MONTHLY working base: the regime the desk trades in this month, key levels, risks. Use ONLY the desk facts. Grounded, no invented numbers. 150-250 words, plain text.'
      : 'You are the market-state white-paper writer for a trading desk. Write the WEEKLY additive layer: what changed this week and what it means for open positions and next trades. Use ONLY the desk facts. Grounded, no invented numbers. 100-200 words, plain text.';

  let r = await deepseek.callChat([
    { role: 'system', content: system },
    { role: 'user', content: `DESK FACTS (current machine state):\n${facts}${historyNote}` },
  ], { model: settings.whitepaper?.model || deepseek.DEFAULT_MODEL, temperature: 0.3, maxTokens: settings.whitepaper?.maxTokens || 1500, jsonMode: false, timeoutMs: 120000, userId, label: 'whitepaper' });

  let text = String(r.text || '').trim().slice(0, 4000);
  // Reasoner sometimes returns empty on long yearly prompts — retry once on the
  // same tier (reliable) rather than dropping the tier; only caps/timeout change.
  if (!text) {
    r = await deepseek.callChat([
      { role: 'system', content: system },
      { role: 'user', content: `DESK FACTS (current machine state):\n${facts}${historyNote}` },
    ], { model: deepseek.DEFAULT_MODEL, temperature: 0.3, maxTokens: settings.whitepaper?.maxTokens || 1200, jsonMode: false, timeoutMs: 60000, userId, label: 'whitepaper' });
  }
  text = String(r.text || '').trim().slice(0, 4000);
  if (!text) throw new Error('empty whitepaper response');
  deepseek.meterUsage(r.model, r.usage, 'whitepaper').catch(() => {});
  budget.record(userId, 'whitepaper', r.usage, { settings }).catch(() => {});
  budget.maybeWarn(userId, settings).catch(() => {});
  // TRD-UI-3 / F5 (2026-09-22): RECORD THE BOOK THE PAPER WAS WRITTEN UNDER.
  //
  // F5's finding is that the white paper is the most authoritative-looking panel on the desk and can
  // describe a desk that no longer exists — the audit's example is the paper and the live header
  // CONTRADICTING EACH OTHER ON THE KILL TIER. The requested rule, "mark it superseded when its asOf
  // precedes the last book/tier change", was not decidable, because nothing recorded which book the paper
  // described; the panel could only render the paper's AGE. Age is a proxy for that question and a weak
  // one: a four-day-old paper can still be exactly right, and an hour-old one can already be wrong because
  // the kill tier was raised at 09:00.
  //
  // So the missing half is recorded at the source. The three facts here are the ones `deskFacts` LEADS
  // WITH when the paper is written ("KILL SWITCH: tier ...", "STRATEGIES ENABLED: ...", "MODE: ..."), so
  // they are precisely the claims the paper's prose speaks to. Additive payload fields only — no migration,
  // and older papers simply have no `book` (the UI says so rather than guessing).
  const book = {
    mode: tree.mode,
    killTier: (tree.kill && tree.kill.tier) || 'off',
    enabled: (tree.strategies || []).slice().sort(),
  };
  const payload = { tier, period, text, model: r.model, at: new Date().toISOString(), actor: `llm:${r.model}`, book };
  await store.logEvent(userId, 'whitepaper', payload);
  return { payload };
}

// Ensure all three tiers exist for their current periods (fire-and-forget
// friendly; each tier self-throttles on period match). `opts.force` (TRD-WP-1
// #1502) rewrites every tier NOW — the manual key and the black-swan path.
async function ensureCurrent(userId, settings, { force = false } = {}) {
  const results = [];
  for (const tier of ['weekly', 'monthly', 'yearly']) {
    try { results.push(await generate(userId, settings, tier, { force })); }
    catch (e) { await store.logEvent(userId, 'error', { where: `whitepaper_${tier}`, error: String(e.message || e).slice(0, 160) }); }
    finally { generating.delete(tier); }
  }
  return results;
}

// Condensed sections for injection into LLM contexts (all tiers, newest text).
async function bundleSections(userId, { maxChars = { weekly: 900, monthly: 500, yearly: 300 } } = {}) {
  const out = {};
  for (const tier of ['weekly', 'monthly', 'yearly']) {
    const ev = await latest(userId, tier);
    if (ev && ev.payload && ev.payload.text) {
      out[tier] = { period: ev.payload.period, at: ev.payload.at, text: String(ev.payload.text).slice(0, maxChars[tier] || 600) };
    }
  }
  return Object.keys(out).length ? out : null;
}

// Black-swan detector: >10% daily gap on any watchlist symbol, or a
// CorporateEvents halt/earnings today. Regenerates all tiers + Telegram.
async function detectBlackSwan(userId, settings, _quantResult, _liveEquity) {
  try {
    const symbols = (settings.watchlist?.symbols || []).map((s) => s.symbol);
    let hit = null;
    for (const symbol of symbols) {
      // 2026-09-10: compute the daily gap from 1h-DERIVED closes (last two
      // UTC days) instead of trusting the 1d table — provider-native 1d rows
      // can be degenerate (o=h=l=c) or duplicate the aggregator's rows, which
      // produced a false "Arabica Coffee −10.9%" black swan on 2026-09-10.
      const bars = await store.listBars(userId, { timeframe: '1h', symbol, venue: 'yahoo', limit: 12000 });
      if (bars.length < 48) continue;
      const byDay = new Map();
      for (const b of bars) {
        const c = Number(b.closePrice);
        if (!Number.isFinite(c) || c <= 0) continue;
        const d = new Date(b.barStart);
        byDay.set(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), c); // ascending — last close wins
      }
      const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
      if (days.length < 2) continue;
      const prev = days[days.length - 2][1];
      const last = days[days.length - 1][1];
      if (prev > 0 && Math.abs((last - prev) / prev) * 100 > Number(settings.whitepaper?.blackSwanGapPct ?? 10)) {
        hit = { symbol, gapPct: +(((last - prev) / prev) * 100).toFixed(2) };
        break;
      }
    }
    if (!hit) {
      const { getPool, sql } = require('../db');
      const pool = await getPool();
      const today = new Date();
      const r = await pool.request()
        .input('userId', sql.Int, userId)
        .input('today', sql.Date, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())))
        .query(`SELECT TOP (1) * FROM CorporateEvents
                WHERE userId = @userId AND eventType IN ('halt','earnings') AND eventDate = @today`);
      if (r.recordset.length) hit = { symbol: r.recordset[0].symbol || '*', eventType: r.recordset[0].eventType, note: r.recordset[0].note || 'fundamental event' };
    }
    if (!hit) return { blackSwan: false };
    await store.logEvent(userId, 'black_swan', hit);
    // Force-regenerate ALL tiers immediately (weekly/monthly/yearly). ★ AND IT NOW DOES (TRD-WP-1 / #1502):
    // this comment claimed "force" for months while the call ran the period-throttled path, so inside a period
    // it rewrote NOTHING. `force: true` is the difference between the comment and the code.
    await ensureCurrent(userId, settings, { force: true });
    await telegramAlert(`OSWALD black swan: ${hit.symbol} ${hit.gapPct != null ? hit.gapPct + '% gap' : hit.eventType}. White papers regenerated.`).catch(() => {});
    return { blackSwan: true, hit };
  } catch (e) {
    return { blackSwan: false, error: String(e.message || e).slice(0, 120) };
  }
}

module.exports = { generate, ensureCurrent, latest, bundleSections, detectBlackSwan, periodFor, periodGate };
