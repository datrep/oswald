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

// ★ ONE SOURCE COULD FABRICATE A BLACK SWAN, AND ONE DID (2026-10-23).
//
// The detector read yahoo 1h only. Measured that day, Natural Gas day-on-day: **yahoo +10.02%**, the venue's own
// series **-2.98%**, and its chart series **-3.05%** — and the two series were already 13% apart on 2026-10-22
// itself. A 10% threshold sitting on a series that is 13% adrift fires forever on nothing. It fired 29 times in
// 3h38m, once per wake, announcing a crash that did not happen.
//
// So the gap is now measured PER VENUE and reported through a median, which is robust to exactly one bad source,
// and two venues that disagree by more than the threshold make the reading UNMEASURABLE rather than alarming —
// silence, not a guess. `verified` says whether more than one venue was even available to agree.
//
// Pure, so the rule is pinned by a test rather than by a wake at 03:00.
function blackSwanVerdict(perVenueGaps, thresholdPct) {
  const entries = Object.entries(perVenueGaps || {}).filter(([, g]) => g != null && Number.isFinite(g.gapPct));
  if (!entries.length) return { fire: false, reason: 'no_data', verified: false };
  const gaps = entries.map(([, g]) => g.gapPct).sort((a, b) => a - b);
  const median = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  const spread = gaps[gaps.length - 1] - gaps[0];
  const best = entries.slice().sort((a, b) => Math.abs(b[1].gapPct) - Math.abs(a[1].gapPct))[0];
  if (entries.length >= 2 && spread > thresholdPct) {
    return { fire: false, reason: 'venues_disagree', verified: false, median: +median.toFixed(2), spread: +spread.toFixed(2), perVenue: Object.fromEntries(entries.map(([v, g]) => [v, g.gapPct])) };
  }
  const fire = Math.abs(median) > thresholdPct;
  return {
    fire, reason: fire ? 'gap' : 'below_threshold', verified: entries.length >= 2,
    gapPct: +median.toFixed(2), venue: entries.length >= 2 ? 'median' : best[0],
    perVenue: Object.fromEntries(entries.map(([v, g]) => [v, g.gapPct])),
  };
}

// Daily closes from a venue's own 1h series. `limit` is 400 hourly bars — enough for 16 days, which is all a
// two-day gap needs; the old 12,000 read was 100k+ rows per wake for a comparison of two numbers.
async function dailyCloses(userId, symbol, venue, limit = 400) {
  const bars = await store.listBars(userId, { timeframe: '1h', symbol, venue, limit });
  if (!bars || bars.length < 48) return null;
  const byDay = new Map();
  for (const b of bars) {
    const c = Number(b.closePrice);
    if (!Number.isFinite(c) || c <= 0) continue;
    const d = new Date(b.barStart);
    byDay.set(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), c); // ascending — last close wins
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  if (days.length < 2) return null;
  const [prevDay, prev] = days[days.length - 2];
  const [lastDay, last] = days[days.length - 1];
  if (!(prev > 0)) return null;
  return { gapPct: +(((last - prev) / prev) * 100).toFixed(2), prevDay, lastDay };
}

// Black-swan detector: a >threshold daily gap AGREED BY THE VENUES, or a CorporateEvents halt/earnings today.
// Fires AT MOST ONCE PER SYMBOL PER GAP-DAY, and says what actually happened rather than what was attempted.
async function detectBlackSwan(userId, settings, _quantResult, _liveEquity) {
  try {
    const symbols = (settings.watchlist?.symbols || []).map((s) => s.symbol);
    const threshold = Number(settings.whitepaper?.blackSwanGapPct ?? 10);
    // ★ ONE ALERT PER SYMBOL PER GAP-DAY. Without this the detector re-derives the same static comparison on every
    // wake and fires again: 29 firings in 3h38m on 2026-10-23, one every 7.8 minutes, each attempting three tier
    // regenerations and 83 `budget_cap` errors between them.
    const recent = await store.listEvents(userId, { kind: 'black_swan', limit: 60 }).catch(() => []);
    const already = new Set((recent || []).map((e) => e.payload && e.payload.dedupeKey).filter(Boolean));

    let hit = null;
    for (const symbol of symbols) {
      const perVenue = {};
      for (const venue of ['plus500', 'plus500_chart', 'yahoo']) {
        const d = await dailyCloses(userId, symbol, venue).catch(() => null);
        if (d) perVenue[venue] = d;
      }
      const verdict = blackSwanVerdict(perVenue, threshold);
      if (!verdict.fire) continue;
      const dayKey = new Date(perVenue[Object.keys(perVenue)[0]].lastDay).toISOString().slice(0, 10);
      const dedupeKey = `${symbol}|${dayKey}`;
      if (already.has(dedupeKey)) return { blackSwan: false, suppressed: true, dedupeKey };
      hit = { symbol, gapPct: verdict.gapPct, venue: verdict.venue, verified: verdict.verified, perVenue: verdict.perVenue, dayKey, dedupeKey };
      break;
    }
    if (!hit) {
      const { getPool, sql } = require('../db');
      const pool = await getPool();
      const today = new Date();
      const todayKey = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
      const r = await pool.request()
        .input('userId', sql.Int, userId)
        .input('today', sql.Date, new Date(`${todayKey}T00:00:00Z`))
        .query(`SELECT TOP (1) * FROM CorporateEvents
                WHERE userId = @userId AND eventType IN ('halt','earnings') AND eventDate = @today`);
      if (r.recordset.length) {
        const ev = r.recordset[0];
        const dedupeKey = `${ev.symbol || '*'}|${ev.eventType}|${todayKey}`;
        if (already.has(dedupeKey)) return { blackSwan: false, suppressed: true, dedupeKey };
        hit = { symbol: ev.symbol || '*', eventType: ev.eventType, note: ev.note || 'fundamental event', dayKey: todayKey, dedupeKey };
      }
    }
    if (!hit) return { blackSwan: false };

    await store.logEvent(userId, 'black_swan', hit);
    // Force-regenerate ALL tiers immediately (weekly/monthly/yearly). ★ AND IT NOW DOES (TRD-WP-1 / #1502): this
    // comment claimed "force" for months while the call ran the period-throttled path.
    const results = await ensureCurrent(userId, settings, { force: true });
    // ★ AND THE ALERT NOW SAYS WHAT HAPPENED. It used to print "White papers regenerated" unconditionally — on
    // 2026-10-23 it said that 29 times while the budget cap had blocked every attempt since 11:10, so 25 of those
    // messages described a regeneration that did not occur.
    const written = (results || []).filter((r) => r && r.payload).length;
    const tiers = ['weekly', 'monthly', 'yearly'];
    const what = written === tiers.length
      ? 'White papers regenerated.'
      : `White papers NOT regenerated (${written}/${tiers.length} tiers; see whitepaper errors).`;
    const gapText = hit.gapPct != null ? `${hit.gapPct}% gap` : hit.eventType;
    const src = hit.venue ? ` (${hit.venue}${hit.verified ? ', venues agree' : ', single venue'})` : '';
    await telegramAlert(`OSWALD black swan: ${hit.symbol} ${gapText}${src}. ${what}`).catch(() => {});
    return { blackSwan: true, hit, written };
  } catch (e) {
    return { blackSwan: false, error: String(e.message || e).slice(0, 120) };
  }
}

module.exports = { generate, ensureCurrent, latest, bundleSections, detectBlackSwan, periodFor, periodGate, blackSwanVerdict };
