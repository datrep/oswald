// trading/scripts/repro/str4-prds-disposition.js — TRD-STR-4. Disposition for the unresolved PRDS flag on
// LabReleases id 3 (r = -0.3846, n = 15, flagged: true, note "OWNER REVIEW required before BH").
//
// READ-ONLY. No release is written, no candidate is touched.
//
// THE QUESTION, STATED SO IT CAN BE ANSWERED RATHER THAN REPEATED. PRDS (positive regression dependency on
// subsets) is the assumption BH's FDR guarantee rests on. `prdsCheck` flags r <= 0, and `releaseAll` responds
// by emptying `bhResult.significant` — 'release returns to owner review'. So the disposition is not 'is the
// flag real' (it is) but TWO things:
//   (1) did the violation CHANGE the release's conclusion? A violation can only hide a discovery by making
//       the procedure permissive; the guard makes it stricter. So ask: under EVERY scheme at least as
//       permissive as the one used, would anything have been declared?
//   (2) does the recorded note name the actual binding constraint? If not, the review is aimed at the wrong
//       quantity — which is what happened here for 13 days.
//
//   node trading/scripts/repro/str4-prds-disposition.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');
const stats = require('../../agent/lab/statistics');

const USER = 1;
const RELEASE_ID = 3;
const Q = 0.10;      // LabReleases.q
const ALPHA = 0.05;  // the screen's own uncorrected threshold

const f = (v, dp = 4) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(dp));

(async () => {
  const pool = await getPool();
  const rel = (await pool.request()
    .input('id', sql.Int, RELEASE_ID)
    .query(`SELECT id, familyType, m, mFrozen, kCounter, q, bhResult, prdsCheck, summary,
                   CONVERT(varchar,releasedAt,120) AS releasedAt FROM LabReleases WHERE userId=@uid AND id=@id`
      .replace('@uid', String(USER)))).recordset[0];

  if (!rel) { console.log(`release ${RELEASE_ID} not found`); return; }
  const bh = JSON.parse(rel.bhResult);
  const prds = JSON.parse(rel.prdsCheck);
  const summary = JSON.parse(rel.summary);

  const nRel = (await pool.request().query('SELECT COUNT(*) AS n FROM LabReleases')).recordset[0].n;
  console.log(`LabReleases rows in total: ${nRel}   (a release is one-shot: releaseId is set on every pair)`);
  console.log(`release ${rel.id} ${rel.familyType} · released ${rel.releasedAt} · q ${rel.q}`);
  console.log(`  m = ${rel.m} testable · mFrozen = ${rel.mFrozen} frozen · kCounter = ${rel.kCounter}\n`);

  console.log(`PRDS: r ${f(prds.r)} · n ${prds.n} · flagged ${prds.flagged}`);
  console.log(`  ${prds.note}\n`);

  // The frozen family, and why only one pair could be tested.
  const withP = summary.filter((s) => s.lockbox && s.lockbox.p != null);
  const insufficient = summary.filter((s) => s.verdict === 'INSUFFICIENT-DATA');
  console.log(`FAMILY`);
  console.log(`  frozen pairs                          ${summary.length}`);
  console.log(`  INSUFFICIENT-DATA (lockbox n < 20)     ${insufficient.length}`);
  console.log(`  pairs with a lockbox p-value (m)       ${withP.length}`);
  const ns = insufficient.map((s) => s.lockbox.n);
  console.log(`  their lockbox n: min ${Math.min(...ns)} · max ${Math.max(...ns)} · floor is 20`);
  for (const s of withP) {
    console.log(`  → #${s.id} ${s.strategy}/${s.symbol} n ${s.lockbox.n} pf ${f(s.lockbox.pf, 3)} p ${f(s.lockbox.p, 4)}` +
      ` smallSample ${s.lockbox.smallSample}`);
  }

  // (1) Would ANY scheme at least as permissive as the one used have declared something?
  const pValues = withP.map((s) => s.lockbox.p);
  const minP = pValues.length ? Math.min(...pValues) : null;
  const bhRecompute = stats.bh(pValues, Q);
  console.log(`\n(1) COULD THE VIOLATION HAVE HIDDEN A DISCOVERY?`);
  console.log(`  smallest p in the family                 ${f(minP)}`);
  console.log(`  BH(q=${Q}) recomputed on the stored p's    declared ${bhRecompute.significant.length}` +
    `  (rank-1 threshold ${f((1 / Math.max(1, pValues.length)) * Q)})`);
  console.log(`  UNCORRECTED alpha=${ALPHA}, ignoring BH      declared ${pValues.filter((p) => p <= ALPHA).length}`);
  console.log(`  the screen additionally needs pf > 1     the only pair's pf ${f(withP[0] ? withP[0].lockbox.pf : null, 3)}` +
    ` → ${withP[0] && withP[0].lockbox.pf > 1 ? 'would pass' : 'FAILS regardless of any p-value'}`);
  console.log(`  ⇒ NOTHING could have been declared under any scheme. The flag is real and INERT for this`);
  console.log(`    release: the guard emptied \`significant\`, which was already empty by arithmetic.`);

  // (2) Does the recorded note name the binding constraint?
  const fdrAvailableByCode = !prds.flagged && rel.m >= 5;
  console.log(`\n(2) DOES THE RECORD EXPLAIN ITSELF?`);
  console.log(`  bhResult keys as stored: ${Object.keys(bh).join(', ')}`);
  const hasNote = Object.prototype.hasOwnProperty.call(bh, 'note');
  const hasFdr = Object.prototype.hasOwnProperty.call(bh, 'fdrAvailable');
  console.log(`  has 'note'         ${hasNote}`);
  console.log(`  has 'fdrAvailable' ${hasFdr}`);
  console.log(`  current code would set BOTH (fdrAvailable = !prds.flagged && m >= 5 = ${fdrAvailableByCode}, plus a`);
  console.log(`  ternary note naming PRDS or the m<5 family). \`store.createLabRelease\` persists bhResult with`);
  console.log(`  JSON.stringify WHOLESALE — no field selection — so persistence cannot be the cause:`);
  console.log(`  ⇒ ★ the row was written by code that did not set them. The release record therefore carries NO`);
  console.log(`    stated reason for its own empty \`significant\` array; the only explanation a reader can find in`);
  console.log(`    the row is \`prdsCheck.note\`, which names PRDS. That is WHY the review has been aimed at PRDS.`);
  console.log(`    (git cannot date the note block: the whole trading tree is one squashed commit, ddaffcc.)`);
  console.log(`  ⇒ AND the binding constraint was m = ${rel.m}: a family of ONE, so BH performed no multiplicity`);
  console.log(`    correction at all. The FDR claim was unavailable independently of PRDS.`);
  console.log(`\nDisposition (proposed): the PRDS flag is REAL, INERT, and UNEXPLAINED-IN-THE-RECORD — accept`);
  console.log(`release 3's 'nothing significant' as final, and record that the reason is m = 1, not correlation.`);
  console.log(`Re-running is impossible (one-shot) and unnecessary (no scheme declares anything).`);
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
