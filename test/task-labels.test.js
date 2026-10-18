// test/task-labels.test.js — TRD-REG-1: pin the task-label contract.
//
// ★ THE FIXTURE IS THE REAL REGISTER, NOT A RE-TYPING. `test/fixtures/task-labels.register.json` is captured
// from `dbo.Tasks` by `scripts/refresh-task-label-fixture.js` (255 rows at capture: 208 labelled, 47
// unlabelled). That matters because a fixture built from the code's belief rather than the producer's contract
// CANNOT FAIL — the standing lesson, and the same trap that hid the shadow-scorer defect for a week. A label
// regex written by hand and tested against three hand-typed examples proves nothing about the 208 strings the
// register actually contains.
//
// ★ AND THE LOAD-BEARING ASSERTION IS THAT A REPEAT IS *REPORTED*, NOT THAT IT IS FORBIDDEN. A repeated
// prefix is not automatically a defect: `TRD-12` x11, `MOD-1` x19, `MOD-2` x6 and `FS-1` x6 are all the house
// convention — a numbered set split by domain, the convention's own rule being that a function name of 4+
// letters belongs in the DOMAIN rather than as its own segment. So a unique index (or a `COUNT(*) > 1` check)
// would FAIL the existing register, and `repeats()` must therefore report every repeat and let an explicit,
// documented allowlist carry the intent. This test pins both halves: the reporting, and the exact set that is
// currently allowed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { labelOf, repeats, LABEL_RE } = require('../shared/taskLabels');

const FIXTURE = path.join(__dirname, 'fixtures', 'task-labels.register.json');
const reg = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// The four repeats that are intentional and documented in scripts/task-label-hygiene.js's ALLOWED_REPEATS.
// Pinned as an exact SET so that a new, unexpected collision FAILS this test rather than passing silently —
// which is the only reason to assert a snapshot at all.
const ALLOWED = {
  'FS-1': { count: 6, ids: [41, 42, 43, 44, 45, 46] },
  'MOD-1': { count: 19, ids: [75, 76, 77, 78, 79, 80, 87, 88, 89, 90, 91, 92, 104, 105, 106, 107, 108, 109, 110] },
  'MOD-2': { count: 6, ids: [81, 82, 93, 94, 111, 112] },
  'TRD-12': { count: 11, ids: [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210] },
};

test('the fixture is a real register capture, and says so', () => {
  assert.ok(reg.total > 200, `expected a real capture, got total=${reg.total}`);
  assert.strictEqual(reg.rows.length, reg.total, 'rows and total must agree');
  assert.match(reg.capturedAt, /^\d{4}-\d{2}-\d{2}T/, 'capturedAt must be an ISO timestamp');
  assert.ok(reg.labelled > 0 && reg.unlabelled > 0,
    'the capture must contain BOTH labelled and unlabelled rows, or the over-matching test below is vacuous');
});

test('labelOf parses EVERY labelled row in the real register', () => {
  const parsed = reg.rows.filter((t) => labelOf(t.name) !== null);
  assert.strictEqual(parsed.length, reg.labelled,
    'a labelled row the regex misses is a label the guard cannot protect');
  for (const t of parsed) {
    assert.ok(LABEL_RE.test(t.name), `regex and labelOf disagree on id ${t.id}`);
    assert.notStrictEqual(labelOf(t.name), '', `id ${t.id} produced an empty label`);
  }
});

test('labelOf does NOT over-match the unlabelled rows', () => {
  const missed = reg.rows.filter((t) => !LABEL_RE.test(t.name));
  assert.strictEqual(missed.length, reg.unlabelled);
  // A prose mention must not be read as a label: the regex is anchored, and the `:` is required.
  for (const name of ['see TRD-36 for the class-pinning work', 'Fix TRD-118 before TRD-119', 'unlabelled task']) {
    assert.strictEqual(labelOf(name), null, `"${name}" must not yield a label`);
  }
  for (const bad of [null, undefined, '', 0, {}]) {
    assert.strictEqual(labelOf(bad), null, `${JSON.stringify(bad)} must yield null, not throw`);
  }
});

