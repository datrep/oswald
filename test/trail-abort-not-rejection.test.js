// test/trail-abort-not-rejection.test.js — TRD-TRL-5 (2026-10-01): a verification failure is not an order rejection.
//
// THE INCIDENT. The trailing stop aborts an entry when its read-back cannot be verified. That abort was logged as
// `order_rejected`, the 30-minute circuit breaker reads `order_rejected`, and at 05:21:25 on 2026-10-01 the desk
// SOFT-KILLED ITSELF after five aborts inside 30 minutes. Measured: all 18 of that day's rejections were trail
// aborts — not one was a venue refusal — and there were 9 more the day before.
//
// ★ THE PODINT. The abort happens BEFORE anything is submitted: the trail is set on the ticket and verified, and
// only then is the order sent. So a trail abort means THE VENUE NEVER RECEIVED AN ORDER. There is nothing for it
// to have rejected. A CONFIGURATION problem was reaching a SAFETY mechanism built for a different failure.
//
// The asymmetry is already established in this file — TRD-43 and TRD-52 both route "the desk declined" to
// `order_blocked` and only the venue's refusals to `order_rejected`. This is the third case of the same shape.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const EXEC = 'trading/agent/executor.js';

const trailBranch = () => {
  const src = code(EXEC);
  const start = src.indexOf('} else if (trailRefusal) {');
  assert.ok(start > -1, 'the trail-refusal branch must exist');
  const end = src.indexOf('} else {', start);
  assert.ok(end > start, 'it must be followed by the rejection branch');
  return src.slice(start, end);
};

test('★★ a trail abort does NOT trip the circuit breaker', () => {
  const branch = trailBranch();
  // ⚠ THE ABSENCE IS THE FIX. Everything else in this branch is bookkeeping; not calling maybeTripBreaker is
  // what stops a control that cannot verify itself from shutting the desk down.
  assert.ok(!/maybeTripBreaker/.test(branch),
    'the trail branch must NOT call maybeTripBreaker — that absence is the entire change');
  assert.match(branch, /'order_blocked'/, 'it is recorded as a refusal, not a rejection');
  assert.match(branch, /reason: 'trail_unverified'/, 'and the reason is named');
});

test('the venue-rejection branch STILL trips the breaker — the change is scoped, not a removal', () => {
  const src = code(EXEC);
  const start = src.indexOf('} else if (trailRefusal) {');
  const reject = src.indexOf('maybeTripBreaker(userId, settings);', start);
  assert.ok(reject > -1, 'a real rejection must still trip the breaker');
  // and it must live in the branch that writes order_rejected, not anywhere else
  const rejected = src.indexOf("'order_rejected'", start);
  assert.ok(rejected > -1 && Math.abs(reject - rejected) < 400,
    'the breaker must stay attached to the order_rejected write');
});

test('★ the abort is detected TWO ways, because one must survive a rethrow', () => {
  const src = code(EXEC);
  // `trailEvidence` is the structured signal the bridge attaches; it has to survive withOrderReliability's
  // rethrow to arrive here. A detection that silently stopped matching would put these straight back into the
  // breaker, so the message prefix is the belt to that braces.
  assert.match(src, /e\.trailEvidence/, 'the structured signal must be checked');
  assert.match(src, /\^trailing stop:/i, 'and the message prefix as the fallback');
  assert.match(src, /const trailRefusal =/, 'both must feed one named predicate');
});

test('the branch ORDER matters: unconfirmed, then trail, then rejection', () => {
  const src = code(EXEC);
  const unconfirmed = src.indexOf("'order_unconfirmed'");
  const trail = src.indexOf('} else if (trailRefusal) {');
  const rejected = src.indexOf("'order_rejected'", trail);
  assert.ok(unconfirmed > -1 && trail > unconfirmed && rejected > trail,
    'an unconfirmed submit is a RISK fact and must be classified before anything else');
});

test('★ the bridge actually attaches the structured signal, so the primary detection can work', () => {
  const web = code('trading/plus500/webtrader.js');
  assert.match(web, /err\.trailEvidence = evidence/,
    'the abort must carry evidence, or the primary detection is dead code and only the regex is holding this');
  assert.match(web, /err\.trailDiag = trailDiag/);
});

test('★ the reason names WHY nothing was submitted, so a reader is not misled', () => {
  const branch = trailBranch();
  // A reader seeing a refusal must be able to tell that the ORDER path never ran — otherwise the same
  // misreading that made this a breaker problem (a refusal read as a rejection) survives in the prose.
  assert.match(branch, /DECLINED TO SUBMIT|declined to submit/,
    'the note must say the venue never received an order');
});
