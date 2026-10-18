// test/chair-veto.test.js — TRD-VET-1, decided 2026-09-20.
//
// THE DECISION: a chair MAJORITY vetoes an ENTRY, and only an entry.
//
// THE CASE FOR IT, measured (`temp/chair-veto-analysis.sql` over the desk's whole history): 13 decisions
// carried a chair majority dissenting and ALL 13 were approved — 12 entries and 1 exit — and the 11 that
// filled came to -37.27 gross on a 4-win/7-loss split. The blend let a unanimous quant panel (+1) outvote
// two dissenting chairs (-1/3) to +1/3.
//
// THE REASON IT IS ENTRY-ONLY, and this is the part that has to keep holding: a vetoed ENTRY skips a trade,
// while a vetoed EXIT does not skip anything — it HOLDS a position on the panel's say-so with only the venue
// stop underneath. That is the one direction with an unbounded consequence, so exits are exempt BY
// CONSTRUCTION, and the rule can therefore only ever remove an entry.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const { committeeVerdict } = require('../trading/agent/aggregator');

// The live panel is weighted 0.5 / 1 / 1.5, so the reachable chair scores are 0, ±1/3, ±2/3, ±1.
const caseOf = (over = {}) => committeeVerdict({
  quantScore: 1, chairScore: -1 / 3, chairResponded: 3, hasChairs: true, kind: 'entry',
  chairOffline: false, veto: { enabled: true }, ...over,
});

test('★ the measured case: a chair majority blocks an entry that the blend would have approved', () => {
  const v = caseOf();
  assert.ok(v.total > 0, `the blend alone approves this (total ${v.total}) — that is the defect being fixed`);
  assert.strictEqual(v.majorityDissents, true);
  assert.strictEqual(v.chairVeto, true);
  assert.strictEqual(v.approved, false);
  assert.match(v.reason, /chair VETO/);
});

test('★ the SAME dissent does not block an exit — a veto on an exit holds a position', () => {
  const v = caseOf({ kind: 'exit' });
  assert.strictEqual(v.chairVeto, false);
  assert.strictEqual(v.approved, true);
  assert.strictEqual(v.reason, 'deliberation approved');
});

test('a tie is not a veto, and one dissenting seat is not a majority', () => {
  assert.strictEqual(caseOf({ chairScore: 0 }).chairVeto, false, 'a tie is not dissent');
  assert.strictEqual(caseOf({ quantScore: 0.5, chairScore: 0 }).approved, true);
  assert.strictEqual(caseOf({ chairScore: 1 / 3 }).chairVeto, false, 'one seat out of three dissenting is not a majority');
  assert.strictEqual(caseOf({ chairScore: 2 / 3 }).chairVeto, false);
});

test('unanimous dissent still blocks — as it always did, and not as a "veto"', () => {
  // quant 1.0 against chair -1.0 is total 0, which the blend already refused. The label must not claim the
  // new rule did the work.
  const v = caseOf({ chairScore: -1 });
  assert.strictEqual(v.approved, false);
  assert.strictEqual(v.chairVeto, false, 'the blend blocked this one; saying "veto" would misattribute it');
  assert.strictEqual(v.reason, 'deliberation declined');
  // ★ TRD-VET-2 (2026-09-28): THE TIE NOW CARRIES ITS OWN NAME. The assertion above is the point of this case —
  // "veto" would misattribute it — and until now nothing replaced the missing label, so a tie was
  // indistinguishable in the record from a moderate chair-majority decline. 57 of the desk's 92 non-veto declines
  // are exactly this shape, which is why the veto counter reports 35 where the chair side decided 113.
  assert.strictEqual(v.tie, true, 'equal halves IS the tie');
  assert.strictEqual(v.attribution, 'tie', 'and it must be countable as a tie, not merely as "declined"');
});

test('★ every outcome carries an attribution, and the attribution names the deciding side', () => {
  // ⚠ THE WHOLE POINT IS THAT A REPORT STOPS READING PROSE. Each case here is a shape the desk has actually
  // produced, and the attribution has to be derivable from the same locals the outcome was.
  // The default case is `quantScore 1 / chairScore -1/3` (total +1/3, a minority dissenting) = the measured veto.
  assert.strictEqual(caseOf({ chairScore: 1 }).attribution, 'approved');
  assert.strictEqual(caseOf().attribution, 'chair_veto', 'a majority dissent that BINDS is the veto');
  assert.strictEqual(caseOf({ chairScore: -1 }).attribution, 'tie', 'equal and opposite is a TIE, not a veto');
  assert.strictEqual(caseOf({ quantScore: 0, chairScore: -1 / 3 }).attribution, 'chair',
    'chair half negative while the panel is merely neutral (total -1/6): the chair dragged it down, and it must not claim a veto');
  assert.strictEqual(caseOf({ quantScore: -1, chairScore: 1 / 3 }).attribution, 'quant', 'the mirror case — and it exists (14 of 92)');
  assert.strictEqual(caseOf({ quantScore: -1, chairScore: -1 }).attribution, 'both', 'neither half positive is not one side\'s fault');
  assert.strictEqual(caseOf({ quantScore: -1, chairOffline: true, chairScore: -1 }).attribution, 'quant',
    'with no seats answering, the panel decides alone — the verdict must not blame a committee that never sat');
  // ⚠ AND THE TWO ARE DIFFERENT FACTS: an exact tie is the committee split, a negative chair score on a negative
  // total is the chair winning. Folding them together is the attribution bug this whole change exists to fix.
  assert.notStrictEqual(caseOf({ chairScore: -1 }).attribution, caseOf({ quantScore: 0, chairScore: -1 / 3 }).attribution);
});

