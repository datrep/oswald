// test/epoch-registry.test.js — TRD-DAT-1: the timeline is DATA, and it is checked rather than believed.
//
// WHY THIS FILE IS MOSTLY ABOUT THE REGISTRY'S OWN WEAKNESS. The registry is a hand-written list, so its failure
// modes are: a feature lands WITHOUT an entry (a reader crosses a boundary blind), entries collide on a date (which
// would make the SQL ranges overlap and MULTIPLY a join), or an entry is filed without saying what it invalidates
// (so a reader is told a change happened and not what it cost them). Each of those is pinned below.
//
// ⚠ AND WHY `code()` CANNOT BE USED HERE: it strips comments, and this module's value is substantially its comments.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const epoch = require('../trading/agent/epoch');

test('★ every entry says what it INVALIDATES — a changelog entry is not enough', () => {
  assert.ok(epoch.FEATURES.length >= 10, `expected the timeline to carry the session's features, got ${epoch.FEATURES.length}`);
  for (const f of epoch.FEATURES) {
    assert.match(f.landedAt, /^\d{4}-\d{2}-\d{2}$/, `${f.id}: landedAt must be an ISO date`);
    assert.ok(f.title && f.title.length > 20, `${f.id}: needs a real title`);
    // The field that makes the entry useful: without it a reader knows a change happened and not what it costs.
    assert.ok(f.invalidates && f.invalidates.length > 60,
      `${f.id}: \`invalidates\` is the point of the entry — say what a number from earlier rows CANNOT mean`);
  }
});

