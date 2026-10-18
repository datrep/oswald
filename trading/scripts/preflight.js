#!/usr/bin/env node
'use strict';

/**
 * trading/scripts/preflight.js - refuse to boot the desk onto a damaged tree.
 *
 * WHY THIS EXISTS (2026-10-01)
 * ---------------------------
 * `trading/agent/aggregator.js` was found at **0 bytes** on disk. The volume had reached zero
 * free space, and a write that begins by truncating its target (fs.writeFileSync 'w', or
 * O_TRUNC) leaves a perfectly VALID empty file when the data write then fails with ENOSPC.
 *
 * That is the worst possible failure mode for a Node service, for three separate reasons:
 *
 *   1. A zero-byte module does NOT throw on require(). It resolves to `{}`. So the server
 *      boots, the crash guard records `event: 'start'`, /healthz answers 200, and the desk
 *      dies later on `aggregator.decide is not a function` - at a time and place unrelated
 *      to the cause.
 *   2. The test suite cannot see it. 2046 tests passed with the file empty on disk, because
 *      every test that requires the module still requires it successfully.
 *   3. The damage is invisible until a RESTART, which is exactly when you cannot afford to
 *      discover it. The running process held the good code in memory; a restart would have
 *      swapped a working desk for a dead one.
 *
 * A partial (non-zero) write is caught by `require` at boot with a real SyntaxError, which is
 * loud but still fatal - so it is checked here too, before anything is stopped.
 *
 * ORDERING IS THE POINT: restart-trading.ps1 runs this BEFORE it stops the running instance.
 * Aborting the restart leaves the old process serving. Restarting into a damaged tree is
 * strictly worse than not restarting at all.
 *
 * Usage:
 *   node trading/scripts/preflight.js
 *   node trading/scripts/preflight.js --min-free-gb 1 --warn-free-gb 5 --json
 *   node trading/scripts/preflight.js --dir <path>      (tests / other trees)
 *
 * Exit codes: 0 = pass (warnings allowed) | 1 = FAIL | 2 = usage error.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const TRADING_DIR = path.join(__dirname, '..');
const GB = 1024 * 1024 * 1024;

/**
 * Measured 2026-10-01 23:12:27-23:13:27: a Unity game wrote ~919 MB of asset cache in 60 s.
 * Used ONLY to translate free space into "seconds until zero", which is the number that
 * actually matters when deciding whether it is safe to start a service on this volume.
 */
const OBSERVED_BURST_MBPS = 919 / 60;

/**
 * Thresholds, and why these numbers.
 *
 * The desk's own footprint is tiny - logs and crash records are kilobytes. The floor is not
 * about the desk's needs; it is about the volume being SHARED. At the measured burst rate a
 * 1 GB floor is consumed in ~65 s, so 1 GB is the point below which a single burst can reach
 * zero *while the service is running* - which is the condition that truncated the file in the
 * first place. Below it we refuse.
 *
 * The warn band is 10 GB, chosen from the burst rate rather than from a round number: it is
 * ~11 minutes of headroom. On a 1862 GB volume an absolute figure this small is 0.5% of the
 * disk, which is why a percentage is NOT used - the hazard is not proportional to volume
 * size, it is absolute headroom versus an absolute burst rate. 2026-10-01 was exactly this
 * state (9.13 GB / 0.49% free) and it produced a truncated source file, so this band is
 * expected to WARN until the volume is cleaned up. That is not the guard crying wolf: it is
 * the same true fact repeating, on a machine where the fact cost the desk a working file.
 */
const DEFAULTS = { minFreeGb: 1, warnFreeGb: 10 };

// Never walked: build output and profile data, not source.
const ALWAYS_SKIP = new Set(['node_modules', '.git', '.chrome-profile']);
// `trading/public/js` is browser ES module code (import/export), which is not valid to parse as
// a classic script. Zero-byte is still checked there; only the parse step skips it.
const NO_PARSE = new Set(['public']);

// ---------------------------------------------------------------------------

/** Every .js under `dir`, skipping build output. Exported for tests. */
function walkJs(dir, { forParse = false } = {}) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not a reason to block a restart
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        if (forParse && NO_PARSE.has(e.name)) continue;
        stack.push(path.join(cur, e.name));
      } else if (e.isFile() && e.name.endsWith('.js')) {
        out.push(path.join(cur, e.name));
      }
    }
  }
  return out.sort();
}

