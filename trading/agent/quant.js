// trading/agent/quant.js — deterministic signal engine (amendment A2).
// Turtle Ultimate core (locked spec): Donchian-20 breakout iff ADX(14) > 20;
// 2xATR(14) trailing stop; position size = capital*1%/(2*ATR). All math is
// deterministic code — instant, zero tokens. The LLM only interprets context.
'use strict';

const { atr, adx, donchian, sma, ema, bollinger, rsi, macd, stochastic, roc, momentum, cci, williamsR, aroon, obv } = require('./indicators');
const store = require('../store');
const strategies = require('./strategies');
// TRD-116 (2026-09-25): THE SCOPE RULE MOVED OUT OF THIS FILE, because it lived in four places and two of
// them disagreed with this one. `scopedStrategyIds` and `symbolEligible` below are now thin delegations, so
// the resolver the desk TRADES on and the resolver every check JUDGES it with cannot drift apart again.
const scopeResolution = require('../scopeResolution');
const lab = require('./lab'); // TRD-13: Strategy Lab harness
const labGate = require('./lab/gate'); // TRD-71: live-eligibility gate (OBSERVE mode)
const venueAdmission = require('./venueAdmission'); // C3: the cached substitute-venue verdict
const { computeStructure, DEFAULTS: STRUCTURE_DEFAULTS } = require('./structure'); // S1b: market structure as CONTEXT — NO CONSUMER YET (design doc §12 S1)
const { computeActivity } = require('./activity'); // S2: the VOLUME-FREE activity measure (§6 P2 item 1) — no consumer yet

// Provider venues in preference order for the 1h indicator snapshot (real
// OHLC beats tick-derived bars). Falls back to plus500 bars.
const IND_VENUE_PREF = ['yahoo', 'binance', 'okx', 'plus500_chart', 'plus500'];

// ★ WHAT INTERVAL DID THIS ROW'S BAR ACTUALLY COME FROM? (design doc §4.1, revision 5)
// This is the SECOND provenance defect in the chart capture, and it is why every structure result carries
// `basis.sourceIntervalSec`. `capture.bankChartBars` maps {900:'15m', 1800:'1h', 3600:'1h', 14400:'4h',
// 86400:'1d'} and FALLS THROUGH to '1h' for anything unmapped — so a 30-MINUTE chart is stored as "1h",
// two 30m bars to a bucket, and `PriceBars` has no column that says so. tfMap maps BOTH 1800 and 3600 to
// '1h', which means the stored timeframe ALONE cannot distinguish the two provenances.
//
// This map states what is knowable BY CONSTRUCTION and null (i.e. "not vouched for") everywhere else —
// a field left null is a finding, not a gap, because §3 requires every structure fact to carry its basis.
//
// ★★ SUPERSEDED AS THE SOURCE OF TRUTH BY MIGRATION 043. `PriceBars.sourceIntervalSec` now records the
// interval EACH ROW was built from, and `evaluateSymbol` below prefers the recorded value over this map.
// What survives here is a fallback for rows written before 043, whose provenance was never recorded. A
// declaration that cannot be falsified was the weakest link in this basis; a recorded value can be checked
// against the bar it sits on.
const SOURCE_INTERVAL_BY_VENUE = Object.freeze({
  plus500: 3600,       // store/bars.js upsertHourlyBars buckets on the SQL HOUR — 1h by construction
  plus500_chart: null, // the chart capture's interval is a property of the CHART, not the venue — unknown
});

// ★★ WHICH SERIES OWNS STRUCTURE? (settled 2026-09-22 — the venue half of §10 residual Q1)
//
// `VENUE_OF_RECORD` is the venue the desk TRADES at, and that venue is stored from TWO different paths:
//   `plus500`       — `upsertHourlyBars` builds each hour from MAX(mid)/MIN(mid) over the ~3-6 ticks the
//                     wake happened to capture. That is a SAMPLE of the hour, so its high/low sit INSIDE
//                     the hour's true range. Mean 1h range on Gold: 7.539 (17.3 bps).
//   `plus500_chart` — the venue's OWN chart series (`capture.bankChartBars` <- ChartIQ masterData), i.e.
//                     the venue's aggregation of its own feed. Mean 1h range on Gold: 17.239 (40.1 bps).
//
// "The range is bigger" cannot decide it — a wrong series can have a bigger range. Three measurements do
// (`trading/scripts/repro/venue-fidelity-audit.js`):
//   1. ★ THE DISCRIMINATING TEST — IF IT IS A SAMPLE, THE SHORTFALL MUST SHRINK AS THE SAMPLE GROWS, and
//      there is no other way for it to behave. Hours bucketed by how many ticks the desk captured in them;
//      ratio = tick range / chart range:
//        Gold    1-2 ticks 0.08 | 3-5 0.10 | 6-9 0.32 | 10+ 0.67
//        Oil     0.10 / 0.12 / 0.32 / 0.61     Silver  0.09 / 0.05 / 0.26 / 0.66
//        Bitcoin 0.02 / 0.09 / 0.31 / 0.59     Sugar   0.17 / 0.05 / 0.35 / 0.54
//      Monotone on every symbol, and the share of hours where the tick high sits BELOW the chart high falls
//      from 100% to 57-75% as ticks accumulate. This is self-contained: it compares the venue's two series
//      to each other and needs no third party.
//   2. CONTAINMENT. Over all overlapping hours the tick high sits below the chart high in 86% (Gold) and the
//      tick low above the chart low in 99% — one-sided, which is what a subsample does.
//   3. SAME PRICE. Same-hour closes differ by -1.30 bps (Gold), +1.17 (Oil), -3.89 (Silver), -6.05
//      (Bitcoin), all |mean|/sd <= 0.24. No level offset, so this substitution moves the EXTREMES without
//      moving the price. It is still the venue the desk trades at (option A), read FROM the venue rather
//      than sampled from it.
//
// ★★ A THIRD-PARTY CORROBORATION WAS CLAIMED HERE AND IS WITHDRAWN — THE MEASUREMENT REFUTED IT. Comparing
// yahoo's Gold range against the tick series' across DIFFERENT WINDOW LENGTHS made the tick series look like
// the outlier (17 bps against ~41). Restricted to the SAME HOURS, yahoo agrees with the TICK series — Gold
// 17.1 vs 18.5 bps with the chart at 41.7; Oil 37.1 vs 35.9 vs 87.8; Silver 27.8 vs 26.7 vs 68.5 — i.e. the
// third opinion pointed the OTHER way and is not evidence for this choice. It is not needed: test 1 settles
// the comparison within the venue. What the refutation LEAVES OPEN is recorded rather than buried: this
// venue's chart extremes are ~2.3-2.6x yahoo's over the same hours, which is either a genuinely different
// instrument behind yahoo's Gold, or intraday quote excursions inside the venue's own chart. Unexplained —
// and it does not bear on which of the venue's two series to use.
//
// ⚠ RECORDED CAVEAT, deliberately not gated: on the HK/SG names (Wilmar -35.9 bps, CK Hutchison -30.2,
// SGX -40.0; 0% of hours chart>tick, |mean|/sd ~2) the two series are NOT the same price. Those symbols
// also carry the thinnest tick history (24-31 overlapping hours) and the desk does not trade them — but
// check `basis.venue` and `basis.venueWhy` before trusting a level on one.
const STRUCTURE_CHART_VENUE = 'plus500_chart';

// Pure, so the policy is pinned by a test instead of hiding inside a DB-bound block (the TRD-PRC-1 lesson:
// being inline is why the price-policy defect went unnoticed for 2.4 hours).
//
// `minBars` is REQUIRED and validated: an omitted one would make `chartBars >= undefined` false and
// silently select the fallback on every symbol — a substitution with no record anywhere, which is the
// class this desk keeps paying for.
function resolveStructureVenue({ configured, chartVenue, chartBars, minBars }) {
  const min = Number(minBars);
  if (!Number.isFinite(min) || min < 1) {
    throw new RangeError(`resolveStructureVenue: minBars must be a finite number >= 1 (got ${JSON.stringify(minBars)})`);
  }
  const n = Number(chartBars) || 0;
  if (n >= min) return { venue: chartVenue, why: 'chart_series_faithful', bars: n };
  return { venue: configured, why: n === 0 ? 'chart_series_absent' : 'chart_series_below_min_bars', bars: null };
}

function mid(t) { return ((t.ask ?? 0) + (t.bid ?? 0)) / 2 || (t.bid ?? 0) || 0; }

