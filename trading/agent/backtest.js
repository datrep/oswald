// trading/agent/backtest.js — Turtle Ultimate backtester (TRD-6).
// Runs the same deterministic signals as quant.js (Donchian-20 breakout excl.
// current bar, ADX(14)>20 gate, 2xATR trailing exit) over 1h PriceBars, then
// produces TWO worksheets:
//   spot baseline  — trades at mid, flat taker fee per side
//   CFD estimated  — spread+slippage once per side, overnight swap, fee
//                    (single-charged since the 2026-09-10 erratum fix — see
//                    worksheet() for the double-count history)
// Ex-dividend normalization: out of scope for spot-style instruments; the
// CorporateEvents table drives session halts instead (noted in provenance).
'use strict';

const store = require('../store');
const strategies = require('./strategies');
const runTurtle = require('./strategies/turtleUltimate').backtest;
const { fundingMinuteFromText, DEFAULT_FUNDING_MINUTE_UTC } = require('./time');

const DEFAULTS = {
  riskPerTradePct: 1,     // Turtle: capital x 1% / (2 x ATR)
  atrStopMultiple: 2,     // trailing stop distance
  adxGate: 20,
  donchianPeriod: 20,
  capital: 10000,
  spotFeePct: 0.1,        // taker fee per side (spot baseline)
  cfdSpreadPct: 0.10,     // half-spread as % of price per side
  cfdSlippagePct: 0.05,   // per side
  cfdSwapDailyPct: 0.02,  // overnight funding per night held
  cfdFeePct: 0,
  // TRD-49: the UTC minute-of-day the venue bills carry at, for the symbol under test. NULL means
  // "no venue clock known" and is the LEGACY UTC-midnight count — see `costCfgFor`, which is the only
  // thing that should be setting this. Declared here so an absent field reads as a decision rather
  // than an omission, and so the strategies never have to distinguish absent from null.
  cfdSwapClockMinuteUtc: null,
};

// --- TRD-25 (2026-09-11): per-instrument cost calibration (cost model v2) ----
// Source: desk-captured plus500 tick history (PriceTicks), all valid quotes;
// value = P75 half-spread as % of price per side (sample spans 2.1-2.2d at
// n>=100 for the lab symbols; the extras are thin samples). Slippage is a
// documented PLACEHOLDER (fill telemetry below the sample floor); swap is
// unchanged (0.02%/night, plan §17). Application order:
//   DEFAULTS -> costCfgFor(symbol) -> explicit caller overrides (config/params)
// so the Backtest-tab editor can still override deliberately. Unlisted symbols
// keep the flat v1 basis and are flagged (costModelVersion 'v1-flat') in
// provenance. Calibration is for FUTURE tests only — never applied
// retroactively to already-scored families (their provenance says v1).
const COST_MODEL_VERSION = 'v2';
// TRD-79 (2026-09-21): a basis COMPUTED from stored tick history gets its OWN version label rather
// than reusing 'v2'. 'v2' means "the curated per-instrument table"; a run whose spread came from a
// 14-day p75 of the desk's own ticks is a different number from a different origin, and a stored run
// whose meaning changed while its label did not is the defect this repo already paid for once (the
// TRD-25 double-count erratum). See `COST_MODEL_VERSION_VENUE` for the same reasoning one phase ago.
const COST_MODEL_VERSION_DERIVED = 'v2-derived';
// --- PHASE 2 (2026-09-14): the venue's OWN carry, per instrument and per side -------------
// v2 charged `cfdSwapDailyPct: 0.02` — one number, both sides, every instrument. The venue does not
// work that way: Gold spot is -0.0319%/night on the BUY side and -0.0120% on the SELL side (a 2.7x
// difference in the cost of holding the same instrument), while the options on the same underlier
// charge 0.0000% both sides. A flat swap therefore overcharges options outright and misprices which
// side of a spot CFD is expensive.
//
// THE SIGN IS SETTLED EMPIRICALLY, from the desk's own eleven venue-closed trades (see
// agent/instruments.js): every trade that opened and closed inside one UTC day has funding exactly 0,
// the ONE trade crossing a UTC midnight is the ONE with non-zero funding, all eleven values are <= 0,
// and #1027's realised -0.01495%/night sits against the venue's stated sell-side rate of -0.0120%.
// So a negative display means the desk PAYS. `swapPctFor` returns the cost as a POSITIVE percentage,
// negating the venue's sign ONCE, here, rather than leaving six consumers to each get it right.
//
// SUPPLIED BY AN EXPLICIT SEED, NOT IMPLICITLY. The registry read is async and this module is not, so
// the basis arrives through `setVenueCostBasis` from a caller that awaited it (routes, or the desk at
// boot). A symbol whose basis was not seeded keeps the v2 number AND SAYS SO in its provenance —
// which is the whole point: a silently-unseeded run would otherwise look identical to a seeded one,
// and changing what a stored backtest means without changing its label is the defect this repo has
// already paid for once (the TRD-25 double-count erratum).
const COST_MODEL_VERSION_VENUE = 'v3-venue';
let VENUE_BASIS = {};
function setVenueCostBasis(map) { VENUE_BASIS = map || {}; return Object.keys(VENUE_BASIS).length; }
function getVenueCostBasis() { return VENUE_BASIS; }

