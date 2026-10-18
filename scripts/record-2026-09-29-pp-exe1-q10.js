// scripts/record-2026-09-29-pp-exe1-q10.js
//
// Records, in one pass, the four autonomous decisions the owner asked me to make:
//   · the EXPOSURE OVERSHOOT is FILED as a new task (not fixed) — with its measured instance;
//   · the book-over-cap FREEZE is ACCEPTED (raising the cap would loosen a risk limit);
//   · TRD-EXE-1 (#1454) item 4's DIAGNOSTIC half landed; items 1 and 2 deferred, with reasons;
//   · Q4 is UNCHANGED.
//   · and Q10 is ANSWERED as a MEASUREMENT (it partly falsifies the §1.1c prediction).
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');

const ROOT = path.join(__dirname, '..');
const YES = process.argv.includes('--yes');
const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';
const SEC = '\u00A7';

const OVERSHOOT_MARKER = '##2026-09-29 exposure budget spent twice in one wake##';
const OVERSHOOT = `${OVERSHOOT_MARKER} THE EXPOSURE BUDGET CAN BE SPENT MORE THAN ONCE IN A SINGLE WAKE.##

${STAR} FOUND 2026-09-29 by measuring the consequence of a cap the owner had just set. ${WARN} THE SETTING'S NAME
DESCRIBES A LIMIT THE CODE DOES NOT ENFORCE ACROSS A WAKE.

${STAR} MEASURED INSTANCE. 'risk.exposureCapPct' = **50%**. Wake **#5661** (2026-09-29T09:14:10Z) decided TWO
entries in one pass ${EM} **Silver and Sugar** ${EM} and BOTH were sized by 'maxEquityPerPositionPct' at **35%**.
**Neither carries a "sized down to exposure budget" reason**, because each read 'v.exposurePct' (risk.js:426, the
sum of the OPEN book) BEFORE the wake had placed anything: the book held only Gold at 12.71%, so
'remaining = 50 - 12.71 = 37.29%' and 35% fitted for each.

    #1123 Gold    sell  12.71%
    #1126 Silver  sell  34.15%   (decisionId 5661)
    #1127 Sugar   buy   34.15%   (decisionId 5661)
    TOTAL **81.01%** vs cap **50%**  =>  OVERSHOOT **31.01 points**

${WARN} SO 'exposureCapPct' IS NOT A BOOK LIMIT. It is a PER-DECISION limit evaluated against a snapshot, and N
entries accepted together can each take up to the full remaining room. The error is bounded by
**(N - 1) x maxEquityPerPositionPct** ${EM} not small, and it is exactly how a limit set to 50% produced an 81% book.

${WARN} WHY IT WAS NOT FIXED IN THE SAME PASS, stated as a reason rather than an excuse: the fix changes the SIZING
path, and the sizes it would shrink are the desk's risk decisions. ${STAR} **The hard safety limit is NOT breached:**
the L3 margin guard caps total MARGIN at 80% of equity, and the book above uses **12.71/5 + 34.15/5 + 34.15/5 =
16.2%** of it. So this is a BUDGET-ACCURACY defect, not a margin-safety one ${EM} which is what makes filing it
honest rather than negligent.

SUGGESTED FIX (not implemented): carry a per-wake committed total into the exposure check, so 'exposurePct' becomes
'open + committed_this_wake'. That is a change to a pure sizing input and is testable without the venue ${EM} a test
can assert that two accepts in one pass cannot exceed the cap.

${ARROW} THE GENERALISABLE LESSON: **a control that reads shared state once per decision cannot bound a batch.** The
same shape as TRD-EXE-1 (the desk's own actions inside a wake do not update its view of its own state).`;

const FREEZE = `
${STAR} AND THE LIVE CONSEQUENCE WAS ACCEPTED RATHER THAN PAPERED OVER. The book is **81.01%** against a **50%** cap,
so 'remaining = -31.01 <= 0' and 'fitExposureBudget' returns 'full' ${EM} 'veto(exposure_budget)' on every new entry
until the book drains below 50%. **The desk is therefore FROZEN for new entries.** That is the cap working as
designed on a book that is 31 points over it, so nothing was changed. **Raising the cap to clear the freeze would be
a unilateral loosening of a risk limit, which is not mine to make.**`;