// TRD-PRC-1 (2026-09-14): CHOOSE THE PRICE. Pure, so the policy is pinned by tests and cannot
// hide inside a DB-bound loop — being inline is why it went unnoticed for 2.4 hours.
//
// ★★ THE FIRST VERSION OF THIS FIX WAS WRONG, AND THE MEASUREMENT THAT CAUGHT IT WAS THE
// SAME ONE THAT MOTIVATED IT. It preferred "a fresh tick from ANY venue", which on live data
// selected YAHOO for Gold and moved the price from the stale venue tick 4294.50 to 4312.90 —
// i.e. FURTHER from the venue's real quote, not closer:
//
//   newest Gold tick per venue, 2026-09-14 ~21:45 SGT   venue's own live quote: 4268.35
//     binance 4281.65 (149s)   okx 4281.30 (149s)   [agree with each other, ~13 off the venue]
//     yahoo   4312.80 (148s)                        [31 off binance/okx, 44 off the venue]
//     plus500 4294.50 (9088s, stale)
//
//   YAHOO'S "Gold" IS A DIFFERENT INSTRUMENT (a futures series, not spot). The same split is in
//   the bar history: 1h closes plus500 4294.5 / binance 4285.1 / okx 4284.95 vs yahoo 4312.9.
//   So "prefer the freshest venue" silently substituted another instrument, and on this data it
//   flipped the open Gold short's trailing stop (4305.97) to a FALSE HIT — the venue's real
//   4268.35 is 37 below that stop. A stale price of the right instrument beat a fresh price of
//   the wrong one, and the first version could not tell the difference.
//
// THE POLICY, and the reason for each rule:
//   1. THE VENUE OF RECORD WINS — fresh or stale. It is the only price the desk can execute at,
//      and it is the right instrument. A stale venue price is labelled, not replaced.
//   2. A SUBSTITUTE VENUE IS USED ONLY IF THE VENUE OF RECORD HAS NO TICK AT ALL. That is the
//      pre-existing behaviour ("fresh tick mid (any venue)"), kept, and now LABELLED — the caller
//      gets `substituted: true` plus the venue name, so a reader can never mistake it for the
//      executable price of the instrument being traded.
//   3. Among substitutes, fresh beats stale, and the least-stale wins. Freshness is only a
//      tie-breaker WITHIN substitutes, never a licence to replace the venue of record.
//
// NOT SETTLED HERE (recorded, not decided): whether these venues are even comparable is a
// per-symbol question this function cannot answer. binance/okx track spot Gold; yahoo does not.
// Fixing `VENUE_ORDER` alone would not have helped — yahoo is second in it. A real answer needs
// a comparability check measured from the desk's own bar history, and that is an owner decision
// because it changes the price the desk trades on.
//
// `candidates` is [{ venue, mid, capturedAt, ageMs }] in venue-preference order.
//
// C3 (2026-09-15): `allowedVenues` is the admission verdict, handed in as DATA so this function stays
// pure. Three-valued, and the distinction is the whole point:
//   * `null` / omitted  -> NOT GATED. Exactly the pre-existing behaviour, which is what the feature
//     being off means. A flag that is off must not change a single price.
//   * `[]`              -> gated, and NOTHING is admitted. A substitute is refused even though one is
//     fresh and available. This is the real case for Gold and Oil (see the B4 report), and it must
//     refuse rather than silently fall through to the old rule.
//   * `['binance', …]`  -> gated, and only those venues may substitute.
// The venue of record is unaffected either way: it is not a substitute.
function pickTick(candidates = [], { slaMs = TICK_SLA_MS, primary = null, allowedVenues = null } = {}) {
  const staleVenues = [];
  const usable = [];
  for (const c of candidates) {
    if (!c || !(c.mid > 0)) continue;               // a non-positive mid is not a price
    const ageMs = Number.isFinite(c.ageMs) ? c.ageMs : Infinity;
    const fresh = ageMs <= slaMs;
    if (!fresh) staleVenues.push({ venue: c.venue, ageMin: Math.round(ageMs / 60000) });
    usable.push({ ...c, ageMs, fresh });
  }
  const allSubs = primary ? usable.filter((c) => c.venue !== primary) : usable;
  const gated = allowedVenues != null;
  const allowed = gated ? allowedVenues.map(String) : null;
  const refused = gated ? allSubs.filter((c) => !allowed.includes(String(c.venue))).map((c) => c.venue) : [];
  const comparability = {
    gated,
    allowed: gated ? allowed : null,
    refused,
    // How many substitutes were available and usable but refused BY THE GATE - i.e. the decision
    // actually cost the desk something here, rather than there being nothing to choose.
    refusedUsable: refused.length,
  };
  // ★★ TRD-FED-1: CROSS-SOURCE DIVERGENCE, COMPUTED WHERE THE ALTERNATIVES ARE ALREADY IN HAND.
  //
  // The row's own finding was that Oil/Sugar/Brent show "a tight core with multi-percent spikes - the
  // signature of a feed going STALE, not of an offset", and that **the 09-24 spike is invisible in every
  // log the desk writes**: it was found by post-hoc analysis of `PriceTicks`, which is precisely the state
  // the acceptance item forbids — *"a divergence that is DETECTED and not LOGGED is still invisible to the
  // next investigation."*
  //
  // It was not logged because it was not DETECTED: `pickTick` chooses ONE candidate and never compares them
  // to each other. They are all right here. Comparing the FRESH ones costs nothing and is the detection.
  //
  // Measured thresholds for calibrating the caller: the 09-24 spike was 2.293% and the worst session
  // (2026-09-18) reached 5.124%, while ordinary venue disagreement is a fraction of a percent, so a ~1%
  // line separates the two populations. The number is returned, not judged here — this function picks a
  // price, it does not decide what is alarming.
  //
  // ⚠ Only FRESH candidates are compared. A stale quote is EXPECTED to disagree (that is what stale means),
  // and folding it in would report every ordinary outage as a divergence — drowning the signal the row is
  // about. Stale venues are already carried separately in `staleVenues`.
  const freshUsable = usable.filter((c) => c.fresh && c.mid > 0);
  let divergence = null;
  if (freshUsable.length >= 2) {
    let worst = null;
    for (let i = 0; i < freshUsable.length; i++) {
      for (let j = i + 1; j < freshUsable.length; j++) {
        const a = freshUsable[i], b = freshUsable[j];
        const lo = Math.min(a.mid, b.mid), hi = Math.max(a.mid, b.mid);
        if (!(lo > 0)) continue;
        const spreadPct = ((hi - lo) / lo) * 100;
        if (!worst || spreadPct > worst.spreadPct) {
          worst = { spreadPct, a, b };
        }
      }
    }
    if (worst) {
      divergence = {
        maxSpreadPct: +worst.spreadPct.toFixed(4),
        venues: [worst.a.venue, worst.b.venue],
        mids: [worst.a.mid, worst.b.mid],
        // How many pairs were compared, so a "no divergence" verdict cannot be read off an empty comparison.
        compared: (freshUsable.length * (freshUsable.length - 1)) / 2,
        freshVenues: freshUsable.length,
      };
    }
  }
  const shape = (c, { substituted, stale }) => ({
    mid: c.mid, venue: c.venue, capturedAt: c.capturedAt, ageMs: c.ageMs,
    stale, substituted, staleVenues, comparability, divergence,
    reason: substituted
      ? `no tick from the venue of record - price came from ${c.venue}${gated ? ', which the comparability gate admits' : ''}`
      : (stale ? 'venue of record tick older than the SLA' : null),
  });

  // Rule 1: the venue of record, whatever its age.
  if (primary) {
    const p = usable.find((c) => c.venue === primary);
    if (p) return shape(p, { substituted: false, stale: !p.fresh });
  } else {
    // No venue of record named: fall back to pure freshness among the candidates given.
    const firstFresh = usable.find((c) => c.fresh);
    if (firstFresh) return shape(firstFresh, { substituted: false, stale: false });
  }

  // Rules 2 + 3: substitutes only. Fresh first, then the least stale.
  const subs = gated ? allSubs.filter((c) => allowed.includes(String(c.venue))) : allSubs;
  const freshSub = subs.find((c) => c.fresh);
  if (freshSub) return shape(freshSub, { substituted: true, stale: false });
  const bestStale = subs.reduce((best, c) => (!best || c.ageMs < best.ageMs ? c : best), null);
  if (bestStale) return shape(bestStale, { substituted: true, stale: true });

  return {
    mid: null, venue: null, capturedAt: null, ageMs: null, stale: false, substituted: false,
    staleVenues, comparability, divergence,
    // NAMED, not generic: "no tick from any venue" would be false when a usable substitute existed
    // and the gate refused it, and a reader must be able to tell the two apart.
    reason: gated && refused.length
      ? `no tick from the venue of record, and the comparability gate admits no substitute (refused: ${refused.join(', ')})`
      : 'no tick from any venue',
  };
}

// TRD-12 Phase 0: staleness SLA — a series older than this is NOT tradable.
const TICK_SLA_MS = 15 * 60000;
// Minimum 1h bar count for the SIGNAL series (implied goal #1).
const MIN_BARS = 30;
// The Plus500 stock-chart series (1h bars) stays "fresh" up to 4h; the
// signal series (1h bars) uses the same window.
const BAR_FRESH_MS = 4 * 3600000;

// Trailing-stop context for an open position: its peak/trough along its OWN
// path — the entry price plus closes AFTER entry, never before it.
//
// 2026-09-12 BUG FIX. This used to be inline and read
//     const src = since.length >= 5 ? since : bars;
// i.e. whenever fewer than 5 bars had elapsed since entry — any position
// younger than ~5 hours on the 1h signal series, which is MOST positions — it
// fell back to the ENTIRE bar history, including prices from before the
// position existed. `peak` then became the highest close of the whole lookback
// window, so for a long entered below the recent high the trail
// (`peak - atrStopMultiple * atr`) sat ABOVE the market and the exit rule fired
// instantly, on a stop the price had never reached.
//
// Evidence (2026-09-11): trades 1031, 1032 and 1028 were all closed by
// "executor close" within 25-60 min of entry, each quoting a 2xATR trailing
// stop of ~102.8-102.9 on Oil while the position's own best price was 99.4-100.1
// — an implied peak of ~104.2, which is Oil's PRE-ENTRY high. The desk's own
// exit logic therefore looked worse than the venue TP on both axes (it capped a
// winner at 65% of the available move and closed it on a phantom level).
//
// Seeding from the entry price is also what the backtester does
// (`pos = { ..., peak: closes[i], trough: closes[i] }` in turtleUltimate), so
// this restores live<->backtest parity rather than departing from it.
function openPositionContext(bars, pos) {
  if (!pos || pos.openPrice == null || pos.openAt == null) return null;
  const open = Number(pos.openPrice);
  if (!Number.isFinite(open)) return null;
  const openMs = new Date(pos.openAt).getTime();
  let peak = open, trough = open;
  for (const b of bars || []) {
    if (new Date(b.barStart).getTime() < openMs) continue; // never pre-entry
    const c = Number(b.closePrice);
    if (!Number.isFinite(c)) continue;
    if (c > peak) peak = c;
    if (c < trough) trough = c;
  }
  return { direction: pos.direction, peak, trough };
}

