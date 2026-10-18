// trading/scripts/repro/set-tuner.js — enable the self-tuner, and prove its gate holds.
//
// The tuner (agent/tuner.js) applies BOUNDED strategy changes (max 3 per pass, >=1 strategy must
// stay enabled) and only runs when:
//
//     tuner.enabled  AND  (paper/sim desk is on  OR  learning.parityValidated)
//
// `parityValidated` is now DERIVED by the parity harness (2026-09-13) rather than hand-set, so
// that half of the gate is finally real. It is currently false, and the paper desk is off — which
// means enabling the tuner is SAFE TODAY: every run refuses with `parity_not_validated` before it
// reaches the model, so no change can be applied.
//
// This script therefore does two things: flips the switch, and PROBES the gate so the refusal is
// observed rather than assumed. A disabled controller proves nothing; a controller that reports
// *why* it did nothing is a controller you can trust.
//
// Usage:
//   node trading/scripts/repro/set-tuner.js on       # enable (gate still refuses today)
//   node trading/scripts/repro/set-tuner.js off
//   node trading/scripts/repro/set-tuner.js probe    # forced run, prints the skip reason (no writes)
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const WANT = String(process.argv[2] || '').toLowerCase();

const call = (method, path, token, body) => new Promise((resolve, reject) => {
  const u = new URL('https://172.22.160.3:8114' + path);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 120000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

async function token() {
  const pool = await getPool();
  const uv = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  return jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv.recordset[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
}

function gateState(s) {
  const tuner = s.tuner || {};
  const paper = !!(s.paper && s.paper.enabled);
  const validated = !!(s.learning && s.learning.parityValidated);
  return {
    enabled: tuner.enabled !== false,
    intervalHours: Number(tuner.intervalHours) || 24,
    maxChangesPerRun: Number(tuner.maxChangesPerRun) || 3,
    paper, validated,
    willAct: tuner.enabled !== false && (paper || validated),
  };
}

(async () => {
  if (!['on', 'off', 'probe'].includes(WANT)) {
    console.error('usage: node trading/scripts/repro/set-tuner.js <on|off|probe>');
    process.exit(2);
  }
  const tk = await token();

  if (WANT === 'probe') {
    // In-process, forced, so the gate is evaluated for real. Not via the API: the route forces a
    // live pass with no dry-run switch, and a probe must never be able to write.
    const store = require('../../store');
    const settings = await store.getSettings(1);
    const g = gateState(settings);
    console.log(`gate: tuner.enabled=${g.enabled} paper=${g.paper} parityValidated=${g.validated}  ->  willAct=${g.willAct}`);
    const res = await require('../../agent/tuner').run(1, settings, { force: true, dryRun: true });
    console.log(`forced dry run -> ${JSON.stringify(res).slice(0, 500)}`);
    if (res && res.skipped) {
      console.log(`\nREFUSED: ${res.skipped}${res.hint ? ` — ${res.hint}` : ''}`);
      console.log('This is the correct, safe outcome while neither the sim desk nor parity evidence is available.');
    } else if (res && res.changes) {
      console.log(`\nPROPOSED ${res.changes.length} change(s), NOT applied (dry run):`);
      for (const c of res.changes) console.log(`  - ${JSON.stringify(c)}`);
    }
    process.exit(0);
  }

  const VALUE = WANT === 'on';
  const before = JSON.parse((await call('GET', '/api/trading/settings', tk)).body);
  const g0 = gateState(before);
  console.log(`before: tuner.enabled=${g0.enabled}  willAct=${g0.willAct}`);

  const r = await call('PUT', '/api/trading/settings', tk, { tuner: { enabled: VALUE } });
  if (r.status !== 200) { console.error('HTTP', r.status, r.body.slice(0, 300)); process.exit(1); }
  const g1 = gateState(JSON.parse(r.body));
  console.log(`after:  tuner.enabled=${g1.enabled}  intervalHours=${g1.intervalHours}  maxChangesPerRun=${g1.maxChangesPerRun}`);
  console.log(`  paper/sim desk: ${g1.paper ? 'ON' : 'off'} · parityValidated: ${g1.validated}`);
  console.log(`  willAct now: ${g1.willAct}${g1.willAct ? '' : '  (every run will refuse with parity_not_validated — no change can be applied)'}`);
  console.log(`  rails: <=${g1.maxChangesPerRun} changes/pass · >=1 strategy stays enabled · HARD kill skips · throttled to ${g1.intervalHours}h · revertible from the Strategy tab`);
  console.log('\nProve the gate with: node trading/scripts/repro/set-tuner.js probe');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
