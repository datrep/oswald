// trading/agent/alternatives.js — alternative-proxy agent (2026-09-11).
//
// When a watched instrument cannot be evaluated (insufficient data / stale /
// venue-only), the desk should not just stare at it: propose tradable
// ALTERNATIVES from the provider-mapped Plus500 universe that (a) can be
// evaluated right now or after one deep pull and (b) actually behave like the
// dead instrument (correlation of log returns over the stored series). The
// best pick gets a scoped PULSE so there is immediate context on it.
//
// Logged as an 'alternatives' TradingEvent; deduped per target (12h) so the
// wake pipeline and the discoverer can both fire it without spamming.
'use strict';
// GOTCHA (see waker.js): `require('mssql')` from trading/ resolves to a
// DIFFERENT instance than the pool's, and its type classes fail with
// "parameter.type.validate is not a function". Always use the pool's export.
const { getPool, sql } = require('../db');
const store = require('../store');
const { correlation } = require('./indicators');
const providers = require('./providers');

const MIN_BARS_1H = 30;       // same floor as quant.MIN_BARS — evaluability
const MIN_OVERLAP = 20;       // aligned samples required for a usable correlation
const MIN_CORR = 0.3;         // a same-direction proxy below this is not "suitable"
const MAX_ALTERNATIVES = 3;
const COOLDOWN_HOURS = 12;
const HISTORY_DAYS = 183;     // 1d window (falls back to 1h when 1d is missing)
const HISTORY_1H_DAYS = 45;
const BACKFILL_RANGE_DAYS = 90;

// PURE: aligned log-return Pearson correlation over [{t,c}] series (asc by t).
// Returns null when the overlap is too thin to mean anything.
function alignedCorr(a, b) {
  const mb = new Map((b || []).map((x) => [x.t, x.c]));
  const xs = [];
  const ys = [];
  for (const p of a || []) {
    const c = mb.get(p.t);
    if (c != null) { xs.push(p.c); ys.push(c); }
  }
  if (xs.length < MIN_OVERLAP) return null;
  const ra = [];
  const rb = [];
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i - 1] > 0 && xs[i] > 0 && ys[i - 1] > 0 && ys[i] > 0) {
      ra.push(Math.log(xs[i] / xs[i - 1]));
      rb.push(Math.log(ys[i] / ys[i - 1]));
    }
  }
  if (ra.length < MIN_OVERLAP - 5) return null;
  const c = correlation(ra, rb);
  return Number.isFinite(c) ? c : null;
}

// One SQL pass per timeframe: yahoo series for every symbol (the same table
// the signal engine reads), so pair scoring is O(1) queries, not O(universe).
async function loadSeries(userId, timeframe, days) {
  const tf = timeframe === '1h' ? '1h' : '1d';
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('days', sql.Int, days)
    .query(`SELECT symbol, barStart, closePrice FROM PriceBars
            WHERE userId = @userId AND timeframe = '${tf}' AND venue = 'yahoo'
              AND barStart >= DATEADD(DAY, -@days, GETUTCDATE())
            ORDER BY symbol, barStart`);
  const out = {};
  for (const row of r.recordset) {
    if (!out[row.symbol]) out[row.symbol] = [];
    out[row.symbol].push({ t: new Date(row.barStart).getTime(), c: Number(row.closePrice) });
  }
  return out;
}

