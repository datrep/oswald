// scripts/record-2026-09-28-veto-intrawake.js — TRD-RSK-5: the correlation veto is never re-checked
// within a wake, so two correlated entries open jointly. Every claim is re-measured before writing.
// Dry by default:  node scripts/record-2026-09-28-veto-intrawake.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');
const store = require('../trading/store');
const risk = require('../trading/agent/risk');
const { correlation } = require('../trading/agent/indicators');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 trd-rsk-5-intrawake-veto##';
const USER = 1;
const VENUES = ['yahoo', 'binance', 'okx', 'plus500_chart', 'plus500'];

const NAME = 'TRD-RSK-5: Risk - the correlation veto is never re-checked within a wake, so two correlated entries open jointly';

const INFO = `★ REGISTERED 2026-09-28 by measurement on the live desk, at the close of the TRD-EXE-1 work. This is a SECOND, INDEPENDENT defect in the SAME GATE as TRD-RSK-3 (#1451) - see the cross-reference there.

★★ THE CORRELATION VETO IS EVALUATED AGAINST A WAKE-START BOOK SNAPSHOT, SO TWO ENTRIES DELIBERATED IN ONE WAKE ARE NEVER COMPARED TO EACH OTHER.

HOW THE GATE IS BUILT (read from the code, not inferred)
- wakePipeline.js:330 takes the book ONCE per wake: const openTrades = await store.getOpenTrades(userId);
- aggregator.decide(...) is handed that array and passes that same array to riskMod.evaluate(userId, settings, proposal, openTrades, cooldownClosed) - aggregator.js:536.
- risk.js:449 then walks "for (const pos of open)" - i.e. only the snapshot it was given.
- store.getOpenTrades is "WHERE userId = @userId AND status = 'open'" and nothing else.
=> every entry in a wake is judged against the same frozen book, and there is no pass that re-reads the book between entries.

★ AND THE ONE FRESH RE-CHECK IS SYMBOL-SCOPED ONLY. wakePipeline.js:961 re-reads store.getOpenTrades(userId) immediately before submit - but its test is "freshOpen.some(x => x.symbol === d.symbol)" -> already_open_symbol. It catches a DUPLICATE OF THE SAME SYMBOL and nothing else. It cannot see a correlated sibling.
=> the gap is exact, and it is a gap between two different claims: the gate promises "no two CORRELATED positions open together"; the only control that touches the pre-submit book enforces "no two of the SAME SYMBOL".

WHAT IT DID TODAY
- 4 of today's wakes (72 at the time of measurement) deliberated MORE THAN ONE entry: #103592 03:40:34Z (Bitcoin + Sugar), #104727 04:53:34Z (Arabica Coffee + Sugar), #105062 05:12:25Z (Arabica Coffee + Sugar), #105365 05:27:10Z (Gold + Silver).
- The Gold+Silver wake is the one that binds. Wake #105365 carries "positions": 1 - the book at wake start was ONE position, #1099 Bitcoin sell. Neither Gold nor Silver was held and neither is correlated with Bitcoin, so BOTH entries passed - correctly, given what the gate was shown.
- Gold #1107 filled 05:26:47.666Z (sell 0.1152 @4188.09). Silver #1108 filled 05:27:10.619Z (sell 7.8131 @61.717) - 23.0 s later, with Gold already open and never re-checked.
- ★★ 12 SECONDS BEFORE THAT PAIR WAS APPROVED, THE SAME GATE REFUSED SILVER. Decision #105279 at 05:22:41.900Z carries veto: ["correlation"] "correlation 0.7763 (30d log-returns) with open position Gold >= 0.7". What changed was not the market, it was the book: Gold #1097 (sell 0.2281) flipped to status='closed' at 05:22:53.696Z, freeing the correlation slot - and the next wake spent it on BOTH legs.
- 69 decisions carried a correlation refusal today, from 00:02:16Z to 05:22:41.900Z - roughly the same pair being refused one leg at a time for five and a half hours, and then admitted as a pair in one wake.

THE EXPOSURE, ARITHMETIC (from the two open rows)
- Both legs are SELL. Gold risk = 0.1152 x (4200.9151 - 4188.09) = $1.4775. Silver risk = 7.8131 x (61.9307 - 61.717) = $1.6697. Total $3.1471 = 0.0761% of the $4,135.07 equity read in the same decision payloads.
- The gate's own rule permits ONE leg: $1.5736 = 0.0381%. So the pair carries 2.00x the at-risk the rule allows, in the SAME direction, at rho 0.7763 - the desk sized two bets as one and is holding both.
- And this is the DEGRADED size (chair offline, runInFactor 0.5). At full size the same wake would have carried four leg-risks.

★★ THE WINDOW DECIDES WHETHER THIS BITES - SO TRD-RSK-3 (#1451) IS NOT A COSMETIC BUG
risk.returnsCorrelation loads store.listBars(..., limit: 12000) with NO date filter, and listBars is "SELECT TOP (@limit) ... ORDER BY barStart DESC". Measured by calling the gate's OWN exported function:
- as implemented: Gold|Silver rho = 0.7763 over 11,476 return-pairs spanning 733 days -> >= 0.7 -> VETOES
- as documented in the sentence the refusal itself prints ("30d log-returns"): rho = 0.688 over 435 pairs spanning 28.3 days -> < 0.7 -> ALLOWS
=> THE TWO DEFECTS PARTIALLY CANCEL. The pair open right now is a breach of the gate AS IMPLEMENTED and NOT a breach of the threshold on the window the policy NAMES. The margin is 0.012, so on this pair the entire verdict is decided by which window is used. Do not fix one without the other: correcting the window alone would leave the pair compliant while the intra-wake gap stays open, and closing the gap alone would enforce a 733-day number that the message mislabels as 30.

WHAT "FIXED" MEANS (no new state, no new architecture, both options use code that exists)
1. Re-run the correlation comparison against a FRESH book before submit, beside the existing symbol-scoped check. The fresh read already happens at wakePipeline.js:961 - only its test is too narrow.
2. Or evaluate a wake's entries as a SET: against the wake-start snapshot PLUS the entries already approved earlier in the same pass. Cheaper, no extra bar loads, and it makes "one wake, one book decision" explicit.
3. Keep already_held and already_open_symbol either way - they make different claims, and only one of them is about correlation.

REPIN: a test that opens two correlated entries in one wake must FAIL today. That is the smallest honest pin, it needs no venue, and today's #105365 is its fixture.
SEVERITY: live, not historical - both rows were open when this was written. It is BOUNDED (0.0761% of equity) and, on the window the policy names, COMPLIANT. This is a guarantee gap to close, not a breach to panic about.`;

