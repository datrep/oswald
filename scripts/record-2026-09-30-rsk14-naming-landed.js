// scripts/record-2026-09-30-rsk14-naming-landed.js
//
// TRD-RSK-14 (#1477), second addendum: the NAMING half landed; the ARITHMETIC half is one owner-supplied number
// and is left open WITH A TRIGGER rather than changed. Appends to #1477. DRY RUN by default (pass --yes).
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192';

const MARKER = '##2026-09-30 rsk14 naming landed arithmetic left open with a trigger##';
const INFO = `${MARKER} THE MODEL CAN NO LONGER BE READ AS THE VENUE. THE ARITHMETIC CHANGE NEEDS ONE NUMBER AND IS **NOT** TAKEN.##

${CHECK} LANDED, additive and behaviour-neutral ${EM} the row's OWN request, which was a labelling fix:
  * 'v.marginGuard.modelledInitialMargin' ${EM} the same number as 'usedMargin', named for what it IS. 'usedMargin' is
    kept because pins and readers hold it; the twin exists so no reader has to know that.
  * 'v.marginGuard.initialMarginHeld' ${EM} **present-and-NULL, deliberately not read.** The desk DOES store the venue's
    real figure ('equity - available' on every 'account' event), and NULL means "the guard does not have this", never
    "it is zero". 'Number(null) === 0' here would turn the guard's worst input into its most permissive reading.
  * a 'reasons' line IN THE FITTED BRANCH ${EM} the branch where this control is what made the size, which is the only
    moment its ceiling is wrong ABOUT anything. Unreachable today, and that is correct: it warns about a state that
    has not occurred.
Pins: **test/margin-guard-units.test.js (4)**. Suite **1813 / 1812 pass / 0 fail / 1 skipped**; eslint exit 0.

${WARN} WHY THE ARITHMETIC IS STILL NOT CHANGED, STATED AS THE ROW'S ROW-DECIDES-THE-TRIGGER PATTERN (TRD-RSK-13's
precedent, applied rather than re-argued). The defect is real and its size is measured; the guard is **NOT BINDING**,
and the fix is a number or a design:
  (a) 'maxMarginUtilisationPct' 80 ${ARROW} **62.5** makes the dial mean "80% of the venue's margin". One number, no code,
      and strictly TIGHTENING ${EM} but correct only while USD/SGD sits near 1.2812 AND the whole book is USD-quoted
      (the registry states a factor of 1.00 for the SGD-quoted names, none of which has ever traded).
  (b) READ the open book's margin from the venue's own snapshot instead of modelling it, leaving the FX question only
      for the new ticket ${EM} and the same snapshots let the desk CALIBRATE its own factor with no external feed.
      Correct, and a real change to the one control the purchasing-power design rests on.
${ARROW} a live risk setting and a live control's arithmetic are both owner calls, so neither is taken here.
**FIX WHEN ANY OF THESE BECOMES TRUE, and treat it as mandatory rather than optional** (this is the trigger, not a
sentiment):
  1. 'maxEquityPerPositionPct' or 'exposureCapPct' is raised again ${EM} this defect went live once already, when L2 raised
     them to 500 and the margin guard became the only binding control;
  2. any proof or report cites 'maxMarginUtilisationPct' as an exact ceiling ${EM} the same condition TRD-RSK-13 carries;
  3. 'margin_utilisation' actually fires on a ticket (it has fired once, and that was before this measurement).
${WARN} AND THE ONE THING THAT MUST NOT BE SAID: the row is NOT closed. Its defect is unfixed, and TRD-87 exists
precisely because closing a task is not evidence its defect is gone. What is finished is the MEASUREMENT.

${STAR} WHAT THIS ROW CHANGED ABOUT THE DESIGN, in one line: L3 was described as "the one control that measures the
VENUE'S CAPACITY rather than the desk's notional". It measures the venue's RATE correctly and the venue's NOTIONAL in
the wrong currency, so at the live 80% its ceiling is **102.50%** of equity in the margin the venue really withholds.
That is a tighter statement than the 96% this row was filed with, and it is the sentence a reader needs.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  console.log('=== TRD-RSK-14: the naming half ===\n');

  const row = (await q(`SELECT id, state, LEN(CAST(info AS NVARCHAR(MAX))) AS n, CAST(info AS NVARCHAR(MAX)) AS info
      FROM dbo.Tasks WHERE name LIKE '%RSK-14%'`))[0];
  if (!row) throw new Error('TRD-RSK-14 not found');
  if (Number(row.state) === 3) throw new Error('TRD-RSK-14 is archived — this addendum would be unreachable');
  const already = String(row.info).includes(MARKER);
  console.log(`  ${CHECK} TRD-RSK-14 is #${row.id}, state ${row.state}, ${row.n} chars${already ? ' — MARKER ALREADY PRESENT' : ''}`);

  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');
  if (!/modelledInitialMargin: mg\.usedMargin/.test(src)) throw new Error('modelledInitialMargin does not mirror usedMargin');
  if (!/modelledInitialMargin: null,\s*\n\s*initialMarginHeld: null,/.test(src)) throw new Error('the shape does not declare both fields');
  const held = [...src.matchAll(/initialMarginHeld\s*:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  if (held.length !== 1 || held[0] !== 'null') throw new Error(`initialMarginHeld should be declared exactly once, as null; found ${JSON.stringify(held)}`);
  // ⚠ THE REGEX MUST STOP BEFORE THE APOSTROPHE: the source carries `venue\'s`, so a gate written with an
  // unescaped `venue's` cannot match it — a one-character gate failure that reads like a missing change.
  if (!/applied to the MODELLED initial margin, not to the venue/.test(src)) throw new Error('the fitted-branch caveat is not real code');
  if (!/the measured factor is 1\.2812/.test(src)) throw new Error('the caveat does not carry the factor');
  const fittedAt = src.indexOf("boundBy = 'margin_utilisation'");
  if (!(fittedAt > 0 && src.indexOf('applied to the MODELLED initial margin') > fittedAt)) throw new Error('the caveat is outside the branch it is about');
  if (!fs.existsSync(path.join(__dirname, '..', 'test', 'margin-guard-units.test.js'))) throw new Error('test/margin-guard-units.test.js is missing');
  console.log(`  ${CHECK} modelledInitialMargin mirrors usedMargin · initialMarginHeld is declared once, as null · the caveat is inside the fitted branch · 4 pins on file`);

  // the guard must STILL be latent, or the "not the time to change it" argument collapses
  const s = JSON.parse((await q(`SELECT CAST(settings AS NVARCHAR(MAX)) AS j FROM TradingSettings WHERE userId=1`))[0].j);
  const cap = Number(s.risk.maxMarginUtilisationPct);
  const reach = Math.min(Number(s.risk.maxEquityPerPositionPct), Number(s.risk.exposureCapPct)) * 0.60 * 1.2812;
  if (!(cap > 0)) throw new Error('maxMarginUtilisationPct is unarmed — this row is about a different thing');
  if (reach >= cap) throw new Error(`the caps now reach the guard (${reach.toFixed(2)}% vs ${cap}%) — this is LIVE, the trigger has fired, and the deferral in this addendum is wrong`);
  console.log(`  ${CHECK} still latent: the caps reach ${reach.toFixed(2)}% against a ${cap}% ceiling — the deferral stands`);

  if (INFO.includes('\u0060')) throw new Error('the addendum contains a backtick');
  console.log(`  ${CHECK} no backticks (${INFO.length} chars)`);
  console.log(`  would append to TRD-RSK-14 (#${row.id})`);
  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written.\n`); await pool.close(); return; }
  if (!already) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${INFO.replace(/'/g, "''")}' WHERE id = ${row.id}`);
  }
  const back = (await q(`SELECT state, LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id=${row.id}`))[0];
  console.log(`  ${CHECK} appended; #${row.id} is now ${back.n} chars, state ${back.state} (STILL OPEN — its defect is unfixed)`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
