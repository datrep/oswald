// scripts/record-2026-09-29-pp-L5.js
//
// Records L5 (day boundary, PARTIAL) on TRD-RSK-10 (#1467).
//
// The block records ONE thing and states ONE non-action:
//   · the halt's day boundary was UTC midnight BY CONSTRUCTION, and UTC midnight falls inside a live session, so
//     the halt could RESET MID-SESSION with the market open;
//   · the anchor is now a stated setting whose DEFAULT is the legacy behaviour — because which anchor is right is
//     a risk decision, and the two differ only for three hours a day, in opposite directions.
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const time = require('../trading/agent/time');
const store = require('../trading/store');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 L5 HALT DAY BOUNDARY##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';
const SEC = '\u00A7';

const ADDENDUM = `
${MARKER} THE HALT COULD RESET MID-SESSION. NOW IT IS A DECISION.##

${STAR} THE DEFECT. 'dayStartEquity' keyed the daily-loss halt on
'new Date().toISOString().slice(0, 10)' ${EM} the **UTC calendar date** ${EM} and **UTC midnight falls
INSIDE a live session.** So one session spanned two halt-days and **the halt RESET MID-SESSION**: the desk could
take its day's loss at 23:00 UTC, be handed a fresh baseline an hour later, and keep trading the same session with
the control lifted. The desk's trading day is the VENUE's, which opens and closes at **21:00 UTC** (Fri 21:00 close
to Sun 21:00 open) ${EM} the same clock 'DEFAULT_FUNDING_MINUTE_UTC' names, and the instant the venue's
own carry is billed at.

${STAR} WHAT LANDED. A pure **'time.dayKeyAt(instant, minuteOfDayUtc)'** ${EM} with **0 reproducing the
legacy behaviour EXACTLY**, which is why 0 is the signature default: the anchor is made EXPLICIT, not changed. A
pure **'risk.haltAnchorMinute(settings)'. The anchor now rides on every 'day_start' row
('anchorMinuteUtc'), because a baseline without its anchor cannot be re-derived and a study comparing two
eras could not tell which boundary produced which halt-day. Pins: **'test/halt-day-boundary.test.js' (7)**.

${STAR} THE SETTING: 'risk.dailyHaltAnchor' = 'utc_midnight' (default) | 'venue_session'.

${WARN}${WARN} **AND THE DEFAULT DID NOT MOVE, DELIBERATELY.** Measured, the two anchors differ **only between
21:00 UTC and midnight**: there the UTC anchor is still carrying the previous day's baseline while a session anchor
has just reset. So switching makes the halt **STRICTER for 21 hours of the day and LOOSER for the three that follow
the venue's close.** That is a risk posture, not housekeeping ${EM} the same reason 'dailyLossHaltPct = k x P'
is not being moved unilaterally either. Rev 5 answered Q6 as **6.0**, and that value belongs to the package that
raises the caps, so it is applied WITH L2 rather than before it.

${STAR}${STAR} THE TRAP THIS WORK RE-HIT, and it is the sixth time this codebase has paid for it. The first
'dayKeyAt' rejected an unusable instant with 'Number.isFinite(getTime())' ${EM} which **cannot see
'null', because 'new Date(null)' is 1970-01-01, a FINITE timestamp.** So an absent instant would
have been filed as a halt-day **at the epoch** instead of as unknown. The guard now rejects nullish BEFORE
constructing the Date, and the pin asserts the precondition ('new Date(null).getTime() === 0') so the
REASON survives rather than the fix being a bare condition. This is 'Number(null) === 0' in its second coat.

${STAR} STATUS: suite **1,746 tests / 1,745 pass / 0 fail / 1 skipped**; eslint exit 0 on every touched file; the
report carries ${SEC}13.7 and its L5 row now reads PARTIAL, with ${SEC}13.6 and ${SEC}13.7 in numeric order at the
end of ${SEC}13. **The L5 change is repo-side only until the next restart, and that is safe by construction: its
default reproduces the existing behaviour exactly, so a restart cannot move a single halt decision.**

${ARROW} REMAINING ON L5: **halt = k x P**, which is the owner's number (rev 5 Q6 = 6.0) and ships WITH L2.
${ARROW} AND STILL PENDING FROM L3/L4: the acceptance read ${EM} see the block above (the first decision after the
2026-09-29T04:18:18Z restart carrying a 'sizeCalc').`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  console.log('=== L5 HALT DAY BOUNDARY — recording gates ===\n');

  console.log('1. the primitive');
  if (typeof time.dayKeyAt !== 'function') await fail('time.dayKeyAt is missing');
  if (time.dayKeyAt(new Date('2026-09-29T04:18:18Z'), 0) !== '2026-09-29') await fail('minute 0 must reproduce the UTC date');
  if (time.dayKeyAt(new Date('2026-09-29T04:18:18Z'), time.DEFAULT_FUNDING_MINUTE_UTC) !== '2026-09-28') {
    await fail('the session anchor must name the day by the session it opened');
  }
  if (time.dayKeyAt(null, 1260) !== null) await fail('a null instant must be UNKNOWN — new Date(null) is the epoch');
  console.log(`  ${CHECK} dayKeyAt: minute 0 = legacy, 1260 = venue session, null = unknown`);

  console.log('\n2. the anchor resolver and the halt');
  const riskSrc = code('trading/agent/risk.js');
  if (!riskSrc.includes("r.dailyHaltAnchor === 'venue_session' ? DEFAULT_FUNDING_MINUTE_UTC : 0")) {
    await fail('haltAnchorMinute must default to 0');
  }
  const fnStart = riskSrc.indexOf('async function dayStartEquity');
  const fnBody = riskSrc.slice(fnStart, riskSrc.indexOf('\n}', fnStart));
  if (/toISOString\(\)\.slice\(0, 10\)/.test(fnBody)) await fail('the inline UTC-midnight date is back');
  if (!fnBody.includes('anchorMinuteUtc')) await fail('the anchor must travel on the day_start row');
  console.log(`  ${CHECK} default is legacy; the boundary has one home; the anchor is recorded`);

  console.log('\n3. the setting');
  if (store.DEFAULT_SETTINGS.risk.dailyHaltAnchor !== 'utc_midnight') {
    await fail(`dailyHaltAnchor default is ${JSON.stringify(store.DEFAULT_SETTINGS.risk.dailyHaltAnchor)} — an absent key must not move a risk boundary`);
  }
  console.log(`  ${CHECK} DEFAULT_SETTINGS.risk.dailyHaltAnchor = utc_midnight`);

  console.log('\n4. the report');
  const doc = read(DOC);
  const i6 = doc.indexOf('### 13.6 '), i7 = doc.indexOf('### 13.7 ');
  if (i6 < 0 || i7 < 0) await fail('the report is missing a section-13 subsection');
  if (i7 < i6) await fail('sections 13.6/13.7 are out of numeric order');
  console.log(`  ${CHECK} the report carries 13.6 then 13.7`);

  console.log('\n5. the row and its marker');
  const row = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!row) await fail(`row ${TASK_ID} does not exist`);
  const n = (row.info || '').split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${(row.info || '').length} chars, this marker ${n}x`);

  if (!YES) {
    console.log(n === 0
      ? `\n  would append ${ADDENDUM.length} chars. DRY RUN ${EM} not written.`
      : `\n  block already present. DRY RUN ${EM} not written.`);
    await pool.close();
    return;
  }
  if (n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log(`  ${CHECK} block appended`);
  } else console.log('  block already present.');

  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`the block appears ${fn}x — expected exactly 1 (idempotency)`);
  if (!(after.info || '').includes('THE HALT COULD RESET MID-SESSION')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${after.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
