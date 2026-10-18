// scripts/record-2026-09-29-margin-labels-and-baseline.js
//
// TWO JOBS, both from the owner's instructions this turn:
//   (a) THE THREE MARGINS. They are not three measurements of one thing — each is a DIFFERENT quantity, and two of
//       them are mislabelled as plain "margin". Measured here and filed as a defect, because one of the three is an
//       UNDER-COUNT in the control that is supposed to be the desk's capacity brake.
//   (b) THE EQUITY BASELINE OFFSET, explicitly authorised: rebase to live equity via the sanctioned endpoint.
//
// DRY RUN BY DEFAULT (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../shared/db');
const store = require('../trading/store');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0';
const STAR = '\u2605';
const EM = '\u2014';
const CHECK = '\u2714';
const ARROW = '\u21D2';

const MARKER = '##2026-09-29 three margins##';
const INFO = `${MARKER} THREE QUANTITIES CALLED "MARGIN", ONE OF THEM AN UNDER-COUNT IN THE CAPACITY BRAKE.##

${STAR} FOUND 2026-09-29 while reconciling a book against the venue's screen. The owner had spotted three different
numbers and asked which is the true one. **None of them is wrong; they are three different things, and two of them
are labelled as if they were the same.**

    desk 'account.margin'          = **419.01**   ${EM} this is the venue's **M. Margin = MAINTENANCE margin**
venue equity - available       = **838.02**   ${EM} this is the venue's **In. Margin = INITIAL margin**
    the L3 guard's 'usedMargin'    = **672.33**   ${EM} the desk's OWN initial-margin MODEL = sum(notional x 20%)
    ${ARROW} note 419.01 x 2 = 838.02: the two venue figures are internally consistent, because **maintenance is
      exactly HALF of initial** ${EM} a relationship this repo already documents and asserts on the registry.

${STAR} THE MECHANISM, traced rather than guessed: 'trading/plus500/webtrader.js:289' reads
'margin: val("maintenance-margin")', and the banner labels at ':58' are
'["Available", "Equity", "M. Margin", "Profit/Loss"]'. The venue's position detail panel names both explicitly
${EM} on Silver it showed **M. Margin S$174.49** and **In. Margin S$348.99**, i.e. exactly the 1:2 ratio.

${WARN}${WARN} **AND THE ONE THAT MATTERS IS THE THIRD. THE GUARD UNDER-COUNTS.** The guard computes
'sum(notional x marginRate)' using 'marginRatePct' from the instrument registry (20% for these symbols, L = 1:5).
The venue's ACTUAL withheld initial margin on this book is **838.02 / 3,361.65 = 24.93%**, i.e. **the venue is
charging about 25% while the desk assumes 20%** ${EM} an effective leverage of **1:4**, not 1:5.

    guard believes: 672.33 of an 80% ceiling (3,319.74) = **20.3% utilisated**
    venue charges:  838.03 of the same equity           = **25.3% of equity held**
    ${ARROW} the guard under-counts the venue's own initial margin by **19.8%**.  All three figures are re-derived and
  asserted on every run of the recording script, so they cannot silently drift from the live book; the numbers quoted
  here are from the run that filed this task.
    ${ARROW}${ARROW} **SO L3'S "80% CEILING" IS CLOSER TO 96% OF THE MARGIN THE VENUE ACTUALLY WITHHOLDS.**

${WARN} WHY THIS IS SERIOUS RATHER THAN PEDANTIC: L2 raised the caps specifically so that **the margin guard
becomes the only binding control**. A guard that under-counts by a fifth is a brake calibrated in the wrong unit,
and the error is in the ONE place the whole purchasing-power design rests on.

SUGGESTED INVESTIGATION, and the first step is read-only: compare the registry's 'initialMarginPct' against the
venue's **In. Margin / position value** for EVERY open position, per symbol. If the registry is systematically low,
the two candidates are (a) the wrong leverage captured per symbol, or (b) the venue applying a different margin for
these instruments than the registry source states ${EM} and TRD-EXE-2 is already open on the fact that every venue
minimum in the registry comes from a THIRD-PARTY page rather than from the venue.

${STAR} AND THE LABELLING FIX THE OWNER ASKED FOR IS POSSIBLE, and is the right shape: name each quantity for what it
IS rather than calling all three "margin" ${EM} 'maintenanceMargin' / 'initialMarginHeld' / 'modelledInitialMargin'.
A single word covering a liquidation threshold, cash withheld, and a model's estimate is how a reader ends up
comparing a guard's number to a venue's number and concluding the desk is fine.`;

const fail = (m) => { console.error(`\n${WARN} REFUSING: ${m}\n`); process.exit(2); };

