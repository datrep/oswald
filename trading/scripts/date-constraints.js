'use strict';
// trading/scripts/date-constraints.js â€” give every bootstrapped constraint a BOUNDED start so it can be judged.
//
// â˜… WHY. The bootstrap captured 50 contract-spec facts from the venue page and could not date any of them: the page
// says what a term IS, never when it began. An undated row is a CANDIDATE, and one candidate makes every affected
// assessment `unassessable` â€” so the ledger held the facts and could answer nothing.
//
// âš âš  WHAT THIS DOES *NOT* DO: it does not invent a start date. `effectiveFrom = <a guess>` would assert an instant no
// evidence supports, which is the fabrication the whole table is built to refuse. Instead the start is BOUNDED
// (`effectiveFromNotBefore`/`NotAfter`, migration 053): the true start lies SOMEWHERE inside that interval, so
//   Â· before it     â€” the row cannot have started (NOT_IN_FORCE),
//   Â· inside it     â€” neither answer is available (UNCERTAIN),
//   Â· at/after it   â€” it had certainly started (IN_FORCE, decisively).
// The interval is the desk's own era: [2026-09-19, 2026-10-26]. Nothing before 2026-09-19 is claimed and nothing
// about the desk's prototype period is measured â€” the owner's rule, and it is also the earliest date the epoch
// registry knows anything about.
//
// âš  THE ORIGINAL ROW IS SUPERSEDED, NOT EDITED. These are append-only ledgers: the undated capture was a correct
// record of what was observed, and the dated row is the same fact with its window added. `resolveSubject` retires a
// superseded row (see `supersededIds`), which is what stops the original candidate from blocking for ever.
//
// âš  `plus500.single_tab` IS DELIBERATELY LEFT UNDATED. It is an operational prohibition we learned about on
// 2026-10-26 by watching the venue sign a second tab out â€” the venue did not CHANGE that day, we found out. Bounding
// it would put OUR learning date into the world's record.
//
// Usage:  node trading/scripts/date-constraints.js [--dry]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const cstore = require('../store/constraints');
const c = require('../agent/constraints');

const USER = 1;
const FROM = '2026-09-19T00:00:00Z';   // the desk's first registered era
const TO = '2026-10-26T00:00:00Z';     // the capture date the values were read on
const RECORDED_BY = 'dating:bounded-era';
const UNDATABLE = new Set(['plus500.single_tab']);
const NOTE = 'Dated by policy 2026-10-27: the term is in force as captured, its true start is unknown, so the start '
  + 'is BOUNDED to the desk era rather than asserted. Before 2026-09-19 the desk claims nothing; after 2026-10-26 the '
  + 'constraint is decisively in force.';

const isCandidate = (r) => r && !r.effectiveFrom && !r.effectiveFromNotBefore && !r.effectiveFromNotAfter;

