// test/cftc-cot.test.js — TRD-76: the first WIRED physical source, tested against REAL provider rows.
//
// The fixture is not hand-written. It was captured 2026-09-15 through this adapter's own buildUrl from
// publicreporting.cftc.gov, so it pins the provider's actual column names, its actual string-typed
// numbers and its actual date format. The TRD-45 lesson applies directly: a synthetic fixture and a
// parser agree with each other by construction, and the disagreements only show up against real data.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const cftc = require('../trading/agent/telemetry/cftcCot');
const registry = require('../trading/agent/telemetry');
const tel = require('../trading/agent/telemetrySources');

const FIXTURE = path.join(__dirname, 'fixtures', 'cftc-cot.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const NOW = new Date('2026-09-15T10:00:00Z');

test('TRD-76: the query orders by report date, because the provider does not', () => {
  const url = cftc.buildUrl({ symbols: ['Gold'] });
  assert.match(url, /resource\/72hh-3qpy\.json/, 'the disaggregated futures-only resource');
  // THE TRAP THIS PINS: the default order is by id ASCENDING, so $limit=1 returns a 2022 row. Without
  // an explicit order this source would serve four-year-old positioning as the latest report.
  assert.match(decodeURIComponent(url), /\$order=report_date_as_yyyy_mm_dd DESC/);
  // Only the nine columns the signal needs: the full row is 194 columns / ~4.7 KB.
  assert.match(decodeURIComponent(url), /\$select=[^&]*m_money_positions_long_all/);
  assert.ok(!decodeURIComponent(url).includes('$select=*'), 'never ask for the whole 194-column row');
  // A source that covers nothing must not build a query that returns everything.
  assert.equal(cftc.buildUrl({ symbols: ['SGX'] }), null);
  assert.equal(cftc.buildUrl({ symbols: [] }), null);
});

test('TRD-76: the market mapping names the RIGHT contract, not just a matching one', () => {
  // `CRUDE OIL, LIGHT SWEET-WTI` also resolves in the dataset, but on ICE FUTURES EUROPE - it is not
  // the NYMEX contract the desk means. A name that matches is not the same as the right instrument.
  assert.equal(cftc.MARKETS.Oil, 'WTI-PHYSICAL');
  assert.equal(cftc.MARKETS.Brent, undefined, 'the desk symbol is "Brent Oil"');
  assert.equal(cftc.MARKETS['Brent Oil'], 'BRENT LAST DAY');
  assert.deepEqual(cftc.marketNamesFor(['SGX', 'Gold']), ['GOLD'], 'uncovered symbols are dropped, not guessed');
});

test('TRD-76: real provider rows parse into a positioned, dated observation', () => {
  const obs = cftc.parse(fixture.rows, { now: NOW, symbols: ['Gold', 'Silver'], weeks: 4 });
  const gold = obs.find((o) => o.symbol === 'Gold');
  assert.equal(gold.state, 'ok');
  assert.equal(gold.market, 'GOLD');
  // The provider returns NUMBERS AS STRINGS ("145804"). A parser that trusted typeof number would read
  // this as absent and report a fabricated zero.
  assert.equal(typeof fixture.rows[0].m_money_positions_long_all, 'string', 'the fixture must keep the provider string type');
  assert.equal(typeof gold.managedMoneyLong, 'number');
  assert.equal(gold.net, gold.managedMoneyLong - gold.managedMoneyShort);
  assert.ok(gold.net > 0, 'managed money is net long in this capture');

  // As-of and cadence travel WITH the value: a weekly figure presented as current is the same class of
  // defect as a stale tick presented as live.
  assert.equal(gold.asOf, '2026-09-08T00:00:00.000');
  assert.equal(gold.cadence, 'weekly');
  assert.equal(gold.staleAfterDays, cftc.STALE_AFTER_DAYS);
  assert.equal(gold.ageDays, 7.8);
  assert.equal(gold.fresh, true, 'a 7.8-day-old weekly report is CURRENT, not stale');

  // A percentile needs history. Four weekly points cannot support one, and saying so beats inventing it.
  assert.equal(gold.netPercentile, null);
  assert.equal(gold.percentileWindowWeeks, 4);

  const silver = obs.find((o) => o.symbol === 'Silver');
  assert.equal(silver.state, 'ok');
  assert.equal(silver.market, 'SILVER');
  assert.equal(obs.length, 2, 'unrequested markets are not emitted');
});

test('TRD-76: freshness is judged against the CADENCE, and an advancing report is not made current by hope', () => {
  const row = { ...fixture.rows[0] };
  // Same real shape, dated 45 days back: the feed has stopped advancing.
  const old = { ...row, report_date_as_yyyy_mm_dd: '2026-08-01T00:00:00.000' };
  const obs = cftc.parse([old], { now: NOW, symbols: ['Gold'], weeks: 1 });
  assert.equal(obs[0].fresh, false);
  assert.ok(obs[0].ageDays > cftc.STALE_AFTER_DAYS);
  // The value is still REPORTED - it is real data, it is just not current. Suppressing it would hide
  // the feed failure; presenting it without its age would hide it differently.
  assert.ok(obs[0].net > 0);
  assert.equal(obs[0].asOf, '2026-08-01T00:00:00.000');
});

test('TRD-76: an absent field is INCOMPLETE, never zero', () => {
  // `Number(null) === 0`, so a bare coercion turns a missing short side into "no shorts at all" - a
  // fabricated maximum-long positioning extreme. This repo has hit that trap three times.
  const partial = { ...fixture.rows[0], m_money_positions_short_all: null };
  const obs = cftc.parse([partial], { now: NOW, symbols: ['Gold'], weeks: 1 });
  assert.equal(obs[0].state, 'incomplete');
  assert.equal(obs[0].net, undefined, 'no net is computed from a fabricated zero');
  assert.match(obs[0].reason, /long\/short missing/);
  assert.equal(obs[0].asOf, '2026-09-08T00:00:00.000', 'the row still reports its date');

  // An empty string is the same absence, and an unparseable string is too.
  for (const bad of ['', 'n/a']) {
    const o = cftc.parse([{ ...fixture.rows[0], m_money_positions_short_all: bad }], { now: NOW, symbols: ['Gold'], weeks: 1 });
    assert.equal(o[0].state, 'incomplete', `short=${JSON.stringify(bad)} must be incomplete`);
  }
});

test('TRD-76: a market with no rows is no_data, and an uncovered symbol is not an error', () => {
  const obs = cftc.parse([fixture.rows[0]], { now: NOW, symbols: ['Gold', 'Coffee C', 'SGX'], weeks: 1 });
  // 'Coffee C' is not a desk symbol at all - the mapping is what decides coverage, so it is skipped
  // entirely rather than reported as a missing market.
  assert.equal(obs.find((o) => o.symbol === 'SGX'), undefined);
  assert.equal(obs.length, 1);

  const none = cftc.parse([], { now: NOW, symbols: ['Arabica Coffee'], weeks: 1 });
  assert.equal(none[0].state, 'no_data');
  assert.equal(none[0].asOf, null);
  assert.match(none[0].reason, /no rows for COFFEE C/);
});

test('TRD-76: the adapter never throws on a network or provider failure — it reports one', async () => {
  const boom = async () => { throw new Error('socket hang up'); };
  const r1 = await cftc.fetchLatest({ symbols: ['Gold'], now: NOW, fetchImpl: boom });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /socket hang up/);
  assert.deepEqual(r1.observations, []);

  // A non-200 is named, not treated as data.
  const bad = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r2 = await cftc.fetchLatest({ symbols: ['Gold'], now: NOW, fetchImpl: bad });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /HTTP 503/);

  // A source that covers none of the requested symbols makes no request at all.
  let called = 0;
  const spy = async () => { called += 1; return { ok: true, json: async () => [] }; };
  const r3 = await cftc.fetchLatest({ symbols: ['SGX', 'Bitcoin'], now: NOW, fetchImpl: spy });
  assert.equal(r3.ok, false);
  assert.equal(called, 0, 'no query is built for an uncovered symbol set');
  assert.match(r3.reason, /no watched symbol/);
});