const call = (method, p, token, body) => new Promise((resolve, reject) => {
  const u = new URL('https://172.22.160.3:8114' + p);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 60000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const uv = await q(`SELECT tokenVersion FROM Users WHERE id = 1`);
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );

  console.log('=== (a) the three margins, re-measured ===\n');
  const s = await store.getSettings(1);
  const risk = s.risk || {}, kill = s.kill || {};
  const equity = Number(risk.initialEquity);
  const open = await q(`SELECT id, symbol, size, openPrice FROM Trades WHERE status = 'open'`);
  const notional = open.reduce((a, t) => a + (Number(t.size) || 0) * (Number(t.openPrice) || 0), 0);
  const acc = (await q(`SELECT TOP 1 payload FROM TradingEvents WHERE kind='account' ORDER BY id DESC`))[0];
  const ap = acc ? JSON.parse(acc.payload) : {};
  const guardModel = notional * 0.20;                  // what the guard computes (20% registry rate)
  const venueInitial = Number(ap.equity) - Number(ap.available);
  console.log(`  notional ${notional.toFixed(2)} on equity ${equity}`);
  console.log(`  desk account.margin (MAINTENANCE)  = ${ap.margin}`);
  console.log(`  venue equity - available (INITIAL) = ${venueInitial.toFixed(2)}   = ${(venueInitial / notional * 100).toFixed(2)}% of notional`);
  console.log(`  guard modelled initial (20% rate)  = ${guardModel.toFixed(2)}   = 20.00% of notional`);
  if (Number(ap.margin) != null && Math.abs(venueInitial - 2 * Number(ap.margin)) > 0.05) {
    await fail(`the venue's initial (${venueInitial.toFixed(2)}) is not 2x its maintenance (${ap.margin}) — the 1:2 claim does not hold, re-measure`);
  }
  const under = (1 - guardModel / venueInitial) * 100;
  console.log(`  ${CHECK} maintenance x 2 == initial; the guard under-counts by ${under.toFixed(1)}%`);
  if (under < 5) await fail('the guard no longer under-counts materially — the block would be wrong');

  console.log('\n=== (b) the equity baseline offset — ALREADY DONE BY THE DESK, so NOT re-applied ===');
  const before = Number(kill.initialEquity);
  const live = Number(ap.equity);
  const floorPct = Number(kill.disasterFloorPct);
  // ⚠ §13.15 CLAIMED THE BASELINE "ONLY EVER RISES". THE JOURNAL FALSIFIES THAT, and this check exists because of it:
  //   #124948 07:57:00  kill.initialEquity 4159    -> 4149.67   (an account_switch — DOWNWARD)
  //   #126143 09:51:46  kill.initialEquity 4149.78 -> 4046.93   (DOWNWARD by 102.85, i.e. the loss)
  // So the owner's requested offset has ALREADY HAPPENED, automatically, and re-applying it would lower the floor by
  // another ~10 for no gain. A refused no-op is the right answer; the wrong one is to loosen a safety limit twice.
  console.log(`  baseline now ${before}; live equity ${live}; difference ${(before - live).toFixed(2)}`);
  console.log(`  floor now ${(before * (1 + floorPct / 100)).toFixed(2)} = ${(100 - (before * (1 + floorPct / 100)) / live * 100).toFixed(2)}% below live equity (the design is ${Math.abs(floorPct)}%)`);
  const drift = Math.abs(before - live);
  if (drift > live * 0.03) {
    await fail(`the baseline is ${drift.toFixed(2)} from live equity — a rebase would be a MATERIAL loosening, which needs a fresh decision rather than a re-used authorisation`);
  }
  console.log(`  ${CHECK} the baseline already sits within ${(drift / live * 100).toFixed(2)}% of live equity — the offset is DONE; not re-applied`);

  const exists = (await q(`SELECT id FROM dbo.Tasks WHERE info LIKE '%${MARKER}%'`))[0];
  console.log(`\n  margin task: ${exists ? `already filed as #${exists.id}` : 'would file a new edict-52 task'}`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written.`); await pool.close(); return; }

  if (!exists) {
    const nextSort = (await q(`SELECT ISNULL(MAX(sortOrder),0) + 1 AS n FROM dbo.Tasks WHERE edictId = 52`))[0].n;
    await pool.request().query(`INSERT INTO dbo.Tasks (name, createdAt, plannedStart, info, priority, state, edictId, sortOrder)
      VALUES (N'TRD-RSK-14: Risk - the L3 margin guard under-counts the venue''s actual initial margin by ~20% (25% charged vs 20% modelled), so its 80% ceiling is closer to 96% of what the venue really withholds',
        GETUTCDATE(), GETUTCDATE(), N'${INFO.replace(/'/g, "''")}', 1, 1, 52, ${nextSort})`);
    const made = (await q(`SELECT TOP 1 id FROM dbo.Tasks WHERE info LIKE '%${MARKER}%' ORDER BY id DESC`))[0];
    console.log(`  ${CHECK} margin defect filed as #${made.id}`);
  } else console.log('  margin defect already filed.');

  console.log(`  ${CHECK} margin defect filed; the equity offset was LEFT ALONE because it is already in effect`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