// Evaluate one watchlist symbol through the ENABLED strategies (TRD-10
// registry). IMPLIED GOAL #1: signals run on the 1h BAR series — the same
// data the backtester consumes — so live and backtest measure the same thing.
// Tick mids are used ONLY for the latest executable price and the
// stop/take-profit checks. Exits win over entries (risk reduction first),
// then strategy order.
async function evaluateSymbol(userId, { symbol, venue }, openTrades, strategyIds, settings, opts = {}) {
  let bars = []; let used = null;
  // ⚠⚠ WHEN NOTHING REACHES THE THRESHOLD, REPORT THE BEST SERIES SEEN - NOT THE WATCHLIST ROW'S OWN.
  // The old code only recorded a series on SUCCESS, so a symbol under the threshold fell through to
  // `listBars(...venue)`, which can be the WORST series of the lot. Measured 2026-09-30: Natural Gas has 18
  // hourly bars on plus500_chart and 6 on plus500, so a reader was shown "6 of 30" when 18 were available -
  // a shortfall three times the real one, and the difference between waiting a wake and giving up. Below the
  // threshold that number is the ONLY thing the desk can offer, so it has to be the best one it has.
  let best = []; let bestVenue = null;
  for (const v of IND_VENUE_PREF) {
    const rows = (await store.listBars(userId, { timeframe: '1h', symbol, venue: v, limit: 300 })) || [];
    if (rows.length > best.length) { best = rows; bestVenue = v; }
    if (rows.length >= MIN_BARS) { bars = rows; used = v; break; }
  }
  if (!bars.length) {
    const own = (await store.listBars(userId, { timeframe: '1h', symbol, venue, limit: 300 })) || [];
    // `used` stays null for the symbol's OWN series so that provenance is unchanged there; when a DIFFERENT
    // venue's series is the better one, provenance names that venue, because that is where the bars came from.
    if (own.length >= best.length) { bars = own; } else { bars = best; used = bestVenue; }
  }
  const lastBar = bars.length ? bars[bars.length - 1] : null;
  const barAgeSec = lastBar ? Math.round((Date.now() - new Date(lastBar.barStart).getTime()) / 1000) : null;
  const status = bars.length >= MIN_BARS ? (barAgeSec != null && barAgeSec <= BAR_FRESH_MS / 1000 ? 'ok' : 'stale') : 'insufficient_data';

  // Latest executable price: fresh tick mid (any venue), else last bar close.
  //
  // ★ THE PRICE PATH SILENTLY PRICED THE WHOLE DESK FROM A DEAD VENUE FEED — FOUND LIVE
  // 2026-09-14 21:36 SGT while adding the provenance below.
  //
  // The old loop was:
  //     if (m > 0 && ageMs <= TICK_SLA_MS) { tickPx = m; ... }
  //     if (tickPx == null && m > 0)       { tickPx = m; }   // accept ANY age
  //     if (tickPx != null) break;                            // ...AND STOP LOOKING
  //
  // So the FIRST venue with any tick won, however old, and the loop ended. Measured that
  // evening: the plus500 tick feed had been dead since 11:10:27 UTC (19:10 SGT, 2h26m) for
  // EVERY symbol — the shared page had stopped rendering the trade view, 13 consecutive
  // selector failures tripped the UI Fallback Pause, and plus500 capture read `captured: 0`.
  // The provider feeds were 6 minutes old and were never consulted, because plus500 answered
  // first with a 2.4-hour-old quote.
  //
  // Gold: plus500 (stale) 4294.50 vs yahoo (fresh) 4312.90 — 18.4 points apart with ATR14 at
  // 12.03, so the desk quoted a price 1.5x ATR from the market for 2.4 hours. The open Gold
  // short #1037 (sell @4281.90) was flagged at floatingPnl +4.56 while the true price put it
  // about 11.6 DOWN, and at the true price its own 2xATR trailing stop (4305.97) is HIT. The
  // desk was holding a position past its stop because of this `break`.
  //
  // ★ THE PRICE PATH SILENTLY PRICED THE WHOLE DESK FROM A DEAD VENUE FEED — FOUND LIVE
  // 2026-09-14 21:36 SGT while adding the provenance fields below.
  //
  // The plus500 tick feed had been dead since 11:10:27 UTC (19:10 SGT, 2h26m): the shared page
  // had stopped rendering the trade view, 13 consecutive selector failures tripped the UI
  // Fallback Pause, and plus500 capture read `captured: 0`. Gold was quoted at 4294.50 while
  // the venue's own live quote was 4268.35.
  //
  // ★ THE REPAIR IS TO RESTORE THE VENUE'S OWN FEED, NOT TO SUBSTITUTE ANOTHER VENUE. The first
  // version of this fix preferred "a fresh tick from any venue" and selected YAHOO for Gold,
  // moving the price to 4312.90 — FURTHER from the venue, because yahoo's "Gold" is a different
  // instrument. See pickTick() for that measurement; it also flipped the open Gold short's
  // trailing stop to a false hit. Navigating the shared page back onto the trade view
  // (POST /watchlist/open) restores plus500 capture, which is the price that is both fresh AND
  // the right instrument.
  //
  // So what this block adds is PROVENANCE AND LABELLING, not a new price source:
  //   * the tick's real timestamp is kept (it used to be computed, used for the freshness
  //     test, and then THROWN AWAY, with `latest.capturedAt` stamped with the BAR's barStart);
  //   * pickTick states which venue answered, whether it was stale, and whether it was a
  //     SUBSTITUTE for the venue of record.
  const VENUE_ORDER = ['plus500', 'yahoo', 'binance', 'okx'];
  // The venue the desk actually trades at. Its price is the executable one; every other venue
  // is a fallback that must be labelled as such.
  const VENUE_OF_RECORD = venue;
  const candidates = [];
  let spreadPts = null;
  for (const v of VENUE_ORDER) {
    const t = await store.latestTick(userId, symbol, v).catch(() => null);
    if (!t) continue;
    // P0-4: live spread (ask - bid) from the plus500 tick — the min-stop-to-spread floor in
    // risk.js uses it. DELIBERATELY UNCHANGED: it still reads the plus500 tick whatever its
    // age. That is its own staleness question (a stale spread becomes a stale stop floor,
    // which changes sizing) and is recorded as a separate task rather than altered here.
    if (v === 'plus500' && spreadPts == null && t.ask != null && t.bid != null) {
      const s = Number(t.ask) - Number(t.bid);
      if (Number.isFinite(s) && s > 0) spreadPts = s;
    }
    candidates.push({ venue: v, mid: mid(t), capturedAt: t.capturedAt, ageMs: Date.now() - new Date(t.capturedAt).getTime() });
  }
  // C3: the admission verdict arrives as DATA (see venueAdmission.js). `null` = the gate is off, which
  // has to mean prefetch behaviour unchanged rather than unchanged-after-considering-it.
  const picked = pickTick(candidates, { primary: VENUE_OF_RECORD, allowedVenues: opts.allowedVenues ?? null });
  const usingTick = picked.mid != null;
  const tickPx = picked.mid;
  const tickVenueUsed = picked.venue;
  const tickCapturedAt = picked.capturedAt;
  const tickStaleFallback = picked.stale;
  // WHICH CLOCK DOES `price` BELONG TO? A tick has its own time; a bar close has the bar's.
  // Consumers must not have to infer this from the value, which is how a live tick ended up
  // being compared against Donchian bounds computed from an hour-old bar.
  const priceAsOf = usingTick ? tickCapturedAt : (lastBar ? lastBar.barStart : null);
  const priceAgeSec = priceAsOf ? Math.round((Date.now() - new Date(priceAsOf).getTime()) / 1000) : null;

  // ---- S1b: MARKET STRUCTURE AS CONTEXT (design doc §5, §12 S1) --------------------------------
  // ★ NO CONSUMER YET, AND THAT IS THE DESIGN. S1 exists so the field can be MEASURED before anything
  // acts on it (§2: structure is CONTEXT before it is a GATE). Nothing reads this.
  //
  // ★ TOP-LEVEL, DELIBERATELY NOT INSIDE `indicators`. `buildBundleObj` and `context.centralContext`
  // BOTH pass `indicators` through WHOLESALE (`indicators: s.indicators || null`). A field nested there
  // would silently change the STORED bundle AND the paper context. A top-level field is ignored by every
  // renderer, because both render FIELD BY FIELD — which is the only reason S1's "byte-identical bundle"
  // gate is achievable at all.
  //
  // ★ VENUE OF RECORD, NOT THE INDICATOR VENUE (owner decision 2026-09-22, option A). `bars` above is the
  // FIRST venue in IND_VENUE_PREF with enough history, and for Gold/Silver/Bitcoin/Oil that resolves to
  // YAHOO — a different instrument (TRD-69). An oscillator on a substitute venue is a tolerated caveat; a
  // LEVEL on one is not, because BOS, protected swings and the dealing range are ABSOLUTE PRICES compared
  // against the traded price, and the Gold basis is ~116 bps (~50 points at 4349) — larger than many of
  // this desk's stop distances.
  let structure;
  let activity;
  // Pre-populated with the fallback so the CATCH block still reports a truthful basis: a resolution that
  // threw must not look like a resolution that chose the configured venue on purpose.
  const structBasis = {
    venue: VENUE_OF_RECORD,
    venueWhy: 'not_resolved',
    venueBars: null,
    timeframe: '1h',
    // ★ RECORDED WINS; THE MAP IS ONLY THE FALLBACK FOR PRE-043 ROWS. Up to here this is a DECLARATION —
    // what the venue is vouched for by construction. From 043 on the newest bar STATES the interval its
    // chart was on, and a statement beats a declaration. That is §4.1 read at its word: provenance as a
    // measurement rather than a claim.
    sourceIntervalSec: SOURCE_INTERVAL_BY_VENUE[VENUE_OF_RECORD] ?? null,
  };
  try {
    // ONE probe read decides the series, and it is also the series we usually keep — so the common case
    // costs one read and no more. The second read only happens if the venue's chart series is too thin.
    const structChartBars = used === STRUCTURE_CHART_VENUE
      ? bars // already the loaded series — no second query
      : await store.listBars(userId, { timeframe: '1h', symbol, venue: STRUCTURE_CHART_VENUE, limit: 300 }).catch(() => []);
    const venuePick = resolveStructureVenue({
      configured: VENUE_OF_RECORD,
      chartVenue: STRUCTURE_CHART_VENUE,
      chartBars: structChartBars.length,
      minBars: STRUCTURE_DEFAULTS.minBars,
    });
    structBasis.venue = venuePick.venue;
    structBasis.venueWhy = venuePick.why;
    structBasis.venueBars = venuePick.bars;
    structBasis.sourceIntervalSec = SOURCE_INTERVAL_BY_VENUE[venuePick.venue] ?? null;
    const structBars = venuePick.venue === STRUCTURE_CHART_VENUE
      ? structChartBars
      : (used === venuePick.venue
        ? bars // the configured venue IS already the loaded series — no second query
        : await store.listBars(userId, { timeframe: '1h', symbol, venue: venuePick.venue, limit: 300 }));
    // Walk newest-first: an older row may predate 043, and ONE recorded row is enough to correct the claim.
    for (let i = structBars.length - 1; i >= 0; i--) {
      const declared = structBars[i] && structBars[i].sourceIntervalSec;
      if (declared != null) { structBasis.sourceIntervalSec = Number(declared); break; }
    }
    // The LAST stored bar is usually the FORMING hour: upsertHourlyBars rebuilds it from the last two days
    // of ticks on every wake. So the decision bar is the one BEFORE it — the same discipline
    // multiTfSnapshot applies to Donchian via slice(0,-1). The engine states its own rule (§4.4) rather
    // than inheriting one, and the CALLER resolves the window, which is where the house rule (TRD-92) puts
    // it. `asOf = length - 2` is deliberately conservative: excluding a closed bar loses one observation,
    // including a forming one invents a swing out of an incomplete hour.
    const structAsOf = structBars.length - 2;
    structure = structAsOf >= 0
      ? computeStructure({ bars: structBars, asOf: structAsOf, basis: structBasis })
      : { state: 'insufficient_history', reason: `venue-of-record series holds ${structBars.length} bar(s) — the forming bar is excluded`, basis: structBasis, params: null, swings: [] };

    // ---- S2: THE VOLUME-FREE ACTIVITY MEASURE (design doc §6 P2 item 1) ---------------------------------
    // ★ SAME BARS, SAME BAR, NO EXTRA READ. It is computed from `structBars` at `structAsOf` because the
    // measure is only sound on the FAITHFUL series. The tick-built series' range shortfall varies by
    // hour-of-day (30-70 bps) AND scales with how many ticks landed in the hour (0.08 at 1-2 ticks, 0.67 at
    // 10+), so a same-hour ratio computed against it would carry that bias straight into its own
    // denominator — the 2026-09-22 venue measurement is what makes this measure sound rather than a guess.
    // Reusing bars structure already resolved costs nothing.
    //
    // ★ ITS OWN GUARD, NOT THE STRUCTURE TRY. These are two independent observations of the same series;
    // one failing must not erase the other.
    const activityFallback = {
      state: 'insufficient_history',
      reason: `venue-of-record series holds ${structBars.length} bar(s) — the forming bar is excluded`,
      basis: structBasis, params: null, hourUtc: null, samples: 0, range: null, body: null,
    };
    try {
      activity = structAsOf >= 0
        ? computeActivity({ bars: structBars, asOf: structAsOf, basis: structBasis })
        : activityFallback;
    } catch (e) {
      activity = { ...activityFallback, state: 'error', reason: String(e.message || e).slice(0, 200) };
    }
  } catch (e) {
    // Guarded for the same reason the candidate-proximity block below is guarded: this is NOT yet
    // load-bearing, and an unguarded throw here would fail a symbol's evaluation inside a live wake —
    // turning a field nobody reads into an outage. `error` is its OWN state so it can never be mistaken
    // for "not enough history", which is a statement about the data rather than about the code.
    structure = { state: 'error', reason: String(e.message || e).slice(0, 200), basis: structBasis, params: null, swings: [] };
  }
  const base = {
    // ⚠ `tickCount` IS A MISNOMER - it has always held the BAR count, not a tick count, and it is rendered in
    // the UI under a column literally headed "Ticks". `barCount` is the same number under a name that does not
    // lie; `tickCount` is kept because rows persisted before this field existed still carry it.
    symbol, venue, tickCount: bars.length, barCount: bars.length, tickVenue: used || venue,
    // ⚠⚠ THE THRESHOLD TRAVELS WITH THE COUNT. `insufficient_data` is a VERDICT, and a verdict on its own cannot
    // be told apart from a symbol one bar short and one twenty-nine short - which is the difference between
    // waiting a wake and dropping the symbol. Both numbers are EMITTED rather than re-derived by a renderer, so
    // MIN_BARS keeps exactly one home (the complaint this answers, TRD-UI-8, was that the threshold was
    // invisible; a second copy of 30 in the client would be a worse answer than no answer).
    minBars: MIN_BARS,
    // S1b: market structure as CONTEXT. Top-level on purpose — see the block above. Added to `base`
    // rather than to `out` so the EARLY RETURN (stale / insufficient_data) cannot be the path that
    // forgets it: TRD-68 was exactly that mistake — a field present on one path and absent on the other,
    // and it took a symbol's signal series going stale for weeks before anything showed it.
    structure,
    // S2: the volume-free activity measure. Top-level for the same reason structure is, and computed on
    // the same venue-of-record series for the same reason — see the activity block above.
    activity,
    // TRD-72 (2026-09-22): THE SCOPED STRATEGY LIST THIS SYMBOL WAS EVALUATED WITH, recorded on the
    // result so the prompt builder can filter dead telemetry by the SAME value the evaluation used
    // rather than re-deriving it — a second derivation is how two answers drift apart. `strategyIds`
    // is the fourth parameter and its single caller passes `scopedStrategyIds(...)` into it.
    // An EMPTY ARRAY is a fact (nothing may trade this symbol); an ABSENT field is UNKNOWN, and the
    // bundle treats those two differently on purpose (see the scope filter in promptBuilder).
    strategies: Array.isArray(strategyIds) ? strategyIds : null,
    // RENAMED (TRD-PRC-1): this was called `tickAgeSec` and always held the BAR's age —
    // a field whose name contradicted its value is how the conflation survived review.
    barAgeSec,
    // PROVENANCE for the price in `price` / `latest.mid`.
    priceSource: usingTick ? 'tick' : 'bar_close',
    priceAsOf,
    priceAgeSec,
    priceVenue: usingTick ? tickVenueUsed : (used || venue),
    // True when the venue of record's own tick was older than the SLA and was used anyway —
    // the right instrument at the wrong time, which is a WARNING, not a substitution.
    priceTickStale: usingTick ? tickStaleFallback : false,
    // True when NO tick existed from the venue of record and another venue's price was used
    // instead. A substituted price is NOT the price the desk can execute at.
    priceSubstituted: usingTick ? !!picked.substituted : false,
    priceReason: picked.reason || null,
    // Which venues were stale, so an outage is attributable without re-querying the ticks table.
    priceStaleVenues: picked.staleVenues.length ? picked.staleVenues : null,
    // C3: WHICH substitutes the comparability gate allowed, and which it REFUSED despite being
    // available. A refused substitution is the interesting case - it is a decision that cost the desk
    // something - so it is carried structurally instead of being inferable only from the reason text.
    priceSubstituteGate: picked.comparability && picked.comparability.gated ? picked.comparability : null,
    // ★★ TRD-FED-1: cross-source divergence, which was COMPUTED NOWHERE and therefore logged nowhere. The
    // 09-24 Oil spike (2.293%) and the worse 2026-09-18 one (5.124%) were both invisible in every log the
    // desk writes - they were found by post-hoc analysis of PriceTicks. This rides the snapshot so the number
    // is recorded on the bundle whether or not it is alarming, and `wakePipeline` raises
    // `price_divergence` off it. Carried in FULL (not just the max) so a reader can see WHICH pair and how
    // many pairs were actually compared - a max over an empty comparison and a max over six pairs are
    // different claims and must not render identically.
    priceDivergence: picked.divergence || null,
    priceTickAgeSec: usingTick && tickCapturedAt
      ? Math.round((Date.now() - new Date(tickCapturedAt).getTime()) / 1000) : null,
    // `latest` KEEPS the bar time: promptBuilder's stalePrices gate and the wake gate both
    // read it as "how old are the BARS", and re-pointing it at the tick would silently
    // redefine a freshness rule. The tick's own time now travels in `priceAsOf` instead.
    latest: lastBar ? { capturedAt: lastBar.barStart, mid: tickPx != null ? tickPx : Number(lastBar.closePrice) } : null,
    // The previous price in `prevPrice` is ALWAYS a bar close (every strategy compares it to
    // Donchian bounds computed from bars). Say so, so a renderer cannot pair it with a tick.
    prevPriceSource: 'bar_close',
    prevPriceAsOf: bars.length > 1 ? bars[bars.length - 2].barStart : null,
  };
  // Indicator snapshot (for the deliberation bundle) is independent of bar
  // sufficiency — same 1h bars, richer set.
  const indicators = await indicatorSnapshot(userId, symbol);
  // Multi-timeframe big picture (5m/1h/4h/1d) for the chairs.
  const bigPicture = await multiTfSnapshot(userId, symbol).catch(() => []);
  if (status !== 'ok' || !bars.length) return { ...base, status, indicators, bigPicture };

  const highs = bars.map((b) => Number(b.high)).filter((v) => Number.isFinite(v));
  const lows = bars.map((b) => Number(b.low)).filter((v) => Number.isFinite(v));
  const closes = bars.map((b) => Number(b.closePrice)).filter((v) => Number.isFinite(v));
  const price = tickPx != null ? tickPx : closes[closes.length - 1];
  const prevPrice = closes[closes.length - 2] ?? price;

  // TRD-13: Strategy Lab harness context — completed 4h blocks + bar-causal
  // regime flags (+ the Gold/Silver ratio series when this ticker is one leg
  // of the pair). Candidates consume `lab` in liveSignal exactly like the
  // backtester consumes it — one trade shape everywhere.
  let labCtx = lab.labContext(lab.normalize(bars));
  let ratioNote = null;
  if (symbol === 'Gold' || symbol === 'Silver') {
    const otherSym = symbol === 'Gold' ? 'Silver' : 'Gold';
    try {
      const otherRows = await store.listBars(userId, { timeframe: '1h', symbol: otherSym, venue: used, limit: 300 });
      if (otherRows.length >= MIN_BARS) {
        labCtx = lab.labContext(lab.normalize(bars), { ratioBars: lab.normalize(otherRows) });
        ratioNote = otherSym;
      }
    } catch { /* ratio unavailable — pair candidates treat lab.ratio as null */ }
  }
  const labNow = labCtx.ctxAt(bars.length - 1);

  const atr14 = atr(highs, lows, closes, 14);
  const adx14 = adx(highs, lows, closes, 14);

  const out = {
    ...base, status, price, prevPrice, atr14: atr14 == null ? null : round4(atr14),
    adx14: adx14 == null ? null : round4(adx14),
    spread: spreadPts == null ? null : round4(spreadPts),
    // P2-14 (2026-09-10): per-ticker regime fit — ADX(14) >= 25 reads as
    // trend on THIS ticker (not the desk-global meta), with the direction
    // from 50-bar momentum. Evidence for the chairs, not a hard gate.
    regime: adx14 == null ? null : (adx14 >= 25 ? 'trend' : 'range'),
    regimeDir: closes.length > 50 ? (closes[closes.length - 1] > closes[closes.length - 51] ? 'up' : 'down') : null,
    donchian: null,
    indicators,
    bigPicture,
    signal: null,
    // TRD-12 Phase 2: the real post-MAD series rides along so the
    // correlation veto in risk.js finally has data (was hard-coded null).
    series: closes,
    // TRD-13: lab context summary for the deliberation bundle (candidates
    // also receive the full ctx via liveSignal).
    lab: {
      barsK: labCtx.blocks.length,
      regime: labNow.regime && labNow.regime.regime,
      dir: labNow.regime && labNow.regime.dir,
      ratioSymbol: ratioNote,
      ratioBars: labNow.ratio ? labNow.ratio.length : 0,
    },
  };

  if (adx14 == null || atr14 == null) return out;

  // Open-position context for trailing stops.
  const pos = (openTrades || []).find((t) => t.symbol === symbol && t.venue === venue);
  const openCtx = openPositionContext(bars, pos);

  let exitSignal = null;
  let entrySignal = null;
  for (const id of strategyIds) {
    const strat = strategies.get(id);
    if (!strat || !strat.liveSignal) continue;
    // 2026-09-11 (scope-leak fix): track-bound strategies (frozen survivors)
    // declare `symbols` and may only ever evaluate those instruments — belt
    // and braces on top of the scope gate, so a config slip can never run an
    // Oil-tuned param set on an equity (the Sany/survoil incident).
    if (Array.isArray(strat.symbols) && strat.symbols.length && !strat.symbols.includes(symbol)) continue;
    // TRD-12 Phase 3: multi-factor only trades EQUITY tickers (its factors
    // are equities-specific); crypto/commodities keep using turtle.
    if (id === 'multi' && !require('./strategies/multiFactor').isEquityTicker((require('./providers').SYMBOL_MAP[symbol] || {}).yahoo || '')) continue;
    // IMPLIED GOAL: mean-reversion voters only act in ranging regimes (the
    // meta engine decides); trend regimes belong to turtle/macd.
    //
    // 2026-09-18 — FAIL-CLOSED. This read `opts.regime && opts.regime !== 'range'`, and
    // `wakePipeline` passes `regime: null` whenever the meta engine is unavailable, so a null
    // short-circuited the guard and PERMITTED the fade: the desk was most permissive exactly when it
    // knew least. On 18/09 that cost 13 rsi2 entries that faded a rising Bitcoin market. An unknown
    // regime is not a ranging regime — fade only on a positive 'range' verdict.
    //
    // squeezerev is deliberately NOT listed here: it applies its own bar-causal regime check inside
    // the strategy (see its header), so gating it twice would hide which gate refused.
    if ((id === 'meanrev' || id === 'rsi2') && opts.regime !== 'range') continue;
    const r = strat.liveSignal({
      highs, lows, closes, atr14, adx14, price, prevPrice,
      // TRD-75: the symbol is passed so a per-instrument (strategy, params) binding is possible.
      // Resolution: DEFAULTS -> params[id] -> symbolParams[symbol][id].
      params: strategies.paramsFor(settings, id, symbol),
      openTrade: openCtx,
      lab: labNow, // TRD-13: { barsK, regime, ratio } at the latest bar
      // ★ S2: STRUCTURE AND ACTIVITY ARE PUBLISHED TO THE STRATEGY LAYER HERE (design doc §12).
      //
      // No strategy reads them yet — S3 registers the first one that does — and this IS the whole of
      // "publish": one object literal, no behaviour change, so S2's gate (no reviewer change, therefore no
      // shadow invalidation) holds by construction rather than by review. Before this a strategy had no way
      // to ask for structure at all; the alternative is each strategy loading its own bars and computing its
      // own levels, which is how two components end up disagreeing about the same price.
      structure,
      activity,
    });
    if (r && r.donchian && !out.donchian) out.donchian = r.donchian;
    if (r && r.type === 'exit' && !exitSignal) exitSignal = { ...r, strategy: id };
    else if (r && r.type === 'entry' && !entrySignal) entrySignal = { ...r, strategy: id };
  }
  // IMPLIED GOAL: explicit stop level on the latest executable price — the
  // DB stop survives between wakes; micro-wakes make this near-real-time.
  if (!exitSignal && pos && pos.stopPrice != null && price != null) {
    const stop = Number(pos.stopPrice);
    const stopHit = pos.direction === 'buy' ? price <= stop : price >= stop;
    if (stopHit) {
      exitSignal = { type: 'exit', direction: pos.direction === 'buy' ? 'sell' : 'buy', basis: `stop level ${stop} hit`, strategy: pos.strategyId || 'desk' };
    }
  }
  // TRD-12 Phase 3: desk-level TAKE-PROFIT exit (3xATR target stored on the
  // trade) — checked before the strategy exits are considered.
  if (!exitSignal && pos && pos.takeProfitPrice != null && price != null) {
    const tp = Number(pos.takeProfitPrice);
    const tpHit = pos.direction === 'buy' ? price >= tp : price <= tp;
    if (tpHit) {
      exitSignal = { type: 'exit', direction: pos.direction === 'buy' ? 'sell' : 'buy', basis: 'take profit hit', strategy: pos.strategyId || 'desk' };
    }
  }
  if (exitSignal) {
    out.signal = { type: exitSignal.type, direction: exitSignal.direction, basis: exitSignal.basis, strategy: exitSignal.strategy };
    // TRD-71: EXITS ARE NEVER GATED. The gate decides whether a STRATEGY may open a position; it
    // must never be able to refuse a stop, a take-profit or a desk exit, because that would trap a
    // position to prove a point about eligibility. Observe (and enforce, when it is switched on)
    // applies to entries only - see the signalLaps below.
  } else if (entrySignal) {
    // TRD-12: one position per symbol — while a position is open, fresh
    // entry signals are SUPPRESSED (only exits pass). This is what stopped
    // the desk from stacking a second Oil long on top of the first.
    if (openCtx) {
      out.signal = null;
      out.flat = 'position open — entries suppressed';
    } else {
      // TRD-12: venue session gate — no entries into a closed market
      // (Plus500 won't fill them anyway; saves a doomed wake decision).
      const venue = require('../plus500/sessionFeed').get(symbol);
      if (venue && venue.isTraded === false) {
        out.signal = null;
        out.flat = 'market closed';
        out.session = venue.next ? { open: false, nextOpenAt: venue.next.from } : { open: false };
      } else {
        const fired = { type: entrySignal.type, direction: entrySignal.direction, basis: entrySignal.basis, strategy: entrySignal.strategy };
        // TRD-71: OBSERVE the live-eligibility decision on every ENTRY that fires. The decision
        // itself is pure (lab/gate.js apply()): observe mode cannot block, an exit is never gated,
        // and only settings.gate.enforce = true can suppress an entry. A failed lab read
        // (candidatesUnavailable) yields no candidates and can never refuse anything.
        if (opts.labGateConfig) {
          const decision = labGate.observe(opts.labGateConfig, { strategyId: fired.strategy, symbol });
          const applied = labGate.apply(fired, decision);
          out.labGate = applied.decision || decision;
          if (applied.signal) out.signal = applied.signal;
          else out.flat = applied.flat || out.flat;
        } else {
          out.signal = fired;
        }
      }
    }
  }
  // ACCURATE FLAT REASONS (user ask 2026-09-10): "no signal" read like an
  // error code. When nothing fired, explain WHY with the actual numbers.
  if (!out.signal) {
    const notes = [];
    // TRD-56: only the gates of strategies that can actually trade THIS symbol.
    const gateScope = gateNoteScope(strategyIds);
    if (gateScope.donchian && out.donchian) {
      if (price > out.donchian.upper) notes.push(`above DC20 band ${round4(out.donchian.upper)} — no fresh cross`);
      else if (price < out.donchian.lower) notes.push(`below DC20 band ${round4(out.donchian.lower)} — no fresh cross`);
      else notes.push(`inside range ${round4(out.donchian.lower)}–${round4(out.donchian.upper)}`);
    }
    if (gateScope.adx && adx14 != null && adx14 <= 20) notes.push(`ADX ${round4(adx14)} ≤ 20 (trend gate)`);
    if (gateScope.macd && indicators && indicators.macd) notes.push(`MACD ${round4(indicators.macd.line)} vs ${round4(indicators.macd.signal)} no cross`);
    if (gateScope.meanrev && indicators && indicators.rsi != null && opts.regime && opts.regime !== 'range') {
      notes.push('mean-rev family gated off (regime ' + opts.regime + ')');
    }
    // Owner choice (TRD-56): in-scope detail above, ONE line for everything else.
    const idle = scopeSummary(strategyIds, opts.globalStrategyIds);
    if (idle) notes.push(idle);
    // ★ AND HOW CLOSE THE CANDIDATES ARE (owner ask 2026-09-15).
    //
    // This began as the answer to the "no strategy in scope for this symbol" dead end — and stopping there
    // was wrong the moment a symbol HAS scope and still fires nothing, because it then reported only
    // `not evaluated here: …`, which is the same "you don't know how close it is" gap one line over. Only
    // the IDS differ: the registry's candidates when nothing is in scope, the SCOPE ITSELF when something
    // is. Using one function for both is what stops the two cases drifting apart.
    //
    // Wrapped so a registry failure degrades to the old message instead of failing a wake.
    try {
      const inScope = strategyIds.length > 0;
      const ids = inScope ? strategyIds : require('./binding').applicableIds(symbol, strategies);
      const regimeBasis = opts.regime
        ? {
          regime: opts.regime,
          adx: opts.regimeAdx == null ? null : Number(opts.regimeAdx),
          symbol: opts.regimeSymbol || null,
          meta: true,
        }
        : { regime: out.regime, adx: adx14, symbol: null, meta: false };
      const prox = candidateProximity(ids, {
        price, adx14, indicators, donchian: out.donchian, highs, lows,
        // The gate note above already names the regime for an IN-SCOPE mean-rev family, so the distance
        // clause does not repeat it. Duplication is how a reader learns to skim.
        regimeBasis: gateScope.meanrev ? null : regimeBasis,
        settings, symbol, closes,
      }, { prefix: inScope ? 'distance' : 'candidates' });
      if (prox) notes.push(prox);
    } catch {
      // ★ THE WHOLE BLOCK IS GUARDED, NOT JUST THE REGISTRY LOOKUP. This line is DECORATION — it explains
      // a symbol that was not going to trade anyway — and an unguarded throw here would fail the symbol's
      // evaluation inside a live wake, i.e. turn a cosmetic improvement into an outage. The first version
      // guarded only `require('./binding')` and left `candidateProximity` able to take the wake down.
      // Degrading to the old one-line message is always the right trade.
    }
    out.flat = out.flat || notes.join(' · ') || 'no trigger conditions';
  }
  return out;
}

