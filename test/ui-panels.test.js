// test/ui-panels.test.js — TRD-UI-3 (2026-09-22).
//
// WHY A SOURCE PIN AGAIN. The three surfaces added by TRD-UI-3 are not pure functions and have no return
// value a unit test could read: they fetch, then write HTML. Three of the four defects found in the TRD-UI
// work so far lived exactly here — in the WIRING — and none of them was visible to a route test or a
// response-shape check:
//
//   1. `pf` / `p` drawn by the DATE formatter  -> rendered 01/01/1970 (see ui-format-guards.test.js)
//   2. a pending ping probe reported as FAILURE -> the endpoint returns no `ok` field while pending
//   3. a hover-only `title` carrying the can-trade answer -> invisible unless the pointer happens to rest
//   4. the digest read for a `text` field that the producer never writes
//
// (4) is the reason this file pins the READER AGAINST THE PRODUCER rather than against a literal. The size of
// the digest payload's real shape was knowable from waker.js in one grep, and the first version of the
// reader still guessed `text || summary || digest` — the same class of error as the invented "BLOCKED" label
// earlier the same day, where a plausible field name stood in for the actual one. So the premise test reads
// the PRODUCER, and the reader test asserts the reader keys off what the producer writes.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'trading', 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'trading', 'public', 'index.html'), 'utf8');
const wakerJs = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'waker.js'), 'utf8');

// Strip comments before asserting — a comment that explains why NOT to do a thing contains the very string
// the pin forbids. This has now cost three separate false failures (pingRow, the TRD-72 bundle symbol, and
// the scoreboard), so it is applied here from the start.
const codeOnly = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');

// The body of one top-level function, without needing to know what follows it.
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const cuts = [rest.indexOf('\nasync function '), rest.indexOf('\nfunction ')].filter((i) => i !== -1);
  return cuts.length ? rest.slice(0, Math.min(...cuts)) : rest;
}

const bodyOf = (name) => codeOnly(fnBody(appJs, name) || '');
const fn = (name) => bodyOf(name) || assert.fail(`${name} is gone — if the panel was removed, delete its pin with it`);

test('the premise: all three TRD-UI-3 renderers exist and are reachable from the tab handler', () => {
  for (const name of ['refreshCanTrade', 'refreshShadowSurfaces', 'refreshDigest']) {
    assert.ok(fnBody(appJs, name), `${name} is missing — the panel it draws is unreachable`);
  }
  // A renderer that nothing calls is decoration, and the tab handler is the only thing that makes it live.
  assert.match(appJs, /refreshDigest\(\)/, 'refreshDigest exists but nothing invokes it');
  assert.match(appJs, /refreshCanTrade\(\)/, 'refreshCanTrade exists but nothing invokes it');
  assert.match(appJs, /refreshShadowSurfaces\(\)/, 'refreshShadowSurfaces exists but nothing invokes it');
  // And the tab branches must be the STRATEGY / HEALTH ones — a call placed under the wrong tab puts the
  // panel behind a screen nobody opens while the route test still passes, because the route IS reached.
  const strat = appJs.match(/dataset\.tab === 'strategy'\)\s*\{([^}]*)\}/);
  assert.ok(strat, 'the strategy tab branch changed shape — re-read this file before trusting it');
  assert.match(strat[1], /refreshCanTrade\(\)/, 'can-trade is not refreshed on the Strategy tab');
  assert.match(strat[1], /refreshShadowSurfaces\(\)/, 'shadow surfaces are not refreshed on the Strategy tab');
  const health = appJs.match(/dataset\.tab === 'health'\)\s*\{([^}]*)\}/);
  assert.ok(health, 'the health tab branch changed shape — re-read this file before trusting it');
  assert.match(health[1], /refreshDigest\(\)/, 'the digest is not refreshed on the Health tab');
});

