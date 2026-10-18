'use strict';

const browser = require('./browser');
const webtrader = require('./webtrader');
const health = require('./health');
const store = require('../store');
const instruments = require('../store/instruments');
const { jitterDelay } = require('../lib/pacing');

const { CATEGORY_URLS, CATEGORY_FALLBACKS } = webtrader;

// ---------------------------------------------------------------------------
// TRD-8 capture redesign: SEARCH-BAR capture.
// Instead of navigating to every category link (all-popular, spotlight,
// cryptocurrencies, singapore, ...) on each wake, the bridge lands on the
// trade page ONCE and uses the Plus500 search bar per tracked symbol.
// SPA searches are far cheaper than full page navigations -> much faster
// return time. The full category sweep survives only as a rare fallback:
//   - universe empty (first run): sweep seeds the universe;
//   - a search misses: sweep refreshes the universe and recovers misses;
//   - periodic refresh: one sweep per capture.universeRefreshHours (default
//     24h) keeps the universe + broad tick coverage fresh.
// ---------------------------------------------------------------------------

const CATS = [
  ['cryptocurrencies', CATEGORY_URLS.cryptocurrencies, null],
  ['commodities', CATEGORY_URLS.commodities, null],
  ['singapore', CATEGORY_URLS.singapore, null],
  ['hong-kong', CATEGORY_URLS['hong-kong'], CATEGORY_FALLBACKS['hong-kong']],
];

// ★★ TRD-EXE-16 (#1504, 2026-10-02): A CAPTURE THAT CANNOT RETURN MUST FAIL NAMED, NOT HANG FOREVER.
//
// MEASURED (docs/incident-2026-10-02-ui-fallback-pause.md §3c): after a Chrome relaunch under a live desk,
// multi-attach churn left a half-dead CDP session where OS-level reads (page.url(), process memory) complete
// normally but `page.evaluate` NEVER returns — reproduced twice, the 06:28Z and 06:37Z captures hung ~8-9
// minutes each while HOLDING pageLock, so every later capture queued behind them. The wake loop looked like it
// was capturing while nothing could progress: the same never-silent failure class the desk has fixed elsewhere.
//
// 90 s is ~5x the worst healthy capture seen (TRD-83's 121 s number is a LOCK WAIT, reported separately, and
// bounded by its own 120 s acquire). The race does not cancel the underlying Playwright call — nothing can —
// but it converts the hang into a NAMED failure the latch can count, releases pageLock, and discards the
// wedged page so the next capture rebuilds a fresh render target.
const CAPTURE_HARD_TIMEOUT_MS = 90000;
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => {
        const e = new Error(`${label}_timeout: no return within ${ms}ms — a half-dead CDP session (page.evaluate never settling); failing NAMED so the latch can count it (TRD-EXE-16)`);
        e.captureTimeout = true;
        rej(e);
      }, ms);
    }),
  ]);
}

// Full category sweep: visit each category once, read EVERY row.
async function categorySweep(page) {
  const ticks = [];
  const seen = new Set();
  for (const [, url, fallback] of CATS) {
    const readCat = async (u) => {
      await webtrader.withConnRetry(() => page.goto(u, { timeout: 45000, waitUntil: 'domcontentloaded' }));
      return webtrader.waitForTable(page, 20000);
    };
    const pages = [await readCat(url)];
    if (fallback) {
      try { pages.push(await readCat(fallback)); } catch { /* split page optional */ }
    }
    for (const table of pages) {
      for (const row of table.rows) {
        if (!row.name || row.buy == null || row.sell == null) continue;
        if (seen.has(row.name)) continue;
        ticks.push({ venue: 'plus500', symbol: row.name, bid: row.sell, ask: row.buy, source: 'plus500_frontend' });
        seen.add(row.name);
      }
    }
  }
  return { ticks, names: [...seen] };
}

// Persist the universe from a sweep result (never overwrites the user-curated
// symbols list — that belongs to the user).
async function updateUniverse(userId, settings, names, { seedSymbols = false } = {}) {
  const next = [...names].sort();
  const prevUniverse = (settings.watchlist?.universe || []).map((s) => s.symbol).sort().join('|');
  const patch = {};
  if (prevUniverse !== next.join('|')) {
    patch.universe = next.map((symbol) => ({ symbol, venue: 'plus500' }));
  }
  if (seedSymbols && !(settings.watchlist?.symbols || []).length) {
    patch.symbols = next.slice(0, 9).map((symbol) => ({ symbol, venue: 'plus500' }));
  }
  if (Object.keys(patch).length) {
    settings = await store.saveSettings(userId, { watchlist: patch });
  }
  return settings;
}

// Persist captured ticks and SURFACE the ingest verdict (2026-09-11 owner
// patch): quarantines used to be invisible here — Silver and Sany Heavy
// Equipment banks were rejected for days while every capture still reported a
// clean 36/36. Logged as tick_ingest telemetry when anything was quarantined,
// deduped or re-anchored.
async function bankTicks(userId, ticks) {
  const ing = await store.addTicks(userId, ticks);
  if (ing.quarantined || ing.deduped || (ing.reanchored && ing.reanchored.length) || ing.catchup) {
    await store.logEvent(userId, 'telemetry', {
      source: 'tick_ingest',
      inserted: ing.inserted,
      quarantined: ing.quarantined,
      deduped: ing.deduped,
      catchup: ing.catchup || 0,
      reanchored: (ing.reanchored || []).map((r) => `${r.symbol} ${r.oldMid}->${r.newMid} (anchor ${r.ageMin}m old)`),
    }).catch(() => { /* telemetry is best-effort */ });
  }
  return ing;
}

// TRD-9 H: bank the venue's own chart bars (ChartIQ masterData) into
// PriceBars under venue 'plus500_chart'.
//
// ★ 043 — `tfMap` IS A BUCKETING DECISION, `intervalSec` IS THE FACT, AND THEY ARE NOT THE SAME NUMBER.
// The map sends BOTH 1800 and 3600 to '1h' and falls through to '1h' for anything else, so a 30-minute
// chart lands in 1h buckets with two bars merged per row and no trace of it. That was design-doc §4.1 and
// it could not be detected from the stored row at all, because `timeframe` is the label the MAPPING chose.
// The row now carries `sourceIntervalSec` = what the chart was ACTUALLY on, so the aggregation is recorded
// rather than implied. The mapping itself is unchanged here (the owner's sequencing: record first).
// TRD-GRD-3/GRD-4 — WHOSE BARS WERE THOSE? Pure, so it can be tested without a browser.
//
// `readChartBars` has always returned `symbol: engine.chart.symbol` — and `bankChartBars` threw it away,
// banking the series under its `symbol` ARGUMENT. That is the whole instrument-swap defect: 151 rows of the
// WRONG instrument reached quant across seven watchlist symbols before it was found
// (trading/docs/instrument-swap-2026-09-24.md).
//
// ★ THE FIRST CHECK WAS A NAME COMPARISON AND IT WAS UNENFORCEABLE — MEASURED, NOT ASSUMED. Observing it live
// returned of:12, match:0, mismatch:12, unrecorded:0 twice running, because `engine.chart.symbol` is the
// VENUE'S INSTRUMENT ID, not a name: Gold is `11_Sell`, Oil `10_Sell`, Bitcoin `3406_Sell`. ENFORCING THAT
// WOULD HAVE REFUSED 100% OF CAPTURES ON THE NEXT WAKE.
//
// ★ THE REPLACEMENT IS EXACT AND ALIAS-PROOF. `<id>_<side>` is a venue instrument id, and the desk ALREADY
// keeps a registry keyed UNIQUE on (userId, venue, venueInstrumentId) — migration 035 — whose rows name the
// desk symbol. Validated against all eight observed pairs on 2026-09-24: 7 resolved to exactly the expected
// symbol (11 Gold, 10 Oil, 12 Silver, 115 Arabica Coffee, 116 Sugar, 3406 Bitcoin, 3424 SGX). The eighth,
// 3989/Sands China, has NO REGISTRY ROW — which is why `unregistered` is its own verdict and NOT a pass.
//
// ★ IT IS ALSO ALIAS-PROOF WHERE A CONSECUTIVE-ID TEST WOULD NOT BE WORTH TRUSTING: Oil and Brent Oil are
// genuinely different instruments here (ids 10 and 431), so an alias pair would not have silently disabled
// it — but the registry is right by construction rather than by luck, and it catches a stale read even when
// the page was left on an instrument from a PREVIOUS sweep, which comparing to the previous symbol cannot.

