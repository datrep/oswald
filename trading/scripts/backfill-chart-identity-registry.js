// trading/scripts/backfill-chart-identity-registry.js — close GRD-4's registry COVERAGE gap.
//
// ★ THE BLOCKER THIS EXISTS FOR. `chartIdentityVerdict` judges the chart's instrument id against the desk's
// registry, and `capture_chart_identity` records `unregistered` when there is no `Instruments` row for that
// id. Measured 2026-09-25: 483 of 1,946 recorded observations (24.8%) were `unregistered`, and 6 of the 13
// distinct pairs had no registry row at all (China overseas 1304, Gasoline 3224, HKEx 1302, Sands China 3989,
// Sinopec 1301, ZTE 1484). Enforcement stays unauthorised while that holds, and it MUST: the check cannot run
// for those symbols, and a guard that is ABSENT for a symbol looks exactly like a guard that PASSED for it.
//
// ★ WHY THIS GOES THROUGH THE API AND NOT THROUGH THE DATABASE. A registry row is an id -> symbol mapping, and
// the ONLY mapping that may be trusted is the VENUE'S OWN. Writing the desk's symbol against the chart's id
// would make `mismatch` unable to fire for that pair — the guard would exist, run, and always pass, which is
// strictly worse than the missing row it replaced. So this script never writes a row: it asks the probe route
// to open each instrument and read the venue's sidebar, and `captureFromObservation` refuses any pairing whose
// sidebar does not match the selected row. It also has to go through the route for a second, mechanical
// reason: `pageLock` is IN-PROCESS state, so a script that drove the shared tab itself would take no lock and
// could land mid-ticket (routes.js:1054).
//
// MEASURED 2026-09-25 on the known gap (3989): the route navigated to /trade/hong-kong--s-z, read the selected
// row's `data-instrument-id="3989"`, read the contract sidebar, reported `sidebarMatchesSelectedRow: true`, and
// the registry went from NO ROW to `symbol=Sands China class=spot unitAmount=200`.
//
// USAGE
//   node trading/scripts/backfill-chart-identity-registry.js                 # dry run: report the gap
//   node trading/scripts/backfill-chart-identity-registry.js --yes           # probe every missing symbol
//   node trading/scripts/backfill-chart-identity-registry.js --yes --max=3   # bounded
//   node trading/scripts/backfill-chart-identity-registry.js --symbol=ZTE    # explicit, ignores discovery
//
// ⚠ THE DISCOVERY IS BEST-EFFORT AND SAYS SO. `capture.js` caps `samples` at 8 per sweep and records only
// NON-match verdicts, so an id whose every sample fell outside a cap is not named here. That is why
// `--symbol=` exists, and why the report prints the recorded `unregistered` COUNT beside the ids it can name:
// if the count exceeds the named set, the set is incomplete and it says so rather than looking complete.
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../shared/db');
const instruments = require('../store/instruments');

