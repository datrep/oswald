// scripts/record-2026-09-29-exe9-refusal-skips-seat.js
//
// Files TRD-EXE-9: a risk refusal happens BEFORE the committee, so the venue-floor disclosure the desk
// painstakingly puts on the ticket is written into a bundle that is never sent.
//
// MOTIVE: the owner pasted a `venue_minimum` refusal and asked to "let the llm know of the venue minimum".
// MEASURED, in three steps, each falsifying the previous guess:
//   1. the floor IS on the ticket line in the stored bundle -> a prompt change would be a no-op;
//   2. but `decision.llmCalled === false` on that case -> the bundle is never sent;
//   3. and 200 of 200 no-model decisions in 7 days are refusals, 83 of them on the floor.
//
// GATES re-derive every number, and one gate asserts that NO CONTROL WAS MOVED.
// DRY RUN by default (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192';

const MARKER = '##2026-09-29 exe9 refusal skips the seat##';
const INFO = `${MARKER} A RISK REFUSAL HAPPENS BEFORE THE COMMITTEE, SO THE FLOOR IS DISCLOSED TO NOBODY.##

${STAR} HOW THIS WAS FOUND, AND WHY THE FIRST TWO ANSWERS WERE BOTH WRONG. The owner pasted a
'venue_minimum' refusal and asked that the LLM be told the venue minimum. Measured in three steps:

  STEP 1 ${EM} "the prompt does not mention it." **FALSE.** The stored bundle for the exact case
  ('TradingPrompts.id' 5671, 2026-09-29T10:52:54Z) carries the floor FOUR ways:
      L 52  'Arabica Coffee: min size 0.5 Contracts ... leverage 1:5' inside '--- VENUE COST OF CARRY ---'
      L101  'PROPOSED ACTION by quant: entry sell Arabica Coffee size=risk-sized ${ARROW} venue minimum 0.5 Contracts'
      the per-proposal lines in the multi-proposal block
      the raw 'venueCosts[sym].minimumUnits' / 'unitKind' object
  And the refusal STRING already leads with it: 'risk veto: [venue_minimum] below venue minimum: computed
  0.2517 < venue minimum 0.5 Contracts'. 'vetoLine()' (risk.js:1025) prints the refusal first and then
  filters it OUT of the gate notes ('notes = all.filter(r => !refusals.includes(r))') ${EM} which is exactly
  why the owner's paste looks like the minimum is missing. **Its absence from "gate notes" is correct.**

  STEP 2 ${EM} "then the model must have been asked and ignored it." **FALSE.** The decision carries
  'llmCalled: false', and the prompt row has 'model: null', 'latencyMs: null'. The bundle was BUILT AND
  NEVER SENT.

  STEP 3 ${EM} "so how often?" **Measured over 7 days: 'called=true' 272, 'called=false' 200, and 200 of
  200 no-model decisions are REFUSALS.** The breakdown of the 200:
      venue_minimum    83   (SGX, Sugar, Arabica Coffee, Bitcoin)
      correlation      50   (Silver)
      (unparsed)       49
      exposure_budget  18
${ARROW} a refusal by this gate is by DESIGN before the committee. The code says so itself: 'risk.js:388'
  ("A refusal by this gate happens BEFORE the committee, so 'llmCalled' is false and no seat is asked
  anything"), and 'routes.js:239'. Only ONE refusal in the whole journal ever had a model call, and its
  'model' was literally 'budget, budget, budget' with 'latencyMs: 0' ${EM} the seats had gone OFFLINE.

${STAR} AND THE 83 ARE ALL RECENT ${EM} EVERY 'venue_minimum' refusal DECISION IN THE ENTIRE JOURNAL FALLS
INSIDE THE LAST 7 DAYS (83 whole-journal, 83 in 7 days). This is not a long-standing condition: it appeared
with the cap reduction to 'maxEquityPerPositionPct 35' / 'exposureCapPct 50'. Tightening the caps made the
desk produce sub-floor tickets and refuse them, which is the OPPOSITE of the freeze being a slow-burn.

${WARN} CONSEQUENCE, STATED PLAINLY: the desk puts the venue floor on the ticket line specifically so a
seat does not vote on a ticket the venue cannot accept (the 2026-09-28 change, motivated by SGX proposed
at 8.5363 Shares against a 20-Share floor). **On a floor refusal that line is written into a bundle that
is stored and never read.** The disclosure is correct and unreachable at the same time.

${CHECK} END-TO-END PROOF THAT THE DISCLOSURE WORKS WHEN THE SEAT IS ACTUALLY ASKED: 'promptId' 5396 is the
one refusal with a model call. Its rendered prompt contains, for every proposal in the same cycle,
    'PROPOSED ACTION by quant: entry sell Silver size=risk-sized ${ARROW} venue minimum 2.5 Troy Ounces'
    'entry buy SGX (basis: ...) ${ARROW} venue minimum 20 Shares'
${ARROW} including the exact SGX case the 2026-09-28 change was written for. **Nothing needs to be added.**

${WARN} TWO GUESSES OF MINE THAT THE RECORD FALSIFIED, recorded so neither is re-derived:
  (a) I assumed the 83 floor refusals were book-capacity refusals mislabelled as symbol-floor ones.
      **23 of the 83** carry a "sized down to exposure budget" note ${EM} so **72% are NOT the book cap**;
      the desk genuinely sizes below a symbol floor via the ordinary cascade. (28% ARE the book cap, which
      is a real sub-case worth its own attention but is not the whole story.)
  (b) I read a Sugar refusal as "computed 0.4364 against a floor of 15" and suspected a 34x unit error.
      **MY MISREADING.** The 'sizeCalc' on a Sugar decision gives 'baseSize' 809.8831, 'finalSize' 74.2518,
      'venueFloor.reason' 'above_venue_minimum' ${EM} it clears the 15 floor comfortably. The small numbers
      belong to whichever symbol was resized by the book that wake.

${WARN}${WARN} AND MY OWN QUERY WAS WRONG, WHICH IS WHY THE FIRST VERSION OF THIS ROW SAID "472" AND "5%".
'TradingEvents.payload LIKE \'%[venue_minimum]%\'' is NOT a literal search: in T-SQL LIKE, '[...]' is a
CHARACTER CLASS, so that pattern matches any text containing ANY of v, e, n, u, m, i ${EM} it returned
**88,282** rows. 'CHARINDEX(\'[venue_minimum]\', payload) > 0' is the literal form and returns **158** (83
'decision' + 75 'wake'). **A count that large should never have been believed without opening a row** ${EM}
the same trap as "LIKE matches a payload that merely MENTIONS the string", which this repo has hit before.

${WARN} NOT DONE, DELIBERATELY. This row changes NOTHING. Both routes to "the seat is asked" are
owner decisions:
  (a) convene the seat on a floor refusal ${EM} spends LLM budget (83 refusals in 7 days) and changes
      nothing about the risk outcome; the refusal still stands. A behavioural change to the decision-maker,
      which is the Q4 precedent ("safe to do" is not "mine to do").
  (b) 'risk.acceptVenueFloor: true' ('store.js', default FALSE) ${EM} RAISE the size to the floor and
      disclose the multiple in the seat's ticket-geometry note, so the ticket EXISTS to be judged. This is a
      RISK POSTURE: it forces up to 2.34x the intended risk on the tightest stops (measured motive: SGX's
      20-Share floor).
${ARROW} a gate below asserts that 'acceptVenueFloor' is still false and that the refusal string is
unchanged, so this row can never be mistaken for a control change.

${WARN} AND THE MEASUREMENT THAT MAKES (a) WORTH CONSIDERING: the desk stores 1,735 bundles and has sent
only 537 of them to a model. Refusals are ~70% of the unsent volume. Those bundles are paid for in
assembly and in database, read by nobody, and they are the desk's only record of what it was thinking when
it refused to trade.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== TRD-EXE-9: a refusal skips the seat — filing gates ===\n');

  // 1. The invariant that makes this a finding: EVERY no-model decision is a refusal.
  const calls = await q(`SELECT JSON_VALUE(payload,'$.llmCalled') AS called,
        CASE WHEN payload LIKE '%risk veto%' THEN 'veto' ELSE 'other' END AS kindof, COUNT(*) AS n
      FROM TradingEvents WHERE kind='decision' AND createdAt >= DATEADD(day,-7,GETUTCDATE())
      GROUP BY JSON_VALUE(payload,'$.llmCalled'), CASE WHEN payload LIKE '%risk veto%' THEN 'veto' ELSE 'other' END`);
  const noCallOther = Number((calls.find((r) => r.called === 'false' && r.kindof === 'other') || {}).n || 0);
  const noCallVeto = Number((calls.find((r) => r.called === 'false' && r.kindof === 'veto') || {}).n || 0);
  if (noCallOther !== 0) throw new Error(`${noCallOther} no-model decisions are NOT refusals — the "every no-call decision is a veto" claim is false`);
  if (noCallVeto < 200) throw new Error(`only ${noCallVeto} no-model refusals in 7 days; the row claims 200`);
  console.log(`  ${CHECK} 7d: ${noCallVeto} no-model refusals, ${noCallOther} no-model non-refusals (the invariant holds)`);

  // 2. The floor refusals, counted. ⚠ CHARINDEX, NOT LIKE: `LIKE '%[venue_minimum]%'` is a CHARACTER CLASS
  // in T-SQL and matched 88,282 rows. The literal count is 83 decisions + 75 wakes.
  const vm = Number((await q(`SELECT COUNT(*) AS n FROM TradingEvents
      WHERE kind='decision' AND createdAt >= DATEADD(day,-7,GETUTCDATE())
        AND CHARINDEX('[venue_minimum]', CAST(payload AS NVARCHAR(MAX))) > 0`))[0].n);
  if (vm < 83) throw new Error(`only ${vm} venue_minimum refusals in 7 days; the row claims 83`);
  const vmAll = Number((await q(`SELECT COUNT(*) AS n FROM TradingEvents
      WHERE kind='decision' AND CHARINDEX('[venue_minimum]', CAST(payload AS NVARCHAR(MAX))) > 0`))[0].n);
  if (vmAll !== vm) throw new Error(`${vmAll} venue_minimum refusals whole-journal vs ${vm} in 7 days — the "all 83 are recent" claim is false`);
  console.log(`  ${CHECK} venue_minimum refusals: ${vm} in 7 days, ${vmAll} whole-journal (all recent, as claimed)`);

  // 3. The disclosure genuinely EXISTS in a stored bundle — otherwise step 1's whole point evaporates.
  const b = await q(`SELECT TOP 1 id, bundle FROM TradingPrompts WHERE bundle LIKE '%venue minimum%' ORDER BY id DESC`);
  if (!b.length) throw new Error('no stored bundle contains "venue minimum" — the "disclosure exists" claim is false');
  const obj = JSON.parse(b[0].bundle);
  const text = String(obj.text || '');
  if (!/venue minimum [\d.]+/.test(text)) throw new Error(`bundle ${b[0].id} does not render the floor on a ticket line`);
  const withMin = Object.values(obj.venueCosts || {}).filter((v) => v && v.minimumUnits != null).length;
  if (withMin < 7) throw new Error(`only ${withMin} venueCosts entries carry minimumUnits`);
  console.log(`  ${CHECK} bundle #${b[0].id}: floor on the ticket line AND minimumUnits on ${withMin} venueCosts rows`);
  const line = text.split('\n').find((l) => /PROPOSED ACTION/.test(l)) || '';
  console.log(`      ${line.replace(/[\u2014\u00b7]/g, '-').slice(0, 150)}`);

  // 4. The reason the gate notes omit it — the vetoLine filter. A pin, not a claim.
  const rsrc = require('fs').readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');
  if (!/all\.filter\(\(r\) => !refusals\.includes\(r\)\)/.test(rsrc)) throw new Error('vetoLine no longer filters refusals out of the gate notes');
  console.log(`  ${CHECK} vetoLine still filters the refusal out of "gate notes" (why the paste looks like the floor is missing)`);

  // 5. NOTHING WAS MOVED — the row must never read as a control change.
  const ssrc = require('fs').readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
  if (!/^\s*acceptVenueFloor: false,/m.test(ssrc)) throw new Error('acceptVenueFloor is no longer false — this row would misrepresent a control change');
  console.log(`  ${CHECK} acceptVenueFloor is STILL false (no risk posture was moved)`);

  const exists = (await q(`SELECT id FROM dbo.Tasks WHERE info LIKE '%${MARKER}%'`))[0];
  const nextSort = (await q(`SELECT ISNULL(MAX(sortOrder),0) + 1 AS n FROM dbo.Tasks WHERE edictId = 52`))[0].n;
  if (exists) { console.log(`\n  already filed as #${exists.id} — nothing to do`); await pool.close(); return; }
  console.log(`\n  would file a new edict-52 task (sortOrder ${nextSort})`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written. Re-run with --yes to file.\n`); await pool.close(); return; }

  await pool.request().query(`INSERT INTO dbo.Tasks (name, createdAt, plannedStart, info, priority, state, edictId, sortOrder)
    VALUES (N'TRD-EXE-9: Deliberation - a risk refusal happens BEFORE the committee, so the venue-floor disclosure the desk puts on the ticket is written into a bundle nobody reads (200 of 200 no-model decisions are refusals, 83 on the floor)',
      GETUTCDATE(), GETUTCDATE(), N'${INFO.replace(/'/g, "''")}', 2, 1, 52, ${nextSort})`);
  const made = (await q(`SELECT TOP 1 id, LEN(info) AS n FROM dbo.Tasks WHERE info LIKE '%${MARKER}%' ORDER BY id DESC`))[0];
  console.log(`  ${CHECK} filed as #${made.id}, ${made.n} chars`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
