// scripts/record-2026-09-28-tun2-resolver.js — appends what landed on TRD-TUN-2 (#1393), which gates TRD-RSK-7.
// Dry by default:  node scripts/record-2026-09-28-tun2-resolver.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ID = 1393;
const MARK = '##2026-09-28 resolver-unified##';
const ROOT = path.join(__dirname, '..');

const NOTE = `

${MARK}
★ **OPTION (a) IMPLEMENTED 2026-09-28 — ONE RESOLUTION ORDER, AND PROVENANCE BESIDE EVERY VALUE.**

WHAT CHANGED, in \`trading/agent/strategies/index.js\`:
- **\`list(settings, symbol = null)\` no longer resolves inline.** It delegated nothing before: it read
  \`overrides[s.id][p.key] ?? p.def\` with \`overrides = settings.strategies.params\` — the GLOBAL layer only —
  while the trading path resolves DEFAULTS -> params[id] -> symbolParams[symbol][id] via \`paramsFor\`. **Two
  independent implementations of one documented order**, and the tuner plus the Strategy tab read the one that
  cannot see the per-symbol layer. It now calls the single resolver, through a small \`resolveParam\` helper.
- **\`paramSource(settings, id, key, symbol)\` is NEW and exported**, answering which layer supplied a value
  (\`symbolParams\` > \`params\` > \`DEFAULTS\` > \`module-default\`), and every param in \`list()\` carries it as
  \`source\`. ★ The defect was INVISIBLE precisely because the answer carried no provenance, so a reader could not
  tell an effective value from a shadowed one — the flag is the fix, not decoration.
- **\`symbol\` is optional and defaults to null**, which reproduces the previous behaviour EXACTLY for every
  existing caller. The trading path (\`quant.js:589/919/951\`) is untouched: this moved the READER, not the gate.
- ⚠ **Absence is \`== null\`, not falsiness.** \`adxGate: 0\` is the entire point of the Gold override, and an
  \`if (!v)\` test would walk straight past it to the global 20 — the same defect in the opposite direction.

MEASURED, BEFORE vs AFTER (the two divergences that made this row real, now covered by tests):
| pair | \`list()\` said | \`paramsFor()\` said | \`list(settings, sym)\` now says |
| Gold.turtle.adxGate | 20 | **0** | **0** (source \`symbolParams\`) |
| Oil.turtle.donchianPeriod | 20 | **5** | **5** (source \`symbolParams\`) |
The invariant it now holds is the one this row asked for: **for every strategy, every param and every symbol,
\`list()\` and \`paramsFor()\` report the same value** — asserted directly in
\`test/strategy-param-resolution.test.js\` (7 tests, including a pin that the inline \`overrides[s.id]\` form
cannot return). Suite **1,633 / 1,632 pass / 0 fail / 1 skipped**; eslint exit 0; desk restarted (pid 25448).

⚠ **WHAT IS STILL OPEN, AND IT IS THE HALF THAT MATTERS FOR THE OPERATOR.** The CALLERS still pass no symbol:
\`tuner.js\` builds its messages from \`strategies.list(settings)\` and the Strategy tab renders the same call, so
both still DISPLAY the global layer for a strategy whose effective value differs by instrument. **The resolver can
now answer the question correctly; nobody has asked it yet.** That is a distinct change touching two surfaces (the
tuner and the Strategy tab), and a single-value display is inherently ambiguous once a value legitimately varies
by symbol — the honest rendering is to show the divergent set, not one number. \`binding.js\` already warns for
inert \`symbolParams\`, and the live measurement stands: **5 overrides, reachable 0, inert 5.**
⇒ **THIS ROW STAYS OPEN until the callers resolve per symbol (or flag the divergence).** TRD-RSK-7's precondition
is therefore still unmet, though it is now much closer: adding a profile LAYER no longer risks a THIRD resolver,
because there is only one left to extend.

⚠ ONE SELF-INFLICTED DELAY WORTH RECORDING: my first edit to this file reported success while only PART of it
applied — the duplicated \`module.exports\` line was the tell (\`paramSource, paramSource,\`), and the \`function
paramSource\` declaration was missing entirely, so the module threw on require. **A multi-part edit that reports a
single failure may still have applied some parts; read the file back before trusting the summary it printed.**`;
// ⚠ single template literal; the newline above is intentional.

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== re-measure the claims before writing them ===');
  const src = fs.readFileSync(path.join(ROOT, 'trading', 'agent', 'strategies', 'index.js'), 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const checks = [
    ['inline overrides[s.id] is GONE', !/overrides\[s\.id\]/.test(codeOnly)],
    ['list accepts a symbol', /function list\(settings, symbol = null\)/.test(codeOnly)],
    ['list delegates to resolveParam', /value: resolveParam\(settings, s\.id, p\.key, symbol, p\.def\)/.test(codeOnly)],
    ['resolveParam calls paramsFor', /function resolveParam\([\s\S]{0,200}const eff = paramsFor\(settings, id, symbol\)/.test(codeOnly)],
    ['paramSource is defined and exported', /function paramSource\(/.test(codeOnly) && /REGISTRY, get, list, paramsFor, paramSource,/.test(codeOnly)],
    ['no duplicated export entry', (codeOnly.match(/paramSource,/g) || []).length === 1],
    ['provenance is reported by list', /source: paramSource\(settings, s\.id, p\.key, symbol\)/.test(codeOnly)],
  ];
  for (const [label, ok] of checks) console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (checks.some(([, ok]) => !ok)) await fail('the implementation is not in the state this note describes');

  const strategies = require('../trading/agent/strategies');
  const S = { strategies: { params: { turtle: { adxGate: 20, donchianPeriod: 20 } }, symbolParams: { Gold: { turtle: { adxGate: 0 } }, Oil: { turtle: { donchianPeriod: 5 } } } } };
  const val = (sym, key) => strategies.list(S, sym).find((x) => x.id === 'turtle').params.find((p) => p.key === key).value;
  console.log(`  Gold.adxGate: list(no sym)=${val(null, 'adxGate')}  list(Gold)=${val('Gold', 'adxGate')}  paramsFor=${strategies.paramsFor(S, 'turtle', 'Gold').adxGate}`);
  if (val(null, 'adxGate') !== 20 || val('Gold', 'adxGate') !== 0) await fail('the two divergences do not resolve as claimed');
  if (strategies.paramsFor(S, 'turtle', 'Gold').adxGate !== val('Gold', 'adxGate')) await fail('list and paramsFor disagree — the invariant is broken');

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
