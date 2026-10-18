// trading/scripts/check-epoch-coverage.js — ★★ THE GUARD `epoch.js` CLAIMS TO HAVE AND DOES NOT.
//
// Run: node trading/scripts/check-epoch-coverage.js [--json]
//
// It answers ONE question: **is there evidence of a behaviour change the registry does not cover?** Two evidence
// sources, because neither is sufficient alone:
//   · `settings_write` rows on a POLICY key  — definite, precisely dated, and a BOUNDARY if unregistered;
//   · `trading/**` file mtimes               — a proxy, and the only signal that catches a CODE-ONLY boundary
//     such as EXE-19 (2026-10-02), which shipped with no task row and no settings write.
// ⚠ `Tasks.completedAt` is deliberately NOT a boundary signal: 218 trading rows share 2026-09-30 because the whole
// backlog was bulk-closed at once. It is reported as advisory, with that caveat attached to the number.
'use strict';
const fs = require('fs');
const path = require('path');
const { getPool } = require('../../shared/db');
const epoch = require('../agent/epoch');
const { unaccounted, summaryLine } = require('../agent/changeAudit');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

// Every .js under trading/, excluding the vendored browser profile and the archive — neither is desk behaviour.
function codeChanges() {
  const out = [];
  const skip = new Set(['.chrome-profile', 'archive', 'node_modules', 'public']);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push({ file: path.relative(ROOT, p), at: fs.statSync(p).mtime });
    }
  };
  walk(ROOT);
  return out;
}

(async () => {
  const pool = await getPool();
  const newest = epoch.FEATURES.reduce((m, f) => (f.landedAt > m ? f.landedAt : m), '');
  const boundary = epoch.POLICY_FREEZE && epoch.POLICY_FREEZE.at > newest ? epoch.POLICY_FREEZE.at : newest;

  // ⚠⚠ SCOPED TO THE DESK USER (userId = 1), ADDED 2026-10-02 07:58. Measured: the `npm test` smoke suite
  // exercises the kill/settings endpoints as ITS TEST USER (42) against this same DB, and its policy-key writes
  // (kill.tier off->soft->hard->off, a risk.entryDriftFactor fixture) lit a FROZEN window with freeze_breaches
  // the DESK never made. The freezes here are about the desk's settings; a harness's fixture rows are not desk
  // behaviour. The desk is always user 1 (store.getSettings callers, the routes, every wake).
  const settingsWrites = (await pool.request().query(`
    SELECT TOP 200 id, createdAt, CAST(payload AS nvarchar(max)) p FROM TradingEvents
     WHERE userId = 1 AND kind='settings_write' AND createdAt >= DATEADD(day,-14,GETDATE()) ORDER BY id DESC`)).recordset
    .map((r) => { try { return { id: r.id, at: r.createdAt, keys: (JSON.parse(r.p).changes || []).map((c) => c.key) }; } catch { return null; } })
    .filter(Boolean);

  const closedTasks = (await pool.request().query(`
    SELECT id, name, completedAt FROM Tasks
     WHERE edictId = 52 AND state = 3 AND completedAt >= DATEADD(day,-14,GETDATE())`)).recordset
    .map((r) => ({ id: r.id, name: r.name, at: r.completedAt }));

  const r = unaccounted({
    newestLandedAt: newest,
    settingsWrites,
    codeChanges: codeChanges(),
    closedTasks,
    freeze: epoch.POLICY_FREEZE || null,
  });

  if (JSON_OUT) { console.log(JSON.stringify({ newest, freeze: epoch.POLICY_FREEZE, result: r }, null, 2)); process.exit(r.ok ? 0 : 1); }

  console.log('=== EPOCH COVERAGE / POLICY FREEZE ===');
  console.log(`  newest registered boundary : ${newest}`);
  if (epoch.POLICY_FREEZE) console.log(`  POLICY FREEZE declared     : ${epoch.POLICY_FREEZE.at}`);
  console.log(`  audited against            : ${boundary}${epoch.POLICY_FREEZE && boundary === epoch.POLICY_FREEZE.at ? ' (the freeze)' : ' (the newest entry)'}`);
  console.log(`\n  ${summaryLine(r)}\n`);
  // ⚠ PENDING IS NOT A PASS AND MUST NOT BE RENDERED AS ONE. The first run of this script exited 0 over a freeze
  // window that had not opened, which reads as "everything is accounted for" while nothing had been looked at.
  if (r.pending) {
    console.log(`  ${r.why}`);
    console.log('  ⇒ this is NOT a clean bill of health: no change has been judged yet.');
    process.exit(0);
  }
  if (!r.findings.length) console.log('  nothing changed after the boundary that the registry does not cover.');
  for (const f of r.findings) {
    const mark = f.severity === 'freeze_breach' ? 'X' : f.severity === 'unregistered_boundary' ? 'X' : '!';
    console.log(`  ${mark} [${f.severity}] ${f.at}`);
    console.log(`      ${f.what}`);
    if (f.files) for (const x of f.files) console.log(`        · ${x}`);
    if (f.note) console.log(`      NOTE: ${f.note}`);
    console.log(`      ⇒ ${f.fix}`);
  }
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(2); });
