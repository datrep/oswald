// trading/scripts/repro/register-instrument.js — register watchlist symbols the desk cannot enter at all.
//
// WHY. Measured 2026-10-01: the `Instruments` registry holds 21 spot rows + 20 option rows = 41, and the watchlist
// additions of 2026-09-30 — **Ethereum, Soybeans, Natural Gas** — have NO ROW AT ALL. Not a row with empty fields:
// no row. `marginRatePct({})` therefore returns `{ pct: null }`, the L3 margin guard fails closed by design, and
// every entry on those three is refused with `margin_guard_unusable`.
//
// ⚠ ETHEREUM IS THE ONE THAT MATTERS. It has 307 hourly bars and is READY TO TRADE; the missing registry row is
// the ONLY thing blocking it. Soybeans (7 bars) and Natural Gas (18) are below the 30-bar scan floor as well.
//
// ★ NO CODE PATH IS ADDED HERE, AND THAT IS THE POINT. `POST /instruments/probe {symbol}` already opens the
// instrument INSIDE the page lock, reads the venue's own contract spec, and (unless `capture:false`) calls
// `agent/instruments.captureFromObservation` -> `store/instruments.upsertInstrument`. A row the desk holds can
// therefore only ever come from something a person or probe actually LOOKED AT — which is the property that makes
// this safe to run.
//
// ⚠⚠ DO NOT HAND-WRITE THE MARGIN RATE. `instruments.js` says it plainly: this is the guard's DENOMINATOR, "the
// one number in the layer that must not be a guess". The registry already spans 1:1.67 (Bitcoin, 60%) to 1:10
// (SGX, 10%) with 20% elsewhere, so pasting 20% across new symbols would be exactly the unverified constant that
// has cost this desk repeatedly. This script reads the venue; it never infers.
//
// Usage: node trading/scripts/repro/register-instrument.js Ethereum [Soybeans "Natural Gas"] [--yes]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const BASE = process.env.TRADING_API_BASE || 'https://172.22.160.3:8114';
const YES = process.argv.includes('--yes');
// ★★ `--check` READS the venue and writes NOTHING (`capture:false`) — the mode that verifies an EXISTING row,
// which is the case that matters when a registered instrument still cannot open a ticket.
const CHECK = process.argv.includes('--check');
const SYMBOLS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const WANT = SYMBOLS.length ? SYMBOLS : ['Ethereum'];

