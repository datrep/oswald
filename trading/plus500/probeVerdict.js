'use strict';
// trading/plus500/probeVerdict.js — WHAT "ok" MEANS FOR A PROBE RUN.
//
// ⚠⚠ WHY THIS IS A MODULE AND NOT A BOOLEAN. Both branches of `instrumentProbe.run()` emitted the LITERAL `ok: true`
// — including a chain scan that found NO ROWS and clicked NOTHING, and a single probe that landed on a page with no
// instrument table at all. Measured 2026-10-27: the one scheduled refresh run reported
// `ok: true, rowsOnPage: 0, scanned: 0`, and `instrumentRefresh` — which keyed its own success on `!!out` —
// collected on the strength of it. A probe that read nothing was reporting health while the registry sat frozen.
//
// ⚠ THE TWO PATHS ASK DIFFERENT QUESTIONS, so they need different criteria and neither is `true`:
//   · a SCAN asked "walk the rows on this page and read each contract". A page with no rows is a FAILED scan, and so
//     is clicking rows that yield no contract;
//   · a single PROBE asked either "read this page" or "read THIS instrument's sidebar". `tableFound` decides the
//     first and `contract` decides the second, and which was asked depends on whether the caller passed `select` or
//     `symbol`. Judging a plain page read by `contract` would mark a genuine success as a failure — the mirror
//     defect, and just as expensive as the one above.
//
// ⚠ IT IS EXTRACTED, NOT INLINE, because `instrumentProbe` top-level-requires `./browser`: a test that loaded it
// would try to attach to the desk's live Chrome. The repo's pattern for this exact problem is a pure module
// (`deliberationScope`, `staleExit`, `sizeReconcile.sizeVerdict`), and it is followed here for the same reason —
// a branch that can only be exercised against a live venue is a branch nobody exercises.
//
// PURE: no browser, no clock, no I/O.

function probeVerdict({
  mode = 'probe',
  tableFound = null,
  rowsOnPage = null,
  scanned = null,
  withSpec = null,
  contractExpected = false,
  contractFound = false,
} = {}) {
  if (mode === 'scan') {
    if (!(Number(rowsOnPage) > 0)) return { ok: false, reason: 'no_rows' };
    if (!(Number(scanned) > 0)) return { ok: false, reason: 'no_rows_scanned' };
    // `withSpec` is optional so a caller that has not computed it is not silently failed — but when it IS supplied
    // and zero, the scan clicked rows and came away with no contract, which is a failed read rather than a quiet one.
    if (withSpec != null && !(Number(withSpec) > 0)) return { ok: false, reason: 'no_contract_read' };
    return { ok: true, reason: 'scanned' };
  }
  if (tableFound !== true) return { ok: false, reason: 'no_table' };
  if (contractExpected && !contractFound) return { ok: false, reason: 'no_contract' };
  return { ok: true, reason: contractFound ? 'probed' : 'page_only' };
}

module.exports = { probeVerdict };
