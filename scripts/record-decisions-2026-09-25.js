// scripts/record-decisions-2026-09-25.js — record the two rulings delegated to me.
//
//   TRD-ANC-1 : `risk.maxAnchorAgeSec` stays OFF, with a stated revisit trigger.
//   TRD-110   : ROUTE 3 (commission a lab round on a new pairing); routes 1 and 2 rejected.
//
// ★ APPEND to both rows. Neither is rewritten: TRD-ANC-1 carries today's measurement and its own corrections,
// TRD-110 carries four sessions of prior work including a self-correction.
//
// Checker: whitespace-normalised AND case-insensitive, because these rows are hard-wrapped and three of my
// scripts this session refused themselves on a case difference alone. Idempotency guard on both.
//
// Usage:
//   node scripts/record-decisions-2026-09-25.js          # DRY RUN
//   node scripts/record-decisions-2026-09-25.js --yes    # writes
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const norm = (s) => String(s).replace(/\s+/g, ' ').toLowerCase();
const has = (text, m) => norm(text).includes(norm(m));

const ANC_ADDITION = `
---------------------------------------------------------------------------
2026-09-25 - RULING TAKEN (delegated to me). risk.maxAnchorAgeSec STAYS NULL / OFF.
---------------------------------------------------------------------------
The options and what each costs, from the 30 measured asOf->fill lags:
  120s  refuses 4 of 30 (13%), including #1082 at 524s - the largest drift in the set, 0.455%
  300s  refuses 1 of 30 (3%), #1082 only
  off   refuses none

DECISION: OFF. The reasoning, so it can be overturned on the merits rather than re-derived:

1. THE BENEFIT IS TINY IN MONEY AND THE COST IS A CLOCK. Median |drift| in the upper lag half is 0.043% of
   entry - a fraction of a dollar on a Gold 0.225 oz ticket - while refusing 13% of entries slows the ONE
   clock this desk is waiting on. TRD-29 and TRD-110 both need n>=50 per strategy, and TRD-110's measured
   ETA is ~2026-09-30 for survgold. Trading weeks of sample for a 0.04% geometry improvement is the wrong
   way round.
2. THE FROZEN TRACK WOULD SPLIT MID-ACCUMULATION. survgold/survoil are a frozen candidate (TRD-29, params
   []). Turning the gate on changes WHICH entries exist, so it needs a declared split date and it would
   fragment the very sample it is meant to protect.
3. NOTHING IS LOST BY WAITING. anchorAgeSec and anchorAgeWouldRefuse are recorded on EVERY entry whether or
   not the gate is on, so this decision can be retaken later at no cost.

★ REVISIT TRIGGER, stated so this is a decision and not a slow drift into never deciding: when a survivor
reaches n>=50, read anchorAgeWouldRefuse from fill_telemetry and re-decide. If the refused set shows a
materially worse realised R:R than the accepted set, turn the gate ON with a declared split date. If it does
not, the gate stays off and the drift is a recorded cost of doing business rather than an unexamined one.

NO CODE CHANGE WAS NEEDED: the gate is built, tested, and OFF; this is the settings value left as it was.
`;

const TRD110_ADDITION = `
---------------------------------------------------------------------------
2026-09-25 - RULING TAKEN (delegated to me). ROUTE 3: COMMISSION A LAB ROUND ON A NEW PAIRING.
---------------------------------------------------------------------------
The three routes and their costs were already stated in this row. Decided against the row's OWN standard -
"MORE OPPORTUNITY AT THE SAME BAR, otherwise it trades the sample size for the edge":

  ROUTE 1 - re-enable meanrev on Arabica Coffee / Silver / Sugar. REJECTED. meanrev has ZERO forward record,
    and its three pairs are gate-EXEMPT rather than validated - the desk's own rule is that "an exemption is
    not a validation". It would also reverse TRD-116's cleanup, which cleared exactly those assignments
    because they pointed at a disabled strategy. That buys trades with an unproven edge.
  ROUTE 2 - assign turtle (desk-default dc20/gate20) to new symbols. REJECTED. The desk default does NOT
    confirm (recorded in TRD-26), so it widens onto a configuration already known to fail its own test.
  ROUTE 3 - run a lab round on a new pairing. CHOSEN. The only route that adds opportunity at the same bar
    rather than lowering the bar, which is the standard this row sets.

★ ROUTE 3'S COST IS EFFORT, NOT VALIDITY, AND THAT IS THE DIFFERENCE. The row records its cost as "no such
round exists". That is a work item, not an objection: TRD-26 and TRD-28 already run lab rounds for GOLD and
OIL VARIANTS of the frozen family, so the machinery exists - what does not exist is a round that INTRODUCES
a new symbol. Commissioning one is the next action on this row.

WHAT THIS DOES NOT DO, stated plainly so it is not over-sold: it does not accelerate the current survivors.
Nothing here shortens survgold's or survoil's path to n>=50 (measured 2026-09-25: 28 and 20, ETAs
~2026-09-30 and ~2026-10-07). Route 3 widens the UNIVERSE of validated pairs - a second, slower clock. The
four-week wait on the current survivors is NOT avoided by any of the three routes, and this ruling does not
pretend otherwise.
`;

