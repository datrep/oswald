'use strict';
// TRD-89 step-down (2026-09-18): the exit chair may ADVISE on a fade but may not CLOSE it.
//
// The thesis fix gave the reviewer the right frame; this removes the authority it should never have had
// over a fade. Both halves matter: the prompt alone could still be ignored at high confidence, and this
// session's churn was the chair closing positions the strategy intended to hold.
//
// The default is DECIDER, so the trend survivors keep the chair as their safety net — and the default is
// RECORDED in the event, so an absent or unrecognised strategyId cannot quietly re-grant the authority
// this removes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { reviewAuthorityFor, decideClose } = require('../trading/agent/review');
const strategies = require('../trading/agent/strategies');

const ADVISORY = ['rsi2', 'meanrev', 'squeezerev'];

test('every mean-reversion strategy hands the chair advisory authority only', () => {
  for (const id of ADVISORY) {
    assert.equal(strategies.get(id).reviewAuthority, 'advisory', `${id} still lets the exit chair close its positions`);
    const a = reviewAuthorityFor({ strategyId: id });
    assert.equal(a.authority, 'advisory');
    assert.equal(a.source, `strategy:${id}`);
  }
});

test('the trend survivors keep the chair as a decider — this change must not touch them', () => {
  for (const id of ['survgold', 'survoil', 'turtle']) {
    const a = reviewAuthorityFor({ strategyId: id });
    assert.equal(a.authority, 'decider', `${id} lost its safety net — that is not what this change was for`);
  }
});

test('an ABSENT authority on a strategy means decider, so nothing silently changes', () => {
  // macd and mtftrend declare no reviewAuthority at all; the default must preserve prior behaviour.
  for (const id of ['macd', 'mtftrend', 'conglomerate-does-not-exist', 'turtle']) {
    assert.equal(reviewAuthorityFor({ strategyId: id }).authority, 'decider', `${id} must default to decider`);
  }
});

test('a position with no strategyId is a decider, and SAYS SO as the source', () => {
  const a = reviewAuthorityFor({});
  assert.equal(a.authority, 'decider');
  assert.equal(a.source, 'no_strategy_recorded', 'the reason for the default must be recorded, not assumed');
});

test('an unknown strategyId is a decider and names the id it did not recognise', () => {
  const a = reviewAuthorityFor({ strategyId: 'not-a-strategy' });
  assert.equal(a.authority, 'decider');
  assert.match(a.source, /^unknown_strategy:not-a-strategy$/);
});

// ---- the rule itself, driven through its truth table (no DB, no LLM) -------------------------------
// The pins below replaced source greps. A grep proves a line exists; it cannot prove the rule is right,
// and this rule is the thing that decides whether a live position is closed.

const base = { mirrored: false, closeMirrored: false, minConfidence: 0.5 };
const close = (extra = {}) => decideClose({ verdict: { action: 'close', confidence: 0.9 }, ...base, ...extra });
const hold = (extra = {}) => decideClose({ verdict: { action: 'hold', confidence: 0.9 }, ...base, ...extra });

test('an ADVISORY strategy never closes, at any confidence', () => {
  for (const c of [0.5, 0.9, 1]) {
    const d = decideClose({ verdict: { action: 'close', confidence: c }, ...base, authority: 'advisory' });
    assert.equal(d.close, false, `an advisory close executed at confidence ${c}`);
    assert.equal(d.shouldClose, true, 'the verdict still counted as wanting a close — it just may not act');
    assert.equal(d.advisory, true);
    assert.equal(d.advisoryReason, 'strategy_policy');
  }
});

test('a DECIDER still closes — the safety net is intact for the trend survivors', () => {
  const d = close({ authority: 'decider' });
  assert.equal(d.shouldClose, true);
  assert.equal(d.canClose, true);
  assert.equal(d.close, true, 'the chair must still be able to close a decider position');
  assert.equal(d.advisory, false);
  assert.equal(d.advisoryReason, null);
});

