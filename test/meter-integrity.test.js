// test/meter-integrity.test.js — TRD-77: the detector for a meter that ran blind for four days.
//
// The first test is a faithful reproduction of the actual incident as a fixture, because the whole
// point of this module is one conjunction that held for four days and nothing noticed:
//
//     rows written   AND   tokens read as zero
//
// Everything else here pins the SHAPE of the detector rather than the incident: that it reads the
// same population through a different code path, that it refuses to call an idle day a healthy one,
// and that it does not fire on a redacted CREDENTIAL (which is correct behaviour, not damage).
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { assess, inspect, METER_TRUSTED_FROM } = require('../trading/agent/meterIntegrity');

test('the four-day failure reproduces as BAD, from the shape of the data alone', () => {
  // 2026-09-10 .. 09-14: llm_usage rows existed every day, and every token field read "[REDACTED]",
  // which TRY_CASTs to NULL and sums as 0. The meter reported total: 0 for every consumer while the
  // desk was making chair, review, shadow and pulse calls.
  const r = assess({
    dbEvents: 137,            // rows written (SQL count)
    dbTokens: 0,              // fields unreadable
    meteredTokens: 0,
    meteredCalls: 137,
    fetched: 137,
    cap: 500,
    requestedLimit: 500,
    consumers: ['chair', 'review'],
    seenConsumers: ['chair', 'review'],
    redactedKeys: ['completionTokens', 'promptTokens'],
  });
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes('blind'), 'the rows-exist-tokens-zero conjunction must be named');
  assert.ok(codes.includes('counter_redacted'), 'and the direct payload assertion must fire too');
  // Two independent statements of the same fact: one about the payload, one about the meter. Either
  // alone is enough to page; both firing is the honest amount of evidence.
  assert.equal(r.status, 'bad');
});

test('a redacted CREDENTIAL is not damage — only a redacted COUNTER is', () => {
  const healthy = {
    dbEvents: 10, dbTokens: 4000, meteredTokens: 4000, meteredCalls: 10,
    fetched: 10, cap: 500, requestedLimit: 500,
    consumers: ['chair'], seenConsumers: ['chair'],
  };
  // `congress.token` IS redacted and IS supposed to be: it is a secret, not a count. A blanket rule
  // would have made this module fire on correct behaviour and taught the operator to ignore it.
  assert.equal(assess({ ...healthy, redactedKeys: ['token'] }).status, 'ok');
  assert.equal(assess({ ...healthy, redactedKeys: [] }).status, 'ok');
  // The counter is the one that must fire, and it needs no threshold to do it.
  const damaged = assess({ ...healthy, redactedKeys: ['promptCacheHitTokens'] });
  assert.equal(damaged.status, 'bad');
  assert.equal(damaged.findings.filter((f) => f.code === 'counter_redacted').length, 1);
  // A mixed payload fires on the counter and names ONLY the counter — the credential stays out of
  // the report, because naming it would imply it should have been kept.
  const mixed = assess({ ...healthy, redactedKeys: ['token', 'completionTokens'] });
  assert.equal(mixed.status, 'bad');
  assert.equal(mixed.findings.filter((f) => f.code === 'counter_redacted').length, 1);
  assert.match(mixed.findings.find((f) => f.code === 'counter_redacted').detail, /completionTokens/);
});

test('the two reads are compared, and under-reading pages', () => {
  const base = { dbEvents: 20, cap: 500, requestedLimit: 500, consumers: ['chair'], seenConsumers: ['chair'] };
  // Agreement is the healthy case, and the detail states the number rather than a verdict word.
  const ok = assess({ ...base, dbTokens: 5000, meteredTokens: 5000, meteredCalls: 20, fetched: 20 });
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /5,000 tokens metered/);

  // The meter losing usage is BAD: a cap that reads low is a cap that cannot trip.
  const under = assess({ ...base, dbTokens: 5000, meteredTokens: 1200, meteredCalls: 20, fetched: 20 });
  assert.equal(under.status, 'bad');
  assert.ok(under.findings.some((f) => f.code === 'meter_under_read'));

  // The meter counting MORE than was written is a drift, not a blindness — worth a warn.
  const over = assess({ ...base, dbTokens: 5000, meteredTokens: 6100, meteredCalls: 20, fetched: 20 });
  assert.equal(over.status, 'warn');
  assert.ok(over.findings.some((f) => f.code === 'meter_over_read'));
});

test('row loss and page-cap saturation are separated by whether loss is PROVABLE', () => {
  const base = { dbEvents: 620, dbTokens: 9000, meteredTokens: 7200, cap: 500, requestedLimit: 500, consumers: ['chair'], seenConsumers: ['chair'] };

  // The SQL count is unbounded by the page cap, so a dropped row is PROVABLE — and a total that is
  // really a floor is a bad state, not a caution.
  const dropped = assess({ ...base, meteredCalls: 500, fetched: 500 });
  assert.equal(dropped.status, 'bad');
  assert.ok(dropped.findings.some((f) => f.code === 'meter_dropped_rows'));
  assert.equal(dropped.saturated, true, 'saturation is still reported as context');

  // A full page where the independent count AGREES is not a defect: the numbers explain the page.
  // This ran live and warned on a healthy desk, which is the alert-fatigue failure this codebase
  // keeps hitting — the saturation is stated in the detail, not as a finding.
  const explained = assess({ dbEvents: 500, dbTokens: 7000, meteredTokens: 7000, meteredCalls: 500, fetched: 500, cap: 500, requestedLimit: 500, consumers: ['chair'], seenConsumers: ['chair'] });
  assert.equal(explained.status, 'ok');
  assert.equal(explained.saturated, true);
  assert.match(explained.detail, /nothing was dropped/);

  // No proof of loss, and comfortably inside the cap: nothing to say.
  const fine = assess({ dbEvents: 40, dbTokens: 100, meteredTokens: 100, meteredCalls: 40, fetched: 40, cap: 500, requestedLimit: 500, consumers: ['chair'], seenConsumers: ['chair'] });
  assert.equal(fine.status, 'ok');
  assert.equal(fine.saturated, false);
});

