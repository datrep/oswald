// test/close-time.test.js — TRD-118: pin the close-TIME provenance contract.
//
// ★ THE FIGURES HERE ARE THE MEASURED ONES, NOT INVENTED ONES. Captured 2026-09-24 from `dbo.Trades`
// (80 closed rows of 94): 36 of 36 `venue_rate` closes land exactly on a minute boundary, 0 of 36 NULL-source
// and 0 of 8 `fill` closes do, and `openAt` is minute-bounded on 0 of 94 rows. The fixture below is built from
// that shape so the test fails if the classifier stops agreeing with the data it was written against.
const test = require('node:test');
const assert = require('node:assert');

const ct = require('../trading/agent/closeTime');

test('minuteRounded catches the measured signature, in UTC', () => {
  assert.strictEqual(ct.minuteRounded('2026-09-24T08:18:00.000Z'), true, 'the venue display shape');
  assert.strictEqual(ct.minuteRounded(new Date('2026-09-24T02:19:00.000Z')), true);
  assert.strictEqual(ct.minuteRounded('2026-09-24T02:10:45.928Z'), false, 'a real observation');
  assert.strictEqual(ct.minuteRounded('2026-09-24T02:19:00.001Z'), false, '1 ms is still an observation');
  // Read in UTC — a SGT offset would shift a genuine 00:00:00Z into a non-zero second and hide it.
  assert.strictEqual(ct.minuteRounded('2026-09-24T00:00:00.000Z'), true);
});

test('minuteRounded never throws on junk, and never guesses', () => {
  for (const bad of [null, undefined, '', 'not-a-date', {}, NaN]) {
    assert.strictEqual(ct.minuteRounded(bad), false, `${JSON.stringify(bad)} must be false, not throw`);
  }
});

test('sourceForVenueClose splits by the reason the venue gave', () => {
  assert.strictEqual(ct.sourceForVenueClose('Loss call'), ct.CLOSE_AT_SOURCE.venueUiMinute);
  assert.strictEqual(ct.sourceForVenueClose('Profit call'), ct.CLOSE_AT_SOURCE.venueUiMinute);
  assert.strictEqual(ct.sourceForVenueClose('  loss call  '), ct.CLOSE_AT_SOURCE.venueUiMinute, 'trim + case');
  // The 8 market-closed rows are a session boundary rather than a fill, so they get their own value.
  assert.strictEqual(ct.sourceForVenueClose('Market closed'), ct.CLOSE_AT_SOURCE.venueSchedule);
  // An unknown reason still gets a name — it arrives via the same minute-resolution display.
  assert.strictEqual(ct.sourceForVenueClose('something new'), ct.CLOSE_AT_SOURCE.venueUiMinute);
  assert.strictEqual(ct.sourceForVenueClose(null), ct.CLOSE_AT_SOURCE.venueUiMinute);
});

test('★ isWindowSafe is TRUE only for an observed instant', () => {
  const S = ct.CLOSE_AT_SOURCE;
  assert.strictEqual(ct.isWindowSafe(S.deskObserved, '2026-09-24T02:10:45.928Z'), true);
  assert.strictEqual(ct.isWindowSafe(S.venueEvent, '2026-09-24T02:10:45Z'), true);
  for (const src of [S.venueUiMinute, S.venueSchedule, S.reconcile, S.synthesised]) {
    assert.strictEqual(ct.isWindowSafe(src, '2026-09-24T02:10:45.928Z'), false, `${src} is not an observation`);
  }
});

test('★ with NO source recorded it falls back to the SHAPE — which is what caught the defect', () => {
  // Every pre-migration row is in this state, so the fallback is the branch history depends on.
  assert.strictEqual(ct.isWindowSafe(null, '2026-09-24T08:18:00.000Z'), false, 'rounded => untrustworthy');
  assert.strictEqual(ct.isWindowSafe(undefined, '2026-09-24T02:10:45.928Z'), true, 'sub-minute => trusted');
});

test('the uncertainty is stated, not hand-waved', () => {
  const S = ct.CLOSE_AT_SOURCE;
  assert.strictEqual(ct.closeTimeUncertaintySec(S.venueUiMinute, '2026-09-24T08:18:00.000Z'), 60);
  assert.strictEqual(ct.closeTimeUncertaintySec(S.venueSchedule, '2026-09-24T22:00:00.000Z'), 60);
  assert.strictEqual(ct.closeTimeUncertaintySec(S.deskObserved, '2026-09-24T02:10:45.928Z'), 0);
  // Unknown source: the shape decides, so a rounded row is still reported as uncertain.
  assert.strictEqual(ct.closeTimeUncertaintySec(null, '2026-09-24T08:18:00.000Z'), 60);
  assert.strictEqual(ct.closeTimeUncertaintySec(null, '2026-09-24T08:18:03.410Z'), 0);
});

test('the measured separation is reproduced over the captured shape', () => {
  // 36 venue closes, all minute-rounded -> all unsafe. 44 executor closes, none rounded -> all safe.
  const venue = Array.from({ length: 36 }, (_, i) => ({ at: `2026-09-24T0${(i % 10)}:${String(i % 60).padStart(2, '0')}:00.000Z`, src: ct.CLOSE_AT_SOURCE.venueUiMinute }));
  const exec = Array.from({ length: 44 }, (_, i) => ({ at: `2026-09-24T0${i % 10}:${String(i % 60).padStart(2, '0')}:45.12${i % 10}Z`, src: ct.CLOSE_AT_SOURCE.deskObserved }));
  const unsafe = (rows) => rows.filter((r) => !ct.isWindowSafe(r.src, r.at)).length;
  assert.strictEqual(unsafe(venue), 36, 'every venue close must be flagged');
  assert.strictEqual(unsafe(exec), 0, 'no executor close may be flagged');
});
