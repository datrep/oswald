// trading/agent/providers/yahoo.js — Yahoo Finance chart API provider (TRD-9).
// Free, no key, unofficial: query1.finance.yahoo.com/v8/finance/chart/{symbol}.
// Bars: 15m / 1h / 1d native; 4h is AGGREGATED from 1h (see store.upsertAggBars).
// Quotes: regularMarketPrice = last trade (crypto/futures ≈ live; equities
// update during exchange hours, last close when closed). No bid/ask — mid only.
// Safety: 300ms request spacing + exponential backoff on 429/5xx, per-call
// timeout, incremental pulls (never re-download stored history).
'use strict';

const https = require('https');
const store = require('../../store');

const HOST = 'query1.finance.yahoo.com';
const INTERVALS = { '5m': '5m', '15m': '15m', '1h': '60m', '1d': '1d' };
// Default history depth per timeframe (days). 4h pulls 1h then aggregates.
// MAX_SPAN_DAYS = empirically verified limits (2026-09-08): 15m -> 422 at 60d,
// 60m -> 422 at 730d; 1d works to 20y. Clamp to stay under them.
const DEPTH_DAYS = { '5m': 2, '15m': 59, '1h': 729, '4h': 729, '1d': 3650 };
const MAX_SPAN_DAYS = { '5m': 59, '15m': 59, '1h': 729, '1d': 3650 };

let lastReqAt = 0;

function getJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) oswald trading-agent yahoo provider',
          Accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(text)); } catch { reject(new Error('bad json from yahoo')); }
          } else if (res.statusCode === 404) {
            reject(Object.assign(new Error(`yahoo 404 (unknown symbol) ${url.split('?')[0].split('/').pop()}`), { notFound: true }));
          } else {
            reject(Object.assign(new Error(`yahoo http ${res.statusCode} for ${url.slice(0, 120)}`), { http: res.statusCode }));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('yahoo timeout')));
    req.on('error', reject);
  });
}

// Paced GET with backoff: 300ms min spacing, retry 429/5xx up to 3 tries.
async function pacedGetJson(url, { attempts = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const wait = Math.max(0, 300 - (Date.now() - lastReqAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastReqAt = Date.now();
    try {
      return await getJson(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (e.notFound) throw e; // 404 is final — no retry
      if (!e.http || e.http < 429) throw e;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i) + Math.random() * 500));
    }
  }
  throw lastErr;
}

// Fetch OHLCV bars. period1/period2 = epoch SECONDS (inclusive/exclusive-ish).
async function fetchChart(symbol, interval, { period1, period2 } = {}) {
  const iv = INTERVALS[interval];
  if (!iv) throw new Error(`yahoo has no native ${interval} interval`);
  const p1 = Math.floor(Number(period1) || 0);
  const p2 = Math.floor(Number(period2) || 0);
  const range = p1 && p2 ? '' : '&range=5d';
  const periods = p1 && p2 ? `&period1=${p1}&period2=${p2}` : '';
  const url = `https://${HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${iv}${periods}${range}`;
  const r = await pacedGetJson(url);
  const result = r && r.chart && r.chart.result && r.chart.result[0];
  if (!result) {
    if (r && r.chart && r.chart.error) throw new Error(`yahoo chart error: ${r.chart.error.description || r.chart.error.code}`);
    throw new Error(`yahoo empty result for ${symbol}`);
  }
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close ? q.close[i] : null;
    if (close == null) continue; // drop session gaps (closed-market nulls)
    bars.push({
      venue: 'yahoo', symbol, timeframe: interval,
      barStart: new Date(ts[i] * 1000),
      openPrice: q.open ? q.open[i] : null,
      high: q.high ? q.high[i] : null,
      low: q.low ? q.low[i] : null,
      closePrice: close,
      volume: q.volume ? q.volume[i] : null,
    });
  }
  return bars;
}

// Latest price as a mid (no bid/ask on Yahoo).
async function fetchQuote(symbol) {
  const r = await pacedGetJson(`https://${HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`);
  const meta = r && r.chart && r.chart.result && r.chart.result[0] && r.chart.result[0].meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(`yahoo no price for ${symbol}`);
  return { mid: parseFloat(meta.regularMarketPrice), at: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : new Date() };
}

// ---- cookie + crumb for v10 quoteSummary (Yahoo rejects crumb-less v10) ----
// Verified 2026-09-08: fc.yahoo.com (404 body but sets A3 cookie) ->
// v1/test/getcrumb -> quoteSummary?crumb=... returns 200.
let crumb = null; // { value, cookie, at }

function rawGet(url, { cookie = null, follow = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'application/json,text/plain,*/*',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && follow < 6) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          const sc = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
          return resolve(rawGet(next, { cookie: sc || cookie, follow: follow + 1 }));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          cookie: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; '),
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('yahoo timeout')));
    req.on('error', reject);
  });
}

async function getCrumb(force = false) {
  if (!force && crumb && Date.now() - crumb.at < 5 * 60 * 1000) return crumb;
  const fc = await rawGet('https://fc.yahoo.com');
  const gc = await rawGet('https://query1.finance.yahoo.com/v1/test/getcrumb', { cookie: fc.cookie });
  const value = gc.body && gc.body.trim();
  if (gc.status !== 200 || !value || value.length > 32 || /[<> ]/.test(value)) {
    crumb = null;
    throw new Error('yahoo crumb unavailable');
  }
  crumb = { value, cookie: gc.cookie || fc.cookie, at: Date.now() };
  return crumb;
}

