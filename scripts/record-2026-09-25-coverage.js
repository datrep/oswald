// scripts/record-2026-09-25-coverage.js — record the coverage work and the LLM-accounting finding.
//
//   node scripts/record-2026-09-25-coverage.js         # dry run
//   node scripts/record-2026-09-25-coverage.js --yes   # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
// ⚠ LIKE-safe marker: `[...]` is a CHARACTER CLASS in T-SQL LIKE and matched 192 rows in an earlier script here.
const MARK = '##2026-09-25 coverage##';
const MARK2 = '##2026-09-25 llm-accounting##';

const ROWS = [
  {
    mark: MARK,
    name: 'TRD-COV-1: Strategy coverage — four per-symbol wrappers, and the real blocker was six EXPLICITLY EMPTY scope lists',
    info: `
${MARK}
★ ASKED: "manually add Silver, Sugar, Bitcoin and SGX strategies … i want more strategies pushed to be able to
send positions … none of them are being filled to be accepted into being ran on strategy."

★★ THE COMPLAINT WAS RIGHT AND THE DIAGNOSIS WAS NOT A MISSING STRATEGY. The live scope held:
    strategies.enabled : ["survgold","survoil"]
    symbolScope        : {Bitcoin:[], Gold:["survgold"], Oil:["survoil"], "Arabica Coffee":[],
                          Silver:[], Sugar:[], SGX:[], others:[]}
An EXPLICIT empty list beats both the \`others\` default AND \`strategies.enabled\` under the scope rule, so NINE
of twelve watchlist symbols resolved to zero strategies and could not enter anything. And those keys were not
always empty: \`trading/docs/UI_FLOW_AUDIT_2026-09-17.md\` records the same panel on 2026-09-17 reading "can
enter: Bitcoin (rsi2), … Silver (meanrev), Sugar (meanrev)". Five symbols HAD strategies and were emptied in the
eight days since. So the first move was to measure the strategies that used to be there, not to assume nothing
fitted.

★ TWO READ-ONLY SCREENS (\`temp/survivor-params-screen.js\`, \`temp/existing-strategies-screen.js\`), yahoo 1h,
1-year window, \`refreshData:false\`, no Lab row, sweep persists nothing.
  · The two survivors' OWN AXES CROSSED (dc{5,20} x gate{0,20}) per symbol. CALIBRATION: on Gold the winner IS
    survgold (dc20/off, pf 1.5222) so the method reproduces a known-good basis; on Oil it does NOT — the netPnl
    winner is dc5/gate-OFF while the actual survivor survoil is dc5/gate-ON, which has the better pf (1.4274 vs
    1.3964) and HALF the drawdown. So the hunt did not select on netPnl, and \`sweep\`'s ordering is not the
    desk's selection basis.
      Silver  dc5/off  net 7292.59 pf 1.4497 n 223   |  Sugar  ALL FOUR LOSE (best dc20/on pf 0.8587)
      Bitcoin dc5/off  net 7748.13 pf 1.1752 n 389   |  SGX    ALL FOUR LOSE (best dc20/on pf 0.6809)
  · The LIBRARY measures better on profit factor for three of the four:
      Silver  -> regturtle pf 1.7711 (maxDD 9.0% vs the wrapper's 12.2%)
      Sugar   -> meanrev  pf 2.2027 — the ONLY profitable thing measured on Sugar, and it is the strategy that
                 was in scope for Sugar on 2026-09-17
      Bitcoin -> regturtle pf 1.3469 (drawdown 22.8% vs the wrapper's 51.7%)
      SGX     -> nothing positive; best of everything is regturtle pf 0.8116, still a loss
    rsi2 is catastrophic on all four (pf 0.499 / 1.738 / 0.316 / 0.071), consistent with
    STRATEGY_AMENDMENT_REPORT.md's finding that the mean-reversion family fails in high-n cells.

★ DELIVERED: \`trading/agent/strategies/survCoverage.js\` — four modules from one declared table, copied from the
survgold/survoil shape (TRACK-BOUND \`symbols:[one]\`, \`params:[]\` frozen, liveSignal spreads its own DEFAULTS).
The measured number lives in \`description\` (the field \`list()\` renders), not in a flag nothing reads.
  survsilver  Silver  dc5/off   7292.59 pf 1.4497   SCOPED
  survbitcoin Bitcoin dc5/off   7748.13 pf 1.1752   SCOPED
  survsugar   Sugar   dc20/on   -490.58 pf 0.8587   REGISTERED, NOT SCOPED
  survsgx     SGX     dc20/on  -1801.03 pf 0.6809   REGISTERED, NOT SCOPED
\`scripts/wire-2026-09-25-coverage-scope.js\` wrote: enabled += survsilver,survbitcoin; Silver -> ['survsilver'];
Bitcoin -> ['survbitcoin']; Gold/Oil untouched. VERIFIED LIVE after a restart: Bitcoin, Gold, Oil, Silver all
CAN ENTER (4 of 12, up from 2), and \`unreachableEnabled\` returns NONE.

★ THE TWO HELD BACK ARE HELD BACK ON THE MEASUREMENT, NOT ON TASTE. Every one of Sugar's and SGX's four cells
is a loss; switching on a strategy whose own basis is a loss would spend real money to learn what the screen
already said. \`SCOPE_READY\`/\`HELD_BACK\` are the single source, and \`test/coverage-wrappers.test.js\` makes the
rule an INVARIANT (\`scopeReady === measured.net > 0\`) so flipping it on a losing cell fails a test.

★ ADDING A STRATEGY FORCED A GATE DECISION, WHICH IS THE DESIGN WORKING. \`test/flat-scope.test.js\` went red
with "undeclared strategies: survsilver, survsugar, survbitcoin, survsgx" until all four were added to BOTH
\`quant.GATE_OWNERS.donchian\` and \`.adx\` — the same treatment \`survgoldstruct\` gets, because a turtle clone owns
the same gates as its control. Without it the Donchian/ADX reasons would have been STRIPPED from Silver and
Bitcoin, the two symbols this change exists to open, while the text about untouched instruments stayed tidy.

⚠ RESIDUALS. (1) Not a Lab qualification: measured on the CURRENT series in a 1-year window, not the frozen dev
window ending 2026-09-10, and on \`yahoo\` rather than the desk's own venue. (2) The 4-cell grid is a basis, not a
hunt. (3) The report recommends scoping the EXISTING library (regturtle/meanrev) for three of the four, measured
better on pf — NOT applied, because it changes what the desk trades on the owner's money.
(4) \`survsugar\`/\`survsgx\` are in neither \`enabled\` nor any scope list, which is the intended disabled state.
Report: \`trading/docs/symbol-coverage-four-strategies-2026-09-25.md\`.
`,
  },
  {
    mark: MARK2,
    name: 'TRD-LLM-1: LLM accounting — spend exists only in TOKENS, so "do the LLMs pay for themselves" has no answer in the ledger',
    info: `
${MARK2}
★ ASKED: "check if the LLMs offset the profit gain. it looks like its going to barely not touch the profit gain,
and then go back into a loss."

★★ THE CHART CANNOT BE SHOWING THAT, AND THE REASON IS STRUCTURAL. There is NO currency figure for LLM spend
anywhere in this codebase: \`agent/budget.js\` accounts in TOKENS per consumer against token caps, and
\`analytics.equityCurve\` is \`store.listEquity(...)\` — pure trading equity. No LLM cost is netted into any equity
series, so an "LLM spend eating equity" line is not a computed series; it is an inference from two separate
ledgers. This row is the first time the two have been put on one axis.

★ MEASURED (temp/equity-shape.js, temp/llm-vs-pnl.js).
  trading: demo equity 4002.51 (09-09 16:05) -> MIN 3929.63 (09-18) -> MAX 4147.16 (09-24 16:03) -> END 4115.72
           (09-25 04:12). Above the start in 788 of 1074 samples (73%). End is NOT the high — 31.44 below it.
  llm    : 7,115,691 tokens over 4,016 calls, 09-10 .. 09-25; chair 3.32M (47%), review 2.01M, shadow 1.01M,
           binding 0.54M, pulse 0.23M. Mean 444,731 tokens/day against a 1,470,000/day cap.

★★ THE DESK-OWNED ANSWER IS A RATE, NOT A PRICE, because the codebase holds no token price and inventing one is
the "a number does not mean what it says" defect this desk keeps paying for:
    break-even $/M tokens = 113.21 / (7,115,691 / 1e6) = $15.91 per million tokens
Above that rate LLM spend would cancel the WHOLE trading gain; below it, it cannot. At DeepSeek-class list
(≈$0.07/M hit, ≈$0.27/M miss, ≈$1.10/M output — an EXTERNAL rate, given only to size the answer) the recorded
split prices at ≈$3.8, i.e. ≈3.4% of the gain, about 30x below break-even. ⚠ That $3.8 is MY conversion, not a
desk fact; the desk owns the token counts and the $15.91/M rate.

★ AND THE CURVE IS NOT WHERE IT WAS READ AS BEING. "Barely not touching the profit gain, then back into a loss"
describes a curve at or below break-even; measured it is +113.21 ABOVE the start (+2.83%), having peaked at
+144.65 and given back 31.44 (0.76%).

★★ THE REAL FINDING IS THE OPPOSITE OF THE CHART'S IMPLICATION. The largest LLM consumer is the CHAIR (47% of
tokens), and the same session found a chair VETO on an Oil entry whose risk engine had ALREADY degraded it
(TRD-RSK-1). So token cost is not what holds the curve back — but the chair's VETOES are the binding constraint
on entries, at almost half the token bill. If LLM spend is to be judged at all, judge it against the ENTRIES IT
BLOCKS, not against the equity line.

⚠ RESIDUAL AND THE ACTUAL GAP: the desk cannot answer "do the LLMs pay for themselves" repeatedly, because the
rate is nowhere in settings and no cost series is recorded. Either a $/M rate belongs in \`settings.budget\` with
a recorded cost series beside the token ledger, or the question stays a per-report conversion like this one.
Not implemented here — it is a settings/schema decision, and the token half already works.
`,
  },
];

