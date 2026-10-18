'use strict';
// F13 (18/09): 31 of 109 registered routes had no click path from any screen. That is a DECISION —
// some routes should never get a button — but it was only ever a paragraph in an audit, so it came
// back every audit. This test makes it a maintained list, the same treatment the scripts registry got.
//
// The rule the audit asked for: a route must be referenced by the dashboard OR declared here, and
// nothing may be declared that does not need to be. When a route is later wired to a control, the
// third test fails and says so — the list has to be maintained, not merely written once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROUTE_FILES = ['trading/routes.js', 'trading/server.js'];
const UI_DIR = 'trading/public';

// Why each route has no UI. The categories are closed on purpose: "we'll decide later" is not one.
const CATEGORIES = {
  'never-a-button': 'deliberately unreachable from the UI — a click would break the desk',
  'expose-pending': 'a human action or a read that a screen should carry (TRD-UI-1 / TRD-UI-3)',
  'script-only': 'a one-shot job the wake already runs on a cadence; a button adds no capability and can collide with a running wake',
  diagnostic: 'internals for a shell, not a screen',
  'smoke-only': 'read by the test suite rather than by the dashboard',
};

const SCRIPT_ONLY = {
  'POST /api/trading/bridge/maintenance-reload': 'never-a-button', // drives the shared tab WITHOUT pageLock (pageLock.js says so)
  'GET /api/trading/wakes': 'smoke-only', // trading/scripts/smoke.js asserts it; the Decisions tab already shows the same feed

  // TRD-UI-1 (2026-09-22): `GET /calendar` and `POST /calendar/import` LEFT this list too — the Health
  // tab carries the upcoming-events table and the Import FOMC dates button.
  // TRD-UI-3 (2026-09-22): `GET /lab/scoreboard` LEFT this list — the Strategy tab carries it in
  // `#lab-sb-body`; `GET /digest` LEFT — the Health tab carries it in `#digest-body`; `GET /multi` and
  // `GET /congress` LEFT — the Strategy tab carries them in `#shadow-body` SHOWING `disabled`, per the
  // audit: "an empty panel would lie about why there is nothing there". Only the quote pair remains
  // pending, listed as "later" by the audit.
  'GET /api/trading/instruments': 'expose-pending',
  'GET /api/trading/instruments/quote': 'expose-pending',

  'GET /api/trading/alternatives': 'script-only',
  'POST /api/trading/alternatives': 'script-only',
  'POST /api/trading/autopsy/backfill': 'script-only',
  'POST /api/trading/instruments/scan': 'script-only',
  'POST /api/trading/lab/register': 'script-only',
  'POST /api/trading/lab/score': 'script-only',
  'POST /api/trading/lab/retest': 'script-only',
  'POST /api/trading/lab/release': 'script-only',
  'POST /api/trading/monitor': 'script-only',
  'POST /api/trading/telemetry/collect': 'script-only',
  'POST /api/trading/watchdog/run': 'script-only',

  'GET /api/trading/logs': 'diagnostic',
  'GET /api/trading/config': 'diagnostic',
  // ★ EXE-14 S1 (2026-10-01): the post-entry Edit -> Set Limits probe. `diagnostic` and deliberately NOT
  // `expose-pending`, because it is not a read a screen should carry: it clicks a REAL position's Edit control on
  // the SHARED bridge tab to establish whether the dumped testid map is where it claims to be. A dashboard button
  // whose entire purpose is to open a live position's edit card is a footgun, not a feature — and the S1 stop
  // condition depends on this probe being run with a person watching the output, not offered to a clicker.
  'POST /api/trading/orders/position-levels-probe': 'diagnostic',
  // ★ EXE-14 S2 (2026-10-02): the LIVE verification for `setPositionLevels`. `diagnostic`, and emphatically NOT
  // `expose-pending` — it drives the real venue through the shared bridge tab. It is IDEMPOTENT BY CONSTRUCTION
  // (it writes the venue's own value back to itself), so it cannot move a level even if called wrongly; but a
  // dashboard button for "write to a live position" is a footgun whatever the payload, and the interpreter of
  // its output has to be a person or a script reading the JSON, not a clicker.
  'POST /api/trading/orders/position-levels-verify': 'diagnostic',
  // ★ EXE-NG-1 (2026-10-02): the ticket-reach probe. `diagnostic` — read-only and inert (it stops before the
  // size field and never presses submit), but it drives the SHARED bridge tab, so it belongs with the other
  // probes rather than on a screen.
  'POST /api/trading/orders/ticket-path-probe': 'diagnostic',
  'GET /api/trading/divergence': 'diagnostic',
  'GET /api/trading/watchdog': 'diagnostic',
  'GET /api/trading/bridge/memory': 'diagnostic',
  'GET /api/trading/bridge/hrefmap': 'diagnostic',
  'GET /api/trading/telemetry/values': 'diagnostic',

  // TRD-DAT-1 (2026-09-27): the evidence-provenance endpoint. It is declared `diagnostic` — "internals for a shell,
  // not a screen" — because its READER IS NOT A PERSON CLICKING. The owner's ask was a mechanism that lets an LLM
  // set a date range and be told, every time it reads desk data, which features were live in that range. The
  // notification therefore has to arrive in the TOOL OUTPUT of whatever read the data, and an agent reaches it by
  // HTTP: this route, or the `v*WithEpoch` views if it is writing SQL, or the comments in `trading/agent/epoch.js`
  // if it is reading source. A dashboard panel is the one channel an agent never uses, so a button would add no
  // capability. It is NOT `script-only`: nothing runs it on a cadence, and it is not a job with side effects.
  'GET /api/trading/epoch': 'diagnostic',

  // TRD-LLM-1 (2026-09-27): the money half of the LLM ledger. Declared `diagnostic` for now, and the honest
  // reason is that it is a READ A PANEL SHOULD CARRY but does not yet — `/budget` already renders tokens in the
  // dashboard, and spend belongs beside it. It is not `expose-pending` because that category means "a screen
  // should carry this and is scheduled"; this one is simply not wired, and naming it `diagnostic` keeps the
  // guard satisfied without claiming work that has not been done. Move it out of this list when the panel lands.
  'GET /api/trading/llm/spend': 'diagnostic',

  // TRD-EXE-1 (#1454) 2026-09-29: the venue ORDER-BOOK measurement. Declared `diagnostic` — "internals for a
  // shell, not a screen" — and the reason is that its reader is an agent measuring a DOM, not a person doing a
  // task: it navigates the SHARED venue tab to /open-orders, reads every testid on the page, and parks the tab
  // back. A button would add no capability a screen wants, and it would contend for the same bridge lock a
  // ticket needs. It is NOT `script-only`: nothing runs it on a cadence and it has no side effects. It is NOT
  // `never-a-button` either — nothing about a click HERE would break the desk; there is simply nothing to
  // click. When the order-row testid is finally observed and the classifier lands, this is the route that
  // produced the evidence, which is why it stays.
  'POST /api/trading/orders/book-probe': 'diagnostic',
  'POST /api/trading/orders/trail-curve-probe': 'diagnostic',
  // ★ TRD-TRL-9 (2026-10-08): the READ-ONLY verification vehicle for the post-entry trail engage
  // (`setPositionTrail`, `commit:false` ALWAYS in this route). `diagnostic` — it drives the SHARED bridge tab
  // against a live position's Edit card, fills a count, reads the venue's own calculation back, and never
  // commits (nothing on that card arms until `#trade-button`, which it never presses). The reader is a person
  // or a script interpreting JSON, not a clicker; the commit path lives only in `agent/trailEngage` behind an
  // OFF flag.
  'POST /api/trading/orders/edit-trail-probe': 'diagnostic',
  // ★ TRD-PRU-3 (2026-10-08): the read-only candidate screen (category pages -> instrument rows -> spreads).
  // `diagnostic` — navigation-only, no ticket, no order; the reader is a script measuring the venue's own
  // offering, not a clicker, and it holds the bridge lock the same way the other probes do.
  'POST /api/trading/orders/instrument-screen-probe': 'diagnostic',
  // TRD-PRU-3b (2026-10-08): the per-symbol chart backfill (focus + series read; interval-verdict carried).
  // `diagnostic` — read-only reach plus a chart read; the reader is the candidate-profile study.
  'POST /api/trading/orders/instrument-bars-probe': 'diagnostic',

  // ★ TRD-PRM-1 (2026-10-04): the premium-analyses capture sweep. `script-only` — the desk's own 6h server tick
  // runs it (self-throttled ~20h via the ledger); a dashboard button adds no capability and would contend for the
  // bridge lock the capture itself needs.
  'POST /api/trading/analyses/capture': 'script-only',
};

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue; // vendored browsers live in dot-dirs
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

