// scripts/set-tp-offset.js — set the take-profit offset and VERIFY it on the live geometry.
//
// The value is derived from the owner's own evidence, not chosen: two live Gold lows (4,245.11 and 4,245.36)
// against a 4,244.24 target — 0.87 and 1.12 points short of a 28.05-point target, i.e. 3.1% and 4.0% of the
// target's own distance. 5% clears the deeper one with ~0.3 of margin. `test/tp-offset.test.js` is the
// acceptance criterion and it calibrates against the chart's own levels.
//
//   node scripts/set-tp-offset.js 5          # dry run
//   node scripts/set-tp-offset.js 5 --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');
const store = require('../trading/store');
const { entryLevels } = require('../trading/agent/exitLevels');

const YES = process.argv.includes('--yes');
const USER = 1;
const PCT = Number(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a))) || 5;
// The live trade, reconstructed from the chart (see test/tp-offset.test.js).
const TRADE = { direction: 'sell', price: 4272.29, atr14: 9.35, stopDistance: 18.7 };
const MISSES = [4245.11, 4245.36];

const show = (label, lv) => {
  const filled = MISSES.map((m) => (m <= lv.takeProfitPrice ? 'FILL' : 'miss'));
  console.log(`  ${label.padEnd(14)} target ${String(lv.takeProfitPrice).padStart(9)}  stop ${String(lv.stopPrice).padStart(9)}`
    + `  R:R ${String(lv.effectiveRR).padEnd(6)}  lows: ${MISSES.map((m, i) => `${m}=${filled[i]}`).join('  ')}`);
};

(async () => {
  const settings = await store.getSettings(USER);
  const capPct = Number((settings.risk || {}).maxAdversePct);
  console.log(`\nlive settings.risk.maxAdversePct = ${capPct}%   takeProfitOffsetPct = ${(settings.risk || {}).takeProfitOffsetPct}`);
  console.log('\n  the observed trade, under the LIVE cap:');
  show('offset 0 (now)', entryLevels({ ...TRADE, maxAdversePct: capPct }));
  show(`offset ${PCT}%`, entryLevels({ ...TRADE, maxAdversePct: capPct, takeProfitOffsetPct: PCT }));
  show('offset 0.2%', entryLevels({ ...TRADE, maxAdversePct: capPct, takeProfitOffsetPct: 0.2 }));

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await poolClose(); return; }

  await store.saveSettings(USER, { risk: { ...(settings.risk || {}), takeProfitOffsetPct: PCT } });
  // Read back FROM THE STORE, not from the object just written.
  const after = (await store.getSettings(USER)).risk || {};
  console.log(`\nread back takeProfitOffsetPct = ${after.takeProfitOffsetPct}  (expected ${PCT})`);

  // ★ VERIFY THE CHAIR-VISIBILITY CLAIM END-TO-END, not by reading the code. `risk.evaluate` is what builds the
  // `reasons` the chair's sizeNote is made from, so calling it is the only proof that the note actually appears.
  try {
    const risk = require('../trading/agent/risk');
    const v = await risk.evaluate(USER, await store.getSettings(USER), {
      symbol: 'Gold', direction: 'sell', type: 'entry', strategy: 'survgold', price: TRADE.price, atr14: TRADE.atr14, spread: 0.4,
    }, [], []);
    const note = (v.reasons || []).find((r) => /take-profit pulled in/.test(r));
    console.log(`\n  risk verdict: veto=${!!v.veto} size=${v.size}`);
    console.log(`  the note the CHAIR reads: ${note ? `FOUND — "${note}"` : '*** NOT FOUND — the chair would not see it ***'}`);
    for (const r of v.reasons || []) console.log(`    · ${r}`);
  } catch (e) {
    console.log(`\n  ⚠ could not run risk.evaluate to confirm the chair note: ${String(e.message || e).slice(0, 160)}`);
  }
  console.log('\n  Restart the service to load the setting.');
  await poolClose();

  function poolClose() { return getPool().then((p) => p.close()); }
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
