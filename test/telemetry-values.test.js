// test/telemetry-values.test.js — TRD-76: recording, reading back, and the two freshness checks.
//
// The load-bearing assertions: freshness is judged at READ time from the report's own date (so a weekly
// figure cannot become current by being recorded recently), a source that failed is RECORDED rather
// than silently absent, and the reviewer's view keeps "a source exists" visually distinct from "this is
// what it says".
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const values = require('../trading/agent/telemetry/values');
const cftc = require('../trading/agent/telemetry/cftcCot');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cftc-cot.json'), 'utf8'));
const NOW = new Date('2026-09-15T10:00:00Z');

const event = (payload, at) => ({ createdAt: at || NOW.toISOString(), payload });

test('TRD-76: freshness is recomputed at READ time from the report date', () => {
  const fresh = values.decorate([event({
    sourceId: cftc.ID, provider: 'CFTC', ok: true, asOf: '2026-09-08T00:00:00.000', cadence: 'weekly',
    observations: cftc.parse(fixture.rows, { now: NOW, symbols: ['Gold'], weeks: 4 }),
  })], { now: NOW });
  assert.equal(fresh[cftc.ID].observations[0].fresh, true);
  assert.equal(fresh[cftc.ID].ageDays, 7.8);

  // THE SAME RECORDED EVENT, read 40 days later. Nothing about the event changed - only the clock -
  // and the value must stop reading as current. A figure recorded recently is not a current figure.
  const later = values.decorate([event({
    sourceId: cftc.ID, provider: 'CFTC', ok: true, asOf: '2026-09-08T00:00:00.000', cadence: 'weekly',
    observations: cftc.parse(fixture.rows, { now: NOW, symbols: ['Gold'], weeks: 4 }),
  })], { now: new Date('2026-10-18T00:00:00Z') });
  assert.equal(later[cftc.ID].observations[0].fresh, false);
  assert.ok(later[cftc.ID].observations[0].ageDays > 39);
  assert.equal(later[cftc.ID].staleAfterDays, cftc.STALE_AFTER_DAYS);
  // The value is still REPORTED with its date: suppressing it would hide the feed failure, and
  // presenting it without its age would hide it differently.
  assert.equal(later[cftc.ID].observations[0].net, fresh[cftc.ID].observations[0].net);
  assert.equal(later[cftc.ID].observations[0].asOf, '2026-09-08T00:00:00.000');
});

test('TRD-76: the newest observation per source wins, and a failure is recorded as one', () => {
  const decorated = values.decorate([
    event({ sourceId: cftc.ID, ok: false, reason: 'timed out', observations: [] }, '2026-09-15T08:00:00Z'),
    event({ sourceId: cftc.ID, ok: true, asOf: '2026-09-08T00:00:00.000', observations: cftc.parse(fixture.rows, { now: NOW, symbols: ['Gold'], weeks: 4 }) }, NOW.toISOString()),
    event({ sourceId: 'another_source', ok: false, reason: 'HTTP 503', observations: [] }, NOW.toISOString()),
  ], { now: NOW });
  assert.equal(decorated[cftc.ID].ok, true);
  assert.equal(decorated[cftc.ID].reason, null);
  // A source that broke is a fact in the log, not an absence - silence is indistinguishable from
  // "never asked".
  assert.equal(decorated.another_source.ok, false);
  assert.match(decorated.another_source.reason, /HTTP 503/);
  assert.equal(decorated.another_source.observations.length, 0);
});

test('TRD-76: an unfinished observation survives the round trip without becoming a number', () => {
  const rows = [{ ...fixture.rows[0], m_money_positions_short_all: null }];
  const decorated = values.decorate([event({
    sourceId: cftc.ID, ok: true, asOf: '2026-09-08T00:00:00.000', cadence: 'weekly',
    observations: cftc.parse(rows, { now: NOW, symbols: ['Gold'], weeks: 1 }),
  })], { now: NOW });
  const o = decorated[cftc.ID].observations[0];
  assert.equal(o.state, 'incomplete');
  assert.equal(o.net, undefined, 'an incomplete row must not acquire a net on the way through storage');
  assert.deepEqual(values.render(decorated, ['Gold']).Gold[0].state, 'incomplete');
});

