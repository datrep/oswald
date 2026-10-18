// TRD-94 — a seat that COULD NOT SPEAK must not render like a seat that SAID NOTHING.
//
// THE INCIDENT. Measured 2026-09-21: `DeepSeek HTTP 402 Insufficient Balance` recurred from 2026-09-10 to that
// morning (18 prompts carrying it, two of them at 03:23Z and 04:07Z). It was written to a prompt-error row (a
// table nothing reads) and into a vote reason — so on every surface the dashboard reads, a chair abstaining on
// CREDIT was indistinguishable from a chair with no opinion. The desk did the right thing with the abstention
// (it is not a "no", and `benignOffline` correctly refuses to treat a payment error as a budget cap, so entries
// fail secure) — but nothing TOLD anyone the account was dry.
//
// The instrument correction matters as much as the fix: the first reading of this row used `llm_call` events,
// which record ONE fan-out per wake, and concluded seats were being lost. The votes say otherwise — see the
// last test.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { classifyProviderError } = require('../trading/agent/deepseek');
const { providerErrorVerdict, tunerGateVerdict, tunerSkipRows, scopeEnabledVerdict } = require('../trading/agent/selfHealth');

test('a payment failure is classified as one, and is NOT retryable', () => {
  for (const status of [402, 401]) {
    const c = classifyProviderError(Object.assign(new Error('DeepSeek HTTP ' + status + ': Insufficient Balance'), { status }));
    assert.equal(c.status, status);
    assert.equal(c.kind, 'payment');
    assert.equal(c.retryable, false, 'a retry cannot fix an empty account — the desk must not pretend otherwise');
  }
});

test('transient failure classes stay retryable and stay distinguishable', () => {
  assert.deepEqual(classifyProviderError(Object.assign(new Error('x'), { status: 500 })), { status: 500, kind: 'provider', retryable: true });
  assert.deepEqual(classifyProviderError(Object.assign(new Error('x'), { status: 429 })), { status: 429, kind: 'rate_limit', retryable: true });
  assert.equal(classifyProviderError(new Error('The operation was aborted due to timeout')).kind, 'transport');
  assert.equal(classifyProviderError(new Error('fetch failed')).kind, 'transport');
  // An error with no status at all is still recorded — as `unknown`, never silently dropped.
  assert.equal(classifyProviderError(new Error('something odd')).kind, 'unknown');
});

test('the verdict table: silence is ok, a blip warns, a dead account is BAD at n=1', () => {
  assert.equal(providerErrorVerdict([]).status, 'ok');
  // ⚠ AND A NON-ARRAY IS NOT SILENCE. The first version coerced anything non-array to [] and reported OK, on a
  // live desk where the 402s were real: `store.queryEvents` returns `{items,…}`, so the check read nothing and
  // gave a clean bill of health. A broken reader must be LOUD.
  assert.equal(providerErrorVerdict(null).status, 'warn');
  assert.equal(providerErrorVerdict({ items: [] }).status, 'warn');
  assert.match(providerErrorVerdict({ items: [] }).detail, /cannot see its input/);

  const blip = providerErrorVerdict([{ errorKind: 'transport', label: 'chair:risk', createdAt: '2026-09-21T05:00:00Z' }]);
  assert.equal(blip.status, 'warn');
  assert.match(blip.detail, /self-healing/);

  // ONE payment error is enough to be `bad`: unlike a blip it will repeat on every subsequent call.
  const dead = providerErrorVerdict([{ errorKind: 'payment', status: 402, label: 'chair:macro', createdAt: '2026-09-21T04:07:25Z' }]);
  assert.equal(dead.status, 'bad');
  assert.match(dead.detail, /HTTP 402/);
  assert.match(dead.detail, /chair:macro/, 'and which seat was lost');
  // ⚠ IT MUST NOT ASSERT A CAUSE. The first version said "the account is out of credit" — measured the same
  // day, the key answered HTTP 200 and a 402 landed in the SAME SECOND as a chair call that succeeded. So the
  // text names the candidates and says the cause is not established. A check that states the wrong cause is
  // the exact defect class this desk keeps writing rows about.
  assert.match(dead.detail, /CAUSE NOT ESTABLISHED/, 'a diagnosis must not outrun its evidence');
  assert.doesNotMatch(dead.detail, /out of credit/);
  assert.match(dead.detail, /ds-watch/, 'and it must say the desk bypasses the local breaker, so this is its only signal');
  // A blip alongside a payment error does not soften it.
  const both = providerErrorVerdict([{ errorKind: 'transport', label: 'a' }, { errorKind: 'payment', status: 402, label: 'b' }]);
  assert.equal(both.status, 'bad');
});

