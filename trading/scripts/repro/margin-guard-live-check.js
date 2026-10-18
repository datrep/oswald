// trading/scripts/repro/margin-guard-live-check.js — L3 (rev 5, 2026-09-29), REBUILT 2026-09-29.
//
// ⚠ THIS SCRIPT WAS LOST IN THE VS CODE CRASH OF 2026-09-29, together with `test/risk-margin-guard.test.js`,
// the two `record-2026-09-29-pp-L3*.js` scripts, the store default and the two accessors it exercises. It is
// rebuilt here because the claim it was built to test is the one that decides whether the whole layer is real:
//
//   L3 IS INERT, AND IT IS INERT FOR A STATED ARITHMETIC REASON — not because it is dead code.
//
// Those two explanations produce the same observable (no size changes) and demand opposite responses, so the
// check has to separate them. It does that by measuring the ARMING CONDITION and the CEILING separately:
//
//   1. the guard ARMS on the effective settings (an absent key is a dead control, not an inert one);
//   2. the live book's margin is READABLE from the registry (an unreadable book makes the guard fail CLOSED,
//      which would refuse entries — the opposite of inert);
//   3. the largest margin any single position can commit is BELOW the ceiling, which is the inertness proof
//      and depends on `maxEquityPerPositionPct`, i.e. on L2. Raise that cap and (3) stops holding.
//
// READ-ONLY: opens no browser, changes no setting, writes no row. Run from the repo root:
//   node trading/scripts/repro/margin-guard-live-check.js
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const store = require('../../store');
const risk = require('../../agent/risk');
const ins = require('../../agent/instruments');
const registry = require('../../store/instruments');
const { getPool } = require('../../../shared/db');

