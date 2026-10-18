// trading/scripts/lab-register-s3.js — register the S3 candidate in the Strategy Lab and run its ADVISORY score.
//
// ★ WHAT THIS DOES NOT DO: `releaseAll`. The lockbox is a ONE-SHOT, FAMILY-WIDE event —
// `scoreCandidate` says so itself: *"the lockbox is deliberately NOT touched here — it releases once, at the
// single release event; 'every registered pair scored together' then. Zero-edge discipline: W4 is spent exactly
// once."* So the out-of-sample window for the whole frozen family is not spent by this script, and spending it
// is a separate, deliberate act.
//
// ★ WHAT REGISTERING COMMITS. `registrationNo` = `K_BASE + count + 1`, which is the family's k. Adding a pair
// therefore widens the multiple-comparison correction that the next release applies to EVERY frozen pair. That
// is the intended mechanism — pre-register, then release once — but it is a research-integrity act rather than
// a code change, which is why this script refuses to write without `--yes` and prints the whole row first.
//
// Usage (from the repo root):
//   node trading/scripts/lab-register-s3.js           # DRY RUN — prints what it would write
//   node trading/scripts/lab-register-s3.js --yes     # writes the row, then scores ADVISORY A/B
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool } = require('../../shared/db');
const store = require('../store');
const lab = require('../agent/lab/scoreboard');
const { DEFAULTS: STRUCTURE_DEFAULTS } = require('../agent/structure');
const s3 = require('../agent/strategies/survGoldStruct');

const args = process.argv.slice(2);
const APPLY = args.includes('--yes');
// ★ ARGUMENT ORDER MATTERS HERE, and getting it wrong produced a silent no-op. `--archive 23` used to let the
// bare `23` be consumed by the USER-ID matcher as well, so the script queried `userId = 23`, found nothing and
// reported "no candidate 23" — which reads exactly like a missing row. The archive target is resolved FIRST and
// then excluded from the user-id search. Same class as everything else in this session: an argument accepted
// and quietly assigned to the wrong thing.
const archiveIdx = args.indexOf('--archive');
const ARCHIVE_ID = archiveIdx >= 0 ? Number(args[archiveIdx + 1]) : null;
const userIdArg = args.find((a, i) => /^\d+$/.test(a) && i !== archiveIdx + 1);
const USER_ID = Number(userIdArg) || 1;

const STRATEGY = 'survgoldstruct';
const SYMBOL = 'Gold';
// ★ VENUE = THE SIGNAL SERIES, NOT THE GATE'S. Registered 2026-09-23 after measuring what each choice costs
// (`trading/scripts/repro/gate-predicate-screen.js` section E). The Lab loads ONE series per candidate, so one
// of the two must mismatch, and three things decide which:
//
//   1. SAMPLE SIZE — the whole question. `plus500_chart` holds 1,141 bars (69.6 d) → 34 control trades, so W4
//      (last 10%) would carry ~3 and could never clear the desk's n>=20 gate, spending the ONE-SHOT lockbox
//      for nothing. `yahoo` holds 11,657 bars (741 d) → 331 control trades → ~33 in W4.
//   2. THE CONTROL'S BASELINE — `survgold`'s pre-registered baseline was established on the yahoo series. §12
//      chose it as the control precisely BECAUSE that baseline is known by construction; pairing on a different
//      series would quietly turn "against its pre-registered baseline" into "against a different series".
//   3. SIGNAL FIDELITY — live `survgold` computes its Donchian from the INDICATOR series, which for Gold is
//      yahoo (`IND_VENUE_PREF`). A `plus500_chart` candidate would take DIFFERENT entries, i.e. it would not be
//      testing the live signal at all, only a filter applied to something else.
//
// ⚠ THE RESIDUAL ASYMMETRY, RECORDED NOT HIDDEN: in the backtest the gate now reads structure from YAHOO bars,
// while LIVE it reads the venue of record (`plus500_chart`). §7 rule 4 wants those to agree, and S3 cannot make
// them agree because the Lab loads one series. This is the SIGNAL that matches live; the GATE's input does not.
const VENUE = 'yahoo';

// ★ A CANDIDATE'S TRADE COUNT IS UNINTERPRETABLE WITHOUT ITS CONTROL, and the control must run on the SAME
// series, the SAME seed and the SAME stages or the comparison is not paired. `survgold` is scored here with
// `save: false` so nothing is written: it is already a registered survivor and re-scoring it must not touch
// its row. Same `registrationNo` ⇒ same seed ⇒ same walk-forward windows.
async function compare(userId, cand) {
  const control = { strategy: 'survgold', symbol: SYMBOL, venue: VENUE, params: {}, registrationNo: cand.registrationNo };
  const gated = await lab.scoreCandidate(userId, cand, { save: false });
  const ungated = await lab.scoreCandidate(userId, control, { save: false });
  if (gated.error || ungated.error) {
    console.log(`  score error — gated: ${gated.error || 'ok'} | control: ${ungated.error || 'ok'}`);
    return;
  }
  console.log(`\n=== ADVISORY, PAIRED (A/B only — the LOCKBOX is untouched) ===`);
  console.log(`  series: ${gated.score.venue} · ${gated.score.bars} bars · span ${gated.score.spanDays} d`);
  console.log('  ' + 'stage'.padEnd(7) + 'gated n'.padStart(9) + 'gated pf'.padStart(11)
    + 'control n'.padStart(11) + 'control pf'.padStart(12) + '  blocked');
  const stages = Object.keys(gated.score.stages || {});
  for (const s of stages) {
    const g = gated.score.stages[s] || {};
    const u = ungated.score.stages[s] || {};
    const blocked = (u.n != null && g.n != null) ? `${u.n - g.n}` : '—';
    console.log('  ' + String(s).padEnd(7) + String(g.n ?? '—').padStart(9)
      + (g.pf == null ? '—' : Number(g.pf).toFixed(2)).padStart(11)
      + String(u.n ?? '—').padStart(11)
      + (u.pf == null ? '—' : Number(u.pf).toFixed(2)).padStart(12) + '  ' + blocked
      + (g.verdict ? `   gated=${g.verdict}` : ''));
  }
  console.log('\n  lockboxSpent:', gated.score.lockboxSpent, '(must be false — W4 is spent once, at release)');
  console.log('  n below 20 has no referent for a win-rate comparison (field-contracts / EVIDENCE_THRESHOLDS),');
  console.log('  so an INSUFFICIENT-DATA verdict here is the expected answer and NOT a result (§14.5).');
}

