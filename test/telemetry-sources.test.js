'use strict';
// TRD-75 (telemetry catalogue) — the physical/structural sources, and what the desk is BLIND to.
//
// The guard that matters most here: DECLARED is not WIRED. The first version of availability() called
// any source with a URL and no credential requirement "ready", so cftc_cot_positioning - which nothing
// in the repo fetches - reported as available. The proposer would then have reasoned as if the data were
// in hand. A catalogue that overstates itself is worse than no catalogue.
const test = require('node:test');
const assert = require('node:assert');
const tel = require('../trading/agent/telemetrySources');

const EMPTY = {};                               // no provider credentials at all
const KEYED = { EIA_API_KEY: 'k', FRED_API_KEY: 'k' };
const byId = (id) => tel.SOURCES.find((s) => s.id === id);

test('TRD-75: every source declares what it is, what it covers and WHY', () => {
  assert.ok(tel.SOURCES.length >= 6, 'the catalogue must actually contain the commodity set');
  for (const s of tel.SOURCES) {
    assert.ok(s.id && s.label, `source ${s.id || '(no id)'} needs an id and a label`);
    assert.ok(Array.isArray(s.instruments) && s.instruments.length, `${s.id} must name the instruments it is for`);
    assert.ok(String(s.why || '').length > 30, `${s.id} must justify itself - a catalogue of merely-available sources is how telemetry sprawls`);
    assert.ok(Object.values(tel.KIND).includes(s.kind), `${s.id} has an unknown kind ${s.kind}`);
  }
});

test('TRD-75: the catalogue covers the instruments the owner named', () => {
  assert.ok(tel.applicable('Oil').some((s) => s.id === 'eia_crude_stocks'), 'Oil needs inventories');
  assert.ok(tel.applicable('Gold').some((s) => s.provider === 'FRED'), 'Gold needs the macro/real-yield side');
  assert.ok(tel.applicable('Arabica Coffee').some((s) => s.kind === tel.KIND.SEASONAL), 'Coffee needs weather');
  assert.deepEqual(tel.applicable('SGX'), [], 'an equity index has no physical telemetry - and the catalogue says so rather than inventing some');
});

test('TRD-75: a key-only source is needs_key, NOT ready, even with the key set', () => {
  assert.equal(tel.availability(byId('eia_crude_stocks'), EMPTY).state, 'needs_key');
  // The key is not the blocker - the adapter is. This is the overclaim that was caught by writing this.
  const withKey = tel.availability(byId('eia_crude_stocks'), KEYED);
  assert.equal(withKey.configured, true);
  assert.equal(withKey.implemented, false);
  assert.equal(withKey.state, 'needs_adapter', 'a declared source with credentials is still not wired');
  assert.match(withKey.reason, /NO ADAPTER IS WRITTEN|adapter present/);
});

test('TRD-75: a keyless source is ready ONLY once an adapter exists (TRD-76 wired the first one)', () => {
  // TRD-76 changed this answer, and the change is the point: cftc_cot_positioning was the source that
  // proved "declared is not wired", because it needed no key and had a URL while nothing fetched it.
  // It now HAS an adapter, and the registry is what says so.
  const cftc = tel.availability(byId('cftc_cot_positioning'), EMPTY);
  assert.equal(cftc.configured, true, 'no key required');
  assert.equal(cftc.implemented, true);
  assert.equal(cftc.state, 'ready');

  // The BRANCH is tested with a synthetic source, so this stops depending on the current state of any
  // real source: a keyless source declaring a network adapter it does not have is needs_adapter. It must
  // carry a route, because "declares an adapter" and "has no endpoint" are now contradictory - the second
  // is its own state (see the no_route test below).
  const synthetic = { id: 'no_such_adapter', route: 'https://example.invalid/series', requiresKey: null, implemented: true, implementedBy: 'adapter' };
  assert.equal(tel.availability(synthetic, EMPTY).state, 'needs_adapter');
});

test('the corrected catalogue asks for NO credential the feed does not want', () => {
  // ★ Corrected 2026-09-15 by testing the endpoints instead of trusting the declaration. Each of these
  // sent the owner looking for a signup that was never the blocker.
  for (const id of ['fred_real_yield_10y', 'weather_brazil_frost']) {
    assert.equal(byId(id).requiresKey, null, `${id} is fetchable WITHOUT a credential (verified live)`);
    assert.ok(byId(id).route, `${id} must carry the route that makes it fetchable`);
  }
  // OPEC needed NEITHER: a credential it cannot spend, on an endpoint that does not exist.
  assert.equal(byId('opec_production').requiresKey, null, 'a key was never the blocker');
  assert.equal(byId('opec_production').route, null, 'and there is nowhere to send one');
  // EIA genuinely does require one - verified as HTTP 403 without it - and must keep saying so.
  assert.equal(byId('eia_crude_stocks').requiresKey, 'EIA_API_KEY');
});

