// trading/scripts/ui-control-audit.js
//
// WHY THIS EXISTS. `trading/docs/UI_FLOW_AUDIT_2026-09-17.md` §8 states it plainly: "83 test files, 844
// tests — and zero cover the UI. Nothing under test/ touches trading/public/**, so every UI finding here is
// unpinned by construction: no test asserts that a panel renders, that a chip updates on a tier change, that
// the alerts table has rows, or that a control has a HANDLER." Its closing thesis is that findings landed
// almost exclusively in the modules and surfaces with no pinning test.
//
// So "some of the buttons don't do what they're supposed to do" is not a vague complaint — it is the
// predictable output of a UI with no pinning layer. This script is the cheapest half of that layer, and it
// is honest about which half it is: it is STATIC. It proves a control is wired to SOMETHING; it cannot prove
// the something is correct. A control that is wired to a handler which does nothing is wired, and this script
// will call it wired. The dynamic half (drive the flow, assert the terminal state) is a separate job.
//
// WHAT IT MEASURES, in descending order of confidence:
//   A. DEAD CONTROLS      — a clickable element in index.html that NO line of JS ever names. It renders, it
//                           looks pressable, and pressing it cannot do anything. This is the desk's own
//                           named defect class ("a control that renders but does nothing").
//   B. DEAD DATA HOOKS    — a data-* attribute used to drive behaviour (data-tab, data-tf, ...) that appears
//                           in the HTML and nowhere in the JS. Same class, different wiring style.
//   C. BROKEN REFERENCES  — an id the JS names that the HTML never declares AND no JS template creates. The
//                           `if ($('x'))` guard idiom means these fail SILENTLY: the guard is there, the
//                           branch never runs, and nothing reports it.
//   D. GUARDED BINDINGS   — a binding written behind `if ($('x'))`, listed separately because that idiom is
//                           exactly how a broken reference hides. Counted, not judged.
//
// Usage:  node trading/scripts/ui-control-audit.js [--json]
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HTML = path.join(ROOT, 'trading', 'public', 'index.html');
const JS_DIR = path.join(ROOT, 'trading', 'public', 'js');
const JSON_OUT = process.argv.includes('--json');

const html = fs.readFileSync(HTML, 'utf8');
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
const js = jsFiles.map((f) => ({ file: f, text: fs.readFileSync(path.join(JS_DIR, f), 'utf8') }));
const jsAll = js.map((j) => j.text).join('\n');

// A comment in JS is not a reference. Strip line comments and block comments before searching, or a control
// named only inside a comment reads as wired. (The same trap the repo's own UI tests document.)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const jsCode = strip(jsAll);