async function main() {
  const dry = process.argv.includes('--dry');
  const rows = await cstore.subjectVersions(USER);
  const retired = c.supersededIds(rows);
  const live = rows.filter((r) => !c.isRetired(r, retired));
  const candidates = live.filter(isCandidate);

  const toDate = candidates.filter((r) => !UNDATABLE.has(r.constraintKey));
  const leftUndated = candidates.filter((r) => UNDATABLE.has(r.constraintKey));

  console.log(`=== DATE CONSTRAINTS ${dry ? '(dry run)' : ''} ===`);
  console.log(`  rows in ledger      : ${rows.length}`);
  console.log(`  live (not retired)  : ${live.length}`);
  console.log(`  undated candidates  : ${candidates.length}`);
  console.log(`  will be dated       : ${toDate.length}`);
  console.log(`  left undated        : ${leftUndated.length}${leftUndated.length ? ' (' + leftUndated.map((r) => r.constraintKey).join(', ') + ')' : ''}`);
  console.log(`  interval            : [${FROM}, ${TO})`);

  if (dry) {
    for (const r of toDate.slice(0, 8)) console.log(`    Â· ${r.constraintKey}`);
    if (toDate.length > 8) console.log(`    Â· â€¦ and ${toDate.length - 8} more`);
    console.log('\ndry run â€” nothing written');
    return;
  }

  let ok = 0;
  const failed = [];
  for (const r of toDate) {
    try {
      await cstore.appendVersion(USER, {
        constraintKey: r.constraintKey,
        subjectKind: r.subjectKind,
        venue: r.venue,
        venueInstrumentId: r.venueInstrumentId,
        constraintType: r.constraintType,
        valueNumeric: r.valueNumeric,
        valueUnit: r.valueUnit,
        valueEnum: r.valueEnum,
        valueMinutesUtc: r.valueMinutesUtc,
        // The window, not a date.
        effectiveFrom: null,
        effectiveFromNotBefore: FROM,
        effectiveFromNotAfter: TO,
        effectiveTo: null,
        supersedesId: Number(r.constraintVersionId),
        verificationState: r.verificationState,
        issuer: r.issuer,
        recordedBy: RECORDED_BY,
        // The evidence travels with the correction â€” the artefact is the same one the original capture retained.
        evidenceExcerpt: r.evidenceExcerpt,
        evidenceArtifactRef: r.evidenceArtifactRef,
        evidenceDigest: r.evidenceDigest,
        sourceUrl: r.sourceUrl,
        note: NOTE,
      });
      ok += 1;
    } catch (e) {
      failed.push({ key: r.constraintKey, id: Number(r.constraintVersionId), error: String((e && e.message) || e).slice(0, 200) });
    }
  }

  console.log(`\n  appended            : ${ok}`);
  if (failed.length) {
    console.log(`  REFUSED             : ${failed.length}`);
    for (const f of failed.slice(0, 10)) console.log(`    X ${f.key} (id ${f.id}) â€” ${f.error}`);
  }

  // âš  VERIFY AT THE DESTINATION. An append that returned is not the same as a resolver that now answers.
  const after = await cstore.subjectVersions(USER);
  const afterRetired = c.supersededIds(after);
  const stillCandidates = after.filter((r) => !c.isRetired(r, afterRetired)).filter(isCandidate);
  // âš  A REMAINING CANDIDATE IS NOT AUTOMATICALLY A FAILURE. `plus500.single_tab` is SUPPOSED to stay undated, so
  // the check is "nothing beyond the declared exceptions", not "zero candidates". The first version of this line
  // exited non-zero on a clean run because it asked the wrong question â€” the same defect as a guard that cannot
  // distinguish "quiet" from "broken", in a script written to avoid exactly that.
  const unexpected = stillCandidates.filter((r) => !UNDATABLE.has(r.constraintKey));
  const overlaps = await cstore.overlaps(USER);
  console.log(`\n  after â€” rows        : ${after.length}`);
  console.log(`  after â€” candidates  : ${stillCandidates.length} (declared exceptions: ${stillCandidates.filter((r) => UNDATABLE.has(r.constraintKey)).map((r) => r.constraintKey).join(', ') || 'none'})`);
  console.log(`  after â€” unexpected  : ${unexpected.length}${unexpected.length ? ' (' + unexpected.map((r) => r.constraintKey).join(', ') + ')' : ''}`);
  console.log(`  overlaps view       : ${overlaps.length} row(s) â€” must be 0`);

  // A dated row must now resolve DECISIVELY for an instant after the interval.
  const sample = after.find((r) => r.constraintKey === 'plus500.11.minimum_trade_size' && r.effectiveFromNotBefore);
  if (sample) {
    const resolved = c.resolveSubject([sample], { venue: 'plus500', venueInstrumentId: '11', at: '2026-10-27T00:00:00Z' });
    console.log(`  probe at 2026-10-27 : inForce=${resolved.inForce.length} uncertain=${resolved.uncertain.length} candidates=${resolved.candidates.length}`);
  }

  const bad = failed.length || overlaps.length || unexpected.length;
  console.log(bad ? '\nNOT CLEAN â€” see above' : '\nclean');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