test('★ NO ROUTE is a different gap from NO KEY, and is never reported as a missing credential', () => {
  // The failure this prevents: "OPEC_API_KEY is not set" sends the owner to buy a key for a feed that does
  // not exist. A source with nowhere to send a credential needs a PROVIDER DECISION.
  for (const id of ['opec_production', 'fred_cb_gold_holdings']) {
    const a = tel.availability(byId(id), EMPTY);
    assert.equal(a.state, 'no_route', `${id} has no endpoint, so a key cannot help`);
    assert.equal(a.configured, true, 'it does not claim to need a credential');
    assert.doesNotMatch(a.reason, /_API_KEY is not set/, 'never answer a no-route gap with "go and get a key"');
  }
});

test('★ a route-less source wired INTERNALLY is still ready, not no_route', () => {
  // venue_funding_basis has route:null because it is stored, not fetched. The no_route check must sit AFTER
  // the ready return, or the one genuinely-wired source in the catalogue is demoted - the same
  // registry-only mistake this file already records for implementedBy.
  assert.equal(byId('venue_funding_basis').route, null);
  assert.equal(tel.availability(byId('venue_funding_basis'), EMPTY).state, 'ready');
});

test('the caveat travels with the source, so "we have weather" is not read as "we have a frost signal"', () => {
  const a = tel.availability(byId('weather_brazil_frost'), EMPTY);
  assert.equal(a.state, 'needs_adapter', 'the DATA is fetchable; the adapter is the work');
  assert.match(a.reason, /what counts as a frost event/, 'the open question must reach the reviewer');
  assert.equal(a.caveat, byId('weather_brazil_frost').caveat);
});

test('TRD-75: the one source that genuinely exists reports ready', () => {
  const funding = tel.availability(byId('venue_funding_basis'), EMPTY);
  assert.equal(funding.state, 'ready', 'the desk really does store venue funding clocks (TRD-50)');
});

test('TRD-75: isConfigured treats a null requirement as satisfied, not as missing', () => {
  assert.equal(tel.isConfigured(byId('cftc_cot_positioning'), EMPTY), true);
  assert.equal(tel.isConfigured(byId('eia_crude_stocks'), EMPTY), false);
  assert.equal(tel.isConfigured(byId('eia_crude_stocks'), null), false, 'a missing env must not throw');
});

test('TRD-75: coverage names what the desk is BLIND to, per instrument', () => {
  const cov = tel.coverage(['Oil', 'Gold', 'Bitcoin', 'SGX'], EMPTY);
  // TRD-76 wired CFTC positioning, which needs no credential - so Oil is no longer at zero ready.
  assert.equal(cov.Oil.ready, 1, 'positioning is wired; the keyed sources are not');
  assert.ok(cov.Oil.declared >= 4, `Oil should declare the EIA + positioning set, got ${cov.Oil.declared}`);
  assert.ok(cov.Oil.needsKey.includes('eia_crude_stocks'));
  assert.ok(cov.Oil.needsRoute.includes('opec_production'), 'the Oil blind spots now separate "no feed" from "no key"');
  assert.ok(!cov.Oil.needsKey.includes('opec_production'), 'OPEC must not be reported as a missing credential');
  assert.ok(!cov.Oil.needsAdapter.includes('cftc_cot_positioning'), 'it has an adapter now');
  assert.equal(cov.Oil.blindTo.length, cov.Oil.declared - 1, 'exactly one source stopped being a blind spot');
  assert.equal(cov.Bitcoin.ready, 1, 'funding basis is wired');
  assert.equal(cov.SGX.declared, 0);
  assert.deepEqual(cov.SGX.blindTo, [], 'nothing declared and nothing to be blind to - but declared:0 says so');
});

test('TRD-75: describe() is honest in both directions', () => {
  const lines = tel.describe(['Oil', 'Bitcoin', 'SGX'], EMPTY);
  assert.match(lines[0], /^Oil: 1\/\d+ ready; BLIND to /);
  assert.match(lines[1], /^Bitcoin: 1\/1 sources ready/);
  assert.match(lines[2], /no physical\/structural telemetry declared/);
});

test('TRD-75: the catalogue is a pure function of the env it is handed', () => {
  // No hidden process.env read: the same env gives the same answer, and a different env changes it.
  assert.equal(tel.coverage(['Oil'], EMPTY).Oil.ready, tel.coverage(['Oil'], EMPTY).Oil.ready);
  assert.equal(tel.coverage([], EMPTY).Oil, undefined, 'an empty symbol list covers nothing');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'trading/agent/telemetrySources.js'), 'utf8');
  const fn = src.slice(src.indexOf('function availability'), src.indexOf('function coverage'));
  assert.ok(fn.length > 100, 'slice guard');
  // `env = process.env` as an OVERRIDABLE DEFAULT is fine and is the point; reaching for process.env
  // inside the body is not, because then no test could pin the answer.
  assert.match(fn.slice(0, fn.indexOf('{')), /\(source,\s*env/, 'env must be a parameter');
  assert.ok(!/process\.env/.test(fn.slice(fn.indexOf('{'))), 'availability must not read the real env inside its body');
});
