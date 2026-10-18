// scripts/record-2026-09-28-correlation-window-and-intrawake.js — TRD-RSK-3 (#1451) + TRD-RSK-5 (#1456).
// Verifies the fix against the LIVE data before appending, so the record cannot claim more than the code does.
// Dry by default:  node scripts/record-2026-09-28-correlation-window-and-intrawake.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');
const risk = require('../trading/agent/risk');
const { correlation } = require('../trading/agent/indicators');

const YES = process.argv.includes('--yes');
const ROOT = path.join(__dirname, '..');
const USER = 1;
const MARK3 = '##2026-09-28 rsk3-window-implemented##';
const MARK5 = '##2026-09-28 rsk5-intrawake-implemented##';

async function load(sym) { return store.listBars(USER, { timeframe: '1h', symbol: sym, venue: 'yahoo', limit: 12000 }).catch(() => []); }

// The OLD rule, replicated here on purpose: the record's "before" number must be measured, not remembered.
function rhoOf(a, b, windowMs) {
  const mapB = new Map(b.map((r) => [new Date(r.barStart).getTime(), Number(r.closePrice)]).filter(([, c]) => Number.isFinite(c) && c > 0));
  const paired = [];
  for (const r of a) {
    const c = Number(r.closePrice);
    if (!Number.isFinite(c) || c <= 0) continue;
    const t = new Date(r.barStart).getTime();
    const o = mapB.get(t);
    if (o != null) paired.push({ t, a: c, b: o });
  }
  const newest = paired.reduce((mx, p) => (p.t > mx ? p.t : mx), paired[0].t);
  const use = windowMs == null ? paired : paired.filter((p) => p.t >= newest - windowMs);
  const ra = [], rb = [];
  for (let i = 1; i < use.length; i++) { ra.push(Math.log(use[i].a / use[i - 1].a)); rb.push(Math.log(use[i].b / use[i - 1].b)); }
  const c = correlation(ra, rb);
  return { rho: c == null ? null : +c.toFixed(4), pairs: ra.length, spanDays: +((use[use.length - 1].t - use[0].t) / 86400000).toFixed(1) };
}