function parseRoutes() {
  const routes = [];
  for (const f of ROUTE_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const prefix = f.endsWith('routes.js') ? '/api/trading' : '';
    const re = /\b(?:router|app)\.(get|post|put|delete|patch)\(\s*(['"`])([^'"`]+)\2/g;
    let m;
    while ((m = re.exec(src))) {
      let p = m[3].replace(/\?.*$/, '');
      if (prefix && !p.startsWith('/api')) p = prefix + p;
      if (!p.startsWith('/api/trading')) continue;
      routes.push(`${m[1].toUpperCase()} ${p}`);
    }
  }
  return [...new Set(routes)];
}

function dashboardReferences() {
  const exact = new Set();
  const prefix = new Set();
  for (const f of walk(path.join(ROOT, UI_DIR))) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /\/api\/trading\/[A-Za-z0-9/_.:-]*/g;
    let m;
    while ((m = re.exec(src))) {
      const lit = m[0];
      if (lit.endsWith('/')) prefix.add(lit);
      else exact.add(lit.replace(/\/+$/, ''));
    }
  }
  return { exact: [...exact], prefix: [...prefix] };
}

function routeToRegex(p) {
  const parts = p.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp('^' + parts.join('/') + '$');
}

const ROUTES = parseRoutes();
const REFS = dashboardReferences();

function isReferenced(routeKey) {
  const p = routeKey.slice(routeKey.indexOf(' ') + 1);
  const re = routeToRegex(p);
  if (REFS.exact.some((lit) => re.test(lit))) return true;
  // `/api/trading/alerts/${id}` in the source names the prefix `/api/trading/alerts/` + one segment.
  return REFS.prefix.some((pre) => p.startsWith(pre) && p.length > pre.length && !p.slice(pre.length).includes('/'));
}

test('every registered route is either reachable from the dashboard or declared', () => {
  const undeclared = ROUTES.filter((r) => !isReferenced(r) && !(r in SCRIPT_ONLY));
  assert.deepEqual(
    undeclared,
    [],
    'these routes have no click path and no declared decision — wire them, or add them to SCRIPT_ONLY with a reason:\n  ' + undeclared.join('\n  ')
  );
});

test('nothing is declared script-only that the dashboard actually reaches', () => {
  const wrong = Object.keys(SCRIPT_ONLY).filter((r) => isReferenced(r));
  assert.deepEqual(
    wrong,
    [],
    'these are declared script-only but a screen now references them — remove them from SCRIPT_ONLY:\n  ' + wrong.join('\n  ')
  );
});

test('the declaration does not rot — every entry is a real route with a known category', () => {
  const bogus = Object.keys(SCRIPT_ONLY).filter((k) => !ROUTES.includes(k));
  assert.deepEqual(bogus, [], 'declared but no such route exists (renamed or removed?):\n  ' + bogus.join('\n  '));
  const badCat = Object.entries(SCRIPT_ONLY).filter(([, c]) => !CATEGORIES[c]);
  assert.deepEqual(badCat, [], 'unknown category — the set is closed, add it deliberately:\n  ' + JSON.stringify(badCat));
});

test('the route count and the decision coverage stay in view', () => {
  // Not a tautology: the numbers are the audit's own claim restated. 31 routes had no click path on
  // 2026-09-17; the manual close (F13A) removed one, and every remaining one is declared above.
  const declared = Object.keys(SCRIPT_ONLY).length;
  const unreferenced = ROUTES.filter((r) => !isReferenced(r)).length;
  assert.equal(unreferenced, declared, 'unreferenced routes and declared routes must be the same set');
  assert.ok(ROUTES.length >= 105, `expected the full route table, parsed ${ROUTES.length}`);
});
