// trading/scripts/self-health-contracts.js — run the field contracts standalone.
//
// The same contracts are folded into the periodic self_health check; this runner exists so a
// human can see them on demand, and so they can be run without the trading service (they only
// need SQL).
//
// Usage:
//   node trading/scripts/self-health-contracts.js            # just the field contracts
//   node trading/scripts/self-health-contracts.js --full     # the WHOLE self-health run
//                                                            # (persist:false, so it writes
//                                                            #  nothing and alerts nobody)
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { runAll } = require('../agent/fieldContracts');

const argv = process.argv.slice(2);
const ui = argv.indexOf('--user');
const userId = ui >= 0 ? Number(argv[ui + 1]) || 1 : 1;

(async () => {
  if (argv.includes('--full')) {
    // Exercises the real integration, not just the contracts module.
    //
    // WARNING, learned the hard way on 2026-09-13: several self-health checks read IN-PROCESS
    // state (the waker's `running` flag, the bridge probe, the budget counter, the provider
    // snapshot). Run from this script they report the state of THIS SHORT-LIVED SCRIPT, not the
    // desk — the first run of this flag printed a red "[bad] Wake loop: loop NOT running" while
    // the service's waker was demonstrably ticking. Those ids are marked below so the output
    // cannot be mistaken for the desk's own verdict.
    const IN_PROCESS_ONLY = new Set(['waker', 'bridge', 'budget', 'providers', 'ticks']);
    const store = require('../store');
    const settings = await store.getSettings(userId);
    const snap = await require('../agent/selfHealth').run(userId, settings, { force: true, persist: false });
    if (snap && snap.skipped) { console.log(`skipped: ${snap.skipped}`); process.exit(0); }
    console.log('NOTE: run OUT-OF-PROCESS. Rows marked "in-process" report THIS script, not the');
    console.log('desk, and are NOT evidence about the desk. The DB-derived rows are real.\n');
    console.log(`self_health: ${snap.status} (${snap.bad} bad / ${snap.warn} warn) at ${snap.at}\n`);
    for (const c of snap.checks) {
      const artifact = IN_PROCESS_ONLY.has(c.id) ? '  <-- in-process: NOT the desk' : '';
      console.log(`  [${String(c.status).padEnd(4)}] ${c.label}${artifact}`);
      console.log(`           ${c.detail}`);
    }
    process.exit(snap.bad ? 2 : snap.warn ? 1 : 0);
  }

  const res = await runAll(userId);
  const icon = { ok: 'ok  ', warn: 'WARN', bad: 'BAD ' };
  console.log(`field contracts (user ${userId}) — a value must match its label\n`);
  for (const c of res.checks) {
    console.log(`  [${icon[c.status] || c.status}] ${c.label}`);
    console.log(`           ${c.detail}`);
  }
  console.log(`\n${res.bad} bad · ${res.warn} warn · ${res.unchecked} not checked (no fresh artifact — see detail)`);
  process.exit(res.bad ? 2 : res.warn ? 1 : 0);
})().catch((e) => {
  console.error(`failed: ${String(e.stack || e.message || e)}`);
  process.exit(3);
});