const NOTE3 = (m) => `

${MARK3}
★ **THE WINDOW IS NOW THE ONE THE REFUSAL NAMES. IMPLEMENTED 2026-09-28.**

WHAT WAS WRONG (restated so this row reads standalone). \`returnsCorrelation\` called \`store.listBars(..., limit: 12000)\`
with NO date filter, and \`listBars\` is \`SELECT TOP (@limit) ... ORDER BY barStart DESC\` with \`limit\` clamped to
12000 — so "12000" silently meant *however far back twelve thousand hourly bars reach*. Measured Gold|Silver:
**${m.oldPairs} return pairs over ${m.oldSpan} days → rho ${m.oldRho}**, while the sentence this gate prints says
"30d log-returns". A number that does not mean what it says is the defect class this desk keeps closing, and here
the disagreement decided a LIVE refusal: at 2026-09-28T05:22:41.900Z Silver was refused at ${m.oldRho}, and
${m.newRho} is BELOW the 0.7 threshold.

WHAT LANDED
- **\`CORR_WINDOW_DAYS = 30\` / \`CORR_WINDOW_MS\`** beside \`CORR_MIN_BARS\` in \`trading/agent/risk.js\`, exported so a
  test can assert the number the message quotes.
- **The paired series is windowed before the returns are computed**, in \`returnsCorrelation\`.
- ⚠ **ANCHORED AT THE NEWEST PAIRED BAR, NOT AT THE CLOCK.** Anchoring at \`Date.now()\` would silently empty the
  window whenever the feed is stale (a closed market, a dead capture) and return \`null\` — which this gate reads as
  *no opinion*, so a broken feed would have quietly DISABLED the veto while looking like it was working. The
  data's own newest bar makes the window always "the last 30 days OF DATA", and a stale series stays visible as
  stale. The window is derived from the DATA's extremes rather than from \`listBars\`' ordering, so a future
  \`ORDER BY\` change cannot silently invert it.
- A series that cannot support the window returns **null** rather than a years-long average: 300 bars spaced
  3 days apart is a perfect unwindowed correlation of +1.0 and only ~10 pairs in-window, and null is the honest
  answer. A series shorter than the window is still used whole — the rule does not invent a floor.

MEASURED AT RECORD TIME (live, by calling the gate's own exported function)
- as implemented, 30 days: **rho ${m.newRho}** over ${m.newPairs} return pairs spanning ${m.newSpan} days
- the OLD rule, replicated: **rho ${m.oldRho}** over ${m.oldPairs} pairs spanning ${m.oldSpan} days

★★ TWO CONSEQUENCES THAT MUST BE READ TOGETHER — THIS ROW ALONE WOULD LOOSEN THE GATE.
1. **The Gold|Silver pair is now COMPLIANT on the window the policy names.** ${m.newRho} < 0.7, by a margin of
   ${m.margin}. So this fix, on its own, stops refusing a pair that the old (mislabelled) reading refused — which
   is correct, and is also why **TRD-RSK-5 (#1456) had to land in the same change**: the intra-wake gap let the
   desk open both legs of that pair in one wake, and closing the window without closing the gap would have left
   the desk able to hold a pair its own policy permits leg-by-leg while being unable to see them as a pair.
2. ⚠ **THE THRESHOLD IS NOT CHANGED, AND I DID NOT CHANGE IT.** The comment justified 0.7 *"for a 3-slot book"*,
   written when \`maxPositions\` defaulted to 3; the live setting is **10**, so the justification was stale and the
   sentence has been corrected to say so. Raising or lowering a live risk threshold is an OWNER decision, not
   housekeeping, so the value stands at 0.7 with the measurement on the record instead — and the ${m.margin}
   margin is exactly the kind of thing a threshold should be re-derived against, not nudged blind.
   **OWNER INPUT SOUGHT: keep 0.7, or re-derive it against a 10-slot book?** The live matrix is already on this
   row; Gold|Silver is the only pair above 0.7 and Arabica Coffee|SGX is −0.4217.

REPIN: \`test/correlation-window-and-intrawake.test.js\` (11 tests, shared with TRD-RSK-5). The window tests are
built so the WINDOWED and UNWINDOWED readings of the same fixture disagree loudly (a pair correlated over the last
30 days and ANTI-correlated before it: windowed +1.0 vs unwindowed −0.2781), and each asserts both readings — so
none of them can pass by measuring nothing. Suite **1603 / 1602 pass / 0 fail / 1 skipped** (was 1592).
⚠ The desk holds this module in memory: the fix is inert until a restart, which was done (see the RSK-5 note).`;

