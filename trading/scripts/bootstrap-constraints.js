'use strict';
// trading/scripts/bootstrap-constraints.js — Phase 6 runner. Seeds the constraint ledger from `Instruments`.
//
//   node trading/scripts/bootstrap-constraints.js            # the operator's watchlist
//   node trading/scripts/bootstrap-constraints.js --all-spot # every spot instrument in the registry
//   node trading/scripts/bootstrap-constraints.js --dry      # show what would be written, write nothing
//
// ⚠ EVERY ROW LANDS WITH `effectiveFrom = null`, because `Instruments` cannot say when a term took effect — it
// upserts in place. That makes every row a CANDIDATE, which the resolver never treats as in force. The result is
// deliberately not a usable audit yet: it is the honest starting state, and the summary prints the coverage gap.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const store = require('../store');
const cstore = require('../store/constraints');
const registry = require('../store/instruments');
const boot = require('../agent/constraintBootstrap');

const USER = 1;
const argv = process.argv.slice(2);
const ALL = argv.includes('--all-spot');
const DRY = argv.includes('--dry');

(async () => {
  const settings = await store.getSettings(USER);
  const wanted = new Set(((settings.watchlist || {}).symbols || [])
    .map((s) => String((s && s.symbol) || s).trim()).filter(Boolean));

  const all = await registry.listInstruments(USER, { venue: boot.VENUE });
  const rows = all
    .filter((r) => r.instrumentClass === 'spot')
    .filter((r) => (ALL ? true : wanted.has(String(r.symbol || '').trim())))
    // One row per instrument id; the registry keeps one row per (venue, id) by upsert, but be explicit.
    .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));

  console.log(`bootstrap: ${rows.length} spot instrument(s) ${ALL ? '(all)' : '(watchlist)'}, ${wanted.size} watchlist symbol(s)`);
  if (!rows.length) {
    console.log('nothing to capture — the registry has no matching spot rows. A bootstrap with no source is not an');
    console.log('empty result, it is a broken read: capturing nothing would look identical to a quiet registry.');
    process.exit(0);
  }

  // ⚠ NO ARTEFACT WHEN NOTHING WILL REFERENCE IT. A scheduled re-run would otherwise write an identical file every
  // time, and an evidence store full of unreferenced files stops being evidence — a reader cannot tell which capture
  // a row came from. So the "is there anything new" pass happens FIRST, and an already-complete ledger exits without
  // touching the archive.
  let pending = 0;
  for (const row of rows) {
    for (const patch of boot.patchesForInstrument(row, { sourceUrl: null })) {
      if (!boot.alreadyPresent(await cstore.versionsFor(USER, patch.constraintKey), patch)) pending += 1;
    }
  }
  const prohibitionRow = boot.venueProhibition();
  if (!boot.alreadyPresent(await cstore.versionsFor(USER, prohibitionRow.constraintKey), prohibitionRow)) pending += 1;
  if (!pending && !DRY) {
    console.log('nothing new to capture — the ledger already holds every assertion this run would make.');
    console.log('no artefact written, no row appended.');
    process.exit(0);
  }

  const artefact = DRY ? { ref: '(dry run)', digest: null } : boot.writeArtefact(rows);
  console.log(`artefact: ${artefact.ref}`);

  const summary = { created: 0, skipped: 0, failed: 0, instruments: 0, byField: {} };
  for (const row of rows) {
    const patches = boot.patchesForInstrument(row, { sourceUrl: null });
    if (!patches.length) continue;
    summary.instruments += 1;
    for (const patch of patches) {
      const prior = await cstore.versionsFor(USER, patch.constraintKey);
      const field = patch.constraintKey.split('.').pop();
      if (boot.alreadyPresent(prior, patch)) { summary.skipped += 1; continue; }
      if (DRY) { summary.created += 1; summary.byField[field] = (summary.byField[field] || 0) + 1; continue; }
      try {
        await cstore.appendVersion(USER, {
          ...patch,
          recordedBy: 'bootstrap',
          evidenceArtifactRef: artefact.ref,
          evidenceDigest: artefact.digest,
          evidenceExcerpt: `${row.symbol || patch.venueInstrumentId}: ${JSON.stringify({
            unitAmount: row.unitAmount, unitKind: row.unitKind, initialMarginPct: row.initialMarginPct,
            fundingBuyPct: row.fundingBuyPct, fundingSellPct: row.fundingSellPct, fundingTime: row.fundingTime,
          })}`.slice(0, 1000),
        });
        summary.created += 1;
        summary.byField[field] = (summary.byField[field] || 0) + 1;
      } catch (e) {
        summary.failed += 1;
        console.error(`  ! ${patch.constraintKey}: ${String(e.message).slice(0, 160)}`);
      }
    }
  }

  // The venue-wide prohibition is one row, not one per instrument.
  const prohibition = boot.venueProhibition();
  const prior = await cstore.versionsFor(USER, prohibition.constraintKey);
  if (boot.alreadyPresent(prior, prohibition)) summary.skipped += 1;
  else if (DRY) { summary.created += 1; summary.byField.single_tab = 1; }
  else {
    try {
      await cstore.appendVersion(USER, { ...prohibition, recordedBy: 'bootstrap' });
      summary.created += 1; summary.byField.single_tab = 1;
    } catch (e) { summary.failed += 1; console.error(`  ! ${prohibition.constraintKey}: ${e.message}`); }
  }

  console.log(`\ninstruments covered : ${summary.instruments}`);
  console.log(`rows created        : ${summary.created}${DRY ? ' (dry)' : ''}`);
  console.log(`rows already present: ${summary.skipped}`);
  console.log(`failed              : ${summary.failed}`);
  console.log(`by field            : ${JSON.stringify(summary.byField)}`);
  console.log('\n⚠ EVERY ROW IS UNDATED (effectiveFrom = null), so every one is a CANDIDATE and NEVER in force.');
  console.log('   An audit of any trade will therefore be `unassessable` until a term can be dated — either by');
  console.log('   capturing the venue page either side of a change, or by a document that states when it took effect.');
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
