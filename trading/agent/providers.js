// trading/agent/providers.js — market data providers (TRD-5).
// Binance + OKX public REST behind one provider abstraction. snapshotAll
// stamps ONE uniform capturedAt across the whole snapshot and is guarded by
// a 60s staleness gate (skip re-snapshots inside minIntervalSec).
'use strict';

const https = require('https');
const store = require('../store');

// display name -> provider instrument ids. Only instruments that genuinely
// exist on the public spot/token markets are mapped; everything else is
// reported as no_provider_mapping (Plus500-only instruments).
// yahoo keys cover the whole Plus500 universe (TRD-9): crypto USD pairs,
// futures proxies for commodities, SG .SI / HK .HK equities. Tickers marked
// VERIFY were chosen by best guess — the live verification step probes each.
const SYMBOL_MAP = {
  // --- crypto (all three venues) ---
  Bitcoin: { binance: 'BTCUSDT', okx: 'BTC-USDT', yahoo: 'BTC-USD' },
  Ethereum: { binance: 'ETHUSDT', okx: 'ETH-USDT', yahoo: 'ETH-USD' },
  Solana: { binance: 'SOLUSDT', okx: 'SOL-USDT', yahoo: 'SOL-USD' },
  BNB: { binance: 'BNBUSDT', okx: 'BNB-USDT', yahoo: 'BNB-USD' },
  Avalanche: { binance: 'AVAXUSDT', okx: 'AVAX-USDT', yahoo: 'AVAX-USD' },
  'Bitcoin Cash ABC': { binance: 'BCHUSDT', okx: 'BCH-USDT', yahoo: 'BCH-USD' },
  Cardano: { binance: 'ADAUSDT', okx: 'ADA-USDT', yahoo: 'ADA-USD' },
  Chainlink: { binance: 'LINKUSDT', okx: 'LINK-USDT', yahoo: 'LINK-USD' },
  Filecoin: { binance: 'FILUSDT', okx: 'FIL-USDT', yahoo: 'FIL-USD' },
  Litecoin: { binance: 'LTCUSDT', okx: 'LTC-USDT', yahoo: 'LTC-USD' },
  'PAX Gold': { binance: 'PAXGUSDT', okx: 'PAXG-USDT', yahoo: 'PAXG-USD' },
  Polkadot: { binance: 'DOTUSDT', okx: 'DOT-USDT', yahoo: 'DOT-USD' },
  // CONTINUITY 2026-10-10: yahoo id was 'POL-USD' and 404s ("unknown symbol", verified live on the
  // laptop 2026-10-10 and re-verified on the desk 2026-10-18). POL28321-USD is the correct Yahoo id.
  Polygon: { binance: 'POLUSDT', okx: 'POL-USDT', yahoo: 'POL28321-USD' },
  'Ripple XRP': { binance: 'XRPUSDT', okx: 'XRP-USDT', yahoo: 'XRP-USD' },
  Stellar: { binance: 'XLMUSDT', okx: 'XLM-USDT', yahoo: 'XLM-USD' },
  Toncoin: { binance: 'TONUSDT', okx: 'TON-USDT', yahoo: 'TON11419-USD' }, // VERIFY
  Tron: { binance: 'TRXUSDT', okx: 'TRX-USDT', yahoo: 'TRX-USD' },
  Uniswap: { binance: 'UNIUSDT', okx: 'UNI-USDT', yahoo: 'UNI7083-USD' }, // VERIFY
  'Ethereum / Bitcoin': { yahoo: 'ETH-BTC' },
  // --- precious metals / commodities (yahoo futures proxies) ---
  Gold: { binance: 'PAXGUSDT', okx: 'PAXG-USDT', yahoo: 'GC=F' },
  Silver: { yahoo: 'SI=F' },
  Oil: { yahoo: 'CL=F' },
  'Brent Oil': { yahoo: 'BZ=F' },
  'Natural Gas': { yahoo: 'NG=F' },
  'Heating Oil': { yahoo: 'HO=F' },
  Gasoline: { yahoo: 'RB=F' },
  Copper: { yahoo: 'HG=F' },
  Palladium: { yahoo: 'PA=F' },
  Platinum: { yahoo: 'PL=F' },
  Corn: { yahoo: 'ZC=F' },
  Soybeans: { yahoo: 'ZS=F' },
  // Added 2026-09-24 (commodities ask): the soybean COMPLEX. `Soybean Oil` is the venue's own
  // spelling (a real Plus500 instrument — take-profit/bridge code in plus500/webtrader.js keys on
  // 'soybean oil'), kept exactly so stored rows and venue rows name the same thing. `Soybean Meal`
  // is NOT a Plus500 instrument; the name is carried here so the yahoo series has a stable display
  // key, and it must never be assumed to match a venue position. Both were absent from this map,
  // which is why neither had any stored history before today.
  'Soybean Oil': { yahoo: 'ZL=F' },
  'Soybean Meal': { yahoo: 'ZM=F' },
  Wheat: { yahoo: 'ZW=F' },
  Sugar: { yahoo: 'SB=F' },
  'Arabica Coffee': { yahoo: 'KC=F' },
  'Lean Hogs': { yahoo: 'HE=F' },
  'Live Cattle': { yahoo: 'LE=F' },
  Aluminum: { yahoo: 'ALI=F' }, // VERIFY
  // --- Singapore equities ---
  AIA: { yahoo: '1299.HK' },
  BOC: { yahoo: '2588.HK' }, // VERIFY (BOC Aviation)
  'Bank Of China': { yahoo: '3988.HK' },
  'Bank of E.Asia': { yahoo: '0023.HK' },
  CITIC: { yahoo: '0267.HK' },
  'CK Hutchison': { yahoo: '0001.HK' },
  'CLP Holdings': { yahoo: '0002.HK' },
  CNOOC: { yahoo: '0883.HK' },
  'China Life': { yahoo: '2628.HK' },
  'China Longyuan Power': { yahoo: '0916.HK' },
  'China Mobile': { yahoo: '0941.HK' },
  'China Railway': { yahoo: '0390.HK' },
  'China Resources': { yahoo: '0836.HK' }, // VERIFY (China Resources Power)
  'China Shenhua': { yahoo: '1088.HK' },
  'China Telecom': { yahoo: '0728.HK' },
  'China Unicom': { yahoo: '0762.HK' },
  'China overseas': { yahoo: '0688.HK' },
  'City Developments': { yahoo: 'C09.SI' },
  'DBS Group': { yahoo: 'D05.SI' },
  'Dairy Farm International Holdings': { yahoo: 'D01.SI' },
  'Geely Automobile': { yahoo: '0175.HK' },
  'Genting Singapore': { yahoo: 'G13.SI' },
  'HK & China Gas': { yahoo: '0003.HK' },
  HKEx: { yahoo: '0388.HK' },
  'Jardine Cycle & Carriage': { yahoo: 'C07.SI' },
  'Jardine Matheson Holdings': { yahoo: 'J36.SI' },
  'Keppel Corporation': { yahoo: 'BN4.SI' },
  'Mapletree Industrial': { yahoo: 'ME8U.SI' },
  'OCBC Bank': { yahoo: 'O39.SI' },
  SATS: { yahoo: 'S58.SI' },
  SGX: { yahoo: 'S68.SI' },
  SHK: { yahoo: '0016.HK' },
  'Sands China': { yahoo: '1928.HK' },
  'Sany Heavy Equipment': { yahoo: '0631.HK' },
  // Seatrium (S51.SI) not on Yahoo — left unmapped (Plus500-only).
  Sembcorp: { yahoo: 'U96.SI' },
  Sinopec: { yahoo: '0386.HK' },
  SingTel: { yahoo: 'Z74.SI' },
  'Singapore Airlines': { yahoo: 'C6L.SI' },
  'Singapore Technologies Engineering': { yahoo: 'S63.SI' },
  'Swire Pacific': { yahoo: '0019.HK' },
  Tencent: { yahoo: '0700.HK' },
  'Tsingtao Brewery': { yahoo: '0168.HK' },
  'UBTECH Robotics': { yahoo: '9880.HK' }, // VERIFY
  'United Overseas Bank': { yahoo: 'U11.SI' },
  Venture: { yahoo: 'V03.SI' },
  Wharf: { yahoo: '0004.HK' },
  'Wilmar International': { yahoo: 'F34.SI' },
  'Wynn Macau': { yahoo: '1128.HK' },
  Xiaomi: { yahoo: '1810.HK' },
  'ZTE Corporation': { yahoo: '0763.HK' },
  'CapitaLand Ascott': { yahoo: 'HMN.SI' }, // VERIFY
  // Not on any public feed (honest unmapped): SHEIN, Shanghai Biren Technology,
  // Crypto 10 Index, Gold/Silver Ratio, EUA.
};

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (oswald trading-agent provider snapshot)',
          Accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> http ${res.statusCode}`)); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('bad json from ' + url)); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
    req.on('error', reject);
  });
}

const PROVIDERS = {
  binance: {
    // data-api.binance.vision = Binance's public market-data host (no geo block).
    fetchTicker: async (instId) => {
      const r = await getJson(`https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=${instId}`);
      if (!r || r.bidPrice == null) throw new Error('binance ticker missing fields');
      return { bid: parseFloat(r.bidPrice), ask: parseFloat(r.askPrice) };
    },
  },
  okx: {
    fetchTicker: async (instId) => {
      const r = await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
      const t = r && r.data && r.data[0];
      if (!t) throw new Error('okx ticker missing data');
      return { bid: parseFloat(t.bidPx), ask: parseFloat(t.askPx) };
    },
  },
  yahoo: {
    // Mid only (no bid/ask on Yahoo) — bid and ask both set to last price.
    fetchTicker: async (instId) => {
      const yahoo = require('./providers/yahoo');
      const q = await yahoo.fetchQuote(instId);
      if (!Number.isFinite(q.mid)) throw new Error('yahoo ticker missing price');
      return { bid: q.mid, ask: q.mid };
    },
  },
};

// Snapshot every mapped watchlist symbol from every enabled provider.
// Uniform capturedAt; per-provider failures isolated; 60s staleness gate
// (force bypasses the gate — used by the wake's stale-data auto-refresh).
async function snapshotAll(userId, settings, opts = {}) {
  const cfg = settings.providers || { enabled: ['binance', 'okx'], minIntervalSec: 60 };
  const gateMs = Math.max(0, (Number(cfg.minIntervalSec) || 60)) * 1000;
  const last = await store.latestEvent(userId, 'provider_snapshot');
  if (!opts.force && last && Date.now() - new Date(last.createdAt).getTime() < gateMs) {
    return { skipped: true, reason: 'within_gate', lastAt: last.createdAt, results: last.payload?.results || {} };
  }

  const symbols = (settings.watchlist?.symbols || []).map((s) => s.symbol);
  const capturedAt = new Date(); // uniform timestamp for the whole snapshot
  const ticks = [];
  const results = {};

  for (const provider of cfg.enabled || ['binance', 'okx']) {
    const impl = PROVIDERS[provider];
    if (!impl) { results[provider] = { ok: false, error: 'unknown provider' }; continue; }
    const mapped = [];
    const unmapped = [];
    for (const name of symbols) {
      const id = SYMBOL_MAP[name] && SYMBOL_MAP[name][provider];
      if (id) mapped.push({ name, id });
      else unmapped.push(name);
    }
    let okCount = 0;
    const failures = [];
    await Promise.all(mapped.map(async ({ name, id }) => {
      try {
        const t = await impl.fetchTicker(id);
        if (!Number.isFinite(t.bid) || !Number.isFinite(t.ask)) throw new Error('non-finite prices');
        ticks.push({ venue: provider, symbol: name, bid: t.bid, ask: t.ask, source: `${provider}_rest`, capturedAt });
        okCount++;
      } catch (e) {
        failures.push({ symbol: name, error: String(e.message || e).slice(0, 120) });
      }
    }));
    results[provider] = { ok: failures.length === 0, ticks: okCount, unmapped: unmapped.length, failures };
  }

  if (ticks.length) await store.addTicks(userId, ticks);
  await store.logEvent(userId, 'provider_snapshot', { capturedAt: capturedAt.toISOString(), ticks: ticks.length, results });
  return { capturedAt: capturedAt.toISOString(), ticks: ticks.length, results };
}

async function providerStatus(userId) {
  const last = await store.latestEvent(userId, 'provider_snapshot');
  return { last: last ? { at: last.createdAt, ...last.payload } : null };
}

// Backfill historical bars into PriceBars for a provider-mapped symbol.
// Binance: /api/v3/klines (pages backwards when limit > 1000).
// OKX: /api/v5/market/history-candles (newest first).
// Yahoo: chart API, incremental (TRD-9); 4h = pull 1h then aggregate.
async function backfillBars(userId, { provider, symbol, timeframe = '1h', limit = 300, rangeDays = null }) {
  const instId = SYMBOL_MAP[symbol] && SYMBOL_MAP[symbol][provider];
  if (!instId) return { error: `no ${provider} mapping for ${symbol}`, bars: 0 };
  const bars = [];

  if (provider === 'yahoo') {
    // TRD-10: yahoo depth is bounded by DEPTH_DAYS, not the binance-era 300
    // default — only trim when a limit was explicitly requested.
    const r = await require('./providers/yahoo').backfill(userId, { symbol, ticker: instId, timeframe, rangeDays, limit: limit || null });
    return r.bars ? r : { ...r, error: r.reason || 'yahoo returned no bars', bars: r.bars || 0 };
  }

  const TF = { '5m': { binance: '5m', okx: '5m' }, '15m': { binance: '15m', okx: '15m' }, '1h': { binance: '1h', okx: '1H' }, '4h': { binance: '4h', okx: '4H' }, '1d': { binance: '1d', okx: '1Dutc' } };
  const tfg = TF[timeframe] || TF['1h'];
  if (provider === 'binance') {
    // Paging: klines come oldest-first with limit <= 1000; walk backwards.
    const total = Math.min(Number(limit) || 300, 5000);
    let endTime;
    for (let guard = 0; guard < 12 && bars.length < total; guard++) {
      const n = Math.min(1000, total - bars.length);
      let url = `https://data-api.binance.vision/api/v3/klines?symbol=${instId}&interval=${tfg.binance}&limit=${n}`;
      if (endTime) url += `&endTime=${endTime}`;
      const rows = await getJson(url);
      if (!rows.length) break;
      const page = rows.map((k) => ({
        venue: 'binance', symbol, timeframe,
        barStart: new Date(k[0]),
        openPrice: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), closePrice: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        // 043: the kline interval IS the requested timeframe (the TF map above is 1:1). A timeframe this map
        // does not know throws in upsertProviderBars rather than being written as if it were 1h.
        sourceIntervalSec: store.TIMEFRAME_SECONDS[timeframe],
      }));
      bars.unshift(...page);
      endTime = page[0].barStart.getTime() - 1;
      if (rows.length < n) break;
    }
  } else if (provider === 'okx') {
    const r = await getJson(`https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${tfg.okx}&limit=${Math.min(Number(limit) || 300, 300)}`);
    for (const c of (r && r.data) || []) {
      // OKX candles are newest-first: [ts, o, h, l, c, vol, ...]
      bars.push({
        venue: 'okx', symbol, timeframe,
        barStart: new Date(parseInt(c[0], 10)),
        openPrice: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), closePrice: parseFloat(c[4]),
        volume: parseFloat(c[5]),
        sourceIntervalSec: store.TIMEFRAME_SECONDS[timeframe], // 043: provider klines are native to `timeframe`
      });
    }
  } else {
    return { error: `unknown provider ${provider}`, bars: 0 };
  }
  if (!bars.length) return { error: `${provider} returned no klines for ${instId}`, bars: 0 };
  bars.sort((a, b) => new Date(a.barStart) - new Date(b.barStart));
  await store.upsertProviderBars(userId, bars);
  await store.logEvent(userId, 'telemetry', { source: 'provider_backfill', provider, symbol, timeframe, bars: bars.length });
  return { provider, symbol, timeframe, bars: bars.length, from: bars[0].barStart, to: bars[bars.length - 1].barStart };
}