// Cost of ONE night held, as a positive percentage, for the trade's own direction. Falls back to the
// flat v2 dial so an unseeded symbol behaves exactly as it did before this change.
function swapPctFor(c, direction) {
  const venue = direction === 'sell' ? c.cfdSwapSellPct : c.cfdSwapBuyPct;
  const v = Number(venue);
  if (Number.isFinite(v)) return v;
  // Fall back to the flat v2 dial. Checked with isFinite rather than `||`, because an EXPLICIT 0
  // ("this instrument carries no funding") is a real instruction and `||` would turn it into the
  // placeholder — the same absent-vs-zero confusion this codebase keeps having to fix, one layer down.
  // A cfg that has neither dial still gets DEFAULTS' 0.02 rather than a free night.
  const flat = Number(c.cfdSwapDailyPct);
  return Number.isFinite(flat) ? flat : DEFAULTS.cfdSwapDailyPct;
}

const CALIBRATED_SPREAD_HALF_PCT = {
  Bitcoin: 0.0750, Gold: 0.0097, Oil: 0.0364, Silver: 0.0468, Sugar: 0.0817,
  'Arabica Coffee': 0.0378, SGX: 0.2507,
  Ethereum: 0.1251, Solana: 0.9014, BNB: 1.0005, SHEIN: 0.4467, 'PAX Gold': 0.1851,
};
const CALIBRATED_SLIP_PCT = 0.05; // placeholder until fill telemetry matures

// --- TRD-79 (2026-09-21): THE DERIVED SPREAD LANE -------------------------------------------------
// The curated table has 12 entries, so every other symbol falls to `v1-flat` -> `roundTripBpsFromCfg`
// null -> `admit()` `no_cost_basis` -> refused. That refusal is honest but it is a BOOKKEEPING refusal,
// not a measurement, and for ~90 symbols it says nothing about the venue. `agent/spreadDerivation.js`
// computes the same quantity — a P75 HALF-spread — from the desk's own two-sided ticks, and this is
// where that result is applied.
//
// ⚠ THE CURATED ENTRY WINS WHERE THERE IS ONE. Not because curating beats measuring (measured 7/7, the
// table reproduces from the same ticks within 0.98-1.03x) but because the curated number is STABLE and
// the derived one is WINDOW-DEPENDENT, and it is the curated number that three live gates already carry:
// Gold 11.94 bps, Oil 17.28, Bitcoin 25.00, SGX 60.14 — which is what the TRD-114 measurements are
// stated against (Gold cost/R 39.8%, Oil 57.6%, BTC 44.8%). Letting a 14-day p75 silently replace those
// would move venue admission, the net-edge screen and the cost-share ceiling at once, for a 0-4% change
// in the number. So this lane FILLS GAPS ONLY, and a symbol keeps its curated value and its label.
//
// ⚠ THE SPREAD AND THE SLIPPAGE ARE COMPOSED IN ONE PLACE, BELOW. A derived figure covers the SPREAD
// term only; the budget stays `2 x (spread + slip) x 100` through `roundTripBpsFromCfg`. Substituting a
// derived spread for the round trip would loosen all three gates above at once (Gold 11.94 -> 3.08).
let SPREAD_DERIVATION = { derived: {}, unverifiable: new Set(), provenance: null };
function setSpreadDerivation({ derived = {}, unverifiable = [], provenance = null } = {}) {
  const map = {};
  for (const [symbol, v] of Object.entries(derived || {})) {
    // Accepts either a bare number or `{ halfPct, n }` (what the seeder passes). An entry with no
    // usable half-spread is DROPPED rather than stored as 0 — a 0 here is a free trade, the exact
    // coercion this repo keeps re-learning.
    const half = Number(v && typeof v === 'object' ? v.halfPct : v);
    if (!Number.isFinite(half) || half <= 0) continue;
    const n = v && typeof v === 'object' ? Number(v.n) : null;
    map[symbol] = { halfPct: half, n: Number.isFinite(n) ? n : null };
  }
  // `provenance` is what makes the audit REAL: the unverifiable list is a statement about the ticks we
  // could read, so it is only valid for a run that read them. Without provenance the labels stay
  // exactly as they were — the conservative default, and what keeps an unseeded process unchanged.
  const validProvenance = provenance && typeof provenance === 'object' ? { ...provenance } : null;
  SPREAD_DERIVATION = {
    derived: map,
    unverifiable: new Set(validProvenance ? (unverifiable || []).map(String) : []),
    provenance: validProvenance,
  };
  return { derived: Object.keys(map).length, audited: !!validProvenance, unverifiable: [...SPREAD_DERIVATION.unverifiable] };
}
function getSpreadDerivation() {
  return {
    derived: { ...SPREAD_DERIVATION.derived },
    unverifiable: [...SPREAD_DERIVATION.unverifiable],
    provenance: SPREAD_DERIVATION.provenance ? { ...SPREAD_DERIVATION.provenance } : null,
    audited: !!SPREAD_DERIVATION.provenance,
  };
}
function derivedSpreadFor(symbol) {
  const d = SPREAD_DERIVATION.derived[symbol];
  return d && Number.isFinite(d.halfPct) && d.halfPct > 0 ? d : null;
}