test('the premise: the DOM ids the three renderers write into exist in index.html', () => {
  // A renderer that fetches correctly and writes into a missing node is a silent no-op: the fetch succeeds,
  // the route test passes, and the screen stays empty.
  for (const id of ['cantrade-body', 'cantrade-state', 'shadow-body', 'shadow-state', 'digest-body', 'digest-state']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} is referenced by app.js but absent from index.html`);
  }
});

test('★ an explicit empty scope is drawn as CANNOT ENTER, not as unconfigured', () => {
  const body = fn('refreshCanTrade');
  // The distinction the panel exists to make. `[]` is how a symbol is RETIRED (F28: enabled=[survgold,
  // survoil] while Bitcoin, Silver, Sugar, SGX, Arabica Coffee and "others" are all []). A truthiness test on
  // the array cannot tell [] from undefined — and only one of those means "can never enter".
  assert.match(body, /strategies\.length > 0/, 'the can-enter test must be a LENGTH test: [] is meaningful and falsy-safe');
  assert.doesNotMatch(body, /r\.strategies \?/, 'a truthiness test on the scope array collapses "retired" into "unset"');
  assert.match(body, /cannot enter/, 'the empty-scope row must say it cannot enter');
  // The chip's hover-only answer, promoted to a screen.
  const uni = codeOnly(appJs.match(/const uni = \$\('banner-universe'\);[\s\S]*?\n  \}/)[0]);
  assert.match(uni, /symbolScope/, 'the header chip no longer computes the scope — the panel and the chip have diverged');
});

test('★ the shadow surfaces render DISABLED with the reason, never as an empty table', () => {
  const body = fn('refreshShadowSurfaces');
  // The audit's instruction: both are off in `strategies.enabled` today, so "an empty panel would lie about
  // why there is nothing there". An absent row reads as "nothing to report"; `disabled` reads as "nothing is
  // scheduled to happen". Only one is true.
  assert.match(body, /disabled/, 'the off state must be stated, not implied by an empty table');
  assert.match(body, /strategies\.enabled/, 'the on/off state must be read from settings, not assumed');
  // Read FRESH inside the renderer. `state.strategies` is a cached snapshot, and a stale cache would show a
  // surface as off after the owner turned it on, or worse the reverse.
  assert.match(body, /apiGet\('\/api\/trading\/settings'/, 'read settings fresh; a cached snapshot can be stale when the owner flips a switch');
  // The ids live in the SHADOW_SURFACES constant, not inline — so pin the DECLARATION for the ids and the
  // BODY for consuming it. Asserting the ids against the body alone fails on correct code, because the
  // constant is declared above it (this cost one run).
  assert.match(body, /SHADOW_SURFACES\.map|SHADOW_SURFACES\.filter/, 'the body must drive the panel from the shared declaration');
  const decl = codeOnly(appJs.match(/const SHADOW_SURFACES = \[[\s\S]*?\n\];/)[0]);
  for (const id of ['multi', 'congress']) {
    assert.match(decl, new RegExp(`id: '${id}'`), `${id} left the panel declaration`);
  }
  // The labels must be the registry's own names, not names invented in the UI. Asserted against the strategy
  // modules so a rename in the registry fails here instead of leaving the screen calling a strategy
  // something it is no longer called.
  for (const f of ['multiFactor.js', 'congress.js']) {
    const mod = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'strategies', f), 'utf8');
    const name = (mod.match(/^\s*name:\s*'([^']+)'/m) || [])[1];
    assert.ok(name, `${f} no longer declares a name — the panel label here is unverified`);
    assert.match(decl, new RegExp(name.replace(/[()]/g, '\\$&')), `the panel does not use ${f}'s registry name "${name}"`);
  }
});

test('★ the digest reader keys off the PRODUCER\'s fields, and never invents one', () => {
  // THE PREMISE, read from the producer itself. If waker.js stops writing `bullets`, the reader below is
  // asserting a shape that no longer exists and this file should fail loudly rather than pass vacuously.
  const write = wakerJs.match(/logEvent\(userId, 'digest', \{[^}]*\}/);
  assert.ok(write, 'the digest producer changed shape — re-read the reader before trusting this pin');
  assert.match(write[0], /bullets/, 'the producer no longer writes `bullets`: the reader reads the wrong field');
  assert.match(write[0], /stats/, 'the producer no longer writes `stats`');

  const body = fn('refreshDigest');
  assert.match(body, /Array\.isArray\(p\.bullets\)/, 'the digest content is `bullets`, an ARRAY — not a text field');
  assert.doesNotMatch(body, /p\.text|p\.summary/, 'an invented field name: the producer writes bullets/stats/actor, never text/summary');
  // `actor` is spread CONDITIONALLY by the producer, so its absence means the LLM never wrote the bullets and
  // what is stored is the three canned fallback lines. A panel that showed that as "the digest the chairs
  // read" would present a fallback as a digest — a missing field carrying the finding.
  assert.match(body, /p\.actor/, 'the LLM-vs-fallback distinction lives in the optional `actor` field');
  assert.match(body, /FALLBACK/, 'the fallback case must be named on screen, not rendered as a normal digest');
});

