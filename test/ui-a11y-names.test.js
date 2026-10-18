// test/ui-a11y-names.test.js — TRD-UI-5 (2026-09-22), the MECHANICAL half.
//
// TRD-UI-5 is deliberately not closable here: it needs a real assistive-technology run (NVDA or VoiceOver
// plus Tab) to record focus order, whether every interactive element is reachable and visibly focused,
// whether a focused Hard plus Enter fires the dialog, and whether success/error changes are ANNOUNCED. None
// of that is measurable from a script, and the row says so.
//
// But the row also says: "Then pin the mechanical half: every control has an accessible name". That half IS
// mechanical, and it turned out to be a real defect rather than a formality. Scanning the rendered page
// found 134 interactive controls, of which 23 had NO accessible name at all and 2 more relied on `title`
// alone — every one of them a form field whose label was only VISUAL (a sibling <span class="k">Interval</span>,
// a placeholder, or an enclosing .kv row). A placeholder is not a name: it disappears the moment the field
// has content, and screen readers treat it as a description, not a label. Those 25 fields now carry
// aria-label, and this file keeps it that way.
//
// WHY A STATIC PIN RATHER THAN A BROWSER CHECK. node:test has no DOM. The browser scan was the instrument
// that FOUND the gaps (and it is re-runnable: the same evaluate block reports 134 / 0 missing); this pin is
// the guard that runs in the ordinary suite. It covers index.html only — controls created dynamically by
// app.js are named by their text content and are outside this file's reach, which is stated rather than
// implied.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'trading', 'public', 'index.html'), 'utf8');

// Every control that needs a name. Buttons and links are named by their text, which is checked separately.
const NAMED_BY_ATTR = /<(input|select|textarea)\b([^>]*)>/gi;

function scan() {
  const tags = [...html.matchAll(NAMED_BY_ATTR)].map((m) => ({ tag: m[1].toLowerCase(), attrs: m[2] }));
  // Ids that a <label for="..."> points at.
  const forIds = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/gi)].map((m) => m[1]));
  // Ids that sit INSIDE a <label> ... </label>, i.e. implicitly labelled.
  const wrappedIds = new Set();
  for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    for (const id of m[1].matchAll(/\bid="([^"]+)"/g)) wrappedIds.add(id[1]);
  }
  const idOf = (attrs) => (attrs.match(/\bid="([^"]+)"/) || [])[1] || null;
  const hasName = (attrs) => /\baria-label(?:ledby)?="[^"]+"/.test(attrs);
  const unnamed = tags.filter((t) => !hasName(t.attrs) && !(idOf(t.attrs) && (forIds.has(idOf(t.attrs)) || wrappedIds.has(idOf(t.attrs)))));
  return { tags, forIds, wrappedIds, unnamed };
}

test('the premise: the scan actually finds the controls', () => {
  // Without this, a change to the markup shape could make the scan match nothing and every assertion below
  // would pass vacuously — a pin that stops meaning anything while still reporting green.
  const { tags, forIds, wrappedIds } = scan();
  assert.ok(tags.length >= 40, `the scan found only ${tags.length} form controls — it stopped matching the markup`);
  assert.ok(forIds.size + wrappedIds.size >= 10, 'the label scrape found almost nothing — the <label> shape changed');
});

test('★ every form control in index.html has an accessible name', () => {
  const { tags, unnamed } = scan();
  const list = unnamed.map((t) => {
    const id = (t.attrs.match(/\bid="([^"]+)"/) || [])[1] || '(no id)';
    return `${t.tag}#${id}`;
  });
  assert.deepEqual(list, [],
    `these controls have no accessible name (aria-label, aria-labelledby, label[for], or a wrapping label): ${list.join(', ')}`);
  assert.ok(tags.length >= 40, 'scope check: see the premise test');
});

test('★ no control relies on `title` alone for its name', () => {
  // `title` is exposed as a description, not as the accessible name, and it is not announced by all readers
  // on focus. Two fields (trade-stop, bt-mc-trials) had title and nothing else. Both now carry aria-label,
  // and the title is kept because it says something MORE than the name does.
  const { tags, forIds, wrappedIds } = scan();
  const titleOnly = tags
    .filter((t) => /\btitle="[^"]+"/.test(t.attrs))
    .filter((t) => !/\baria-label(?:ledby)?="[^"]+"/.test(t.attrs))
    .filter((t) => {
      const id = (t.attrs.match(/\bid="([^"]+)"/) || [])[1];
      return !(id && (forIds.has(id) || wrappedIds.has(id)));
    })
    .map((t) => (t.attrs.match(/\bid="([^"]+)"/) || [])[1] || '(no id)');
  assert.deepEqual(titleOnly, [], `these controls lean on title alone: ${titleOnly.join(', ')}`);
});

test('★ the fields the audit named specifically stay named', () => {
  // The login fields matter most: a screen-reader user cannot even get past the door without them, and they
  // had no label of any kind (placeholder only — the password field does not even announce its purpose until
  // it is typed into). Named individually so a markup rewrite cannot quietly drop them.
  for (const id of ['username', 'password', 'trade-symbol', 'trade-dir', 'trade-amount', 'trade-stop',
    'ask-input', 'congress-token', 'bt-symbol', 'bt-venue', 'events-kind', 'bar-symbol']) {
    const re = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`);
    const tag = html.match(re);
    assert.ok(tag, `#${id} is gone from index.html — if the control was removed, remove it from this list`);
    assert.match(tag[0], /aria-label="[^"]+"/, `#${id} must keep an accessible name`);
  }
});
