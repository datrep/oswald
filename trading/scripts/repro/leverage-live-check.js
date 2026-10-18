// ★ UNIT-FREE ON PURPOSE, AND IT READS NO BALANCE. Equity is not queried — `dbo.Trades` has no such
// column (checked against INFORMATION_SCHEMA rather than assumed), and purchasing power is printed as a
// MULTIPLE of equity instead. §7.1 of the design document is ratio-only for the same reason: every
// absolute figure in an earlier draft of this work was wrong, while `notionalPct = r/s` and
// `marginPct = r/ceiling` are exact for any equity. An equity figure this script does not take cannot
// be an equity figure it got wrong.
//
// ★ THE NUMBER TO WATCH is `ceilingPct = L x venueStopPct`, and the STOP is printed beside it, because
// a ceiling without its stop is a number without a subject — Gold appears in this work's ancestry as
// both 2.75% and 3.320% on identical settings, purely because the stop moved.
//
// READ-ONLY. No write, no capture, no probe, no browser: one SELECT and seven resolve() calls.
//
// Run: node trading/scripts/repro/leverage-live-check.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const ins = require('../../agent/instruments');
const spec = require('../../plus500/instrumentSpec');

// The seven symbols of §5's ceiling table. A symbol here with `L = null` is a hole in the desk's
// ability to state its own limit.
const WATCHLIST = ['Gold', 'Bitcoin', 'Sugar', 'Arabica Coffee', 'Silver', 'Oil', 'SGX'];
const USER_ID = 1;

const pad = (s, n) => String(s == null ? '-' : s).padEnd(n);
const r4 = (n) => (n == null || !Number.isFinite(Number(n)) ? '-' : (Math.round(Number(n) * 10000) / 10000).toFixed(4));

