// scripts/fix-2026-09-28-budget-and-arabica-loop.js — (1) raise budget.totalDaily, verified through the gate
// itself; (2) measure WHY the desk re-decides an Arabica entry every ~2 minutes.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const USER = 1;
const NEW_TOTAL = 3000000;

const store = require('../trading/store');
const budget = require('../trading/agent/budget');
const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return undefined; } };

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== PART 1. RAISE budget.totalDaily ===');
  const before = await store.getSettings(USER);
  const bsB = before.budget || {};
  const sumPer = Object.values(bsB.perConsumer || {}).reduce((a, b) => a + Number(b || 0), 0);
  console.log(`  totalDaily now        = ${bsB.totalDaily}`);
  console.log(`  sum of per-consumer   = ${sumPer}`);
  console.log(`  -> the total is ${(sumPer / Number(bsB.totalDaily)).toFixed(1)}x SMALLER than the sum of its parts`);
  const preGate = await budget.allow(USER, before, 'chair');
  console.log(`  chair gate BEFORE: allowed=${preGate.allowed} reason=${preGate.reason}`);

  if (!YES) console.log('  DRY RUN — not written.');
  else {
    const after = await store.saveSettings(USER, { budget: { totalDaily: NEW_TOTAL } });
    console.log(`  totalDaily after      = ${(after.budget || {}).totalDaily}`);
    const postGate = await budget.allow(USER, after, 'chair');
    console.log(`  chair gate AFTER:  allowed=${postGate.allowed} reason=${postGate.reason} used=${postGate.used} cap=${postGate.cap}`);
    for (const c of ['review', 'shadow', 'pulse']) {
      const g = await budget.allow(USER, after, c);
      console.log(`  gate(${c.padEnd(7)}) allowed=${g.allowed} reason=${g.reason || '-'}`);
    }
    if (!postGate.allowed) { console.error('  *** THE GATE STILL REFUSES — the bump did not take effect'); await pool.close(); process.exit(1); }
    console.log('  \u2714 the chair is ALLOWED again');
    const j = (await q(`SELECT TOP 1 id, createdAt, payload FROM TradingEvents WHERE kind='settings_write' ORDER BY id DESC`))[0];
    const jp = J(j.payload) || {};
    console.log(`  journal: #${j.id} ${j.createdAt.toISOString()} changed=${jp.changed} keys=${JSON.stringify((jp.keys || []).slice(0, 5))}`);
    const ch = (jp.changes || []).find((c) => /totalDaily/.test(c.key));
    console.log(`  journal recorded: ${ch ? `${ch.key}: ${JSON.stringify(ch.before)} -> ${JSON.stringify(ch.after)}` : '(no totalDaily entry — INVESTIGATE)'}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== PART 2. WHY is the desk re-deciding an Arabica entry every ~2 minutes? ===');
  const dec = await q(`SELECT TOP 14 id, createdAt, payload FROM TradingEvents WHERE kind='decision'
      AND payload LIKE '%Arabica%' ORDER BY id DESC`);
  console.log('  time                       action  size     chairVote   sessionLock  blockedReason');
  let prev = null;
  for (const d of dec.slice().reverse()) {
    const p = J(d.payload) || {};
    const gap = prev ? ((d.createdAt - prev) / 1000).toFixed(0) + 's' : '';
    console.log(`  ${d.createdAt.toISOString()}  ${String(p.action).padEnd(7)} ${String(p.size).padEnd(8)} ${String(p.chairVote).padEnd(11)} ${String(p.sessionLock).padEnd(12)} ${p.blockedReason || '-'}   ${gap}`);
    prev = d.createdAt;
  }

  console.log('\n=== the WAKES behind them: trigger and what they claim to be doing ===');
  for (const w of await q(`SELECT TOP 12 id, createdAt, payload FROM TradingEvents WHERE kind='wake'
      AND payload LIKE '%Arabica%' ORDER BY id DESC`)) {
    const p = J(w.payload) || {};
    console.log(`  #${w.id} ${w.createdAt.toISOString()} trig=${String(p.trigger).padEnd(9)} action=${String(p.action).padEnd(7)} symbol=${String(p.symbol).padEnd(16)} withSignal=${p.withSignal ?? '-'} positions=${p.positions} llm=${p.llmCalled}`);
    for (const k of Object.keys(p)) if (/micro|prox|reason|signal|quant/i.test(k)) {
      const v = typeof p[k] === 'string' ? p[k] : JSON.stringify(p[k]);
      console.log(`      ${k} = ${String(v).slice(0, 200)}`);
    }
  }

  console.log('\n=== the micro-wake settings and the proximity rule ===');
  const s2 = await store.getSettings(USER);
  console.log('  wake = ' + JSON.stringify(s2.wake));

  console.log('\n=== is there any Arabica POSITION the micro-wake could be watching? ===');
  const tr = await q(`SELECT id, symbol, status, openAt FROM Trades WHERE symbol='Arabica Coffee' ORDER BY id DESC`);
  for (const t of tr.slice(0, 6)) console.log(`  #${t.id} status=${t.status} open=${t.openAt.toISOString()}`);
  console.log(`  (${tr.filter((t) => t.status === 'open').length} open)`);

  console.log('\n=== did ANY of them reach the venue? (my guard should have stopped them) ===');
  const oa = await q(`SELECT TOP 8 id, createdAt, JSON_VALUE(payload,'$.order.symbol') AS sym, JSON_VALUE(payload,'$.attempts[0].ok') AS ok
      FROM TradingEvents WHERE kind='order_attempt' AND payload LIKE '%Arabica%' ORDER BY id DESC`);
  console.log(`  order_attempt rows for Arabica (newest): ${oa.length}`);
  for (const r of oa) console.log(`  #${r.id} ${r.createdAt.toISOString()} ok=${r.ok}`);
  const ob = await q(`SELECT TOP 8 id, createdAt, JSON_VALUE(payload,'$.reason') AS reason FROM TradingEvents
      WHERE kind='order_blocked' AND payload LIKE '%Arabica%' ORDER BY id DESC`);
  console.log(`  order_blocked for Arabica (newest): ${ob.length}`);
  for (const r of ob) console.log(`  #${r.id} ${r.createdAt.toISOString()} reason=${r.reason}`);

  console.log('\n=== and what the WAKE-list actually logged for the newest ones ===');
  for (const r of await q(`SELECT TOP 8 id, createdAt, kind, JSON_VALUE(payload,'$.reason') AS reason,
      LEFT(CAST(payload AS nvarchar(max)), 200) AS p FROM TradingEvents
      WHERE createdAt >= DATEADD(minute, -20, GETUTCDATE()) AND payload LIKE '%Arabica%' ORDER BY id DESC`))
    console.log(`  #${r.id} ${r.createdAt.toISOString()} ${String(r.kind).padEnd(16)} ${String(r.reason || '').slice(0, 60)}`);
  console.log('  table "TradingEvents" latest rows overall:');
  for (const r of await q(`SELECT TOP 6 id, createdAt, kind FROM TradingEvents ORDER BY id DESC`))
    console.log(`  #${r.id} ${r.createdAt.toISOString()} ${r.kind}`);

  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