test('TRD-76: fetchLatest drives the whole path with an injected fetch', async () => {
  const fake = async (url) => {
    assert.match(decodeURIComponent(url), /\$limit=8/, 'the limit follows the market count x weeks');
    return { ok: true, json: async () => fixture.rows };
  };
  const r = await cftc.fetchLatest({ symbols: ['Gold', 'Silver'], now: NOW, fetchImpl: fake, weeks: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'CFTC');
  assert.equal(r.rows, 8);
  // The source's own as-of is the newest across markets, so one lagging market cannot make the feed
  // look current.
  assert.equal(r.asOf, '2026-09-08T00:00:00.000');
  assert.equal(r.observations.length, 2);
  assert.equal(r.fetchedAt, '2026-09-15T10:00:00.000Z');
});

test('TRD-76: implemented is DERIVED from the registry, so the catalogue cannot overstate itself', () => {
  // The catalogue header records the original bug: a source with a URL and no key requirement was
  // called READY while nothing fetched it. The literal in SOURCES now only DECLARES; the registry
  // decides.
  assert.equal(registry.has('cftc_cot_positioning'), true);
  assert.equal(registry.get('cftc_cot_positioning'), cftc);
  assert.ok(registry.ids().includes('cftc_cot_positioning'));

  const cftcSource = tel.SOURCES.find((s) => s.id === 'cftc_cot_positioning');
  const av = tel.availability(cftcSource, {});
  assert.equal(av.implemented, true);
  assert.equal(av.declaredImplemented, true);
  assert.equal(av.mismatch, null);
  assert.equal(av.state, 'ready', 'public, no key, and an adapter exists');

  // A source that CLAIMS a network adapter with none registered is reported as a contradiction rather
  // than silently believed - this is the original bug the catalogue's header records.
  const liar = { ...cftcSource, id: 'not_a_real_source' };
  const lie = tel.availability(liar, {});
  assert.equal(lie.state, 'needs_adapter');
  assert.equal(lie.implemented, false);
  assert.match(lie.mismatch, /declares implementedBy:adapter but NO adapter is registered/);

  // And the reverse: an adapter registered for a source whose literal says false.
  const shy = { ...cftcSource, id: 'cftc_cot_positioning', implemented: false };
  const shyAv = tel.availability(shy, {});
  assert.equal(shyAv.state, 'ready', 'the registry wins on what is WIRED BY ADAPTER');
  assert.match(shyAv.mismatch, /declares implemented:false but an adapter IS registered/);
});

test('TRD-76: an INTERNAL mechanism is wired without an adapter, and must not be demoted', () => {
  // The first version of the derived flag demoted venue_funding_basis to needs_adapter, because it
  // derived "wired" from the network-adapter registry alone. It IS wired - by internal storage (TRD-50
  // funding clocks in the instrument registry and the Trades ledger). "Wired" has more than one
  // mechanism, and a rule that only knows one of them mislabels real coverage as a gap.
  const funding = tel.availability(tel.SOURCES.find((s) => s.id === 'venue_funding_basis'), {});
  assert.equal(funding.implemented, true);
  assert.equal(funding.implementedBy, 'internal');
  assert.equal(funding.state, 'ready');
  assert.equal(funding.mismatch, null);

  // An unbacked claim (implemented:true, no mechanism named) is NOT counted as wired.
  const unbacked = tel.availability({ id: 'x', requiresKey: null, implemented: true }, {});
  assert.equal(unbacked.implemented, false);
  assert.match(unbacked.mismatch, /unbacked claim/);
});

test('TRD-76: coverage now reports the source ready, and the blind list shrinks by exactly one', () => {
  const cov = tel.coverage(['Oil', 'Gold', 'Bitcoin', 'SGX'], {});
  assert.equal(cov.Oil.ready, 1, 'positioning is wired; the keyed sources are not');
  assert.ok(!cov.Oil.needsAdapter.includes('cftc_cot_positioning'));
  assert.equal(cov.Oil.sources.find((s) => s.id === 'cftc_cot_positioning').state, 'ready');
  assert.equal(cov.Oil.blindTo.length, cov.Oil.declared - 1);
  assert.ok(cov.Gold.ready >= 1, 'Gold is covered by CFTC too');
  assert.equal(cov.SGX.declared, 0, 'an equity index still has no physical telemetry, and the catalogue says so');
});
