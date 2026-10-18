// Apply migration 044 and label the existing close times (TRD-118).
//
// ★ NO BACKFILL INSIDE THE MIGRATION, following 041's rule: a schema change must not silently reinterpret
// history. The labelling happens here, explicitly, and it CROSS-CHECKS its own inference against the
// timestamp shape it was derived from — so a row that contradicts the classification is reported, not written.
const fs = require('fs');
const path = require('path');
const { getPool, sql } = require('../shared/db');
const { CLOSE_AT_SOURCE, minuteRounded, sourceForVenueClose } = require('../trading/agent/closeTime');

const MIGRATION = path.join(__dirname, '..', 'sql', 'migrations', '044_trade_close_at_source.sql');

// Classify from the NOTE text, which is provenance the row already carries.
function sourceFromNote(note) {
  const n = String(note || '');
  if (n.startsWith('executor close')) return CLOSE_AT_SOURCE.deskObserved;
  const m = /^venue closed\s*—\s*(.*)$/.exec(n);
  if (m) return sourceForVenueClose(m[1]);
  return null; // unknown -> leave NULL, never guess
}

(async () => {
  const APPLY = process.argv.includes('--yes');
  const pool = await getPool();

  // ---- 1. the migration ----
  const sqlText = fs.readFileSync(MIGRATION, 'utf8');
  const batches = sqlText.split(/^\s*GO\s*$/gim).map((b) => b.trim()).filter(Boolean);
  console.log(`migration 044: ${batches.length} batch(es)`);
  for (const b of batches) console.log('  -> ' + b.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--')).join(' '));

  if (APPLY) {
    for (const b of batches) await pool.request().query(b);
    const col = await pool.request().query(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Trades' AND COLUMN_NAME='closeAtSource'`);
    console.log('  applied. column now:', JSON.stringify(col.recordset));
  }

  // ---- 2. the labelling ----
  const hasCol = (await pool.request().query(
    "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Trades' AND COLUMN_NAME='closeAtSource'"
  )).recordset[0].n > 0;
  console.log(`\ncolumn closeAtSource exists: ${hasCol}${hasCol ? '' : ' (dry run — already-labelled rows cannot be detected yet)'}`);
  const sel = hasCol
    ? 'id, symbol, note, closeAt, closePriceSource, closeAtSource, status'
    : 'id, symbol, note, closeAt, closePriceSource, status';
  const rows = (await pool.request().query(`
    SELECT ${sel} FROM Trades WHERE userId = 1 AND status = 'closed' ORDER BY id
  `)).recordset;

  const plan = [];
  const contradictions = [];
  for (const r of rows) {
    if (r.closeAtSource != null) continue;
    const want = sourceFromNote(r.note);
    if (!want) continue;
    const rounded = minuteRounded(r.closeAt);
    // The cross-check: a "minute-resolution venue display" claim must BE minute-rounded, and an "observed"
    // claim must not be. A row that disagrees means the inference is wrong for that class.
    const expectRounded = want !== CLOSE_AT_SOURCE.deskObserved;
    if (rounded !== expectRounded) contradictions.push({ id: r.id, note: r.note, want, closeAt: r.closeAt.toISOString(), rounded });
    plan.push({ id: r.id, want });
  }

  const byWant = plan.reduce((m, p) => (m[p.want] = (m[p.want] || 0) + 1, m), {});
  console.log(`\nlabelling plan: ${plan.length} rows of ${rows.length} closed`);
  for (const [k, v] of Object.entries(byWant)) console.log(`  ${String(v).padStart(3)}  ${k}`);
  const unlabelled = rows.filter((r) => r.closeAtSource == null && !sourceFromNote(r.note)).length;
  console.log(`  ${String(unlabelled).padStart(3)}  (left NULL — no note to infer from; NULL means UNKNOWN)`);

  console.log(`\n★ CROSS-CHECK against the timestamp shape: ${contradictions.length} contradiction(s)`);
  for (const c of contradictions.slice(0, 10)) console.log(`  id ${c.id} want=${c.want} rounded=${c.rounded} ${c.closeAt} "${String(c.note).slice(0, 40)}"`);

  if (!APPLY) { console.log('\nDRY RUN — pass --yes to apply.'); process.exit(0); }

  for (const p of plan) {
    await pool.request().input('id', sql.Int, p.id).input('src', sql.NVarChar(24), p.want)
      .query('UPDATE Trades SET closeAtSource = @src WHERE id = @id');
  }
  const after = await pool.request().query(`
    SELECT ISNULL(closeAtSource,'(null)') AS src, COUNT(*) AS n,
           SUM(CASE WHEN DATEPART(second, closeAt)=0 AND DATEPART(millisecond, closeAt)=0 THEN 1 ELSE 0 END) AS onMinute
    FROM Trades WHERE userId=1 AND status='closed' GROUP BY closeAtSource ORDER BY n DESC
  `);
  console.log('\n=== after ===');
  for (const x of after.recordset) console.log(`  ${String(x.n).padStart(3)}  onMinute ${String(x.onMinute).padStart(3)}  ${x.src}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