test('★ the epoch is a RECORDED value and the boundary is present in the timeline', () => {
  assert.match(epoch.EPOCH, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(epoch.FEATURES.some((f) => f.landedAt === epoch.EPOCH),
    `the policy epoch ${epoch.EPOCH} must be an entry, or the date an artifact cites is not in the registry it cites`);
});

test('★ no two DISTINCT ids share a landing date in a way that would multiply a join', () => {
  // Ranges are built one-row-per-date, so several features may share a date — that is fine and expected. What must
  // not happen is the SAME id twice, which would silently overwrite one of them during the sync.
  const ids = epoch.FEATURES.map((f) => f.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate feature id — the sync would drop one silently');
});

test('★ the annotation REFUSES to call a cross-epoch window safe', () => {
  const a = epoch.annotate({ since: '2026-09-10', until: '2026-09-26' });
  assert.strictEqual(a.safe, false, 'a window spanning the epoch must never be reported as one regime');
  assert.strictEqual(a.crossesEpoch, true);
  assert.ok(a.caveats.length > 0, 'and it must carry caveats, not just a false flag');
  // Non-vacuity: a window INSIDE one regime must come back safe, or the assertion above proves nothing.
  const b = epoch.annotate({ since: '2026-09-22', until: '2026-09-24' });
  assert.strictEqual(b.safe, true, 'a window inside one regime should be safe');
  assert.strictEqual(b.caveats.length, 0);
});

test('★ a window that SPANS a feature boundary is not safe, even inside one epoch week', () => {
  // 2026-09-25 and 2026-09-27 both changed behaviour, so a range covering them is not one regime.
  const a = epoch.annotate({ since: '2026-09-24', until: '2026-09-28' });
  assert.strictEqual(a.safe, false);
  assert.ok(a.featuresInWindow.length >= 2, `expected the boundaries inside the window, got ${a.featuresInWindow.length}`);
  assert.ok(a.featuresInWindow.some((f) => f.id === 'one-wake-one-event'),
    'the duplicate-wake boundary must be visible: it DOUBLES event counts before its own date');
});

test('`about` names the regime a single date sits in — and names it the SAME WAY the SQL table does', () => {
  const a = epoch.annotate({ about: '2026-09-26' });
  // ⚠ THE REGIME ID MUST MATCH `FeatureEpochs.id`, because a reader asking the API and a reader joining the table
  // are asking the same question. The first version of `annotate` answered with a FEATURE id (`chair-sees-panel`)
  // while the table answered with the DATE bucket, so the same day had two names.
  const fromTable = epoch.ranges().find((r) => r.landedAt <= '2026-09-26' && '2026-09-26' < r.nextLandedAt);
  assert.strictEqual(a.regime, fromTable.id, 'the API answer and the joinable row must agree on the regime name');
  assert.strictEqual(a.regime, 'day-2026-09-25', 'a date mid-range belongs to the range that contains it');
  assert.ok(a.invalidates, 'and must carry what that regime cannot prove');
  // Before the earliest entry there is no regime, and saying "safe" would be the opposite of the truth.
  const b = epoch.annotate({ about: '2026-01-01' });
  assert.strictEqual(b.safe, false);
  assert.strictEqual(b.regime, 'pre-registry');
});

test('★★ `safe` means ONE thing for a date and a window: is this produced by the code running now?', () => {
  // ⚠ THE FIRST VERSION MEANT TWO THINGS. For a window it meant "the range sits inside one regime"; for a single
  // date it meant "a regime exists". So `about=2026-09-20` — a date inside the SUPERSEDED `stop-cap` regime, whose
  // own `invalidates` says its geometry is not comparable with what followed — came back `safe: true`. An agent
  // reading that flag would have pooled it with current data, which is the exact mistake the mechanism exists to
  // prevent. `safe` now answers the reader's real question in both shapes.
  // ⚠ THE `about` DATE MOVES AS BOUNDARIES ARE ADDED, AND IT MUST. This test pins a RELATIVE property — the newest
  // regime is safe, earlier ones are not — so registering a boundary NECESSARILY retires the previous "in force"
  // date. On 2026-10-02 the registry was found eleven days stale (nothing after 09-27, while ~10 sizing rows closed
  // on 09-30 alone); 2026-09-28 was the newest until that gap was filled. Leaving it here would have made this test
  // FAIL the moment the gap was fixed — which is the test working, not breaking.
  // 2026-10-08: DERIVED from the registry — the newest range is by construction the regime in force, so adding
  // the next boundary cannot silently red this pin (the hardcoded '2026-10-03' it replaced went stale at 10-04+).
  const newest = epoch.ranges().slice(-1)[0];
  const inForce = epoch.annotate({ about: newest.landedAt });
  assert.strictEqual(inForce.currentRegime, true);
  assert.strictEqual(inForce.safe, true, 'a date in the regime now in force is safe');
  assert.strictEqual(inForce.supersededBy, null, 'nothing has superseded the regime in force');
  // ⚠ AND THE NON-VACUITY THAT MATTERS: the date that used to be newest must now read as RETIRED. Without this,
  // every boundary added below could be missing and the assertion above would still pass.
  assert.strictEqual(epoch.annotate({ about: '2026-09-28' }).safe, false,
    'the pre-2026-09-30 regime is not the code running now, so it must not read as safe');
  assert.strictEqual(epoch.annotate({ about: '2026-09-28' }).currentRegime, false);

  const superseded = epoch.annotate({ about: '2026-09-20' });
  assert.strictEqual(superseded.regime, 'stop-cap', 'the date still NAMES its regime — that is documented history');
  assert.strictEqual(superseded.currentRegime, false);
  assert.strictEqual(superseded.safe, false, '★ a superseded regime must not be reported as safe to use');
  assert.strictEqual(superseded.supersededBy, 'policy-epoch', 'and it must say what replaced it');
  assert.match(superseded.reason, /EARLIER regime/);
  // Non-vacuity: the flag must carry information, so it cannot be false everywhere.
  assert.ok(superseded.safe !== inForce.safe, 'the flag must distinguish the two cases or it says nothing');
});

test('windowLine always states a WINDOW — the defect is a number without one', () => {
  const line = epoch.windowLine({ since: '2026-09-10', until: '2026-09-26' });
  assert.match(line, /^window 2026-09-10\.\.2026-09-26/);
  assert.match(line, /epoch 2026-09-21/);
  assert.match(line, /caveat/, 'a spanning window must say it has caveats in the one-line form too');
  assert.match(epoch.windowLine({ since: '2026-09-22', until: '2026-09-24' }), /one regime/);
});

test('the SQL helper hands a RAW reader the same boundary, because that path sees no comments', () => {
  const j = epoch.sqlEpochJoin({ dateExpr: 't.createdAt' });
  assert.match(j, /LEFT JOIN FeatureEpochs/);
  assert.match(j, /t\.createdAt >= e\.landedAt AND t\.createdAt < e\.nextLandedAt/,
    'the range join is the mechanism: an annotation that lives only in a comment is invisible to SELECT AVG(...)');
});

test('★ featuresBetween is half-open, so a boundary ON the window edge is counted exactly once', () => {
  // `since` is exclusive and `until` inclusive. If a boundary could be counted twice or missed, a caller reporting
  // "N caveats" would disagree with the window it printed.
  const onEdge = epoch.featuresBetween('2026-09-24', '2026-09-25');
  assert.ok(onEdge.some((f) => f.landedAt === '2026-09-25'), 'a boundary on `until` is inside');
  const before = epoch.featuresBetween('2026-09-24', '2026-09-24');
  assert.ok(!before.some((f) => f.landedAt === '2026-09-25'), 'a boundary after `until` is outside');
  const openEnded = epoch.featuresBetween('2026-09-26', null);
  assert.ok(openEnded.length >= 1, 'an open-ended window must still find the newest boundaries');
});
