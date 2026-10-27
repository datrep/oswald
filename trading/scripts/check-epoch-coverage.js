// trading/scripts/check-epoch-coverage.js — ★★ THE GUARD `epoch.js` CLAIMS TO HAVE AND DOES NOT.
//
// Run: node trading/scripts/check-epoch-coverage.js [--json]
//
// It answers ONE question: **is there evidence of a behaviour change the registry does not cover?** Three evidence
// sources, because no two of them are sufficient:
//   · `settings_write` rows on a POLICY key  — definite, precisely dated, and a BOUNDARY if unregistered;
//   · `trading/**` file mtimes               — a proxy, and the only signal that catches a CODE-ONLY boundary
//     such as EXE-19 (2026-10-02), which shipped with no task row and no settings write;
//   · `sql/migrations/**` file mtimes       — added 2026-10-26. Migrations live OUTSIDE trading/ and are applied by
//     the OWNER in SSMS, so neither of the first two can see one. Measured that day: 052 and 053 were applied
//     across a declared freeze boundary and this script reported a clean window.
//     ⚠ ADVISORY, AND FOR A REASON THAT MUST NOT BE FORGOTTEN: an mtime is when the file was WRITTEN, not when the
//     DDL was APPLIED. It cannot be asserted as a boundary — only named so it cannot pass silently.
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
// ⚠⚠ DOT-DIRECTORIES ARE SKIPPED AS A CLASS, NOT ONE AT A TIME. Measured 2026-10-27: the set named
// `.chrome-profile` and the audit then reported `trading/.librewolf-profile/prefs.js` as a freeze breach — browser
// churn from a second profile, not a change of behaviour. That is the permanently-red situation this file already
// argues against for `kill.initialEquity`: a guard that fires on every browser launch is a guard nobody keeps, and
// the next reader learns to ignore the whole section. `test/architecture-conformance.test.js` already walks with
// `e.name.startsWith('.')` for the same reason, so this now matches that convention instead of naming an instance.
function codeChanges() {
  const out = [];
  const skip = new Set(['archive', 'node_modules', 'public']);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push({ file: path.relative(ROOT, p), at: fs.statSync(p).mtime });
    }
  };
  walk(ROOT);
  return out;
}

// `sql/migrations/**` — the schema substrate. Scanned non-recursively for `.sql`, which is the whole shape of that
// directory by convention. A missing directory is NOT an error: it returns nothing, and the audit then says nothing
// about schema rather than claiming there was none.
function schemaChanges() {
  const out = [];
  const repo = path.join(ROOT, '..');
  const dir = path.join(repo, 'sql', 'migrations');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.sql')) continue;
    const p = path.join(dir, e.name);
    out.push({ file: path.relative(repo, p), at: fs.statSync(p).mtime });
  }
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
    schemaChanges: schemaChanges(),
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
