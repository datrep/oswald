// test/quant-panel-disclosure.test.js — TRD-LLM-3: the chairs are shown the deterministic panel.
//
// THE DEFECT. In `deliberateOne`, `quantVotes()` ran and its result was used for the record and for the 50/50
// committee blend — and was then discarded, because `chairVotes` was called with `focusText + sizeNote` only. So
// a seat voted on a proposal whose only in-scope deterministic confirmation was invisible to it, while the
// READER of the stored decision saw both. The seat judged half of a blend it could not see.
//
// ⚠ WHAT IS PINNED HERE IS AS MUCH ABOUT WHAT IS *NOT* SHOWN. The row that raised this warned that a numeric
// score invites deference ("the panel always outvoted it, because the panel had scored the live number" — the
// past defect recorded in promptBuilder). So the disclosure must carry each voter's basis, must NOT carry the
// blended score, and must tell the seat that its own dissent is counted.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const agg = require('../trading/agent/aggregator');

// The shape `quantVotes` really returns.
const QV = {
  votes: [
    { type: 'turtle', weight: 1, vote: 1, note: 'proposal present' },
    { type: 'adx', weight: 0.5, vote: -1, note: 'ADX 13.4 choppy' },
    { type: 'meanrev', weight: 0.5, vote: 0, note: 'not a meanrev proposal (survgold)' },
  ],
  score: 0.25,
};

test('every voter reaches the seat, with its basis and its weight', () => {
  const note = agg.quantPanelNote(QV);
  assert.match(note, /DETERMINISTIC QUANT PANEL/);
  for (const v of QV.votes) {
    assert.ok(note.includes(v.type), `${v.type} must be named`);
    assert.ok(note.includes(String(v.weight)), `${v.type}'s weight must travel with its vote`);
    assert.ok(note.includes(v.note), `${v.type}'s BASIS must travel — a vote without a reason cannot be argued with`);
  }
  // Signs must be explicit: "+1" and "-1" read unambiguously, a bare "1" next to a "0" does not.
  assert.match(note, /vote \+1/);
  assert.match(note, /vote -1/);
  assert.match(note, /vote 0/);
});

test('★ no blended score VALUE is disclosed — a number invites deference, a basis invites argument', () => {
  const note = agg.quantPanelNote(QV);
  assert.ok(!note.includes('0.25'), 'the blended quantScore must not appear as a figure');
  // ⚠ The WORD "score" is legitimate and necessary: the seat has to be told how the panel's group score enters
  // the blend, or it cannot reason about the weight its own seat carries. What must never appear is the VALUE, or
  // any figure presented as the panel's verdict — that is the deference defect. So the assertion targets the
  // pattern, not the word: an earlier version of this test banned the word and failed on its own explanatory
  // sentence, which is a test asserting its own prose rather than the behaviour.
  assert.doesNotMatch(note, /\bscore\b\s*[:=]\s*[-+]?[0-9]/, 'no "score: 0.25" style disclosure');
  assert.doesNotMatch(note, /\btotal\b\s*[:=]/, 'no blended total');
  assert.doesNotMatch(note, /\bmean\b\s*[:=]\s*[-+]?[0-9]/, 'no mean presented as the panel verdict');
});

test('the seat is told its own dissent is scored, so disclosure does not become pressure', () => {
  const note = agg.quantPanelNote(QV);
  assert.match(note, /same weight as the seats/i, 'the blend relationship must be stated, not hidden');
  assert.match(note, /dissent is scored, not discarded/i);
  assert.match(note, /judge the proposal yourself/i);
});

test('an empty or malformed panel produces NO text rather than a dangling heading', () => {
  for (const v of [null, undefined, {}, { votes: [] }, { votes: 'nonsense' }, 0]) {
    assert.strictEqual(agg.quantPanelNote(v), '', `quantPanelNote(${JSON.stringify(v)}) must be empty`);
  }
});

// Non-vacuity: the note must be built from the votes it is HANDED, not from a constant. If it were a constant,
// every assertion above would still pass while the seat was shown another wake's panel.
test('the note is derived from the votes handed in, not from a constant', () => {
  const other = agg.quantPanelNote({ votes: [{ type: 'rsi', weight: 0.5, vote: -1, note: 'RSI 78 overbought' }] });
  const base = agg.quantPanelNote(QV);
  assert.notStrictEqual(base, other);
  assert.ok(other.includes('RSI 78 overbought'));
  assert.ok(!other.includes('turtle'), 'a panel without turtle must not claim one');
});

// ★ THE WIRING, pinned structurally because the failure mode was a MISSING ARGUMENT rather than a wrong value:
// `quantPanelNote(qv)` must appear in the very expression that builds the chair's text. A test that only checks
// the formatter would pass while the aggregator still dropped the note.
test('the chair text expression actually includes the panel note', () => {
  const { code } = require('./_source');
  const src = code('trading/agent/aggregator.js');
  const call = src.match(/cv = await chairVotes\([^;]*;/);
  assert.ok(call, 'chairVotes must still be called from deliberateOne');
  assert.match(call[0], /quantPanelNote\(qv\)/,
    'the panel note must be part of the string handed to chairVotes — this is the exact bug: `qv` was computed'
    + ' one line earlier and left out of this expression');
  assert.match(call[0], /sizeNote/, 'and the risk note must still be there too');
});
