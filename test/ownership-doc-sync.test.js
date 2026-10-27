'use strict';
// ownership-doc-sync.test.js — AGENTS.md §2 must not disagree with `store/ownership.js`.
//
// ★ WHY THIS EXISTS. On 2026-10-27 `AGENTS.md` still said `watchlist.symbols` was operator-owned and "never written by
// the machine", four hours after `store/ownership.js` began classifying it as CO-OWNED BY ENTRY to match what
// `agent/discoverer.js` actually does. That is the drift the whole "external artefacts" remedy is supposed to prevent,
// produced by the remedy itself. `AGENTS.md` §8 now states the rule (code is authoritative for behaviour; a mismatch
// is a docs bug); this test is what makes the rule a fact rather than a sentence.
//
// It fails in BOTH directions, which is what stops it rotting: a path added to the registry must appear in the doc,
// and the doc may not resurrect the one claim that was wrong.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ownership = require('../trading/store/ownership');

const AGENTS = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');

test('every path in the ownership registry is named in AGENTS.md', () => {
  for (const rule of ownership.RULES) {
    assert.ok(AGENTS.includes(rule.path),
      `AGENTS.md does not mention "${rule.path}" — the registry owns it and the doc must say so`);
  }
});

test('every ownership namespace AGENTS.md claims is in the registry', () => {
  // The other direction: a doc that invents a namespace the code does not know about is the same defect.
  const known = new Set(ownership.RULES.map((r) => r.path));
  for (const p of ['risk', 'deliberation', 'budget', 'bridge', 'kill.initialEquity', 'watchlist.universe', 'watchlist.candidates', 'discovery']) {
    assert.ok(known.has(p), `AGENTS.md names "${p}" but the registry does not contain it`);
  }
});

test('AGENTS.md does not claim watchlist.symbols is operator-owned — the exact regression', () => {
  // The machine writes this array every discovery cycle. If the doc says otherwise, a future session will "fix"
  // discoverer by making it stop, which is the opposite of correct.
  assert.doesNotMatch(AGENTS, /operator-owned[^.]*watchlist\.symbols/i,
    'watchlist.symbols is CO-OWNED BY ENTRY, not operator-owned');
  assert.match(AGENTS, /co-owned by entry/i, 'AGENTS.md must state the co-ownership');
  assert.match(AGENTS, /order is not ownership/i, 'AGENTS.md must record that array order is not ownership');
});

test('the ADR does not contradict the registry either', () => {
  // ⚠ THE FIRST VERSION OF THIS FILE CHECKED ONLY `AGENTS.md`. The ADR said the same wrong thing — that
  // `watchlist.symbols` is wholly operator-owned — and it went unnoticed because the guard looked at one document.
  // Two authorities disagreeing with each other is exactly the drift this is meant to stop, so both are checked.
  const adr = fs.readFileSync(path.join(__dirname, '..', 'docs', 'adr', 'ARCHITECTURE-DECISIONS.md'), 'utf8');
  assert.doesNotMatch(adr, /operator-owned[^\n]*`watchlist\.symbols`/i,
    'the ADR still classifies watchlist.symbols as operator-owned');
  assert.match(adr, /co-owned by entry/i, 'the ADR must state the co-ownership');
  assert.ok(adr.includes(ownership.MACHINE), 'the ADR must name the machine namespace in the same terms as the code');
});

test('AGENTS.md points at the registry as authoritative, not at itself', () => {
  assert.match(AGENTS, /trading\/store\/ownership\.js/,
    'the doc must name the registry, so a reader knows which source wins');
  assert.match(AGENTS, /this paragraph is the bug/i,
    'the precedence must be stated in the doc itself, not only in an ADR');
});

