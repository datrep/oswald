// trading/plus500/matching.js — class-aware instrument-name matching (TRD-36).
//
// Why this module exists (verified live 2026-09-11): the venue's search
// surfaces OPTION instruments for plain spot queries — querying "Oil" returns
// "Oil | Call 101 | Sep W2". The old matcher (exact -> startsWith -> includes,
// first hit wins) could therefore select an option while intending spot, and
// the capture path would bank option PREMIUMS into the spot symbol's tick
// stream (a silent poison of the signal series). Every spot-intent resolve
// path goes through these pickers now; option rows are skipped unless the
// caller opts in (allowOptions) or the query itself is option-shaped.
//
// Pure functions (no DOM, no IO) — pinned by test/class-matching.test.js.
'use strict';

// Structured option naming: "<Underlying> | Call/Put <strike> | <expiry>".
// A plain pipe (e.g. the search row's "D05.SGX | DBS Group") is NOT an option.
const OPTION_RE = /\|\s*(call|put)\b/i;

function cleanName(s) {
  return String(s == null ? '' : s)
    .replace(/[\u200e\u200f\u200b\u00a0]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function isOptionName(name) {
  return OPTION_RE.test(cleanName(name));
}

// First acceptable match over the FULL item list (exact -> startsWith ->
// includes). Disallowed-class items are skipped but KEEP their index, so the
// returned index stays valid for keyboard navigation over the raw list.
// An option-shaped query implies option intent even without the flag.
function pickIndex(names, query, { allowOptions = false } = {}) {
  const q = cleanName(query).toLowerCase();
  if (!q) return -1;
  const allow = allowOptions || isOptionName(query);
  const ok = (n) => allow || !isOptionName(n);
  const list = (names || []).map((n) => cleanName(n).toLowerCase());
  let i = list.findIndex((n) => n === q && ok(n));
  if (i === -1) i = list.findIndex((n) => n.startsWith(q) && ok(n));
  if (i === -1) i = list.findIndex((n) => n.includes(q) && ok(n));
  return i;
}

// Same scoring for table rows ({ name, ... }) — used by searchInstrument's
// table fallback and by matchRow (discoverer / category paths).
function pickRow(rows, query, { allowOptions = false } = {}) {
  const list = rows || [];
  const idx = pickIndex(list.map((r) => (r && r.name) || ''), query, { allowOptions });
  return idx === -1 ? null : list[idx];
}

module.exports = { cleanName, isOptionName, pickIndex, pickRow };
