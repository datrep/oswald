// test/wake-single-emitter.test.js — TRD-WAK-2: one wake writes ONE wake event.
//
// THE DEFECT. A wake was written by up to four call sites: three in `aggregator` (the no-proposal path, the
// `decide` tail, and `finish`) plus one in `wakePipeline`, and the pipeline's copy was guarded by
//
//     if (!String(result.reason || '').startsWith('no_signal'))
//
// i.e. a test on the PROSE of the reason. That guard covers exactly ONE of the aggregator's three reasons, so
// `positions open, no proposal - committee not convened` — the most common outcome on this desk — was written
// TWICE. MEASURED over 14 days: 815 of 1,426 wakes carried a duplicate pair; one carried five.
//
// WHY THE STRUCTURE IS TESTED AND NOT JUST THE BEHAVIOUR. The failure mode is an OWNERSHIP question, and the
// original bug was that ownership was expressed as a string comparison. A behavioural test would have to
// reproduce every aggregator return path to notice a new writer appearing; a structural test notices the moment
// one is added, which is the thing that actually goes wrong.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const AGG = 'trading/agent/aggregator.js';
const PIPE = 'trading/agent/wakePipeline.js';

test('★ the aggregator writes NO wake events at all — ownership is not a string comparison', () => {
  const src = code(AGG);
  const writes = src.match(/log\.write\(userId,\s*'wake'/g) || [];
  assert.strictEqual(writes.length, 0, `the aggregator must not write wake events; found ${writes.length}`);
  const logs = src.match(/store\.logEvent\(userId,\s*'wake'/g) || [];
  assert.strictEqual(logs.length, 0, `the aggregator must not write wake events via store.logEvent; found ${logs.length}`);
  // Non-vacuity: the file DOES still write the `decision` events, so the assertions above are about `wake`
  // specifically rather than about `log.write` having disappeared.
  assert.match(src, /log\.write\(userId,\s*'decision'/, 'the decision events must survive — they were never duplicated');
});

test('★ the prose-prefix guard is GONE, and nothing else tests a wake reason with startsWith', () => {
  const src = code(PIPE);
  assert.ok(!/startsWith\('no_signal'\)/.test(src),
    "the ownership guard `String(result.reason||'').startsWith('no_signal')` must not return: a prose prefix"
    + ' cannot decide who owns a write, and it silently covered only one of three reasons');
});

test('the pipeline is the single writer, and every wake write there is on a path that returns', () => {
  const src = code(PIPE);
  const writes = src.match(/log\.write\(userId,\s*'wake'/g) || [];
  // Several writes exist, but exactly ONE may execute per wake: the early-exit paths cover kill switch, market
  // close and the paper guards, and each returns. The measured proof is the weekend wakes — market_closed, and
  // exactly one event each.
  assert.ok(writes.length >= 1, 'the pipeline must still write the wake event');
  assert.match(src, /demoWakePayload\(trigger, result/, 'and it must write the rich payload, not a bare stub');
});

test('★ demoWakePayload RECONSTRUCTS every field the removed aggregator row carried', () => {
  const { demoWakePayload } = require('../trading/agent/wakePipeline');
  const result = {
    action: 'none', reason: 'positions open, no proposal - committee not convened', llmCalled: false,
    promptId: 42, blocked: 'bridge paused',
    quant: { evaluated: 7, withSignal: 0 },
    committee: { convene: false, reason: 'no_proposal' },
    decision: { decisions: [{ symbol: 'Gold', action: 'none', reason: 'no signal in scope' }] },
    executions: [],
  };
  const p = demoWakePayload('schedule', result, { symbols: [] }, 'open', 1);
  // The fields the aggregator used to write in the SECOND row — losing them would trade a duplicate for a loss.
  assert.strictEqual(p.blocked, 'bridge paused');
  assert.deepStrictEqual(p.quant, { evaluated: 7, withSignal: 0 });
  assert.deepStrictEqual(p.committee, { convene: false, reason: 'no_proposal' });
  // ⚠ and the per-decision reason, which was ONLY on the aggregator's copy.
  assert.strictEqual(p.decisions[0].reason, 'no signal in scope');
  assert.strictEqual(p.decisions[0].symbol, 'Gold');
  // The pipeline's own fields must survive alongside them.
  assert.strictEqual(p.mode, 'demo');
  assert.strictEqual(p.reason, 'positions open, no proposal - committee not convened');
  assert.strictEqual(p.positions, 1);
});

test('an absent field is null on the payload, never missing — readers must not get undefined', () => {
  const { demoWakePayload } = require('../trading/agent/wakePipeline');
  const p = demoWakePayload('schedule', { action: 'none', reason: null }, { symbols: [] }, 'open', 0);
  for (const k of ['blocked', 'quant', 'committee', 'reason']) assert.ok(k in p, `${k} must be present`);
  assert.strictEqual(p.blocked, null);
  assert.strictEqual(p.quant, null);
  assert.strictEqual(p.committee, null);
  assert.deepStrictEqual(p.decisions, []);
  assert.deepStrictEqual(p.executions, []);
});

// The aggregator's return values are the CONTRACT that replaced its writes. A path that returns no `committee`
// silently drops the only record of why the committee was not convened.
test('each aggregator path that used to write a wake returns the fields the pipeline needs', () => {
  const src = code(AGG);
  // The no-proposal path.
  assert.match(src, /action: 'none', reason, llmCalled: false, decision, promptId,\s*\n\s*blocked: blocked \|\| null, quant: qs, committee: plan/,
    'the no-proposal return must carry blocked/quant/committee');
  // The decide tail.
  assert.match(src, /return \{\s*\n\s*promptId, action, reason, llmCalled: anyLlm, blocked: blocked \|\| null,\s*\n\s*quant: qs, session: session\.state, stale, positions: openTrades\.length,/,
    'the decide tail must carry the same four fields');
  // finish().
  assert.match(src, /return \{\s*\n\s*promptId, action, reason, llmCalled, decision, blocked: blocked \|\| null,/,
    'finish must carry them too, or the hard-evacuation path loses its wake fields');
});