(async () => {
  const pool = await getPool();
  const maxSort = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  let sortOrder = Number(maxSort.recordset[0].m) + 1;

  const toCreate = [];
  for (const r of ROWS) {
    const dup = await pool.request().query(
      `SELECT id FROM Tasks WHERE info LIKE '%${r.mark}%' OR name LIKE '${r.name.split(':')[0]}:%'`);
    if (dup.recordset.length) { console.log(`[ALREADY RECORDED] ${r.name.split(':')[0]} -> #${dup.recordset[0].id}`); continue; }
    toCreate.push(r);
    console.log(`  create "${r.name.slice(0, 70)}..."  info ${r.info.length} chars  sortOrder ${sortOrder}`);
    sortOrder++;
  }
  if (!toCreate.length) { console.log('\nall rows already exist — no write.'); await pool.close(); return; }
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  const created = [];
  let order = Number(maxSort.recordset[0].m) + 1;
  for (const r of toCreate) {
    // ⚠ plannedStart is NOT NULL and must be UTC or the row renders "Inactive" for 8 hours.
    const ins = await pool.request()
      .input('name', r.name).input('info', r.info).input('plannedStart', new Date()).input('sortOrder', order++)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT inserted.id
              VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, GETUTCDATE())`);
    created.push({ id: ins.recordset[0].id, mark: r.mark });
    console.log(`created ${r.name.split(':')[0]} as #${ins.recordset[0].id}`);
  }

  const ids = created.map((c) => Number(c.id));
  const check = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE id IN (${ids.join(',')}) ORDER BY id`);
  console.log('\nverify:');
  for (const c of check.recordset) {
    const marked = created.find((x) => Number(x.id) === Number(c.id));
    const has = await pool.request().query(`SELECT CASE WHEN CAST(info AS nvarchar(max)) LIKE '%${marked.mark}%' THEN 1 ELSE 0 END AS h FROM Tasks WHERE id = ${c.id}`);
    console.log(`  #${c.id} state=${c.state} info=${c.info_len} marker=${has.recordset[0].h}`);
  }
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