function costCfgFor(symbol) {
  const basis = VENUE_BASIS[symbol] || null;
  // A venue spread is used ONLY when it came from a capture taken while the market was OPEN. The
  // registry's `spreadHalfPct` is null otherwise by construction, so a closed-market placeholder can
  // never reach here — but the basis is re-checked rather than trusted, because this is the one path
  // where a placeholder would become a permanent cost constant.
  const venueSpread = basis && Number.isFinite(Number(basis.spreadHalfPct)) && Number(basis.spreadHalfPct) > 0
    ? Number(basis.spreadHalfPct) : null;
  const venueBuy = basis && Number.isFinite(Number(basis.fundingBuyPct)) ? -Number(basis.fundingBuyPct) : null;
  const venueSell = basis && Number.isFinite(Number(basis.fundingSellPct)) ? -Number(basis.fundingSellPct) : null;
  const hasFunding = venueBuy != null || venueSell != null;
  // PRECEDENCE (TRD-79): a live OPEN-MARKET capture, then the curated calibration, then the DERIVED
  // p75 — and the derived lane only ever FILLS A GAP. `usedDerived` (not `derived != null`) is what
  // labels the result, so a symbol that kept its curated value cannot be described as derived.
  const curated = CALIBRATED_SPREAD_HALF_PCT[symbol];
  const derived = derivedSpreadFor(symbol);
  const usedDerived = venueSpread == null && curated == null && derived != null;
  const spread = venueSpread != null ? venueSpread : (curated != null ? curated : (usedDerived ? derived.halfPct : null));
  if (spread == null && !hasFunding) return { costModelVersion: 'v1-flat' };  // TRD-49: WHICH CLOCK THE NIGHTS WERE COUNTED ON. The venue does not bill at midnight; it bills
  // once per crossing of the "Overnight funding time" it publishes per instrument (5:00 AM for the
  // Gold chain). Every strategy backtester counted UTC midnights, so a hold that straddles 05:00 but
  // no midnight was free in the model and charged in reality — the exact disagreement the funding
  // validator hit on its first testable row (Trades #29: zero midnights crossed, 0.31 charged).
  //
  // The clock travels to the strategies through cfg, because they are what builds each trade's
  // `nights` and the worksheet is what prices it. A symbol on the venue basis therefore ALWAYS gets
  // a clock — the instrument's own published time, or the venue default when the registry has no
  // time for it. It is never left unset while the basis is the venue's, because "we know the venue's
  // rate but not its clock" would silently restore the midnight count under a v3-venue label.
  //
  // VERSIONING: this changes every stored swap number that sits on the venue basis, so it is a
  // labelled change and not a silent one. Checked before shipping: ZERO stored BacktestRuns carried
  // `v3-venue`, so v3-venue can mean the whole venue basis (rates AND clock) without re-labelling
  // anything already on disk. A run that keeps the legacy midnight count keeps its older label too.
  const onVenueBasis = venueSpread != null || hasFunding;
  const clockFromRegistry = basis ? fundingMinuteFromText(basis.fundingTime) : null;
  const swapClockMinuteUtc = onVenueBasis
    ? (clockFromRegistry == null ? DEFAULT_FUNDING_MINUTE_UTC : clockFromRegistry)
    : null;
  return {
    cfdSpreadPct: spread == null ? DEFAULTS.cfdSpreadPct : spread,
    cfdSlippagePct: CALIBRATED_SLIP_PCT,
    ...(venueBuy != null ? { cfdSwapBuyPct: venueBuy } : {}),
    ...(venueSell != null ? { cfdSwapSellPct: venueSell } : {}),
    cfdSwapClockMinuteUtc: swapClockMinuteUtc,
    costModelVersion: onVenueBasis ? COST_MODEL_VERSION_VENUE : (usedDerived ? COST_MODEL_VERSION_DERIVED : COST_MODEL_VERSION),
    costModelBasis: {
      // The label must describe WHERE THE NUMBER CAME FROM, which is what TRD-79 was raised about. Three
      // origins are now distinguishable: a live capture, a curated table entry, and a value computed from
      // stored ticks. `calibrated_table` is the fourth: a curated entry whose symbol has NO reachable
      // two-sided tick history (Ethereum/Solana/BNB/SHEIN/PAX Gold at 2026-09-21), so the number cannot
      // be checked against anything — it is a decision, and it says so. That relabel happens ONLY for an
      // audited process (the seeder read the ticks and said which symbols it could not verify); without
      // that audit the labels are exactly as they were.
      spread: venueSpread != null ? 'venue_open_market'
        : curated != null
          ? (SPREAD_DERIVATION.provenance && SPREAD_DERIVATION.unverifiable.has(symbol) ? 'calibrated_table' : 'tick_history_p75')
          : usedDerived ? 'tick_history_p75_derived'
            : 'flat_default',
      // The SIZE of the derivation, when the derivation is what priced the symbol: "a p75 of n two-sided
      // ticks over the window". Provenance that cannot say how thin the sample was is how a thin sample
      // becomes a permanent constant.
      ...(usedDerived && derived.n != null ? { spreadSample: derived.n } : {}),
      funding: hasFunding ? 'venue_per_side' : 'flat_placeholder',
      swapClock: onVenueBasis
        ? (clockFromRegistry == null ? 'venue_time_default' : 'venue_funding_time')
        : 'utc_midnight',
    },
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }
const round2 = (n) => Math.round(n * 100) / 100;

// TRD-49: the basis label must describe the clock that ACTUALLY runs, not the one the registry
// suggested. A caller can override `cfdSwapClockMinuteUtc` deliberately (a what-if, or the A/B that
// produced this change's own evidence) — and the first version of this shipped a run whose rows were
// counted on MIDNIGHT while its provenance still said `venue_funding_time`, because the label came
// from `costCfgFor` and the override came afterwards. A stored run whose meaning changed without its
// label changing is the defect this repo has already paid for once (the TRD-25 double-count erratum),
// so the label is derived from the final cfg rather than from the layer that proposed the default.
function swapClockBasisOf(cfg) {
  if (!cfg || cfg.cfdSwapClockMinuteUtc == null) return 'utc_midnight';
  const declared = cfg.costModelBasis && cfg.costModelBasis.swapClock;
  return declared === 'venue_time_default' ? 'venue_time_default' : 'venue_funding_time';
}

// Seeded PRNG (mulberry32) so MC runs are reproducible when a seed is given.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Monte Carlo over the CFD cost model: each trial jitters spread/slippage/swap
// around the base values and re-runs the worksheet. Same trade stream, many
// plausible cost worlds -> a P&L DISTRIBUTION instead of one number.
function monteCarlo(rawTrades, cfg, { trials = 200, seed = null } = {}) {
  const rng = mulberry32(seed == null ? Math.floor(Math.random() * 2 ** 31) : Number(seed));
  const usedSeed = seed == null ? null : Number(seed);
  const jitter = (base, factor) => base * (0.5 + rng() * factor); // uniform ±
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const nets = [];
  const dds = [];
  const winRates = [];
  const pfs = [];
  for (let t = 0; t < trials; t++) {
    const trialCfg = {
      ...c,
      cfdSpreadPct: jitter(c.cfdSpreadPct, 1.0),   // 0.5x..1.5x
      cfdSlippagePct: jitter(c.cfdSlippagePct, 1.5), // 0.5x..2.0x
      cfdSwapDailyPct: jitter(c.cfdSwapDailyPct, 1.0),
      // Phase 2: jitter the per-side rates too, or an MC run against a venue-based basis would report
      // a certainty about carry that the flat dial's jitter implies it does not have. Both sides get
      // the SAME multiplier per trial, because they are two statements of one instrument's funding
      // curve — jittering them independently would fabricate a spread between them.
      ...(Number.isFinite(Number(c.cfdSwapBuyPct)) ? { cfdSwapBuyPct: jitter(c.cfdSwapBuyPct, 1.0) } : {}),
      ...(Number.isFinite(Number(c.cfdSwapSellPct)) ? { cfdSwapSellPct: jitter(c.cfdSwapSellPct, 1.0) } : {}),
      spotFeePct: jitter(c.spotFeePct, 1.0),
    };
    const m = worksheet(rawTrades, trialCfg, 'cfd').metrics;
    nets.push(m.netPnl);
    dds.push(m.maxDrawdownPct);
    winRates.push(m.winRate);
    if (m.profitFactor != null) pfs.push(m.profitFactor);
  }
  const pct = (arr, q) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(q * (arr.length - 1))));
    return round4(sorted[idx]);
  };
  const mean = (arr) => round4(arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length));
  return {
    trials, seed: usedSeed,
    netPnl: { p5: pct(nets, 0.05), p25: pct(nets, 0.25), p50: pct(nets, 0.5), p75: pct(nets, 0.75), p95: pct(nets, 0.95), mean: mean(nets) },
    maxDrawdownPct: { p50: pct(dds, 0.5), p95: pct(dds, 0.95), worst: pct(dds, 0.99) },
    winRate: { p5: pct(winRates, 0.05), p50: pct(winRates, 0.5), p95: pct(winRates, 0.95) },
    profitFactor: { p50: pct(pfs, 0.5), p95: pct(pfs, 0.95) },
    jittered: { spread: '0.5x-1.5x', slippage: '0.5x-2.0x', swap: '0.5x-1.5x' },
  };
}