test('★ an unreadable setting renders UNKNOWN, never `disabled` and never an empty list', () => {
  // FOUND LIVE, not by reasoning. Every Strategy route answered 401 in a browser whose app shell loaded
  // anyway — i.e. an ordinary stale/signed-out tab. The first version of these panels fell through to
  // `enabled = []` on that failure and rendered BOTH surfaces as `disabled`, and the can-trade list as an
  // empty table. Both are statements about the desk's CONFIGURATION made from an AUTHENTICATION error.
  //
  // This is the same defect shape as the pending ping probe reported as failure and the missing cost basis
  // coerced into the pessimistic branch: a missing value defaulting into the confident-sounding branch. The
  // rule is that a panel must not answer the question it exists to answer when it could not read the answer.
  for (const name of ['refreshShadowSurfaces', 'refreshCanTrade', 'refreshDigest']) {
    const body = fn(name);
    assert.match(body, /catch/, `${name} has no failure path`);
    assert.match(body, /UNKNOWN/, `${name} must name the state UNKNOWN rather than imply a value`);
    assert.doesNotMatch(body, /catch\s*\{[^}]*el\.textContent = 'unavailable'/,
      `${name}: a bare "unavailable" body with an untouched heading leaves the heading looking like "nothing to report"`);
  }
  // The shadow panel must test the settings object itself before deriving `enabled` from it — this is the
  // exact line whose absence produced the false `disabled`.
  assert.match(fn('refreshShadowSurfaces'), /if \(!settings \|\| !settings\.strategies\)/,
    'the shadow panel must refuse to render a state it could not read');
  // And the can-trade panel must not print its headline from a defaulted-empty enabled list.
  const cant = fn('refreshCanTrade');
  const catchStart = cant.indexOf('catch');
  assert.ok(catchStart !== -1, 'no catch block');
  assert.doesNotMatch(cant.slice(catchStart), /canEnter\.length/,
    'the catch block must not print the headline: on a failed read there is no count to print');
});

test('★ F5: the white paper is marked superseded against the BOOK, not merely its age', () => {
  // The audit's rule — "mark superseded when `asOf` precedes the last book/tier change" — was not decidable,
  // because nothing recorded which book the paper described; the panel could render only the paper's AGE. Age
  // is a weak proxy: a four-day-old paper can still be exactly right, an hour-old one can be wrong because the
  // kill tier was raised. So the producer records the book and the panel compares.
  const prod = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'whitepaper.js'), 'utf8');
  const w = codeOnly(prod);
  assert.match(w, /const book = \{/, 'the producer no longer records the book the paper was written under');
  for (const k of ['killTier', 'enabled']) {
    assert.match(w, new RegExp(`${k}: `), `the recorded book must carry ${k} — it is what the paper makes claims about`);
  }
  assert.match(w, /book \}/, 'the recorded book must actually reach the payload');

  const body = fn('renderWhitepaper');
  assert.match(body, /w\.book/, 'the panel must read the recorded book');
  assert.match(body, /killTier/, 'the kill tier is the contradiction the audit observed');
  assert.match(body, /SUPERSEDED/, 'the superseded state must be named');
  // The three outcomes must stay DISTINCT. Collapsing `book unrecorded` into either side loses the
  // distinction the whole fix rests on: an uncomparable paper is neither superseded nor verified-current.
  assert.match(body, /book unrecorded/, 'an uncomparable paper needs its own state, not a silent default');
  assert.match(body, /matches live book/, 'the verified-current state must be stated, not merely implied by absence of a mark');
});