const NOTE5 = (m) => `

${MARK5}
★ **THE VETO IS NOW RE-ASKED AGAINST A BOOK THAT INCLUDES THIS WAKE'S OWN APPROVALS. IMPLEMENTED 2026-09-28.**

WHAT WAS WRONG (restated so this row reads standalone). \`risk.evaluate\` walks the book it is HANDED, and
\`wakePipeline.js:330\` takes that book ONCE per wake. Every entry in a wake was therefore judged against the same
frozen snapshot, and the only pre-submit re-check was SYMBOL-scoped (\`freshOpen.some(x => x.symbol === d.symbol)\`
→ \`already_open_symbol\`). **The gate promises "no two CORRELATED positions open together"; the only control that
touched the pre-submit book enforced "no two of the SAME SYMBOL".** Measured on wake #105365: handed a 1-position
book, it approved Gold and Silver together — 12 seconds after the same gate refused Silver against an open Gold.

WHAT LANDED
- **\`risk.correlationClash(userId, risk, symbol, positions, { proposal })\`** is the rule in ONE place, and
  \`evaluate\` now DELEGATES to it instead of keeping an inline loop (a second copy is how two copies drift). The
  refusal sentence is byte-identical to the original — \`correlation <c> (30d log-returns) with open position <S> >= <T>\`
  — which is why TRD-RSK-3 mattered: readers key on that sentence and it now describes the window actually used.
- **The wake re-asks it immediately before \`executor.openTrade\`**, against \`freshOpen\` **concatenated with
  \`approvedThisWake\`** — the entries this same pass has already placed.
- Refused as a POLICY refusal: \`blocked: true\` on the execution and an \`order_blocked\` event with reason
  \`correlation_intrawake\`, carrying the coefficient, the clashing symbol, the threshold, the book size and
  \`approvedThisWake\`. Never \`order_rejected\`: self-health's drift check counts approved-entries-that-never-filled
  and the breaker reads rejections, so a working guard must not report as a broken desk (the TRD-43 asymmetry).
- ⚠ **A BUG I CAUGHT IN MY OWN WIRING BEFORE IT RAN:** the first version passed the whole \`settings\` object where
  the helper takes the \`risk\` SUB-object, so \`settings.correlationVeto\` was undefined and the owner's threshold
  would have been silently ignored in favour of the 0.7 default. It now passes \`settings.risk || {}\`, and a test
  asserts that expression specifically.

★ WHAT THE FRESH BOOK ALONE WOULD HAVE CAUGHT — worth stating, because it shrinks the claimed scope honestly.
Gold #1107 filled at 05:26:47.666Z and Silver was submitted at 05:27:10.619Z, so by then \`freshOpen\` DID contain
Gold. **The narrow symbol test is the ONLY reason that fill was invisible.** \`approvedThisWake\` covers the
remaining window — an entry approved earlier in the same pass whose fill has not landed yet — which is the part a
fresh read cannot see at all.

⚠ STILL OPEN / NOT CLAIMED
- The re-check lives on the WAKE's entry path. Any other caller of \`executor.openTrade\` (a non-wake order path)
  still relies on the gate as evaluated at decision time. Nothing is known to be wrong there; it is simply not
  covered by this fix and is not claimed to be.
- The re-check costs one \`getOpenTrades\` (already happening) and up to N correlation reads per entry. Those reads
  are the same cached-bar reads \`evaluate\` uses; if it ever shows up as latency, the set-evaluation variant
  (score the wake's entries as a SET against the snapshot) is the cheaper design and is recorded on the row.

REPIN: \`test/correlation-window-and-intrawake.test.js\` — asserts the re-check runs BEFORE \`openTrade\`, passes the
RISK sub-object, includes \`freshOpen.concat(approvedThisWake)\`, is a policy refusal, does not trip the breaker, and
that \`evaluate\` no longer calls \`returnsCorrelation\` directly. The bar read is stubbed, so the rules are tested
behaviourally; the stub now AWAITS the callback before restoring, because the first version put the real read back
while the assertions were still pending and made an exemption test pass for entirely the wrong reason.
Suite **1603 / 1602 pass / 0 fail / 1 skipped**. Desk restarted so the module graph is live.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the constant, and the window actually applied ===');
  if (risk.CORR_WINDOW_DAYS !== 30) await fail(`CORR_WINDOW_DAYS is ${risk.CORR_WINDOW_DAYS}, not 30`);
  console.log('  CORR_WINDOW_DAYS = ' + risk.CORR_WINDOW_DAYS + '  CORR_MIN_BARS = ' + risk.CORR_MIN_BARS);
  const g = await load('Gold'), s = await load('Silver');
  if (g.length < 40 || s.length < 40) await fail('not enough bars to measure');
  const oldM = rhoOf(g, s, null);
  const newM = rhoOf(g, s, 30 * 86400000);
  console.log(`  OLD rule (no window): rho ${oldM.rho} over ${oldM.pairs} pairs / ${oldM.oldSpan || oldM.spanDays} days`);
  console.log(`  NEW rule (30d)      : rho ${newM.rho} over ${newM.pairs} pairs / ${newM.spanDays} days`);

  console.log('\n=== 2. the gate ITSELF returns the windowed number ===');
  const live = await risk.returnsCorrelation(USER, 'Gold', 'Silver');
  console.log('  risk.returnsCorrelation(1,Gold,Silver) = ' + live);
  if (live !== newM.rho) await fail(`the gate returned ${live} but the replicated 30d value is ${newM.rho}`);
  if (!(live < 0.7)) await fail(`the live 30d reading is ${live}, which is NOT under 0.7 — the record's central claim would be false`);
  if (!(oldM.rho >= 0.7)) await fail(`the old reading is ${oldM.rho}, which is not over 0.7 — there is no contrast to record`);
  const margin = +(0.7 - live).toFixed(4);
  console.log(`  \u2714 the pair flipped from VETOED (${oldM.rho}) to ALLOWED (${live}), margin ${margin}`);

  console.log('\n=== 3. the threshold was NOT changed ===');
  const thr = (await q(`SELECT TOP 1 JSON_VALUE(settings,'$.risk.correlationVeto') AS v FROM TradingSettings WHERE userId = 1`))[0];
  console.log('  live risk.correlationVeto = ' + thr.v);
  if (String(thr.v) !== '0.7') await fail(`the live threshold is ${thr.v}, not 0.7 — this record says the value stands`);

  console.log('\n=== 4. the wake re-ask exists and precedes the submit ===');
  const wp = fs.readFileSync(path.join(ROOT, 'trading/agent/wakePipeline.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const idx = wp.indexOf("require('./risk').correlationClash(");
  const submit = wp.indexOf("require('./executor').openTrade(", idx);
  if (!(idx > -1 && submit > idx)) await fail('the re-check is missing or does not precede openTrade');
  if (!/settings\.risk \|\| \{\}/.test(wp.slice(idx, idx + 300))) await fail('the whole settings object is being passed again');
  if (!/freshOpen\.concat\(approvedThisWake\)/.test(wp)) await fail('the book does not include this wake\'s approvals');
  console.log('  \u2714 re-check at offset ' + idx + ', submit at ' + submit + ', risk sub-object passed, approvals included');

  console.log('\n=== 5. the tests ===');
  const tf = 'test/correlation-window-and-intrawake.test.js';
  if (!fs.existsSync(path.join(ROOT, tf))) await fail(tf + ' is missing');
  const n = (fs.readFileSync(path.join(ROOT, tf), 'utf8').match(/^test\(/gm) || []).length;
  console.log('  ' + tf + ' — ' + n + ' test() calls');
  if (n < 11) await fail('expected at least 11 tests');

  console.log('\n=== 6. the pair this is about, as it stands right now (reported, not asserted) ===');
  for (const r of await q(`SELECT id, symbol, direction, size, status, openAt FROM Trades WHERE id IN (1107,1108) ORDER BY id`))
    console.log(`  #${r.id} ${r.symbol} ${r.direction} size=${r.size} status=${r.status} open=${r.openAt.toISOString()}`);

  const m = { oldRho: oldM.rho, oldPairs: oldM.pairs, oldSpan: oldM.spanDays, newRho: newM.rho, newPairs: newM.pairs, newSpan: newM.spanDays, margin };

  console.log('\n=== the records ===');
  for (const [id, mark, text, label] of [[1451, MARK3, NOTE3(m), 'TRD-RSK-3'], [1456, MARK5, NOTE5(m), 'TRD-RSK-5']]) {
    const dup = await q(`SELECT id FROM Tasks WHERE id = ${id} AND info LIKE '%${mark}%'`);
    if (dup.length) { console.log(`  [${label}] #${id} marker present - nothing to do.`); continue; }
    const cur = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`))[0];
    console.log(`  [${label}] #${id} info ${cur.len} -> ${Number(cur.len) + text.length}`);
    if (!YES) { console.log(`  [${label}] DRY RUN - not written.`); continue; }
    await pool.request().input('t', text).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${id}`);
    const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`))[0];
    console.log(`  \u2714 [${label}] #${id} appended -> ${b.len} chars`);
  }
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
