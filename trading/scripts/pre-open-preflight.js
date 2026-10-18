// trading/scripts/pre-open-preflight.js — the runbook's §3 checklist, mechanised. READ-ONLY.
//
// Run at T-15min (Sun ~20:45 UTC / Mon ~04:45 SGT), BEFORE the venue opens at 21:00 UTC.
//   node trading/scripts/pre-open-preflight.js
//
// WHY THIS EXISTS. `docs/pre-open-runbook.md` §3 is a READ-ONLY pre-flight whose every line is "a fact to
// confirm", and the runbook itself records that the cost of skipping it is concrete: a `bad · Plus500 SIGNED
// OUT` bridge was found at 18:34Z on 2026-09-20 "with every other gate looking fine", the desk was down ~7h
// overnight on 09-19, and the T-2h reset lands at 03:00 SGT inside a window where the machine has twice been
// off. A checklist that lives only in prose is run from memory at 04:45 in the morning.
//
// ⚠ IT NEVER WRITES AND NEVER PAGES. It prints, and it exits non-zero if a REQUIRED line fails, so it can be
// used as a gate. Everything here is a read of state the desk already recorded.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { getPool } = require('../../shared/db');

const results = [];
const line = (name, ok, detail, required = true) => {
  results.push({ name, ok, detail, required });
  const mark = ok === true ? 'PASS' : ok === false ? (required ? 'FAIL' : 'WARN') : 'INFO';
  console.log(`  [${mark}] ${name.padEnd(34)} ${detail}`);
};

