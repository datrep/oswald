'use strict';
// trading/scripts/news-arms.js — MULTI-ARM PROPOSAL SCORER (2026-10-06, owner-directed; see
// trading/docs/news-arms-pre-registration-2026-10-06.md).
//
// Question: does news availability at decision time shift the mechanically-simulated outcome of the
// desk's entry proposals? Arms: RAW / CHAIRS± / NEWS± / non-crypto NEWS± (exploratory).
//
// METHOD: proposal extraction + baseline walk IDENTICAL to trading/scripts/resim-exits.js baseline
// (which reproduces the chair-vs-raw test): decisions with chair payloads, wake-price map, 4h
// symbol+direction dedup, effectiveStopDistance, 1h bars, +1.41R target, 48-bar horizon, adv-first /
// fav-first brackets. The news split restricts to the post-first-fetch subset (news only exists after
// 2026-10-03 13:33Z) with a matching RAW(news-window) reference arm.
//
// Read-only: TradingEvents + PriceBars + NewsItems. No DB writes. Writes temp/news-arms-out.json only.
//
// Usage: node trading/scripts/news-arms.js [--since=2026-09-21T00:00:00] [--tf=1h]

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { getPool } = require('../../trading/db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const TF = String(args.tf || '1h');
const SINCE = String(args.since || '2026-09-21T00:00:00');
const HORIZON_BARS = 48;
const TARGET_R = 1.41;
const DEDUP_MS = 4 * 3600 * 1000;
const NEWS_WINDOW_MS = 24 * 3600 * 1000;
const BAR_MS = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 }[TF];
if (!BAR_MS) { console.error('unsupported --tf:', TF); process.exit(2); }

// Same cost table as resim-exits.js (measured 2026-10-05, round-trip spread as R units per symbol).
const COST_R = {
  Gold: 0.18, Oil: 0.10, 'Arabica Coffee': 0.10, Sugar: 0.20, Silver: 0.21,
  Bitcoin: 0.20, SGX: 0.29, Soybeans: 0.28, Ethereum: 0.29,
};
const CRYPTO = new Set(['Bitcoin', 'Ethereum', 'Solana', 'BNB', 'PAX Gold']);
const VENUE_PREF = ['plus500', 'plus500_chart', 'yahoo', 'binance', 'okx'];

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const utcMs = (naive) => new Date(String(naive).replace(' ', 'T') + 'Z').getTime();
const barFloor = (ms) => Math.floor(ms / BAR_MS) * BAR_MS;

// Baseline walk, one proposal, one ordering (identical semantics to resim-exits baseline policy).
function walk({ bars, startMs, d, P, D, favFirst }) {
  const stop0 = P - d * D;
  const target = P + d * TARGET_R * D;
  let n = 0, last = null;
  for (let k = 0; k < 3000 && n < HORIZON_BARS; k++) {
    const b = bars.get(startMs + k * BAR_MS);
    if (!b) continue;                            // gap hour — same skip convention as chair-test
    if (b.h > P * 1.6 || b.l < P * 0.6) continue; // 2026-10-07 DATA FIX: skip wrong-scale venue bars (plus500_chart serves Soybeans at ~1/20 scale in off-hours: ~61 vs ~1278)
    n++; last = b;
    const fav = d === 1 ? b.h : b.l;
    const adv = d === 1 ? b.l : b.h;
    const adverse = () => { const hit = d === 1 ? adv <= stop0 : adv >= stop0; return hit ? { R: -1, reason: 'stop', bars: n } : null; };
    const favourable = () => { const hit = d === 1 ? fav >= target : fav <= target; return hit ? { R: TARGET_R, reason: 'target', bars: n } : null; };
    const first = favFirst ? favourable() : adverse();
    if (first) return first;
    const second = favFirst ? adverse() : favourable();
    if (second) return second;
  }
  if (!last) return null;
  return { R: +(d * (last.c - P) / D).toFixed(3), reason: 'timeout', bars: n };
}

// count of sorted-ms array within [lo, hi] (inclusive) — binary search both ends
function countInWindow(arr, lo, hi) {
  if (!arr || !arr.length) return 0;
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m] < lo) a = m + 1; else b = m; }
  const start = a;
  a = start; b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m] <= hi) a = m + 1; else b = m; }
  return a - start;
}

