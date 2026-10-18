// scripts/record-2026-09-29-L3-lost-and-restored.js
//
// Records, on TRD-RSK-10 (#1467), that L3's implementation was MISSING FROM DISK and has been restored.
//
// ⚠ WHY THIS IS WORTH A ROW OF ITS OWN RATHER THAN A LINE. The document and this task row both asserted
// "L3 — LANDED, and INERT". On disk, half the layer was absent: the guard's two accessors, the store default
// that arms it, the chair disclosure, its 20-test file, its record scripts and its live-check script. So the
// guard was not INERT, it was DEAD CODE — and those two produce the identical observable (no size changes)
// while demanding opposite responses. One means the layer is ready for L2; the other means L2 would ship with
// no guard at all.
//
// ★ AND THE GATES BELOW ARE THE POINT OF THE SCRIPT, NOT ITS DECORATION. They RE-MEASURE the restored state at
// write time and REFUSE if it does not hold — so this row cannot become a second stale claim of correction.
// That failure is already in the repo's history: "writing a correction into memory is NOT applying it."
//
// DRY RUN BY DEFAULT (pass --yes to write). Marker-guarded, occurrence-counted, READ BACK after writing.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');
const ins = require('../trading/agent/instruments');
const pb = require('../trading/agent/promptBuilder');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TESTFILE = 'test/risk-margin-guard.test.js';
const LIVECHECK = 'trading/scripts/repro/margin-guard-live-check.js';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 L3 LOST AND RESTORED##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const DOT = '\u00B7';
const SEC = '\u00A7';
const CHECK = '\u2714';