const TASKS = [
  {
    id: 1405, label: 'TRD-ANC-1', addition: ANC_ADDITION,
    mustExist: ['stay OBSERVE-ONLY', 'STRUCTURALLY DEAD'],
    // ★ MARKERS UNIQUE TO THE NEW SECTION. 'RULING TAKEN' was briefly used here and is ALREADY present in
    // this row (section 7 is headed "RULING TAKEN: stay OBSERVE-ONLY"), so it would have passed vacuously —
    // a marker that cannot fail is the pattern this codebase keeps naming, and I put one in by reflex.
    mustAdd: ['delegated to me', 'maxAnchorAgeSec STAYS NULL', 'REVISIT TRIGGER',
      'recorded cost of doing business', 'survivor reaches n>=50'],
    appliedMark: '2026-09-25 - RULING TAKEN (delegated to me). risk.maxAnchorAgeSec',
  },
  {
    id: 1361, label: 'TRD-110', addition: TRD110_ADDITION,
    mustExist: ['THE UNIVERSE LEVER', 'OWNER DECISION among the three routes'],
    mustAdd: ['delegated to me', 'ROUTE 3: COMMISSION A LAB ROUND', 'buys trades with an unproven edge',
      'NOT avoided by any of the three routes'],
    appliedMark: '2026-09-25 - RULING TAKEN (delegated to me). ROUTE 3',
  },
];

async function main() {
  const all = await taskModel.getTasksByEdict(52);
  const loaded = [];
  for (const t of TASKS) {
    const row = all.find((x) => Number(x.id) === t.id);
    if (!row) { console.error(`REFUSING: no task ${t.id} in edict 52`); process.exit(1); }
    const current = String(row.info || '');
    if (has(current, t.appliedMark)) {
      console.error(`ALREADY APPLIED — ${t.label} (${t.id}) already carries this ruling. Refusing a SECOND copy.`);
      process.exit(1);
    }
    const missing = t.mustExist.filter((m) => !has(current, m));
    if (missing.length) {
      console.error(`REFUSING: ${t.label} (${t.id}) is missing ${missing.join(' | ')}. Nothing written.`);
      process.exit(1);
    }
    const next = current.replace(/\s*$/, '') + '\n' + t.addition;
    const previewMissing = t.mustAdd.filter((m) => !has(next, m));
    console.log(`${t.label} (id ${t.id})  state ${row.state}  info ${current.length} -> ${next.length} chars (+${next.length - current.length})`);
    console.log(`  history markers: ${t.mustExist.length - missing.length}/${t.mustExist.length}   `
      + `new markers: ${t.mustAdd.length - previewMissing.length}/${t.mustAdd.length}`
      + (previewMissing.length ? '  MISSING: ' + previewMissing.join(' | ') : ''));
    if (previewMissing.length) { console.error('\nREFUSING: section is missing its own markers. Nothing written.'); process.exit(1); }
    loaded.push({ ...t, next });
  }

  if (!APPLY) { console.log('\nDRY RUN - pass --yes to write. No DB write performed.'); return; }

  for (const t of loaded) {
    await taskModel.updateTask(t.id, { info: t.next });
    const back = (await taskModel.getTasksByEdict(52)).find((x) => Number(x.id) === t.id);
    const text = String((back && back.info) || '');
    const missOld = t.mustExist.filter((m) => !has(text, m));
    const missNew = t.mustAdd.filter((m) => !has(text, m));
    console.log(`\n  ${t.label} read-back: ${text.length} chars, state ${back.state}`);
    console.log(`    history: ${missOld.length ? 'MISSING ' + missOld.join(' | ') : 'preserved'}   `
      + `new section: ${missNew.length ? 'MISSING ' + missNew.join(' | ') : 'all markers present'}`);
    if (missOld.length || missNew.length) process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