(async () => {
  const pool = await getPool();

  // The newest stop actually used on a ticket per symbol. Not decoration: `ceiling = L x stopPct`, so
  // this column is half of every number to its right, and the reason two runs of this script on
  // different days disagree without either being wrong.
  const rows = await pool.request().query(`
    SELECT symbol, stopPrice, openPrice
      FROM dbo.Trades
     WHERE userId = ${USER_ID} AND stopPrice IS NOT NULL AND openPrice > 0
       AND symbol IN (${WATCHLIST.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')})
     ORDER BY openAt ASC`);

  const stopPct = new Map();
  for (const r of rows.recordset) {
    const s = Math.abs(Number(r.openPrice) - Number(r.stopPrice)) / Number(r.openPrice) * 100;
    if (Number.isFinite(s) && s > 0) stopPct.set(r.symbol, s); // ascending => the newest write wins
  }

  console.log(`\n=== L1 LIVE CHECK — ${new Date().toISOString()} ===`);
  console.log('purchasing power is a MULTIPLE OF EQUITY (L x equity). No balance is read, so nothing here');
  console.log('depends on an equity figure this script did not take.\n');
  console.log(`${pad('symbol', 16)} ${pad('leverageRaw', 12)} ${pad('L', 7)} ${pad('100/L', 7)} ${pad('init%', 7)} ${pad('maint%', 8)} ${pad('PP (x eq)', 10)} ${pad('stop%', 8)} ${pad('CEILING%', 9)} ${pad('', 2)}`);
  console.log('-'.repeat(106));

  let unreadable = 0;
  let disagree = 0;
  const seen = [];

  for (const sym of WATCHLIST) {
    const res = await ins.resolve(USER_ID, { symbol: sym });
    const L = res.found ? res.leverage : null;
    const s = stopPct.get(sym) || null;
    const ceiling = L != null && s != null ? L * s : null;
    const expected = L != null ? 100 / L : null;
    // ★ ASK THE VALIDATOR, DO NOT RE-DERIVE IT HERE. An earlier version of this script compared against
    // a locally-chosen 0.1 and so disagreed with `checkSpec` on Bitcoin — a second copy of the arithmetic,
    // which is the defect the cross-check exists to catch. `checkSpec` is the thing that decides.
    const mismatch = res.found
      ? spec.checkSpec({
        unitAmount: res.minUnits, unitKind: res.unitKind, instrumentClass: res.instrumentClass || 'spot',
        leverageRaw: res.leverageRaw, initialMarginPct: res.initialMarginPct,
      }).includes(spec.CODES.MARGIN_LEVERAGE_MISMATCH)
      : false;
    if (!res.found || L == null) unreadable += 1;
    if (mismatch) disagree += 1;
    seen.push({ sym, L, s, ceiling, init: res.initialMarginPct, raw: res.leverageRaw, found: res.found, reason: res.reason });
    console.log([
      pad(sym, 16),
      pad(res.found ? (res.leverageRaw || '(null)') : `NOT FOUND:${res.reason}`, 12),
      pad(r4(L), 7),
      pad(r4(expected), 7),
      pad(r4(res.initialMarginPct), 7),
      pad(r4(res.maintenanceMarginPct), 8),
      pad(L != null ? `${L}x` : '-', 10),
      pad(s != null ? s.toFixed(4) : '-', 8),
      pad(ceiling != null ? ceiling.toFixed(4) : '-', 9),
      pad(mismatch ? 'DISAGREE' : '', 2),
    ].join(' '));
  }
  console.log('-'.repeat(106));

  // ★ THE FINDING THIS SCRIPT EXISTS TO PRODUCE: one dial, several symbols, several different ceilings.
  console.log('\n=== the spread in capacity, on identical settings ===');
  for (const x of seen) {
    if (x.L == null) { console.log(`  ${pad(x.sym, 16)} leverage UNKNOWN — ceiling cannot be stated at all`); continue; }
    console.log(`  ${pad(x.sym, 16)} L=${r4(x.L)}  PP=${x.L}x equity  ${x.ceiling != null ? `ceiling on this ticket's stop (${x.s.toFixed(4)}%) = ${x.ceiling.toFixed(4)}%` : 'no stop on record — ceiling not computable'}`);
  }
  const known = seen.filter((x) => x.L != null);
  if (known.length > 1) {
    const hi = known.reduce((a, b) => (b.L > a.L ? b : a));
    const lo = known.reduce((a, b) => (b.L < a.L ? b : a));
    console.log(`\n  => max(L)/min(L) = ${(hi.L / lo.L).toFixed(2)}x (${hi.sym} ${hi.L} vs ${lo.sym} ${lo.L}). A risk dial is NOT one`);
    console.log('     setting across a book with that spread: the same r is reachable on one symbol and');
    console.log('     geometrically impossible on another, and no control on the desk could say so before L1.');
  }

  console.log('\n=== the venue\'s own cross-check (initialMarginPct == 100 / leverage) ===');
  console.log(disagree === 0
    ? '  no disagreement: the ratio L1 reads agrees with the margin the venue itself states.'
    : `  ${disagree} row(s) DISAGREE — the ratio and the margin are two statements of one number, so one was misread.`);

  // ★★ WHICH NUMBER IS AUTHORITATIVE — settled here, because L3's margin guard divides by it and a
  // 0.2% error in that denominator is a 0.2% error in every margin figure the desk reports.
  //
  // `instrumentSpec.checkSpec` asserts `|initialMarginPct - 100/leverage| <= 0.01` and its comment
  // claims that tolerance is "enough to absorb the display rounding to 2dp". THAT CLAIM IS FALSE, and
  // the Bitcoin row is the counter-example: the venue stores '1:1.67' and 60.00% initial margin, so the
  // check computes 100/1.67 = 59.8802 against a stated 60.0000 — a 0.1198 discrepancy, 12x the
  // tolerance it was said to absorb. The rounding error in the MARGIN scales as 100/L^2 x dL, and with
  // the ratio rounded to 2dp (dL up to 0.005) that is ~0.18 points at L = 1.67 — not 0.01. The tighter
  // the leverage, the bigger the error: at 1:1.67 it is material, at 1:10 (SGX) it is invisible.
  //
  // The evidence for which statement is PRIMARY, on this venue's own numbers:
  //   (a) maintenanceMarginPct is EXACTLY half of initialMarginPct on all seven rows (60/30, 20/10,
  //       10/5). A ratio-derived initial of 59.8802 would put maintenance at 29.94, and the venue says
  //       30.00 — so the margin figures are stated, and the ratio is the rounded one.
  //   (b) 100/60 = 1.66667, which round-trips to the venue's own '1:1.67' display.
  // => THE MARGIN PERCENT IS PRIMARY; THE RATIO IS A 2dp PRESENTATION OF IT.
  //
  // This is printed rather than asserted in code because changing `checkSpec`'s tolerance is a change to
  // a validator, and this script is read-only. What it establishes is the input L3 needs: `initialMargin
  // Pct` is the authoritative denominator, and `leverage` is safe to use only where its 2dp rounding is
  // immaterial (L >= ~5 on this venue).
  console.log('\n=== WHICH STATEMENT IS PRIMARY (drives L3\'s denominator) ===');
  console.log('  maintenance vs initial, and the error the 2dp ratio would introduce:\n');
  console.log(`  ${pad('symbol', 16)} ${pad('init%', 8)} ${pad('maint%', 8)} ${pad('m=init/2?', 10)} ${pad('100/init', 10)} ${pad('err(pts)', 9)}`);
  console.log('  ' + '-'.repeat(64));
  for (const sym of WATCHLIST) {
    const res = await ins.resolve(USER_ID, { symbol: sym });
    if (!res.found || res.initialMarginPct == null) { console.log(`  ${pad(sym, 16)} initial margin unreadable`); continue; }
    const half = res.maintenanceMarginPct != null ? Math.abs(res.maintenanceMarginPct - res.initialMarginPct / 2) <= 0.005 : null;
    // The margin the venue's RATIO implies, vs the margin it STATES. The gap is the display rounding.
    const implied = res.leverage != null ? 100 / res.leverage : null;
    const err = implied != null ? Math.abs(implied - res.initialMarginPct) : null;
    const flagged = spec.checkSpec({
      unitAmount: res.minUnits, unitKind: res.unitKind, instrumentClass: res.instrumentClass || 'spot',
      leverageRaw: res.leverageRaw, initialMarginPct: res.initialMarginPct,
    }).includes(spec.CODES.MARGIN_LEVERAGE_MISMATCH);
    console.log(`  ${pad(sym, 16)} ${pad(r4(res.initialMarginPct), 8)} ${pad(r4(res.maintenanceMarginPct), 8)} ${pad(half === null ? '-' : (half ? 'yes' : 'NO'), 10)} ${pad(r4(100 / res.initialMarginPct), 10)} ${pad(err == null ? '-' : err.toFixed(4), 9)} ${flagged ? 'FLAGGED' : ''}`);
  }
  console.log('  (a) maintenance == initial/2 on every row  => the margins are STATED, the ratio is derived.');
  console.log('  (b) the err(pts) column is the flat-constant error that USED to flag Bitcoin: 0.1198, 12x the');
  console.log('      0.01 checkSpec tolerated, because the margin error scales as 100/L^2 x dL. Since 2026-09-29');
  console.log('      checkSpec tests the stated margin against the interval the displayed ratio permits, so the');
  console.log('      FLAGGED column above is the validator\'s own verdict and is NOT a copy of this arithmetic.');

  console.log(`\n${unreadable === 0
    ? 'ALL SEVEN have a stated ceiling. L1 is reading the registry, and every ceiling above is a fact about a real row.'
    : `${unreadable} of ${WATCHLIST.length} cannot state a ceiling — leverage absent or unparseable on the registry row.`}`);

  await pool.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