// Run the Turtle strategy over bars (oldest -> newest). Returns raw trades
// (mid prices) + equity curve; cost models are applied afterwards so the
// signal stream is identical for both worksheets.
// ATR/ADX are computed INCREMENTALLY (Wilder smoothing, identical math to
// indicators.js) so multi-year ranges stay O(n) instead of O(n^2).
// TRD-10: runTurtle now delegates to the strategy registry (turtleUltimate)
// so backtests and live quant share ONE implementation.

// Apply a cost model to the raw (mid) trades -> worksheet rows + metrics.
// Row prices stay at MID; all cost is charged once, itemized on `costs`.
// ERRATUM 2026-09-10: until this date spread+slippage were applied TWICE for
// the cfd model — once by shifting entry/exit prices and again through the
// costs line — so every stored worksheetCfd row, netPnl, PF and downstream
// p-value produced before the fix sits on a cost basis roughly 2x the
// parameter values (0.60% vs 0.30% round trip at defaults). Do not compare
// cfd-basis numbers across the fix line.
function worksheet(trades, cfg, model) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const rows = trades.map((t) => {
    const notional = t.size * t.entryPrice;
    let costs;
    if (model === 'cfd') {
      const spreadSlip = t.entryPrice * ((c.cfdSpreadPct + c.cfdSlippagePct) / 100) * t.size * 2; // entry + exit side
      // Phase 2: the night's cost depends on WHICH SIDE is held — Gold spot's buy side pays 2.7x the
      // sell side, and an option pays nothing at all. Charging one flat number to both sides of every
      // instrument is the mispricing this replaces.
      const swap = notional * (swapPctFor(c, t.direction) / 100) * t.nights;
      const fee = notional * (c.cfdFeePct / 100) * 2;
      costs = round4(spreadSlip + swap + fee);
    } else {
      costs = round4(notional * (c.spotFeePct / 100) * 2);
    }
    const pnl = t.direction === 'buy' ? (t.exitPrice - t.entryPrice) * t.size : (t.entryPrice - t.exitPrice) * t.size;
    return {
      direction: t.direction, size: t.size,
      entryTime: t.entryTime, exitTime: t.exitTime,
      entryPrice: round4(t.entryPrice), exitPrice: round4(t.exitPrice),
      nights: t.nights, costs, grossPnl: round4(pnl), netPnl: round4(pnl - costs), reason: t.reason,
    };
  });
  const nets = rows.map((r) => r.netPnl);
  const wins = rows.filter((r) => r.netPnl > 0);
  const losses = rows.filter((r) => r.netPnl < 0);
  let equity = c.capital;
  let peak = equity;
  let maxDD = 0;
  for (const r of rows) {
    equity += r.netPnl;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = round4(dd);
  }
  const grossWin = wins.reduce((s, r) => s + r.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.netPnl, 0));
  return {
    metrics: {
      trades: rows.length,
      netPnl: round4(nets.reduce((s, n) => s + n, 0)),
      winRate: rows.length ? Math.round((wins.length / rows.length) * 100) : 0,
      profitFactor: grossLoss > 0 ? round4(grossWin / grossLoss) : rows.length ? null : null,
      avgWin: wins.length ? round4(grossWin / wins.length) : 0,
      avgLoss: losses.length ? round4(-grossLoss / losses.length) : 0,
      maxDrawdownPct: maxDD,
      finalCapital: round4(equity),
    },
    rows,
  };
}

