// test/analyses-note-hash.test.js — 2026-10-27. The dedupe key for `AnalysesNotes` (migration 054).
//
// ⚠ WHY THIS IS PINNED RATHER THAN TRUSTED. The writer's `NOT EXISTS` guard and the unique index are both only as good
// as this function: if the hash moves when nothing about the observation moved, re-captures duplicate again and the
// guard reports success; if it does NOT move when the analysis changed, the ledger silently loses rows. Both failures
// are invisible at the call site, so the definition of "the same read" is asserted here.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { analysesNoteHash } = require('../trading/store');

const base = {
  kind: 'instrument',
  symbol: 'Gold',
  title: 'Gold Intraday: Key Resistance Focus 4214',
  url: 'https://app.plus500.com/premiumhub',
  source: 'capture',
  rawText: 'Gold Intraday\nKey Resistance Focus 4214\nSupport 4180',
};

test('the same observation hashes the same', () => {
  assert.strictEqual(analysesNoteHash(base), analysesNoteHash({ ...base }));
});

test('a sha256 hex digest, so the column width is honest', () => {
  assert.match(analysesNoteHash(base), /^[0-9a-f]{64}$/);
});

test('whitespace is normalised — the DOM re-wraps between runs', () => {
  // ⚠ THE CASE THIS EXISTS FOR. The captured text carries the page's line wrapping; two reads of an unchanged page
  // differ in indentation and newlines alone. Hashing those verbatim would suppress NOTHING, which is the failure mode
  // that looks identical to a working guard because it produces no error.
  const rewrapped = { ...base, rawText: 'Gold Intraday   Key Resistance Focus 4214\n\n   Support 4180  ' };
  assert.strictEqual(analysesNoteHash(base), analysesNoteHash(rewrapped));
});

test('changed analysis text is a different observation', () => {
  assert.notStrictEqual(analysesNoteHash(base), analysesNoteHash({ ...base, rawText: `${base.rawText}\nResistance 4250` }));
});

test('the lane is part of the key — text capture and vision are different observations', () => {
  assert.notStrictEqual(analysesNoteHash(base), analysesNoteHash({ ...base, source: 'capture-vision' }));
});

test('the symbol, title and url are part of the key', () => {
  for (const field of ['symbol', 'title', 'url', 'kind']) {
    assert.notStrictEqual(analysesNoteHash(base), analysesNoteHash({ ...base, [field]: 'different' }),
      `${field} must distinguish two observations`);
  }
});

test('capture metadata is EXCLUDED — a parser improvement must not look like a venue change', () => {
  // ⚠ THE OTHER DIRECTION, AND IT IS THE ONE THAT WOULD HAVE BITTEN. `note` and `parseStatus` describe how the capture
  // WENT, not what was read. Including them would re-append the same analysis every time the parser's status string
  // changed, and the ledger would fill with rows that differ only in metadata.
  assert.strictEqual(analysesNoteHash(base), analysesNoteHash({ ...base, note: 'capture: no_levels', parseStatus: 'vision_unparsed' }));
});

test('absent fields and absent-vs-empty do not throw', () => {
  assert.match(analysesNoteHash({}), /^[0-9a-f]{64}$/);
  assert.strictEqual(analysesNoteHash({}), analysesNoteHash({ symbol: null, title: undefined, rawText: '' }));
});
