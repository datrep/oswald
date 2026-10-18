'use strict';
// TRD-75 (proposer) — an INDEPENDENT reviewer that proposes the binding. Tests for the pure parts.
//
// Two guarantees are tested structurally, because both are promises that prose cannot keep:
//   1. THE INPUT IS WHITELISTED. A reviewer handed the desk's positions and current signal is not
//      reviewing, it is agreeing. The input key set is asserted to be EXACTLY INPUT_KEYS.
//   2. THE PROPOSER NEVER WRITES. It proposes and records. Nothing in the file may touch settings.
const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const bp = require('../trading/agent/bindingProposer');

const registry = {
  REGISTRY: {
    turtle: { id: 'turtle', liveSignal() {}, DEFAULTS: { donchianPeriod: 20, adxGate: 20 }, params: [{ key: 'donchianPeriod', def: 20, min: 5, max: 100 }, { key: 'adxGate', def: 20, min: 0, max: 60 }] },
    survgold: { id: 'survgold', liveSignal() {}, symbols: ['Gold'], DEFAULTS: { donchianPeriod: 20, adxGate: 0 }, params: [] },
  },
  get(id) { return this.REGISTRY[id] || null; },
};
const SYMBOLS = ['Gold', 'Oil', 'Silver'];
const settings = { strategies: { enabled: ['survgold', 'turtle'], symbolScope: { Gold: ['survgold', 'turtle'], others: [] } } };
const gate = (candidates) => ({ candidates, enforce: false, overrides: {} });
const pass = [{ id: 99, strategy: 'turtle', symbol: 'Gold', status: 'frozen', verdict: 'PASS' }];
const archived = [{ id: 20, strategy: 'turtle', symbol: 'Gold', status: 'archived', verdict: null }];

// --- 1. the whitelist -------------------------------------------------------

test('TRD-76: the measured physical VALUE and its as-of reach the reviewer verbatim', () => {
  // Criterion 3 of TRD-76, pinned where it is cheapest: availability and value are separate keys, and
  // the value carries the report's own date, cadence and age. The prompt is JSON.stringify(input), so
  // asserting on the serialized object is asserting on what the model is sent.
  const input = bp.buildReviewInput({
    instruments: [{ symbol: 'Gold' }],
    physicalValues: {
      Gold: [{ source: 'cftc_cot_positioning', asOf: '2026-09-08', ageDays: 7.8, cadence: 'weekly', fresh: true, managedMoneyNet: 134972, netPercentile: 55, percentileWindowWeeks: 156 }],
    },
  });
  const serialized = JSON.stringify(input);
  assert.ok(serialized.includes('cftc_cot_positioning'));
  assert.ok(serialized.includes('2026-09-08'), 'the as-of must travel with the value');
  assert.ok(serialized.includes('134972'));
  assert.ok(serialized.includes('percentileWindowWeeks'), 'a percentile is unquotable without its window');
  assert.ok(serialized.includes('"fresh":true'));
  // The two are NOT the same key: a source being available is not a statement about the instrument.
  assert.notEqual(input.physicalValues, input.physicalTelemetry);
  // And a new report date moves the signature, while re-reading the same one does not.
  const a = bp.signature(bp.buildReviewInput({ instruments: [], physicalValues: { Gold: [{ asOf: '2026-09-08' }] } }));
  const b = bp.signature(bp.buildReviewInput({ instruments: [], physicalValues: { Gold: [{ asOf: '2026-09-15' }] } }));
  assert.notEqual(a, b);
});

test('TRD-75: the reviewer input has EXACTLY the whitelisted keys', () => {
  const input = bp.buildReviewInput({ instruments: [{ symbol: 'Gold' }], scope: { Gold: 'explicit' }, coverage: {} });
  assert.deepEqual(Object.keys(input).sort(), [...bp.INPUT_KEYS].sort(), 'an extra key means something leaked into a reviewer that must not see the trade');
});

