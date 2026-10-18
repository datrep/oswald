// trading/agent/telemetry/cftcCot.js — TRD-76: the first WIRED physical source. CFTC Commitments of Traders.
//
// WHY THIS SOURCE FIRST. It is public (no key), weekly, and it covers six of the twelve watchlist
// instruments, so it has the widest coverage for zero credential cost. And it is POSITIONING
// telemetry: the desk has nothing else that can distinguish "price moved" from "everyone is already
// on one side of it".
//
// WHAT WAS VERIFIED LIVE, 2026-09-15 - none of this is assumed:
//
//   * the resource is `72hh-3qpy`, the DISAGGREGATED FUTURES-ONLY report. Verified by column count:
//     194 columns and 30 of them managed-money, against 133 columns and ZERO managed-money fields on
//     `6dca-aqww`. Choosing the wrong dataset here does not error, it silently answers a different
//     question: `jun7-fc8e` is the COMBINED (futures+options) report and reports GOLD open interest
//     582,664 where the futures-only report says 411,227. A parser that "worked" against either
//     would be wrong against the other.
//   * the default row order is by `id` ASCENDING, so `$limit=1` returns a row from 2022, not the
//     newest one. Every query here orders by report date explicitly. A source that silently serves
//     four-year-old positioning as current is the same defect class as a stale tick presented as live.
//   * the market names, checked one by one against the live dataset: GOLD, SILVER, WTI-PHYSICAL,
//     BRENT LAST DAY, SUGAR NO. 11, COFFEE C all resolve. NOTE `CRUDE OIL, LIGHT SWEET-WTI` ALSO
//     resolves but on ICE FUTURES EUROPE - it is NOT the NYMEX contract the desk means, so the
//     mapping names `WTI-PHYSICAL` instead. A name that matches is not the same as the right contract.
//
// THE AS-OF RULE IS THE POINT OF THE MODULE. A weekly figure is published for the prior TUESDAY and
// released the following FRIDAY, so the newest available report is normally 3-10 days old. That lag
// is NORMAL and must not read as staleness - and equally, a report that stops advancing must not read
// as current. So the observation carries its report date, its cadence and its age, and freshness is
// judged against the CADENCE (7 days + publication slack), never against a generic tick SLA.
//
// NOT WIRED INTO TRADING. Nothing here is a sizing or entry input. It is recorded and it is available
// to the reviewer to CITE; a proposal that never mentions it cannot have been influenced by it.
'use strict';

const ID = 'cftc_cot_positioning';
const PROVIDER = 'CFTC';
const ENDPOINT = 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json';

// Desk symbol -> CFTC contract_market_name. Verified live (see the header). An unmapped symbol is
// simply not covered by this source - it is not an error and it must not be guessed at.
const MARKETS = {
  Gold: 'GOLD',
  Silver: 'SILVER',
  Oil: 'WTI-PHYSICAL',
  'Brent Oil': 'BRENT LAST DAY',
  Sugar: 'SUGAR NO. 11',
  'Arabica Coffee': 'COFFEE C',
};

// Only the columns the signal needs. The full row is 194 columns and ~4.7 KB; asking for nine of them
// is the difference between a 200 KB response and a 3 MB one.
const SELECT = [
  'contract_market_name',
  'report_date_as_yyyy_mm_dd',
  'open_interest_all',
  'm_money_positions_long_all',
  'm_money_positions_short_all',
  'm_money_positions_spread',
  'change_in_m_money_long_all',
  'change_in_m_money_short_all',
].join(',');

// 7-day cadence + up to 3 days of publication slack. Beyond this the report has stopped advancing,
// which is a fact about the FEED, not about the position.
const CADENCE = 'weekly';
const STALE_AFTER_DAYS = 10;

// How many weekly reports to read per market. Used for the percentile window, and the window length
// travels with the value so a percentile can never be quoted without saying "over N weeks".
const WINDOW_WEEKS = 156;   // three years

function marketNamesFor(symbols = []) {
  return [...new Set((symbols || []).map((s) => MARKETS[s]).filter(Boolean))];
}

// Pure. Exported so a test can assert the query without a network call - and so the ordering and the
// column list are pinned as part of the contract with the provider.
function buildUrl({ symbols = [], weeks = WINDOW_WEEKS } = {}) {
  const names = marketNamesFor(symbols);
  if (!names.length) return null;
  const where = `contract_market_name IN (${names.map((n) => `'${n}'`).join(',')})`;
  const order = 'report_date_as_yyyy_mm_dd DESC';
  return `${ENDPOINT}?$select=${SELECT}`
    + `&$where=${encodeURIComponent(where)}`
    + `&$order=${encodeURIComponent(order)}`
    + `&$limit=${names.length * weeks}`;
}

// GOTCHA that has bitten this repo three times (exitLevels.level, expectancy.num, the tick-poison
// scan): `Number(null) === 0` and `Number('') === 0`, so a bare Number() guard ACCEPTS an absent
// value. Here that would turn a missing short-side figure into "no shorts", i.e. a fabricated
// maximum-long positioning extreme. Reject absent values BEFORE coercing.
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function daysBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
}

