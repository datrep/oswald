#!/usr/bin/env node
/*
 * Guard + repair for the oversized Copilot repo-memory file.
 *
 * WHY THIS EXISTS (2026-09-24 incident):
 *   memories/repo/oswald.md reached 4.185 MB / 12,095 lines with 1,169 `## ` headings
 *   but only 144 unique names -> the file contained 8-16 byte-identical copies of
 *   itself. Reading it whole (`memory view /memories/repo/oswald.md`) blew the worker:
 *     "Worker terminated due to reaching memory limit: JS heap out of memory"
 *   and the ~450k-token tool result pushed the chat past its compaction threshold,
 *   which rewrote the prompt prefix and collapsed the DeepSeek cached prefix to 130.4k
 *   of 292.3k -> ds-watch TRIP #22 (rate 45%) -> circuit OPEN -> requests refused (429).
 *
 *   No workspace code writes this file; it is written by Copilot's own memory tool.
 *   So the bloat WILL recur -> run --check periodically.
 *
 * MODES:
 *   --check   report size + duplication; exit 1 if over the guard threshold (default)
 *   --write   de-duplicate in place, after copying the original to logs/archive/
 *
 * SAFETY: a section is dropped only when its ENTIRE text (heading + body) is
 * byte-identical to a section already kept. Unique content is never dropped and
 * original order is preserved (first occurrence wins).
 *
 * Usage:
 *   node scripts/dedupe-repo-memory.js                 # check
 *   node scripts/dedupe-repo-memory.js --write         # repair
 *   node scripts/dedupe-repo-memory.js --file <path>   # target another memory file
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Same authority the memory tool uses; keep this in sync with a hard-coded value
// only if its shape changes. Resolved by glob so it survives an extension update.
function resolveMemoryFile() {
  const i = process.argv.indexOf('--file');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];

  const root = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
  if (!fs.existsSync(root)) {
    throw new Error(`workspaceStorage not found: ${root}`);
  }
  for (const ws of fs.readdirSync(root)) {
    const dir = path.join(root, ws, 'GitHub.copilot-chat', 'memory-tool', 'memories', 'repo');
    if (fs.existsSync(dir)) return path.join(dir, 'oswald.md');
  }
  throw new Error(`no memory-tool repo dir under ${root}`);
}

// The file is never injected - it is only READ on demand - so its size on disk is NOT
// the binding constraint. What killed the worker was ONE unbounded read of 4,185 KB
// (2026-09-24 14:04:20, GitHub Copilot Chat.log). So the budget is per READ, not per file.
// Duplication stays a HARD failure: it multiplies every read and never adds content.
const READ_BUDGET_BYTES = 100 * 1024; // most one `memory view` should pull back
const BYTES_PER_TOKEN = 4;            // stated estimate, not a measurement
const BYTES_PER_LINE = 408;           // measured: 752 KB / 1,887 lines

const WRITE = process.argv.includes('--write');
const BACKUP_DIR = path.join(__dirname, '..', 'logs', 'archive');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';

function dedupe(raw) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  // Sections start at every `## ` heading; anything before the first one is the preamble.
  const sections = [];
  let cur = { heading: '__preamble__', lines: [] };
  for (const line of lines) {
    if (/^## /.test(line)) {
      sections.push(cur);
      cur = { heading: line, lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);

  const seen = new Map();
  const kept = [];
  const dropped = [];
  for (const s of sections) {
    const text = s.lines.join(eol);
    if (text.trim() === '') { kept.push(s); continue; }
    const key = s.heading + '\u0000' + text;
    if (seen.has(key)) dropped.push({ heading: s.heading, at: seen.get(key) });
    else { seen.set(key, kept.length); kept.push(s); }
  }

  // Collapse the runs of blank lines the deletions leave behind.
  const outLines = [];
  for (const s of kept) {
    for (const line of s.lines) {
      if (line.trim() === '' && outLines.length && outLines[outLines.length - 1].trim() === '') continue;
      outLines.push(line);
    }
  }
  while (outLines.length && outLines[outLines.length - 1] === '') outLines.pop();

  return { out: outLines.join(eol) + eol, outLines, sections, unique: seen.size, dropped };
}

const MEM = resolveMemoryFile();
const raw = fs.readFileSync(MEM, 'utf8');
const { out, outLines, sections, unique, dropped } = dedupe(raw);

const before = Buffer.byteLength(raw);
const after = Buffer.byteLength(out);
const reduction = (100 - (after / before) * 100);

console.log('file            :', MEM);
console.log('original        :', kb(before), '/', raw.split(/\r?\n/).length, 'lines /', sections.length, 'sections');
console.log('unique sections :', unique);
console.log('exact duplicates:', dropped.length);
console.log('projected       :', kb(after), '/', outLines.length, 'lines');
console.log('reduction       :', reduction.toFixed(1) + '%');
console.log('per-read budget :', kb(READ_BUDGET_BYTES), '-> safe slice ~' + Math.floor(READ_BUDGET_BYTES / BYTES_PER_LINE) + ' lines');
console.log('whole-read cost : ~' + Math.round(before / BYTES_PER_TOKEN).toLocaleString() + ' tokens',
  before <= READ_BUDGET_BYTES ? '(safe to read whole)' : '(NEVER read whole - use view_range)');

if (dropped.length) {
  const byHeading = dropped.reduce((m, d) => (m[d.heading] = (m[d.heading] || 0) + 1, m), {});
  console.log('\nmost-dropped headings:');
  for (const [h, n] of Object.entries(byHeading).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log('  x' + n, h.slice(0, 78));
  }
}

if (WRITE) {
  if (!dropped.length) {
    console.log('\nnothing to do - no exact duplicates found.');
    process.exit(0);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `oswald-repo-memory-${stamp}.md`);
  fs.copyFileSync(MEM, backup);
  fs.writeFileSync(MEM, out, 'utf8');
  console.log('\nbackup  :', backup, '(' + kb(fs.statSync(backup).size) + ')');
  console.log('written :', MEM, '(' + kb(fs.statSync(MEM).size) + ')');
  process.exit(0);
}

console.log('');
if (dropped.length) {
  console.log('REPAIR NEEDED - the file is duplicating itself, which inflates EVERY read.');
  console.log('Re-run with --write (backup is taken to logs/archive/ first).');
  process.exit(1);
}
console.log('OK - no exact duplicates.');
if (before > READ_BUDGET_BYTES) {
  console.log('File size is NOT a failure condition (it is never injected), but do not');
  console.log('read it whole: always pass view_range so one call stays under the read budget.');
}