const stat = (arr, key) => {
  const n = arr.length; if (!n) return { n: 0 };
  const rs = arr.map((x) => x[key]);
  const mean = rs.reduce((s, x) => s + x, 0) / n;
  const sorted = [...rs].sort((x, y) => x - y);
  return {
    n, meanR: +mean.toFixed(3), medR: +sorted[Math.floor(n / 2)].toFixed(3),
    winPct: +(100 * rs.filter((x) => x > 0).length / n).toFixed(1),
    sumR: +rs.reduce((s, x) => s + x, 0).toFixed(1),
  };
};
const statNet = (arr, key) => {
  const rows = arr.filter((x) => x.costR != null).map((x) => ({ [key]: x[key] - x.costR }));
  return { ...stat(rows, key), nCosted: rows.length };
};
function bootDiffUnpaired(a, b, key, iters = 10000) {
  const ra = a.map((x) => x[key]), rb = b.map((x) => x[key]);
  if (!ra.length || !rb.length) return null;
  const diffs = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < ra.length; j++) s += ra[(Math.random() * ra.length) | 0];
    let t = 0;
    for (let j = 0; j < rb.length; j++) t += rb[(Math.random() * rb.length) | 0];
    diffs.push(s / ra.length - t / rb.length);
  }
  diffs.sort((x, y) => x - y);
  return {
    aMean: +(ra.reduce((s, x) => s + x, 0) / ra.length).toFixed(3),
    bMean: +(rb.reduce((s, x) => s + x, 0) / rb.length).toFixed(3),
    lo90: +diffs[Math.floor(0.05 * iters)].toFixed(3),
    hi90: +diffs[Math.floor(0.95 * iters)].toFixed(3),
  };
}
function spearman(rows, getX, getY) {
  const n = rows.length; if (n < 5) return null;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n); let i = 0;
    while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
    return r;
  };
  const rx = rank(rows.map(getX)), ry = rank(rows.map(getY));
  const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return +(num / Math.sqrt(dx * dy)).toFixed(3);
}

