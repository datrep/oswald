// scripts/record-2026-09-27-step0-era-correction.js — CORRECT Step 0's headline, which was contaminated.
//
// The owner asked "does N include ones this week or before this week?" — the right question, and the answer
// overturns §8.2. This appends the correction to TRD-GAT-1 (#1417) and records the epoch decision.
//
//   node scripts/record-2026-09-27-step0-era-correction.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 step0-era-correction##';

const ADD = `
${MARK}
★★★ THE OWNER ASKED THE QUESTION THAT BREAKS THIS MEASUREMENT'S HEADLINE, AND THE HEADLINE IS WRONG.

They asked: **"does N include ones this week or before this week?"** Split by ISO week, the same method:

    group                before 2026-09-21            from 2026-09-21
    approved entry       n=54   mean -0.969%          n=11   mean **+0.307%**
    score-declined       n=32   mean -1.469%          n=41   mean  -1.741%
    chair veto           n=0    --                    n=9    mean  -2.734%
    risk veto            n=35   mean -1.118%          n=0    --
    chair offline        n=5    mean +0.722%          n=0    --
    exit                 n=25   mean +0.199%          n=0    --

★ **§8.2 SAID "THE APPROVED ENTRIES WERE NEGATIVE TOO", AND THAT IS AN ARTEFACT OF OLD DATA.** 54 of the 65
approved entries — 83% — predate this week. In the current week the approved entries are **+0.307%**, i.e. the
opposite sign. The conclusion drawn from it ("the weak link is upstream of the gate") was therefore **unsupported
for the current policy set**, which is exactly the ruling the owner has now had to make three times in one session:
*"dont trust previous data. they are before the new policies are implemented."* This is the third time, and it was
the machine that got it wrong, not the owner.

★ **WHAT SURVIVES, and it is the part that matters for the gate.** The committee's dissent is negative in BOTH eras
(declined -1.469% before vs -1.741% now) and the chair veto — which exists ONLY in the current week, because
TRD-VET-1 is recent — is the worst group at -2.734%. **"The committee is not noise" holds on the current data
alone**, which is a stronger statement than the original, because the original leaned on 83% pre-policy rows.

⚠ AND TWO ENTIRE GROUPS ARE HISTORICAL. **All 35 risk vetoes and all 25 exits are pre-2026-09-21.** Any statement
about either — including §7's layer table and the "same tickets the committee then objects to" note on TRD-RSK-1 —
describes a regime that no longer exists. Not deleted: flagged, because a group with n=0 this week cannot support a
claim about this week.

★★ **THE PROCESS FIX, recorded as a decision rather than as a resolution to be careful.** The failure was not that
old data existed; it was that a measurement SILENTLY included it and reported a single mean. So:
  · **the policy epoch is a RECORDED VALUE** — \`2026-09-21\`, the Monday of the week the current policy set began —
    not a date a reader is expected to reconstruct from a task number;
  · **a measurement must state its window**, and a window that spans the epoch must say so in its own output;
  · and this row's §8 is amended in place, with the original left standing, because the wrong version is what a
    reader may already have acted on.

★ **RE-SCOPED RECOMMENDATION.** §8.3 argued for making the next work about entry quality in layers 1-2. That
argument rested on the pre-policy mean and is now WITHDRAWN. What the current week actually shows is the opposite:
approved entries have a POSITIVE forward edge (+0.307%, n=11) while the committee refuses the negative ones. n=11
is far too small to conclude from, so the honest recommendation is **to re-run this measurement on the current
epoch alone once there is enough of it — and to treat the gate's design question as OPEN rather than answered in
either direction.**
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query('SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1417');
  if (!cur.recordset.length) { console.error('#1417 not found — aborting'); process.exit(1); }
  const c = cur.recordset[0];
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  console.log(`#1417 state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = 1417`);
  const back = await pool.request().query('SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1417');
  console.log(`✔ #1417 appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
