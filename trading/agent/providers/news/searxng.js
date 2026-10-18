// trading/agent/providers/news/searxng.js — S1 fetch layer for the news aggregator (open-work §4.19).
//
// Shaped like tuner/telemetry sources, not a new invention: one keyless endpoint -> normalised rows,
// with the failure MODE recorded rather than thrown away. The brief (§10) is explicit, and it is the
// F1 defect class this desk has paid for twice: "a dead feed rendering as quiet" must not be
// reintroduced. So every failure returns a NAMED reason (`searxng_unreachable`,
// `searxng_format_not_allowed`, `searxng_bad_json`) — the caller writes it into a `news_digest`
// event, and "no items because nothing happened" stays distinguishable from "no items because the
// fetch is broken".
//
// Verified live on the owner's instance (Docker, 127.0.0.1:18080, 2026-10-03): JSON format enabled,
// `categories=news&time_range=day` returns items. A 403 that names the format is a CONFIG error on
// the instance (`search.formats` missing `json`) — logged as such, never swallowed.
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DEGRADE_REASONS = {
  unreachable: 'searxng_unreachable',
  format: 'searxng_format_not_allowed',
  badjson: 'searxng_bad_json',
};

// Pure — pinned by test/news-searxng.test.js so the query contract cannot drift from the desk's own
// expectations of searxng's API (GET /search?q=…&format=json).
function buildSearchUrl(base, query, { categories = 'news', timeRange = 'day' } = {}) {
  const b = String(base || '').replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('q', String(query || ''));
  params.set('format', 'json');
  if (categories) params.set('categories', categories);
  if (timeRange) params.set('time_range', timeRange);
  return `${b}/search?${params.toString()}`;
}

function rawGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: false,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Pure status mapping — the three degradation classes above, pinned by test.
function parseSearchResponse(status, text, url) {
  if (status === 403 && /format/i.test(String(text || ''))) {
    return { ok: false, reason: DEGRADE_REASONS.format, detail: 'json format not allowed on the instance', url };
  }
  if (status !== 200) {
    return { ok: false, reason: DEGRADE_REASONS.unreachable, detail: `HTTP ${status}`, url };
  }
  try {
    return { ok: true, url, body: JSON.parse(text) };
  } catch (e) {
    return { ok: false, reason: DEGRADE_REASONS.badjson, detail: e.message, url };
  }
}

async function fetchSearch(base, query, opts = {}) {
  const url = buildSearchUrl(base, query, opts);
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  let res;
  try {
    res = await rawGet(url, timeoutMs);
  } catch (e) {
    return { ok: false, reason: DEGRADE_REASONS.unreachable, detail: e.message || String(e), url };
  }
  return parseSearchResponse(res.status, res.text, url);
}

// sha256(symbol|url|title) — the DB dedupe key. Deterministic so a re-fetch of the same item is a
// duplicate, and so two symbols sharing one article keep separate rows (the digest reads per symbol).
function hashItem(symbol, url, title) {
  return crypto.createHash('sha256').update(`${symbol}|${url}|${title}`).digest('hex');
}

// ⚠ ABSENT IS NOT A DATE. searxng omits `publishedDate` for many engines; `new Date(null)` is the
// epoch and `Number(null) === 0`-class coercion has bitten this repo repeatedly. Anything unparseable
// stays NULL in the DB — the digest must be able to say "publication time unknown", not "1970".
function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeUnresponsive(list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map((e) => {
    if (Array.isArray(e)) return `${e[0]}:${e[1]}`;
    return String(e);
  });
}

// Pure mapping from a searxng response body to NewsItems row shapes. Items without a title or a url
// are DROPPED and counted — an unopenable item is noise, and the count keeps the drop visible.
function mapResults(symbol, query, body, { maxPerSymbol = 15 } = {}) {
  const rows = [];
  let dropped = 0;
  const results = (body && Array.isArray(body.results)) ? body.results : [];
  for (const r of results) {
    const title = String((r && r.title) || '').trim();
    const link = String((r && r.url) || '').trim();
    if (!title || !link) { dropped += 1; continue; }
    let source = null;
    try { source = new URL(link).hostname.replace(/^www\./, ''); } catch { /* keep null */ }
    rows.push({
      symbol,
      title: title.slice(0, 512),
      url: link.slice(0, 1024),
      source,
      engine: (r.engine || (Array.isArray(r.engines) && r.engines[0]) || null),
      publishedAt: parseDateOrNull(r.publishedDate),
      score: Number.isFinite(Number(r.score)) && r.score != null ? Number(r.score) : null,
      snippet: r.content ? String(r.content).slice(0, 4000) : null,
      query,
      itemHash: hashItem(symbol, link, title),
    });
    if (rows.length >= maxPerSymbol) break;
  }
  return { rows, dropped, unresponsive: normalizeUnresponsive(body && body.unresponsive_engines) };
}

module.exports = { DEGRADE_REASONS, buildSearchUrl, fetchSearch, parseSearchResponse, mapResults, hashItem };
