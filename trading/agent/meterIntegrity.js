// trading/agent/meterIntegrity.js — TRD-77: does the LLM meter still see the thing it measures?
//
// THE FAILURE THIS EXISTS FOR. The logging denylist matched the substring `token` with no boundary,
// so it struck the token COUNTERS the desk logs. 945 of 1002 `llm_usage` events stored
// "[REDACTED]" for completionTokens/promptTokens, budget.todayUsage() sums them with
// `Number(x) || 0`, and the budget therefore metered ZERO. GET /api/trading/budget rendered a full,
// confident, WRONG table: every consumer listed, every cap shown, every usage zero. For four days.
//
// THE RULE THAT FOLLOWS, and the reason this is a module rather than a sentence in a report:
//
//     A CONTROL THAT CAN FAIL SILENTLY NEEDS A DETECTOR, AND THE DETECTOR MUST BE INDEPENDENT
//     OF THE CONTROL.
//
// "Is usage plausible" cannot work, because a meter reporting 0 is indistinguishable from a desk
// that is idle. So the check compares the meter against a source that does not flow through it:
//
//     * the CALL COUNT and TOKEN SUM are read by SQL, in one statement, bypassing pagination, the
//       `Number(x) || 0` coercion and the meter's field names entirely (`store.llmUsageSince`);
//     * the meter's own answer comes from `budget.todayUsage()`.
//
// Two reads of the same rows, through different code paths. When they disagree, the rows are fine
// and the meter is not — which is the only conclusion the four-day outage needed.
//
// WHY ROWS-EXIST-BUT-TOKENS-ARE-ZERO IS THE SIGNATURE. A redacted field holds the STRING
// "[REDACTED]", which TRY_CASTs to NULL and sums as 0. So the conjunction
// `events > 0 AND tokens === 0` is not a heuristic: it is exactly what corrupting those fields
// produces, and it held every day the meter was blind.
'use strict';

// `dayStartUtc` and `METER_TRUSTED_FROM` are imported rather than restated so the detector and the
// meter cannot disagree about where "today" begins, or about when the record became readable — the
// TRD-52 rule applied to a time boundary instead of a TTL.
const { dayStartUtc, METER_TRUSTED_FROM } = require('./budget');

function finding(code, status, detail) {
  return { code, status, detail };
}

// A redacted COUNTER, as opposed to a redacted credential. `completionTokens`, `promptTokens` and
// `promptCacheHitTokens` all end in `Tokens`; a bare `token` (congress.token, an API token) does
// not, and redacting that is CORRECT. The distinction is the whole reason the denylist exception
// exists (`log.COUNT_KEY`), so the assertion has to name the same thing.
const COUNTER_IN_REDACTED = /tokens$/i;

