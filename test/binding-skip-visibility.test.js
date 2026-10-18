// test/binding-skip-visibility.test.js — TRD-84 question 2 (2026-09-22).
//
// ★ THE ROW ASKED: "Should a budget refusal be VISIBLE? A proposal that never happened because of a cap is
// indistinguishable from a proposal that had nothing to say."
//
// MEASURED ANSWER WHEN THIS WAS WRITTEN: the skip WAS recorded and READ BY NOBODY. `binding_proposer_skipped`
// had exactly ONE match in the whole repository — the `store.logEvent` that writes it in wakePipeline.js. So
// the event existed, carried the reason, and reached no surface at all: the panel would render a STALE
// proposal as though it were the current answer, and a reviewer refused on budget looked exactly like a
// reviewer that had nothing to say. That is the same shape as TRD-77 ("a control that fails silently needs a
// detector").
//
// The fix is a reader plus the distinction, and the distinction is a TIMESTAMP: a skip NEWER than the newest
// proposal means the last attempt did not run. A skip OLDER than it is history and must not be dressed up as
// a current problem — reporting that as "did not run" would be the mirror-image error of the one being fixed.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'routes.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'public', 'js', 'app.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
const pipelineSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'wakePipeline.js'), 'utf8');

const codeOnly = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
const routes = codeOnly(routesSrc);
const app = codeOnly(appSrc);

test('the premise: the skip is still WRITTEN, and latestEvent still supports a source filter', () => {
  // Without the writer the reader has nothing to read and this file would pass over an empty feature; without
  // the source filter the read would have to page telemetry rows and hope the skip is inside the page — which
  // is the F32 lesson.
  assert.match(pipelineSrc, /source: 'binding_proposer_skipped'/,
    'the skip event must still be logged with this source tag, or the reader reads nothing');
  assert.match(codeOnly(storeSrc), /async function latestEvent\(userId, kind, \{ source = null \} = \{\}\)/,
    'latestEvent must keep its source filter');
  assert.match(codeOnly(storeSrc), /JSON_VALUE\(payload, '\$\.source'\)/,
    'the source filter must be applied in SQL, not by filtering a page of rows');
});

test('★ the route READS the skip and returns it, so a surface can exist at all', () => {
  const route = routes.slice(routes.indexOf("router.get('/binding'"));
  const body = route.slice(0, route.indexOf('\n}));'));
  assert.match(body, /store\.latestEvent\(req\.user\.userID, 'telemetry', \{ source: 'binding_proposer_skipped' \}\)/,
    'the binding route must read the skip event by source');
  assert.match(body, /lastSkip,/, 'and must return it — a read that is not returned fixes nothing');
  assert.match(body, /reason: \(e\.payload && e\.payload\.reason\) \|\| null/, 'the reason must travel, not just the timestamp');
  assert.match(body, /stranded: /, 'whether a stranded proposal was re-offered is part of why it did not run');
  // It must degrade rather than throw: the binding panel is not worth a 500.
  assert.match(body, /\.catch\(\(\) => null\)/, 'a missing or failing skip read must not fail the route');
});

test('★ the panel separates "did NOT run" from "had nothing to say", by TIMESTAMP', () => {
  // The distinction cannot be made from the skip alone: an old skip next to a newer proposal means the
  // reviewer ran perfectly well afterwards.
  assert.match(app, /const skipNewer = !!\(skip && skipAt > propAt\)/,
    'the two states must be separated by comparing the skip against the newest proposal');
  assert.match(app, /Last reviewer attempt did NOT run/,
    'the did-not-run state must be stated, not implied by an absence');
  assert.match(app, /a later proposal exists, so this is history/,
    'an OLD skip must be labelled as history — the mirror-image error is dressing history up as a current fault');
  // The heading carries it too: it is what stays visible when the body is scrolled.
  assert.match(app, /last attempt skipped \(/, 'the heading must carry the skip, not only the body');
});

test('★ the skip line is rendered into the panel', () => {
  // Computed-but-not-rendered is the exact defect this task is about, one layer down.
  assert.match(app, /const skipLine = skip/, 'the skip must be composed');
  assert.match(app, /\$\{skipLine\}\$\{scopeRows\}/, 'and must be interpolated into the panel markup');
});
