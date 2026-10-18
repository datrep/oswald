// scripts/wire-2026-09-25-replica-scope.js — give Silver / Sugar / Bitcoin / SGX the two surviving strategies.
//
// ★ THE BLOCKER THIS REMOVES. `symbolScope` held an EXPLICIT EMPTY LIST for each of these four symbols, and an
// explicit empty list beats both the `others` default and `strategies.enabled` under the scope rule — so they
// resolved to zero strategies and could not enter anything regardless of what the registry held.
//
// WHAT IT WRITES — `strategies.REPLICA_SCOPE` is the single source, not a list restated here:
//   strategies.enabled            += the eight replica ids
//   symbolScope[Silver|Sugar|Bitcoin|SGX] = that instrument's two replicas (survivor A's set + survivor C's set)
//   and the SUPERSEDED ids (survsilver, survbitcoin) are REMOVED from both `enabled` and the scope, because a
//   scope entry naming a removed strategy resolves to nothing and the symbol would look configured while being
//   unable to enter — the invisible-guard shape this desk keeps finding.
//
// Everything else in `symbolScope` is preserved key-for-key: Gold -> survgold and Oil -> survoil must not move.
//
//   node scripts/wire-2026-09-25-replica-scope.js          # dry run
//   node scripts/wire-2026-09-25-replica-scope.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');
const store = require('../trading/store');
const strategies = require('../trading/agent/strategies');
const binding = require('../trading/agent/binding');
const scopeResolution = require('../trading/scopeResolution');

const YES = process.argv.includes('--yes');
const USER = 1;
const DEAD = ['survsilver', 'survsugar', 'survbitcoin', 'survsgx'];

(async () => {
  // The registration is not believed until each id RESOLVES and carries a liveSignal — a registry key mapping to
  // nothing would make every downstream check silently skip the symbol.
  const wanted = strategies.REPLICA_IDS;
  console.log(`\nregistry holds ${Object.keys(strategies.REGISTRY).length}; replicas wanted: ${wanted.length}`);
  for (const { ids } of strategies.REPLICA_SCOPE) {
    for (const id of ids) {
      const m = strategies.get(id);
      console.log(`  ${id.padEnd(14)} -> ${m ? `OK ${m.replicates} symbols=${JSON.stringify(m.symbols)} liveSignal=${typeof m.liveSignal}` : '*** DID NOT RESOLVE ***'}`);
    }
  }
  const missing = wanted.filter((id) => !strategies.get(id));
  if (missing.length) { console.error(`\nABORT: ${missing.join(', ')} did not resolve`); process.exit(1); }

  const settings = await store.getSettings(USER);
  const st = settings.strategies || {};
  const scope = { ...(st.symbolScope || {}) };

  const add = {};
  for (const { symbol, ids } of strategies.REPLICA_SCOPE) {
    // ⚠ REPLACES the symbol's list rather than appending: the four empty lists are the blocker, and the
    // superseded ids must not survive alongside their replacements.
    add[symbol] = ids;
  }
  const enabled = [...new Set([...(st.enabled || []), ...wanted])].filter((id) => !DEAD.includes(id));

  console.log(`\nenabled : ${JSON.stringify(st.enabled)}\n       -> ${JSON.stringify(enabled)}`);
  for (const [sym, next] of Object.entries(add)) {
    console.log(`  ${sym.padEnd(8)} ${JSON.stringify(scope[sym])} -> ${JSON.stringify(next)}`);
  }
  const lingering = DEAD.filter((id) => enabled.includes(id) || Object.values(add).some((v) => v.includes(id)));
  console.log(`  superseded ids still referenced after the write: ${lingering.length ? lingering.join(', ') : 'none'}`);

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await poolClose(); return; }

  const saved = await store.saveSettings(USER, { strategies: { ...st, enabled, symbolScope: { ...scope, ...add } } });
  // Read back FROM THE STORE, not from the object just built: `saveSettings` is the chokepoint under test.
  const after = (saved && saved.strategies) || (await store.getSettings(USER)).strategies;
  console.log(`\nread back enabled: ${JSON.stringify(after.enabled)}`);
  console.log(`read back scope  : ${JSON.stringify(after.symbolScope)}`);

  console.log('\n  scope resolution AFTER the write (the question the scout asks):');
  for (const w of (settings.watchlist && settings.watchlist.symbols) || []) {
    const ids = binding.inScopeIds({ strategies: after }, w.symbol).ids;
    const runs = ids.filter((id) => { const m = strategies.get(id); return m && m.liveSignal && (!m.symbols || m.symbols.includes(w.symbol)); });
    console.log(`    ${String(w.symbol).padEnd(16)} ${JSON.stringify(ids).padEnd(34)} ${ids.length ? (runs.length === ids.length ? 'CAN ENTER' : '*** partially runnable ***') : '*** CANNOT ENTER ***'}`);
  }
  const universe = scopeResolution.watchlistSymbols((await store.getSettings(USER)).watchlist);
  const dead = scopeResolution.unreachableEnabled(after.enabled || [], after.symbolScope || {}, universe);
  console.log(`\n  unreachable enabled ids: ${dead.length ? JSON.stringify(dead) : 'none'}  (universe ${universe.length})`);
  await poolClose();

  function poolClose() { return getPool().then((p) => p.close()); }
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