// Latest classic-indicator values from stored 1h bars (first venue that has
// >= 30 bars wins). Deterministic, zero tokens. Null-safe.
async function indicatorSnapshot(userId, symbol) {
  try {
    for (const venue of IND_VENUE_PREF) {
      const bars = await store.listBars(userId, { timeframe: '1h', symbol, venue, limit: 260 });
      if (bars.length < 30) continue;
      const closes = bars.map((b) => b.closePrice).filter((v) => v != null);
      const highs = bars.map((b) => b.high).filter((v) => v != null);
      const lows = bars.map((b) => b.low).filter((v) => v != null);
      const bb = bollinger(closes, 20, 2);
      const st = stochastic(highs, lows, closes, 14, 3);
      return {
        venue, bars: closes.length,
        sma50: round4n(sma(closes, 50)), sma200: round4n(sma(closes, 200)), ema20: round4n(ema(closes, 20)),
        bollinger: bb ? { upper: round4(bb.upper), mid: round4(bb.mid), lower: round4(bb.lower), bandwidthPct: round4(bb.bandwidth ?? 0) } : null,
        rsi: round4n(rsi(closes, 14)),
        macd: (() => { const m = macd(closes, 12, 26, 9); return m ? { line: round4(m.macd), signal: round4(m.signal), hist: round4(m.hist) } : null; })(),
        stoch: st ? { k: round4(st.k), d: round4(st.d) } : null,
        // implied goal: the full classic set so the chairs see everything a
        // human would (roc/momentum/cci/%R/aroon/obv on top of the base).
        roc20: round4n(roc(closes, 20)),
        mom10: round4n(momentum(closes, 10)),
        cci20: round4n(cci(highs, lows, closes, 20)),
        williamsR14: round4n(williamsR(highs, lows, closes, 14)),
        aroon: (() => { const a = aroon(highs, lows, 25); return a ? { up: round4(a.up), down: round4(a.down) } : null; })(),
        obv: (() => { const o = obv(closes, bars.map((b) => b.volume)); return o ? round4(o.obv) : null; })(),
      };
    }
    return null;
  } catch (e) {
    return { error: String(e.message || e).slice(0, 120) };
  }
}

