// trading/scripts/repro/set-reanchor-live.js — enable EXE-15's venue-price re-anchor. DRY RUN by default (--yes).
//
// WHY THIS IS ITS OWN SCRIPT. It is one key (`risk.reanchorToLive`), and the house rule is that a settings write
// PREDICTS its consequence before applying it and verifies EVERY OTHER KEY afterwards. A partial `risk` object
// passed to a general setter is how a value nobody asked about moves — and this desk has already been bitten by
// exactly that.
//
// ⚠ WHAT IT TURNS ON, STATED PLAINLY BECAUSE IT MOVES A MONEY-TOUCHING LEVEL. With this key true, an entry on a
// NON-FROZEN strategy re-reads the instrument's live price off the venue's own page just before submit and shifts
// the STOP and the TAKE-PROFIT by the difference between that price and the stale decision price. The DISTANCE is
// untouched — only its anchor moves — so the sized risk is preserved and the submitted geometry is the geometry the
// owner accepted.
//
// ⚠ IT IS GATED, AND THE GATE IS NOT A FORMALITY. `survgold`/`survoil` are a FROZEN forward-validation candidate
// (TRD-29) and moving their levels would void the track, so `frozenTrack.isFrozenStrategy` refuses them and this
// key cannot reach them. Live on 2026-10-01: the frozen pair is 54.6% of closed fills, so THIS KEYS APPLIES TO THE
// OTHER 45.4%. That is (a) — build gated, do not extend the freeze — and it is the owner's decision of record.
//
// ⚠ AND IT COSTS ONE NAVIGATION PER ENTRY. The venue price comes from the same navigation `placeSession` already
// performs, on the shared bridge tab. Measured 2026-10-01 with the tab free: 3 of 3 symbols returned a live price
// (Gold/Oil/Sugar), against 0 of 2 before TRD-EXE-18 fixed the discarded value.
//
// Usage: node trading/scripts/repro/set-reanchor-live.js [--yes] [--off]
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
const BASE = process.env.TRADING_API_BASE || 'https://172.22.160.3:8114';

const call = (method, path, token, body) => new Promise((resolve, reject) => {
  const u = new URL(BASE + path);
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
  const uv = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv.recordset[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
  const get = async () => JSON.parse((await call('GET', '/api/trading/settings', token)).body);

  const before = (await get()).risk || {};
  // ⚠⚠ `--off` MUST WRITE `false`, NOT `undefined`. The first version computed `WANT ? true : undefined`, which
  // JSON.stringify DROPS — so the PUT body was `{"risk":{}}`, nothing changed, and the read-back correctly refused.
  // The bug was in this script; the check that caught it is the one that stays. A setter that reports success
  // without writing is precisely the defect class this desk keeps finding, so the read-back is not optional.
  const want = WANT === true;
  console.log('=== set risk.reanchorToLive ===\n');
  console.log(`1. the change: risk.reanchorToLive ${before.reanchorToLive} -> ${WANT}`);
  console.log('   it shifts the STOP and TAKE-PROFIT anchor to the venue\'s live price at submit, on');
  console.log('   NON-FROZEN strategies only. The stop DISTANCE is unchanged, so the sized risk is preserved.');

  // ⚠ THE FROZEN GATE, STATED AS A PREDICTION BEFORE THE WRITE RATHER THAN DISCOVERED AFTER IT.
  const { isFrozenStrategy } = require('../../agent/frozenTrack');
  console.log(`\n2. the gate: survgold frozen=${isFrozenStrategy('survgold')}, survoil frozen=${isFrozenStrategy('survoil')},`
    + ` a replica frozen=${isFrozenStrategy('survasilver')}, turtle frozen=${isFrozenStrategy('turtle')}`);
  if (!isFrozenStrategy('survgold') || !isFrozenStrategy('survoil')) fail('the frozen pair is NOT being refused — stop, the gate is broken');
  if (isFrozenStrategy('survasilver')) fail('a REPLICA is being refused — the gate is keyed on something other than the freeze marker');

  // ⚠ EVERY OTHER RISK KEY, CAPTURED NOW SO THE VERIFICATION AFTER THE WRITE HAS SOMETHING TO COMPARE AGAINST.
  const snapshot = { ...before };
  const others = Object.keys(snapshot).filter((k) => k !== 'reanchorToLive');
  console.log(`\n3. the OTHER ${others.length} risk keys this must not touch: ${others.join(', ')}`);

  if (!YES) {
    console.log(`\n${WARN} DRY RUN — nothing written. Re-run with --yes to apply.`);
    return;
  }

  const r = await call('PUT', '/api/trading/settings', token, { risk: { reanchorToLive: want } });
  if (r.status !== 200) fail(`PUT returned ${r.status}: ${String(r.body).slice(0, 300)}`);

  const after = (await get()).risk || {};
  console.log(`\n4. read back: risk.reanchorToLive = ${after.reanchorToLive}`);
  if (after.reanchorToLive !== WANT) fail(`read-back disagrees with the write (wanted ${WANT}, got ${after.reanchorToLive})`);

  // ⚠ THE VERIFICATION THAT MATTERS. A write that lands the key it was aimed at and quietly moves another is the
  // failure this check exists for — the whole reason a one-key script exists instead of a general setter.
  const drift = others.filter((k) => JSON.stringify(after[k]) !== JSON.stringify(snapshot[k]));
  if (drift.length) fail(`${drift.length} untouched key(s) MOVED: ${drift.join(', ')}`);
  console.log(`${CHECK} all ${others.length} other risk keys unchanged`);

  // The keys that must be OFF for this to be a controlled test — printed, not assumed.
  console.log(`\n5. context: trailingStop.enabled=${after.trailingStop && after.trailingStop.enabled}`
    + `  entryDriftFactor=${after.entryDriftFactor}  kill.tier=${(await get()).kill && (await get()).kill.tier}`);
  console.log(`\n${CHECK} applied. The NEXT non-frozen entry is the verification point:`);
  console.log('   look for `entry_reanchored` with freshSource="venue_page" and a NON-ZERO shift.');
  console.log(`   ${WARN} freshSource="desk_tick" means it silently fell back — that is the field reporting a real degradation.`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