const ADDENDUM = `
${MARKER} HALF OF L3 WAS MISSING FROM DISK##

${WARN} **THIS ROW AND ${SEC}13 OF THE REPORT BOTH SAID "L3 ${EM} LANDED, and INERT" WHILE L3 WAS DEAD CODE.**
Recorded 2026-09-29 after a VS Code crash, because the two states are indistinguishable from every surface the
desk has, and because a stale claim of landed work is the failure class this report exists to criticise.

${STAR} WHAT WAS ACTUALLY ABSENT, measured rather than assumed:

| artifact | state found | consequence |
|---|---|---|
| ${'`'}instruments.js${'`'} ${ARROW} ${'`'}marginRatePct()${'`'} | **absent** (function, call site, and both exports) | the guard's **denominator** did not exist |
| ${'`'}instruments.js${'`'} ${ARROW} ${'`'}marginRatesFor()${'`'} | **absent** | the open book's margin could not be read at all |
| ${'`'}store.js${'`'} ${ARROW} ${'`'}DEFAULT_SETTINGS.risk.maxMarginUtilisationPct${'`'} | **absent** | ${'`'}risk.js${'`'} arms the guard only when that number is finite and positive ${EM} **so it was never armed** |
| ${'`'}promptBuilder.js${'`'} ${ARROW} the two chair refusal rules | **absent** | the seat was told about neither rule |
| ${'`'}test/risk-margin-guard.test.js${'`'} | **absent** (the whole file, 20 tests) | **nothing tested the layer** |
| ${'`'}scripts/record-2026-09-29-pp-L3*.js${'`'} (x2) | **absent** | the layer's record scripts |
| ${'`'}trading/scripts/repro/margin-guard-live-check.js${'`'} | **absent** | the inertness measurement |

${ARROW} **THE DECISIVE READING: the guard was ${'`'}marginArmed: false${'`'}, i.e. ABSENT, not inert.** The live
${'`'}TradingSettings${'`'} row carries no ${'`'}maxMarginUtilisationPct${'`'} key, so the value comes from
${'`'}DEFAULT_SETTINGS${'`'} ${EM} and with that key gone there was nothing to arm it. **An absent key is
indistinguishable from a switched-off control**, which is the ${'`'}maxRiskPerTradePct${'`'} precedent: a missing
default silently disabled a guard while the code read as though it were armed.

${STAR} HOW IT WAS FOUND, and why nothing else caught it. The ONLY surviving test that touched the layer was the
promptBuilder disclosure test in ${'`'}test/risk-veto-codes.test.js${'`'}, and it was **red ${EM} one failure out of
1,709**. The other four absences were invisible to the suite BY CONSTRUCTION: no test required the two accessors,
and a missing store default is a state the code is designed to tolerate silently. **The structural pin that WOULD
have caught it had been the one corrected earlier the same day for the opposite reason** (it certified a claim it
could no longer test) ${EM} see ${SEC}13 of the report.

${STAR}${STAR}${STAR} RESTORED AND RE-MEASURED LIVE 2026-09-29 (${'`'}margin-guard-live-check.js${'`'}, read-only,
**all gates pass**):

    ARMING       effective maxMarginUtilisationPct = 80 (supplied by the DEFAULT, since the row has no key)
                 and the DEFAULT arms it ${EM} an absent key must not disarm the guard
    DENOMINATOR  21 spot rows; maintenance is exactly half of initial on EVERY row (0 exceptions)
                 Bitcoin states 60% from initialMarginPct vs 100/L = 59.8802 from the 2dp display
    LIVE BOOK    equity 4150.45 ${DOT} Silver 4.9559 @ 61.19 ${DOT} Gold 0.1275 @ 4136.40
                 both rates 20% from initialMarginPct
                 used margin 166.13 = 4.00% of equity against the 80% ceiling  <-- ${SEC}13.2's 3.99% reproduced
                 guard has an OPINION (not ${'`'}unknown${'`'}), book NOT full (remaining 3154.23)
    INERTNESS    worst single position = 80% x 60% = 48.00% of equity vs an 80% ceiling
                 ${ARROW} the guard CANNOT fire; raise maxEquityPerPositionPct past 133% and that stops holding

${WARN} **THE RESTORATION IS REPO-SIDE ONLY UNTIL THE TRADING SERVICE RESTARTS.** The running process holds
whichever combination it loaded at start, so "inert" cannot be asserted of the LIVE desk until a restart ${EM} and
on that restart the guard becomes armed for the first time if the process predates the store default. That is safe
precisely because the arithmetic above holds (48% < 80%), which is why the inertness proof had to be re-measured
BEFORE the restart rather than after it.

${STAR} SUITE: **1,730 tests / 1,729 pass / 0 fail / 1 skipped** (the rebuilt file contributes 21; the lost
original had 20). ${'`'}test/risk-margin-guard.test.js${'`'} now pins the two things whose absence caused this:
**the store default is part of the control** and **the two accessors exist and are exported**. The report carries
the whole account in its ${SEC}13.4.

${STAR} THE TRANSFERABLE RULE. A status line reading "LANDED" is a claim about a REPOSITORY, and a repository can
lose a file without losing the claim. **Neither this failure nor its cousin (the structural pin that stopped
firing) was catchable by reading the code; both were caught by asking whether the control was ARMED and BELOW ITS
CEILING ${EM} i.e. by measuring the two numbers the layer acts on.**`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (sqlText) => (await pool.request().query(sqlText)).recordset;

  console.log('=== L3 LOST AND RESTORED — recording gates ===\n');

  // ── 1. THE THREE ACCESSORS/DEFAULTS THAT WERE MISSING ─────────────────────────────────────────────────
  console.log('1. the restored implementation');
  for (const fn of ['marginRatePct', 'marginRatesFor']) {
    if (typeof ins[fn] !== 'function') await fail(`instruments.${fn} is ${typeof ins[fn]} — the guard's ${
      fn === 'marginRatePct' ? 'denominator' : 'book read'} is missing AGAIN`);
  }
  console.log(`  ${CHECK} instruments.marginRatePct + marginRatesFor are functions`);

  const capDefault = (store.DEFAULT_SETTINGS.risk || {}).maxMarginUtilisationPct;
  if (!(Number.isFinite(capDefault) && capDefault > 0)) {
    await fail(`DEFAULT_SETTINGS.risk.maxMarginUtilisationPct is ${JSON.stringify(capDefault)} — the guard would NOT arm,`
      + ' which is the exact state this row records as a loss');
  }
  console.log(`  ${CHECK} the store DEFAULT arms the guard (${capDefault}%)`);

  // ── 2. THE CHAIR DISCLOSURE, BOTH DIRECTIONS ──────────────────────────────────────────────────────────
  console.log('\n2. the chair disclosure');
  const armed = pb.riskParameterLines({ risk: { maxMarginUtilisationPct: 80 } }).join('\n');
  const off = pb.riskParameterLines({ risk: {} }).join('\n');
  if (!armed.includes("the book's margin utilisation is already at the 80% ceiling")) {
    await fail('the armed disclosure is missing the margin_utilisation rule');
  }
  if (!armed.includes("the margin guard cannot be evaluated (the venue's margin rate or an open position's notional is unreadable)")) {
    await fail('the armed disclosure is missing the margin_guard_unusable rule');
  }
  if (/margin guard cannot be evaluated/.test(off)) await fail('the UNARMED config prints a refusal rule — non-vacuity lost');
  console.log(`  ${CHECK} both rules disclosed when armed, neither when the ceiling is off`);

  // ── 3. THE LIVE BOOK, AND THE INERTNESS PROOF ─────────────────────────────────────────────────────────
  console.log('\n3. the live book (read-only)');
  const settings = await store.getSettings(1);
  const cap = Number((settings.risk || {}).maxMarginUtilisationPct);
  if (!(Number.isFinite(cap) && cap > 0)) await fail(`the EFFECTIVE ceiling is ${JSON.stringify(cap)} — the guard is disarmed`);
  const open = await store.getOpenTrades(1);
  const symbols = [...new Set(open.map((t) => String(t.symbol)))];
  const rates = await ins.marginRatesFor(1, symbols);
  let used = 0;
  let unreadable = 0;
  for (const t of open) {
    const row = rates[String(t.symbol)];
    const pct = row && Number.isFinite(row.pct) && row.pct > 0 ? row.pct : null;
    if (pct == null) { unreadable += 1; continue; }
    used += (Number(t.size) || 0) * (Number(t.openPrice) || 0) * (pct / 100);
  }
  if (unreadable) await fail(`${unreadable} open position(s) are unpriced for margin — the guard would fail CLOSED and refuse entries`);
  console.log(`  ${CHECK} every open position is priceable ${DOT} ${open.length} open, used margin ${used.toFixed(2)}`);

  const rows = rates;
  const perPos = Number((settings.risk || {}).maxEquityPerPositionPct);
  const table = await require('../trading/store/instruments').listInstruments(1, { limit: 2000 });
  const ratesAll = table
    .filter((r) => String(r.instrumentClass || 'spot') === 'spot')
    .map((r) => ins.marginRatePct(ins.venueLeverage(r)).pct)
    .filter((x) => Number.isFinite(x) && x > 0);
  const maxRate = ratesAll.length ? Math.max(...ratesAll) : null;
  if (maxRate == null) await fail('no registry row yields a margin rate — the inertness proof has no input');
  const worst = perPos * (maxRate / 100);
  if (!(worst < cap)) {
    await fail(`the worst single position is ${worst.toFixed(2)}% of equity against a ${cap}% ceiling — the guard is`
      + ' NO LONGER inert, so "inert" is the wrong word and the row must be rewritten rather than appended');
  }
  console.log(`  ${CHECK} INERTNESS holds: ${perPos}% x ${maxRate}% = ${worst.toFixed(2)}% vs a ${cap}% ceiling`);
  if (rows && Object.keys(rows).length !== symbols.length) await fail('marginRatesFor did not answer for every symbol');

  // ── 4. THE RESTORED ARTIFACTS EXIST ───────────────────────────────────────────────────────────────────
  console.log('\n4. artifacts');
  for (const f of [TESTFILE, LIVECHECK]) {
    if (!fs.existsSync(path.join(ROOT, f))) await fail(`${f} does not exist — this row would cite a file that is gone`);
  }
  const testSrc = fs.readFileSync(path.join(ROOT, TESTFILE), 'utf8');
  if (!testSrc.includes('THE STORE DEFAULT IS PART OF THE CONTROL')) {
    await fail('the rebuilt test file does not pin the store default — the exact thing that was lost');
  }
  console.log(`  ${CHECK} ${TESTFILE} pins the store default ${DOT} ${LIVECHECK} present`);

  const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  if (!doc.includes('13.4 ') || !doc.includes('48.00% of equity')) {
    await fail(`the report has no ${SEC}13.4 account of the loss — the doc is the record of it`);
  }
  console.log(`  ${CHECK} the report carries ${SEC}13.4 and the 48.00% inertness figure`);

  // ── 5. THE ROW ────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n5. the row and its marker');
  const row = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!row) await fail(`row ${TASK_ID} does not exist`);
  const info = row.info || '';
  const n = info.split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${info.length} chars ${DOT} this marker ${n}x`);

  if (!YES) {
    console.log(n === 0
      ? `\n  would append ${ADDENDUM.length} chars. DRY RUN ${EM} not written.`
      : `\n  block already present (${ADDENDUM.length} chars skipped). DRY RUN ${EM} not written.`);
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
  if (!(after.info || '').includes('HALF OF L3 WAS MISSING FROM DISK')) await fail('the read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${after.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