test('the failure reaches the EVENT STREAM, not only the prompt-error table', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'deepseek.js'), 'utf8');
  // ⚠ TRD-94b (2026-10-02): THE LOG MOVED FROM `askDecision` TO `callChat`, AND THE ASSERTION GOT STRONGER.
  // TRD-94 attached the report to `askDecision` — the CHAIR's entry point only. Ten other consumers call
  // `callChat` directly (review, pulse, central, ask, autopsy, bindingProposer, shadowCall, tuner, waker,
  // whitepaper) and none of them reaches that line, so none of them could ever report a provider failure.
  // Measured: of the 30 `llm_provider_error` rows the desk has EVER written, every one is a `chair:*`, while an
  // hour of `position_review` aborts (2026-10-01 20:23-21:28Z) sat in the log as generic `error` rows that
  // self-health check #13 cannot read. The report must live at the choke point every consumer passes through.
  assert.match(src, /logProviderError\(userId, \{ label, error: e, latencyMs: Date\.now\(\) - startedAt \}\)/,
    'a provider failure must be logged at the choke point every consumer passes, not at one caller');
  assert.doesNotMatch(src, /label: opts\.label \|\| 'decision', error: e/,
    'and NOT only on the askDecision path — that is the site ten other consumers bypass');
  assert.match(src, /store\.logEvent\(uid, 'llm_provider_error'/, 'and under its own kind, never folded into llm_error');
  assert.match(src, /err\.status = res\.status/, 'the status is the diagnosis, so it travels on the error');
  // The classification must NOT be called `kind` in the payload: the event has its own `kind` column, and one
  // word for two things is how a reader ends up filtering on the wrong one (the first version of check 13 did).
  assert.match(src, /errorKind: c\.kind/);
});

test('the two new checks read by KIND, because a stream filter cannot see an unlisted kind', () => {
  // `log.streamFor` maps an unknown kind to 'app', so `queryEvents({stream:'state'})` silently EXCLUDED both
  // `llm_provider_error` and `tune_skipped` — the checks would have reported a clean bill of health forever.
  const sh = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'selfHealth.js'), 'utf8');
  assert.match(sh, /listEvents\(userId, \{ kind: 'llm_provider_error', since, limit: 200 \}\)/);
  assert.match(sh, /listEvents\(userId, \{ kind: 'tune_skipped', since, limit: 200 \}\)/);
  assert.doesNotMatch(sh, /queryEvents\(userId, \{ stream: 'state', since, limit: 200 \}\)/,
    'the stream-based reader is what made both checks blind');
  // And the writer's own kind still flows through the envelope's mapper (documented behaviour, not a fix).
  const log = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'log.js'), 'utf8');
  assert.match(log, /STREAM_BY_KIND\[String\(kind\)\] \|\| 'app'/, 'unlisted kinds default to app — which is WHY the checks must ask by kind');
});

test('self-health carries the check and the desk keeps the abstention semantics', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'selfHealth.js'), 'utf8');
  assert.match(src, /check\('provider', 'LLM provider errors'/);
  // The existing, correct behaviour this must NOT change: a payment error is not a budget cap, so the
  // degraded-entry path must not treat it as benign. Only `budget_cap` may do that.
  const agg = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'aggregator.js'), 'utf8');
  assert.match(agg, /offlineCauses\.every\(\(r\) => String\(r\)\.startsWith\('budget_cap'\)\)/,
    'a payment failure must keep failing SECURE — never degrade into an undeliberated entry');
  assert.match(agg, /\^\(llm_error\|parse_failure\|budget_cap\|regex-fallback\)/,
    'and an llm_error must keep counting as an abstention rather than as a reasoned "no"');
});

