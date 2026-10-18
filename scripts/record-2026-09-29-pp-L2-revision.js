// scripts/record-2026-09-29-pp-L2-revision.js
//
// Records the L2 REVISION and the FAILED PREDICTION on TRD-RSK-10 (#1467).
//
// The load-bearing gate re-derives the corrected model on BOTH eras: the L2-era observation (Sugar, 1.5%) and the
// pre-L2 observations (Coffee 0.3696, Sugar 0.4401). A model that "explains" the new number but not the old ones is
// curve-fitting, and this refuses to write on the strength of one.
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 L2 REVISION AND THE FAILED PREDICTION##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';
const SEC = '\u00A7';

const ADDENDUM = `
${MARKER} THE PREDICTION FAILED, AND DIAGNOSING IT CORRECTED THE MODEL AND FOUND THE CAP THAT BINDS.##

${STAR} THE OWNER's REVISION, one hour after the raise. 'settings_write' #125102 at **08:09:36Z** moved TWO keys:
'risk.maxEquityPerPositionPct' **500 -> 60** and 'risk.exposureCapPct' **500 -> 100**. The cause was on the venue's
own screen: a **645-contract Sugar ticket worth $11,964.75 against $4,124.95 of equity ${EM} 290% of equity in one
position**, against the ~16% the old 80% cap would have produced. The owner's word: miscalculation; the position is
left to close on its own.

${STAR}${STAR} **AND THE PREDICTION THIS ROW COMMITTED TO FAILED ${EM} WHICH IS WHY IT WAS WORTH WRITING DOWN.** The
first sized decision under L2 (wake #5653, 08:06:42Z) resolved at **1.5%**, not the predicted **2.2008%** ${EM} wrong
by **0.7008 percentage points**. 'cappedAtPct' was **null**, exactly as predicted, because the 500% cap genuinely no
longer bound. A prediction that is not falsifiable is prose; this one was, and it was false.

${STAR} THE DIAGNOSIS: **THE RUN-IN MULTIPLIER**, a term the model simply did not have. The ticket's own reason reads
'run-in factor 0.5 (this strategy is not parity-validated)'. **The dial is HALVED BEFORE any cap is compared** ${EM}
3.0% x 0.5 = 1.5% ${EM} so the TARGET was binding, at half the level the model assumed.

${STAR} THE CORRECTED MODEL, which reproduces BOTH eras exactly:
  'r_effective = min( r x runInFactor x strategyFactor ,  (u/100) x ceiling ,  capPct x stopPct ,  maxRiskPerTradePct )'
    Sugar, L2 era (#5653)   min(3.0x0.5, 0.8x2.751, 500x0.5502/100, 5) = **1.5%**     recorded **1.5**    (agrees)
    Coffee, pre-L2          min(3.0x0.5, 0.8x2.3101, 80x0.46202/100, 5) = **0.3696%**  recorded **0.3696** (agrees)
    Sugar, pre-L2           min(1.5, 2.2008, 0.4402, 5)                = **0.4402%**  recorded **0.4401** (agrees)
  ${ARROW} A model that explains the NEW number but not the OLD ones is curve-fitting. This explains all three.

${STAR} AND 'boundBy: null' ON THAT TICKET IS CORRECT BY DESIGN, NOT A DEFECT. L4's own comment states it: "a run-in
or half-risk MULTIPLIER never sets it: it scales the dial rather than bounding the ticket, and it is not one of the
enumerated controls." The number IS 'riskPerTradePct x runInFactor' ${EM} nothing bounded it. ${WARN} **BUT STATE THE
CONSEQUENCE PLAINLY: 'boundBy: null' means "none of the four SIZE controls bound" ${EM} it does NOT mean "no control
acted", and it cannot by itself distinguish "the dial was small enough" from "a multiplier made it so". That
distinction lives only in 'reasons'**, and the same gap will exist for any future multiplier. It is a property of the
field's design, not a bug to patch.

${WARN}${WARN} **AND THE 60%/100% PAIR HAS A LARGER EFFECT THAN THE POSITION CAP ITSELF.** 'exposureCapPct' came back
to **100**, so with a 60% per-position cap **the book fits roughly 1.6 full-size positions** ${EM}
'maxPositions: 10' is now largely theoretical. And on every measurable symbol the 60% cap delivers **LESS risk than
the pre-L2 80% cap did**:
    Arabica Coffee   pre-L2 0.3696%   ->  L2 as shipped 1.8481%   ->  as revised **0.2772%** (-25%)
    Sugar            pre-L2 0.4402%   ->  L2 as shipped 2.2008%   ->  as revised **0.3301%** (-25%)
    SGX              pre-L2 1.1989%   ->  L2 as shipped 3.0000%   ->  as revised **0.8992%** (-25%)
${ARROW}${ARROW} **THE PER-POSITION CAP IS THE BINDING CONTROL AGAIN AND THE MARGIN GUARD IS IDLE ${EM} the OPPOSITE
of ${SEC}6.1's intent**, which was to raise the caps until the guard became the only brake so the 'r = 3.0%' target
could actually be delivered. **At 60% the target is unreachable on every symbol measured.** 60% is a defensible
posture and it is the owner's to choose, but as it stands the package delivers the TIGHTENINGS ('r' 5 -> 3, the cap
80 -> 60) without the loosening it was designed around, so ${SEC}6.1's evidence-collection argument does not yet
apply. **Flagged as an OWNER DECISION; not resolved here, and nothing further was changed.**

${STAR} THE OPEN POSITION, and why it was not touched. 'Trades' #1125 ${EM} Sugar sell, 645 contracts (computed
647.0551), entry 18.52, 'origin = agent', 'decisionId = 5653', **stop 18.6612 and limit 18.4279**, both correctly
placed around 18.55. It carries ~290% of equity in notional, **above the new 60% cap ${EM} and that is correct
behaviour, because a position cap governs SIZING and cannot reach backwards into a position already open.** The owner
is letting it close on its own; nothing was closed, moved or hedged.

${WARN} AND A CONSEQUENCE OF MY OWN TRD-RSK-11 FIX, FOUND WHILE WRITING THIS BLOCK's GATE: **'cappedAtPct: null'
NO LONGER RECORDS WHAT THE CAP *WAS*.** Making the field honest meant writing it only when the cap truncates, so on
a decision where the cap did NOT bind the payload no longer carries the cap's value at all. Re-deriving the model
for a PAST decision therefore depends on the 'settings_write' JOURNAL, not on the payload ${EM} which is precisely the
record TRD-RSK-8 asked for, and the reason the journal matters more now than it did yesterday. My gate refused to
write the first time because it used the CURRENT cap and evaluated a 60% cap on a decision taken under a 500% one.

${WARN} ONE MORE MEASUREMENT DEBT, NOTED NOT FIXED: 'Trades.units' reads as the string 'Contracts', not a number, so
'units x openPrice' returns 'NaN' ${EM} a notional derived from that column is silently poisoned rather than failing
loudly. Adjacent to TRD-EXE-6, and it cost this section one probe.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== L2 revision + failed prediction — recording gates ===\n');

  console.log('1. the report');
  const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  const i12 = doc.indexOf('### 13.12 '), i13 = doc.indexOf('### 13.13 ');
  if (i13 < 0) await fail('the report is missing 13.13');
  if (i13 < i12) await fail('13.13 must come after 13.12');
  if (!/THE FIRST TEST OF THE L2 PREDICTION FAILED/.test(doc)) await fail('the report must name the failure');
  console.log(`  ${CHECK} 13.13 present, in order, and records the failure`);

  console.log('\n2. THE OWNER\u2019S REVISION, re-derived from the journal');
  const sw = (await q(`SELECT TOP 1 id, payload FROM TradingEvents WHERE kind = 'settings_write'
    AND payload LIKE '%maxEquityPerPositionPct%' ORDER BY id DESC`))[0];
  if (!sw) await fail('no settings_write event journals the cap change');
  const p = JSON.parse(sw.payload);
  const chg = Object.fromEntries((p.changes || []).map((c) => [c.key, [c.before, c.after]]));
  if (JSON.stringify(chg['risk.maxEquityPerPositionPct']) !== '[500,60]') {
    await fail(`the journal says ${JSON.stringify(chg['risk.maxEquityPerPositionPct'])}, expected [500,60]`);
  }
  if (JSON.stringify(chg['risk.exposureCapPct']) !== '[500,100]') {
    await fail(`exposureCapPct journal is ${JSON.stringify(chg['risk.exposureCapPct'])}, expected [500,100]`);
  }
  console.log(`  ${CHECK} event #${sw.id} journals 500->60 and 500->100`);

  console.log('\n3. the live settings now match the revision');
  const risk = (await store.getSettings(1)).risk || {};
  if (Number(risk.maxEquityPerPositionPct) !== 60) await fail(`maxEquityPerPositionPct is ${risk.maxEquityPerPositionPct}, not 60`);
  if (Number(risk.exposureCapPct) !== 100) await fail(`exposureCapPct is ${risk.exposureCapPct}, not 100`);
  console.log(`  ${CHECK} live = 60 / 100 (with r=${risk.riskPerTradePct}, halt=${risk.dailyLossHaltPct}, guard=${risk.maxMarginUtilisationPct})`);

  console.log('\n4. THE CORRECTED MODEL, re-derived on BOTH eras');
  // ⚠ THE CAP IN FORCE IS TIME-DEPENDENT, AND `cappedAtPct: null` NO LONGER RECORDS IT. TRD-RSK-11 made that
  // field honest by writing it ONLY when the cap truncates — so on a decision where the cap did NOT bind, the
  // payload no longer says what the cap WAS. Re-deriving the model for a past decision therefore needs the
  // `settings_write` journal, which is exactly the record TRD-RSK-8 asked for. The first version of this gate
  // used the CURRENT setting and refused to write because wake #5653 (08:06:42Z) predates the 08:09:36Z revision
  // by three minutes: it evaluated a 60% cap on a decision taken under a 500% one.
  const swAll = await q(`SELECT id, createdAt, payload FROM TradingEvents WHERE kind = 'settings_write' ORDER BY id`);
  const capTimeline = [];
  for (const s of swAll) {
    let pp; try { pp = JSON.parse(s.payload); } catch { continue; }
    for (const c of (pp.changes || [])) {
      if (c.key === 'risk.maxEquityPerPositionPct') capTimeline.push({ at: new Date(s.createdAt), before: Number(c.before), after: Number(c.after) });
    }
  }
  capTimeline.sort((a, b) => a.at - b.at);
  const capInForceAt = (when) => {
    let v = capTimeline.length ? capTimeline[0].before : Number(risk.maxEquityPerPositionPct);
    for (const c of capTimeline) { if (c.at <= when) v = c.after; }
    return v;
  };
  console.log(`  cap journal: ${capTimeline.map((c) => `${c.before}->${c.after}@${c.at.toISOString().slice(11, 19)}`).join('  ') || '(none)'}`);
  const rows = await q(`SELECT id, createdAt, decision FROM TradingPrompts WHERE decision IS NOT NULL ORDER BY id DESC`);
  const seen = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.decision); } catch { continue; }
    for (const e of (Array.isArray(d.decisions) ? d.decisions : [])) {
      const sc = e && e.sizeCalc;
      if (sc && sc.resolvedRiskPct != null && sc.ceilingPct != null) {
        seen.push({ at: new Date(r.createdAt), sym: e.symbol, sc });
      }
    }
  }
  const L2_AT = new Date('2026-09-29T07:57:43Z');
  const after = seen.filter((x) => x.at >= L2_AT);
  if (!after.length) await fail('no L2-era sized decision — the failure claim cannot be re-derived');
  const u = Number(risk.maxMarginUtilisationPct);
  let checked = 0;
  for (const x of [...after, ...seen.filter((y) => y.at < L2_AT)].slice(0, 8)) {
    const sc = x.sc;
    const L = sc.venueFloor && sc.venueFloor.leverage ? Number(sc.venueFloor.leverage) : null;
    if (!L) continue;
    const stop = sc.ceilingPct / L;
    // A decision that RECORDS the cap (cappedAtPct non-null) says so directly; otherwise the value in force has to
    // come from the journal, at that decision's moment.
    const capPct = sc.cappedAtPct != null ? Number(sc.cappedAtPct) : capInForceAt(x.at);
    const dial = Number(sc.riskDialPct) * Number(sc.runInFactor) * Number(sc.strategyFactor);
    const model = Math.min(dial, (u / 100) * sc.ceilingPct, capPct * stop / 100, 5);
    const got = Number(sc.resolvedRiskPct);
    const ok = Math.abs(model - got) < 0.01;
    console.log(`  ${ok ? CHECK : WARN} ${x.at.toISOString().slice(11, 19)} ${String(x.sym).padEnd(15)} model ${model.toFixed(4)}%  recorded ${got}%  dial=${dial} cap=${capPct} ${ok ? '' : '  <-- MISMATCH'}`);
    if (!ok) await fail(`${x.sym}: corrected model ${model.toFixed(4)} != recorded ${got} — it does not explain this era`);
    checked++;
  }
  if (checked < 3) await fail(`only ${checked} observations checked — not enough to claim both eras`);
  console.log(`  ${CHECK} the corrected model explains ${checked} observations across BOTH eras`);

  console.log('\n5. the open Sugar ticket is protected (so "let it close on its own" is safe)');
  const t = (await q(`SELECT TOP 1 id, symbol, status, origin, stopPrice, takeProfitPrice FROM Trades
    WHERE symbol = 'Sugar' AND status = 'open' ORDER BY id DESC`))[0];
  if (!t) console.log(`  ${WARN} no open Sugar ticket right now`);
  else {
    if (t.stopPrice == null || t.takeProfitPrice == null) await fail(`Sugar #${t.id} is missing a stop or a limit — it is NOT safe to leave open`);
    console.log(`  ${CHECK} Sugar #${t.id} origin=${t.origin} stop=${t.stopPrice} limit=${t.takeProfitPrice}`);
  }

  console.log('\n6. the row and its marker');
  const r = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!r) await fail(`row ${TASK_ID} does not exist`);
  const n = (r.info || '').split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${(r.info || '').length} chars, this marker ${n}x`);

  if (!YES) {
    console.log(n === 0
      ? `\n  would append ${ADDENDUM.length} chars. DRY RUN ${EM} not written.`
      : `\n  block already present. DRY RUN ${EM} not written.`);
    await pool.close();
    return;
  }
  if (n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log(`  ${CHECK} block appended`);
  } else console.log('  block already present.');

  const aft = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (aft.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`the block appears ${fn}x — expected exactly 1 (idempotency)`);
  if (!(aft.info || '').includes('DIAGNOSING IT CORRECTED THE MODEL')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${aft.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