async function main() {
  const pool = await getPool();
  const now = (await pool.request().query('SELECT SYSUTCDATETIME() AS n')).recordset[0].n;
  const mins = (d) => (d ? ((now - new Date(d)) / 60000) : null);
  console.log(`\nPRE-OPEN PRE-FLIGHT — ${new Date(now).toISOString()} (${new Date(now).toUTCString().slice(0, 3)})`);
  console.log('Venue reopens Sun 21:00 UTC / Mon 05:00 SGT. Runbook §3.\n');

  // ---- 1. the desk is answering at all ---------------------------------------------------------
  console.log('1. SERVICE');
  let health = null;
  try {
    const http = require('http');
    health = await new Promise((res) => {
      const r = http.request({ hostname: '127.0.0.1', port: 8115, path: '/healthz', timeout: 6000 },
        (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res({ status: x.statusCode, body: d })); });
      r.on('error', (e) => res({ status: 0, body: e.message })); r.on('timeout', () => { r.destroy(); res({ status: 0, body: 'timeout' }); }); r.end();
    });
  } catch (e) { health = { status: 0, body: String(e.message) }; }
  line('healthz', health.status === 200 && /ok/i.test(health.body), `${health.status} ${String(health.body).slice(0, 60)}`);

  // The heartbeat proves the EVENT LOOP is turning — a bound port can still be a hung one.
  try {
    const fs = require('fs');
    const hbp = path.join(__dirname, '..', 'crash', 'heartbeat.json');
    const h = JSON.parse(fs.readFileSync(hbp, 'utf8'));
    const age = mins(h.at);
    line('heartbeat', age != null && age < 2.5, `${h.at} (${age == null ? '?' : age.toFixed(1)}m ago) rss ${h.rssMb}MB`);
  } catch (e) { line('heartbeat', null, `unreadable: ${e.message}`, false); }

  // ---- 2. ★ THE BRIDGE MUST BE SIGNED IN -------------------------------------------------------
  console.log('\n2. BRIDGE — the runbook\'s loudest line');
  // ⚠⚠ THE MARKET STATE HAS TO BE READ BEFORE THE TICK CHECK, AND MY FIRST VERSION DID NOT DO THIS.
  //
  // It required `plus500 tick is LIVE` (a tick < 10 min old) at EVERY run. **But the venue only ticks while
  // the market is OPEN**, and the runbook schedules this at T-15min — i.e. ~15 minutes BEFORE the open, with
  // the venue closed since Friday 21:00Z. So the check could not pass on a completely healthy desk, and it
  // would have reported NOT CLEAR TO OPEN for the wrong reason at 04:45 SGT. A gate that always fails is a
  // gate that gets ignored, which is worse than no gate.
  //
  // The correct split, and it is the same distinction the runbook draws elsewhere:
  //   market CLOSED -> the tick is NOT APPLICABLE. What must be true is that the bridge is READABLE at all.
  //   market OPEN   -> the tick is REQUIRED, and it is the only fact that proves capture is working.
  const wake = await pool.request().query(`
    SELECT TOP 1 createdAt, JSON_VALUE(payload, '$.skipped') AS skipped
    FROM TradingEvents WHERE kind = 'wake' ORDER BY createdAt DESC`);
  const marketClosed = wake.recordset.length ? wake.recordset[0].skipped === 'market_closed' : false;
  line('market state', true, marketClosed
    ? 'CLOSED (latest wake says market_closed) — the tick check below is NOT APPLICABLE yet'
    : 'OPEN (or unknown) — the tick check below IS required');

  const login = await pool.request().query(`
    SELECT TOP 1 createdAt FROM TradingEvents WHERE kind = 'watchdog_login_death' ORDER BY createdAt DESC`);
  const loginAge = login.recordset.length ? mins(login.recordset[0].createdAt) : null;
  line('no recent login-death', loginAge == null || loginAge > 30,
    loginAge == null ? 'none on record' : `last ${new Date(login.recordset[0].createdAt).toISOString()} (${loginAge.toFixed(1)}m ago)`);

  const feed = await pool.request().query(`
    SELECT TOP 1 capturedAt FROM PriceTicks WHERE venue = 'plus500' ORDER BY capturedAt DESC`);
  const feedAge = feed.recordset.length ? mins(feed.recordset[0].capturedAt) : null;
  // ★ THE DECISIVE ONE, AND IT IS ONLY DECISIVE WHILE THE MARKET IS OPEN. Only a bridge that has cleared the
  // demo guard can write a plus500 tick; while the market is closed there is nothing to write.
  if (marketClosed) {
    line('plus500 tick is LIVE', null, `n/a — market closed (last tick ${feedAge == null ? 'never' : feedAge.toFixed(0) + 'm ago'})`, false);
    // With the market shut, the observable proof that the bridge can READ is the ACCOUNT banner, which is
    // visible text on every page. `readAccount` parses it, so a RECENT account row is evidence the session is
    // readable even while nothing can be traded.
    const acc = await pool.request().query(`
      SELECT TOP 1 createdAt FROM TradingEvents WHERE kind = 'account' ORDER BY createdAt DESC`);
    const accAge = acc.recordset.length ? mins(acc.recordset[0].createdAt) : null;
    line('account read is LIVE', accAge != null && accAge < 10,
      accAge == null ? 'never' : `${new Date(acc.recordset[0].createdAt).toISOString()} (${accAge.toFixed(1)}m ago)`);
  } else {
    line('plus500 tick is LIVE', feedAge != null && feedAge < 10,
      feedAge == null ? 'never' : `${new Date(feed.recordset[0].capturedAt).toISOString()} (${feedAge.toFixed(1)}m ago)`);
  }

  // ⚠ THE DEMO GUARD, added after it cost two days (2026-09-27). `not_demo` is FAIL-CLOSED at four call sites
  // — tick capture, the order path, the discoverer and watchlist open — so a demo marker the desk cannot see
  // stops the desk trading entirely, while the ACCOUNT BANNER keeps rendering and makes it look like a dead
  // session. The marker lives in a COLLAPSED account menu, so it is invisible to `innerText`; the check that
  // matters is that no `not_demo` has fired recently.
  const nd = await pool.request().query(`
    SELECT TOP 1 createdAt FROM TradingEvents WHERE payload LIKE '%not_demo%' ORDER BY createdAt DESC`);
  const ndAge = nd.recordset.length ? mins(nd.recordset[0].createdAt) : null;
  line('no recent not_demo', ndAge == null || ndAge > 30,
    ndAge == null ? 'none on record' : `last ${new Date(nd.recordset[0].createdAt).toISOString()} (${ndAge.toFixed(1)}m ago)`);

  const prm = await pool.request().query(`
    SELECT TOP 6 createdAt, JSON_VALUE(payload, '$.mode') AS mode, JSON_VALUE(payload, '$.url') AS url,
           JSON_VALUE(payload, '$.rows') AS rows
    FROM TradingEvents WHERE payload LIKE '%position_read_mode%' ORDER BY createdAt DESC`);
  const live = prm.recordset[0];
  // ⚠ `rows_on_page` is the runbook's target, but it is UNREACHABLE when the book is genuinely empty — the
  // venue renders the "You have no open positions" empty state instead of a table. `flat_corroborated` is the
  // correct verdict for a flat book, so requiring `rows_on_page` unconditionally would fail a healthy desk
  // with nothing open. Both are accepted; a category page is not.
  line('position_read_mode', live && (live.mode === 'rows_on_page' || live.mode === 'flat_corroborated'),
    live ? `mode=${live.mode} url=${live.url} rows=${live.rows}` : 'no reading', false);
  if (live && live.mode !== 'rows_on_page' && live.mode !== 'flat_corroborated') {
    console.log(`       the runbook wants \`rows_on_page\` (rows parsed) or \`flat_corroborated\` for an empty book —`);
    console.log(`       a mode parked on a category page means the positions read is not happening at all`);
  }

  // ---- 3. ★ THE PHANTOM CHECK: a position open here and gone there --------------------------------
  console.log('\n3. THE BOOK');
  const open = await pool.request().query(`
    SELECT t.id, t.symbol, t.plus500PositionId, t.openPrice, t.status
    FROM Trades t WHERE t.status = 'open' ORDER BY t.id`);
  line('open positions', true, `${open.recordset.length} on the desk's own book`);
  for (const t of open.recordset) {
    console.log(`       #${t.id} ${t.symbol} venueId=${t.plus500PositionId || '(none)'} @${t.openPrice}`);
  }
  if (open.recordset.length && feedAge != null && feedAge > 30) {
    console.log('       ⚠ POSITIONS ARE OPEN AND THE BRIDGE IS BLIND — the mirror cannot confirm they still exist at');
    console.log('         the venue. A position open here and gone there is a PHANTOM and must be resolved first.');
  }

  // ---- 4. ★ THE RESET BASELINE, which is the only thing standing between the halt and a fallback ----
  console.log('\n4. RESET BASELINE (runbook: "the only thing between the halt and that fallback")');
  const ds = await pool.request().query(`
    SELECT TOP 1 createdAt, JSON_VALUE(payload, '$.equity') AS equity FROM TradingEvents
    WHERE kind = 'day_start' ORDER BY createdAt DESC`);
  const st = await pool.request().query('SELECT TOP 1 settings FROM TradingSettings WHERE userId = 1');
  const s = JSON.parse(st.recordset[0].settings);
  const killBase = s.risk && s.risk.initialEquity;
  line('day_start row', ds.recordset.length > 0,
    ds.recordset.length ? `${new Date(ds.recordset[0].createdAt).toISOString()} equity=${ds.recordset[0].equity}` : 'NONE on record');
  line('kill.initialEquity', Number(killBase) > 0, `${killBase}${Number(killBase) > 0 ? '' : '  ⚠ dailyHalt treats start<=0 as NOT HALTED'}`);
  const lastEq = await pool.request().query('SELECT TOP 1 equity, at FROM EquityTicks ORDER BY at DESC');
  if (lastEq.recordset.length) {
    line('latest equity', true, `${lastEq.recordset[0].equity} @ ${new Date(lastEq.recordset[0].at).toISOString()}`);
  }

  // ---- 5. the market's own verdict, so a closed market is not mistaken for a broken desk ----------
  console.log('\n5. MARKET');
  const w = await pool.request().query(`
    SELECT TOP 3 createdAt, JSON_VALUE(payload, '$.skipped') AS skipped, JSON_VALUE(payload, '$.detail') AS detail
    FROM TradingEvents WHERE kind = 'wake' ORDER BY createdAt DESC`);
  for (const x of w.recordset) {
    console.log(`       ${new Date(x.createdAt).toISOString().slice(11, 19)} skipped=${x.skipped || '-'} ${String(x.detail || '').slice(0, 80)}`);
  }

  // ---- verdict ------------------------------------------------------------------------------------
  const failed = results.filter((r) => r.required && r.ok === false);
  console.log(`\n${'='.repeat(78)}`);
  if (failed.length) {
    console.log(`NOT CLEAR TO OPEN — ${failed.length} required line(s) failed:`);
    for (const f of failed) console.log(`  · ${f.name}: ${f.detail}`);
    console.log('\nThe bridge sign-in is a HUMAN step (runbook §3, and INSTRUMENT_MIRROR.md: "Plus500 permits ONE');
    console.log('login"). Nothing on this desk can read positions or place an order while it is out.');
  } else {
    console.log('CLEAR TO OPEN — every required line passed. Record the balance, kill.initialEquity, the day-start');
    console.log('equity and the time; everything after the open is measured against those.');
  }
  console.log('='.repeat(78));
  await pool.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(2); });