// MULTI-TIMEFRAME BACKFILL (user ask 2026-09-10): the LLM sees the big
// picture — 5m (8h window), 1h (90 days), 4h (aggregated), 1d (~2 months).
// Provider priority per symbol: yahoo -> binance -> okx (first mapped wins).
// Incremental pulls make repeat runs cheap; serial + provider-paced.
const MULTI_TF_PLAN = [
  { timeframe: '5m', rangeDays: 2 },
  // 2026-09-11: 1h deepened 3 -> 90 days. Exchange-hours instruments (HK/SGX
  // equities trade ~7h/day) only collected ~21 bars from a 3-day window —
  // under quant.MIN_BARS (30) — so every AI-discovered equity showed "flat ·
  // insufficient data" forever (probe: 0019.HK serves 434 bars over 90d).
  // Incremental pulls keep this cheap for symbols that already have a tail;
  // a NEW symbol's first 1h pull lands the full window in one request.
  { timeframe: '1h', rangeDays: 90 },
  { timeframe: '4h', rangeDays: 8 },
  { timeframe: '1d', rangeDays: 60 },
];

async function backfillMultiTf(userId, settings, { symbols = null, force: _force = false } = {}) {
  const list = symbols || (settings.watchlist?.symbols || []).map((s) => s.symbol);
  if (!list.length) return { ok: 0, attempts: 0, skipped: 'empty_watchlist' };
  const results = [];
  let ok = 0;
  for (const symbol of list) {
    for (const plan of MULTI_TF_PLAN) {
      let done = false;
      for (const provider of ['yahoo', 'binance', 'okx']) {
        if (!(SYMBOL_MAP[symbol] && SYMBOL_MAP[symbol][provider])) continue;
        const r = await backfillBars(userId, { provider, symbol, timeframe: plan.timeframe, rangeDays: plan.rangeDays });
        results.push({ symbol, timeframe: plan.timeframe, provider, ...(r.error ? { error: r.error } : { bars: r.bars }) });
        if (r.bars) ok++;
        done = true;
        break; // one provider per symbol+tf is enough
      }
      if (!done) results.push({ symbol, timeframe: plan.timeframe, provider: null, error: 'no provider mapping' });
    }
  }
  await store.logEvent(userId, 'multi_tf_backfill', { symbols: list, ok, attempts: results.length, at: new Date().toISOString() });
  return { ok, attempts: results.length, results };
}

module.exports = { PROVIDERS, SYMBOL_MAP, snapshotAll, providerStatus, backfillBars, backfillMultiTf, MULTI_TF_PLAN };
