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
  // ★ `timeRange` DEFAULT IS NOW null, AND THAT IS THE WHOLE FIX (2026-10-26). It was `'day'`, which reads as a
  // sensible recency bound and is in fact what made every stored item UNDATABLE. Measured on the owner's instance:
  //
  //     categories=news                      -> 30 results, 21 DATED   (bing news + duckduckgo news + wikinews)
  //     categories=news&time_range=day       -> 10 results,  0 dated   (bing news only)
  //     categories=news&time_range=week      ->  9 results,  0 dated   (bing news only)
  //
  // So `time_range` does not merely filter for recency: it RESTRICTS THE QUERY TO ENGINES THAT IMPLEMENT TIME
  // FILTERING, and on this instance the only such engine is `bing news`, which never emits `publishedDate`. The
  // request for freshness is what destroyed the very field freshness would be measured with. The dates we wanted
  // were available the whole time, one engine away.
  //
  // ⚠ THE RECENCY BOUND IS NOT LOST, IT MOVES: `maxAgeHours` applies the horizon HERE, on the actual
  // `publishedDate`, instead of asking a remote service to filter blind. Filtering on a known date also makes the
  // discard count reportable, which a silent engine-side filter never was.
  timeRange: null,
  // ★ 2026-10-27 — `bing news` IS EXCLUDED BY NAME. It is the engine `time_range` used to select, and it never emits
  // `publishedDate`: measured over the whole corpus, **474 of its 474 rows are undated (100%)**, against 0 of 79 for
  // `yahoo news` and 0 of 77 for `duckduckgo news`. One engine supplied 75% of the volume and every undated row the
  // digest had. It is removed by a POST-FILTER rather than a query parameter because a wrong engine selection returns
  // NOTHING, which is indistinguishable from a quiet world — the exact failure this module is built to prevent.
  // An empty list disables the filter and restores the previous behaviour exactly.
  denyEngines: ['bing news'],
  maxAgeHours: 48,       // discard an item whose OWN date is older than this; items with no date are KEPT (see below)
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
    // ⚠ `String(n.timeRange ?? DEFAULTS.timeRange)` WAS A BUG the moment the default became null: `??` falls
    // through to `null`, `String(null)` is the four-character string `"null"`, and the query went out as
    // `time_range=null` — HTTP 400 from the instance, reported as `searxng_unreachable`. A null default has to
    // survive as an actual null, because the absence of the parameter is the entire fix.
    timeRange: (n.timeRange === undefined ? DEFAULTS.timeRange : n.timeRange) === null
      ? null
      : String(n.timeRange === undefined ? DEFAULTS.timeRange : n.timeRange),
    // 0 disables the horizon (a stated decision), an absent value takes the default — never an accidental 0.
    maxAgeHours: n.maxAgeHours === 0 ? 0 : (Number(n.maxAgeHours) > 0 ? Number(n.maxAgeHours) : DEFAULTS.maxAgeHours),
    // An explicit ARRAY replaces the default deny-list; an ABSENT key keeps it; an explicit `[]` disables filtering.
    // The distinction matters: `[]` is a decision to take every engine, and collapsing it into the default would make
    // that decision impossible to express.
    denyEngines: Array.isArray(n.denyEngines)
      ? n.denyEngines.map((e) => String(e)).filter(Boolean)
      : DEFAULTS.denyEngines.slice(),
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
  let tooOld = 0;
  const failures = [];
  const unresponsive = new Set();
  const symbolsWithNew = new Set();
  let deniedEngine = 0;

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
    // ★ 2026-10-27 — THE UNDATED ENGINE IS DROPPED AT THE SOURCE, BY NAME, AND THE DROP IS COUNTED.
    //
    // Measured over the whole `NewsItems` corpus: `bing news` 474 rows / **474 undated (100%)**, `yahoo news` 79 /
    // 0, `duckduckgo news` 77 / 0. So one engine supplied 75% of the volume and 100% of the undated rows, and
    // "79 of 94 recent rows undated" was entirely its doing.
    //
    // ⚠ A POST-FILTER, NOT A QUERY TWEAK. SearXNG's engine-selection syntax varies by instance and a wrong selection
    // returns NOTHING — which would look exactly like "the world was quiet", the failure this module exists to
    // prevent. Filtering after the response keeps the fetch contract unchanged, and `deniedEngine` is reported so the
    // removal is a MEASUREMENT and not a silent engine disappearing from the feed.
    const allowed = mapped.rows.filter((r) => {
      if (!conf.denyEngines || !conf.denyEngines.length) return true;
      if (conf.denyEngines.includes(String(r.engine || ''))) { deniedEngine += 1; return false; }
      return true;
    });
    // ⚠ AN ITEM WITH NO DATE IS KEPT, AN ITEM WITH AN OLD DATE IS NOT. Those are different facts, and the horizon can
    // only ever reject a row that STATES a date it fails — dropping undated rows here would remove an engine by
    // stealth rather than by the declared deny-list above.
    const fresh = allowed.filter((r) => {
      if (!r.publishedAt) return true;
      const ageH = (Date.now() - new Date(r.publishedAt).getTime()) / 3600000;
      if (ageH <= conf.maxAgeHours) return true;
      tooOld += 1;
      return false;
    });
    fetched += fresh.length;
    dropped += mapped.dropped;
    const ins = await insertItems(userId, fresh);
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
    // ⚠ `tooOld` is the count the engine-side filter could never report. It is separate from `dropped`
    // (unusable rows) because it means something different: those rows were fine, just not recent.
    tooOld,
    maxAgeHours: conf.maxAgeHours,
    timeRange: conf.timeRange,
    // Rows a DECLARED deny-list removed. Separate from `dropped` (unusable) and `tooOld` (usable but stale), because
    // "we chose not to take this engine" is a third fact and must not be counted as either.
    deniedEngine,
    denyEngines: (conf.denyEngines || []).slice(),
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