/** Files of exactly zero length. This is the 2026-10-01 failure, caught directly. */
function zeroByteFiles(files) {
  const zero = [];
  for (const f of files) {
    try {
      if (fs.statSync(f).size === 0) zero.push(f);
    } catch {
      // Vanished between listing and stat. Not damage; ignore.
    }
  }
  return zero;
}

function firstLine(s) {
  const lines = String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // `node --check` prints the offending source line first and the reason further down
  // ("SyntaxError: Unexpected token"). Printing the first line alone gives the operator a
  // location with no cause, so prefer the line that names the error.
  const err = lines.find((l) => /Error/.test(l));
  if (err) return err;
  const nonFrame = lines.filter((l) => !l.startsWith('at '));
  return nonFrame[nonFrame.length - 1] || '';
}

/**
 * Parse every file. One process, not one per file: `node --check` per file cost 18 s for 318
 * files purely in process startup. vm.Script compiles in-process, which is ~50x faster.
 *
 * vm.Script is a CLASSIC script parse, so a legitimate ES module fails it. Rather than guess
 * or exclude by hand, we fall back to `node --check` as the authority for any file that fails
 * - the slow path runs at most a handful of times, and only on files that already look wrong.
 */
function syntaxFailures(files) {
  const bad = [];
  for (const f of files) {
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch (e) {
      bad.push({ file: f, why: 'unreadable: ' + e.message });
      continue;
    }
    if (src.length === 0) continue; // reported by the zero-byte check, not here
    try {
      new vm.Script(src, { filename: f });
      continue;
    } catch {
      /* fall through to the authority below */
    }
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push({ file: f, why: firstLine(r.stderr) });
  }
  return bad;
}

/** Free space on the volume holding `dir`. Never throws. */
function freeSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { ok: true, bytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 'pass' | 'warn' | 'fail' | 'unknown'.
 *
 * 'unknown' is deliberately NOT 'fail'. A guard that blocks the desk because it cannot read a
 * number is a new outage, not a protection. But it must never be mistaken for a green tick
 * either - the caller prints it as VOID so the absence of evidence is visible in the log.
 */
function classifyFreeSpace(bytes, { minFreeGb = DEFAULTS.minFreeGb, warnFreeGb = DEFAULTS.warnFreeGb } = {}) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < minFreeGb * GB) return 'fail';
  if (bytes < warnFreeGb * GB) return 'warn';
  return 'pass';
}

/**
 * Run every check and return a structured verdict.
 * `freeBytes` is injectable so tests never depend on the real disk.
 */
function runChecks(opts = {}) {
  const dir = opts.dir || TRADING_DIR;
  const minFreeGb = opts.minFreeGb ?? DEFAULTS.minFreeGb;
  const warnFreeGb = opts.warnFreeGb ?? DEFAULTS.warnFreeGb;

  const allJs = walkJs(dir);
  const zero = zeroByteFiles(allJs);
  const parse = syntaxFailures(walkJs(dir, { forParse: true }));

  const free = opts.freeBytes === undefined ? freeSpace(dir) : { ok: true, bytes: opts.freeBytes };
  const freeBytes = free.ok ? free.bytes : NaN;
  const verdict = classifyFreeSpace(freeBytes, { minFreeGb, warnFreeGb });

  const failures = [];
  if (verdict === 'fail') {
    failures.push({
      check: 'free-space',
      detail: `${(freeBytes / GB).toFixed(3)} GB free is below the ${minFreeGb} GB floor`,
    });
  }
  if (zero.length) failures.push({ check: 'zero-byte', detail: `${zero.length} empty module(s)`, files: zero });
  if (parse.length) failures.push({ check: 'syntax', detail: `${parse.length} file(s) will not parse`, files: parse });

  return {
    ok: failures.length === 0,
    dir,
    scanned: allJs.length,
    checks: {
      freeSpace: {
        verdict,
        bytes: Number.isFinite(freeBytes) ? freeBytes : null,
        totalBytes: free.ok ? free.totalBytes : null,
        error: free.ok ? null : free.error,
        minFreeGb,
        warnFreeGb,
      },
      zeroByte: { verdict: zero.length ? 'fail' : 'pass', files: zero },
      syntax: { verdict: parse.length ? 'fail' : 'pass', files: parse },
    },
    failures,
  };
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false, dir: null, minFreeGb: DEFAULTS.minFreeGb, warnFreeGb: DEFAULTS.warnFreeGb, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`preflight: --${a.replace(/^--/, '')} expects a non-negative number, got ${JSON.stringify(v)}`);
        process.exit(2);
      }
      return n;
    };
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--min-free-gb') out.minFreeGb = num(argv[++i]);
    else if (a === '--warn-free-gb') out.warnFreeGb = num(argv[++i]);
    else {
      console.error(`preflight: unknown argument ${JSON.stringify(a)}`);
      process.exit(2);
    }
  }
  if (out.warnFreeGb < out.minFreeGb) {
    console.error(`preflight: --warn-free-gb (${out.warnFreeGb}) must be >= --min-free-gb (${out.minFreeGb})`);
    process.exit(2);
  }
  return out;
}