test('★ repeats() reports the four real sets and nothing else', () => {
  const got = repeats(reg.rows);
  const gotLabels = got.map((r) => r.label).sort();
  assert.deepStrictEqual(gotLabels, Object.keys(ALLOWED).sort(),
    'the set of repeated labels changed — if that is a NEW intentional set, document it in ALLOWED_REPEATS '
    + 'and regenerate the fixture; if it is an accident, that is the defect this guard exists to catch');

  for (const r of got) {
    const want = ALLOWED[r.label];
    assert.strictEqual(r.rows.length, want.count, `${r.label} count changed`);
    assert.deepStrictEqual(r.rows.map((x) => x.id), want.ids, `${r.label} ids changed`);
  }

  // And the reporting is a REPORT, not a verdict: the 11-row TRD-12 set must be surfaced, because only an
  // explicit allowlist may quiet it. A `repeats()` that tried to be clever about "intentional" sets would make
  // the trap in the header invisible.
  assert.ok(got.some((r) => r.label === 'TRD-12' && r.rows.length === 11),
    'the TRD-12 set must still be REPORTED — the allowlist is what clears it, not this function');
});

test('repeats(): same labels whatever the input order; WITHIN a group the input order is preserved', () => {
  // ★ MY FIRST VERSION OF THIS TEST WAS WRONG, and the failure is worth keeping. It deep-compared the ARRAYS
  // of groups and expected the reversal to be identical — but `repeats()` keys a Map in order of first
  // appearance, so reversing the input reverses the GROUPS. That is not a defect: the group order carries no
  // meaning, and `scripts/task-label-hygiene.js` only prints it. The invariant that DOES matter is the one
  // named in shared/taskLabels.js — within a group, input order is preserved, which is what lets a caller
  // apply "the newcomer yields" (the TRD-EVD-1 -> TRD-EVD-2 precedent: the row that arrived second is the one
  // renamed). Asserting the wrong invariant would have made this test fail for a non-reason.
  const byLabel = (rows) => {
    const m = new Map();
    for (const r of repeats(rows)) m.set(r.label, r.rows.map((x) => x.id));
    return m;
  };
  const fwd = byLabel(reg.rows);
  const rev = byLabel([...reg.rows].reverse());

  assert.deepStrictEqual([...rev.keys()].sort(), [...fwd.keys()].sort(),
    'the same labels must be reported whatever the input order');

  for (const [label, ids] of fwd) {
    assert.deepStrictEqual(rev.get(label), [...ids].reverse(), `${label}: within-group order must follow the input`);
  }

  const withJunk = [{ id: -1, name: 'no label here' }, ...reg.rows];
  assert.deepStrictEqual(byLabel(withJunk).get('TRD-12'), fwd.get('TRD-12'),
    'an unlabelled row must not join or split a group');
  assert.deepStrictEqual([...byLabel(withJunk).keys()].sort(), [...fwd.keys()].sort());
});

test('the four label SHAPES in this register all parse', () => {
  const shapes = {
    'TRD-118': 'TRD-118',
    'TRD-SHW-4': 'TRD-SHW-4',
    'LST-8': 'LST-8',
    'MOD-1': 'MOD-1',
    'FS-1': 'FS-1',
    'SYNC-2': 'SYNC-2',
    'UAC-5': 'UAC-5',
  };
  for (const [name, label] of Object.entries(shapes)) {
    assert.strictEqual(labelOf(`${name}: something`), label, `${name} must parse`);
  }
  // ★ The TRD-only blind spot, pinned: these are live families and a `TRD-`-anchored regex reads them as null.
  for (const name of ['LST-8: Parts', 'MOD-1: Job application CRUD', 'FS-1: Previews']) {
    assert.notStrictEqual(labelOf(name), null,
      'a TRD-only regex would return null here — the widened net is the point (found 2026-09-24)');
  }
});