test('an unknown consumer is reported even when every number agrees', () => {
  // budget.record() RETURNS EARLY for a consumer that is not on the allowlist, so the spend is
  // recorded and never capped — TRD-75, where a whole agent was invisible in both directions while
  // the report claimed it was metered. Every count here is consistent; only membership is wrong.
  const r = assess({
    dbEvents: 12, dbTokens: 3000, meteredTokens: 3000, meteredCalls: 12, fetched: 12,
    cap: 500, requestedLimit: 500,
    consumers: ['chair', 'review'], seenConsumers: ['chair', 'binding'],
  });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /binding/);
});

test('an idle day is UNTESTED, and the wording refuses to call it healthy', () => {
  const r = assess({ dbEvents: 0, dbTokens: 0, meteredTokens: 0, meteredCalls: 0, fetched: 0, cap: 500, requestedLimit: 500 });
  assert.equal(r.status, 'ok', 'an idle desk must not page');
  // ...but "0" is exactly what the blind meter reported, so the detail must not be read as a pass.
  assert.match(r.detail, /untested, not verified/);
});

test('a caller asking for more than the page cap is told it cannot be honoured', () => {
  const r = assess({
    dbEvents: 5, dbTokens: 10, meteredTokens: 10, meteredCalls: 5, fetched: 5,
    cap: 500, requestedLimit: 2000, consumers: ['chair'], seenConsumers: ['chair'],
  });
  assert.equal(r.status, 'warn');
  assert.ok(r.findings.some((f) => f.code === 'limit_clamped'));
});

test('a missing input is not read as zero — an absent call count must not manufacture a defect', () => {
  const r = assess({ dbEvents: 30, dbTokens: 900, meteredTokens: 900, fetched: 30, cap: 500, requestedLimit: 500 });
  assert.equal(r.status, 'ok');
  assert.equal(r.findings.length, 0);
});

test('inspect reads its own population, so the meter cannot hide its input from it', async () => {
  const now = new Date().toISOString();
  const rows = [
    { createdAt: now, payload: { consumer: 'chair', completionTokens: 500, promptTokens: 500 } },
    { createdAt: now, payload: { consumer: 'review', completionTokens: 400, promptTokens: 400 } },
  ];
  const stubStore = {
    EVENT_QUERY_CAP: 500,
    llmUsageSince: async () => ({ events: 2, tokens: 1800 }),
    listEvents: async () => rows,
  };
  const stubBudget = {
    CONSUMERS: ['chair', 'review'],
    todayUsage: async () => ({ total: 1800, by: { chair: 1000, review: 800 }, calls: 2, fetched: 2, requestedLimit: 500 }),
  };
  const ok = await inspect(1, { store: stubStore, budget: stubBudget });
  assert.equal(ok.status, 'ok');

  // The same rows, with the meter blind while the DATABASE can still read them: the meter is
  // dropping usage, which is provable against the SQL sum WITHOUT trusting anything the meter says
  // about itself. Note this is NOT `blind` — `blind` is reserved for the case where the FIELDS are
  // gone and the SQL read is zero too. Two different failures, two different codes.
  const blind = await inspect(1, {
    store: stubStore,
    budget: { CONSUMERS: ['chair', 'review'], todayUsage: async () => ({ total: 0, by: {}, calls: 2, fetched: 2, requestedLimit: 500 }) },
  });
  assert.equal(blind.status, 'bad');
  assert.ok(blind.findings.some((f) => f.code === 'meter_under_read'), 'the SQL read sees tokens the meter reports as zero');
  assert.equal(blind.findings.some((f) => f.code === 'blind'), false, 'blind means the DATA is gone, not that the meter dropped it');

  // ...and the actual incident, where the fields themselves are unreadable: the SQL sum is zero as
  // well, so `blind` fires. This is the distinction that makes the two codes worth having.
  const damagedData = await inspect(1, {
    store: { ...stubStore, llmUsageSince: async () => ({ events: 2, tokens: 0 }) },
    budget: { CONSUMERS: ['chair', 'review'], todayUsage: async () => ({ total: 0, by: {}, calls: 2, fetched: 2, requestedLimit: 500 }) },
  });
  assert.equal(damagedData.status, 'bad');
  assert.ok(damagedData.findings.some((f) => f.code === 'blind'), 'rows exist and tokens read zero in BOTH reads');

  // Damage in the payload is visible to inspect without any comparison at all.
  const damaged = await inspect(1, {
    store: { ...stubStore, listEvents: async () => [{ createdAt: now, payload: { consumer: 'chair', redacted: ['promptTokens'] } }] },
    budget: stubBudget,
  });
  assert.equal(damaged.status, 'bad');
  assert.ok(damaged.findings.some((f) => f.code === 'counter_redacted'));
});

test('the unmeasurable era is stated as a fact about the record, with its date', () => {
  // A spend report over 2026-09-10..09-14 must render "not measurable", never zero. The constant is
  // the date the record became readable, and it must move only with evidence.
  assert.equal(METER_TRUSTED_FROM, '2026-09-14T17:51:00Z');
  const stamp = Date.parse(METER_TRUSTED_FROM);
  assert.ok(Number.isFinite(stamp), 'the boundary must be a real instant');
});