// Pure. Every input is a number or an array of already-parsed payloads, so the whole verdict is
// testable without a database.
function assess({
  dbEvents = 0,
  dbTokens = 0,
  meteredTokens = 0,
  meteredCalls = null,
  fetched = null,
  pages = null,
  truncated = null,
  cap = null,
  requestedLimit = null,
  consumers = [],
  seenConsumers = [],
  redactedKeys = [],
} = {}) {
  const out = [];
  const events = Number(dbEvents) || 0;
  const db = Number(dbTokens) || 0;
  const metered = Number(meteredTokens) || 0;

  // The rule lives HERE, in the pure function, rather than in the wrapper that does the reading —
  // otherwise the assertion "a redacted counter is damage, a redacted credential is not" is only
  // exercised by an integration path and the pure function silently accepts anything it is handed.
  const redactedCounters = (Array.isArray(redactedKeys) ? redactedKeys : []).filter((k) => COUNTER_IN_REDACTED.test(k));

  // 1. The direct assertion, and the cheapest one: a counter key that reached the redactor. It needs
  // no threshold and no comparison — the payload is either intact or it is not.
  if (redactedCounters.length) {
    out.push(finding('counter_redacted', 'bad',
      `the meter payload is DAMAGED: ${[...new Set(redactedCounters)].join(', ')} were recorded as [REDACTED]. Any field ending in "Tokens" that reaches the redaction denylist zeroes the meter - check log.COUNT_KEY against the field names budget.record() writes.`));
  }

  // 2. The signature conjunction. Rows written, tokens unreadable.
  if (events > 0 && db === 0) {
    out.push(finding('blind', 'bad',
      `${events} LLM call(s) today carry ZERO metered tokens - the meter is blind, not the desk idle. Every cap is unreachable while this holds, and the budget API will report a confident zero.`));
  }

  // 3. Two reads of one population. The SQL sum is the reference because it cannot paginate away.
  if (db !== metered) {
    const under = metered < db;
    out.push(finding(under ? 'meter_under_read' : 'meter_over_read', under ? 'bad' : 'warn',
      `the meter reports ${metered} token(s) where the database sums ${db} over the same day${under ? ' — the meter is losing usage, so a cap can be exceeded without ever tripping' : ' — the meter is counting more than was written, so its own definition has drifted'}`));
  }

  // 4. Rows the meter never counted. Provable only because the SQL read is unbounded by the page cap,
  // and only asserted when the meter's own call count is KNOWN — an absent input must not be read as
  // zero calls, which would manufacture a defect out of a missing argument.
  if (meteredCalls != null && events > Number(meteredCalls)) {
    out.push(finding('meter_dropped_rows', 'bad',
      `${events} call(s) today but the meter counted ${meteredCalls} — ${events - meteredCalls} dropped, most likely by the ${cap || '?'}-row page cap on the event read. The meter's total is a FLOOR being presented as a total.`));
  }

  // 5. Saturation is CONTEXT, not a finding. Once the read is scoped to the window being summed and
  // an independent count exists, a full page is fully explained by the numbers: `meter_dropped_rows`
  // states row loss as a fact (bad) or nothing was lost at all. An unconditional "page was full"
  // warning fired on a healthy desk the first time this ran, and a check that cries wolf on correct
  // behaviour is how a real alert gets tuned out.
  //
  // ★ 2026-09-30: since the meter WALKS the day (`store.listEventsAll`), a full page is not merely
  // explainable — it is the normal shape of a busy day, and it is still context. What is NOT context
  // is a walk that gave up at its own page ceiling: that is the TRD-77 defect one level down, a
  // bounded read presented as a total, and only the meter can admit it (the SQL count would just
  // disagree, which is `meter_dropped_rows` seen from the outside).
  if (truncated === true) {
    out.push(finding('meter_read_truncated', 'bad',
      `the meter stopped reading after ${pages != null ? pages : '?'} page(s) of ${cap || '?'} rows WITHOUT reaching the end of the day — its total is a FLOOR being presented as a total.`));
  }
  const saturated = fetched != null && cap != null && fetched >= cap;

  // 6. A caller asking for more than the page cap can silently receive less. This is how the meter
  // came to request 2000 and read at most 500 while reporting the result as a total.
  if (requestedLimit != null && cap != null && requestedLimit > cap) {
    out.push(finding('limit_clamped', 'warn',
      `the meter requests limit ${requestedLimit} but the event read caps at ${cap}, so the request cannot be satisfied and the caller is not told`));
  }

  // 7. A consumer that is not on the allowlist is never metered and never capped — budget.record()
  // returns early for it. TRD-75 was exactly this: a whole agent's spend invisible in BOTH
  // directions, while the report claimed it was metered.
  const unknown = [...new Set(seenConsumers)].filter((c) => c && !consumers.includes(c));
  if (unknown.length) {
    out.push(finding('unknown_consumer', 'warn',
      `consumer(s) ${unknown.join(', ')} appear in today's llm_usage rows but are not on the budget allowlist — their spend is recorded and never capped`));
  }

  const bad = out.filter((f) => f.status === 'bad');
  const warn = out.filter((f) => f.status === 'warn');
  const status = bad.length ? 'bad' : warn.length ? 'warn' : 'ok';
  let detail;
  if (bad.length || warn.length) {
    detail = (bad.length ? bad : warn).map((f) => f.detail).join(' · ');
  } else if (events === 0) {
    // Deliberately NOT "the meter is healthy". With no calls today it is UNTESTED — which is the
    // same indistinguishable-from-idle trap one level up.
    detail = 'no LLM calls today — the meter is untested, not verified';
  } else {
    detail = `${events} call(s) · ${metered.toLocaleString()} tokens metered, matched by an independent count`;
    if (saturated) {
      detail += ` · the read reached its ${cap}-row page cap`
        + (pages != null ? ` over ${pages} page(s)` : '')
        + ', and the independent count agrees that nothing was dropped';
    }
  }
  return { status, detail, findings: out, events, dbTokens: db, meteredTokens: metered, saturated };
}

// Thin wrapper: does its own reads. `deps` is injectable so the check can be exercised without a DB.
async function inspect(userId, {
  store: s = require('../store'),
  budget: budgetMod = require('./budget'),
} = {}) {
  const since = dayStartUtc();
  const [db, meter, walk] = await Promise.all([
    s.llmUsageSince(userId, since),
    budgetMod.todayUsage(userId),
    // The payload scan has the SAME blindness the sum had: a redacted counter sitting on an older
    // page is invisible to a single-page read. Walk the day when the store can; a store without the
    // paging helper (a test stub, an older caller) falls back to one page rather than throwing.
    typeof s.listEventsAll === 'function'
      ? s.listEventsAll(userId, { kind: 'llm_usage', since })
      : s.listEvents(userId, { kind: 'llm_usage', limit: (s.EVENT_QUERY_CAP || 500) }).then((rows) => ({ rows, pages: null, truncated: null })),
  ]);

  const rows = Array.isArray(walk) ? walk : (walk && Array.isArray(walk.rows) ? walk.rows : []);
  const walkPages = walk && !Array.isArray(walk) ? walk.pages : null;
  const walkTruncated = walk && !Array.isArray(walk) ? walk.truncated : null;
  const todaysRows = rows.filter((e) => new Date(e.createdAt).getTime() >= since.getTime());
  const redactedKeys = [];
  const seenConsumers = [];
  for (const e of todaysRows) {
    const p = e.payload || {};
    if (p.consumer) seenConsumers.push(p.consumer);
    for (const k of (Array.isArray(p.redacted) ? p.redacted : [])) redactedKeys.push(k);
  }

  const consumers = (budgetMod.CONSUMERS || []);
  return assess({
    dbEvents: db.events,
    dbTokens: db.tokens,
    meteredTokens: meter.total,
    meteredCalls: meter.calls != null ? meter.calls : todaysRows.length,
    fetched: meter.fetched != null ? meter.fetched : rows.length,
    pages: meter.pages != null ? meter.pages : walkPages,
    truncated: meter.truncated != null ? meter.truncated : walkTruncated,
    cap: s.EVENT_QUERY_CAP || null,
    requestedLimit: meter.requestedLimit != null ? meter.requestedLimit : null,
    consumers,
    seenConsumers,
    redactedKeys,
  });
}

module.exports = { assess, inspect, METER_TRUSTED_FROM, COUNTER_IN_REDACTED };
