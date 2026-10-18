// scripts/record-2026-09-28-tun2-half2.js — TRD-TUN-2's second half: the tuner no longer writes where the
// per-symbol layer shadows it. Verifies the wiring before appending.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ID = 1393;
const MARK = '##2026-09-28 tun2-second-half##';
const ROOT = path.join(__dirname, '..');

const NOTE = `

${MARK}
★ **SECOND HALF DONE: THE WRITE CAN NO LONGER BE MEANINGLESS.** The first half made the RESOLUTION single
(\`list()\` delegates to \`paramsFor\`, and every param carries its \`source\` layer). This half stops a caller that
WRITES the global layer from writing where the per-symbol layer shadows it.

WHAT LANDED
- **\`strategies/index.js\` gains two PURE helpers, exported:** \`scopedSymbols(settings, id, watchlistSymbols)\`
  (TRD-91's rule: an explicit \`symbolScope[symbol]\` entry REPLACES the global \`enabled\` list for that symbol)
  and \`paramDivergence(settings, id, symbols)\` (which of the strategy's params resolve differently across the
  symbols it can run on). ⚠ **The symbol universe is an ARGUMENT, not a require of \`scopeResolution\`** — that
  module lazily requires this one, so requiring it back would be a cycle; passing it in also keeps both
  functions pure and directly testable.
- **\`tuner.js\` EXCLUDES divergent strategies from the proposal set** (\`registryAll.filter(...)\`) rather than
  annotating them, and records the exclusion as \`shadowedStrategies\` on EVERY tune payload — so "the tuner
  considered it and could not act" is distinguishable from "the tuner never saw it".
- **⚠ WHY EXCLUDE RATHER THAN WARN, which is the row's option (b) over its option (c):** \`binding.js\` ALREADY
  warns for the inert case, and this row records that the warning did not stop the state from being creatable.
  Excluding removes the proposal from the prompt, so the LLM cannot ask for it at all. A warning beside a
  written value is not a control.
- **⚠ THE COST IS ZERO TODAY AND THAT IS NOT THE ARGUMENT.** Measured: the tuner has NEVER written anything —
  all 19 of its events are \`tune_skipped\`, gated on \`parity_not_validated\`. This forbids nothing it was doing;
  it removes a hazard from the day the gate opens.

TESTS: \`test/tuner-effective-layer.test.js\` — **12**, all passing. Behavioural for both helpers: the
replacement rule (including an EMPTY scope entry, which is still an explicit entry and therefore reaches
nothing), the fallback, defensiveness on missing settings, the <2-symbol case, a genuine divergence, identical
resolution NOT raising a false alarm, a frozen strategy being unable to diverge, and an unknown id not throwing.
★ The pin worth naming: **\`adxGate: 0\` must register as an override** — 0 IS the entire point of the Gold
override (the ADX filter OFF), and a truthiness test would walk past it and report no divergence, which is the
coercion bug class this desk keeps re-finding.
Structural for the wiring: it FILTERS rather than annotates, the exclusion travels on every payload, and the
helpers require nothing.

⚠ **STILL OPEN ON THIS ROW — THE OTHER CALLER.** \`routes.js:735\` (\`GET\` for the Strategy tab) still calls
\`strategies.list(settings)\` with NO symbol. It is a READ path, so it cannot write a shadowed value, and \`list()\`
now returns a per-param \`source\` — so the truthful data is already in the response and the remaining work is to
SURFACE it in the tab (a UI change). Until that is done the Strategy tab still displays the global value without
saying which layer supplied it, which is the display half of the defect the row was raised for.`;
(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  console.log('\n=== 1. the helpers exist, are exported, and are pure ===');
  const st = require('../trading/agent/strategies');
  if (typeof st.scopedSymbols !== 'function') await fail('scopedSymbols is not exported');
  if (typeof st.paramDivergence !== 'function') await fail('paramDivergence is not exported');
  console.log('  both exported');
  // exercise them against the LIVE shape so the record cannot claim more than the code does
  const live = { strategies: { enabled: ['survgold'], symbolScope: { Gold: ['survgold'], Oil: [] }, params: {}, symbolParams: { Gold: { turtle: { adxGate: 0 } } } } };
  console.log('  scopedSymbols(live, survgold, [Gold,Oil]) = ' + JSON.stringify(st.scopedSymbols(live, 'survgold', ['Gold', 'Oil'])));
  console.log('  paramDivergence(live, turtle, [Gold,Oil]) = ' + JSON.stringify(st.paramDivergence(live, 'turtle', ['Gold', 'Oil']).map((d) => d.key)));
  if (!st.paramDivergence(live, 'turtle', ['Gold', 'Oil']).some((d) => d.key === 'adxGate')) await fail('adxGate:0 is not registering as a divergence — the 0-is-a-value rule is broken');
  console.log('  \u2714 an override to 0 registers (0 is a value, not an absence)');

  console.log('\n=== 2. the tuner filters rather than annotates, and records it ===');
  const tuner = code('trading/agent/tuner.js');
  if (!/const registry = registryAll\.filter\(/.test(tuner)) await fail('the tuner does not FILTER the registry');
  if (!/strategies\.paramDivergence\(settings, s\.id, symbols\)/.test(tuner)) await fail('the tuner does not ask about divergence');
  const recorded = (tuner.match(/shadowedStrategies: shadowedStrategies\.length/g) || []).length;
  console.log('  shadowedStrategies recorded on ' + recorded + ' payload(s)');
  if (recorded < 2) await fail('the exclusion is not recorded on every payload');

  console.log('\n=== 3. the OTHER caller is still unfixed (stated, not claimed) ===');
  const routes = code('trading/routes.js');
  const listsWithoutSymbol = (routes.match(/strategies\.list\(settings\)/g) || []).length;
  console.log('  routes.js calls strategies.list(settings) with no symbol: ' + listsWithoutSymbol);
  console.log('  (a READ path — it cannot write a shadowed value; the remaining work is to surface `source` in the tab)');

  console.log('\n=== 4. and the tuner has still never written ===');
  const wrote = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind = 'tune'`))[0].n;
  const skipped = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind = 'tune_skipped'`))[0].n;
  console.log(`  tune events: ${wrote}   tune_skipped: ${skipped}`);
  if (wrote > 0) console.log('  ⚠ the tuner HAS written — re-word the "cost is zero today" claim');

  console.log('\n=== the row ===');
  const dup = await q(`SELECT id FROM Tasks WHERE id = ${ID} AND info LIKE '%${MARK}%'`);
  if (dup.length) { console.log(`  #${ID} marker present — nothing to do.`); await pool.close(); return; }
  const cur = (await q(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  #${ID} state=${cur.state} info=${cur.len} -> ${Number(cur.len) + NOTE.length}`);
  if (!YES) { console.log('  DRY RUN — not written.'); await pool.close(); return; }
  await pool.request().input('t', NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