const EXE1 = `##2026-09-29 exe1-item4-diagnostic## ITEM 4'S DIAGNOSTIC HALF IS LANDED; THE CLASSIFICATION HALF NEEDS THE VENUE.##

${STAR} WHAT LANDED ('trading/plus500/webtrader.js', in the submit check): the failure path now reads
'.positions-orders [data-testid]' ${EM} EVERY row, not only 'PositionRow.' ${EM} and reports what the container
actually held. The thrown error becomes "position row did not appear after submit (order may have failed) ${EM}
.positions-orders held 2 row(s): PositionRow.x, OrderRow.y" instead of the bare ambiguous string. 'was EMPTY' and
'could not be read' are distinguished, because "nothing appeared" and "a row appeared that is not a position" are
different findings and the record has never carried the difference.

${WARN}${WARN} **AND THE CLASSIFICATION ITSELF IS DELIBERATELY NOT DONE, BECAUSE IT CANNOT BE DONE HONESTLY FROM
HERE.** Telling a position row from a QUEUED ORDER needs the venue's ORDER-row testid prefix, and that is only
observable while a market is closed and an order is genuinely queued. **Guessing the prefix could label a POSITION a
queued order, which is strictly worse than the ambiguity it would remove** ${EM} the desk would believe a fill had
not happened when it had. The diagnostic makes the next occurrence self-documenting, and then the classification is
a small change written against a real testid. Pins: 'test/exe1-submit-evidence.test.js' (4), including one that
holds the scan to 'PositionRow.' so item 4 cannot be silently half-applied.

${WARN} STILL OPEN ON THIS ROW: item 1 (make the venue authoritative on its own session) ${EM} deferred, because the
fix direction is subtle: the guard currently reads the desk's own session reading and that reading was WRONG, so the
repair is to trust the venue, and a bug in reading the venue would flip the guard from over-refusing to
under-refusing. Item 2 (CANCEL or ADOPT an unconfirmed order) ${EM} deferred, because it is a NEW WRITE PATH TO THE
LIVE VENUE, and building or using one is not something to do unattended. **Item 3 remains done.**`;

const Q10 = `##2026-09-29 Q10 ANSWERED## Q10 IS MEASURED ${EM} AND IT PARTLY FALSIFIES THE ${SEC}1.1c PREDICTION.##

${STAR} THE PREDICTION (${SEC}1.1c): "the current 5% is expected to stop the risk cap firing at all and leave the
per-position cap as the SOLE binding control."

${STAR} MEASURED over the 25 sized decisions carrying 'boundBy' (the L4 era; 'maxRiskPerTradePct' moved 0.07 -> 5
today at ~03Z, so the window is short and this is a first reading, not a settled one):

    maxEquityPerPositionPct   15    60%
    exposureCapPct             8    32%
    margin_utilisation         1     4%
    null (no size control)     1     4%
    maxRiskPerTradePct         0     0%

${CHECK} **THE RISK CAP STOPPED FIRING: 0 times.** The prediction was right about that.
${WARN} **BUT THE PER-POSITION CAP IS NOT THE SOLE CONTROL.** 'exposureCapPct' bound on EIGHT of 25 decisions (32%)
${EM} so the portfolio budget was a substantial co-binder, and ${SEC}1.1c's "sole binding control" is wrong.
${STAR} **AND THE MARGIN GUARD BOUND ONCE ${EM} L3 IS NO LONGER PURELY INERT.** That is the first time the guard
has been the binding constraint in production, and it is the outcome L3 was built for ("a control that cannot fire
is indistinguishable from one that is absent" was the risk; it can fire).

${WARN} CAVEAT, STATED BECAUSE THE WINDOW IS SMALL: the caps moved FOUR times inside this window (80 -> 500 -> 60 ->
35, and exposure 100 -> 500 -> 100 -> 50), so the tally mixes several regimes. A clean answer needs a window in
which the caps do not move ${EM} which is now the case, so this can be re-measured later against a stable set.`;

