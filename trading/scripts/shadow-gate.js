// trading/scripts/shadow-gate.js — TRD-SHW-3 (2026-09-14).
//
// THE RUNNER for the pre-registered promotion gate (agent/shadowGate.js). It
// fetches the shadow ledger and the bars those calls need, hands them to the pure
// gate, and writes the report.
//
//   node trading/scripts/shadow-gate.js [--looks N]
//
// READ-ONLY against the desk: it reads ShadowSignals and PriceBars, writes one
// markdown file under trading/reports/, and changes no setting and places no
// order. Safe to run live.
//
// ALPHA SPENDING IS AUTOMATIC AND DELIBERATE. Every report is a LOOK at the same
// data, so running this script repeatedly and keeping the best result is the exact
// failure mode the pre-registration exists to prevent. `looks` therefore defaults
// to the number of prior reports already on disk plus one, and the gate tightens
// its boundary accordingly — you cannot quietly take a second look for free.
'use strict';

const path = require('path');
const fs = require('fs');
const repo = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(repo, '.env') });

const store = require('../store');
const gate = require('../agent/shadowGate');

const USER_ID = 1;
const REPORT_DIR = path.join(__dirname, '..', 'reports');
const BAR_LIMIT = 400; // the scorer's own depth; enough for C to have somewhere to enter

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function priorLooks() {
  try {
    return fs.readdirSync(REPORT_DIR).filter((f) => /^shadow-gate-\d{4}-\d{2}-\d{2}\.md$/.test(f)).length;
  } catch { return 0; }
}

const fmt = (n, dp = 3) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(dp));

async function main() {
  const signals = await store.listShadowSignals(USER_ID, { limit: 5000 });

  // Prefetch one bar series per traded symbol|venue. barsFor must be SYNCHRONOUS
  // because baseline C draws from it inside the pure gate, so every series the
  // gate could ask for has to be resident before the call.
  const keys = [...new Set(signals
    .filter((r) => r.direction === 'buy' || r.direction === 'sell')
    .map((r) => `${r.symbol}|${r.venue}`))];
  const cache = new Map();
  for (const k of keys) {
    const [symbol, venue] = k.split('|');
    const bars = await store.listBars(USER_ID, { timeframe: '1h', symbol, venue, limit: BAR_LIMIT })
      .catch(() => []);
    cache.set(k, bars);
  }

  const looks = Number(arg('looks', priorLooks() + 1)) || 1;
  const report = gate.evaluateShadowGate({
    signals,
    barsFor: (row) => cache.get(`${row.symbol}|${row.venue}`) || [],
    looks,
  });

  console.log(`shadow gate — prompt ${report.promptVersion}, looks ${looks}`);
  console.log(`  ${report.gate.message}`);
  console.log(`  recorded ${report.counts.totalCalls} · directional ${report.counts.directional}`
    + ` · scored ${report.counts.yes} · awaiting horizon ${report.counts.unscoredDirectional}`);
  console.log(`  bars cached: ${cache.size} series (${[...cache.values()].reduce((a, b) => a + b.length, 0)} bars)`);

  if (!report.tests.run) {
    console.log('  NOT RUN — no test is computed while a gate is closed.');
    console.log(`  sample so far: n=${report.sample.n} meanR ${fmt(report.sample.meanR)}`
      + ` win ${fmt(report.sample.winPct, 1)}%`);
    return;
  }

  console.log('');
  console.log('  baselines (R units)   A shadow   B unmirrored-long   C random-entry');
  console.log(`                        ${fmt(report.baselines.A_shadow.meanR).padStart(7)}`
    + `${fmt(report.baselines.B_unmirroredLong.meanR).padStart(18)}`
    + `${fmt(report.baselines.C_randomEntry.meanR).padStart(17)}`);
  console.log('');
  for (const t of report.tests.family) {
    console.log(`  ${t.id.padEnd(14)} n=${String(t.n).padStart(3)}  diff ${fmt(t.mean)}`
      + `  [${fmt(t.lower)}, ${fmt(t.upper)}]  p=${t.p.toFixed(4)}  ${t.significant ? 'SIGNIFICANT' : '-'}`);
  }
  console.log(`  BH q=${report.bh.q} declared ${report.bh.declared} of ${report.bh.m}`);
  console.log(`  VERDICT: ${report.verdict}`);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(REPORT_DIR, `shadow-gate-${stamp}.md`);
  fs.writeFileSync(file, gate.renderReport(report) + '\n', 'utf8');
  console.log(`  report -> ${path.relative(repo, file)}`);
}

main().catch((e) => {
  console.error('shadow-gate failed:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
