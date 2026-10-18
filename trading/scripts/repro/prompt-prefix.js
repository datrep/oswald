// trading/scripts/repro/prompt-prefix.js — TRD-72 / TRD-78: WHERE does the prompt stop matching?
//
// WHY THIS EXISTS. TRD-78 says the 3-chair fan-out pays ~5.3k miss tokens three times, and its fix direction
// (1) is "move the volatile fields to the TAIL of the bundle — a stable prefix is the prerequisite". That
// direction is only actionable if we know WHICH byte breaks the match, and the two measurements on record
// disagree in an important way:
//   · "the byte-identical prefix across the 3 chairs is 754 characters" (the 10-line preamble + `YOU are the `)
//   · "the common prefix between consecutive wake bundles is 23-54 characters out of ~52,000"
// Those are different comparisons (across chairs, vs across wakes) and neither says where the first volatile
// byte is INSIDE the bundle. This measures all three, from the bundles the desk actually sent.
//
// ⚠ CORRECTED 2026-09-21 — THE PROMPT IS `bundle.text`, NOT `bundle`. `TradingPrompts.bundle` stores the
// JSON OBJECT (`{ ...buildBundleObj(), text: bundleTextFinal }`, aggregator.js:284/410/463) while the chairs
// receive `bundleTextFinal` (aggregator.js:112). So the second figure above — the one TRD-78 was built on —
// was measured on a string NO MODEL HAS EVER SEEN, and this harness repeated the mistake. Every measurement
// below now runs on the text, and the actionable form of the question is "where does the constant HEAD end",
// reported as a line boundary rather than a byte offset.
//
// Read-only. Usage: node trading/scripts/repro/prompt-prefix.js [hours]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const HOURS = Number(process.argv[2]) || 48;

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

// Where is the first character that DIFFERS from the other samples of the same wake? That byte is what a
// prefix cache must get past, so its offset is the whole question.
function firstVarianceOffset(texts) {
  if (texts.length < 2) return null;
  const min = Math.min(...texts.map((t) => t.length));
  for (let i = 0; i < min; i += 1) {
    const c = texts[0][i];
    if (texts.some((t) => t[i] !== c)) return i;
  }
  return min;
}

// Where a prefix ENDS, expressed as a LINE — the actionable form, because the fix direction is "move this
// block after that one" and a byte offset does not say which block that is.
function lineAt(text, offset) {
  const head = text.slice(0, offset);
  const lines = head.split('\n');
  return { line: lines.length, lastLine: (lines[lines.length - 1] || '').slice(0, 70) };
}

