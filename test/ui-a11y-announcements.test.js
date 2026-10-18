// test/ui-a11y-announcements.test.js — TRD-UI-9 (2026-10-03): the NVDA listen-through fixes.
//
// WHAT THE LISTEN-THROUGH FOUND (transcripts: temp/ui-sitting-2026-10-03/nvda-speech-viewer-transcript-*.txt):
//   (A) #health-banner — a role=status live region — was REBUILT on every self-health poll, so while the
//       desk was degraded a screen reader re-read the whole ~600-char offender block every ~15 s
//       (~7 full re-reads captured in one sitting).
//   (B) the AI-state line and its chips read the full 18-name strategies run aloud on every render.
//   (C) the hard-kill confirm was a native window.confirm, read under NVDA with a stray leading host word
//       ("Code dialog HARD KILL …").
//   (D) alert rows linearized to bare tokens ("Gold / above / never / 91%").
//
// node:test has no DOM, so these are SOURCE pins — the same instrument as ui-a11y-names.test.js. The
// behavioural halves (announce-once, focus order, Esc) are covered by the owner's next listen-through.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { code } = require('./_source');

const APP = 'trading/public/js/app.js';
const HTML = 'trading/public/index.html';
const app = code(APP); // comments stripped — a negative assertion must not pass on prose
const html = fs.readFileSync(path.join(__dirname, '..', HTML), 'utf8');

test('(A) the health live regions only write when their text changed', () => {
  assert.match(app, /if \(statusEl\.textContent !== healthChipTxt\) statusEl\.textContent = healthChipTxt;/,
    'the status chip must dirty-check before writing');
  assert.match(app, /if \(banner\.dataset\.sig !== bannerHtml\) \{/,
    'the banner must dirty-check via a content signature');
  assert.ok(!/statusEl\.textContent = s\.status\.toUpperCase\(\); statusEl\.className/.test(app),
    'the unconditional same-text write is the defect — it must be gone');
  assert.ok(!/banner\.innerHTML = `<span class="chip \$\{tone\}">DESK DEGRADED/.test(app),
    'the banner must never be written outside the signature guard');
});

test('(B) the status line announces a strategy COUNT, not 18 names', () => {
  assert.match(app, /strategies \$\{strategies\.length \? strategies\.length \+ ' enabled' : 'none'\}/,
    'the live line announces the count');
  assert.ok(!/· strategies \$\{\(state\.strategiesEnabled \|\| s\.strategies \|\| \[\]\)\.join\('\+'\)/.test(app),
    'the full list inside the live line is the defect — it must be gone');
  assert.match(app, /\['strategies', strategies\.length \? String\(strategies\.length\) : 'none'/,
    'the chips announce the count too (the full list lives in the tooltip and the Strategy card)');
});

test('(C) the hard-kill confirm is the in-page dialog, keeping the exact promise text', () => {
  assert.match(html, /<dialog id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-body">/);
  assert.match(html, /<button id="confirm-cancel" class="small secondary">Cancel<\/button>/);
  assert.match(html, /<button id="confirm-ok" class="small danger">Proceed<\/button>/);
  assert.ok(html.indexOf('id="confirm-cancel"') < html.indexOf('id="confirm-ok"'),
    'Cancel precedes Proceed in reading and focus order');
  assert.match(app, /const ok = await askConfirm\(\{[\s\S]{0,80}title: 'HARD KILL',/,
    'the kill handler must go through the dialog');
  assert.match(app, /This blocks new entries AND closes \$\{open\} open position\(s\) at market\./,
    'the promise text is verbatim');
  assert.match(app, /It cannot be undone — Resume only lifts the tier\./,
    'including the irreversible half');
  assert.ok(!/confirm\(`HARD KILL/.test(app),
    'the native window.confirm in the kill path is the defect — it must be gone');
  assert.match(app, /\$\('confirm-cancel'\)\.focus\(\);/,
    'focus must default to the safe control');
  assert.match(app, /resolve\(dlg\.returnValue === 'ok'\)/,
    'only an explicit Proceed resolves true (Esc closes with an empty returnValue → false)');
  assert.match(app, /return window\.confirm\(`\$\{title\}/,
    'a fallback must exist for browsers without <dialog>');
});

test('(D) alert rows carry visually-hidden labels and the table has scoped headers', () => {
  assert.match(app, /sr-only">alert symbol <\/span>\$\{esc\(a\.symbol\)\}/);
  assert.match(app, /sr-only">metric <\/span>/);
  assert.match(app, /sr-only">condition <\/span>/);
  assert.match(app, /sr-only">threshold <\/span>/);
  assert.match(app, /sr-only">last triggered <\/span>/);
  assert.match(html, /<th scope="col">Symbol<\/th><th scope="col">Metric<\/th><th scope="col">Condition<\/th><th scope="col">Threshold<\/th><th scope="col">Triggered at<\/th><th scope="col"><span class="sr-only">Actions<\/span><\/th>/,
    'the alerts table headers must be scoped columns (the Actions column needs its label too)');
  assert.match(html, /\.sr-only \{ position: absolute;/, 'the visually-hidden utility exists');
});
