// scripts/record-2026-09-28-settings-audit.js — TRD-RSK-8: a live risk setting moved and nothing recorded it.
// Every claim below is re-measured from the DB and the source before anything is written.
// Dry by default:  node scripts/record-2026-09-28-settings-audit.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const EDICT = 52;
const MARK = '##2026-09-28 settings-write-unrecorded##';
const NAME = 'TRD-RSK-8: Risk - a live risk setting changed with no event recording it; settings writes have no journal';
const ROOT = path.join(__dirname, '..');

const INFO = `★ REGISTERED 2026-09-28, found while answering the owner's question "have we given the LLM data on the risk and position sizing?" — the answer is yes (below), and that answer is what exposed this.

★★ THE FINDING: A LIVE RISK SETTING CHANGED, AND THERE IS NO EVENT THAT RECORDS IT.
Measured, in this order:
- \`TradingSettings\` (userId 1) now reads \`risk.maxAdversePct = 1.5\`, with \`updatedAt = 2026-09-28T06:51:16.553Z\`.
- The newest prompt at that moment, #5407 (2026-09-28T06:50:22.206Z), told the chair: **"Venue stop CAP: 0.3% of price."**
- **The write landed 54 SECONDS AFTER the chair was last told, and the change reached the chair ONE WAKE LATER.** Bracketed: prompt #5407 (06:50:22Z) told the chair **"Venue stop CAP: 0.3% of price"**; the write was at **06:51:16.553Z**; prompt #5408 (06:56:28Z) told the chair **"1.5% of price"**. So there was a window — one wake, ~6 minutes — in which the chair reasoned under a rule the desk had already replaced. ⚠ The window is a CONSEQUENCE and I am not making it the headline: it closed by itself. **The headline is that the write left no record of itself, which does not close by itself.**
- **NOTHING RECORDED IT.** TradingEvents carries 52 distinct kinds; the ONLY one matching settings|config|tune|save|write|patch is \`tune_skipped\`. There is **no settings-write event kind at all** — a dashboard "Save sizing" click leaves no trace anywhere except a nullable \`updatedAt\` column.
- ★ AND IT WAS NOT THE TUNER: the tuner's every event is \`tune_skipped\` with \`gate: parity_not_validated\` (newest 2026-09-27T19:12:19Z). **The tuner has never written a setting.** So the author is a human dashboard save, and the desk cannot say so.

WHY THIS IS THE MIRROR OF THE OWNER'S OWN CONCERN. The owner asked to "prevent inert controls on the risk and position sizing". This is the INVERSE defect: the control WORKED (the value saved and will size the next ticket) and its EFFECT is unattributable. A risk control whose change cannot be attributed is a control that cannot be audited — and the desk is otherwise meticulous about this (vetoCodes, order_blocked, reanchor_skipped, the epoch registry). Settings are the one live input with no journal.

⚠ AND THE DIRECTION MATTERS. DEFAULT_SETTINGS' own comment records the sweep: \`temp/sweep-stop-cap.js\` — **cap 0.30% nets -28.89 / E -0.932, versus -46.93 / E -1.514 at 0.40%, versus -72.15 uncapped.** 0.30% is the measured optimum and wider is measured WORSE, monotonically. At 1.5% the cap is effectively OFF for every instrument on the book (Gold's declared 2xATR is ~0.53%), so the desk has been returned to approximately the "uncapped" configuration that sweep scored worst. **Not asserted as wrong — the owner may have a reason — but it is a change worth knowing about, and nothing told them.**

THE FIX, and it is small: **write a \`settings_write\` event on every saveSettings**, carrying \`{keys: [...], before: {...}, after: {...}, actor}\`. \`store.saveSettings\` is the ONE chokepoint every writer already shares (TRD-116's lesson: an automated writer reverted a human through it), so the journal belongs there and needs no new call sites. Then a risk change is attributable, reversible in principle, and visible to the next prompt instead of silent.

★★ SECONDARY FINDING IN THE SAME MEASUREMENT, NOT YET VERIFIED — flagged as a LEAD, not a claim: the venue's own position sizes disagree with the desk's \`Trades\` rows. At 06:51:23Z the account poll reported Gold **0.125** (desk row #1107 = 0.1152), Silver **7.5** (desk #1108 = 7.8131) and Bitcoin **0.003** (desk #1099 = 0.0025) — differences of 4-8%, against \`unconfirmed.SIZE_TOLERANCE_PCT = 2\`. If those are real rather than display rounding, **the tolerance that resolves an unconfirmed submit would refuse to match the desk's own position**, which is the recovery path TRD-52 depends on. Verify before acting.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the settings row, raw ===');
  const s = (await q(`SELECT TOP 1 JSON_VALUE(settings,'$.risk.maxAdversePct') AS stopcap, updatedAt
      FROM TradingSettings WHERE userId = 1`))[0];
  console.log(`  risk.maxAdversePct = ${s.stopcap}   updatedAt = ${s.updatedAt.toISOString()}`);

  console.log('\n=== 2. which two prompts BRACKET the write (this does not drift as new prompts arrive) ===');
  const iso = s.updatedAt.toISOString();
  const before = (await q(`SELECT TOP 1 id, createdAt, bundle FROM TradingPrompts WHERE createdAt <= '${iso}' ORDER BY createdAt DESC`))[0];
  const after = (await q(`SELECT TOP 1 id, createdAt, bundle FROM TradingPrompts WHERE createdAt > '${iso}' ORDER BY createdAt ASC`))[0];
  const capOf = (r) => { const m = r && r.bundle.match(/Venue stop CAP:\s*([^\\"]{0,30})/); return m ? m[1].trim() : '(none)'; };
  if (!before || !after) await fail('could not bracket the settings write with two prompts — the claim needs re-deriving');
  console.log(`  write at            ${iso}`);
  console.log(`  prompt BEFORE  #${before.id} ${before.createdAt.toISOString()}  told the chair: "${capOf(before)}"`);
  console.log(`  prompt AFTER   #${after.id} ${after.createdAt.toISOString()}  told the chair: "${capOf(after)}"`);
  console.log(`  => the change reached the chair ONE wake later (${((after.createdAt - before.createdAt) / 1000).toFixed(0)}s of prompt gap)`);
  if (!/^0\.3%/.test(capOf(before))) await fail(`the prompt BEFORE the write says "${capOf(before)}", not 0.3% — the divergence claim is void`);
  if (!/^1\.5%/.test(capOf(after))) await fail(`the prompt AFTER the write says "${capOf(after)}", not 1.5% — the propagation claim is void`);
  if (String(s.stopcap) !== '1.5') await fail(`maxAdversePct is ${s.stopcap}, not 1.5 — the claim is void`);

  console.log('\n=== 3. is there a settings-write event kind? ===');
  const kinds = (await q(`SELECT DISTINCT kind FROM TradingEvents`)).map((r) => r.kind);
  const settingsish = kinds.filter((k) => /setting|config|tune|save|write|patch/i.test(k));
  console.log(`  ${kinds.length} distinct kinds; settings-ish: ${settingsish.join(', ') || 'NONE'}`);
  if (settingsish.some((k) => !/tune_skipped/.test(k))) await fail('a settings-write kind DOES exist — re-check before claiming it does not');

  console.log('\n=== 4. and it was not the tuner ===');
  const tune = await q(`SELECT kind, COUNT(*) AS n FROM TradingEvents WHERE kind LIKE '%tune%' GROUP BY kind`);
  console.log('  tuner events: ' + tune.map((r) => `${r.kind}=${r.n}`).join(' '));
  const wrote = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind LIKE '%tune_applied%' OR kind LIKE '%tune_write%'`))[0].n;
  console.log(`  tune_applied/tune_write events: ${wrote}`);
  if (wrote > 0) await fail('the tuner HAS written something — re-check the attribution');

  console.log('\n=== 5. no event at all in the write window ===');
  const win = await q(`SELECT kind, COUNT(*) AS n FROM TradingEvents
      WHERE createdAt BETWEEN '2026-09-28T06:50:30Z' AND '2026-09-28T06:52:30Z' GROUP BY kind ORDER BY kind`);
  console.log('  ' + win.map((r) => `${r.kind}=${r.n}`).join('  '));
  const suspicious = win.filter((r) => /setting|config|save|tune|kill|system|note/.test(r.kind));
  console.log('  settings-related kinds in the +/-1min window: ' + (suspicious.map((r) => r.kind).join(', ') || 'NONE'));
  if (suspicious.length) await fail('something in the window could be the record — inspect it before claiming silence');

  console.log('\n=== 6. the sweep the direction claim rests on ===');
  const store = fs.readFileSync(path.join(ROOT, 'trading', 'store.js'), 'utf8');
  const sweep = /sweep-stop-cap\.js[\s\S]{0,240}/.exec(store);
  console.log(sweep ? '  found: ' + sweep[0].replace(/\s+/g, ' ').slice(0, 230) : '  ⚠ the sweep citation was NOT found in store.js — the direction claim cannot be made');
  if (!sweep) await fail('the sweep citation is missing from store.js');

  console.log('\n=== the row ===');
  const dup = await q(`SELECT id, state FROM Tasks WHERE name LIKE 'TRD-RSK-8:%'`);
  if (dup.length) { console.log(`  already recorded as #${dup[0].id} (state ${dup[0].state}) — nothing to do.`); await pool.close(); return; }
  if (NAME.length > 255) await fail('name too long');
  if (/[^\x20-\x7E]/.test(NAME)) await fail('name is not pure ASCII');
  console.log(`  "${NAME}" (${NAME.length} chars, info ${INFO.length} chars)`);
  if (!YES) { console.log('  DRY RUN — not written.'); await pool.close(); return; }
  const mx = (await q('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks'))[0];
  const anchor = (await q('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1456'))[0];
  const ins = await pool.request().input('name', NAME).input('info', INFO)
    .input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx.m) + 1)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id VALUES (@name, @info, @plannedStart, 1, 1, ${EDICT}, @sortOrder, SYSUTCDATETIME())`);
  const id = ins.recordset[0].id;
  const back = (await q(`SELECT state, active, sortOrder FROM Tasks WHERE id = ${id}`))[0];
  console.log(`  ✔ created as #${id} state=${back.state} active=${back.active} sortOrder=${back.sortOrder}`);
  const st = await q(`SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = ${EDICT} GROUP BY state`);
  console.log('\nedict 52 by state: ' + st.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