async function load(sym) {
  for (const v of VENUES) {
    const rows = await store.listBars(USER, { timeframe: '1h', symbol: sym, venue: v, limit: 12000 }).catch(() => []);
    if (rows.length >= 30) return rows;
  }
  return [];
}

function rhoFrom(a, b, cutMs) {
  const mapB = new Map(b.map((r) => [new Date(r.barStart).getTime(), Number(r.closePrice)])
    .filter(([, c]) => Number.isFinite(c) && c > 0));
  const paired = [];
  for (const r of a) {
    const c = Number(r.closePrice);
    if (!Number.isFinite(c) || c <= 0) continue;
    const o = mapB.get(new Date(r.barStart).getTime());
    if (o != null) paired.push([new Date(r.barStart).getTime(), c, o]);
  }
  const keep = cutMs == null ? paired : paired.filter((x) => x[0] >= cutMs);
  const ra = [], rb = [];
  for (let i = 1; i < keep.length; i++) {
    ra.push(Math.log(keep[i][1] / keep[i - 1][1]));
    rb.push(Math.log(keep[i][2] / keep[i - 1][2]));
  }
  const c = correlation(ra, rb);
  const spanDays = keep.length ? (keep[keep.length - 1][0] - keep[0][0]) / 86400000 : 0;
  return { rho: c == null ? null : +c.toFixed(4), pairs: ra.length, spanDays: +spanDays.toFixed(1) };
}