async function main() {
  await getPool();

  if (ARCHIVE_ID) {
    const cand = await store.getLabCandidate(USER_ID, ARCHIVE_ID);
    if (!cand) { console.log(`no candidate ${ARCHIVE_ID}`); await getPool().then((p) => p.close()); return; }
    const reason = 'MIS-REGISTERED VENUE: registered against plus500_chart, whose whole history is 1,141 bars '
      + '(69.6 d) — 34 control trades, so W4 (last 10%) would carry ~3 and could never reach the desk\'s n>=20 '
      + 'gate, spending the one-shot lockbox for nothing. The signal series is the indicator series (yahoo, '
      + '11,657 bars / 741 d, 331 control trades), which is ALSO the series the control\'s pre-registered '
      + 'baseline was established on. Re-registration pending the venue decision.';
    if (!APPLY) { console.log('DRY RUN — would archive:', ARCHIVE_ID, '\n reason:', reason); await getPool().then((p) => p.close()); return; }
    await lab.archiveCandidate(USER_ID, ARCHIVE_ID, { reason });
    console.log(`archived candidate ${ARCHIVE_ID} — it will not be frozen by the next release.`);
    await getPool().then((p) => p.close());
    return;
  }

  const all = await store.listLabCandidates(USER_ID, { statuses: ['registered', 'frozen', 'archived'] });
  // ★ AN ARCHIVED ROW IS HISTORY, NOT A BLOCKER. A withdrawn candidate must not prevent registering its
  // replacement — otherwise a mis-registration can never be corrected, which is the opposite of what archiving
  // is for. Only a LIVE status blocks.
  const dup = all.find((c) => c.strategy === STRATEGY && c.symbol === SYMBOL && c.status !== 'archived');
  if (dup) {
    console.log(`already registered: id ${dup.id} #${dup.registrationNo} status ${dup.status} — nothing to write.`);
    await compare(USER_ID, dup);
    await getPool().then((p) => p.close());
    return;
  }
  const archived = all.filter((c) => c.strategy === STRATEGY && c.symbol === SYMBOL && c.status === 'archived');
  if (archived.length) {
    console.log(`note: ${archived.length} archived row(s) for this pair (${archived.map((c) => `#${c.registrationNo}`).join(', ')}) — history, not a blocker.`);
  }

  const count = await store.countLabCandidates(USER_ID);
  const registrationNo = lab.K_BASE + count + 1;

  // The params ARE the pre-registration record, and they are DERIVED from the engine's own DEFAULTS rather than
  // typed out — a hand-copied set is a set that can disagree with what runs (design doc §14.2, pinned by
  // `test/s3-preregistration.test.js`). `structureParamsFrom` in the strategy reads these same keys back out of
  // `cfg`, so the recorded numbers are the numbers the gate uses.
  // Derived through the SAME key list the gate reads back out of `cfg`, so the recorded set cannot contain a
  // key the gate ignores nor omit one it uses. `test/s3-preregistration.test.js` asserts the two are equal.
  const params = s3.structureParamsFrom(STRUCTURE_DEFAULTS);

  const row = {
    strategy: STRATEGY,
    symbol: SYMBOL,
    venue: VENUE,
    params,
    label: 'S3 structure gate (predicate (a) direction-agrees) vs its ungated control survgold',
    registrationNo,
  };

  console.log('\n=== candidate to register ===');
  console.log(`  family size now        : ${count}  (K_BASE ${lab.K_BASE})`);
  console.log(`  registrationNo (k)     : ${registrationNo}   seed ${lab.seedFor(registrationNo)}`);
  console.log(`  strategy / symbol      : ${STRATEGY} / ${SYMBOL}`);
  console.log(`  venue (series loaded)  : ${VENUE}`);
  console.log(`  label                  : ${row.label}`);
  console.log('  params (the pre-registration record, derived from structure DEFAULTS):');
  console.log('   ', JSON.stringify(params));
  console.log('\n  NOT part of this hypothesis: the activity measure\'s days/minSamples (§14.3) are deliberately');
  console.log('  absent from `params`, because the gate does not read `activity` and recording them here would');
  console.log('  suggest varying them is part of the test.');

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --yes to register and score ADVISORY A/B.');
    await getPool().then((p) => p.close());
    return;
  }

  const created = await store.createLabCandidate(USER_ID, row);
  console.log(`\nregistered: id ${created.id} #${created.registrationNo}`);
  await compare(USER_ID, await store.getLabCandidate(USER_ID, created.id));

  await getPool().then((p) => p.close());
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