// ── Parse the HTML controls ──────────────────────────────────────────────────────────────────────────
// Line-anchored so an id inside a long attribute string cannot be mistaken for a declaration.
// ★ matchAll, NOT match: `String.match` returns only the FIRST match per line, and this markup puts several
// controls on one line (`<h2 ...><button id="btn-wake"><button id="btn-wake-pause"></h2>`, and the equity
// strip carries four ids). Using `.match` here silently dropped every id after the first on such a line and
// then reported those controls as "named by the JS but never declared" — 11 false positives, all mine.
const htmlLines = html.split('\n');
const controls = [];
const htmlIds = new Set();
htmlLines.forEach((line, i) => {
  const tag = (line.match(/<\s*([a-zA-Z][\w-]*)/) || [, '?'])[1].toLowerCase();
  const hasInlineOnclick = /\son(click|change|input)\s*=/.test(line);
  const idsOnLine = [...line.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const dataOnLine = [...line.matchAll(/\s(data-[a-z0-9-]+)\s*=/g)].map((m) => m[1]);
  for (const id of idsOnLine) {
    htmlIds.add(id);
    const isControl = ['button', 'input', 'select', 'textarea', 'a'].includes(tag);
    controls.push({
      id, tag, line: i + 1, isControl, hasInlineOnclick, dataOnLine,
      // A control is only "clickable" if it is something a person presses.
      clickable: tag === 'button' || tag === 'a' || (tag === 'input' && !/type="(text|number|password|search)"/.test(line)),
    });
  }
});

// ── Parse JS-created ids, so a dynamically rendered row is not reported as a broken reference ────────
const jsIds = new Set();
for (const m of jsCode.matchAll(/id="([^"$]+)"/g)) jsIds.add(m[1]);          // template-string elements
for (const m of jsCode.matchAll(/\.id\s*=\s*'([^']+)'/g)) jsIds.add(m[1]);   // el.id = '...'

// ── Classify each control ────────────────────────────────────────────────────────────────────────────
const namePattern = (id) => {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\$|querySelector|getElementById)\\s*\\(\\s*['"]#?${esc}['"]`, 'g');
};
const bindPattern = (id) => {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // $('x').onclick = ...   |   $('x').addEventListener('click', ...)   |   with '#' for querySelector
  return new RegExp(`(?:\\$|getElementById)\\s*\\(\\s*['"]${esc}['"]\\s*\\)\\s*\\.\\s*(?:onclick|onchange|oninput|onsubmit)\\s*=|`
    + `(?:\\$|getElementById)\\s*\\(\\s*['"]${esc}['"]\\s*\\)\\s*\\.\\s*addEventListener\\s*\\(\\s*['"](?:click|change|input|submit)['"]`, 'g');
};
const guardedPattern = (id) => {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`if\\s*\\(\\s*\\$\\s*\\(\\s*['"]${esc}['"]\\s*\\)\\s*\\)`);
};

const dead = [];
const bound = [];
const readOnly = [];
const guarded = [];
const delegated = [];
const hooked = [];

for (const c of controls) {
  const named = namePattern(c.id).test(jsCode);
  const boundNow = bindPattern(c.id).test(jsCode);
  const isGuarded = guardedPattern(c.id).test(jsCode);
  // ★ A CONTROL IS NOT DEAD JUST BECAUSE `$('id').onclick` IS ABSENT. This file wires controls three other
  // ways, all of which my first pass missed and then reported as "wired to nothing" — six false positives:
  //   1. DELEGATION   app.js:3511  document.querySelectorAll('#tab-prices [data-tf]').forEach(b => b.onclick = ...)
  //                   → tf-5m / tf-15m / tf-4h have no id-based binding and are fully live.
  //   2. ARRAY LOOPS  app.js:3770  for (const [id, which] of [['btn-test-sql','sql'], ...])
  //                   → btn-test-sql / btn-test-model / btn-test-bridge are live the same way.
  //   3. dataset.*    a control driven by its data-* attribute rather than its id.
  // So "bound" is a CONFIDENT claim (a direct id-based handler) while "named anywhere in the JS as a quoted
  // string" is the weaker claim that keeps DEAD honest. DEAD now means: this id appears NOWHERE in the
  // JS, in any form — which is the only version of the claim worth making.
  c.named = named;
  c.bound = boundNow || c.hasInlineOnclick;
  c.guarded = isGuarded;
  c.mentioned = jsCode.includes(`'${c.id}'`) || jsCode.includes(`"${c.id}"`);
  // ★ AND THE THIRD FALSE POSITIVE: a control bound ONLY by a data hook. `#tf-5m` is bound by
  // `#tab-prices [data-tf]` at app.js:3511 and never named by its id, so the id-string test called it dead.
  // A control carrying a hook the JS actually reads is wired, whatever its id says.
  c.hookBound = (c.dataOnLine || []).some((a) => {
    const camel = a.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    return jsCode.includes(`dataset.${camel}`) || jsCode.includes(`[${a}]`);
  });

  if (c.bound) bound.push(c);
  else if (c.hookBound) hooked.push(c);
  else if (c.mentioned) delegated.push(c);
  else if (named) readOnly.push(c);
  else dead.push(c);   // not named anywhere in the JS, in any form, and carries no live hook
}

// A DEAD control is only interesting if it is genuinely clickable. An input that is never named is also
// dead (nothing reads it), but the severity differs, so they are reported apart.
const deadClickable = dead.filter((c) => c.clickable);
const deadInput = dead.filter((c) => !c.clickable);

// ── data-* hooks ─────────────────────────────────────────────────────────────────────────────────────
// The tab bar and timeframe pickers are driven by data attributes, not ids: `<button data-tab="...">` has no
// id at all, so the id scan above cannot see whether it is wired.
const dataAttrs = new Map();
for (const line of htmlLines) {
  for (const m of line.matchAll(/\s(data-[a-z0-9-]+)\s*=/g)) {
    dataAttrs.set(m[1], (dataAttrs.get(m[1]) || 0) + 1);
  }
}
const deadHooks = [];
const liveHooks = [];
for (const [attr, count] of [...dataAttrs.entries()].sort()) {
  const camel = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const used = jsCode.includes(`dataset.${camel}`) || jsCode.includes(attr) || jsCode.includes(`[${attr}]`);
  (used ? liveHooks : deadHooks).push({ attr, count });
}

// ── JS → HTML broken references ──────────────────────────────────────────────────────────────────────
const referenced = new Map();
for (const m of jsCode.matchAll(/(?:\$|getElementById)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
  const id = m[1].replace(/^#/, '');
  if (id) referenced.set(id, (referenced.get(id) || 0) + 1);
}
const broken = [...referenced.entries()]
  .filter(([id]) => !htmlIds.has(id) && !jsIds.has(id))
  .sort((a, b) => b[1] - a[1]);

// ── Report ───────────────────────────────────────────────────────────────────────────────────────────
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : '—');

if (JSON_OUT) {
  console.log(JSON.stringify({
    controls: controls.length, bound: bound.length, hooked: hooked.length, delegated: delegated.length,
    readOnly: readOnly.length, deadClickable, deadInput, deadHooks, liveHooks, broken: broken.map(([id, n]) => ({ id, n })),
  }, null, 2));
} else {
  console.log('\n=========== trading UI control audit ===========');
  console.log(`source: trading/public/index.html (${htmlLines.length} lines) + js/{${jsFiles.join(', ')}}`);
  console.log(`controls with an id: ${controls.length}   bound (direct handler): ${bound.length} (${pct(bound.length, controls.length)})   ` +
    `hook-bound: ${hooked.length}   named-but-indirect: ${delegated.length}   read-only: ${readOnly.length}   DEAD: ${dead.length}`);

  console.log(`\n--- A. DEAD CLICKABLE CONTROLS (${deadClickable.length}) — the id appears NOWHERE in the JS, in any form ---`);
  if (!deadClickable.length) console.log('  none');
  for (const c of deadClickable) console.log(`  index.html:${c.line}  <${c.tag} id="${c.id}">`);

  console.log(`\n--- A2. DEAD NON-CLICKABLE (${deadInput.length}) — never read by any JS ---`);
  if (!deadInput.length) console.log('  none');
  for (const c of deadInput) console.log(`  index.html:${c.line}  <${c.tag} id="${c.id}">`);

  console.log(`\n--- B. DEAD data-* HOOKS (${deadHooks.length}) — in the HTML, nowhere in the JS ---`);
  if (!deadHooks.length) console.log('  none');
  for (const h of deadHooks) console.log(`  ${h.attr}  (${h.count} element${h.count === 1 ? '' : 's'})`);
  console.log(`  live hooks: ${liveHooks.map((h) => h.attr).join(', ') || 'none'}`);

  console.log(`\n--- C. BROKEN REFERENCES (${broken.length}) — JS names an id the HTML never declares and no template creates ---`);
  if (!broken.length) console.log('  none');
  for (const [id, n] of broken) console.log(`  ${id}  (named ${n}x)`);

  console.log(`\n--- D. GUARDED BINDINGS (${guarded.length}) — the idiom that HIDES section C ---`);
  for (const c of guarded) console.log(`  ${c.id}${c.bound ? ' (bound)' : ' *** GUARDED BUT NEVER BOUND ***'}`);

  console.log('\n--- the controls that ARE wired, for the diff ---');
  console.log('  ' + bound.map((c) => c.id).join(' · '));

  console.log(`\n--- hook-bound (${hooked.length}) — bound via a data-* hook, not by id ---`);
  console.log('  ' + (hooked.map((c) => `${c.id}[${(c.dataOnLine || []).join(',')}]`).join(' · ') || 'none'));

  console.log(`\n--- named-but-indirect (${delegated.length}) — bound by delegation/loop, NOT by id ---`);
  console.log('  ' + (delegated.map((c) => c.id).join(' · ') || 'none'));
  console.log('');
}