async function load1hCounts(userId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT symbol, COUNT(*) AS c FROM PriceBars
            WHERE userId = @userId AND timeframe = '1h' AND venue = 'yahoo'
            GROUP BY symbol`);
  const out = {};
  for (const row of r.recordset) out[row.symbol] = Number(row.c) || 0;
  return out;
}

// Rank the universe against the target. Returns { target, timeframe, alternatives }.
async function findAlternatives(userId, target, settings) {
  const universe = Object.keys(providers.SYMBOL_MAP)
    .filter((s) => s.toLowerCase() !== String(target).toLowerCase());
  const counts = await load1hCounts(userId);

  let series = await loadSeries(userId, '1d', HISTORY_DAYS);
  let timeframe = '1d';
  if (!(series[target] || []).length || series[target].length < MIN_OVERLAP) {
    series = await loadSeries(userId, '1h', HISTORY_1H_DAYS);
    timeframe = '1h';
  }
  const tgt = series[target] || [];
  const tracked = new Set((settings.watchlist?.symbols || []).map((s) => String(s.symbol).toLowerCase()));

  const out = [];
  for (const cand of universe) {
    const cs = series[cand];
    if (!cs || cs.length < MIN_OVERLAP) continue;
    const corr = alignedCorr(tgt, cs);
    if (corr == null || corr < MIN_CORR) continue;
    out.push({
      symbol: cand,
      corr: Math.round(corr * 1000) / 1000,
      bars1h: counts[cand] || 0,
      evaluable: (counts[cand] || 0) >= MIN_BARS_1H,
      tracked: tracked.has(cand.toLowerCase()),
    });
  }
  out.sort((a, b) => b.corr - a.corr);
  const top = out.slice(0, MAX_ALTERNATIVES);

  // Make the best pick evaluable if its hourly series is short — one deep pull
  // (the same 90-day window the multi-TF backfill now uses).
  const firstShort = top.find((x) => !x.evaluable);
  if (firstShort) {
    try {
      const r = await providers.backfillBars(userId, {
        provider: 'yahoo', symbol: firstShort.symbol, timeframe: '1h', rangeDays: BACKFILL_RANGE_DAYS,
      });
      if (r && r.bars) {
        firstShort.evaluable = true;
        firstShort.backfilled = r.bars;
        firstShort.bars1h = Math.max(firstShort.bars1h, r.bars);
      }
    } catch { /* keep the suggestion, flagged not-evaluable */ }
  }
  // Prefer candidates the desk can actually evaluate right now.
  top.sort((a, b) => (b.evaluable - a.evaluable) || (b.corr - a.corr));
  return { target, timeframe, alternatives: top };
}

// Full agent pass: find alternatives, pulse the best one, log the event.
async function suggest(userId, settings, { symbol, reason = 'manual', pulse = true, force = false } = {}) {
  const target = String(symbol || '').trim();
  if (!target) return { error: 'symbol is required' };
  const recent = await store.listEvents(userId, { limit: 40, kind: 'alternatives' });
  const prev = (recent || []).find((e) => String((e.payload && e.payload.target) || '').toLowerCase() === target.toLowerCase());
  if (!force && prev && Date.now() - new Date(prev.createdAt).getTime() < COOLDOWN_HOURS * 3600000) {
    return { skipped: 'cooldown', target, lastAt: prev.createdAt };
  }

  const found = await findAlternatives(userId, target, settings);
  const alts = found.alternatives || [];
  let pulseResult = null;
  if (pulse && alts.length && !(settings.llm || {}).stub) {
    try {
      pulseResult = await require('./pulse').generatePulse(userId, settings, { force: true, scope: alts[0].symbol });
    } catch (e) {
      pulseResult = { error: String(e.message || e).slice(0, 160) };
    }
  }
  const pulseInfo = alts.length
    ? {
      scope: alts[0].symbol,
      ok: !!(pulseResult && !pulseResult.skipped && !pulseResult.error),
      skipped: pulseResult && pulseResult.skipped ? pulseResult.skipped : null,
      error: pulseResult && pulseResult.error ? pulseResult.error : null,
    }
    : null;

  await store.logEvent(userId, 'alternatives', {
    target,
    reason: String(reason || 'manual').slice(0, 60),
    timeframe: found.timeframe,
    count: alts.length,
    alternatives: alts,
    pulse: pulseInfo,
    at: new Date().toISOString(),
    actor: 'system:alternatives',
  });
  return { target, reason, timeframe: found.timeframe, alternatives: alts, pulse: pulseInfo };
}

module.exports = { suggest, findAlternatives, alignedCorr, MIN_CORR, MIN_BARS_1H, MAX_ALTERNATIVES };
