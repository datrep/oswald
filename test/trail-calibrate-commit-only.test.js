// test/trail-calibrate-commit-only.test.js — 2026-10-20: the calibration pass writes, so it must be commit-only.
//
// The pass types a SECOND count into `#trailing-stop-pips`. `setPositionTrail` is also called with `commit: false`
// by the staged-rollout mode and by diagnostics, where the call is a READ. A read must never mutate the card, so
// the correction has to sit behind `commit` — and a read-only call whose card disagrees must keep the OLD refusal
// rather than being "fixed" into a write.
const test = require('node:test');
const assert = require('node:assert/strict');
const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const webtrader = nl(code('trading/plus500/webtrader.js'));

function setPositionTrailBody() {
  const start = webtrader.indexOf('async function setPositionTrail');
  assert.ok(start > -1, 'setPositionTrail must still exist');
  const next = webtrader.indexOf('\nasync function ', start + 10);
  return webtrader.slice(start, next > -1 ? next : webtrader.length);
}

test('★★ the calibration call is gated on `commit` — a read-only call never types into the card', () => {
  const body = setPositionTrailBody();
  const at = body.indexOf('calibrateCount(');
  assert.ok(at > -1, 'the calibration pass must still be wired');

  // Walk back from the call to the conditional that governs it.
  const before = body.slice(0, at);
  const guardIdx = before.lastIndexOf('if (!proportional');
  assert.ok(guardIdx > -1, 'the calibration must sit under a !proportional conditional');
  const guard = before.slice(guardIdx, guardIdx + 120).replace(/\s+/g, ' ');
  assert.match(guard, /if \(!proportional && commit\)/, `calibration guard must include commit: ${guard}`);

  // And the guard must be AFTER the read-only return, i.e. the read-only branch must not sit between them.
  const readOnlyReturn = body.indexOf("out.reason = 'verified_read_only'");
  assert.ok(readOnlyReturn > at, 'the commit:false return must come AFTER the calibration block');
});

test('★ a read-only call whose card disagrees still refuses, and commits nothing', () => {
  const body = setPositionTrailBody();
  // ONE home for the typing, and two callers: the planned count and the calibrated one.
  const writes = (body.match(/nativeSet\.call\(el,/g) || []).length;
  assert.equal(writes, 1, 'the native-setter typing must exist in ONE place (inside typeCount)');
  const callers = (body.match(/await typeCount\(/g) || []).length;
  assert.equal(callers, 2, `expected two typeCount callers (planned, calibrated), found ${callers}`);
  const refuse = body.indexOf("if (!verified) { out.reason = 'trail_not_verified_before_commit'");
  const click = body.indexOf("page.click('#trade-button'");
  assert.ok(refuse > -1 && click > refuse, 'the refusal must precede the only click that writes');
  assert.ok(!/out\.committed = true[\s\S]{0,400}if \(!verified\)/.test(body), 'nothing may commit before it is verified');
});

test('the pass cannot turn an unverified ticket into a commit', () => {
  const body = setPositionTrailBody();
  // prop2 (the SECOND read) must be inside the band before `verified` is set true
  assert.match(body, /const prop2 = !!\(held2[\s\S]{0,160}?\n\s*out\.calibration\.readAfter/, 'prop2 must be computed from the second read-back');
  assert.match(body, /if \(!prop2\) \{ out\.reason = 'trail_not_verified_before_commit'; return out; \}/, 'a failed second read must refuse');
});