// ⚠ `temp/` IS NOT RETAINED, so a comment that cites a figure's producer and names a scratch script is worse than
// no citation: it READS AS PROVENANCE. `store.js` cited `temp/trail-grid.js` for the 5,359-breakout sweep whose
// numbers are still quoted as a basis for `takeProfitRR`.
//
// The first version of this check scanned every `trading/**/*.js` and reported 25 hits — but most were OUTPUT
// filenames (`temp/resim-exits-out.js`) rather than citations, so the check was measuring the wrong thing. It is now
// scoped to RUNTIME code (where a citation implies provenance) and excludes output artefacts.
//
// ⚠ AND IT IS A RATCHET, NOT A BLOCKER. Ten citations in live code point at scripts that are gone, and resolving
// them means either re-deriving the number or stating plainly that the producer no longer exists — neither of which
// a test can do. So the known set is recorded, a NEW one fails the build, and a known one that disappears must be
// removed from the list, so the list can only ever shrink.
const KNOWN_DEAD_CITATIONS = [
  'agent/geometryReplay.js -> temp/sweep-stop-cap.js',
  'agent/selfHealth.js -> temp/scope-resolver-probe.js',
  'agent/spreadDerivation.js -> temp/verify-79-derivation.js',
  'agent/stopPolicy.js -> temp/sweep-cost-share.js',
  'agent/stopPolicy.js -> temp/sweep-stop-cap.js',
  'agent/venueComparability.js -> temp/measure-venue-comparability.js',
  'agent/wakePipeline.js -> temp/verify-trd97.js',
  'plus500/webtrader.js -> temp/bridge-probe6-2026-10-03.js',
  'scopeResolution.js -> temp/scope-resolver-probe.js',
  'store.js -> temp/sweep-cost-share.js',
  'store.js -> temp/sweep-stop-cap.js',
];

function deadCitations() {
  const root = path.join(__dirname, '..', 'trading');
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // `scripts/` holds research code, and its `temp/` mentions are output paths rather than provenance.
        if (!/node_modules|\.chrome-profile|^scripts$/.test(e.name)) walk(p);
        continue;
      }
      if (!p.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/temp\/([A-Za-z0-9._-]+\.js)/g)) {
        if (/-out\.js$/.test(m[1])) continue;                      // an output artefact, not a citation
        if (!fs.existsSync(path.join(__dirname, '..', 'temp', m[1]))) {
          out.add(`${path.relative(root, p).replace(/\\/g, '/')} -> temp/${m[1]}`);
        }
      }
    }
  };
  walk(root);
  return [...out].sort();
}

// ★★ A DECLARED EXCLUSION, NOT AN INFERRED ONE.
//
// `temp/` is gitignored and can never ship, so in a delivery tree the question "does this script exist" is
// unevaluable: every citation looks dead. The guard must not treat that as drift, and it must not silently pass
// either — that is the §7 defect in a new costume.
//
// ⚠ AND IT MUST NOT BE A BARE `if (no temp dir) skip`. That would make the guard defeatable by DELETING its input,
// which is the cheapest attack on a guard and leaves a green tick behind. So the skip is allowed only when the tree
// DECLARES ITSELF a delivery in `.delivery.json` and names `temp` as excluded. In the working repo there is no such
// file, so a missing `temp/` still fails exactly as before. The helper lives in test/support/delivery.js because a
// second guard needed the same rule immediately.
const { deliveryExcludes, excludedReason } = require('./support/delivery');

test('no NEW comment cites a temp/ script that does not exist', (t) => {
  if (deliveryExcludes('temp')) {
    t.skip(excludedReason('temp'));
    return;
  }
  const known = new Set(KNOWN_DEAD_CITATIONS);
  const introduced = deadCitations().filter((x) => !known.has(x));
  assert.deepStrictEqual(introduced, [],
    'a comment cites a deleted scratch script as its provenance — state that the producer is gone, or re-derive it');
});

test('a KNOWN dead citation that has been fixed is removed from the list', () => {
  // Bidirectional, for the same reason `architecture-conformance` is: an allowlist nobody prunes is an allowlist that
  // silently absolves everything added to it later.
  const live = new Set(deadCitations());
  const stale = KNOWN_DEAD_CITATIONS.filter((x) => !live.has(x));
  assert.deepStrictEqual(stale, [],
    'these entries no longer exist in the source — delete them from KNOWN_DEAD_CITATIONS so the list can shrink');
});
