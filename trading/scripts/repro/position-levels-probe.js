// trading/scripts/repro/position-levels-probe.js — EXE-14 S1, READ-ONLY.
//
// Phase 1 (default)  : discovery — dump the per-row action elements. Clicks NOTHING.
// Phase 2 (--edit)   : click that row's Edit control, read the card, Escape. Writes NOTHING.
//
// ⚠ THE NAVIGATION AND THE CLICK HAPPEN INSIDE THE SERVICE (`/orders/position-levels-probe`), for the reason
// `book-probe` and `trail-curve-probe` both give: `pageLock` is IN-PROCESS mutual exclusion, so a script driving
// the shared tab itself could not coordinate with a ticket and would navigate it out from under one.
//
// Usage: node trading/scripts/repro/position-levels-probe.js [--edit] [--row N]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const BASE = process.env.TRADING_API_BASE || 'https://172.22.160.3:8114';
const argv = process.argv.slice(2);
const EDIT = argv.includes('--edit');
const ri = argv.indexOf('--row');
const ROW = ri >= 0 ? Number(argv[ri + 1]) || 0 : 0;

const call = (method, p, token, body) => new Promise((resolve, reject) => {
  const u = new URL(BASE + p);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 300000,
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

  console.log(`=== EXE-14 S1 — ${EDIT ? 'PHASE 2 (verify: one click, one read, one Escape)' : 'PHASE 1 (discovery: NOTHING is clicked)'} ===\n`);
  const r = await call('POST', '/api/trading/orders/position-levels-probe', token, { edit: EDIT, rowIndex: ROW });
  let out = null;
  try { out = JSON.parse(r.body); } catch { console.log('non-JSON response:', String(r.body).slice(0, 400)); return; }
  if (r.status !== 200) { console.log('HTTP', r.status, JSON.stringify(out).slice(0, 400)); return; }
  if (out.skipped) { console.log('skipped:', out.skipped, '—', out.hint); return; }

  console.log(`url before : ${out.urlBefore}`);
  console.log(`url now    : ${out.url}`);
  console.log(`error      : ${out.error}`);
  const d = out.discovery || {};
  console.log(`\n--- DISCOVERY ---`);
  console.log(`rows=${d.rowCount}  groups=${d.groupCount}  bodyHasEditWord=${d.bodyHasEditWord}`);
  console.log(`\nedit-ish testids on the page:\n  ${(d.editishTestids || []).join('\n  ') || '(none)'}`);
  console.log(`\nTradeSetLimits testids already present:\n  ${(d.setLimitsTestids || []).join('\n  ') || '(none — the card is not open, as expected at rest)'}`);
  if (d.firstRow) {
    console.log(`\nFIRST ROW ${d.firstRow.tid} — action-shaped descendants:`);
    for (const x of (d.firstRow.descendants || []).slice(0, 20)) {
      console.log(`  tag=${String(x.tag).padEnd(8)} tid=${String(x.tid).padEnd(48)} text="${x.text}"`);
    }
  }
  if (d.firstGroup) {
    console.log(`\nFIRST GROUP ${d.firstGroup.tid} — action-shaped descendants:`);
    for (const x of (d.firstGroup.descendants || []).slice(0, 20)) {
      console.log(`  tag=${String(x.tag).padEnd(8)} tid=${String(x.tid).padEnd(48)} text="${x.text}"`);
    }
  }

  if (EDIT) {
    console.log(`\n--- THE CLICK ---`);
    console.log(JSON.stringify(out.clicked));
    const c = out.card || {};
    console.log(`\n--- THE CARD (${c.nodeCount || 0} SetLimits-ish nodes) ---`);
    if (c.error) console.log('card read error:', c.error);
    for (const n of (c.nodes || [])) {
      console.log(`  tid=${String(n.tid).padEnd(46)} id=${String(n.id).padEnd(26)} val=${String(n.value).padEnd(12)} checked=${n.checked} text="${n.text || ''}"`);
    }
    console.log(`\nTHE DOCUMENTED TESTIDS, by name (this is the direct yes/no against the dump):`);
    for (const [k, v] of Object.entries(c.byKnownTid || {})) console.log(`  ${v ? 'PRESENT' : 'absent '}  ${k}`);
    console.log(`\nTHE LEVEL FIELDS:`);
    for (const [k, v] of Object.entries(c.stoppedAt || {})) console.log(`  ${k}: ${v ? JSON.stringify(v) : 'ABSENT'}`);
    if (c.anyDialog) console.log(`\ndialog: ${JSON.stringify(c.anyDialog).slice(0, 300)}`);
    // ★ EXE-14 S2: the question the filtered `nodes` dump could not answer — is there an APPLY control, and is it
    // inside the card or in a shared footer? If one exists and S2 never presses it, a read-back that shows the
    // typed value proves nothing about what the venue holds.
    const cc = c.commitControls || {};
    console.log(`\n--- COMMIT CONTROLS (how does this card get APPLIED?) ---`);
    console.log(`card container : ${cc.cardFound ? cc.cardId : 'NOT FOUND'}`);
    console.log(`buttons INSIDE the card: ${(cc.inCardButtons || []).length}`);
    for (const b of (cc.inCardButtons || [])) {
      console.log(`  tag=${String(b.tag).padEnd(14)} tid=${String(b.tid).padEnd(42)} id=${String(b.id).padEnd(20)} vis=${b.visible} dis=${b.disabled} text="${b.text}"`);
    }
    console.log(`apply-shaped controls ANYWHERE on the page: ${(cc.applyishAnywhere || []).length}`);
    for (const b of (cc.applyishAnywhere || [])) {
      console.log(`  ${b.insideCard ? 'IN-CARD' : 'OUTSIDE'} tag=${String(b.tag).padEnd(14)} tid=${String(b.tid).padEnd(42)} vis=${b.visible} dis=${b.disabled} text="${b.text}"`);
    }
    // The UNFILTERED inventory: the two lists above are filtered by text and by card membership, so an icon-only
    // commit (or a sibling of the card) could still hide. This one lists every button-shaped element on screen.
    console.log(`\nall button-shaped elements ON SCREEN (unfiltered): ${(cc.allVisibleButtons || []).length}`);
    for (const b of (cc.allVisibleButtons || [])) {
      console.log(`  ${b.insideCard ? 'IN-CARD' : 'OUTSIDE'} tag=${String(b.tag).padEnd(14)} tid=${String(b.tid).padEnd(42)} vis=${b.visible} dis=${b.disabled} text="${b.text}"`);
    }
    console.log(`\n#trade-button present: ${cc.tradeButtonPresent}${cc.tradeButtonText ? ` (text="${cc.tradeButtonText}")` : ''}`);
    if (cc.submitDetail) {
      console.log(`\nBuySell.SubmitButton — is it the card's commit, or a ticket submit?`);
      for (const a of cc.submitDetail.attrs) console.log(`    ${a}`);
      console.log(`  ancestry: ${cc.submitDetail.ancestry.join('  <  ')}`);
      console.log(`  html    : ${cc.submitDetail.html}`);
    }
  } else {
    console.log(`\n(next: re-run with --edit to click the Edit control and read the card)`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
