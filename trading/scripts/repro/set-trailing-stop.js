// trading/scripts/repro/set-trailing-stop.js — P5: switch the venue-native trailing stop ON, and PREDICT first.
//
// WHY THIS IS ITS OWN SCRIPT. It is one key (`risk.trailingStop.enabled`), and the house rule is that a settings
// write predicts its consequence before applying it and verifies every other key afterwards. Passing a partial
// `risk` object to a general setter is how a value nobody asked about moves.
//
// WHAT IT ACTUALLY TURNS ON, AND WHY THAT IS THE SAFE PART.
// `distanceMultiple: 1` places the trail exactly ON the stop's own level at any price, so it does not move the
// level the sizing was computed against — every `R` on this desk divides by that same stop distance. The venue
// stop stays the MANDATORY exit and the trail sits on it.
//
// ⚠ AND IT CANNOT BREAK AN ENTRY. Measured in `webtrader.js`: an unstateable count returns
// `{ placed: false, reason: 'unstateable_<why>' }` and NOTHING HAS BEEN WRITTEN, so the ticket is exactly as it was
// found. Four of the ten watchlisted instruments have no measured pip unit (Ethereum, Soybeans, Natural Gas, SGX),
// so for those the trail is skipped BY NAME and the entry proceeds untouched. The six measured instruments
// (Gold, Oil, Silver, Sugar, Arabica, Bitcoin) get a trail with a COMPUTED count — the old probe is gone, because
// the control commits only the first count it is given and probing would make the real count the second write.
//
// ⚠ IT IS INERT ON EXISTING POSITIONS: the executor reads the setting at PLACEMENT time, so this affects the
// NEXT entry and does not reach into anything already open.
//
// DRY RUN BY DEFAULT (pass --yes).
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const YES = process.argv.includes('--yes');
const OFF = process.argv.includes('--off');
const WANT = !OFF;
const WARN = '\u26A0';
const CHECK = '\u2714';

const call = (method, path, token, body) => new Promise((resolve, reject) => {
  const u = new URL('https://172.22.160.3:8114' + path);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 60000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});
const fail = (m) => { console.error(`\n${WARN} REFUSING: ${m}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const uv = await q('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
  const get = async () => JSON.parse((await call('GET', '/api/trading/settings', token)).body);

  const before = (await get()).risk || {};
  const t = before.trailingStop || {};
  console.log('=== set risk.trailingStop.enabled ===\n');
  console.log(`1. the change: trailingStop.enabled ${t.enabled} -> ${WANT}`);
  if (t.enabled === WANT) { console.log(`   already ${WANT}. Nothing to do.`); await pool.close(); return; }
  console.log(`   every other key is left alone: distanceMultiple ${t.distanceMultiple}, allowTighterThanStop ${t.allowTighterThanStop}, verifyTolerancePct ${t.verifyTolerancePct}`);

  console.log('\n2. what it means');
  console.log(`   distanceMultiple ${t.distanceMultiple} places the trail ON the stop's own level, so the level the`);
  console.log('   sizing was computed against does not move. The venue stop remains the mandatory exit.');
  console.log('   measured instruments get a trail with a COMPUTED count; the four unmeasured ones');
  console.log('   (Ethereum, Soybeans, Natural Gas, SGX) skip it by name and the entry proceeds untouched.');
  console.log('   INERT on existing positions - the executor reads this at placement time.');

  console.log('\n3. the guard');
  if (WANT && Number(t.distanceMultiple) < 1 && t.allowTighterThanStop !== true) {
    console.log(`   ${WARN} distanceMultiple < 1 with allowTighterThanStop false: a tighter trail REPLACES the stop`);
    console.log('   (the venue arbitrates between the two levels), and every R here divides by that stop distance.');
  } else {
    console.log(`   ${CHECK} distanceMultiple ${t.distanceMultiple} is not tighter than the stop - no stop replacement risk.`);
  }

  if (!YES) {
    console.log('\n4. DRY RUN — nothing written. Re-run with --yes to apply.');
    await pool.close();
    return;
  }

  console.log('\n4. applying...');
  const r = await call('PUT', '/api/trading/settings', token, { risk: { trailingStop: { ...t, enabled: WANT } } });
  if (r.status !== 200) fail(`PUT returned ${r.status}: ${String(r.body).slice(0, 300)}`);

  const after = (await get()).risk || {};
  console.log('\n5. verification');
  if ((after.trailingStop || {}).enabled !== WANT) fail(`re-read says enabled = ${(after.trailingStop || {}).enabled}, wanted ${WANT}`);
  console.log(`   ${CHECK} trailingStop.enabled = ${after.trailingStop.enabled}`);
  const others = Object.keys(before).filter((k) => k !== 'trailingStop');
  const moved = others.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (moved.length) fail(`unrelated risk keys moved: ${moved.join(', ')}`);
  console.log(`   ${CHECK} every other risk key held (${others.length} checked)`);
  const trailOthers = Object.keys(t).filter((k) => k !== 'enabled');
  const trailMoved = trailOthers.filter((k) => JSON.stringify(t[k]) !== JSON.stringify(after.trailingStop[k]));
  if (trailMoved.length) fail(`other trailingStop keys moved: ${trailMoved.join(', ')}`);
  console.log(`   ${CHECK} every other trailingStop key held (${trailOthers.length} checked)`);
  await pool.close();
})();
