'use strict';
// trading/agent/constraintBootstrap.js — Phase 6: seed the constraint ledger from what the desk already captured.
//
// ★ WHAT THIS DOES NOT DO. It does not reconstruct history. `Instruments` UPSERTS in place and moves `capturedAt`
// (`store/instruments.js`), so it cannot say what a term was last month — every row produced here is written with
// `effectiveFrom = null`, which the resolver treats as a CANDIDATE: visible, never in force, and enough to make an
// affected audit `unassessable`. That is the honest outcome and it is the point of the pilot: the first useful
// measurement this system produces is how much of the book has NO datable constraint.
//
// ⚠ AND IT IS A CAPTURE, NOT A CLAIM. Everything lands as `verificationState = 'observed'`, not `confirmed`: nobody
// has checked it against the venue page, and the row cannot pretend otherwise. Promotion to `confirmed` is a
// deliberate operator act and requires a retained artefact (enforced by `constraints.validateVersion`).
//
// THE ARTEFACT IS REAL. Each run writes the SOURCE ROWS it read to
//     trading/archive/constraint-evidence/bootstrap-<timestamp>.json
// and every row it creates references that file with its sha256. That is what makes the capture re-examinable
// later — a digest alone would prove only that something existed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fundingMinuteFromText } = require('./time');
const constraints = require('./constraints');

const VENUE = 'plus500';
const EVIDENCE_DIR = path.join(__dirname, '..', 'archive', 'constraint-evidence');

// The pilot fields, per the scoping decision (Q7). ⚠ `leverage` is deliberately ABSENT: measured on 2026-10-27,
// `leverageRaw` and `initialMarginPct` are one fact — 1/5 = 20%, 1/10 = 10%, and 1:1.67 is the ROUNDED rendering of
// 60%. Storing both would be two producers of one fact, and they disagree in the third case (59.88 vs 60).
const FIELDS = ['minimum_trade_size', 'initial_margin_pct', 'funding_buy_pct', 'funding_sell_pct', 'funding_time'];

// PURE. One instrument row -> the constraint patches it supports. Absent source values produce NO patch rather than
// a zero: `Number(null) === 0` here would declare a free trade, which is the coercion this repo has paid for
// repeatedly.
function patchesForInstrument(row, { venue = VENUE, sourceUrl = null } = {}) {
  if (!row || row.venueInstrumentId == null) return [];
  const id = String(row.venueInstrumentId).toLowerCase();
  const key = (field) => `${venue}.${id}.${field}`;
  const base = {
    subjectKind: 'instrument',
    venue,
    venueInstrumentId: String(row.venueInstrumentId),
    effectiveFrom: null,            // ⚠ UNKNOWN. Never "it was always so".
    verificationState: 'observed',
    issuer: venue,
    sourceUrl,
    note: row.symbol ? `source row symbol: ${row.symbol}` : null,
  };
  const out = [];

  const min = row.unitAmount == null ? null : Number(row.unitAmount);
  if (min != null && Number.isFinite(min) && min > 0 && row.unitKind) {
    out.push({ ...base, constraintKey: key('minimum_trade_size'), constraintType: 'numeric_limit',
      valueNumeric: min, valueUnit: String(row.unitKind) });
  }

  const margin = row.initialMarginPct == null ? null : Number(row.initialMarginPct);
  if (margin != null && Number.isFinite(margin) && margin > 0) {
    out.push({ ...base, constraintKey: key('initial_margin_pct'), constraintType: 'numeric_limit',
      valueNumeric: margin, valueUnit: 'percent' });
  }

  for (const [field, col] of [['funding_buy_pct', 'fundingBuyPct'], ['funding_sell_pct', 'fundingSellPct']]) {
    const v = row[col] == null ? null : Number(row[col]);
    // ⚠ A NEGATIVE FUNDING RATE IS A COST, NOT AN ABSENCE, so the sign must survive. Only a non-finite or missing
    // value produces no patch; `v !== 0` is NOT the test.
    if (v != null && Number.isFinite(v)) {
      out.push({ ...base, constraintKey: key(field), constraintType: 'numeric_limit',
        valueNumeric: v, valueUnit: 'pct_per_night' });
    }
  }

  const minutes = row.fundingTime ? fundingMinuteFromText(row.fundingTime) : null;
  if (minutes != null && Number.isInteger(minutes)) {
    out.push({ ...base, constraintKey: key('funding_time'), constraintType: 'time_of_day',
      valueMinutesUtc: minutes });
  }

  return out;
}

// The venue-wide prohibition, captured once rather than per instrument. ⚠ This one is `asserted`, not `observed`:
// it is not read from the venue page, it is a MEASURED OPERATIONAL FACT (a second tab produces a sign-out and an
// entry block). Calling it `observed` would overstate where it came from.
function venueProhibition() {
  return {
    constraintKey: `${VENUE}.single_tab`,
    subjectKind: 'venue',
    venue: VENUE,
    venueInstrumentId: null,
    constraintType: 'prohibition',
    effectiveFrom: null,
    verificationState: 'asserted',
    issuer: VENUE,
    note: 'measured 2026-10-26: a second Plus500 tab produced a sign-out and a 4h45m entry block',
  };
}

const digestOf = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Is this exact assertion already recorded as an undated candidate? Re-running a bootstrap must not accumulate
// duplicates — and the overlap guard cannot help, because undated rows are candidates rather than periods.
function alreadyPresent(existing, patch) {
  return existing.some((r) => r.effectiveFrom == null
    && r.constraintType === patch.constraintType
    && (patch.valueNumeric == null || Number(r.valueNumeric) === Number(patch.valueNumeric))
    && (patch.valueUnit == null || r.valueUnit === patch.valueUnit)
    && (patch.valueEnum == null || r.valueEnum === patch.valueEnum)
    && (patch.valueMinutesUtc == null || Number(r.valueMinutesUtc) === Number(patch.valueMinutesUtc)));
}

// Write the artefact FIRST, so no row can reference a file that was never written.
function writeArtefact(rows, { now = new Date() } = {}) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(EVIDENCE_DIR, `bootstrap-${stamp}.json`);
  const body = JSON.stringify({ capturedAt: now.toISOString(), source: 'Instruments', rows }, null, 2);
  fs.writeFileSync(file, body, 'utf8');
  return { ref: path.relative(path.join(__dirname, '..', '..'), file).replace(/\\/g, '/'), digest: digestOf(body) };
}

module.exports = { VENUE, FIELDS, EVIDENCE_DIR, patchesForInstrument, venueProhibition, alreadyPresent, digestOf, writeArtefact };