test('TRD-75: no position, signal, price or pnl data can reach the reviewer', () => {
  // The desk's own state is deliberately NOT accepted as an argument, so the strongest check is that
  // the builder has no parameter that would carry it, and the serialized input mentions none of it.
  const src = code('trading/agent/bindingProposer.js');
  const fn = src.slice(src.indexOf('function buildReviewInput'), src.indexOf('function signature'));
  assert.ok(fn.length > 100, 'slice guard');
  for (const forbidden of ['position', 'openTrade', 'pnl', 'direction', 'signal', 'equity']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`, 'i').test(fn), `buildReviewInput must not reference ${forbidden}`);
  }
  const input = bp.buildReviewInput({ instruments: [{ symbol: 'Gold' }], scope: {}, coverage: {} });
  const text = JSON.stringify(input).toLowerCase();
  for (const word of ['position', 'pnl', 'direction', 'equity']) assert.ok(!text.includes(word), `the input must not carry ${word}`);
});

test('TRD-75: the system prompt states the separation and the override rule', () => {
  assert.match(bp.SYSTEM, /do NOT trade|you do not see the desk/i);
  assert.match(bp.SYSTEM, /overrideReason/);
  assert.match(bp.SYSTEM, /frozen/i);
  assert.match(bp.SYSTEM, /JSON only/);
});

// --- 2. change detection ----------------------------------------------------

test('TRD-75: the signature is stable for the same input', () => {
  const a = bp.buildReviewInput({ instruments: [{ symbol: 'Gold' }, { symbol: 'Oil' }], scope: { Gold: 'explicit' }, coverage: { Gold: { ready: 0, declared: 3 } } });
  const b = bp.buildReviewInput({ instruments: [{ symbol: 'Oil' }, { symbol: 'Gold' }], scope: { Gold: 'explicit' }, coverage: { Gold: { ready: 0, declared: 3 } } });
  assert.equal(bp.signature(a), bp.signature(b), 'instrument ORDER must not fake a change');
});

test('TRD-75: the signature moves when the evidence, the binding or the telemetry moves', () => {
  const base = { instruments: [{ symbol: 'Gold' }], scope: {}, evidence: [{ symbol: 'Gold', strategy: 'turtle', outcome: 'archived', eligible: false }], coverage: { Gold: { ready: 0, declared: 3 } } };
  const s0 = bp.signature(bp.buildReviewInput(base));
  const sEvidence = bp.signature(bp.buildReviewInput({ ...base, evidence: [{ symbol: 'Gold', strategy: 'turtle', outcome: 'pass', eligible: true }] }));
  const sCoverage = bp.signature(bp.buildReviewInput({ ...base, coverage: { Gold: { ready: 1, declared: 3 } } }));
  assert.notEqual(s0, sEvidence, 'a verdict change must trigger a re-decision');
  assert.notEqual(s0, sCoverage, 'a source becoming available must trigger a re-decision');
});

test('TRD-75: shouldPropose fires on change but respects a floor', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  assert.equal(bp.shouldPropose({ sig: 'a' }).propose, true, 'first time proposes');
  assert.equal(bp.shouldPropose({ sig: 'a', lastSig: 'a', lastAt: '2026-09-15T00:00:00Z', now }).propose, false, 'unchanged input does not');
  assert.equal(bp.shouldPropose({ sig: 'b', lastSig: 'a', lastAt: '2026-09-15T10:00:00Z', now, minIntervalH: 12 }).propose, false, 'changed inside the floor does not');
  assert.equal(bp.shouldPropose({ sig: 'b', lastSig: 'a', lastAt: '2026-09-14T10:00:00Z', now, minIntervalH: 12 }).propose, true, 'changed outside the floor does');
  assert.equal(bp.shouldPropose({ sig: 'b', lastSig: 'a', lastAt: null, now }).propose, true, 'no usable timestamp does not block');
});

test('TRD-75: ★ the staleness ceiling forces a re-decision even when NOTHING changed', () => {
  // The gap a pure change-trigger leaves: if every input the reviewer can see is identical, it never
  // reconsiders - and "nothing changed" is exactly what a stale world looks like from inside.
  const now = Date.parse('2026-09-15T12:00:00Z');
  const stale = bp.shouldPropose({ sig: 'a', lastSig: 'a', lastAt: '2026-09-08T00:00:00Z', now, maxStaleH: 168 });
  assert.equal(stale.propose, true, 'identical input past the ceiling must still re-decide');
  assert.match(stale.why, /stale/);

  const fresh = bp.shouldPropose({ sig: 'a', lastSig: 'a', lastAt: '2026-09-15T00:00:00Z', now, maxStaleH: 168 });
  assert.equal(fresh.propose, false, 'identical input inside the ceiling does not');
  assert.match(fresh.why, /within the staleness ceiling/);
});

test('TRD-75: the ceiling is a backstop, so an unusable timestamp does not defer forever', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  assert.equal(bp.shouldPropose({ sig: 'a', lastSig: 'a', lastAt: null, now, maxStaleH: 168 }).propose, true);
  assert.equal(bp.shouldPropose({ sig: 'a', lastSig: 'a', lastAt: 'not-a-date', now, maxStaleH: 168 }).propose, true, 'a corrupt timestamp must not suppress the ceiling');
});

test('TRD-75: maxStaleH = 0 disables the ceiling rather than meaning "always"', () => {
  // 0 must be readable as OFF, which is why the config is read with an explicit null check and not `||`.
  const now = Date.parse('2026-09-15T12:00:00Z');
  const r = bp.shouldPropose({ sig: 'a', lastSig: 'a', lastAt: '2020-01-01T00:00:00Z', now, maxStaleH: 0 });
  assert.equal(r.propose, false, 'ceiling off and input unchanged means no proposal');
});

test('TRD-75: the default ceiling is a week, chosen against the evidence cadence', () => {
  assert.equal(bp.DEFAULT_MAX_STALE_H, 168);
  const now = Date.parse('2026-09-15T12:00:00Z');
  // just inside, at the default
  assert.equal(bp.shouldPropose({ sig: 'a', lastSig: 'a', lastAt: '2026-09-09T12:00:00Z', now }).propose, false);
  // just outside, at the default
  assert.equal(bp.shouldPropose({ sig: 'a', lastSig: 'a', lastAt: '2026-09-08T06:00:00Z', now }).propose, true);
});

test('TRD-75: a deliberate 0 floor is not silently turned back into the default', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const r = bp.shouldPropose({ sig: 'b', lastSig: 'a', lastAt: '2026-09-15T11:59:00Z', now, minIntervalH: 0, maxStaleH: 0 });
  assert.equal(r.propose, true, 'floor 0 means no floor');
});

// --- 3. parsing -------------------------------------------------------------

test('TRD-75: parseProposal tolerates fences and defaults the arrays', () => {
  const ok = bp.parseProposal('```json\n{"bindings":[],"notes":"n"}\n```');
  assert.ok(ok.proposal);
  assert.deepEqual(ok.proposal.bindings, []);
  assert.deepEqual(ok.proposal.unbound, []);
  assert.deepEqual(ok.proposal.wantsPhysical, []);
  assert.equal(ok.proposal.notes, 'n');
  assert.ok(bp.parseProposal('not json').error);
  assert.ok(bp.parseProposal('').error);
});

// --- 4. validation reuses the real guards -----------------------------------

test('TRD-75: a proposal the gate would refuse needs an overrideReason', () => {
  const v = bp.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'turtle', params: { adxGate: 0 }, rationale: 'x' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(archived) },
  );
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => r.source === 'live-eligibility gate' && /no overrideReason/.test(r.reason)));
});

test('TRD-75: the same proposal is ACCEPTED once it declares a reason', () => {
  const v = bp.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'turtle', params: { adxGate: 0 }, rationale: 'x', overrideReason: 'owner decision 2026-09-15' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(archived) },
  );
  assert.equal(v.accepted, true, JSON.stringify(v.reasons));
  assert.deepEqual(v.overrideRequests, [{ symbol: 'Gold', strategy: 'turtle', reason: 'owner decision 2026-09-15' }]);
});

test('TRD-75: a passing pair needs no override', () => {
  const v = bp.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'turtle', params: { adxGate: 0 }, rationale: 'lab pass' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(pass) },
  );
  assert.equal(v.accepted, true, JSON.stringify(v.reasons));
  assert.equal(v.overrideRequests.length, 0);
});

test('TRD-75: proposing params for a FROZEN strategy is refused, and says why', () => {
  const v = bp.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'survgold', params: { donchianPeriod: 5 }, rationale: 'x', overrideReason: 'anything' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(archived) },
  );
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => r.source === 'binding.validate' && /FROZEN/.test(r.reason)), JSON.stringify(v.reasons));
});

test('TRD-75: a binding with no rationale is refused - it cannot be reviewed', () => {
  const v = bp.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'turtle', rationale: '   ' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(pass) },
  );
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => /no rationale/.test(r.reason)));
});

test('TRD-75: an off-watchlist symbol is refused', () => {
  const v = bp.validateProposal(
    { bindings: [{ symbol: 'Platinum', strategy: 'turtle', rationale: 'x' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(pass) },
  );
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => /not on the watchlist/.test(r.reason)));
});

test('TRD-75: out-of-range parameters are refused by the reused range guard', () => {
  const v = bp.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'turtle', params: { donchianPeriod: 1 }, rationale: 'x' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(pass) },
  );
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some((r) => /below min 5/.test(r.reason)), JSON.stringify(v.reasons));
});

test('TRD-75: "propose nothing" is a valid answer and is not an error', () => {
  const v = bp.validateProposal(
    { bindings: [], unbound: [{ symbol: 'Silver', reason: 'no evidence and no physical telemetry' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(pass) },
  );
  assert.equal(v.accepted, true);
  assert.deepEqual(v.patch, {});
});

test('TRD-75: the validation result carries the patch it WOULD write, and writes nothing', () => {
  const v = bp.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'turtle', params: { donchianPeriod: 20, adxGate: 0 }, rationale: 'x' }] },
    { settings, symbols: SYMBOLS, registry, gate: gate(pass) },
  );
  assert.deepEqual(v.patch, { Gold: { turtle: { donchianPeriod: 20, adxGate: 0 } } });
  assert.equal(settings.strategies.symbolParams, undefined, 'validate must not mutate the settings it read');
});

// --- 5. the never-writes guarantee -----------------------------------------

test('TRD-75: the proposer contains NO settings write of any kind', () => {
  const src = code('trading/agent/bindingProposer.js');
  for (const forbidden of ['saveSettings', 'updateSettings', 'MERGE TradingSettings', 'INSERT INTO TradingSettings']) {
    assert.ok(!src.includes(forbidden), `the proposer must never call ${forbidden} - it proposes and records, nothing else`);
  }
  assert.match(src, /applied: false/, 'and it must record that it did not apply');
});

// --- 6. the redaction collision -------------------------------------------
//
// FOUND LIVE 2026-09-15: the lab_gate row came back with "signature":"[REDACTED]" and
// redacted:["signature"]. log.js redacts any key matching its denylist at the LOGGING boundary, and
// `signature` is on it. The proposer STORES its change-signature in an event and READS IT BACK to
// decide whether to re-propose - so the read returned null every time, and both the 12h floor and the
// 168h ceiling were silently bypassed. The cadence was defeated by a field NAME, with no error anywhere.
// The denylist is extracted from log.js rather than restated, so this test tracks the real rule.

function denylistFromLogSource() {
  const src = code('trading/agent/log.js');
  const m = src.match(/DENYLIST_KEY\s*=\s*(\/.*?\/[a-z]*)\s*;/);
  assert.ok(m, 'the denylist must be a plain regex literal for this test to read it');
  const lit = m[1];
  const last = lit.lastIndexOf('/');
  return new RegExp(lit.slice(1, last), lit.slice(last + 1));
}

test('TRD-75: the stored change-signature field is redaction-safe', () => {
  const re = denylistFromLogSource();
  assert.ok(re.test('signature'), 'this test is only meaningful while `signature` is on the denylist - if that changes, this guard can be simplified');
  assert.ok(!re.test('inputSig'), 'inputSig must stay off the denylist, or the cadence is bypassed again');
  assert.ok(!re.test('promptVersion'));
});

test('TRD-75: the proposer never logs or reads a field named `signature`', () => {
  const src = code('trading/agent/bindingProposer.js');
  assert.ok(!/\bsignature\s*:/.test(src), 'a field named `signature` is stored as [REDACTED] and read back as a mismatch');
  assert.match(src, /inputSig/, 'the change-signature must be carried under a redaction-safe name');
});

test('TRD-75: the wake pipeline records the ledger signature under a redaction-safe name too', () => {
  const src = code('trading/agent/wakePipeline.js');
  const at = src.indexOf("'lab_gate'");
  assert.ok(at > -1, 'the lab_gate event must exist');
  const slice = src.slice(at, at + 900);
  assert.ok(slice.length > 100, 'slice guard');
  assert.ok(!/\bsignature\s*:/.test(slice), 'the ledger signature would be stored as [REDACTED], losing the audit value');
  assert.match(slice, /inputSig\s*:/);
});

// --- 7. the caps, measured (2026-09-15) ------------------------------------
//
// FOUND BY A FORCED RUN, not by reading. The reviewer could not answer AT ALL: both the 6000 and the
// 12000-token attempt returned empty content with finish_reason 'length', so a v3 proposal produced
// nothing but "reviewer returned nothing: the 12000-token cap was consumed entirely by reasoning".
// A separate run with the same input and a 40000-token budget succeeded on the FIRST attempt with
// finish_reason 'stop' having used 14,984 completion tokens in 68 seconds. So the cap was the binding
// constraint, it was roughly 2.5x too small, and the timeout (60s, inherited from settings.llm) aborted
// the call mid-escalation on its own.

test('TRD-84: the reviewer\'s base cap fits its MEASURED answer, not an estimate', () => {
  assert.ok(bp.MAX_TOKENS >= 15000, `base cap must exceed the measured need of 14,984 tokens (is ${bp.MAX_TOKENS})`);
  assert.ok(bp.MAX_TOKENS_RETRY > bp.MAX_TOKENS, 'the escalation rung must actually escalate');
  assert.ok(bp.MAX_TOKENS_RETRY >= 20000, 'and be serviceable if it is ever reached');
});

test('TRD-84: the reviewer does NOT inherit the global 60s timeout', () => {
  // A full call plus its escalation measured ~30s + ~60s. At 60000ms the reviewer aborted mid-escalation
  // with "This operation was aborted" — a second, independent way to emit nothing.
  assert.ok(bp.DEFAULT_TIMEOUT_MS >= 180000, `a full call plus escalation needs headroom (is ${bp.DEFAULT_TIMEOUT_MS})`);
  const src = code('trading/agent/bindingProposer.js');
  assert.match(src, /timeoutMs: Number\(bpCfg\.timeoutMs\) \|\| DEFAULT_TIMEOUT_MS/, 'and it must be its own budget, overridable by settings');
  assert.ok(!/timeoutMs: llm\.timeoutMs/.test(src), 'the global value is what aborted it');
});

// --- 8. more than one object in one reply ---------------------------------

test('★ a reply containing TWO objects is parsed, COUNTED, and reported', () => {
  // A forced call returned the answer, then the model's own prose — "Note the trailing text after the
  // JSON in my draft; I must not include it... Let me finalize." — then a corrected second copy. The desk
  // parses the FIRST, i.e. the draft the model had just disowned. The two agreed on every count that
  // time, so nothing was materially wrong, but the mechanism is unsafe and "it agreed once" is not a
  // guarantee. The count is recorded so the choice can be made against evidence.
  const draft = '{"bindings":[{"symbol":"Gold","strategy":"survgold"}],"unbound":[],"hypotheses":[]}';
  const final = '{"bindings":[{"symbol":"Sugar","strategy":"meanrev"}],"unbound":[],"hypotheses":[]}';
  const reply = `${draft}\n\nWait — that must be JSON only, valid. Let me finalize.\n${final}`;
  assert.equal(bp.topLevelJsonObjects(reply).length, 2, 'both are complete, balanced objects');
  const p = bp.parseProposal(reply);
  assert.equal(p.jsonObjects, 2, 'the trail must show it happened');
  assert.equal(p.salvaged, true, 'and that the whole reply was not valid JSON');
  assert.equal(p.proposal.bindings[0].symbol, 'Gold', 'the FIRST object is used — a documented limitation, not an accident');
});

test('a brace in prose is not counted as a second object, and no JSON is no object', () => {
  assert.equal(bp.topLevelJsonObjects('{"bindings":[]} and then a note').length, 1);
  assert.equal(bp.topLevelJsonObjects('a note with no json at all').length, 0);
  assert.equal(bp.firstJsonObject('a note with no json at all'), null);
  assert.equal(bp.parseProposal('not json').jsonObjects, 0);
  assert.equal(bp.parseProposal('{"bindings":[]}').jsonObjects, 1);
});