const USER = 1;
let failures = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`  OK   ${msg}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  await getPool();
  console.log('=== L3 MARGIN GUARD — LIVE READ-ONLY CHECK ===\n');

  const settings = await store.getSettings(USER);
  const r = settings.risk || {};

  // ── 1. ARMED, AND ARMED FROM THE EFFECTIVE SETTINGS (not from a key someone typed into the DB) ──────────
  console.log('1. ARMING');
  const cap = Number(r.maxMarginUtilisationPct);
  ok(Number.isFinite(cap) && cap > 0, 'the ceiling is armed on the EFFECTIVE settings',
    `maxMarginUtilisationPct = ${JSON.stringify(r.maxMarginUtilisationPct)} (default supplied it if the row has no key)`);
  const capDefault = store.DEFAULT_SETTINGS.risk.maxMarginUtilisationPct;
  ok(Number.isFinite(capDefault) && capDefault > 0, 'the DEFAULT arms it too — an absent key must not disarm the guard',
    `DEFAULT_SETTINGS.risk.maxMarginUtilisationPct = ${JSON.stringify(capDefault)}`);

  // ── 2. THE RATES THE GUARD WILL USE, READ FROM THE REGISTRY ────────────────────────────────────────────
  console.log('\n2. THE DENOMINATOR, per registry row');
  const rows = await registry.listInstruments(USER, { limit: 2000 });
  const spots = rows.filter((x) => String(x.instrumentClass || 'spot') === 'spot');
  const seen = new Map();
  for (const row of spots) if (!seen.has(row.symbol)) seen.set(row.symbol, row);
  let halfMismatch = 0;
  for (const row of spots) {
    const init = row.initialMarginPct == null ? null : Number(row.initialMarginPct);
    const maint = row.maintenanceMarginPct == null ? null : Number(row.maintenanceMarginPct);
    if (init != null && maint != null && Math.abs(maint - init / 2) > 1e-6) halfMismatch += 1;
  }
  ok(spots.length > 0, 'the registry holds spot rows to price capacity from', `${spots.length} spot row(s), ${rows.length} total`);
  ok(halfMismatch === 0, 'maintenance is exactly half of initial on every row — which is why initial is the denominator',
    `${halfMismatch} exception(s)`);
  const btc = spots.find((x) => String(x.symbol) === 'Bitcoin');
  if (btc) {
    const m = ins.marginRatePct(ins.venueLeverage(btc));
    ok(m.pct != null, 'Bitcoin states a margin', `${m.pct}% from ${m.from}`);
    const derived = Number(btc.leverage) > 0 ? 100 / Number(btc.leverage) : null;
    if (derived != null) {
      ok(Math.abs(m.pct - derived) > 1e-9,
        'the STATED percent differs from the ratio-derived one — the reason `from` is carried',
        `stated ${m.pct}% vs 100/L ${+derived.toFixed(4)}% (L = ${btc.leverage})`);
    }
  } else {
    ok(false, 'Bitcoin must be in the registry for the leverage-ordering claim to be checkable');
  }

  // ── 3. THE LIVE BOOK, AND THE GUARD'S OWN ARITHMETIC ON IT ─────────────────────────────────────────────
  console.log('\n3. THE LIVE BOOK');
  const open = await store.getOpenTrades(USER);
  const ticks = await store.listEquityTicks(USER, { hours: 6, limit: 500 });
  const equity = ticks.length ? Number(ticks[ticks.length - 1].equity) : null;
  ok(equity != null && equity > 0, 'equity read from the venue strip (EquityTicks)', equity == null ? 'none' : equity.toFixed(2));

  const symbols = [...new Set(open.map((t) => String(t.symbol)))];
  const rates = await ins.marginRatesFor(USER, symbols);
  console.log(`     open positions: ${open.length ? open.map((t) => `${t.symbol} ${t.size}@${t.openPrice}`).join(' · ') : '(none)'}`);
  for (const s of symbols) {
    const rate = rates[s];
    console.log(`     rate ${s}: ${rate ? `${rate.pct}% from ${rate.from}` : 'UNREADABLE -> guard fails closed'}`);
  }

  let usedMargin = 0;
  let unreadable = 0;
  for (const t of open) {
    const rate = rates[String(t.symbol)];
    const pct = rate && Number.isFinite(rate.pct) && rate.pct > 0 ? rate.pct : null;
    if (pct == null) { unreadable += 1; continue; }
    usedMargin += (Number(t.size) || 0) * (Number(t.openPrice) || 0) * (pct / 100);
  }
  ok(unreadable === 0, 'every open position is priceable for margin, so the guard will not fail closed',
    unreadable ? `${unreadable} unreadable` : 'all readable');

  if (equity > 0) {
    const usedPct = (usedMargin / equity) * 100;
    const mg = risk.fitMarginBudget({ size: 0.5, price: 4000, marginRatePct: 20, usedMargin, capPct: cap, equity });
    ok(!mg.unknown, 'the guard has an OPINION on the live book (not `unknown`, which would refuse every entry)',
      `used ${usedMargin.toFixed(2)} = ${usedPct.toFixed(2)}% against a ${cap}% ceiling`);
    ok(mg.full === false, 'and the book is NOT full', `capMargin ${mg.capMargin.toFixed(2)}, remaining ${mg.remainingMargin.toFixed(2)}`);
  }

  // ── 4. ★ THE INERTNESS PROOF — the number that must be compared before L2 ships ────────────────────────
  console.log('\n4. INERTNESS (the acceptance test, and it is arithmetic)');
  const maxRate = Math.max(0, ...spots.map((row) => {
    const m = ins.marginRatePct(ins.venueLeverage(row));
    return m.pct == null ? 0 : m.pct;
  }));
  const perPos = Number(r.maxEquityPerPositionPct);
  ok(Number.isFinite(perPos) && perPos > 0, 'maxEquityPerPositionPct read', `${perPos}%`);
  if (Number.isFinite(perPos) && maxRate > 0) {
    const worst = perPos * (maxRate / 100);
    ok(worst < cap,
      'the largest margin ONE position can commit is below the ceiling, so the guard cannot fire yet',
      `worst = ${perPos}% x ${maxRate}% = ${worst.toFixed(2)}% of equity vs a ${cap}% ceiling`);
    console.log(`     ⚠ RAISE maxEquityPerPositionPct past ${(cap / (maxRate / 100)).toFixed(0)}% and this stops holding —`);
    console.log(`       at L2's 500% the same position commits ${(500 * (maxRate / 100)).toFixed(0)}% of equity in margin, i.e. the guard becomes the ONLY brake.`);
  }

  console.log(`\n${failures === 0 ? '✔ ALL GATES PASS — L3 is armed, readable, and inert for a stated reason'
    : `✘ ${failures} GATE(S) FAILED — do NOT describe L3 as inert until they pass`}`);
  const pool = await getPool();
  await pool.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('margin-guard-live-check failed:', e); process.exit(2); });