// Valid backtest ranges + their lookback (days) and minimum bar needs.
const RANGES = {
  '1w': { days: 7 },
  '1m': { days: 31 },
  '1y': { days: 366 },
};

async function loadSeries(userId, { symbol, venue = 'plus500', timeframe = '1h', range = null, refreshData = true } = {}) {
  const rangeSpec = RANGES[range] || null;
  const cutoff = rangeSpec ? new Date(Date.now() - rangeSpec.days * 86400000) : null;
  const load = async (limit) => {
    const rows = await store.listBars(userId, { timeframe, symbol, venue, limit });
    return cutoff ? rows.filter((b) => new Date(b.barStart) >= cutoff) : rows;
  };
  let bars = await load(12000);
  let backfilled = null;
  const isProvider = venue !== 'plus500';
  if (isProvider) {
    // Bars the chosen range needs (rough): 15m=96/day, 1h=24/day, 4h=6/day, 1d=1/day.
    const wantBars = rangeSpec
      ? rangeSpec.days * (timeframe === '15m' ? 96 : timeframe === '1h' ? 24 : timeframe === '4h' ? 6 : 1)
      : 300;
    if (bars.length < 25 || (refreshData && bars.length < wantBars)) {
      // Pull public history on demand (incremental — only the missing tail).
      backfilled = await require('./providers').backfillBars(userId, {
        provider: venue, symbol, timeframe,
        rangeDays: rangeSpec ? rangeSpec.days : null,
        limit: rangeSpec ? 12000 : 300,
      });
      bars = await load(12000);
    }
  }
  const series = bars.map((b) => ({ open: b.openPrice, high: b.high, low: b.low, close: b.closePrice, time: b.barStart }));
  if (series.length < 25) {
    const extra = isProvider ? (backfilled && backfilled.error ? ` (${backfilled.error})` : ' (no provider history)') : '';
    return { error: `insufficient bars (${series.length} < 25) for ${symbol} ${venue}${extra}` };
  }
  const spanDays = Math.round((new Date(bars[bars.length - 1].barStart) - new Date(bars[0].barStart)) / 86400000 * 10) / 10;
  const rangeNote = rangeSpec && spanDays < rangeSpec.days * 0.9
    ? `${range} requested but ${timeframe} data spans only ${spanDays} days (${venue} ${timeframe} history limit)`
    : null;
  return { series, bars, backfilled, rangeNote, spanDays };
}