async function append(pool, id, text, mark, label) {
  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE id = ${id} AND info LIKE '%${mark}%'`)).recordset;
  if (dup.length) { console.log(`  [${label}] marker present - nothing to do.`); return; }
  const cur = (await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`)).recordset[0];
  console.log(`  [${label}] #${id} info ${cur.len} -> ${Number(cur.len) + text.length}`);
  if (!YES) { console.log(`  [${label}] DRY RUN - not written.`); return; }
  await pool.request().input('t', text).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${id}`);
  const b = (await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`)).recordset[0];
  console.log(`  \u2714 [${label}] #${id} appended -> ${b.len} chars`);
}

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  // ── 0. MAKE EVERY CLAIM FIRST ─────────────────────────────────────────────────────────────────────
  console.log('\n=== the gate\'s own function, both windows ===');
  const gate = await risk.returnsCorrelation(USER, 'Gold', 'Silver');
  const gA = await load('Gold'), gB = await load('Silver');
  const all = rhoFrom(gA, gB, null);
  const w30 = rhoFrom(gA, gB, Date.now() - 30 * 86400000);
  console.log(`  as implemented: rho=${all.rho} pairs=${all.pairs} span=${all.spanDays}d  (risk.returnsCorrelation -> ${gate})`);
  console.log(`  as documented : rho=${w30.rho} pairs=${w30.pairs} span=${w30.spanDays}d`);
  if (gate !== all.rho) await fail(`the gate returned ${gate} but the replication produced ${all.rho}`);
  if (!(Math.abs(all.rho) >= 0.7)) await fail(`the ${all.spanDays}d rho ${all.rho} does not breach 0.7 - the window claim is void`);
  if (!(Math.abs(w30.rho) < 0.7)) await fail(`the 30d rho ${w30.rho} also breaches 0.7 - then the window is NOT the deciding factor`);
  console.log(`  \u2714 verdict flips on the window: ${all.rho} vetoes / ${w30.rho} allows`);

  console.log('\n=== the wake that opened both legs, and the book it was given ===');
  const wk = (await q(`SELECT id, createdAt, payload FROM TradingEvents WHERE kind='wake' AND id=105365`))[0];
  if (!wk) await fail('wake #105365 is missing - the fixture is gone');
  const wp = JSON.parse(wk.payload);
  const entries = (wp.decisions || []).filter((d) => d.action === 'entry');
  console.log(`  wake #${wk.id} ${wk.createdAt.toISOString()} positions=${wp.positions} entries=${entries.map((e) => e.symbol).join(', ')}`);
  if (wp.positions !== 1) await fail(`wake #105365 recorded positions=${wp.positions}, not 1 - the gate was NOT shown a 1-position book`);
  if (entries.length !== 2) await fail(`wake #105365 carried ${entries.length} entries, not 2`);
  if (!(entries.some((e) => e.symbol === 'Gold') && entries.some((e) => e.symbol === 'Silver')))
    await fail('the two entries are not Gold and Silver');
  console.log('  \u2714 one wake, a 1-position book, two correlated entries');

  console.log('\n=== the refusal 12 seconds earlier on the same gate ===');
  const ref = (await q(`SELECT id, createdAt, payload FROM TradingEvents WHERE id=105279`))[0];
  const rp = ref ? JSON.parse(ref.payload) : null;
  const rline = rp ? (rp.riskReasons || []).find((s) => /correlation/i.test(String(s))) : null;
  console.log(`  #105279 ${ref && ref.createdAt.toISOString()} codes=${JSON.stringify(rp && rp.riskVetoCodes)} :: ${rline}`);
  if (!rp || !(rp.riskVetoCodes || []).includes('correlation')) await fail('#105279 does not carry a correlation refusal');
  if (!/with open position Gold/.test(String(rline))) await fail('#105279 does not name an open position Gold');

  console.log('\n=== the two live rows and the arithmetic ===');
  const rows = await q(`SELECT id, symbol, direction, size, openPrice, stopPrice, status, decisionId, openAt
      FROM Trades WHERE id IN (1107,1108) ORDER BY id`);
  for (const r of rows) console.log(`  #${r.id} ${r.symbol} ${r.direction} size=${r.size} @${r.openPrice} stop=${r.stopPrice} status=${r.status} decision=${r.decisionId}`);
  if (rows.length !== 2) await fail('expected exactly two rows, #1107 and #1108');
  if (!rows.every((r) => r.direction === 'sell')) await fail('the two legs are not both sells');
  const equity = 4135.07;
  const riskOf = (r) => Number(r.size) * Math.abs(Number(r.stopPrice) - Number(r.openPrice));
  const kG = riskOf(rows[0]), kS = riskOf(rows[1]);
  const total = kG + kS, single = total / 2;
  console.log(`  Gold $${kG.toFixed(4)} + Silver $${kS.toFixed(4)} = $${total.toFixed(4)} = ${(total / equity * 100).toFixed(4)}% of equity`);
  console.log(`  the rule permits one leg: $${single.toFixed(4)} = ${(single / equity * 100).toFixed(4)}%  -> pair carries ${(total / single).toFixed(2)}x`);
  if (!(Math.abs(total - 3.1471) < 0.01)) await fail(`the combined risk came to $${total.toFixed(4)}, not $3.1471 - the arithmetic in this record is wrong`);
  if (!(total > single * 1.9)) await fail('the pair does not carry about twice a single leg');
  const gap = (rows[1].openAt - rows[0].openAt) / 1000;
  console.log(`  the second leg opened ${gap.toFixed(1)} s after the first, with the first already open`);
  if (!(gap > 0)) await fail('the two legs did not open in that order');

  console.log('\n=== reported, not asserted (these drift as the day goes on) ===');
  const corrToday = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision'
      AND createdAt >= CAST(GETUTCDATE() AS date) AND payload LIKE '%"correlation"%'`))[0].n;
  const wakesToday = await q(`SELECT payload FROM TradingEvents WHERE kind='wake' AND createdAt >= CAST(GETUTCDATE() AS date)`);
  const multi = wakesToday.filter((w) => { try { return (JSON.parse(w.payload).decisions || []).filter((d) => d.action === 'entry').length > 1; } catch { return false; } }).length;
  console.log(`  correlation refusals today: ${corrToday}   wakes today: ${wakesToday.length}   wakes with >1 entry: ${multi}`);

  // ── 1. THE ROW ────────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== TRD-RSK-5 ===');
  const dup = await q(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' OR name LIKE 'TRD-RSK-5:%'`);
  if (dup.length) console.log(`  already recorded as #${dup[0].id} - nothing to do.`);
  else if (!YES) console.log('  DRY RUN - not written.');
  else {
    const mx = (await q('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks'))[0];
    const anchor = (await q('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1451'))[0];
    const ins = await pool.request()
      .input('name', NAME).input('info', INFO).input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx.m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    const id = ins.recordset[0].id;
    const b = (await q(`SELECT state, active, sortOrder FROM Tasks WHERE id = ${id}`))[0];
    console.log(`  \u2714 created as #${id} state=${b.state} active=${b.active} sortOrder=${b.sortOrder}`);
    await append(pool, 1451, `

##2026-09-28 trd-rsk-3-intrawake-link##
★ CROSS-REFERENCE: this gate now carries a SECOND, INDEPENDENT defect - TRD-RSK-5 (#${id}). The veto is evaluated against a wake-start book snapshot, so two entries deliberated in one wake are never compared to each other, and the only pre-submit re-check is symbol-scoped (already_open_symbol).
★★ THE TWO INTERACT, AND THAT IS WHY NEITHER CAN BE FIXED ALONE. The pair open on the desk today - Gold #1107 and Silver #1108, both SELL - is rho 0.7763 on the 733-day window THIS row is about, and rho 0.688 on the 30-day window the refusal's own message names. The margin is 0.012.
=> fixing this row alone leaves that pair COMPLIANT while the intra-wake gap stays open and can be used again; fixing the gap alone would enforce a 733-day number the message mislabels as 30d.`, '##2026-09-28 trd-rsk-3-intrawake-link##', 'TRD-RSK-3 #1451');
  }

  const s = await q('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('\nedict 52 by state: ' + s.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