// Fundamentals for the multi-factor strategy (TRD-10). Unofficial free
// endpoint; needs cookie+crumb; missing modules/fields degrade to null.
async function quoteSummary(symbol, modules = 'summaryDetail,financialData,price') {
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await getCrumb(attempt > 0);
    const wait = Math.max(0, 300 - (Date.now() - lastReqAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastReqAt = Date.now();
    const r = await rawGet(
      `https://${HOST}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(c.value)}`,
      { cookie: c.cookie }
    );
    if (r.status === 401) continue; // stale crumb -> refresh once and retry
    if (r.status !== 200) throw new Error(`yahoo http ${r.status} for quoteSummary ${symbol}`);
    let j;
    try { j = JSON.parse(r.body); } catch { throw new Error('bad json from yahoo quoteSummary'); }
    const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
    if (!res) throw new Error(`yahoo no summary for ${symbol}`);
    const pe = res.summaryDetail && res.summaryDetail.trailingPE && res.summaryDetail.trailingPE.raw != null
      ? res.summaryDetail.trailingPE.raw : null;
    const roeRaw = res.financialData && res.financialData.returnOnEquity && res.financialData.returnOnEquity.raw != null
      ? res.financialData.returnOnEquity.raw : null;
    return {
      pe,
      roe: roeRaw != null ? roeRaw * 100 : null,
      price: res.price && res.price.regularMarketPrice ? res.price.regularMarketPrice.raw : null,
    };
  }
  throw new Error(`yahoo quoteSummary unauthorized for ${symbol}`);
}

// Incremental backfill into PriceBars. 4h = pull 1h then aggregate.
// `symbol` = display name (stored), `ticker` = Yahoo symbol (fetched).
async function backfill(userId, { symbol, ticker = null, timeframe = '1h', rangeDays = null, limit = null }) {
  const yTicker = String(ticker || symbol);
  const tf = timeframe === '4h' ? '1h' : timeframe; // aggregate afterwards

  const last = (await store.listBars(userId, { timeframe: tf, symbol, venue: 'yahoo', limit: 1 }))[0];
  const now = Date.now();
  const spanDays = Number(rangeDays) || DEPTH_DAYS[timeframe] || 30;
  const maxDays = MAX_SPAN_DAYS[tf] || 729;
  const days = Math.min(spanDays, maxDays);
  const period1 = last
    ? Math.max(
        Math.floor((new Date(last.barStart).getTime() - (tf === '1d' ? 86400000 : tf === '1h' ? 3600000 : 900000)) / 1000), // 1-bar overlap
        Math.floor((now - days * 86400000) / 1000) // but never exceed the span limit
      )
    : Math.floor((now - days * 86400000) / 1000);

  const bars = await fetchChart(yTicker, tf, { period1, period2: Math.floor(now / 1000) });
  if (!bars.length) return { provider: 'yahoo', symbol, timeframe, bars: 0, reason: 'no_bars' };

  // 2026-09-10: yahoo occasionally serves degenerate 1d bars (o=h=l=c, e.g.
  // a bogus 319.20 coffee day that tripped the black-swan detector). A real
  // daily session on a liquid market never has zero range — drop them.
  const kept = tf === '1d'
    ? bars.filter((b) => !(Number(b.openPrice) === Number(b.high)
        && Number(b.high) === Number(b.low) && Number(b.low) === Number(b.closePrice)))
    : bars;
  if (!kept.length) return { provider: 'yahoo', symbol, timeframe, bars: 0, reason: 'no_bars' };

  // fetchChart tags rows with the TICKER — store under the display name.
  // limit only trims when explicitly provided (span clamps bound the size).
  // 043: `tf` is what was FETCHED (a '4h' request pulls 1h and aggregates afterwards), so the row declares
  // the interval of the series it was actually built from — not the timeframe the caller asked about.
  const cap = Number(limit) || 30000;
  const rows = kept.map((b) => ({ ...b, symbol, sourceIntervalSec: store.TIMEFRAME_SECONDS[tf] })).slice(-cap);
  await store.upsertProviderBars(userId, rows);

  if (timeframe === '4h') {
    // Aggregate from ALL stored 1h bars (MERGE is idempotent); start from the
    // last existing 4h bucket so the rest of history isn't recomputed.
    const last4 = (await store.listBars(userId, { timeframe: '4h', symbol, venue: 'yahoo', limit: 1 }))[0];
    const since4 = last4 ? new Date(new Date(last4.barStart).getTime() - 4 * 3600000) : null;
    await store.upsertAggBars(userId, { venue: 'yahoo', symbol, fromTf: '1h', toTf: '4h', since: since4 });
  }

  await store.logEvent(userId, 'telemetry', {
    source: 'provider_backfill', provider: 'yahoo', symbol, timeframe, bars: rows.length,
    incremental: !!last, from: rows[0].barStart, to: rows[rows.length - 1].barStart,
  });
  return { provider: 'yahoo', symbol, timeframe, bars: rows.length, from: rows[0].barStart, to: rows[rows.length - 1].barStart, incremental: !!last };
}

module.exports = { fetchChart, fetchQuote, quoteSummary, backfill, DEPTH_DAYS, INTERVALS, MAX_SPAN_DAYS };