test('TRD-76: the reviewer view carries the as-of, the age and the window — not just a value', () => {
  const decorated = values.decorate([event({
    sourceId: cftc.ID, ok: true, asOf: '2026-09-08T00:00:00.000', cadence: 'weekly',
    observations: cftc.parse(fixture.rows, { now: NOW, symbols: ['Gold', 'Silver'], weeks: 4 }),
  })], { now: NOW });
  const view = values.render(decorated, ['Gold', 'Silver', 'SGX']);
  assert.deepEqual(Object.keys(view).sort(), ['Gold', 'Silver'], 'a symbol with no values is ABSENT, not zero-valued');
  const g = view.Gold[0];
  assert.equal(g.source, cftc.ID);
  assert.equal(g.asOf, '2026-09-08', 'the date travels with the value');
  assert.equal(g.cadence, 'weekly');
  assert.equal(g.ageDays, 7.8);
  assert.equal(g.fresh, true);
  assert.equal(typeof g.managedMoneyNet, 'number');
  // A percentile is unquotable without its window, so the window is part of the payload.
  assert.equal(g.netPercentile, null);
  assert.equal(g.percentileWindowWeeks, 4);
});

test('TRD-76: the signature moves on a NEW report and not on a re-render of the same one', () => {
  const mk = (asOf) => values.decorate([event({
    sourceId: cftc.ID, ok: true, asOf, cadence: 'weekly',
    observations: cftc.parse(fixture.rows, { now: NOW, symbols: ['Gold'], weeks: 4 }),
  })], { now: NOW });
  const a = values.signatureOf(mk('2026-09-08T00:00:00.000'));
  const b = values.signatureOf(mk('2026-09-08T00:00:00.000'));
  const c = values.signatureOf(mk('2026-09-15T00:00:00.000'));
  assert.deepEqual(a, b, 're-reading the same report must not churn the reviewer');
  assert.notDeepEqual(a, c, 'a new report IS new evidence and must be reconsidered');
  assert.equal(a[cftc.ID], '2026-09-08T00:00:00.000');
});

test('TRD-76: record() journals one event per source, with the values, using an injected fetch', async () => {
  const logged = [];
  const stubStore = { logEvent: async (userId, kind, payload) => { logged.push({ kind, payload }); } };
  const fakeFetch = async () => ({ ok: true, json: async () => fixture.rows });
  const out = await values.record(1, { symbols: ['Gold', 'Silver'], now: NOW, fetchImpl: fakeFetch, store: stubStore });
  assert.equal(out.written.length, 1, 'one wired source');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].kind, 'telemetry_observation');
  assert.equal(logged[0].payload.sourceId, cftc.ID);
  assert.equal(logged[0].payload.ok, true);
  assert.equal(logged[0].payload.observations.length, 2);

  // A failing fetch still produces a journalled event: the failure must be visible.
  const boom = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const logged2 = [];
  const out2 = await values.record(1, {
    symbols: ['Gold'], now: NOW, fetchImpl: boom,
    store: { logEvent: async (userId, kind, payload) => { logged2.push(payload); } },
  });
  assert.equal(out2.written[0].ok, false);
  assert.match(out2.written[0].reason, /ENOTFOUND/);
  assert.equal(logged2.length, 1, 'the failure is recorded, not swallowed');
});

test('TRD-76: a journalling failure does not break the pull', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => fixture.rows });
  const out = await values.record(1, {
    symbols: ['Gold'], now: NOW, fetchImpl: fakeFetch,
    store: { logEvent: async () => { throw new Error('DB down'); } },
  });
  assert.equal(out.written.length, 0, 'nothing recorded');
  assert.equal(out.results.length, 1, 'but the collect still completed and reported');
  assert.equal(out.results[0].ok, true);
});
