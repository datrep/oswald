// trading/agent/newsAggregator.js — S1 of the news aggregator (open-work §4.19 / TRD-NEW-1).
//
// WHAT IT IS: an hourly, self-throttling loop that composes one search per watchlist symbol
// (newsKeywords.js), fetches via the owner's SearXNG instance (providers/news/searxng.js), and
// WRITES items into NewsItems with a `news_digest` telemetry event per cycle.
//
// WHAT IT IS NOT — deliberately, per the frozen brief: there is NO CONSUMER. Nothing here reaches a
// chair prompt, a digest, a panel or Telegram (those are S2/S3, gated). A row written by this module
// cannot have influenced a trading decision. S1's whole job is "is this feed useful and is it
// alive", answered from the stored record.
//
// DEAD-FEED DISCIPLINE (brief §10, the F1 class): the `news_digest` event carries its failure
// reason (`searxng_unreachable` / `searxng_format_not_allowed` / `no_items`). A reader must be able
// to tell "the world was quiet" from "the pipe is broken" — the event shape is built to make that
// distinction impossible to lose.
//
// SELF-THROTTLE: one `news_digest` event IS the clock. Ticks arriving inside intervalHours-1 do
// nothing. Downtime is harmless: the next tick after boot catches up by itself (nothing is
// "missed" — news has no earliest date).
'use strict';

const { getPool, sql } = require('../db');
const store = require('../store');
const { keywordsFor } = require('./newsKeywords');
const searxng = require('./providers/news/searxng');
const { telegramAlert } = require('../lib/http');
const { toastLine } = require('./newsDigest');

// Code defaults; every field is settings-overridable under `settings.news` (no settings write is
// REQUIRED for the module to work — the owner's instance address is the default).
const DEFAULTS = {
  enabled: true,
  intervalHours: 1,
  searxngUrl: 'http://127.0.0.1:18080',
  categories: 'news',
  timeRange: 'day',
  maxPerSymbol: 15,
  paceMs: 1500,          // between per-symbol queries — be a polite metasearch client
  retentionDays: 7,      // items older than this are pruned at cycle end
  toastMinHours: 6,      // S2 toast cap: at most one content-free "news updated" line per N hours
};

// Startup probe (brief §10): once per PROCESS, prove the instance answers and record its latency;
// a 403 naming the format is a config error and is written to the log even though the loop then
// degrades normally. Kept module-level on purpose — a restart re-probes.
let startupProbe = null;
let lastToastAt = 0;   // S2 toast clock (module-level on purpose: a restart may re-toast once — the
                       // line is content-free, so the worst case is one harmless "news updated")

function newsConf(settings) {
  const n = (settings && settings.news) || {};
  const intHours = Number(n.intervalHours);
  return {
    enabled: n.enabled !== false,
    intervalHours: Number.isFinite(intHours) && intHours > 0 ? intHours : DEFAULTS.intervalHours,
    searxngUrl: String(n.searxngUrl || DEFAULTS.searxngUrl),
    categories: n.categories === null ? null : String(n.categories ?? DEFAULTS.categories),
    timeRange: n.timeRange === null ? null : String(n.timeRange ?? DEFAULTS.timeRange),
    maxPerSymbol: Number(n.maxPerSymbol) > 0 ? Number(n.maxPerSymbol) : DEFAULTS.maxPerSymbol,
    paceMs: Number.isFinite(Number(n.paceMs)) ? Number(n.paceMs) : DEFAULTS.paceMs,
    retentionDays: Number(n.retentionDays) > 0 ? Number(n.retentionDays) : DEFAULTS.retentionDays,
    toastMinHours: Number(n.toastMinHours) > 0 ? Number(n.toastMinHours) : DEFAULTS.toastMinHours,
  };
}

// Accepts both watchlist shapes seen in the wild: [{symbol}] and ['Gold', …].
function symbolsOf(settings) {
  const list = (settings && settings.watchlist && settings.watchlist.symbols) || [];
  return list
    .map((s) => (typeof s === 'string' ? s : s && s.symbol))
    .map((s) => (s ? String(s).trim() : ''))
    .filter(Boolean);
}

async function lastDigestAt(userId) {
  const rows = await store.listEvents(userId, { kind: 'news_digest', limit: 1 }).catch(() => []);
  const at = rows && rows[0] && rows[0].createdAt;
  if (!at) return null;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? new Date(t) : null;
}

