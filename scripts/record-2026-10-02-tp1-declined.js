// scripts/record-2026-10-02-tp1-declined.js — APPENDS the decline decision to TRD-TP-1 (#1412).
// The owner delegated D-2 (2026-10-02); this records the agent call. Appends, never replaces. Dry by default.
//   node scripts/record-2026-10-02-tp1-declined.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const M = '##2026-10-02 anchor-flip-declined##';

const ADD = `
${M}
★ DECISION (delegated by the owner 2026-10-02; agent call, recorded because this row owns the question): **THE ANCHOR FLIP DOES NOT SHIP. Route (2) stays built and OFF; the live 6% offset is untouched by this decision.**

WHY, in four measurements:
 1. The +0.46R swing was measured on a SUBSET SELECTED BY THE DEFECT — the 25 post-cap tickets that ran >1.6R. On the WHOLE recorded population it does not survive: the offline exit re-simulation (pre-declared family, n=138 desk trades, mechanics read from code — always-on 2xATR peak trail, TP at the DECISION-price anchor + the live 6% offset) puts the as-declared-1.5R-target arm at **P1 = +0.073R/trade, p = 0.48 (v1); the faithful fixed-stop+TP1.5 arm E5 = +0.077R, p = 0.47 (v2) — both null.**
 2. Sanity holds: the faithful emulation tracks the actual record (E0 p = 0.50) and E5 reproduces v1's P1 (+0.074 -> +0.077) — the engine is not why the result is null.
 3. Held-out (yahoo, pre-2026-08-31, two bar sets): no TP-anchor variant beats the pooled drift (E1 +0.115 p .19 / E2 +0.125 p .16 — they do not even clear the uncorrected 0.05 bar); the pooled "edges" decompose to long-side drift, not exit geometry.
 4. The mechanism is already partially compensated: the 6% offset (live since 10-02 05:29Z) prices TMs ~= 1.41R; the residue the anchor would recover is inside a null at this sample size.

REOPEN CRITERIA (either, and only via a NEW pre-registration): (a) post-prune era telemetry shows systematic achieved-vs-declared R:R decay beyond what the 6% offset compensates (TP-side leakage); or (b) a fresh replay on the post-prune population with its own held-out slicing clears the corrected bar.
★ DO NOT flip during the TRD-PRU-1 window — one change per era; attribution is the point.
Refs: trading/docs/exit-resim-2026-10-02.md · trading/docs/exit-resim-v2-oos-2026-10-02.md · trading/docs/phase2-investigation-2026-10-02.md (§5,§6) · trading/docs/trd-pru-1-pre-registration-2026-10-02.md (§5).
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1412`);
  if (!cur.recordset.length) { console.error('#1412 not found — aborting'); process.exit(1); }
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${M}%'`);
  const c = cur.recordset[0];
  console.log(`#1412 TRD-TP-1 state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — skipped'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = 1412`);
  console.log('✔ #1412 TRD-TP-1 appended');
  const chk = await pool.request().query(`SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1412`);
  console.log(`read-back: #1412 state=${chk.recordset[0].state} info=${chk.recordset[0].len}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