const USER = 1;
const API = 'https://172.22.160.3:8114';
const argv = process.argv.slice(2);
const YES = argv.includes('--yes');
const MAX = Number((argv.find((a) => a.startsWith('--max=')) || '').split('=')[1]) || 12;
const explicit = argv.filter((a) => a.startsWith('--symbol=')).map((a) => a.slice('--symbol='.length)).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, p, token, body) => new Promise((resolve, reject) => {
  const u = new URL(API + p);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 300000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

// Every chart instrument id the capture has ever reported, with the desk symbol the capture was asking for.
// `registry == null` on a sample is what `unregistered` means: the lookup found nothing.
async function discoverRecordedPairs(pool) {
  const r = await pool.request().query(
    `SELECT id, payload FROM TradingEvents
      WHERE userId = ${Number(USER)} AND payload LIKE '%capture_chart_identity%' ORDER BY id`);
  const pairs = new Map(); // chartId -> { symbol, chartSymbol, registry }
  let unregisteredCount = 0;
  let events = 0;
  for (const row of r.recordset) {
    let p;
    try { p = JSON.parse(row.payload); } catch { continue; }
    if (p.source !== 'capture_chart_identity') continue;
    events++;
    unregisteredCount += Number(p.unregistered) || 0;
    for (const s of p.samples || []) {
      if (!s || s.chartId == null) continue;
      const id = String(s.chartId);
      const prev = pairs.get(id);
      // A later sample that DID resolve the registry wins: coverage is a current fact, not a historical one.
      if (!prev || (prev.registry == null && s.registry != null)) {
        pairs.set(id, { symbol: s.symbol, chartSymbol: s.chartSymbol, registry: s.registry == null ? null : s.registry });
      }
    }
  }
  return { pairs, unregisteredCount, events };
}

(async () => {
  const pool = await getPool();
  const uv = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv.recordset[0] ? uv.recordset[0].tokenVersion : 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );

  const { pairs, unregisteredCount, events } = await discoverRecordedPairs(pool);
  console.log(`\nchart-identity registry coverage — ${pairs.size} distinct pair(s) recorded over ${events} sweep(s)`);
  console.log(`recorded 'unregistered' OBSERVATIONS: ${unregisteredCount} (counted, not sampled)\n`);

  // Live coverage, not recorded coverage: a row may have been added since the sample was taken.
  const rows = [];
  for (const [id, info] of pairs) {
    const live = await instruments.getInstrumentById(USER, { venue: 'plus500', venueInstrumentId: id }).catch(() => null);
    rows.push({ id, deskSymbol: info.symbol, chartSymbol: info.chartSymbol, recorded: info.registry, live: live ? live.symbol : null });
  }
  rows.sort((a, b) => String(a.deskSymbol).localeCompare(String(b.deskSymbol)));

  console.log('  chartId  desk symbol        chart symbol    recorded     live registry');
  for (const r of rows) {
    console.log(`  ${String(r.id).padEnd(8)} ${String(r.deskSymbol).padEnd(17)} ${String(r.chartSymbol).padEnd(15)} `
      + `${String(r.recorded == null ? '(none)' : r.recorded).padEnd(12)} ${r.live == null ? '** MISSING **' : r.live}`);
  }

  let missing = rows.filter((r) => r.live == null);
  if (explicit.length) {
    missing = explicit.map((s) => ({ id: '(explicit)', deskSymbol: s, chartSymbol: null, recorded: null, live: null }));
  }

  console.log(`\n  covered: ${rows.length - rows.filter((r) => r.live == null).length} of ${rows.length} distinct pair(s)`);
  console.log(`  still missing: ${missing.length}${missing.length ? ' — ' + missing.map((m) => `${m.deskSymbol} (${m.id})`).join(', ') : ''}`);
  if (missing.length && unregisteredCount > 0 && missing.length < unregisteredCount) {
    console.log('  ⚠ the named set is INCOMPLETE by construction: `capture.js` caps `samples` at 8 per sweep, and');
    console.log('    an id whose every sample fell outside the cap is not nameable here. Pass --symbol=<name> for it.');
  }

  if (!missing.length) { console.log('\nnothing to backfill.'); process.exit(0); }
  if (!YES) {
    console.log(`\nDRY RUN — pass --yes to probe ${Math.min(missing.length, MAX)} symbol(s) through the API.`);
    console.log('The probe READS the venue\'s own id/name pairing; this script never writes a registry row itself.');
    process.exit(0);
  }

  const done = [];
  for (const m of missing.slice(0, MAX)) {
    try {
      const r = await call('POST', '/api/trading/instruments/probe', token, { symbol: m.deskSymbol, select: true });
      if (r.status !== 200) { done.push({ ...m, ok: false, why: `HTTP ${r.status}` }); continue; }
      const o = JSON.parse(r.body);
      if (o.skipped) { done.push({ ...m, ok: false, why: `skipped: ${o.skipped}` }); continue; }
      const stored = o.registry && Array.isArray(o.registry.stored) ? o.registry.stored : [];
      const refused = o.registry && Array.isArray(o.registry.refused) ? o.registry.refused : [];
      // ★★ THE RETURNED ID MUST BE THE ID WE ASKED ABOUT, AND THIS IS NOT DEFENSIVE PADDING — IT WAS MEASURED.
      // Asking for `Gasoline` (3224) on 2026-09-25 landed on a page still showing CHINA OVERSEAS, and the
      // route reported success because `sidebarMatchesSelectedRow` was true: that self-check proves the
      // sidebar describes the selected ROW, not that the row is the instrument REQUESTED. Taking `stored[0]`
      // therefore re-registered 1304 and reported Gasoline as covered while 3224 stayed missing — a backfill
      // that reports success while the gap survives is worse than no backfill, because it retires the task.
      const explicitLookup = String(m.id) === '(explicit)';
      const row = explicitLookup ? (stored[0] || null) : (stored.find((s) => String(s.instrumentId) === String(m.id)) || null);
      const other = stored[0] || null;
      done.push({
        ...m,
        ok: !!(row && row.symbol),
        why: row
          ? null
          : (other
            ? `the venue returned id ${other.instrumentId} (${other.symbol}), NOT ${m.id} — the navigation never reached ${m.deskSymbol}`
            : (refused.length ? 'refused by the sidebar/row pairing guard' : 'no registry candidate in the observation')),
        got: row ? `${row.instrumentId} -> ${row.symbol}` : null,
        // Both the ids the venue reported AND where it reported them from: a mismatch here is the only signal
        // that the probe read a stale page, so it is printed rather than inferred.
        venueIds: stored.map((s) => s.instrumentId),
        landedOn: o.url || null,
      });
    } catch (e) {
      done.push({ ...m, ok: false, why: String((e && e.message) || e).slice(0, 120) });
    }
    await sleep(800 + Math.random() * 600);
  }

  console.log('\n  result:');
  for (const d of done) {
    console.log(`    ${d.ok ? '✓' : '✗'} ${String(d.deskSymbol).padEnd(18)} ${d.got || d.why}`);
    if (!d.ok && d.landedOn) console.log(`        landed on ${d.landedOn}`);
  }
  const gained = done.filter((d) => d.ok).length;
  console.log(`\n  ${gained} of ${done.length} probed symbol(s) stored a registry row.`);

  // Re-measure rather than assume: report the live coverage AFTER the run.
  let still = 0;
  for (const [id] of pairs) {
    const live = await instruments.getInstrumentById(USER, { venue: 'plus500', venueInstrumentId: id }).catch(() => null);
    if (!live) still++;
  }
  console.log(`  coverage now: ${pairs.size - still} of ${pairs.size} recorded pair(s) have a registry row.`);
  console.log('\n  Re-run trading/scripts/repro/chart-identity-check.js to see `unregistered` fall.');
  await pool.close();
  process.exit(0);
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