function round4n(v) { return v == null ? null : round4(v); }

// MULTI-TIMEFRAME BIG PICTURE (user ask 2026-09-10): one compact line per
// timeframe so the chairs see 5m/1h/4h/1d context, not just the 1h signal
// series. Venue pick: first venue with >= 20 bars for that timeframe.
const BIG_TFS = ['5m', '1h', '4h', '1d'];
const BIG_VENUES = ['yahoo', 'binance', 'okx', 'plus500_chart', 'plus500'];
async function multiTfSnapshot(userId, symbol) {
  const rows = [];
  for (const tf of BIG_TFS) {
    let bars = [];
    let used = null;
    for (const v of BIG_VENUES) {
      const b = await store.listBars(userId, { timeframe: tf, symbol, venue: v, limit: 120 }).catch(() => []);
      if (b.length >= 20) { bars = b; used = v; break; }
    }
    if (!bars.length) continue;
    const closes = bars.map((b) => Number(b.closePrice));
    const highs = bars.map((b) => Number(b.high));
    const lows = bars.map((b) => Number(b.low));
    const last = closes[closes.length - 1];
    const first = closes[0];
    const prev = closes.length > 1 ? closes[closes.length - 2] : null;
    const dc = donchian(highs.slice(0, -1), lows.slice(0, -1), 20);
    const a = adx(highs, lows, closes, 14);
    const pos = dc ? (last > dc.upper ? 'above' : last < dc.lower ? 'below' : 'inside') : null;
    // 2026-09-13 HORIZON FIX. `chgPct` is a FIXED-BAR-COUNT lookback (limit 120), so
    // its horizon is whatever the stored series happens to span — NOT the bar length
    // in `tf`. Measured live: the `5m` row reported chg=-4.597% at 2026-09-11 15:24,
    // which reconciles to a first price of ~103.98 = Oil's level ~16 HOURS earlier,
    // while the same code on the same limit reached back only ~10 hours the next day
    // (chg=-2.18%). Chairs read that as a 5-MINUTE flush (the true 5m move was -0.21%)
    // and cited it to justify two exits. So: publish the real span, and publish a true
    // one-bar change, so a multi-hour drift cannot be mistaken for an intraday move.
    const firstAt = new Date(bars[0].barStart).getTime();
    const lastAt = new Date(bars[bars.length - 1].barStart).getTime();
    const spanHours = Number.isFinite(firstAt) && Number.isFinite(lastAt) ? (lastAt - firstAt) / 3600000 : null;
    rows.push({
      tf, venue: used, bars: closes.length,
      last: round4(last),
      chgPct: first > 0 ? round4(((last - first) / first) * 100) : null,
      spanHours: spanHours == null ? null : round4(spanHours),
      chgLast1Pct: prev > 0 ? round4(((last - prev) / prev) * 100) : null,
      adx14: a == null ? null : round4(a),
      dc20: dc ? { lower: round4(dc.lower), upper: round4(dc.upper) } : null,
      pos,
      asOf: bars[bars.length - 1].barStart,
    });
  }
  return rows;
}

