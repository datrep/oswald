// trading/scripts/order-health.js — the honest order failure rate (TRD-42 / workstream E).
//
// The old headline was "41% of the last 17 attempts fail against a <10% criterion". Measured
// from the journal that turns out to be a per-ATTEMPT rate whose biggest component is CLOSES OF
// POSITIONS THAT NO LONGER EXIST — a reconciliation problem, not an execution one. This reports
// the split, so the number that gets compared to a target is the number that means something:
//
//   * failures by CLASS (never a catch-all — see connector/errorClass.js)
//   * failures by INTENT (open vs close)
//   * `ambiguous` counted separately, because an unknown submit outcome is a RISK metric, not a
//     reliability metric: it is the one class that can leave an unmanaged position
//   * per-ORDER, not per-attempt: a retry that succeeds is not a failure
//
// Usage: node trading/scripts/order-health.js [--user 1]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool } = require('../../shared/db');
const { classifyBridgeError } = require('../connector/errorClass');

const argv = process.argv.slice(2);
const ui = argv.indexOf('--user');
const userId = ui >= 0 ? Number(argv[ui + 1]) || 1 : 1;

(async () => {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', require('mssql') ? undefined : undefined)
    .query(`SELECT id, kind, CONVERT(varchar(19), createdAt, 126) AS at, payload
              FROM TradingEvents
             WHERE userId = ${Number(userId)}
               AND kind IN ('order_attempt','order_rejected','phantom_fill')
             ORDER BY id ASC`);
  const rows = r.recordset.map((x) => ({ ...x, p: (() => { try { return JSON.parse(x.payload); } catch { return {}; } })() }));

  const attempts = rows.filter((x) => x.kind === 'order_attempt');
  const phantoms = rows.filter((x) => x.kind === 'phantom_fill');
  const byClass = new Map();
  const byIntent = new Map();
  let filled = 0, failed = 0, retriedThenOk = 0, attemptsTotal = 0, markers = 0;

  for (const ev of attempts) {
    const list = Array.isArray(ev.p.attempts) ? ev.p.attempts : [];
    attemptsTotal += list.length;
    const intent = (ev.p.order && ev.p.order.intent) || 'unlabelled(historical)';
    const ok = list.some((a) => a.ok === true);
    const last = list[list.length - 1] || {};
    if (ok) { filled += 1; if (list.length > 1) retriedThenOk += 1; } else { failed += 1; }
    // classify every failed attempt, re-deriving the class from its message so HISTORICAL rows
    // are re-classified too (they carry the old binary label and cannot be read as recorded)
    for (const a of list) {
      if (a.ok) continue;
      // retry MARKERS are not failures: `phase:'wait_bridge'` is pushed with ok:false and no error
      // (the old journal had no `marker` flag, so detect it structurally as well as by flag)
      if (a.marker === true || a.phase === 'wait_bridge') { markers += 1; continue; }
      const cls = a.errorClass && a.errorClass !== 'other'
        ? a.errorClass
        : classifyBridgeError(Object.assign(new Error(a.error || ''), { code: a.code }));
      byClass.set(cls, (byClass.get(cls) || 0) + 1);
      const key = `${intent} · ${cls}`;
      byIntent.set(key, (byIntent.get(key) || 0) + 1);
    }
  }

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
  console.log(`order health — user ${userId}, ${attempts.length} journalled order(s), ${attemptsTotal} attempt(s)\n`);
  console.log(`  filled  ${filled}`);
  console.log(`  failed  ${failed}   (${pct(failed, attempts.length)} of ORDERS)`);
  console.log(`  retried then succeeded: ${retriedThenOk}`);
  console.log(`  retry markers (wait_bridge, NOT failures): ${markers}`);
  const realFailures = [...byClass.values()].reduce((a, b) => a + b, 0);
  console.log(`  (of ${attemptsTotal} ATTEMPTS: ${realFailures} real failures, ${markers} markers, ${attemptsTotal - realFailures - markers} filled)`);
  if (attemptsTotal !== realFailures + markers + filled) console.log(`  NOTE: ${attemptsTotal - realFailures - markers - filled} attempt(s) unaccounted — inspect before trusting this`);
  console.log('');

  console.log('  failures by class:');
  const order = ['state_stale', 'dom_state', 'ambiguous', 'lifecycle', 'preflight', 'policy', 'other'];
  for (const c of order) {
    const n = byClass.get(c);
    if (!n) continue;
    const note = {
      state_stale: '  <- the desk tried to close something the venue no longer has. Reconciliation, NOT execution',
      ambiguous: '  <- OUTCOME UNKNOWN: needs reconciliation before anything else is trusted',
      dom_state: '  <- selector/DOM; pageLock exists for the set-limits case and it recurred',
      lifecycle: '  <- the only retryable class',
    }[c] || '';
    console.log(`    ${c.padEnd(12)} ${String(n).padStart(3)}${note}`);
  }
  if (!byClass.size) console.log('    (none)');

  console.log('\n  failures by intent × class:');
  for (const [k, n] of [...byIntent.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(34)} ${n}`);

  console.log(`\n  phantom_fill events (missing_on_venue): ${phantoms.length}`);
  console.log(`    corroborates state_stale: the desk believed it held positions the venue did not have.`);

  const ambiguous = byClass.get('ambiguous') || 0;
  const stale = byClass.get('state_stale') || 0;
  const actionable = failed - stale;
  console.log(`\nHEADLINE: of ${failed} failed orders, ${stale} were closes of positions that were already gone,`);
  console.log(`and ${ambiguous} left the outcome UNKNOWN. The execution-failure count is therefore ${actionable},`);
  console.log(`not ${failed} — and the unknown-outcome count is a risk item, not a reliability one.`);
  process.exit(0);
})().catch((e) => { console.error(`failed: ${String(e.stack || e.message || e)}`); process.exit(3); });