// `11_Sell` -> `11`. Returns null when the venue gives us nothing to parse — and null is NOT a pass.
function chartInstrumentId(chartSymbol) {
  const m = String(chartSymbol == null ? '' : chartSymbol).match(/^\s*(\d+)/);
  return m ? m[1] : null;
}

// Case, spacing and punctuation are not identity, so they are normalised away. `registrySymbol` comes from the
// desk's own registry, so this compares desk-name to desk-name — a mismatch is a real signal, not a naming gap.
const normSymbol = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

// 'match' | 'mismatch' | 'unregistered' | 'unrecorded'. ABSENCE IS NEVER `match`: a chart that does not say
// which instrument it is has told us nothing, and treating silence as agreement is how a guard goes inert.
function chartIdentityVerdict(chartSymbol, deskSymbol, registrySymbol) {
  if (!chartInstrumentId(chartSymbol)) return 'unrecorded';
  const r = normSymbol(registrySymbol);
  if (!r) return 'unregistered';
  return r === normSymbol(deskSymbol) ? 'match' : 'mismatch';
}

// ★ THE BUCKETING, EXTRACTED AND PURE (TRD-GRD-5, 2026-09-25). It is the decision under dispute, and a
// decision that can only be exercised through a live browser cannot be pinned by a test.
//
// WHAT WAS WRONG WITH LEAVING IT INLINE. `tfMap` is unchanged here — the owner's sequencing is intact — but
// the fall-through it performs was recoverable ONLY from `sourceIntervalSec`, which says what the chart WAS
// and not what the mapping DID with it. So a row built from twelve 5-minute bars and a row built from one
// native 1h bar were INDISTINGUISHABLE in the capture result. That is what the row recorded as its concrete
// next action, and it is why the range-fidelity half of its gate could not be discharged: the chart's own 5m
// and 30m bars are never stored, and every chart volume is 0, so the count of source bars existed nowhere.
// `merge.histogram` is that count, reported at write time.
//
// ⚠ `merge` IS NOT VOLUME AND IS NOT DERIVABLE FROM IT. An aggregated hour and a native hour can carry
// identical OHLC (they SHOULD, if the bucket is right), so the only fact that separates them is how many
// source bars went in.
const TF_MAP = Object.freeze({ 900: '15m', 1800: '1h', 3600: '1h', 14400: '4h', 86400: '1d' });
const BUCKET_MS = Object.freeze({ '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 });

// Returns the bars to store AND the arithmetic that produced them. `fallThrough` is TRUE exactly when the
// chart declared an interval the map does not know, so the substitution is NAMED rather than inferred.
function bucketChartBars(bars, intervalSec) {
  const declared = intervalSec == null ? null : Number(intervalSec);
  const mapped = declared != null && Object.prototype.hasOwnProperty.call(TF_MAP, declared) ? TF_MAP[declared] : null;
  const target = mapped || '1h';
  const bucketMs = BUCKET_MS[target];
  const buckets = new Map();
  for (const b of bars) {
    const start = Math.floor(b.DT / bucketMs) * bucketMs;
    // 4.6/4.7-A (2026-10-03): seed NULL, never 0. `0` conflated "nothing traded" with "nothing was
    // READ" — a capture regression (volume stopped being read ~09-11) hid behind that plausible zero
    // for days. Absent stays absent all the way to the column.
    const agg = buckets.get(start) || { openPrice: b.Open, high: b.High, low: b.Low, closePrice: b.Close, volume: null, srcBars: 0 };
    if (b.High > agg.high) agg.high = b.High;
    if (b.Low < agg.low) agg.low = b.Low;
    agg.closePrice = b.Close;
    if (b.Volume != null) agg.volume = Number(agg.volume || 0) + Number(b.Volume);
    agg.srcBars++;
    buckets.set(start, agg);
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const histogram = {};
  let min = Infinity;
  let max = 0;
  for (const [, r] of sorted) {
    histogram[r.srcBars] = (histogram[r.srcBars] || 0) + 1;
    if (r.srcBars < min) min = r.srcBars;
    if (r.srcBars > max) max = r.srcBars;
  }
  return {
    target,
    bucketMs,
    fallThrough: declared != null && mapped == null,
    // Expected source bars per bucket (12 for a 5m chart into 1h) — null when the interval itself is unknown.
    nativePerBucket: declared == null ? null : bucketMs / 1000 / declared,
    merge: sorted.length
      ? { buckets: sorted.length, min, max, histogram, merged: sorted.length && max > 1 }
      : { buckets: 0, min: null, max: null, histogram: {}, merged: false },
    rows: sorted.map(([start, r]) => ({
      timeframe: target, barStart: new Date(start),
      openPrice: r.openPrice, high: r.high, low: r.low, closePrice: r.closePrice, volume: r.volume,
    })),
  };
}

async function bankChartBars(userId, symbol, page) {
  try {
    const c = await webtrader.readChartBars(page);
    if (!c.bars || c.bars.length < 10) return { chartBars: 0, chartErr: c.error || 'too_few_chart_bars' };
    // ★★ THE INTERVAL IS VERIFIED, NOT TRUSTED (2026-09-25). `intervalSec` is the ENGINE'S CLAIM and the
    // single field every row's provenance descends from — its `timeframe` through `TF_MAP` and its
    // `sourceIntervalSec` through the row. It is FALSIFIABLE, and not hypothetically: `setPeriodicity`
    // records the new layout BEFORE it attempts the reload and reports a failure only to the console (its own
    // source; `engine.dataCallback` is null on this venue), so `layout` can say 3600 while the series is 900.
    // Writing in that state labels 15m bars as 1h AND claims `sourceIntervalSec = 3600` for them — a
    // provenance that LIES, which is worse than an absent one. So the series' own bar spacing is measured
    // beside the claim, and only agreement is writable.
    const iv = webtrader.chartIntervalVerdict({ layoutSec: c.intervalSec, measuredSec: c.measuredIntervalSec });
    const ivReport = { verdict: iv, layoutSec: c.intervalSec, measuredSec: c.measuredIntervalSec };
    if (iv !== 'agree') {
      // One sweep of bars for one symbol, and the refusal rides the EXISTING `chartErr` path — the one TRD-68
      // wired to `chartMissing` and to telemetry — so it is reported rather than swallowed. `unmeasured` is
      // here too, deliberately: a chart whose spacing cannot be read has told us nothing, and writing a row
      // on silence is how a guard goes inert.
      const describe = (v) => (v == null ? '?' : `${v}s`);
      return {
        chartBars: 0,
        chartErr: `interval_${iv}: layout ${describe(c.intervalSec)} vs series ${describe(c.measuredIntervalSec)}`,
        chartInterval: ivReport,
      };
    }
    // ★ THE BUCKETING IS A DECLARED DECISION, NOT A DEFAULT. `bucketChartBars` returns what it did; this call
    // site no longer reproduces it. TRD-GRD-5 kept the mapping itself UNCHANGED on purpose — see the task row
    // for the measured reason, which is that mapping 300 to its own timeframe would stop refreshing the 1h
    // series that TRD-STR-1 made the ONLY structure venue.
    const bucketed = bucketChartBars(c.bars, c.intervalSec);
    const target = bucketed.target;
    const rows = bucketed.rows.map((r) => ({
      venue: 'plus500_chart', symbol, ...r,
      // What the chart was ON. `null` is a recorded unknown (readChartBars' own `layout.interval` was
      // unreadable), NOT "assume 1h" — upsertProviderBars accepts null and rejects an absent key.
      sourceIntervalSec: c.intervalSec == null ? null : Number(c.intervalSec),
    }));
    await store.upsertProviderBars(userId, rows);
    // ★ THE 15-MINUTE HOLE (2026-09-25). `TF_MAP[900]` is `'15m'`, and it is the ONLY entry that maps BELOW
    // 1h: every other interval refreshes the 1h series (300 falls through to 1h, 1800 is mapped to 1h, and
    // 3600/14400/86400 are 1h or coarser). Structure reads exactly one series — `quant.STRUCTURE_CHART_VENUE`
    // at `timeframe: '1h'`, the primary AND ONLY structure venue since TRD-STR-1 — and nothing consumes
    // `plus500_chart` at `'15m'`. So a tab left on 15m (measured live: it was) was the one state in which the
    // ONLY structure venue received no new bars at all.
    //
    // Rolling the fine series UP closes that without touching the mapping GRD-5 ruled on. `upsertAggBars`
    // does a correct OHLC rollup (open = first, close = last, high = MAX, low = MIN) and declares
    // `sourceIntervalSec = 900`, so the 1h rows it writes are recorded as AGGREGATED rather than native —
    // `barIntervalProvenance` tells them apart, which is the entire reason that column exists. Guarded on the
    // BUCKET rather than on the literal `'15m'` so the rule survives a change to the map.
    let chartRollup = 0;
    if (bucketed.bucketMs < 3600000) {
      chartRollup = await store.upsertAggBars(userId, { venue: 'plus500_chart', symbol, fromTf: target, toTf: '1h' })
        .catch(() => 0);
    }
    // ⚠ RECORDED, NOT ENFORCED, AND THE REASON IS CONCRETE RATHER THAN CAUTION.
    // `engine.chart.symbol` is the VENUE's string for the instrument, which need not equal the desk's: the
    // desk says `SGX`, `Oil`, `Sands China`, `Bank of E.Asia`. Refusing on string inequality BEFORE the
    // agreement has been measured would refuse LEGITIMATE captures — a worse failure than the defect being
    // fixed. So this pass measures, and enforcement waits for the calibration.
    //
    // ⚠ AND NEITHER VERDICT IS A FINDING ABOUT THE DATA. It compares two NAMES, not two price series: a
    // chart can display the right name and still carry the previous instrument's masterData, and a
    // `mismatch` may be nothing more than a naming difference. Only about the LABELS.
    const chartSymbol = c.symbol == null ? null : String(c.symbol);
    // ⚠ REQUIRED DIRECTLY, NOT THROUGH THE STORE INDEX. `trading/store.js` does NOT re-export
    // `getInstrumentById` — verified, it is `undefined` there — so a `store.getInstrumentById(...)` call would
    // throw a TypeError on every capture while any test reading the call site as TEXT still passed. That is
    // exactly the near-miss recorded in trading/docs/instrument-swap-2026-09-24.md section 8, so the direct
    // require is deliberate and the test asserts this symbol resolves rather than merely appearing.
    const chartId = chartInstrumentId(chartSymbol);
    let registrySymbol = null;
    if (chartId) {
      // venue 'plus500': the registry is keyed by the venue's own instrument id, and the chart capture's
      // instrument ids are the same namespace (Gold 11, from migration 035's data).
      const row = await instruments.getInstrumentById(userId, { venue: 'plus500', venueInstrumentId: chartId }).catch(() => null);
      registrySymbol = row ? row.symbol : null;
    }
    return {
      chartBars: rows.length, chartTf: target, chartIntervalSec: c.intervalSec,
      // What the series MEASURED beside what the engine claimed, so "this row is a 1h row" is a fact of the
      // capture rather than a repetition of the engine's assertion.
      chartInterval: ivReport,
      // How many 1h rows this 15m read contributed through the rollup. Zero on every other interval.
      chartRollup,
      // ★ TRD-GRD-5's concrete next action: HOW MANY SOURCE BARS BUILT EACH STORED ROW, per bucket. Reported
      // rather than recorded in a column, because it is only needed for the fidelity question and the schema
      // has no field for it; `histogram` is keyed by source bars per bucket.
      chartMerge: bucketed.merge,
      chartSourceBarsPerBucket: bucketed.nativePerBucket,
      // TRUE when the chart declared an interval the map does not know, so the '1h' target was a SUBSTITUTION.
      chartFallThrough: bucketed.fallThrough,
      chartSymbol,
      chartId,
      chartRegistrySymbol: registrySymbol,
      chartIdentity: chartIdentityVerdict(chartSymbol, symbol, registrySymbol),
      // The one number that makes §4.1 visible from a capture result: true means the rows written under a
      // native label were AGGREGATED into it, so their range statistics are not native-range statistics.
      chartAggregated: c.intervalSec != null && Number(c.intervalSec) !== bucketed.bucketMs / 1000,
    };
  } catch (e) {
    return { chartBars: 0, chartErr: String(e.message || e).slice(0, 120) };
  }
}

// Search the watchlist, one search-bar lookup per symbol. TRD-12 Phase 0:
// BURST capture — after the first read, re-read the live ticket 2 more times
// ~2s apart (no extra navigation) so each wake banks ~3 ticks per symbol.
// ★ TRD-GRD-4: the match-case heartbeat. A CLEAN identity sweep used to be silent, and `capture_chart_identity`
// therefore only ever fired on an anomaly — so the record could not answer "does mismatch ever fire on a healthy
// capture" except in the affirmative, because health left no trace. Module state, like `review.js`'s round-robin
// cursor, because the cadence is a property of the process and one event per six hours is the intended rate.
const IDENTITY_HEARTBEAT_MS = 6 * 3600 * 1000;
let lastIdentityHeartbeat = 0;

async function captureBySearch(userId, settings, page, { only = null, chartsOnly = false } = {}) {
  const wanted = (settings.watchlist?.symbols || []).filter((s) => s && s.symbol);
  const symbols = only && only.length ? wanted.filter((s) => only.includes(s.symbol)) : wanted;
  const ticks = [];
  const missing = [];
  // TRD-68 (2026-09-22): CHART-BAR FAILURES ARE A DIFFERENT QUESTION FROM TICK MISSES, and they were the
  // invisible half. `bankChartBars` already returned `chartErr`; the caller read only `chartBars` and threw
  // the error away, so a symbol whose SIGNAL SERIES had stopped being written was reported as fully captured.
  // The only visible artefact was a bare `stale` on a panel with no explanation - and a symbol whose series
  // is stale is silently excluded from evaluation forever while still costing a scout slot and riding in
  // every chair bundle.
  // `missing` cannot carry this: it means "the ticket lookup found nothing" (the TICKS question). A chart-bar
  // failure happens on a symbol whose ticks succeeded perfectly - China Shenhua was capturing 3 ticks per
  // sweep with an empty `missing` list while its 1h bars sat 456 minutes stale.
  const chartMissing = [];
  // TRD-GRD-3 observe mode: whose bars were banked? Counted, never acted on.
  const chartIdentity = { match: 0, mismatch: 0, unregistered: 0, unrecorded: 0, samples: [] };
  // TRD-GRD-5: what the bucketing DID, aggregated for the sweep. Kept beside `chartIdentity` because the two
  // are the same kind of fact — a property of the capture the desk would otherwise have to infer from the
  // stored rows, one sweep later, after the interval had already changed.
  const chartMerge = { merged: 0, maxMerge: 0, fallThrough: 0, largest: null };
  let chartBars = 0;
  // ★ THE INTERVAL VERDICT, AGGREGATED (2026-09-25). `disagree` is the number that matters: the engine's
  // claim and the series' own spacing did not match, so those symbols banked NO bars rather than mislabelled
  // ones. `rollups` counts the 1h rows this sweep built FROM a finer series, which is the structure venue
  // being refreshed on an interval that used to contribute nothing to it.
  const chartInterval = { agree: 0, disagree: 0, unmeasured: 0, rollups: 0, firstError: null };
  const burst = Math.max(1, Math.min(5, Number(settings.capture?.burstTicks) || 3));
  // chartsOnly: focus+bank under a per-symbol hard deadline (ADR-8) so one slow symbol cannot eat the sweep.
  const bankFor = async (sym) => {
    if (!chartsOnly) return bankChartBars(userId, sym.symbol, page);
    return withTimeout((async () => {
      const f = await webtrader.searchInstrument(page, sym.symbol, settings);
      if (!f || !f.hit) throw new Error('focus_miss');
      await page.waitForTimeout(1200);
      return bankChartBars(userId, sym.symbol, page);
    })(), CHART_VISIT_DEADLINE_MS, `chart:${sym.symbol}`);
  };
  for (const sym of symbols) {
    try {
      if (!chartsOnly) {
      const r = await webtrader.searchInstrument(page, sym.symbol, settings);
      if (!r || !r.hit || (r.hit.buy == null && r.hit.sell == null)) {
        missing.push(sym.symbol);
        continue;
      }
      ticks.push({ venue: sym.venue || 'plus500', symbol: sym.symbol, bid: r.hit.sell, ask: r.hit.buy, source: 'plus500_frontend' });
      // Burst re-reads: the ticket updates live on the open chart page.
      for (let b = 1; b < burst; b++) {
        await new Promise((res) => setTimeout(res, 1800 + Math.random() * 700));
        try {
          const t = await webtrader.readTicket(page);
          const num = (s) => (s == null || s === '' ? null : parseFloat(String(s).replace(/,/g, '')));
          const lastB = (side) => [...(t.labels || [])].reverse().find((l) => l.side === side);
          const buy = num(lastB('Buy') ? lastB('Buy').value : t.rates.buy);
          const sell = num(lastB('Sell') ? lastB('Sell').value : t.rates.sell);
          if (buy == null && sell == null) continue;
          ticks.push({ venue: sym.venue || 'plus500', symbol: sym.symbol, bid: sell, ask: buy, source: 'plus500_frontend' });
        } catch { /* burst read optional */ }
      }
      } // end !chartsOnly
      // Bank the venue's own chart bars (full visible series) — deadline-bounded in chartsOnly mode.
      const cb = await bankFor(sym);
      chartBars += cb.chartBars || 0;
      if (cb.chartErr) chartMissing.push({ symbol: sym.symbol, error: cb.chartErr });
      if (cb.chartMerge) {
        if (cb.chartMerge.merged) chartMerge.merged++;
        if (cb.chartMerge.max > chartMerge.maxMerge) {
          chartMerge.maxMerge = cb.chartMerge.max;
          chartMerge.largest = { symbol: sym.symbol, intervalSec: cb.chartIntervalSec, histogram: cb.chartMerge.histogram };
        }
      }
      if (cb.chartFallThrough) chartMerge.fallThrough++;
      if (cb.chartAggregated) chartMerge.aggregated = (chartMerge.aggregated || 0) + 1;
      // Consumed, not discarded — the TRD-68 lesson, applied to the interval before it can cost the same thing.
      if (cb.chartInterval) {
        chartInterval[cb.chartInterval.verdict] = (chartInterval[cb.chartInterval.verdict] || 0) + 1;
        if (cb.chartInterval.verdict !== 'agree' && !chartInterval.firstError) chartInterval.firstError = cb.chartErr || null;
      }
      if (cb.chartRollup) chartInterval.rollups += cb.chartRollup;
      // ★ CONSUMED, NOT DISCARDED. This file ALREADY lost a whole diagnostic this way — TRD-68: `chartErr`
      // was returned and ignored, so a symbol whose signal series had stopped being written read as FULLY
      // CAPTURED. A field nobody reads is not telemetry, so the caller tallies it here.
      if (cb.chartIdentity) {
        chartIdentity[cb.chartIdentity] = (chartIdentity[cb.chartIdentity] || 0) + 1;
        if (cb.chartIdentity !== 'match' && chartIdentity.samples.length < 8) {
          chartIdentity.samples.push({ symbol: sym.symbol, chartSymbol: cb.chartSymbol, chartId: cb.chartId, registry: cb.chartRegistrySymbol });
        }
      }
    } catch (e) {
      if (chartsOnly) {
        // A deadline/focus failure in the chart pass is a CHART fact only — the symbol's quote is unaffected.
        chartMissing.push({ symbol: sym.symbol, error: String((e && e.message) || e).slice(0, 90) });
      } else {
        missing.push(sym.symbol);
        chartMissing.push({ symbol: sym.symbol, error: `tick_path: ${String(e.message || e).slice(0, 90)}` });
      }
    } finally {
      if (chartsOnly) lastChartAt.set(sym.symbol, Date.now());
    }
    await jitterDelay(400, 1100); // human-like pacing between searches
  }
  // Telemetry only when it FAILED, so the event is a signal rather than a stream. The diagnostic existed
  // inside bankChartBars the whole time; this is where it stops being discarded.
  if (chartMissing.length) {
    await store.logEvent(userId, 'telemetry', {
      source: 'capture_chart_bars',
      failed: chartMissing.length,
      of: symbols.length,
      symbols: chartMissing.slice(0, 8),
    }).catch(() => {});
  }
  // The interval verdict, on the same signal-not-stream convention. A write refused here is a row whose
  // `timeframe` AND `sourceIntervalSec` would both have been wrong, and an unknown that only exists inside a
  // return value never gets read.
  if (chartInterval.disagree || chartInterval.unmeasured) {
    await store.logEvent(userId, 'telemetry', {
      source: 'capture_chart_interval',
      of: symbols.length, agree: chartInterval.agree,
      disagree: chartInterval.disagree, unmeasured: chartInterval.unmeasured,
      firstError: chartInterval.firstError,
      note: 'the engine\'s declared interval and the series\' own bar spacing did not agree (or could not be measured), so those symbols banked NO bars rather than rows whose timeframe and sourceIntervalSec would both have been wrong.',
    }).catch(() => {});
  }
  // Same convention as above — an event is a SIGNAL, not a stream. `unrecorded` fires because a chart that
  // never says which instrument it is makes any guard inert, and from outside "the field never arrived" and
  // "we ignore it" are indistinguishable. `unregistered` fires because it is a COVERAGE fact that silently
  // disables the check for that symbol — 3989/Sands China has no registry row today — and a guard that is
  // absent for one symbol looks exactly like a guard that passed for it. `mismatch` is the real anomaly.
  if (chartIdentity.mismatch || chartIdentity.unrecorded || chartIdentity.unregistered) {
    await store.logEvent(userId, 'telemetry', {
      source: 'capture_chart_identity',
      of: symbols.length,
      match: chartIdentity.match, mismatch: chartIdentity.mismatch,
      unregistered: chartIdentity.unregistered, unrecorded: chartIdentity.unrecorded,
      samples: chartIdentity.samples,
      note: 'OBSERVE ONLY — instrument ids checked against the registry, no row withheld. mismatch is a stale read; unregistered is missing registry COVERAGE, not a data error.',
    }).catch(() => {});
  } else if (Date.now() - lastIdentityHeartbeat >= IDENTITY_HEARTBEAT_MS) {
    // ★ THE MATCH-CASE HEARTBEAT (TRD-GRD-4, approved 2026-09-25). A FULLY CLEAN sweep used to be silent, so
    // the record could not distinguish "every symbol matched" from "the capture stopped running" — and the
    // enforcement question is exactly "does mismatch EVER fire on a healthy capture", which a signal-only
    // record can only ever answer in the affirmative. Low cadence, one event per six hours, so a clean state
    // is RECORDED rather than assumed, and the ledger keeps an interval during which the check was known to be
    // running and clean.
    //
    // ⚠ IT DOES NOT REPLACE THE BLOCKER. 483 of 1,946 recorded observations are `unregistered` — the registry
    // has no row, so the check CANNOT RUN for those symbols — and enforcement stays unauthorised until that
    // coverage gap closes. A heartbeat makes the clean case visible; it does not make an absent guard look
    // like a present one, and this comment says so where the next reader will be.
    lastIdentityHeartbeat = Date.now();
    await store.logEvent(userId, 'telemetry', {
      source: 'capture_chart_identity',
      heartbeat: true,
      of: symbols.length,
      match: chartIdentity.match, mismatch: chartIdentity.mismatch,
      unregistered: chartIdentity.unregistered, unrecorded: chartIdentity.unrecorded,
      samples: [],
      // TRD-GRD-5 rides here because this is the only low-cadence, durable record of a capture's arithmetic:
      // how many source bars built each stored row. Without it the range-fidelity question can only be asked
      // of a live capture result, which nothing writes down.
      merge: chartMerge,
      // ★ AND SO DOES THE INTERVAL VERDICT, for exactly the GRD-4 reason: a capture whose interval always
      // agreed leaves NO trace, so a signal-only record could never distinguish "every sweep verified its
      // interval" from "the verification stopped being called". One event per six hours suits a fact that
      // should always be true.
      interval: chartInterval,
      // ⚠ THE NOTE IS UPDATED WITH THE FACT, because a stale recorded claim is what this whole series of rows
      // keeps paying for. Coverage was the enforcement blocker, and on 2026-09-25 the six unregistered pairs
      // were backfilled from the VENUE's own id/name pairing (trading/scripts/backfill-chart-identity-registry.js);
      // the first sweep afterwards reported `unregistered: 0` of 12. Enforcement is still NOT enabled here —
      // that costs a symbol its series when it fires wrongly, so it stays an owner decision — but the note no
      // longer claims a blocker that has been cleared.
      note: 'HEARTBEAT — a clean instrument-identity sweep, recorded so that silence is not the only evidence of health. OBSERVE ONLY, by design: a mismatch costs a symbol its series, so refusal is an owner decision. Both gates are now measured — mismatch has never fired on the current emitter, and the registry COVERAGE gap was closed 2026-09-25 (6 pairs backfilled from the venue\'s own id/name read).',
    }).catch(() => {});
  }
  return { ticks, missing, chartBars, chartMissing, chartIdentity, chartMerge, chartInterval };
}

// ─── WATCHLIST FAST PATH (2026-10-18) ────────────────────────────────────────────────────────────────────
// WHY. The swept capture paid PER SYMBOL: a search+select, two 1.8-2.5 s burst re-reads, a chart read and a
// jitter pause — measured 7-15 s per instrument, i.e. >90 s for the 10-symbol watchlist and a named
// `capture_timeout` on nearly every wake (4 tab swaps in one evening). The laptop continuity run measured the
// alternative at ~1.5 s TOTAL: one DOM read of the watchlist table returns every row's live sell/buy.
//
// THE SPLIT. Quotes now come from one table read (ADR-1: read the page that is already open, do not search
// per instrument). Chart bars still need the per-instrument focus the venue provides, so every watchlist
// symbol's chart is still read on every dynamic capture — only the TICK BURST's transport changed (three
// table reads ≈ 4.5 s total instead of ≈45 s), and quotes are banked BEFORE the chart sweep, so a slow venue
// can no longer time-out the wake's prices. `webtrader.readInstrumentTable` is the desk's own proven reader.
const WATCHLIST_PATH_RE = /\/trade\/watchlists--\d+/i;

// CHART ROTATION (2026-10-18): the chart half still costs a search+focus per instrument (~4-12 s on a slow
// venue). One slow symbol cannot be allowed to eat the sweep budget, so every chart visit races its own hard
// deadline, and each dynamic capture charts only the N least-recently-charted symbols. Every visit reads the
// chart's FULL series (bankChartBars upserts the whole visible history), so rotation creates NO bar gaps — it
// only bounds how stale the newest bar can be (~2-3 wakes ≈ 20-30 min for 10 symbols at 5/wake), inside
// quant's BAR_FRESH_MS = 4 h by a wide margin.
const CHART_VISIT_DEADLINE_MS = Number(process.env.CAPTURE_CHART_VISIT_MS) || 12000;
const CHART_VISITS_PER_WAKE = Math.max(1, Number(process.env.CAPTURE_CHART_VISITS) || 5);
// The whole rotation gets its own budget OUTSIDE the 90 s quote race (captureOnce) — a slow chart can never
// turn a good quote capture into a NAMED timeout + tab swap.
const CHART_ROTATION_BUDGET_MS = Number(process.env.CAPTURE_CHART_BUDGET_MS) || 40000;
const lastChartAt = new Map(); // symbol -> ms; module state like review.js's cursor (resets on restart, harmless)

// 2026-10-18 v2: ROTATION BACKOFF for a CLOSED VENUE. Measured: on the closed weekend venue every chart visit
// completes but banks ZERO bars (charts serve no new series), and the rotation still spends up to its 40 s
// budget cycling the shared tab (weekend capture 61.3 s vs ~15-20 s without). After CHART_ZERO_STREAK_LIMIT
// consecutive zero-bank rotations, the next CHART_SKIP_WAKES wakes skip the rotation and the one after tries
// again — so a venue REOPEN is picked up within ~20 min, which BAR_FRESH_MS = 4 h makes free. Signal-only
// telemetry: the zero-bank event carries the streak, and a resume that banks bars is logged once so the
// weekend-to-Monday transition is visible instead of inferred.
const CHART_ZERO_STREAK_LIMIT = 2;
const CHART_SKIP_WAKES = 2;
let chartZeroStreak = 0;
let chartSkipWakes = 0;

// Pure: map watchlist-table rows to venue ticks. Exact-name matching only — a renamed instrument must fall
// through to the search path rather than silently misprice. Exported for pins.
function mapTableRowsToTicks(rows, symbols) {
  const byName = new Map((rows || []).map((r) => [String((r && r.name) || '').trim(), r]));
  const ticks = [];
  const missing = [];
  for (const sym of symbols || []) {
    const r = byName.get(String((sym && sym.symbol) || '').trim());
    if (!r || (r.buy == null && r.sell == null)) { missing.push(sym.symbol); continue; }
    ticks.push({ venue: sym.venue || 'plus500', symbol: sym.symbol, bid: r.sell, ask: r.buy, source: 'plus500_frontend' });
  }
  return { ticks, missing };
}

async function resolveWatchlistUrl(settings, page) {
  const configured = String((settings.bridge || {}).watchlistUrl || '');
  if (WATCHLIST_PATH_RE.test(configured)) return configured;
  const hrefs = ((settings.bridge || {}).hrefMap || {}).hrefs || [];
  const hit = hrefs.find((h) => WATCHLIST_PATH_RE.test(String(h)));
  if (hit) return 'https://app.plus500.com' + String(hit);
  // Last resort: the CURRENT page's own links (read-only; raced — evaluate has no default timeout, ADR-8).
  try {
    const found = await Promise.race([
      page.evaluate(() => {
        const href = [...document.querySelectorAll('a[href]')]
          .map((a) => a.getAttribute('href'))
          .find((h) => h && /watchlists--\d+/.test(h));
        if (href) return href;
        const m = location.pathname.match(/\/trade\/watchlists--\d+/);
        return m ? m[0] : null;
      }),
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ]);
    if (found) return 'https://app.plus500.com' + String(found);
  } catch { /* detection is best-effort; the caller falls back to the search path */ }
  return null;
}

// One table read (plus burst re-reads) = every watchlist instrument's live quote. Navigates ONCE when the
// tab is elsewhere — the same single hard nav the old flow paid (goto cryptocurrencies), not a per-symbol one.
async function captureQuotesFromWatchlist(userId, settings, page, url) {
  const symbols = (settings.watchlist?.symbols || []).filter((s) => s && s.symbol);
  const ms = { goto: 0, wait: 0, burst: 0 };
  let t = Date.now();
  if (!WATCHLIST_PATH_RE.test(String(page.url() || ''))) {
    await webtrader.withConnRetry(() => page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' }));
  }
  ms.goto = Date.now() - t; t = Date.now();
  const table = await webtrader.waitForTable(page, 15000).catch(() => null);
  ms.wait = Date.now() - t; t = Date.now();
  const first = mapTableRowsToTicks((table && table.rows) || [], symbols);
  const ticks = [...first.ticks];
  const have = new Set(first.ticks.map((t2) => t2.symbol));
  const burst = Math.max(1, Math.min(5, Number(settings.capture?.burstTicks) || 3));
  for (let b = 1; b < burst; b++) {
    await new Promise((res) => setTimeout(res, 1400 + Math.random() * 600));
    try {
      const tv = await webtrader.readInstrumentTable(page);
      ticks.push(...mapTableRowsToTicks((tv && tv.rows) || [], symbols.filter((s) => have.has(s.symbol))).ticks);
    } catch { /* burst read optional */ }
  }
  ms.burst = Date.now() - t;
  return { ticks, missing: first.missing, rows: ((table && table.rows) || []).length, ms, urlAtStart: String(page.url() || '').slice(0, 80) };
}

// Dynamic mode (2026-10-18 restructure): QUOTES first from one watchlist-table read (ADR-1), then the
// per-symbol CHART sweep (the venue's own series — full coverage every wake), then the legacy search path
// ONLY for symbols the table could not supply (renames/moves), then the universe sweep when actually due.
async function captureDynamic(userId, settings, page) {
  const symbols = (settings.watchlist?.symbols || []).filter((s) => s && s.symbol);
  let ticks = [];
  let missing = symbols.map((s) => s.symbol);
  let chartBars = 0;
  const chartMissing = [];
  const chartInterval = { agree: 0, disagree: 0, unmeasured: 0, rollups: 0, firstError: null };
  const mergeChart = (r) => {
    if (!r) return;
    chartBars += r.chartBars || 0;
    for (const m of r.chartMissing || []) chartMissing.push(m);
    // chartIdentity + chartMerge are deliberately NOT aggregated here: captureBySearch logs the identity
    // verdict at the point of measurement (its own `capture_chart_identity` event), and neither field is
    // part of this function's contract — see the local-scope pin in test/capture-chart-bars.test.js.
    const ct = r.chartInterval || {};
    for (const k of ['agree', 'disagree', 'unmeasured', 'rollups']) chartInterval[k] += ct[k] || 0;
    if (!chartInterval.firstError && ct.firstError) chartInterval.firstError = ct.firstError;
  };

  // 1) QUOTES — one table read of the analysis watchlist (persisted once resolved).
  const url = await resolveWatchlistUrl(settings, page);
  if (url) {
    try {
      const q = await captureQuotesFromWatchlist(userId, settings, page, url);
      ticks = q.ticks;
      missing = q.missing;
      // OP TEMPORARY INSTRUMENT (2026-10-18 change window): timing per stage, one event per capture.
      // Tighten to signal-only once the stage costs are known.
      await store.logEvent(userId, 'telemetry', {
        source: 'watchlist_quote_source', url, rows: q.rows, ticks: q.ticks.length, missing: q.missing.length,
        ms: q.ms, urlAtStart: q.urlAtStart,
      }).catch(() => {});
      if (String((settings.bridge || {}).watchlistUrl || '') !== url) {
        settings = await store.saveSettings(userId, { bridge: { ...(settings.bridge || {}), watchlistUrl: url } });
      }
    } catch (e) {
      await store.logEvent(userId, 'telemetry', { source: 'watchlist_quote_source', error: String(e.message || e).slice(0, 140) }).catch(() => {});
    }
  }
  // href map: read by captureOnce for every mode - not duplicated here.

  // ★ BANK THE QUOTES NOW (2026-10-18): the chart sweep below is the slow half. Banking before it means a
  // venue slow enough to run this capture into its 90 s timeout can never cost the wake its PRICES — that is
  // the exact failure this restructure exists to remove (quotes used to be banked only if the whole sweep fit).
  const ingest = { inserted: 0, quarantined: 0, reanchored: [] };
  const bank = async (list) => {
    if (!list || !list.length) return;
    const ing = await bankTicks(userId, list);
    ingest.inserted += ing.inserted || 0;
    ingest.quarantined += ing.quarantined || 0;
    ingest.reanchored.push(...(ing.reanchored || []));
  };
  await bank(ticks);

  // 2) CHARTS — least-recently-charted slice, focus-only (quotes already banked above).
  // (chart rotation moved OUT of this function: it now runs in captureOnce after the quote race,
  //  with its own budget and the same pageLock, so a slow chart can never fail a good quote capture.)

  // 3) FALLBACK — symbols the table could not supply: the legacy search path for JUST those.
  if (missing.length) {
    const fb = await captureBySearch(userId, settings, page, { only: missing });
    await bank(fb.ticks || []);
    ticks = ticks.concat(fb.ticks || []);
    missing = fb.missing || [];
    mergeChart(fb);
  }

  // 4) Universe sweep — unchanged trigger (no universe yet, stale, or a search miss).
  const universe = settings.watchlist?.universe || [];
  const refreshHours = Number(settings.capture?.universeRefreshHours ?? 24);
  const lastSweep = settings.bridge?.lastSweepAt ? new Date(settings.bridge.lastSweepAt) : null;
  const universeStale = refreshHours > 0 && universe.length && (!lastSweep || Date.now() - lastSweep.getTime() > refreshHours * 3600 * 1000);
  let sweepResult = null;
  if (!universe.length || universeStale || missing.length) {
    try {
      sweepResult = await categorySweep(page);
    } catch { /* sweep optional */ }
    if (sweepResult) {
      settings = await updateUniverse(userId, settings, sweepResult.names, { seedSymbols: !universe.length });
      await store.saveSettings(userId, { bridge: { ...(settings.bridge || {}), lastSweepAt: new Date().toISOString() } });
      const byName = new Map(sweepResult.ticks.map((t) => [t.symbol, t]));
      const recovered = [];
      for (const m of [...missing]) {
        const row = byName.get(m);
        if (row) { recovered.push({ ...row }); missing.splice(missing.indexOf(m), 1); }
      }
      await bank(recovered);
      ticks = ticks.concat(recovered);
    }
  }

  if (!ticks.length) return { captured: 0, reason: 'no_table_rows', missing, chartBars, chartMissing, chartInterval, dynamic: true };
  return { captured: ticks.length, symbols: ticks.map((t) => t.symbol), missing, chartBars, chartMissing, chartInterval, dynamic: true, mode: 'dynamic', sweep: !!sweepResult, ingest: { inserted: ingest.inserted, quarantined: ingest.quarantined, reanchored: ingest.reanchored.length } };
}

// Fixed mode: search each confirmed symbol; category sweep fallback for misses.
async function captureFixed(userId, settings, page) {
  await webtrader.withConnRetry(() => page.goto(CATEGORY_URLS.cryptocurrencies, { timeout: 45000, waitUntil: 'domcontentloaded' }));
  await webtrader.waitForTable(page, 20000).catch(() => {});

  const { ticks, missing, chartBars, chartMissing, chartInterval } = await captureBySearch(userId, settings, page);
  if (missing.length) {
    const sweepResult = await categorySweep(page).catch(() => null);
    if (sweepResult) {
      const byName = new Map(sweepResult.ticks.map((t) => [t.symbol, t]));
      for (const m of [...missing]) {
        const row = byName.get(m);
        if (row) { ticks.push({ ...row }); missing.splice(missing.indexOf(m), 1); }
      }
    }
  }
  const ing = ticks.length ? await bankTicks(userId, ticks) : { inserted: 0, quarantined: 0, deduped: 0, reanchored: [] };
  return { captured: ticks.length, symbols: ticks.map((t) => t.symbol), missing, chartBars, chartMissing, chartInterval, mode: 'fixed', ingest: { inserted: ing.inserted, quarantined: ing.quarantined, reanchored: (ing.reanchored || []).length } };
}

// TRD-83 (2026-09-19): report a bridge-lock wait at or above this. The capture's own work measures ~1-2s,
// so anything past 5s is the shared tab, not the browser — and a wait nobody records is a wait that gets
// read as work (which is exactly how `capture 121325ms` survived two weeks of review).
const CAPTURE_LOCK_REPORT_MS = 5000;

async function captureOnce(userId, settings, providedPage) {
  const symbols = (settings.watchlist && settings.watchlist.symbols) || [];
  const mode = settings.watchlist?.mode || 'dynamic';
  // 2026-10-03 PARK (operator-scope): while parked the capture refuses BEFORE anything else — it is
  // the only path that launches Chrome by design (`browser.newPage()` → `connectOrLaunch`), so the
  // gate must sit above the page acquisition, not below it.
  if (settings.bridge?.parked) return { captured: 0, reason: 'parked' };
  // TRD-12 Phase 0: claim the shared bridge page for the conflict registry.
  require('../agent/wakePipeline').bridgeUse('capture', true);
  let page = null; // TRD-EXE-16: hoisted so the timeout path can discard a wedged page
  try {
    // 2026-09-11: serialize against ticket flows / the mirror (pageLock) —
    // a capture mid-ticket must wait, never fight for the tab.
    //
    // TRD-83 (2026-09-19): THE 120s IS A WAIT, NOT WORK, and it is now recorded rather than inferred.
    // The wake record's `capture 121325ms` (100x every other step) is almost entirely this line: on
    // 17/09 the desk spent 120 of 121 seconds parked here while a ticket held the tab. The row asked
    // two questions and both are now answerable: (a) WHY — because the step's duration folds in a lock
    // wait, and the wait is not proportional to anything the capture does; (b) WHETHER the wake path and
    // `POST /capture` are the same code — they are: the wake goes connector.getQuotes -> browser.getQuotes
    // -> captureOnce, and the route calls captureOnce directly. One frozen bridge starves both equally.
    //
    // Reported as an EVENT and not returned, deliberately: threading a field through the seven return
    // paths of this function would put the number where only one caller can see it, and the point of
    // TRD-83 is that the number was invisible until someone correlated two timestamps by hand.
    const pageLock = require('./pageLock');
    const lock = await pageLock.acquire('capture', { waitMs: 120000 });
    const lockWaitMs = Number(lock && lock.waitedMs) || 0;
    if (lockWaitMs >= CAPTURE_LOCK_REPORT_MS) {
      await store.logEvent(userId, 'telemetry', {
        source: 'capture_lock_wait', waitedMs: lockWaitMs, waitedOn: (lock && lock.waitedOn) || [],
        configuredWaitMs: 120000, watchlist: (settings.watchlist && settings.watchlist.symbols || []).length,
      }).catch(() => {});
    }
    page = providedPage || (await browser.newPage());

    // ★ TRD-EXE-16 (#1504): every step below runs under a hard 90 s race — a wedged evaluate fails NAMED here
    // instead of holding pageLock forever (see withTimeout for the measured case and its limits).
    const result = await withTimeout((async () => {

    // A1: selector health check BEFORE any trading action.
    // CONTINUITY 2026-10-10 (data-collection mode): the gate exists to stop TRADING on an unhealthy UI
    // and raises a pause + alert after 3 fails. When the desk is only READING (laptop continuity run),
    // a selector drift would block capture entirely instead of just blocking orders — so the gate is
    // skippable by explicit flag. Inert unless TRADING_CAPTURE_SKIP_HEALTH=1.
    if (process.env.TRADING_CAPTURE_SKIP_HEALTH === '1') {
      console.error('[trading.capture] selector health gate SKIPPED (data-collection mode)');
    } else {
      const hc = await health.checkAndGate(userId, settings, page);
      if (!hc.ok) return { captured: 0, reason: hc.reason, paused: hc.paused };
    }

    const demo = await webtrader.assertDemo(page, settings);
    if (!demo.demo) return { captured: 0, reason: 'not_demo', demo };

    if (mode === 'dynamic') {
      // TRD-12 Phase 3 (#210): discover the live href map once per wake — the
      // link-first navigation baseline (routes shift after soft-kill resumes).
      try {
        const map = await webtrader.readHrefMap(page);
        // 4.11 (2026-10-03): guard on CONTENT, not the stamp. `readHrefMap` stamps `at` fresh per read,
        // so the old full-JSON compare was ALWAYS true — a saveSettings + href_map telemetry fired every
        // wake (~9-12 min; measured 313/410 settings_write rows in 72 h were timestamp-only). `at` now
        // means "when the map last CHANGED"; no consumer needs a read-stamp.
        if (hrefMapChanged((settings.bridge || {}).hrefMap, map.hrefs)) {
          await store.saveSettings(userId, { bridge: { hrefMap: { at: map.at, hrefs: map.hrefs } } });
          await store.logEvent(userId, 'telemetry', { source: 'href_map', hrefs: map.hrefs.length, at: map.at });
        }
      } catch { /* href map optional */ }
      const r = await captureDynamic(userId, settings, page);
      // TRD-11: bank the demo account strip (Available/Equity/M.Margin/P&L).
      try {
        const acc = await webtrader.readAccountStatus(page);
        if (acc && acc.equity != null) await require('../agent/accountPoller').acceptSample(userId, acc, 'capture');
      } catch { /* account optional */ }
      return { ...r, demo: demo.detail };
    }

    if (!symbols.length) return { captured: 0, reason: 'empty_watchlist', mode: 'fixed' };

    // Fixed mode: search-bar capture per confirmed symbol (sweep fallback
    // lives inside captureFixed).
    const r = await captureFixed(userId, settings, page);
    // TRD-11: bank the demo account strip (Available/Equity/M.Margin/P&L).
    try {
      const acc = await webtrader.readAccountStatus(page);
      if (acc && acc.equity != null) await require('../agent/accountPoller').acceptSample(userId, acc, 'capture');
    } catch { /* account optional */ }
    return { ...r, demo: demo.detail };
    })(), CAPTURE_HARD_TIMEOUT_MS, 'capture');

    // ── CHART ROTATION (2026-10-18) — OUTSIDE the quote race, same lock, own budget ─────────────────────
    // Quotes are what the wake cannot live without; chart bars are supplementary (structure venue, 4 h SLA),
    // and each visit reads the full series so rotation creates no gaps. Kept in the same pageLock window so
    // no other consumer can interleave, but a slow chart here cannot fail the capture. Telemetry is a
    // SIGNAL, not a stream: logged only when a visit failed or nothing banked.
    if (mode === 'dynamic' && (settings.watchlist?.symbols || []).length) {
      try {
        if (chartSkipWakes > 0) {
          // Backing off after a zero-bank streak: this wake spends NOTHING on charts (the skip is already
          // announced by the zero-bank event that set the streak — no event per skipped wake).
          chartSkipWakes -= 1;
        } else {
          const syms = settings.watchlist.symbols;
          const order = [...syms].sort((a, b) => (lastChartAt.get(a.symbol) || 0) - (lastChartAt.get(b.symbol) || 0));
          const slice = order.slice(0, CHART_VISITS_PER_WAKE).map((s) => s.symbol);
          const c = await withTimeout(
            captureBySearch(userId, settings, page, { chartsOnly: true, only: slice }),
            CHART_ROTATION_BUDGET_MS, 'chart_rotation'
          );
          const failed = (c.chartMissing || []).length;
          const bars = c.chartBars || 0;
          if (bars > 0) {
            if (chartZeroStreak >= CHART_ZERO_STREAK_LIMIT) {
              await store.logEvent(userId, 'telemetry', {
                source: 'chart_rotation', resumed: true, chartBars: bars, zeroStreak: chartZeroStreak,
                note: 'chart bars are banking again after a zero-bank streak (venue reopened); rotation backoff cleared',
              }).catch(() => {});
            }
            chartZeroStreak = 0;
          } else {
            chartZeroStreak += 1;
            if (chartZeroStreak === CHART_ZERO_STREAK_LIMIT) chartSkipWakes = CHART_SKIP_WAKES;
            await store.logEvent(userId, 'telemetry', {
              source: 'chart_rotation', of: slice.length, chartBars: 0, failed,
              zeroStreak: chartZeroStreak, skipNextWakes: chartSkipWakes,
              samples: (c.chartMissing || []).slice(0, 4),
            }).catch(() => {});
          }
        }
      } catch (e) {
        await store.logEvent(userId, 'telemetry', {
          source: 'chart_rotation', error: String(e.message || e).slice(0, 140),
        }).catch(() => {});
      }
    }
    return result;
  } catch (e) {
    if (e && e.captureTimeout) {
      // ★ TRD-BRG-1 (#1511, 2026-10-05): NEVER CLOSE THE SHARED PAGE. TRD-EXE-16's "discard the wedged
      // page" closed the bridge tab directly — but that tab is normally Chrome's ONLY tab, and closing the
      // last tab EXITS CHROME cleanly (no crash dump, no WER event). Measured 2026-10-05: 17 desk-caused
      // Chrome exits; each exit drops the bridge for every consumer and risks the venue session. The discard
      // is now a SWAP — open a fresh tab FIRST (tab count >= 2), then close the wedged one — so Chrome
      // survives with one tab and the next consumer's newPage() finds the fresh one. If the fresh tab cannot
      // be opened (half-dead CDP), close NOTHING: a wedged page is a far lesser failure than a dead Chrome.
      try {
        const ctx = page ? page.context() : null;
        if (ctx) {
          const fresh = await Promise.race([
            ctx.newPage().catch(() => null),
            new Promise((r) => setTimeout(() => r(null), 8000)),
          ]);
          if (fresh) {
            const tabsNow = ctx.pages().length;
            try { page.close().catch(() => {}); } catch { /* ignore */ }
            console.error(`[trading.capture] wedged page recycled via tab swap (tabs now ${tabsNow}) — Chrome survives; old tab discarded`);
          } else {
            console.error('[trading.capture] wedged page swap: no fresh tab within 8s — closing NOTHING (a dead Chrome is worse than a wedged page)');
          }
        }
      } catch { /* the failure path must never throw */ }
      return { captured: 0, reason: String(e.message || e).slice(0, 200), timedOut: true };
    }
    const conn = e && e.connError;
    if (conn) {
      const fail = await health.recordConnectionFailure(userId);
      return { captured: 0, reason: 'plus500_connection_error', paused: fail.paused, consecutiveFails: fail.consecutiveFails };
    }
    return { captured: 0, reason: String(e.message || e).slice(0, 200) };
  } finally {
    require('./pageLock').release('capture');
    require('../agent/wakePipeline').bridgeUse('capture', false);
  }
}

// 4.11: pure — true only when the hrefs CONTENT differs. The stamp (`at`) is deliberately excluded:
// comparing it was the always-true guard that buried the settings journal. Exported for test pins.
function hrefMapChanged(prevHrefMap, nextHrefs) {
  const prevHrefs = JSON.stringify((prevHrefMap || {}).hrefs || []);
  const next = JSON.stringify(nextHrefs || []);
  return prevHrefs !== next;
}

module.exports = { captureOnce, chartIdentityVerdict, chartInstrumentId, bucketChartBars, withTimeout, CAPTURE_HARD_TIMEOUT_MS, hrefMapChanged, mapTableRowsToTicks, WATCHLIST_PATH_RE };
