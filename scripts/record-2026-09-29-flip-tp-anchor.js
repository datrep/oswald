// scripts/record-2026-09-29-flip-tp-anchor.js
//
// Flip `risk.takeProfitAnchor` from 'declared' to 'placed' — the second of the two owner decisions.
//
// WHY THIS IS THE CORRECT SETTING, AND WHY IT IS SAFE TODAY. Under 'declared' the TARGET is anchored to the
// DECLARED stop distance while the CAP shortens the STOP only, so the payoff ratio becomes 1.425 x declared/capped
// — an OUTPUT of wherever the cap lands, not a parameter (TRD-TP-1 #1412). 'placed' anchors the target to the stop
// the venue actually got, so the payoff ratio IS the chosen multiple.
//
// ⚠ AND THE FLIP IS CURRENTLY A NO-OP, WHICH IS EXACTLY WHY IT SHOULD HAPPEN NOW RATHER THAN LATER. With
// `maxAdversePct` at 1.5% and declared stops of 0.31-1.50%, the cap does not bind, so declared == placed and the
// two anchors are the same geometry. The switch only becomes load-bearing the moment the cap is lowered — and
// setting it correctly BEFORE the cap is used is cheaper than discovering the coupling after.
//
// Uses `store.saveSettings`, the one chokepoint every writer shares, so the settings journal records the change.
//
// Dry by default:  node scripts/record-2026-09-29-flip-tp-anchor.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');

const YES = process.argv.includes('--yes');
const ROOT = path.join(__dirname, '..');
const USER = 1;
const FROM = 'declared';
const TO = 'placed';

const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return {}; } };
const iso = (d) => (d ? new Date(d).toISOString() : 'n/a');

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the setting, and the code that reads it ===');
  const before = J((await q(`SELECT settings FROM TradingSettings WHERE userId = ${USER}`))[0].settings);
  const cur = (before.risk || {}).takeProfitAnchor;
  console.log(`  risk.takeProfitAnchor = ${JSON.stringify(cur)}`);
  if (cur === TO) { console.log(`  already '${TO}' — nothing to do.`); await pool.close(); return; }
  if (cur !== FROM) await fail(`expected '${FROM}', found ${JSON.stringify(cur)} — the premise is wrong`);
  const src = fs.readFileSync(path.join(ROOT, 'trading/agent/exitLevels.js'), 'utf8');
  if (!/takeProfitAnchor === 'placed' \? 'placed' : 'declared'/.test(src))
    await fail('exitLevels does not resolve the anchor three-valued — flipping would not take effect');
  console.log('  \u2714 exitLevels resolves it, so the setting is live');

  console.log('\n=== 2. the flip is currently a NO-OP: the cap does not bind ===');
  const capped = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision'
      AND createdAt >= '2026-09-28T06:51:16.553Z' AND JSON_VALUE(payload,'$.stopCap.cappedBy') IS NOT NULL`))[0].n;
  const total = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision'
      AND createdAt >= '2026-09-28T06:51:16.553Z'`))[0].n;
  console.log(`  since the cap moved to 1.5%: ${capped} of ${total} decisions recorded a cap`);
  if (capped !== 0) await fail(`${capped} decisions since then DID record a cap — the flip would change live geometry, which needs its own evidence`);
  console.log('  \u2714 the cap never binds, so declared == placed and this changes nothing today');
  console.log('     (it becomes load-bearing only if maxAdversePct is lowered — which is the point of setting it now)');

  console.log('\n=== 3. what else the write touches ===');
  const patch = { risk: { takeProfitAnchor: TO } };
  console.log(`  patch: ${JSON.stringify(patch)}  (only this key; saveSettings deep-merges the rest)`);
  const riskKeys = Object.keys(before.risk || {});
  console.log(`  existing risk keys preserved: ${riskKeys.length}`);

  console.log('\n=== 4. the write ===');
  if (!YES) { console.log('\n  DRY RUN - not written. Pass --yes to apply.'); await pool.close(); return; }
  const jBefore = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='settings_write'
      AND CAST(payload AS nvarchar(max)) LIKE '%takeProfitAnchor%'`))[0].n;
  await store.saveSettings(USER, patch);
  const after = J((await q(`SELECT settings FROM TradingSettings WHERE userId = ${USER}`))[0].settings);
  const now = (after.risk || {}).takeProfitAnchor;
  console.log(`  risk.takeProfitAnchor: ${JSON.stringify(cur)} -> ${JSON.stringify(now)}`);
  if (now !== TO) await fail(`the write did not take: the stored value is ${JSON.stringify(now)}`);
  const jAfter = await q(`SELECT TOP 1 id, createdAt, payload FROM TradingEvents WHERE kind='settings_write'
      AND CAST(payload AS nvarchar(max)) LIKE '%takeProfitAnchor%' ORDER BY id DESC`);
  if (jAfter.length === 0 || jAfter[0].id == null) await fail('the journal recorded nothing for this write');
  const p = J(jAfter[0].payload);
  console.log(`  journal event #${jAfter[0].id} at ${iso(jAfter[0].createdAt)}: ${JSON.stringify(p.changes)}`);
  if (jBefore === 0) console.log('  \u2714 the write is journalled (this is the second attributable settings change on this desk)');

  console.log('\n=== 5. nothing else moved ===');
  const changed = riskKeys.filter((k) => JSON.stringify(before.risk[k]) !== JSON.stringify(after.risk[k]));
  console.log(`  risk keys changed by this write: ${changed.length ? changed.join(', ') : '(none besides the anchor)'}`);
  if (changed.length > 1 || (changed.length === 1 && changed[0] !== 'takeProfitAnchor'))
    await fail(`the write moved more than the anchor: ${changed.join(', ')}`);
  console.log('  \u2714 exactly one key changed');

  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