(async () => {
  const p = await getPool();

  // 1. entry proposals with chair votes — identical extraction to resim-exits.js / chair-test
  const decRows = (await p.request().query(
    "SELECT id, CONVERT(varchar(19),createdAt,120) t, CAST(payload AS varchar(max)) pl " +
    "FROM TradingEvents WHERE userId=1 AND kind='decision' AND createdAt > '" + SINCE + "' AND CAST(payload AS varchar(max)) LIKE '%chairVotes%'"
  )).recordset;
  const proposals = [];
  for (const r of decRows) {
    const j = parseJson(r.pl);
    if (!j || j.type !== 'entry') continue;
    const eff = Number(j.effectiveStopDistance);
    const stop = Number.isFinite(eff) && eff > 0 ? eff : Number(j.stopDistance);
    if (!(stop > 0) || !j.symbol || !j.direction) continue;
    proposals.push({
      evId: r.id, t: r.t, tMs: utcMs(r.t), promptId: j.promptId, symbol: j.symbol, direction: j.direction,
      strategy: j.strategy, stop, chairVote: j.chairVote,
    });
  }
  console.log('entry proposals (raw):', proposals.length);

  // 2. prices from wake payloads — identical to chair-test / resim-exits
  const wakeRows = (await p.request().query(
    "SELECT CAST(payload AS varchar(max)) pl FROM TradingEvents WHERE userId=1 AND kind='wake' AND createdAt > '" + SINCE + "' AND CAST(payload AS varchar(max)) LIKE '%signals%'"
  )).recordset;
  const priceMap = new Map();
  for (const r of wakeRows) {
    const j = parseJson(r.pl);
    if (!j || !j.quant || !Array.isArray(j.quant.signals)) continue;
    for (const s of j.quant.signals) {
      if (!s || !s.symbol || s.price == null) continue;
      priceMap.set(j.promptId + '|' + s.symbol + '|' + s.direction + '|' + (s.type || 'entry'), Number(s.price));
    }
  }
  console.log('wake price entries:', priceMap.size);

  // 3. bars
  const barRows = (await p.request().query(
    "SELECT symbol, venue, CONVERT(varchar(19),barStart,120) bs, high, low, closePrice FROM PriceBars " +
    "WHERE userId=1 AND timeframe='" + TF + "' AND barStart > '2026-09-20' ORDER BY symbol, barStart"
  )).recordset;
  const barsBy = new Map();
  for (const b of barRows) {
    if (!barsBy.has(b.symbol)) barsBy.set(b.symbol, new Map());
    const m = barsBy.get(b.symbol);
    const key = utcMs(b.bs);
    const rank = VENUE_PREF.indexOf(b.venue);
    const cur = m.get(key);
    if (!cur || (rank >= 0 && cur.rank > rank)) {
      m.set(key, { h: Number(b.high), l: Number(b.low), c: Number(b.closePrice), rank: rank === -1 ? 99 : rank });
    }
  }
  console.log('symbols with', TF, 'bars:', barsBy.size);

  // 4. news timeline per symbol (fetch availability, createdAt)
  const newsRows = (await p.request().query("SELECT symbol, CONVERT(varchar(19),createdAt,120) c FROM NewsItems")).recordset;
  const newsBy = new Map();
  let firstNewsMs = Infinity;
  for (const r of newsRows) {
    const ms = utcMs(r.c);
    if (!Number.isFinite(ms)) continue;
    if (ms < firstNewsMs) firstNewsMs = ms;
    if (!newsBy.has(r.symbol)) newsBy.set(r.symbol, []);
    newsBy.get(r.symbol).push(ms);
  }
  for (const arr of newsBy.values()) arr.sort((a, b) => a - b);
  console.log('news items:', newsRows.length, '| first fetched:', new Date(firstNewsMs).toISOString(), '| symbols:', newsBy.size);

  // 5. dedup + price attach (identical), then walk both orderings
  const kept = [];
  const seenAt = new Map();
  let deduped = 0, missingPrice = 0, priceFallback = 0;
  for (const pr of proposals) {
    const k = pr.symbol + '|' + pr.direction;
    const prev = seenAt.get(k) || 0;
    if (pr.tMs - prev < DEDUP_MS) { deduped++; continue; }
    seenAt.set(k, pr.tMs);
    let P = priceMap.get(pr.promptId + '|' + pr.symbol + '|' + pr.direction + '|entry');
    if (P == null) {
      const m = barsBy.get(pr.symbol);
      if (m) for (let k2 = 0; k2 < 6; k2++) { const b = m.get(barFloor(pr.tMs) - k2 * BAR_MS); if (b) { P = b.c; priceFallback++; break; } }
    }
    if (P == null) { missingPrice++; continue; }
    kept.push({ ...pr, P });
  }
  console.log('kept:', kept.length, '| deduped:', deduped, '| missingPrice:', missingPrice, '| priceFallback:', priceFallback);

  const sims = [];
  for (const it of kept) {
    const m = barsBy.get(it.symbol);
    if (!m) continue;
    const d = it.direction === 'buy' ? 1 : -1;
    const a = walk({ bars: m, startMs: barFloor(it.tMs), d, P: it.P, D: it.stop, favFirst: false });
    const f = walk({ bars: m, startMs: barFloor(it.tMs), d, P: it.P, D: it.stop, favFirst: true });
    if (!a || !f) continue;
    const arr = newsBy.get(it.symbol) || [];
    const nCount = arr.length ? countInWindow(arr, it.tMs - NEWS_WINDOW_MS, it.tMs) : 0;
    let newestMs = null;
    if (arr.length) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= it.tMs) lo = mid + 1; else hi = mid; } if (lo > 0) newestMs = arr[lo - 1]; }
    const newestAgeH = newestMs == null ? null : +((it.tMs - newestMs) / 3600000).toFixed(2);
    sims.push({ i: it, Radv: a.R, Rfav: f.R, reasonA: a.reason, reasonF: f.reason, costR: COST_R[it.symbol] ?? null, news: nCount, newestAgeH, crypto: CRYPTO.has(it.symbol) });
  }
  const inNewsWindow = (x) => x.i.tMs >= firstNewsMs;
  console.log('simulated:', sims.length, '| in news window:', sims.filter(inNewsWindow).length);
  const reasonMix = (key) => { const m = {}; for (const x of sims) m[x[key]] = (m[x[key]] || 0) + 1; return m; };
  console.log('reason mix adv:', JSON.stringify(reasonMix('reasonA')), '| fav:', JSON.stringify(reasonMix('reasonF')));

  // 6. arms
  const nw = sims.filter(inNewsWindow);
  const arms = {
    RAW: sims,
    'RAW(news-window)': nw,
    'CHAIRS-YES': sims.filter((x) => x.i.chairVote === 'yes'),
    'CHAIRS-NO': sims.filter((x) => x.i.chairVote === 'no'),
    'CHAIRS-OTHER': sims.filter((x) => x.i.chairVote !== 'yes' && x.i.chairVote !== 'no'),
    'NEWS+': nw.filter((x) => x.news >= 1),
    'NEWS-': nw.filter((x) => x.news === 0),
    'NEWS-DENSE(>=3)': nw.filter((x) => x.news >= 3),
    'NEWS-SPARSE(<3)': nw.filter((x) => x.news < 3),
    'NEWS-RECENT(<=2h)': nw.filter((x) => x.newestAgeH != null && x.newestAgeH <= 2),
    'NEWS-STALE(>2h)': nw.filter((x) => x.newestAgeH == null || x.newestAgeH > 2),
    'NONCRYPTO+': nw.filter((x) => !x.crypto && x.news >= 1),
    'NONCRYPTO-': nw.filter((x) => !x.crypto && x.news === 0),
  };
  const hist = {};
  for (const x of nw) { const b = x.news >= 10 ? '10+' : String(x.news); hist[b] = (hist[b] || 0) + 1; }
  console.log('news-count histogram (news-window):', JSON.stringify(hist));
  const table = {};
  for (const [name, arr] of Object.entries(arms)) {
    table[name] = {};
    for (const ord of ['adv', 'fav']) {
      const key = ord === 'adv' ? 'Radv' : 'Rfav';
      table[name][ord] = { gross: stat(arr, key), net: statNet(arr, key) };
    }
  }
  const deltas = {};
  const pairs = [['NEWS+', 'NEWS-'], ['CHAIRS-YES', 'CHAIRS-NO'], ['NONCRYPTO+', 'NONCRYPTO-'], ['NEWS-DENSE(>=3)', 'NEWS-SPARSE(<3)'], ['NEWS-RECENT(<=2h)', 'NEWS-STALE(>2h)']];
  for (const [a, b] of pairs) {
    if (!arms[a].length || !arms[b].length) { deltas[a + ' - ' + b] = null; continue; }
    deltas[a + ' - ' + b] = {
      adv: bootDiffUnpaired(arms[a], arms[b], 'Radv'),
      fav: bootDiffUnpaired(arms[a], arms[b], 'Rfav'),
    };
  }

  // composition of NEWS+ and NEWS- by symbol (confound view)
  const comp = {};
  for (const name of ['NEWS+', 'NEWS-']) {
    const m = {};
    for (const x of arms[name]) m[x.i.symbol] = (m[x.i.symbol] || 0) + 1;
    comp[name] = Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  }

  const rho = {
    adv: spearman(nw, (r) => r.news, (r) => r.Radv),
    fav: spearman(nw, (r) => r.news, (r) => r.Rfav),
  };
  console.log('Spearman rho(newsCount, R) news-window: adv', rho.adv, '| fav', rho.fav);

  const out = {
    generatedAt: new Date().toISOString(),
    method: 'baseline walk identical to resim-exits/chair-test; news split = >=1 NewsItems fetched in 24h before decision; unpaired bootstrap 10k 90% CI; net = costs-in-R per symbol',
    tf: TF, since: SINCE, kept: kept.length, simulated: sims.length, inNewsWindow: nw.length, firstNewsMs: new Date(firstNewsMs).toISOString(),
    arms: table, deltas, composition: comp, costR: COST_R, rho,
    rows: sims.map((x) => ({ evId: x.i.evId, symbol: x.i.symbol, t: x.i.t, news: x.news, newestAgeH: x.newestAgeH, Radv: x.Radv, Rfav: x.Rfav, chairVote: x.i.chairVote })),
  };

  console.log('\n===== NEWS ARMS (n=' + sims.length + ', news-window n=' + nw.length + ') =====');
  for (const name of Object.keys(arms)) {
    const t = table[name];
    if (!t.adv.gross.n) { console.log(name.padEnd(18), '(empty)'); continue; }
    console.log(
      name.padEnd(18) +
      ' n=' + String(t.adv.gross.n).padStart(3) +
      ' | adv meanR ' + String(t.adv.gross.meanR).padStart(6) + ' win% ' + String(t.adv.gross.winPct).padStart(4) +
      ' | fav meanR ' + String(t.fav.gross.meanR).padStart(6) + ' win% ' + String(t.fav.gross.winPct).padStart(4) +
      ' | net(adv) ' + String(t.adv.net.meanR).padStart(6)
    );
  }
  console.log('\ndeltas (unpaired bootstrap 90% CI):');
  for (const [k, v] of Object.entries(deltas)) {
    if (!v) { console.log('  ' + k + ': (empty arm)'); continue; }
    console.log('  ' + k.padEnd(24) + ' adv ' + v.adv.aMean + '-' + v.adv.bMean + ' = ' + (v.adv.aMean - v.adv.bMean).toFixed(3) + ' [' + v.adv.lo90 + ', ' + v.adv.hi90 + ']' +
      ' | fav ' + (v.fav.aMean - v.fav.bMean).toFixed(3) + ' [' + v.fav.lo90 + ', ' + v.fav.hi90 + ']');
  }
  console.log('\nNEWS+ composition:', JSON.stringify(comp['NEWS+']));
  console.log('NEWS- composition:', JSON.stringify(comp['NEWS-']));

  fs.writeFileSync(path.join(__dirname, '../../temp/news-arms-out.json'), JSON.stringify(out, null, 2));
  console.log('\nwrote temp/news-arms-out.json');
  await p.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