// ---------------- strategy scope resolution (P0-1c + 2026-09-11 fix) ----------
// Track-bound check: a strategy that declares `symbols` may only evaluate
// those instruments (frozen forward-validation wrappers MUST declare it).
function symbolEligible(id, symbol, registry = strategies) {
  return scopeResolution.applicableOn(id, symbol, registry);
}

// Eligible strategy ids for ONE symbol: explicit entry > DEFAULT entry
// ('others' or '*') > global enabled list. Track-bound strategies are filtered
// out per symbol. The default key is the fix for the Sany/survoil incident:
// the scope config enumerated every symbol it knew about, so newly added
// symbols silently inherited the global enabled list (the frozen survivors).
function scopedStrategyIds(globalIds, symbolScope, symbol, registry = strategies) {
  return scopeResolution.scopeIdsFor(globalIds, symbolScope, symbol, registry);
}

// ---------------- flat-reason gate scope (TRD-56, 2026-09-14) ---------------
// The flat reason explains WHY nothing fired. It used to do that with the gates
// of strategies that are not running on this symbol: the owner read
// "flat MACD -0.3401 vs -0.2831 no cross" on Sugar and SGX and reasonably
// concluded the desk trades MACD. It does not - macd has had no symbol scope
// since 2026-09-11 - and the same text rode into EVERY chair bundle.
//
// GATE OWNERSHIP IS DECLARED, NEVER INFERRED FROM THE ID. survGold/survoil are
// the frozen turtle wrappers, but their ids contain neither `turtle` nor `macd`,
// so a name-based mapping would strip the Donchian and ADX reasons from Gold and
// Oil - the only two instruments the desk currently trades - while tidying the
// text about the ones it does not. A coverage test asserts every registered
// strategy is either mapped here or declared GATELESS, so a new strategy has to
// make this decision deliberately rather than inherit a wrong answer.
const GATE_OWNERS = {
  // `survgoldStruct` (S3, 2026-09-23) is a turtle clone, so it owns the same two gates as its control. Its
  // presence here is what makes the reviewer's candidate set able to mention it — see the note in
  // `test/structure-gate-s3.test.js` about why that is safe TODAY and what it is conditional on.
  //
  // The `surva*`/`survc*` REPLICAS (ten from 2026-09-25, six more from 2026-09-30) are turtle clones too, and
  // for the same reason: without them here the Donchian and ADX reasons would be stripped from the instruments
  // they exist to open, while the text about untouched instruments stayed tidy. They REPLACED the earlier
  // `survsilver` family — a replica carries a survivor's own frozen set, so it owns that survivor's gates. This
  // map says which gates a strategy OWNS, never whether it is switched on.
  donchian: ['turtle', 'survgold', 'survoil', 'survgoldstruct', 'regturtle', 'mtftrend', 'multi',
    'survasilver', 'survasugar', 'survabitcoin', 'survasgx', 'survaarabicacoffee',
    'survcsilver', 'survcsugar', 'survcbitcoin', 'survcsgx', 'survcarabicacoffee',
    'survaethereum', 'survcethereum', 'survasoybeans', 'survcsoybeans',
    'survanaturalgas', 'survcnaturalgas'],
  adx: ['turtle', 'survgold', 'survoil', 'survgoldstruct', 'regturtle', 'mtftrend', 'multi', 'macd',
    'survasilver', 'survasugar', 'survabitcoin', 'survasgx', 'survaarabicacoffee',
    'survcsilver', 'survcsugar', 'survcbitcoin', 'survcsgx', 'survcarabicacoffee',
    'survaethereum', 'survcethereum', 'survasoybeans', 'survcsoybeans',
    'survanaturalgas', 'survcnaturalgas'],
  macd: ['macd'],
  meanrev: ['meanrev', 'rsi2', 'squeezerev'],
};