const Q4 = `
${STAR} AND Q4 WAS LEFT UNCHANGED, DELIBERATELY: showing purchasing power to the chair is not a neutral edit. It
changes what the model reasons about, and therefore what it decides ${EM} so it is a behavioural change to the
decision-maker, not a reporting one. ${SEC}6 said it was safe "once L3 exists", and L3 does exist, but "safe to do"
is not the same as "mine to do". **Deferred to the owner.**`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  console.log('=== EXE-1 diagnostic + Q10 + the four decisions ===\n');

  console.log('1. the diagnostic is in the source');
  const wt = code('trading/plus500/webtrader.js').replace(/\r\n/g, '\n');
  if (!/\.positions-orders \[data-testid\]/.test(wt)) await fail('the container-wide read is missing');
  if (!/was EMPTY \(nothing appeared/.test(wt)) await fail('the EMPTY/held distinction is missing');
  if (!/\.positions-orders \[data-testid\^="PositionRow\."\]/.test(wt)) await fail('the original anchored scan was removed — item 4 silently half-applied');
  console.log(`  ${CHECK} container-wide read present, EMPTY/held distinguished, anchored scan intact`);

  console.log('\n2. the overshoot instance reproduces');
  const risk = (await store.getSettings(1)).risk || {};
  const equity = Number(risk.initialEquity);
  const open = await q(`SELECT id, symbol, size, openPrice FROM Trades WHERE status = 'open'`);
  const tot = open.reduce((s, t) => s + (Number(t.size) || 0) * (Number(t.openPrice) || 0), 0) / equity * 100;
  console.log(`  book = ${tot.toFixed(2)}% vs cap ${risk.exposureCapPct}%`);
  if (tot <= Number(risk.exposureCapPct)) await fail('the book is NOT over the cap now — the overshoot claim cannot be illustrated live; re-measure');
  const w = (await q(`SELECT decision FROM TradingPrompts WHERE id = 5661`))[0];
  if (!w) await fail('wake #5661 is gone — the measured instance cannot be cited');
  const dd = JSON.parse(w.decision);
  const entries = (dd.decisions || []).filter((e) => e && e.sizeCalc);
  if (entries.length < 2) await fail(`wake #5661 has ${entries.length} sized entries, the claim needs 2`);
  for (const e of entries) {
    if ((e.sizeCalc.reasons || []).some((r) => /exposure budget/.test(String(r)))) {
      await fail(`${e.symbol} DOES carry an exposure-budget reason — the "neither was resized" claim is wrong`);
    }
  }
  console.log(`  ${CHECK} wake #5661 sized ${entries.length} entries, none touched by the budget; book over cap`);

  console.log('\n3. Q10 tally re-derives');
  const rows = await q(`SELECT decision FROM TradingPrompts WHERE decision IS NOT NULL`);
  const tally = {};
  for (const r of rows) {
    let d; try { d = JSON.parse(r.decision); } catch { continue; }
    for (const e of (Array.isArray(d.decisions) ? d.decisions : [])) {
      if (e && e.sizeCalc && 'boundBy' in e.sizeCalc) {
        const k = e.sizeCalc.boundBy === null ? 'null' : e.sizeCalc.boundBy;
        tally[k] = (tally[k] || 0) + 1;
      }
    }
  }
  console.log(`  ${JSON.stringify(tally)}`);
  if ((tally.maxRiskPerTradePct || 0) !== 0) await fail(`maxRiskPerTradePct bound ${tally.maxRiskPerTradePct} times — the §1.1c prediction outcome is not what the block says`);
  if (!(tally.exposureCapPct > 0)) await fail('exposureCapPct never bound — the "not sole" claim is wrong');

  console.log('\n4. the task row for the overshoot');
  const exists = (await q(`SELECT id FROM dbo.Tasks WHERE info LIKE '%${OVERSHOOT_MARKER}%'`))[0];
  const nextSort = (await q(`SELECT ISNULL(MAX(sortOrder),0) + 1 AS n FROM dbo.Tasks WHERE edictId = 52`))[0].n;
  console.log(`  ${exists ? `already filed as #${exists.id}` : `would create a new edict-52 task (sortOrder ${nextSort})`}`);

  if (!YES) {
    console.log(`\n  would also append ${EXE1.length} chars to #1454 and ${(FREEZE + Q10 + Q4).length} chars to #1467`);
    console.log(`  DRY RUN ${EM} nothing written.`);
    await pool.close();
    return;
  }

  // (a) the overshoot task
  // (a) the overshoot task. ⚠ `name` and `plannedStart` are the only NOT NULL columns with NO default
  // (checked against sys.columns) — `id` is identity, `sortOrder` has a default, `active` is computed.
  if (!exists) {
    await pool.request().query(`INSERT INTO dbo.Tasks (name, createdAt, plannedStart, info, priority, state, edictId, sortOrder)
      VALUES (N'TRD-EXE-7: Risk - the exposure budget is spent PER DECISION against a pre-wake snapshot, so one wake opened two 35% positions and took the book to 81% against a 50% cap',
        GETUTCDATE(), GETUTCDATE(), N'${OVERSHOOT.replace(/'/g, "''")}', 1, 1, 52, ${nextSort})`);
    const made = (await q(`SELECT TOP 1 id FROM dbo.Tasks WHERE info LIKE '%${OVERSHOOT_MARKER}%' ORDER BY id DESC`))[0];
    console.log(`  ${CHECK} filed as #${made.id}`);
  } else console.log('  overshoot task already filed.');

  // (b) #1454
  const t1 = (await q(`SELECT LEN(ISNULL(info,'')) AS n, info FROM dbo.Tasks WHERE id = 1454`))[0];
  if ((t1.info || '').split('##2026-09-29 exe1-item4-diagnostic##').length - 1 === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${EXE1.replace(/'/g, "''")}' WHERE id = 1454`);
    console.log(`  ${CHECK} #1454 block appended`);
  } else console.log('  #1454 block already present.');
  const a1 = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = 1454`))[0];
  if ((a1.info || '').split('##2026-09-29 exe1-item4-diagnostic##').length - 1 !== 1) await fail('#1454 marker count is not 1');
  console.log(`  ${CHECK} #1454 is now ${a1.n} chars, marker x1`);

  // (c) #1467
  const t2 = (await q(`SELECT LEN(ISNULL(info,'')) AS n, info FROM dbo.Tasks WHERE id = 1467`))[0];
  if ((t2.info || '').split('##2026-09-29 Q10 ANSWERED##').length - 1 === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${(FREEZE + Q10 + Q4).replace(/'/g, "''")}' WHERE id = 1467`);
    console.log(`  ${CHECK} #1467 block appended`);
  } else console.log('  #1467 block already present.');
  const a2 = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = 1467`))[0];
  if ((a2.info || '').split('##2026-09-29 Q10 ANSWERED##').length - 1 !== 1) await fail('#1467 marker count is not 1');
  console.log(`  ${CHECK} #1467 is now ${a2.n} chars, marker x1`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