async function runBacktest(userId, { symbol, venue = 'plus500', timeframe = '1h', config = {}, label = null, range = null } = {}) {
  const cfg = { ...DEFAULTS, ...costCfgFor(symbol), ...(config || {}) };
  // TRD-11: per-run param overrides (Backtest tab strategy editor) — flatten
  // config.params onto cfg so paramsWith() picks them up.
  if (config.params && typeof config.params === 'object') Object.assign(cfg, config.params);
  // TRD-49: settle the clock label against the FINAL cfg, before anything reads it. Everything
  // downstream — the strategies' night counts, the worksheet's swap line, the stored provenance and
  // the returned config — then describes one clock instead of two.
  cfg.costModelBasis = { ...(cfg.costModelBasis || {}), swapClock: swapClockBasisOf(cfg) };
  const refreshData = cfg.refreshData !== false; // true = re-pull latest window before running
  const loaded = await loadSeries(userId, { symbol, venue, timeframe, range, refreshData });
  if (loaded.error) return loaded;
  const { series, bars, backfilled, rangeNote, spanDays } = loaded;

  // TRD-13: Strategy Lab harness — completed k-bar blocks + bar-causal
  // regime flags (+ an optional ratio series when cfg.lab.ratioSymbol is
  // set), passed to strategy.backtest as the third argument. Classic
  // strategies ignore it; LAB candidates consume it.
  const labCfg = cfg.lab || {};
  let labCtx = null;
  if (labCfg.enabled !== false) {
    let ratioBars = null;
    if (labCfg.ratioSymbol && labCfg.ratioSymbol !== symbol) {
      const other = await loadSeries(userId, { symbol: labCfg.ratioSymbol, venue, timeframe, range, refreshData });
      if (other.series && other.series.length >= 25) ratioBars = other.series;
    }
    labCtx = require('./lab').labContext(series, { k: labCfg.k || 4, ratioBars });
  }

  const raw = (() => {
    const strategyId = String(cfg.strategy || 'turtle');
    const strat = strategies.get(strategyId);
    return strat && strat.backtest ? strat.backtest(series, cfg, labCtx) : runTurtle(series, cfg);
  })();
  const strategyId = String(cfg.strategy || 'turtle');
  const spot = worksheet(raw.trades, cfg, 'spot');
  const cfd = worksheet(raw.trades, cfg, 'cfd');

  const mc = cfg.monteCarlo
    ? monteCarlo(raw.trades, cfg, { trials: Math.min(Math.max(Number(cfg.monteCarloTrials) || 200, 10), 2000), seed: cfg.monteCarloSeed ?? null })
    : null;

  // TRD-12 Phase 3: buy-and-hold benchmark over the same series (the simplest
  // baseline the strategy must beat) + optional walk-forward (train/test
  // split, out-of-sample P&L over the later segments).
  const benchmark = (() => {
    const closes = series.map((b) => Number(b.close)).filter((v) => Number.isFinite(v) && v > 0);
    if (closes.length < 2) return null;
    const pnlPct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
    return { pnlPct: +pnlPct.toFixed(2), bars: closes.length };
  })();

  const walkForward = cfg.walkForward ? (() => {
    const n = series.length;
    const seg = Math.max(25, Math.floor(n / 3));
    const segs = [];
    for (let i = 1; i < 3 && i * seg < n; i++) {
      const part = series.slice(i * seg);
      const strategyId = String(cfg.strategy || 'turtle');
      const strat = strategies.get(strategyId);
      // TRD-13: walk-forward segments get their own causal lab context.
      const partLab = labCtx ? require('./lab').labContext(part, { k: labCfg.k || 4 }) : null;
      const r2 = strat && strat.backtest ? strat.backtest(part, cfg, partLab) : runTurtle(part, cfg);
      const w = worksheet(r2.trades, cfg, 'cfd');
      segs.push({ from: part[0].time, to: part[part.length - 1].time, pnl: round2(w.metrics.netPnl), trades: r2.trades.length });
    }
    return { segments: segs, oosPnl: round2(segs.reduce((s, x) => s + x.pnl, 0)) };
  })() : null;

  const id = await store.createBacktestRun(userId, {
    strategy: strategyId,
    symbols: JSON.stringify([symbol]),
    periodStart: bars[0].barStart, periodEnd: bars[bars.length - 1].barStart,
    config: JSON.stringify({ ...cfg, label, range: range || 'all', venue, timeframe }),
    metrics: JSON.stringify({
      spot: spot.metrics, cfd: cfd.metrics,
      benchmark: benchmark || null,
      walkForward: walkForward || null,
      monteCarlo: mc ? { trials: mc.trials, seed: mc.seed, netPnlP50: mc.netPnl.p50, netPnlP5: mc.netPnl.p5, netPnlP95: mc.netPnl.p95, ddP50: mc.maxDrawdownPct.p50, ddP95: mc.maxDrawdownPct.p95 } : null,
      raw: { trades: raw.trades.length, maxDrawdown: raw.maxDrawdown, finalCapitalMid: raw.finalCapital },
    }),
    worksheetSpot: JSON.stringify(spot),
    worksheetCfd: JSON.stringify(cfd),
    provenance: JSON.stringify({
      source: `pricebars ${venue} ${timeframe}`, bars: bars.length,
      generatedAt: new Date().toISOString(),
      range: range || 'all', refreshData, backfilled: backfilled ? backfilled.bars || backfilled.error || null : null,
      rangeNote, spanDays,
      lab: labCtx ? { k: labCtx.k, blocks: labCtx.blocks.length, ratioSymbol: labCfg.ratioSymbol || null, ratioBars: labCtx.ratio ? labCtx.ratio.length : 0 } : null,
      monteCarlo: mc ? { trials: mc.trials, seed: mc.seed } : null,
      costModel: {        version: cfg.costModelVersion || 'v1-flat',        spot: { feePctPerSide: cfg.spotFeePct },
        cfd: { spreadPct: cfg.cfdSpreadPct, slippagePct: cfg.cfdSlippagePct, swapDailyPct: cfg.cfdSwapDailyPct, feePct: cfg.cfdFeePct,
          // Phase 2 provenance: WHICH basis each number came from, and the per-side rates when the
          // venue supplied them. A stored run must be able to say whether its carry was the venue's
          // own per-instrument, per-side funding or the flat placeholder — otherwise two runs with
          // materially different costs look identical after the fact.
          swapBuyPct: cfg.cfdSwapBuyPct != null ? cfg.cfdSwapBuyPct : null,
          swapSellPct: cfg.cfdSwapSellPct != null ? cfg.cfdSwapSellPct : null,
          // TRD-49: the UTC minute-of-day the `nights` on every row below were counted against, and
          // the basis that chose it. Without this a v3-venue run is unreadable: two runs of the same
          // symbol can differ ONLY by which clock counted their nights, and the swap line is where
          // that difference lands.
          swapClockMinuteUtc: cfg.cfdSwapClockMinuteUtc != null ? cfg.cfdSwapClockMinuteUtc : null,
          basis: cfg.costModelBasis || null,
          venueBasisSymbols: Object.keys(VENUE_BASIS).length },
      },
      exDividend: 'normalization out of scope; CorporateEvents halts applied at session level',
    }),
  });

  const chartSeries = series.slice(-600);
  return {
    id, symbol, venue, bars: bars.length, range: range || 'all', refreshData, backfilled, rangeNote, spanDays, monteCarlo: mc, strategy: strategyId,
    benchmark: benchmark || null,
    walkForward: walkForward || null,
    period: { from: bars[0].barStart, to: bars[bars.length - 1].barStart },
    metrics: { spot: spot.metrics, cfd: cfd.metrics },
    worksheetSpot: spot.rows.slice(-30),
    worksheetCfd: cfd.rows.slice(-30),
    chart: {
      times: chartSeries.map((b) => b.time),
      closes: chartSeries.map((b) => round4(b.close)),
      markers: cfd.rows
        .filter((r) => chartSeries.some((b) => b.time === r.entryTime))
        .map((r) => ({ entryTime: r.entryTime, entryPrice: r.entryPrice, direction: r.direction, exitTime: r.exitTime, exitPrice: r.exitPrice, netPnl: r.netPnl })),
    },
    config: cfg,
  };
}