// Strategies that own no price-gate note (congress fires on politician activity).
const GATELESS = ['congress'];

function gateNoteScope(scopedIds) {
  const ids = Array.isArray(scopedIds) ? scopedIds : [];
  const owns = (cat) => (GATE_OWNERS[cat] || []).some((id) => ids.includes(id));
  return { donchian: owns('donchian'), adx: owns('adx'), macd: owns('macd'), meanrev: owns('meanrev') };
}

// ---------------------------------------------------------------------------------------------------
// HOW CLOSE IS "NOTHING IN SCOPE"? (owner ask 2026-09-15)
// ---------------------------------------------------------------------------------------------------
//
// TRD-56 (test/flat-scope.test.js) requires a flat reason to name ONLY the gates of strategies that can
// actually trade the symbol. That rule is right and this does not touch it — the owner read "MACD … no
// cross" on Sugar and reasonably concluded the desk trades MACD, and it does not.
//
// But it left the other half unanswerable. For a symbol with nothing in scope, `gateNoteScope([])` is
// all-false BY DESIGN, so the only thing recorded was the single line "no strategy in scope for this
// symbol" — a dead end that reads like a fault. The owner: *"you don't know how close it is."* The desk
// HAD the numbers all along — donchian bands, ADX, MACD, RSI — and never looked at them.
//
// So a symbol with nothing in scope gets a SECOND clause reporting distance to the nearest candidate
// triggers. It is prefixed `candidates —` so it can never be mistaken for the reason nothing fired, which
// is the distinction TRD-56 exists to preserve. Thresholds come from each strategy's OWN resolved params
// (`paramsFor` resolves DEFAULTS -> global -> per-symbol) rather than being restated here, so a tuning
// change moves the distance with it. Bounded: this is a dashboard line, not a report.
//
// The cap counts ATOMIC clauses, not groups. Grouping them ("band A · band B" as one entry) made the cap
// unreachable — there are only three owner categories — so it silently stopped being a limit at all while
// still reading like one. Clauses are kept in usefulness order and the tail is dropped, which is why the
// MACD gap is the one that goes missing when a symbol has something more interesting to say.
const PROX_CLAUSE_LIMIT = 4;