test('the tuner verdict: silence is a WARN, a deliberate gate is ok, budget starvation is not', () => {
  // TRD-112: the tuner is scheduled every 6h and was refused at the parity gate silently for eleven days. Now
  // that each decision is recorded, the ABSENCE of a record is once again meaningful.
  const silent = tunerGateVerdict([], '2026-09-10T11:21:39Z');
  assert.equal(silent.status, 'warn');
  assert.match(silent.detail, /no tuner decision recorded/);
  assert.match(silent.detail, /last ACTUAL tune: 2026-09-10/, 'and it must say when it last really tuned');
  assert.match(tunerGateVerdict([]).detail, /never actually tuned/, 'with no tune at all it says so, rather than an epoch');

  const held = tunerGateVerdict([{ kind: 'tune_skipped', payload: { gate: 'parity_not_validated' } }], '2026-09-10T11:21:39Z');
  assert.equal(held.status, 'ok', 'being held at parity on a non-validated live desk is the DESIGN, not a fault');
  assert.match(held.detail, /deliberately held/);

  assert.equal(tunerGateVerdict([{ payload: { gate: 'disabled' } }]).status, 'ok');
  assert.equal(tunerGateVerdict([{ payload: { gate: 'interval' } }]).status, 'ok');
  assert.equal(tunerGateVerdict([{ payload: { gate: 'kill_switch_hard' } }]).status, 'ok');
  assert.equal(tunerGateVerdict([{ payload: { gate: 'budget' } }]).status, 'warn', 'starved of budget is not ok');
  assert.equal(tunerGateVerdict([{ payload: { gate: 'something_new' } }]).status, 'warn', 'an unknown gate must not pass as fine');
  // And a broken reader is loud here too.
  assert.equal(tunerGateVerdict({ items: [] }).status, 'warn');
  // The reader's shape is checked in ONE place, so the filter cannot silently eat a non-array.
  assert.equal(tunerSkipRows(null), null);
  assert.deepEqual(tunerSkipRows([{ kind: 'wake' }, { kind: 'tune_skipped' }]).length, 1);
});

test('scope vs enabled: only a setting that can run NOWHERE is reported — the rule is the resolver\'s (TRD-116)', () => {
  // ★ CORRECTED 2026-09-25. This test previously asserted the WRONG VERDICT in three places, so "the test
  // agrees" was never evidence for the check. Measured against `quant.scopedStrategyIds` — the resolver the
  // desk actually trades on — the check reported all of the following as unreachable, and every one of them
  // is a configuration the desk RUNS:
  //   · enabled + an EMPTY scope map          (an absent key falls back to the global list)
  //   · enabled + OTHER symbols enumerated    (enumerating other symbols says nothing about this one)
  //   · a scope entry naming a NON-enabled strategy (the deliberate override — TRD-91)
  // A guard that fires on working configurations is noise, and noise gets ignored. The cases are therefore
  // asserted as NOT reported, because only pinning the true alarm cannot fail.
  const WL = ['Gold', 'Oil', 'Bitcoin', 'Silver', 'Sugar', 'Arabica Coffee'];

  // (i) THE TRUE POSITIVE — TRD-116's actual defect, unchanged: `Oil: []` is an EXPLICIT empty entry, which
  //     replaces the global list, so survoil is enabled and can open nothing.
  const live = scopeEnabledVerdict(['survgold', 'survoil'],
    { Gold: ['survgold'], Oil: [], 'Arabica Coffee': ['meanrev'], Silver: ['meanrev'], Sugar: ['meanrev'], Bitcoin: [] }, WL);
  assert.equal(live.status, 'warn');
  assert.match(live.detail, /"survoil" is ENABLED but/);
  assert.match(live.detail, /DISAGREEMENT/, 'the finding is the disagreement, not either field');
  assert.doesNotMatch(live.detail, /meanrev/,
    'the scope-only direction is LIVE by design (an explicit entry replaces the global list), so reporting it as unreachable was itself the defect');

  // (ii) the three false alarms, now asserted silent
  assert.equal(scopeEnabledVerdict(['survgold'], {}, WL).status, 'ok',
    'an ABSENT key falls back to enabled, so an empty scope map reaches every symbol');
  assert.equal(scopeEnabledVerdict(['survgold'], { Silver: ['turtle'], Sugar: [] }, WL).status, 'ok',
    'enumerating other symbols says nothing about a symbol that has no entry');
  assert.equal(scopeEnabledVerdict(['survgold'], { Gold: ['survgold'], Oil: [], Bitcoin: [] }, WL).status, 'ok',
    'an empty scope for an unenabled strategy is how a symbol is retired, and is fine');

  // (iii) genuinely dead: every watchlist symbol explicitly emptied
  assert.equal(scopeEnabledVerdict(['survgold'],
    { Gold: [], Oil: [], Bitcoin: [], Silver: [], Sugar: [], 'Arabica Coffee': [] }, WL).status, 'warn');

  // (iv) ★ THE APPLICABILITY FILTER IS NOT DECORATION. `survoil` is enabled and the global list applies to
  //      Gold — a two-list reading of the settings calls this reachable — but `survoil.symbols = ['Oil']`
  //      track-binds it, and with no Oil in the universe the desk can open it NOWHERE. Measured against the
  //      real registry, not a stub.
  const trackBound = scopeEnabledVerdict(['survoil'], {}, ['Gold', 'Bitcoin']);
  assert.equal(trackBound.status, 'warn');
  assert.match(trackBound.detail, /track-bound/);

  // (v) A reader that cannot see its input must be loud here too — INCLUDING the universe, which the old
  //     signature did not even take, so "reachable" was asserted without one.
  assert.equal(scopeEnabledVerdict(null, null, WL).status, 'warn');
  assert.equal(scopeEnabledVerdict(['x'], null, WL).status, 'warn');
  assert.equal(scopeEnabledVerdict(['survgold'], {}, []).status, 'warn', 'no watchlist means reachability is UNMEASURED');
  assert.match(scopeEnabledVerdict(['survgold'], {}, []).detail, /UNMEASURED/);

  const sh = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'selfHealth.js'), 'utf8');
  assert.match(sh, /check\('scope', 'Strategy scope vs enabled'/, 'and it must be a check, not a comment');
  assert.match(sh, /scopeResolution\.unreachableEnabled/, 'and it must DELEGATE — the rule is not restated here');
  assert.doesNotMatch(sh, /const enabled = new Set\(enabledList\)/,
    'the hand-rolled two-list loop, which disagreed with the resolver, must be gone');
});

