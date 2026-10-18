// trading/scripts/bundle-anatomy.js — what does the chair prompt actually cost, and of what?
//
//   node trading/scripts/bundle-anatomy.js            # the newest stored bundle
//   node trading/scripts/bundle-anatomy.js 4761       # a specific prompt row
//
// WHY IT READS THE DESK'S OWN ROWS rather than re-rendering the bundle: a fixture drifts from the builder,
// and the claim it would be used to support is a claim about what the chairs were actually sent. This reads
// `TradingPrompts.bundle`, which is that.
//
// ★ IT DISTINGUISHES TWO ARTEFACTS THAT ARE EASY TO CONFLATE (TRD-73):
//   the CHAIR PROMPT      = `$.text`, the rendered bundle, ~2,200 tokens. This is what is sent.
//   the STORED AUDIT ROW  = the whole JSON, ~5,200 tokens: the structured keys PLUS `text`, kept so the row
//                           can be replayed. It is NOT the prompt.
// A cost claim that uses the stored row's size is overstating the prompt by ~2.4x.
//
// ★ THREE MEASUREMENT TRAPS THIS SCRIPT EXISTS TO AVOID, each of which produced a plausible wrong number:
//   1. The section markers live INSIDE a JSON string. Splitting the raw column on `--- SECTION ---` finds
//      nothing and reports a clean-looking "100% header".
//   2. `JSON_VALUE` returns NULL for a string longer than 4,000 characters — indistinguishable from "the key
//      is absent". Use OPENJSON for long values.
//   3. Attributing a whole string VALUE to a substring match charges the entire document. Count LINES.
//
// Read-only.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { getPool } = require('../../shared/db');

const tok = (chars) => Math.round(chars / 4); // the desk's own rough ratio

(async () => {
  const wantId = process.argv[2] ? Number(process.argv[2]) : null;
  const pool = await getPool();
  const r = await pool.request()
    .input('id', wantId || 0)
    .query(`
      SELECT TOP 8 id, createdAt, triggerType, LEN(CAST(bundle AS NVARCHAR(MAX))) AS len,
             CAST(bundle AS NVARCHAR(MAX)) AS bundle
        FROM TradingPrompts
       WHERE bundle IS NOT NULL AND (@id = 0 OR id <= @id)
       ORDER BY id DESC`);

  if (!r.recordset.length) { console.log('no stored bundles'); process.exit(1); }
  const iso = (v) => { try { return new Date(v).toISOString(); } catch { return String(v); } };
  const pick = r.recordset.find((x) => x.id === wantId) || r.recordset[0];

  console.log('recent stored rows (AUDIT record = structured keys + text):');
  for (const row of r.recordset) {
    console.log(`  #${row.id}  ${iso(row.createdAt)}  ${String(row.triggerType || '').padEnd(10)} ${String(row.len).padStart(7)} chars  ~${String(tok(row.len)).padStart(6)} tokens`);
  }

  const raw = String(pick.bundle || '');
  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* not JSON */ }
  if (!obj || typeof obj !== 'object') { console.log('\nnot JSON — nothing to measure'); process.exit(1); }

  console.log(`\n#${pick.id} (${iso(pick.createdAt)})`);
  console.log(`  stored audit row : ${String(raw.length).padStart(7)} chars  ~${String(tok(raw.length)).padStart(6)} tokens`);
  if (typeof obj.text === 'string') {
    console.log(`  CHAIR PROMPT ($.text): ${String(obj.text.length).padStart(3)} chars  ~${String(tok(obj.text.length)).padStart(6)} tokens   <- the number that matters`);
  }

  // ---- structured keys (the audit row, NOT the prompt) ----
  const rows = Object.entries(obj).map(([k, v]) => {
    const s = JSON.stringify(v);
    return { name: k, chars: s === undefined ? 0 : s.length };
  }).sort((a, z) => z.chars - a.chars);
  console.log('\nby top-level key (audit row):');
  console.log('  key'.padEnd(30) + 'chars'.padStart(9) + 'share'.padStart(8));
  for (const x of rows) {
    console.log(`  ${x.name.slice(0, 27).padEnd(28)}${String(x.chars).padStart(9)}${((x.chars / raw.length) * 100).toFixed(1).padStart(7)}%`);
  }

  // ---- the prompt, section by section ----
  if (typeof obj.text === 'string') {
    const t = obj.text;
    const blocks = [];
    let cur = { name: '(preamble: account + hard rules + session)', lines: [] };
    for (const ln of t.split('\n')) {
      const m = ln.match(/^---\s*(.+?)\s*---\s*$/);
      if (m) { blocks.push(cur); cur = { name: m[1], lines: [] }; } else cur.lines.push(ln);
    }
    blocks.push(cur);
    const srows = blocks.map((x) => ({ name: x.name, chars: x.lines.join('\n').length })).sort((a, z) => z.chars - a.chars);
    console.log(`\nthe CHAIR PROMPT by section (${t.length} chars):`);
    console.log('  section'.padEnd(58) + 'chars'.padStart(8) + 'share'.padStart(8));
    for (const x of srows) {
      console.log(`  ${x.name.slice(0, 55).padEnd(56)}${String(x.chars).padStart(8)}${((x.chars / t.length) * 100).toFixed(1).padStart(7)}%`);
    }
  }

  // ---- how much is about symbols no strategy can trade ----
  const settings = await pool.request().query(`SELECT TOP 1 CAST(settings AS NVARCHAR(MAX)) AS s FROM TradingSettings`);
  const scope = JSON.parse((settings.recordset[0] || {}).s || '{}').strategies?.symbolScope || {};
  const barred = Object.entries(scope).filter(([, l]) => Array.isArray(l) && l.length === 0).map(([k]) => k);
  const canTrade = Object.entries(scope).filter(([, l]) => Array.isArray(l) && l.length > 0).map(([k]) => k);
  console.log(`\nstrategies.symbolScope: can trade = ${canTrade.join(', ') || 'none'} | cannot = ${barred.join(', ') || 'none'}`);

  // COUNT LINES (trap 3). A whole-document value charged to its first match over-attributes by the size of the
  // document — the first version of this reported 45.9% where the truth was 12.1%.
  const perKey = {};
  const countLines = (key, s) => {
    for (const ln of String(s).split('\n')) {
      if (barred.some((b) => ln.includes(b))) perKey[key] = (perKey[key] || 0) + ln.length + 1;
    }
  };
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') countLines(k, v);
    else if (v && typeof v === 'object') for (const ln of JSON.stringify(v).split(/[[,{]/)) countLines(k, ln);
  }
  const total = Object.values(perKey).reduce((s, n) => s + n, 0);
  console.log(`\nLINES naming a symbol NO strategy can trade: ${total} chars = ${((total / raw.length) * 100).toFixed(2)}% of the audit row`);
  for (const [k, n] of Object.entries(perKey).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)}${String(n).padStart(8)} chars`);
  }
  process.exit(0);
})().catch((e) => { console.error('bundle-anatomy error:', e.message); process.exit(2); });