test('★ every CSS class these panels use exists in the palette', () => {
  // FOUND WHILE WRITING THIS FILE: the first version used `class="warn"` and `class="chip bad"`, neither of
  // which exists — the palette has `warn-t` and `chip hard`. An unknown class renders UNSTYLED, so the mark
  // would have appeared as plain body text: present in the DOM, correct in the assertion, invisible as a
  // signal. That is the same failure mode as drawing a number with the date formatter.
  const classes = new Set();
  for (const name of ['refreshCanTrade', 'refreshShadowSurfaces', 'refreshDigest', 'renderWhitepaper']) {
    for (const m of fn(name).matchAll(/class="([^"]*)"/g)) {
      const attr = m[1];
      // A class is often produced by a ternary INSIDE the attribute — `class="${isOn ? 'pos' : 'muted'}"` — so
      // the interpolated expression has to be read for its quoted literals, and the remaining literal text
      // read separately. Splitting the raw attribute on whitespace (the first version) collects `'pos'` and
      // `: 'muted'}` as if they were class names, which is a scraper bug masquerading as a real finding.
      for (const lit of attr.matchAll(/'([a-zA-Z][\w-]*)'/g)) classes.add(lit[1]);
      for (const tok of attr.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(tok)) classes.add(tok);
      }
    }
  }
  assert.ok(classes.size > 4, `the class scrape found only ${classes.size} classes — it stopped matching the markup`);
  for (const c of classes) {
    assert.match(html, new RegExp(`\\.${c}[\\s,{.:]`), `class "${c}" is used by a panel but is not defined in index.html`);
  }
});

test('★ TRD-UI-4: the flex context is on #app, not main — the bug that made the first fix inert', () => {
  // MEASURED FIRST, at 1920x900: tab bar top 3901px (viewport 900), narration column 63-105px, 720px of the
  // screen unused. The first fix put `display:flex` on `main` — and `order: 9` on .grid was then INERT,
  // because `order` only means anything to a flex/grid ITEM and .grid is a grandchild: everything is wrapped
  // in `<div id="app">`, so main has exactly two children (#login-card and #app). The rule was applying
  // (getComputedStyle reported order:9) while the grid stayed at top 238. A silent no-op, so it is pinned.
  const mainRule = html.match(/\n\s*main \{([^}]*)\}/);
  assert.ok(mainRule, 'the main rule changed shape — re-read this file before trusting it');
  assert.doesNotMatch(mainRule[1], /display:\s*flex/,
    'the flex context must NOT be on main: .grid is not a child of main, so `order` there is inert');

  const appRule = html.match(/\n\s*#app \{([^}]*)\}/);
  assert.ok(appRule, '#app has no rule — the flex context needs somewhere to live');
  assert.match(appRule[1], /display:\s*flex/, '#app must establish the column flex context');
  assert.match(appRule[1], /flex-direction:\s*column/, '#app must stack, not row');

  const gridRule = html.match(/\n\s*\.grid \{([^}]*)\}/);
  assert.ok(gridRule, 'the .grid rule changed shape');
  assert.match(gridRule[1], /order:\s*9/, '.grid must be ordered after the tab panels, or the tab bar returns below the fold');

  // THE PREMISE, without which the pin above is meaningless: the content really is inside #app. If someone
  // unwraps #app, `order` on .grid becomes inert again and this file must start failing.
  const mainBody = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  assert.match(mainBody, /<div id="app"/, 'the app wrapper vanished from main — the flex context has no home');
  const appIdx = mainBody.indexOf('<div id="app"');
  const gridIdx = mainBody.indexOf('<div class="grid"');
  assert.ok(gridIdx > appIdx, '.grid must be INSIDE the app wrapper for order to apply to it');

  // F10's other half: the Ask card reserved ~285px for a one-line empty state at every height.
  assert.match(html, /#ask-answer:empty \{ display: none; \}/,
    'the empty answer box must collapse again — it is a padded, bordered, max-height:180px panel');
  assert.match(html, /id="ask-answer"[^>]*><\/div>/,
    'the answer box must start EMPTY: any placeholder text inside it defeats :empty');
});