module.exports = { runBacktest, sweep, runTurtle, worksheet, monteCarlo, loadSeries, DEFAULTS, RANGES, costCfgFor, COST_MODEL_VERSION, CALIBRATED_SPREAD_HALF_PCT, COST_MODEL_VERSION_VENUE, COST_MODEL_VERSION_DERIVED, setVenueCostBasis, getVenueCostBasis, setSpreadDerivation, getSpreadDerivation, swapPctFor, swapClockBasisOf };

// TRD-11: parameter sweep — "backtest the strategy across a grid, and only
// the profitable variants are shown up top". Deterministic, no LLM, capped.
async function sweep(userId, { symbol, venue = 'plus500', timeframe = '1h', config = {}, range = null } = {}) {
  const cfg = { ...DEFAULTS, ...costCfgFor(symbol), ...(config || {}) };
  // Same TRD-49 normalisation as runBacktest. The strategies read the clock straight off cfg, so a
  // sweep is already numerically correct without this — but a sweep that is never labelled today is a
  // sweep that gets labelled tomorrow, and the bug this line fixes was a label that outlived its value.
  cfg.costModelBasis = { ...(cfg.costModelBasis || {}), swapClock: swapClockBasisOf(cfg) };
  const strategy = String(config.strategy || 'turtle');
  const grid = config.grid || {};
  const loaded = await loadSeries(userId, { symbol, venue, timeframe, range, refreshData: cfg.refreshData !== false });
  if (loaded.error) return loaded;
  const strat = strategies.get(strategy);
  if (!strat || !strat.backtest) return { error: `strategy ${strategy} has no backtest` };
  const base = { ...cfg };
  delete base.grid; delete base.strategy; delete base.params;
  const axes = Object.entries(grid).filter(([, v]) => Array.isArray(v) && v.length);
  if (!axes.length) return { error: 'grid empty — send {config:{grid:{param:[v1,v2,...]}}}' };
  const combos = [];
  const walk = (i, acc) => {
    if (i === axes.length) { combos.push({ ...acc }); return; }
    const [k, vals] = axes[i];
    for (const v of vals.slice(0, 6)) walk(i + 1, { ...acc, [k]: Number(v) });
  };
  walk(0, {});
  if (combos.length > 40) return { error: `grid too large (${combos.length} combos > 40 — narrow the grid)` };
  const runs = combos.map((params) => {
    const runCfg = { ...base, ...params };
    const raw = strat.backtest(loaded.series, runCfg);
    const m = worksheet(raw.trades, runCfg, 'cfd').metrics;
    return { params, trades: m.trades, netPnl: m.netPnl, winRate: m.winRate, profitFactor: m.profitFactor, maxDrawdownPct: m.maxDrawdownPct };
  }).sort((a, b) => b.netPnl - a.netPnl);
  const profitable = runs.filter((r) => r.netPnl > 0);
  return {
    symbol, venue, timeframe, range: range || 'all', strategy,
    bars: loaded.bars.length, combos: runs.length, profitable: profitable.length,
    note: 'profitable variants first — nothing here is auto-applied to the live strategy',
    best: runs[0] || null,
    runs,
  };
}