test('★ an abstention is not dissent, and a single responding seat cannot veto', () => {
  // Nobody responded: the score is 0 by construction, and the rule must not fire on "no chairs".
  const none = caseOf({ chairScore: 0, chairResponded: 0 });
  assert.strictEqual(none.chairVeto, false);
  assert.strictEqual(none.approved, true);
  // ONE seat dissenting with a negative score: "majority" has no meaning for a one-seat panel.
  const oneSeat = caseOf({ chairScore: -1, chairResponded: 1 });
  assert.strictEqual(oneSeat.majorityDissents, false, 'minResponders is 2 on purpose');
  assert.strictEqual(oneSeat.chairVeto, false);
});

test('★ a budget-exhausted panel keeps its quant-only path — no veto, no behaviour change', () => {
  const v = caseOf({ chairOffline: true, chairScore: -1, chairResponded: 0 });
  assert.strictEqual(v.approved, true, 'the degraded-entry path is decided by the quant panel, as before');
  assert.strictEqual(v.chairVeto, false);
  assert.strictEqual(v.reason, 'chair unavailable');
});

test('★ { enabled: false } restores the previous behaviour exactly', () => {
  const off = caseOf({ veto: { enabled: false } });
  assert.strictEqual(off.chairVeto, false);
  assert.strictEqual(off.approved, true, 'the old rule approved this: total > 0');
  assert.strictEqual(off.reason, 'deliberation approved');
  // and the old formula is still what `total` is, so nothing else downstream moved
  assert.strictEqual(off.total, 0.5 * 1 + 0.5 * (-1 / 3));
});

test('no chairs configured is the quant panel alone, as before', () => {
  const v = caseOf({ hasChairs: false, chairScore: 0, chairResponded: 0 });
  assert.strictEqual(v.total, 1);
  assert.strictEqual(v.approved, true);
});

test('the verdict is a pure function of its inputs', () => {
  const a = caseOf();
  const b = caseOf();
  assert.deepStrictEqual(a, b);
});

// --- the wiring, pinned so the exemption cannot be lost quietly ---------------

const src = code('trading/agent/aggregator.js');

test('★ the call site passes the SAME kind that chooses entry vs exit', () => {
  assert.match(src, /kind: proposal\.type/,
    'if this became a literal, the exit exemption would silently stop applying');
  assert.match(src, /veto: settings\.deliberation && settings\.deliberation\.chairVeto/,
    'the rule must be switchable off in one setting');
});

test('the veto is recorded on the decision, not only acted on', () => {
  assert.match(src, /chairVeto: verdict\.chairVeto/, 'a rule that cannot be audited per decision cannot be evaluated later');
  // ★ TRD-VET-2: and the ATTRIBUTION has to travel with it, or the rule is auditable but its CAUSE is not.
  assert.match(src, /attribution: verdict\.attribution/, 'the name of the deciding side must be recorded, not re-derived from prose');
});

test('★ ★ the DETERMINISTIC refusal carries an attribution too — it never reached a seat', () => {
  // ⚠ THE PARTITION HAS TO BE TOTAL OR A CENSUS SILENTLY DROPS THE LOUDEST CASES. The risk gate returns BEFORE
  // `committeeVerdict` is ever called, so `votes` is null on those decisions and no `attribution` would be
  // written at all: 17 of 167 decisions are this shape, and grouping non-approvals by attribution would have
  // missed every deterministic refusal — the only refusals the desk can attribute with certainty.
  assert.match(src, /attribution: 'risk_veto'/, 'a refusal with no committee must still name its cause');
  assert.match(src, /riskVetoCodes: risk\.vetoCodes \|\| \[\]/, 'and keep the machine-readable codes beside it');
});

test('one place decides the verdict', () => {
  assert.ok(!/approved = chairOffline \? qv\.score > 0 : total > 0/.test(src),
    'the old inline rule must be gone, or there would be two answers to the same question');
  assert.match(src, /const verdict = committeeVerdict\(\{/);
});
