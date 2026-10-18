// test/_source.js — shared source reader for STRUCTURAL assertions.
//
// Reads a source file and strips its comments, so an assertion cannot pass (or
// fail) on its own documentation. Structural tests exist because some modules
// cannot be required from a unit test at all — `executor` attaches to the desk's
// live Chrome on :9224, `aggregator` opens a DB pool — so the only thing left to
// assert about their CALL SITES is their text.
//
// ⚠ THE CRLF TRAP — FOUND 2026-09-14, AFTER IT SILENTLY NO-OPED EVERYWHERE.
// Every source in this repo is CRLF (verified: 100% on promptBuilder.js,
// aggregator.js, quant.js, committee.js, executor.js, maintenance.js). In
// JavaScript `.` does NOT match `\r`, and a non-multiline `$` cannot match
// immediately before it either. So the natural-looking form
//
//     src.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
//
// matches NOTHING on a CRLF file and fails SILENTLY — the "stripped" source still
// contains every comment, so every negative assertion is really testing prose.
// That is the same failure shape as the original bridge-maintenance defect (a
// `doesNotMatch` matching the comment explaining why the call was absent), but
// inverted and much harder to notice: it makes tests PASS on documentation.
//
// THE CORRECT FORM, and the reason this module exists rather than three copies:
// operate on the WHOLE string with the `g` flag and use `[^\n]*` (which DOES
// match `\r`) instead of `.*$`. `://` is preserved so URLs inside string
// literals survive the strip.
//
// test/bridge-maintenance.test.js still carries its own copy of this (it is
// already in the correct form). Consolidating it here is a small, deliberate
// tidy-up, not a fix.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Raw file text.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// File text with comments removed — assert against this, never against `read`.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

module.exports = { read, code, ROOT };