test('the llm_call census counts WAKES, which is why it must not be used to count seats', () => {  // Measured 2026-09-21: 90 live proposals recorded EXACTLY 3 seat-votes each (270/270, never 2 and never 4),
  // while `llm_call` events for the same window numbered ~72. The reason is this line — the vote aggregate
  // (and therefore the per-wake usage record) is taken once per WAKE, not once per deliberation — so a census
  // built from `llm_call` undercounts seats and reads as "seats are being lost". The VOTES are the record; the
  // call events are a per-wake account. Pinned so the next reader does not re-derive the wrong conclusion.
  const agg = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'aggregator.js'), 'utf8');
  assert.match(agg, /if \(!allVoteAgg\) allVoteAgg = voteAggFrom\(cv\);/,
    'the usage/aggregate is recorded for the FIRST proposal of a wake, so llm_call under-counts deliberate calls');
});

// TRD-94b (2026-10-02) — the report must be at the CHOKE POINT, and this proves it BEHAVIOURALLY rather than
// by reading the source. The incident: TRD-94 attached `logProviderError` to `askDecision`, the chair's entry
// point. Ten consumers call `callChat` directly and never reached it, so on 2026-10-01 an hour of
// `position_review` aborts (20:23-21:28Z, a 60s abort every ~5 min) landed as generic `error` rows — the one
// kind self-health check #13 does not read — and the desk reported "no provider errors in 24h" while the
// review path was dead. This test drives a NON-CHAIR consumer (`label: 'review'`) through the real `callChat`.
test('callChat itself reports a provider failure, so a non-chair consumer (review/pulse/...) is not silent', async () => {
  const deepseekMod = require('../trading/agent/deepseek');
  const store = require('../trading/store');

  const logged = [];
  const realLogEvent = store.logEvent;
  const realFetch = global.fetch;
  const realKey = process.env.DEEPSEEK_API_KEY;
  // `logProviderError` writes through the shared `store` object, so replacing the property is enough — and
  // the stub records SYNCHRONOUSLY, so the row is present before `callChat` re-throws.
  store.logEvent = async (userId, kind, payload) => { logged.push({ userId, kind, payload }); };
  process.env.DEEPSEEK_API_KEY = 'test-key';
  // The EXACT shape fetch produces when callChat's own AbortController fires: name AbortError, code 20,
  // message 'This operation was aborted' — the same triple the live rows carried.
  const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 20 });
  global.fetch = async () => { throw abortErr; };

  try {
    await assert.rejects(
      () => deepseekMod.callChat([{ role: 'user', content: 'hi' }], { userId: 1, label: 'review' }),
      /aborted/,
      'the error must still PROPAGATE to the caller — this fix adds a record, it does not swallow the failure',
    );
    const pe = logged.find((r) => r.kind === 'llm_provider_error');
    assert.ok(pe, 'callChat must write llm_provider_error — otherwise every consumer except the chair is invisible');
    assert.equal(pe.userId, 1, 'and to the owner that made the call, never mis-attributed');
    assert.equal(pe.payload.label, 'review', 'carrying the consumer label, so the lost seat is NAMEABLE');
    assert.equal(pe.payload.errorKind, 'transport', 'an abort classifies as transport, which is what check #13 reads');
    assert.equal(pe.payload.retryable, true);
    // The duration of a FAILED call is recordable nowhere else: `llm_call` is written only on success, so a
    // hung-and-aborted call leaves no latency row and every duration statistic goes blind to it.
    assert.ok(Number.isFinite(pe.payload.latencyMs), 'the failed call must carry how long it took — the hang is otherwise invisible');
  } finally {
    store.logEvent = realLogEvent;
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = realKey;
  }
});