function candidateProximity(candidateIds, ctx = {}, opts = {}) {
  const ids = Array.isArray(candidateIds) ? candidateIds : [];
  if (!ids.length) return null;
  const { price, adx14, indicators, highs, lows, regimeBasis, regime, settings = {}, symbol, closes } = ctx;
  if (price == null || !Number.isFinite(Number(price))) return null;
  // ★ WHOSE REGIME IS IT? Two different regimes are in play and they must never be blended. `opts.regime`
  // is the desk-global META verdict, derived by `meta.js` from the first watchlist symbol with bars;
  // `out.regime` is THIS ticker's own, from its own ADX. Pairing the meta regime with the local ADX
  // produced "now trend, ADX 16.83" on Silver — a self-contradicting sentence. A bare `regime` (direct
  // callers, tests) is read as this ticker's own, the only reading that cannot misattribute a number.
  const basis = regimeBasis || (regime ? { regime, adx: adx14, symbol: null, meta: false } : null);
  const owners = (cat) => (GATE_OWNERS[cat] || []).filter((id) => ids.includes(id));
  const who = (arr) => (arr.length > 3 ? `${arr.slice(0, 3).join('/')} +${arr.length - 3}` : arr.join('/'));
  const n = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '?' : Number(v).toFixed(dp));
  const pctFrom = (v) => ((v - price) / price) * 100;
  const signed = (v) => `${v >= 0 ? '+' : ''}${n(v)}%`;
  const clauses = [];

  const dc = owners('donchian');
  if (dc.length) {
    // ★ THE BAND IS COMPUTED FROM EACH STRATEGY'S OWN PERIOD, and attributed to THAT strategy. Both halves
    // were wrong in the first version of this: it read `out.donchian`, which is only populated when a
    // strategy RAN (nothing ran on this path — that is the whole point), and it deduplicated by period
    // while keeping one owner list, so a DC30 band was printed under the names of the DC20 strategies.
    // `paramsFor` resolves each strategy's period the same way the strategy would.
    if (adx14 != null && Number(adx14) <= 20) clauses.push(`need ADX > 20 (now ${n(adx14)})`);
    const byPeriod = new Map();
    for (const id of dc) {
      const p = strategies.paramsFor(settings, id, symbol) || {};
      const period = Number(p.donchianPeriod) || 20;
      const b = (Array.isArray(highs) && Array.isArray(lows) && highs.length > period) ? donchian(highs, lows, period) : null;
      if (!b || b.lower == null || b.upper == null) continue;
      // Dedupe by BAND, not by period: DC20 and DC30 usually resolve to the same two levels, and printing
      // the identical numbers twice under two names is noise, not detail.
      const key = `${Number(b.lower).toFixed(6)}:${Number(b.upper).toFixed(6)}`;
      const cur = byPeriod.get(key) || { owners: [], periods: new Set(), band: b };
      cur.owners.push(id);
      cur.periods.add(period);
      byPeriod.set(key, cur);
    }
    for (const { owners: bandOwners, periods, band } of byPeriod.values()) {
      const keys = [...periods];
      const tag = `DC${keys.length > 1 ? keys.join('/') : keys[0]}`;
      clauses.push(`${who(bandOwners)}: ${tag} break ${n(band.lower)} (${signed(pctFrom(band.lower))}) or ${n(band.upper)} (${signed(pctFrom(band.upper))})`);
    }
  }

  const mr = owners('meanrev');
  if (mr.length) {
    // The regime gate is a HARD filter for this family (see the `continue` in the strategy loop), so it
    // is stated first and separately from the thresholds — otherwise "RSI 80.96 vs 90" would imply a
    // trigger that a trend regime would silently discard.
    if (basis && basis.regime && basis.regime !== 'range') {
      const src = basis.symbol ? ` on ${basis.symbol}` : '';
      // A meta regime with no ADX of its own prints NO ADX rather than borrowing the ticker's — borrowing
      // is exactly the defect this replaced.
      const adxPart = basis.adx == null ? '' : `, ADX ${n(basis.adx)} vs 25`;
      clauses.push(`${who(mr)} need regime range (now ${basis.regime}${src}${adxPart})`);
    }
    const per = mr.map((id) => {
      const p = strategies.paramsFor(settings, id, symbol) || {};
      const period = Number(p.rsiPeriod) || (id === 'rsi2' ? 2 : 14);
      // Computed from the closes at THIS strategy's own period, so the label and the number can never
      // disagree; `indicators.rsi` (RSI-14) is only the fallback when the bar history is too short.
      const r = (Array.isArray(closes) && closes.length > period + 1) ? rsi(closes, period) : (indicators ? indicators.rsi : null);
      const low = p.low != null ? p.low : p.rsiLow;
      const high = p.high != null ? p.high : p.rsiHigh;
      if (r == null || low == null || high == null) return null;
      // ★ A NEGATIVE DISTANCE IS NOT A DISTANCE (found live): SGX read "meanrev RSI(14) 16.77 — -13.23
      // below 30 to buy", which is a trigger that has ALREADY fired being printed as a shortfall. The
      // interesting case is exactly that one — a candidate whose condition is met and which is not trading
      // — so it says so.
      if (r < Number(low)) return `${id} RSI(${period}) ${n(r)} — BELOW ${low}, buy trigger already met`;
      if (r > Number(high)) return `${id} RSI(${period}) ${n(r)} — ABOVE ${high}, sell trigger already met`;
      const toBuy = r - Number(low);
      const toSell = Number(high) - r;
      return `${id} RSI(${period}) ${n(r)} — ${toBuy <= toSell ? `${n(toBuy)} below ${low} to buy` : `${n(toSell)} above ${high} to sell`}`;
    }).filter(Boolean);
    // Pushed one by one, NOT joined: the mean-rev family can contribute two entries, and joining them into
    // a single "clause" made the cap count one where the reader sees two — so a 4-clause line could show
    // five. The cap has to bound what is PRINTED, not what was pushed.
    for (const c of per) clauses.push(c);
  }

  const md = owners('macd');
  if (md.length && indicators && indicators.macd) {
    clauses.push(`${who(md)}: MACD ${n(indicators.macd.line - indicators.macd.signal)} from a cross`);
  }
  // NOTE: there is deliberately no separate "ADX vs 25" clause for strategies that own the adx gate but no
  // donchian band. `GATE_OWNERS.adx` is a superset of `GATE_OWNERS.donchian` plus `macd`, both of which are
  // handled above, so that branch could never fire — and a branch that cannot fire still reads like cover.
  // The 20-gate is reported by the donchian block, where it actually decides something.

  if (!clauses.length) return null;
  // `candidates` when nothing is in scope (these are strategies the desk could be given), `distance` when
  // the ids ARE the scope (these are strategies the desk already holds and did not fire). Two different
  // claims, so two different words.
  const prefix = opts.prefix || 'candidates';
  return `${prefix} — ${clauses.slice(0, PROX_CLAUSE_LIMIT).join(' · ')}`;
}

// ONE line naming what was NOT evaluated here (owner choice, TRD-56: in-scope
// detail plus a one-line summary of the rest). A symbol with nothing in scope is
// the most important case - it is the sentence that would have prevented this
// whole investigation, and it says so rather than reporting someone else gate.
function scopeSummary(scopedIds, globalIds) {
  const scoped = Array.isArray(scopedIds) ? scopedIds : [];
  if (!scoped.length) return 'no strategy in scope for this symbol';
  const global = Array.isArray(globalIds) ? globalIds : [];
  const rest = global.filter((id) => !scoped.includes(id));
  return rest.length ? `not evaluated here: ${rest.join(', ')}` : null;
}

// IMPLIED GOAL: evaluate with an optional meta regime (meanrev gating).
async function evaluate(userId, settings, openTrades, opts = {}) {
  let symbols = (settings.watchlist || {}).symbols || [];
  if ((settings.watchlist || {}).mode !== 'fixed') {
    const cap = Number(settings.watchlist?.dynamicQuantCap) || 24;
    symbols = symbols.slice(0, cap);
  }
  const strategyIds = ((settings.strategies || {}).enabled || ['turtle'])
    .filter((id) => strategies.get(id) && strategies.get(id).liveSignal);
  // P0-1c (2026-09-10): per-symbol strategy scope — a symbol with a scope
  // entry uses ONLY those strategies (validated per-symbol configurations),
  // overriding the global enabled list.
  // 2026-09-11 (scope-leak fix): the scope may carry a DEFAULT key — "others"
  // (or "*") — applied to every symbol WITHOUT an explicit entry; without a
  // default, unlisted symbols keep the global list (old behaviour). Track-bound
  // strategies (wrappers declaring `symbols`) are filtered per symbol.
  const symbolScope = (settings.strategies || {}).symbolScope || {};
  const results = [];
  // TRD-71: the live-eligibility gate, in OBSERVE mode. ONE candidate read per wake (never per
  // symbol), and loadCandidates() cannot throw - an observe-mode read failure must not be able to
  // break a wake, so it is reported as candidatesUnavailable rather than as a refusal.
  const labRead = await labGate.loadCandidates(userId);
  const labGateConfig = labGate.configFrom(settings, labRead.candidates);
  // TRD-56: the flat reason names what was NOT evaluated, which needs the global
  // enabled list as well as the per-symbol scope.
  const scopeOpts = { ...opts, globalStrategyIds: strategyIds, labGateConfig };
  // C3: ONE admission read per symbol, TTL-cached, and a NO-OP when the gate is off — the resolver
  // returns before it touches the database. Belt-and-braces `.catch` because a price path must not be
  // able to fail on account of a measurement: a throw here is already an empty allowlist.
  const admission = new Map();
  for (const s of symbols) {
    const a = await venueAdmission.resolve(userId, s.symbol, settings).catch((e) => ({
      enabled: true, allowed: [], unavailable: true, reason: String((e && e.message) || e).slice(0, 160), evidence: [],
    }));
    admission.set(s.symbol, a);
  }
  for (const s of symbols) {
    const ids = scopedStrategyIds(strategyIds, symbolScope, s.symbol);
    const adm = admission.get(s.symbol);
    try { results.push(await evaluateSymbol(userId, s, openTrades, ids, settings, { ...scopeOpts, allowedVenues: adm && adm.enabled ? adm.allowed : null })); }
    catch (e) { results.push({ symbol: s.symbol, venue: s.venue, status: 'error', error: String(e.message || e).slice(0, 120) }); }
  }
  // TRD-71: the LEDGER - one row per in-scope (strategy, symbol) pair, so the desk collects coverage
  // for every pair it COULD trade and not only the ones that happened to fire. Recomputed from
  // current rows every wake, so it follows the data as verdicts change.
  const pairs = [];
  for (const s of symbols) {
    for (const id of scopedStrategyIds(strategyIds, symbolScope, s.symbol)) pairs.push({ strategyId: id, symbol: s.symbol });
  }
  const labGateLedger = labGate.ledger(labGateConfig, pairs);
  return {
    evaluatedAt: new Date().toISOString(),
    symbols: results,
    strategies: strategyIds,
    symbolScope,
    // C3: the substitute-venue verdict per symbol, WITH its evidence, so a wake can state why a
    // substitute was refused instead of leaving a reader to re-derive it from the bars later.
    venueComparability: {
      enabled: [...admission.values()].some((a) => a && a.enabled),
      unavailable: [...admission.entries()].filter(([, a]) => a && a.unavailable).map(([symbol, a]) => ({ symbol, reason: a.reason })),
      symbols: Object.fromEntries([...admission.entries()].map(([symbol, a]) => [symbol, !a || !a.enabled ? null : {
        allowed: a.allowed,
        reference: a.reference || null,
        cached: !!a.cached,
        evidence: (a.evidence || []).map((e) => ({ venue: e.venue, code: e.code, chargedBps: e.chargedBps, budgetBps: e.budgetBps })),
      }])),
    },
    labGate: {
      observe: labGateConfig.observe,
      enforce: labGateConfig.enforce,
      candidatesUnavailable: !!labRead.candidatesUnavailable,
      error: labRead.error || null,
      summary: labGate.summarise(labGateLedger),
      ledger: labGateLedger,
    },
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = { evaluate, evaluateSymbol, scopedStrategyIds, symbolEligible, indicatorSnapshot, multiTfSnapshot, mid, pickTick, resolveStructureVenue, STRUCTURE_CHART_VENUE, openPositionContext, gateNoteScope, scopeSummary, candidateProximity, PROX_CLAUSE_LIMIT, GATE_OWNERS, GATELESS, TICK_SLA_MS, BAR_FRESH_MS, MIN_BARS, BIG_TFS, labGate, IND_VENUE_PREF };