const HELP = `preflight - refuse to boot the desk onto a damaged tree

  --dir <path>          tree to scan (default: trading/)
  --min-free-gb <n>     refuse below this    (default ${DEFAULTS.minFreeGb})
  --warn-free-gb <n>    warn below this      (default ${DEFAULTS.warnFreeGb})
  --json                machine-readable output
  --help                this text

Exit: 0 pass | 1 FAIL | 2 usage error`;

function report(r, { minFreeGb, warnFreeGb }) {
  const fsr = r.checks.freeSpace;
  const gb = (b) => (b / GB).toFixed(2);
  const lines = [];

  lines.push('--- preflight ---');
  lines.push(`  tree: ${r.dir}   (${r.scanned} .js file(s))`);

  if (fsr.verdict === 'unknown') {
    lines.push(`  VOID   free space could not be read (${fsr.error}) - not measured, NOT verified`);
  } else {
    const pct = fsr.totalBytes ? ((fsr.bytes / fsr.totalBytes) * 100).toFixed(2) : '?';
    const secs = Math.round(fsr.bytes / (OBSERVED_BURST_MBPS * 1024 * 1024));
    const tag = fsr.verdict === 'pass' ? 'OK  ' : fsr.verdict === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`  ${tag}   free space ${gb(fsr.bytes)} GB of ${gb(fsr.totalBytes)} GB (${pct}%)`);
    lines.push(`         ~${secs}s of headroom at the measured burst rate (${OBSERVED_BURST_MBPS.toFixed(1)} MB/s)`);
    if (fsr.verdict === 'warn') {
      lines.push(`         below the ${warnFreeGb} GB warn band - a burst writer can still reach zero`);
    }
    if (fsr.verdict === 'fail') {
      lines.push(`         below the ${minFreeGb} GB floor: a failed write here TRUNCATES its target (2026-10-01)`);
    }
  }

  lines.push(
    r.checks.zeroByte.verdict === 'pass'
      ? '  OK     no zero-byte modules'
      : `  FAIL   ${r.checks.zeroByte.files.length} ZERO-BYTE module(s) - require() resolves these to {} and will NOT throw`
  );
  for (const f of r.checks.zeroByte.files) lines.push(`           ${f}`);

  lines.push(
    r.checks.syntax.verdict === 'pass'
      ? '  OK     every file parses'
      : `  FAIL   ${r.checks.syntax.files.length} file(s) do not parse`
  );
  for (const f of r.checks.syntax.files) lines.push(`           ${f.file}\n             ${f.why}`);

  lines.push(r.ok ? 'PREFLIGHT PASS' : 'PREFLIGHT FAIL - do not restart onto this tree');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const r = runChecks({ dir: args.dir || undefined, minFreeGb: args.minFreeGb, warnFreeGb: args.warnFreeGb });
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else console.log(report(r, args));
  if (!r.ok) console.error(`PREFLIGHT FAILED: ${r.failures.map((f) => f.check).join(', ')}`);
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  walkJs,
  zeroByteFiles,
  syntaxFailures,
  freeSpace,
  classifyFreeSpace,
  runChecks,
  report,
  parseArgs,
  DEFAULTS,
  OBSERVED_BURST_MBPS,
};