test('an advisory strategy outranks closeMirrored — it cannot be re-armed by a config flag', () => {
  // The dangerous combination: a mirrored position on an advisory strategy with mirrored closes enabled.
  // If closeMirrored won here, a fade could be closed through the mirrored path and the step-down would
  // be a policy that only holds when the configuration is convenient.
  const d = decideClose({
    verdict: { action: 'close', confidence: 0.99 },
    mirrored: true, closeMirrored: true, minConfidence: 0.5, authority: 'advisory',
  });
  assert.equal(d.close, false, 'ADVISORY LOST TO closeMirrored — the step-down is not load-bearing');
  assert.equal(d.advisoryReason, 'strategy_policy', 'the reason must name the strategy, not the mirroring');
});

test('a hold never closes and is never labelled advisory', () => {
  for (const authority of ['advisory', 'decider']) {
    const d = hold({ authority });
    assert.equal(d.close, false);
    assert.equal(d.advisory, false, 'a hold is not a suppressed close');
    assert.equal(d.advisoryReason, null);
  }
});

test('confidence below the minimum does not close, and is a non-decision rather than a suppression', () => {
  const d = decideClose({ verdict: { action: 'close', confidence: 0.49 }, ...base, authority: 'decider' });
  assert.equal(d.shouldClose, false);
  assert.equal(d.advisory, false);
  assert.equal(d.advisoryReason, null);
});

test('confidence exactly at the minimum DOES close — the boundary belongs to acting', () => {
  const d = decideClose({ verdict: { action: 'close', confidence: 0.5 }, ...base, authority: 'decider' });
  assert.equal(d.close, true, 'a >= boundary that refused would silently raise the threshold');
});

test('the pre-existing mirrored rule still behaves as it did', () => {
  const blocked = decideClose({ verdict: { action: 'close', confidence: 0.9 }, mirrored: true, closeMirrored: false, minConfidence: 0.5, authority: 'decider' });
  assert.equal(blocked.close, false);
  assert.equal(blocked.advisoryReason, 'mirrored_position', 'the mirrored reason must not be relabelled as strategy policy');
  const allowed = decideClose({ verdict: { action: 'close', confidence: 0.9 }, mirrored: true, closeMirrored: true, minConfidence: 0.5, authority: 'decider' });
  assert.equal(allowed.close, true);
  assert.equal(allowed.advisory, false);
});

test('a missing or malformed verdict fails secure', () => {
  for (const v of [null, undefined, {}, { action: 'close' }, { action: 'close', confidence: null }, { action: 'close', confidence: 'x' }]) {
    const d = decideClose({ verdict: v, ...base, authority: 'decider' });
    assert.equal(d.close, false, `a malformed verdict closed a position: ${JSON.stringify(v)}`);
  }
});

test('the loop actually routes its decision through decideClose', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'review.js'), 'utf8');
  assert.match(src, /const d = decideClose\(\{/, 'reviewScope must delegate the decision');
  assert.match(src, /if \(d\.close\) \{/, 'the close must be gated on the pure decision, not re-derived inline');
  assert.match(src, /advisoryReason: d\.advisoryReason/, 'the event must carry the reason the pure rule computed');
  // and the old inline derivation must be gone, or the two can drift apart
  assert.doesNotMatch(src, /const canClose = \(!mirrored \|\| cfg\.closeMirrored\)/, 'an inline duplicate of the rule survived — the two will drift');
});

test('the event records WHICH authority applied and where it came from', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'review.js'), 'utf8');
  assert.match(src, /authority, authoritySource: source/, 'the recorded event must carry the authority and its source');
});

test('the UI shows an advisory close distinctly, and never as an executed one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'public', 'js', 'app.js'), 'utf8');
  assert.match(src, /close · advisory/, 'an advisory close must be labelled in the Review column');
  assert.match(src, /NOT executed: this strategy owns its own exit/, 'the tooltip must say the close did not happen and why');
  // the chip must not take the executed-close styling when the verdict was advisory
  assert.match(src, /rv\.action === 'close' && !rvAdvisory \? 'review' : 'muted'/, 'an advisory verdict must not render with the close styling');
});

test('the policy is visible on the strategy card, so it can be questioned', () => {
  assert.equal(strategies.list({}).find((s) => s.id === 'rsi2').reviewAuthority, 'advisory');
  assert.equal(strategies.list({}).find((s) => s.id === 'survgold').reviewAuthority, 'decider');
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'public', 'js', 'app.js'), 'utf8');
  assert.match(src, /review: advisory/);
  assert.match(src, /review: decider/);
});