// Insert-if-absent on the (userId, itemHash) unique key; returns how many were genuinely new.
async function insertItems(userId, rows) {
  let inserted = 0;
  let duplicates = 0;
  if (!rows.length) return { inserted, duplicates };
  const pool = await getPool();
  for (const r of rows) {
    const res = await pool
      .request()
      .input('userId', sql.Int, userId)
      .input('symbol', sql.NVarChar(64), r.symbol)
      .input('title', sql.NVarChar(512), r.title)
      .input('url', sql.NVarChar(1024), r.url)
      .input('source', sql.NVarChar(128), r.source)
      .input('engine', sql.NVarChar(64), r.engine)
      .input('publishedAt', sql.DateTime2, r.publishedAt)
      .input('score', sql.Float, r.score)
      .input('snippet', sql.NVarChar(sql.MAX), r.snippet)
      .input('query', sql.NVarChar(256), r.query)
      .input('itemHash', sql.Char(64), r.itemHash)
      .query(`INSERT INTO NewsItems (userId, symbol, title, url, source, engine, publishedAt, score, snippet, query, itemHash)
              SELECT @userId, @symbol, @title, @url, @source, @engine, @publishedAt, @score, @snippet, @query, @itemHash
              WHERE NOT EXISTS (SELECT 1 FROM NewsItems WHERE userId = @userId AND itemHash = @itemHash)`);
    if (res.rowsAffected && res.rowsAffected[0] > 0) inserted += 1;
    else duplicates += 1;
  }
  return { inserted, duplicates };
}

async function prune(userId, retentionDays) {
  try {
    const pool = await getPool();
    const res = await pool
      .request()
      .input('userId', sql.Int, userId)
      .input('days', sql.Int, retentionDays)
      .query('DELETE FROM NewsItems WHERE userId = @userId AND createdAt < DATEADD(day, -@days, GETUTCDATE())');
    return (res.rowsAffected && res.rowsAffected[0]) || 0;
  } catch {
    return 0;
  }
}

async function runOnce(userId, settings) {
  const conf = newsConf(settings);
  if (!conf.enabled) return { skipped: 'disabled' };

  const last = await lastDigestAt(userId);
  if (last && (Date.now() - last.getTime()) < (conf.intervalHours * 60 - 1) * 60000) {
    return { skipped: 'throttled', lastMinutesAgo: Math.round((Date.now() - last.getTime()) / 60000) };
  }

  // The startup probe does not gate the loop — it ANNOTATES it (brief §10: record, don't swallow).
  if (!startupProbe) {
    const t0 = Date.now();
    const p = await searxng.fetchSearch(conf.searxngUrl, 'test', { categories: null, timeRange: null, timeoutMs: 8000 });
    startupProbe = {
      ok: !!p.ok,
      latencyMs: Date.now() - t0,
      at: new Date().toISOString(),
      ...(p.ok ? {} : { reason: p.reason, detail: p.detail ? String(p.detail).slice(0, 200) : null }),
    };
  }

  const keywords = keywordsFor(symbolsOf(settings));
  if (!keywords.length) {
    const summary = { inserted: 0, reason: 'no_symbols', startupProbe };
    await store.logEvent(userId, 'news_digest', summary).catch(() => {});
    return summary;
  }

  let fetched = 0;
  let inserted = 0;
  let duplicates = 0;
  let dropped = 0;
  const failures = [];
  const unresponsive = new Set();
  const symbolsWithNew = new Set();

  for (const k of keywords) {
    const res = await searxng.fetchSearch(conf.searxngUrl, k.query, {
      categories: conf.categories,
      timeRange: conf.timeRange,
    });
    if (!res.ok) {
      failures.push({ symbol: k.symbol, reason: res.reason, detail: res.detail ? String(res.detail).slice(0, 200) : null });
      continue;
    }
    const mapped = searxng.mapResults(k.symbol, k.query, res.body, { maxPerSymbol: conf.maxPerSymbol });
    for (const u of mapped.unresponsive) unresponsive.add(u);
    fetched += mapped.rows.length;
    dropped += mapped.dropped;
    const ins = await insertItems(userId, mapped.rows);
    inserted += ins.inserted;
    duplicates += ins.duplicates;
    if (ins.inserted > 0) symbolsWithNew.add(k.symbol);
    if (conf.paceMs) await new Promise((r) => setTimeout(r, conf.paceMs));
  }

  const pruned = await prune(userId, conf.retentionDays);

  // The reason precedence is the discipline: all-queries-failed names the failure; zero items with
  // NO failures says `no_items` ("the world was quiet" — a true statement); otherwise null (healthy).
  const reason = failures.length === keywords.length
    ? (failures[0].reason || searxng.DEGRADE_REASONS.unreachable)
    : (fetched === 0 ? 'no_items' : null);

  const summary = {
    queries: keywords.length,
    fetched,
    inserted,
    symbols: symbolsWithNew.size,
    duplicates,
    dropped,
    pruned,
    failures: failures.slice(0, 5),
    unresponsive: [...unresponsive].slice(0, 10),
    startupProbe,
    reason,
  };
  await store.logEvent(userId, 'news_digest', summary).catch(() => {});

  // S2 toast (brief §8): CONTENT-FREE line, fires only when items actually arrived, capped by
  // toastMinHours. A notification failure must never fail the cycle.
  if (inserted > 0 && (Date.now() - lastToastAt) >= conf.toastMinHours * 3600000) {
    try {
      await telegramAlert(toastLine(summary));
      lastToastAt = Date.now();
      summary.toasted = true;
    } catch { /* content-free; nothing to do */ }
  }
  return summary;
}

module.exports = { runOnce, newsConf, symbolsOf, DEFAULTS };
