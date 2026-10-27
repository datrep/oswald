'use strict';
// test/support/delivery.js — does THIS tree belong to a delivery that excluded a given path?
//
// ★★ WHY A DECLARATION AND NOT AN INFERENCE.
//
// Some guards read inputs that a delivery tree cannot carry: `temp/` scratch scripts, internal research notes under
// `trading/docs`. In that tree the question "does this file exist" is unevaluable — everything is absent — so a
// guard keyed on existence reports drift that is really policy.
//
// ⚠⚠ AND THE OBVIOUS FIX IS WRONG. `if (!fs.existsSync(dir)) skip()` makes a guard defeatable by DELETING ITS OWN
// INPUT, which is the cheapest attack on a guard and leaves a green tick behind. The distinction we need is
// "excluded on purpose" versus "gone", and only the tree can say which.
//
// So `scripts/deliver-code.js` writes `.delivery.json` at the root of every delivery, naming what it left out. A
// guard may skip ONLY when that file exists, declares itself a delivery, and names the path. In the working repo
// there is no such file, so a deleted input still fails exactly as it always did.
//
// ⚠ ONE PRODUCER: this file. Two guards already needed it by the time it was written (dead `temp/` citations and
// `trading/docs/INSTRUMENT_MIRROR.md`), and a helper copied into each would be the same drift in miniature.
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = path.join(__dirname, '..', '..', '.delivery.json');

// True only for a real delivery manifest that names `prefix` (or something under it) as excluded.
function deliveryExcludes(prefix) {
  try {
    const d = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (!d || d.delivered !== true || !Array.isArray(d.excluded)) return false;
    return d.excluded.some((p) => p === prefix || String(p).startsWith(prefix + '/'));
  } catch {
    return false;
  }
}

// The reason string a skipping test should print. Stated once so every guard explains itself the same way.
function excludedReason(prefix) {
  return `delivery tree: "${prefix}" is excluded by policy, so this guard's input is not present — declared in .delivery.json, not inferred from absence`;
}

module.exports = { deliveryExcludes, excludedReason, MANIFEST };