(async () => {
  const pool = await getPool();
  const rows = (await pool.request().query(
    `SELECT id, triggerType, bundle, model, usage, createdAt
       FROM TradingPrompts
      WHERE bundle IS NOT NULL AND createdAt >= DATEADD(hour, -${HOURS}, GETUTCDATE())
      ORDER BY id`,
  )).recordset;
  if (!rows.length) { console.log(`no bundles in the last ${HOURS}h`); return; }

  // The prompt is the NESTED text; JSON_VALUE is not usable here because it casts to nvarchar(4000) and
  // would silently truncate a ~14,000-character prompt. Parse in JS, and fall back to a bare string only
  // for rows old enough to have stored one.
  for (const r of rows) {
    let nested = null;
    try {
      const parsed = typeof r.bundle === 'string' ? JSON.parse(r.bundle) : r.bundle;
      nested = parsed && typeof parsed.text === 'string' ? parsed.text : null;
    } catch { nested = null; }
    r.text = nested
      || (typeof r.bundle === 'string' && !r.bundle.trimStart().startsWith('{') ? r.bundle : null);
  }
  const texts = rows.filter((r) => typeof r.text === 'string' && r.text.length > 0);
  console.log(`\n⚠ ${rows.length - texts.length} of ${rows.length} row(s) carry no \`text\` — excluded, because they are not the prompt`);

  console.log(`\n=== ${texts.length} prompt(s) (bundle.text) from the last ${HOURS}h ===`);
  console.log(`length (chars): min ${Math.min(...texts.map((r) => r.text.length))} · max ${Math.max(...texts.map((r) => r.text.length))} · mean ${Math.round(texts.reduce((a, r) => a + r.text.length, 0) / texts.length)}`);

  // --- 1. what the bundle OPENS with, because that is what a prefix cache sees first ----------------
  console.log('\n--- the first 160 characters of the prompt the NEWEST chair actually received ---');
  console.log(JSON.stringify(texts[texts.length - 1].text.slice(0, 160)));
  console.log('--- the same, 6 wakes ago (so the varying part is visible by eye) ---');
  console.log(JSON.stringify(texts[Math.max(0, texts.length - 6)].text.slice(0, 160)));

  // --- 2. rows written in the SAME MINUTE -----------------------------------------------------------
  // ⚠ THIS IS NOT "ACROSS THE 3 CHAIRS". The chair slot is not stored anywhere on the row, and a minute
  // bucket also catches unrelated callers — the run that produced the old "first differing byte at offset 2"
  // line had paired a `binding` prompt (28,585 chars) with an unlabelled one (3,837 chars), i.e. two
  // different callers, and reported the difference between THEM as a property of the fan-out. Kept only as
  // a grouping of same-minute rows, with its membership printed so it cannot be read as a chair set.
  const byWake = new Map();
  for (const r of texts) {
    const k = new Date(r.createdAt).toISOString().slice(0, 16); // minute bucket
    if (!byWake.has(k)) byWake.set(k, []);
    byWake.get(k).push(r);
  }
  const chairGroups = [...byWake.entries()].filter(([, v]) => v.length >= 2);
  console.log(`\n--- SAME-MINUTE ROWS: ${chairGroups.length} minute(s) with 2+ prompts (NOT necessarily 3 chairs) ---`);
  for (const [k, v] of chairGroups.slice(-5)) {
    const off = firstVarianceOffset(v.map((r) => r.text));
    console.log(`  ${k}  n=${v.length}  ids=${v.map((r) => r.id).join(',')}  [${v.map((r) => r.triggerType).join(',')}]  first differing byte at offset ${off}  (${((off / v[0].text.length) * 100).toFixed(1)}% into a ${v[0].text.length}-char PROMPT)`);
  }
  if (!chairGroups.length) console.log('  (none — so no chair fan-out has run inside this window)');

  // --- 3. across CONSECUTIVE WAKES, same chair slot --------------------------------------------------
  // The chair slot is not stored, so compare each bundle with the NEXT one after it: on a scheduled wake the
  // pipeline emits the chairs back to back, so the nearest same-slot predecessor is n+3.
  console.log('\n--- ACROSS WAKES (prompt i vs prompt i+3, the same chair slot on consecutive wakes) ---');
  let n3 = 0, sum3 = 0;
  for (let i = 0; i + 3 < texts.length; i += 1) {
    const l = commonPrefixLen(texts[i].text, texts[i + 3].text);
    sum3 += l; n3 += 1;
    if (n3 <= 8) {
      const at = lineAt(texts[i].text, l);
      console.log(`  #${texts[i].id} vs #${texts[i + 3].id}: common prefix ${l} chars — the constant head ends at LINE ${at.line} ("${at.lastLine}")`);
    }
  }
  if (n3) console.log(`  mean over ${n3} pairs: ${Math.round(sum3 / n3)} chars`);
  if (n3) {
    const mean = Math.round(sum3 / n3);
    const meanLen = Math.round(texts.reduce((a, r) => a + r.text.length, 0) / texts.length);
    console.log(`  ⇒ a prefix cache can match at most ${mean} of ~${meanLen} chars = ${((mean / meanLen) * 100).toFixed(1)}% of the prompt.`);
    console.log('    Compare THAT against the recorded hit ratio below: if the ratio is far below it, the');
    console.log('    provider is not matching what the bytes allow, and the finding is elsewhere.');
  }

  // --- 4. the cache numbers the desk actually recorded, per wake -------------------------------------
  console.log('\n--- recorded usage: hit vs miss per call (the number TRD-78 watches) ---');
  const per = rows.map((r) => {
    let u = {};
    try { u = typeof r.usage === 'string' ? JSON.parse(r.usage) : (r.usage || {}); } catch { u = {}; }
    const hit = Number(u.promptCacheHitTokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
    const miss = Number(u.promptCacheMissTokens ?? 0) || (Number(u.prompt_tokens || 0) - hit);
    return { id: r.id, hit, miss, total: hit + miss };
  }).filter((p) => p.total > 0);
  for (const p of per.slice(-8)) {
    console.log(`  #${p.id}  hit ${p.hit}  miss ${p.miss}  hit ratio ${p.total ? ((p.hit / p.total) * 100).toFixed(1) : 'n/a'}%`);
  }
  if (per.length) {
    const h = per.reduce((a, p) => a + p.hit, 0), t = per.reduce((a, p) => a + p.total, 0);
    console.log(`  overall: hit ${h} of ${t} = ${((h / t) * 100).toFixed(1)}%   (the report quotes ~34% per chair)`);
  }

  // --- 5. THE SAME QUESTION PER LABEL, FROM THE llm_call ROWS -----------------------------------------
  // TradingPrompts.usage says what a prompt COST; llm_call says WHICH CALLER paid it. Chair calls carry
  // `chair:<persona>`, which is the only way to read the fan-out's cache behaviour as a set — and the
  // fan-out costs 3 calls per wake against 1 for everything else, so the labels are what separate them.
  console.log('\n--- llm_call by label (hit / miss / chars / tokens) ---');
  const lab = (await pool.request().query(
    `SELECT TOP 300 payload FROM TradingEvents WHERE userId = 1 AND kind = 'llm_call' ORDER BY id DESC`,
  )).recordset.map((x) => { try { return JSON.parse(x.payload); } catch { return null; } }).filter(Boolean);
  const agg = new Map();
  for (const p of lab) {
    const k = String(p.label || 'unlabelled');
    const a = agg.get(k) || { n: 0, hit: 0, miss: 0, chars: 0, tokens: 0 };
    a.n += 1;
    a.hit += Number(p.cacheHit) || 0;
    a.miss += Number(p.cacheMiss) || 0;
    a.chars += Number(p.promptChars) || 0;
    a.tokens += Number(p.promptTokens) || 0;
    agg.set(k, a);
  }
  for (const [k, a] of [...agg.entries()].sort((x, y) => y[1].n - x[1].n)) {
    const total = a.hit + a.miss;
    console.log(`  ${k.padEnd(16)} n=${String(a.n).padStart(3)}  hit ${String(a.hit).padStart(7)}  miss ${String(a.miss).padStart(7)}  ratio ${total ? ((a.hit / total) * 100).toFixed(1) : 'n/a'}%  mean chars ${Math.round(a.chars / a.n)}  mean tokens ${Math.round(a.tokens / a.n)}`);
  }
  if (!agg.size) console.log('  (no llm_call rows yet)');
  console.log('  NOTE: a row reading `unlabelled` came from a caller that passes no label — ask, autopsy, central,');
  console.log('  pulse, review, shadowCall, waker and whitepaper all call callChat directly, so they cannot be');
  console.log('  separated from each other in this table.');
})().catch((e) => { console.error(e.message); process.exit(1); });