// Percentile of the newest net within the fetched window. Returns null when there is not enough
// history to make the claim - a percentile over three points is not a percentile.
function percentileOfNewest(values) {
  if (!Array.isArray(values) || values.length < 26) return null;   // < ~6 months of weeks
  const [head, ...rest] = values;                                    // newest first
  if (!Number.isFinite(head)) return null;
  const below = rest.filter((v) => Number.isFinite(v) && v < head).length;
  const known = rest.filter((v) => Number.isFinite(v)).length;
  if (!known) return null;
  return Math.round((below / known) * 100);
}

// PURE: provider rows -> observations. No clock, no network, no DB. `now` is injected.
function parse(rows, { now = new Date(), symbols = [], weeks = WINDOW_WEEKS } = {}) {
  const out = [];
  const byMarket = new Map();
  for (const r of (rows || [])) {
    const name = r && r.contract_market_name;
    if (!name) continue;
    if (!byMarket.has(name)) byMarket.set(name, []);
    byMarket.get(name).push(r);
  }

  for (const symbol of (symbols || [])) {
    const market = MARKETS[symbol];
    if (!market) continue;                                   // not covered - not an error
    const rowsForMarket = (byMarket.get(market) || []).slice()
      .sort((a, b) => new Date(b.report_date_as_yyyy_mm_dd) - new Date(a.report_date_as_yyyy_mm_dd));
    if (!rowsForMarket.length) {
      out.push({ id: ID, symbol, market, state: 'no_data', reason: `no rows for ${market} in the fetched window`, asOf: null });
      continue;
    }
    const newest = rowsForMarket[0];
    const asOf = newest.report_date_as_yyyy_mm_dd || null;
    const long = numOrNull(newest.m_money_positions_long_all);
    const short = numOrNull(newest.m_money_positions_short_all);
    const spread = numOrNull(newest.m_money_positions_spread);
    const oi = numOrNull(newest.open_interest_all);

    // An absent field is NOT zero. Report it as incomplete rather than computing a net from a
    // fabricated short side.
    if (long == null || short == null) {
      out.push({
        id: ID, symbol, market, state: 'incomplete', asOf, cadence: CADENCE,
        reason: `managed-money long/short missing in the newest row (long=${newest.m_money_positions_long_all}, short=${newest.m_money_positions_short_all})`,
      });
      continue;
    }

    const net = long - short;
    const nets = rowsForMarket.map((r) => {
      const l = numOrNull(r.m_money_positions_long_all);
      const s = numOrNull(r.m_money_positions_short_all);
      return l == null || s == null ? null : l - s;
    });
    const ageDays = asOf ? Math.round(daysBetween(asOf, now) * 10) / 10 : null;
    out.push({
      id: ID, symbol, market, state: 'ok',
      asOf,
      cadence: CADENCE,
      ageDays,
      // Freshness judged against the CADENCE, not a tick SLA. A 7-day report is current; a report
      // that has stopped advancing is not, and the two must not look the same.
      fresh: ageDays != null && ageDays <= STALE_AFTER_DAYS,
      staleAfterDays: STALE_AFTER_DAYS,
      managedMoneyLong: long,
      managedMoneyShort: short,
      managedMoneySpread: spread,
      net,
      netPctOfOpenInterest: oi ? Math.round((net / oi) * 1000) / 10 : null,
      openInterest: oi,
      changeNet: (numOrNull(newest.change_in_m_money_long_all) != null && numOrNull(newest.change_in_m_money_short_all) != null)
        ? numOrNull(newest.change_in_m_money_long_all) - numOrNull(newest.change_in_m_money_short_all)
        : null,
      // "Positioning extreme" is the signal the catalogue justifies this source with, and a raw net
      // is not that. The window travels WITH the number so it can never be quoted bare.
      netPercentile: percentileOfNewest(nets),
      percentileWindowWeeks: Math.min(rowsForMarket.length, weeks),
      observations: rowsForMarket.length,
    });
  }
  return out;
}

// Thin. The fetch is injected so tests never touch the network; `record` decides whether the result
// is journalled (the caller owns the store, this module owns the parsing).
async function fetchLatest({ symbols = [], now = new Date(), fetchImpl = fetch, weeks = WINDOW_WEEKS, timeoutMs = 15000 } = {}) {
  const url = buildUrl({ symbols, weeks });
  if (!url) return { id: ID, ok: false, reason: 'no watched symbol is covered by this source', observations: [] };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return { id: ID, ok: false, reason: `HTTP ${res.status} from ${PROVIDER}`, observations: [] };
    const rows = await res.json();
    const observations = parse(rows, { now, symbols, weeks });
    const usable = observations.filter((o) => o.state === 'ok');
    return {
      id: ID, ok: usable.length > 0, provider: PROVIDER, url,
      fetchedAt: new Date(now).toISOString(),
      rows: rows.length,
      observations,
      // The source's own as-of is the NEWEST report date across markets, so one lagging market
      // cannot be reported as the source being current.
      asOf: usable.length ? usable.map((o) => o.asOf).sort().slice(-1)[0] : null,
      reason: usable.length ? null : 'fetched, but no usable observation',
    };
  } catch (e) {
    return { id: ID, ok: false, reason: `${e.name === 'AbortError' ? 'timed out' : 'fetch failed'}: ${String(e.message || e).slice(0, 120)}`, observations: [] };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { ID, PROVIDER, ENDPOINT, MARKETS, CADENCE, STALE_AFTER_DAYS, WINDOW_WEEKS, SELECT, buildUrl, parse, fetchLatest, marketNamesFor };