const call = (method, p, token, body) => new Promise((resolve, reject) => {
  const u = new URL(BASE + p);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 600000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

(async () => {
  const pool = await getPool();
  const uv = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv.recordset[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
  // ⚠⚠ THE COLUMN LIST IS THE CHECK'S OWN PRECONDITION. The first version selected five columns and then
  // compared `existing.venueInstrumentId` — WHICH IT HAD NEVER FETCHED — against the probe's id. Both sides were
  // `undefined`, `undefined === undefined` is TRUE, and the ID CHECK printed a green tick while measuring
  // NOTHING. That is the `Number(null) === 0` trap one level up — at the KEY rather than the value — and it is
  // the third check today that reported success without measuring anything. So the columns the ID CHECK reads are
  // selected HERE, beside it.
  const rows = async () => (await pool.request().query(
    "SELECT symbol, instrumentClass, venueInstrumentId, unitAmount, unitKind, pointValue, leverageRaw, initialMarginPct, maintenanceMarginPct FROM Instruments WHERE userId=1 AND instrumentClass='spot' ORDER BY symbol",
  )).recordset;

  const before = (await rows()).map((r) => r.symbol);
  console.log(`=== register instrument(s): ${WANT.join(', ')} ===`);
  console.log(`spot rows BEFORE: ${before.length} — ${before.join(', ')}`);
  for (const s of WANT) {
    const existing = (await rows()).find((r) => r.symbol === s) || null;
    if (existing && !CHECK) { console.log(`\n  ${s}: ALREADY REGISTERED — skipping (use --check to verify its id)`); continue; }
    if (!YES && !CHECK) { console.log(`\n  ${s}: NOT registered. Re-run with --yes to probe the venue and capture the row.`); continue; }

    // ★ THE ONE CALL. Under --check it carries `capture:false`, so the route reads the venue and writes NOTHING.
    let out = null;
    try {
      out = JSON.parse((await call('POST', '/api/trading/instruments/probe', token,
        { symbol: s, select: true, capture: !CHECK })).body);
    } catch (e) { console.log(`  ${s}: probe failed — ${e.message}`); continue; }

    // ★★ THE GATE THIS SCRIPT SHOULD HAVE HAD FROM THE START — AND THE REPO HAD ALREADY WRITTEN IT DOWN.
    // `sidebarMatchesSelectedRow` proves the sidebar describes the selected ROW; it does NOT prove the row is the
    // instrument REQUESTED. Asking for Gasoline (3224) once landed on a page still showing CHINA OVERSEAS (1304)
    // and reported SUCCESS. So gate on the RETURNED id/name, never on "a row appeared" — which is exactly the
    // mistake this script made when it took `stored` on trust for Natural Gas and Soybeans.
    const c = (out && out.contract) ? out.contract : null;
    const reg = out && out.registry ? out.registry : null;
    console.log(`\n  ${s}: probed (capture=${!CHECK}).`);
    if (c) {
      const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/[^a-z0-9]/g, '');
      const asked = norm(s);
      const cName = norm(c.name);
      const cSym = norm(c.symbol);
      const nameOk = (cName && (cName.includes(asked) || asked.includes(cName)))
        || (cSym && (cSym.includes(asked) || asked.includes(cSym)));
      console.log(`    venue returned : instrumentId=${c.instrumentId} name="${c.name || ''}" symbol="${c.symbol || ''}"`);
      console.log(`    stored row     : ${existing
        ? `instrumentId=${existing.venueInstrumentId} | unitAmount=${existing.unitAmount} ${existing.unitKind} | pointValue=${existing.pointValue} | ${existing.leverageRaw} | initial ${existing.initialMarginPct}`
        : '(none)'}`);
      console.log(`    ★ NAME CHECK   : ${nameOk
        ? 'the probed instrument matches the requested symbol'
        : '*** THE PROBED INSTRUMENT DOES NOT MATCH THE REQUESTED SYMBOL ***'}`);
      if (existing) {
        // ★ A VA C U O U S PASS IS NOT A PASS. Both sides must be PRESENT before they are compared; an
        // `undefined === undefined` tick reads exactly like a verified row and is how this check failed first time.
        const haveBoth = existing.venueInstrumentId != null && c.instrumentId != null;
        const idOk = haveBoth && String(c.instrumentId) === String(existing.venueInstrumentId);
        console.log(`    ★ ID CHECK     : ${!haveBoth
          ? `*** VOID — one side is missing (returned=${c.instrumentId}, stored=${existing.venueInstrumentId}). An undefined === undefined pass is NOT a pass. ***`
          : (idOk
            ? 'returned id == stored id'
            : `*** RETURNED ${c.instrumentId} BUT THE ROW STORES ${existing.venueInstrumentId} — THE ROW POINTS AT A DIFFERENT INSTRUMENT ***`)}`);
      }
    } else {
      console.log(`    ⚠ no contract in the probe result — nothing to compare. keys: ${out ? Object.keys(out).join(',') : 'none'}`);
    }
    if (!CHECK) console.log(`    registry: ${JSON.stringify(reg && (reg.stored || reg.error || reg)).slice(0, 300)}`);

    if (!CHECK) {
      const now = (await rows()).find((r) => r.symbol === s);
      if (!now) { console.log(`  ⚠ ${s}: STILL NOT REGISTERED — the capture did not produce a spot row.`); continue; }
      console.log(`  ✔ registered: ${now.symbol} | ${now.instrumentClass} | ${now.leverageRaw} | initial ${now.initialMarginPct} | maintenance ${now.maintenanceMarginPct}`);
      if (now.initialMarginPct == null && now.leverageRaw == null) {
        console.log(`  ⚠ ${s}: the row exists but the DENOMINATOR is still unreadable — the margin guard will keep refusing.`);
      }
    }
  }

  // Park the shared tab back where the positions mirror expects it. `/instruments/probe` navigates; a probe that
  // leaves the tab on an instrument page silently disables the mirror.
  await call('POST', '/api/trading/orders/book-probe', token, {}).catch(() => {});
  const after = await rows();
  console.log(`\nspot rows AFTER: ${after.length}`);
  console.log(after.map((r) => `  ${String(r.symbol).padEnd(18)} ${String(r.instrumentClass).padEnd(7)} ${String(r.leverageRaw).padEnd(8)} initial ${r.initialMarginPct}  maint ${r.maintenanceMarginPct}`).join('\n'));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