test('★ TRD-UI-2: the SIM/DEMO mode fact has exactly ONE reader endpoint', () => {
  // The row said the remaining item "needs the endpoint merge, not another projection". SIM-vs-DEMO was still
  // answered by TWO endpoints on two schedules — /paper (boolean `enabled`) and /state (string `mode`) — and
  // both derive from the same server setting, so they agree in principle and could still disagree on screen.
  const app = codeOnly(appJs);
  const ai = fn('renderAiState');
  assert.match(ai, /state\.mode = s\.mode/, '/state must be the reader that sets the shared mode');
  assert.match(ai, /applyMode\(\)/, 'the reader must paint through the shared projector');
  assert.doesNotMatch(ai, /s\.mode === 'sim'/, 'the mode must be read from the shared value, not re-derived from the response');

  // /settings must NOT be read for the mode. It has no top-level `mode` field at all — only `watchlist.mode`,
  // a different fact — so a read there yields null and the page then has to defend against null everywhere.
  // This is the bug the pin is named for: introduced while wiring F5, it would have made every paper compare
  // as SUPERSEDED (book.mode "plus500_demo" vs liveBook.mode null).
  // ⚠ The assertion must be scoped to the SETTINGS reader. Matching the whole file for `state.mode = s.mode`
  // also matches the legitimate /state read in renderAiState — a pin that cannot tell the two readers apart
  // would forbid the very line it requires. (It did, on the first run.)
  assert.doesNotMatch(fn('refreshWaker'), /state\.mode/, 'refreshWaker reads /settings, which has no mode field — that read returns null');

  // THE PREMISE: /state really does carry the mode, and it is a NAME not a boolean.
  const tree = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'stateTree.js'), 'utf8');
  assert.match(tree, /mode: sim \? 'sim' : 'plus500_demo'/, 'the state tree no longer names the mode — re-read this pin');
  // And /settings really has no top-level mode, which is WHY the read above was wrong.
  const store = fs.readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
  const defaults = store.slice(store.indexOf('DEFAULT_SETTINGS'), store.indexOf('DEFAULT_SETTINGS') + 6000);
  assert.doesNotMatch(codeOnly(defaults), /^\s*mode:/m, 'settings gained a top-level mode — this pin and the comment above it are now stale');

  // The paper panel keeps the checkbox (that IS the paper subsystem switch, and the write path) but must not
  // paint the page-wide labels from its own read.
  const paper = fn('refreshPaper');
  assert.match(paper, /paper-toggle'\)\.checked/, 'the Paper tab checkbox is still the paper switch');
  assert.match(paper, /applyMode\(\)/, 'the paper panel must project the shared mode, not derive its own');
  assert.doesNotMatch(paper, /modeEl\.textContent = d\.enabled/, 'the banner label must not come from /paper');
  assert.match(paper, /state\.simMode = !!d\.enabled/, 'the paper subsystem still owns its own boolean');
});

test('★ F5: an UNREAD live book value is never reported as a change', () => {
  // Same defect shape as `disabled` from a 401. `state.killTier` and `state.mode` are null until their first
  // reads land, and a blind `!==` would call that a book change — marking EVERY paper SUPERSEDED on every
  // page load. The comparison must count what it actually compared, and a paper that could not be compared at
  // all needs its own verdict rather than passing silently as current.
  const body = fn('renderWhitepaper');
  assert.match(body, /compared/, 'the drift check must count the fields it actually compared');
  assert.match(body, /state\.killTier != null/, 'the kill tier must be compared only when it has been read');
  assert.match(body, /liveBook\.mode != null/, 'the mode must be compared only when it has been read');
  assert.match(body, /book not comparable yet/, 'an incomparable paper needs its own verdict');
  assert.match(body, /matches live book \(\$\{drift\.compared\}\/3\)/,
    'the current verdict must state HOW MANY facts it actually checked — "unchanged" from one field is not "unchanged"');
});

test('★ the premise: `actor` is still written only when the LLM wrote the bullets', () => {
  // This is what makes the absence meaningful. If the producer starts always writing `actor`, the reader's
  // fallback branch becomes dead code and the pin above would be protecting a distinction that no longer
  // exists — so the premise is asserted, not assumed.
  assert.match(wakerJs, /\.\.\.\(digestModel \? \{ actor: /, '`actor` is no longer conditional — the LLM/fallback read is now meaningless');
});
