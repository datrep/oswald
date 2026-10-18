// ★ The preflight gate, proved on the REFUSE side first.
//
// ⚠ A GATE THAT ONLY PROVES THE PASS SIDE IS NOT A GATE. The whole reason this file exists is
// the 2026-10-01 incident, where `trading/agent/aggregator.js` sat on disk at 0 BYTES while the
// service ran happily from memory and 2046 tests passed. So the load-bearing assertions below
// are the FAILING ones: a zero-byte module must fail, a file that will not parse must fail, and
// free space below the floor must fail.
//
// ⚠ AND THE SUBTLEST ONE: free space that CANNOT BE MEASURED must report `unknown`, never
// `pass`. A guard that cannot read a number and then reports success is worse than no guard,
// because it converts "I did not check" into "I checked and it is fine" — the same class of
// error as the `undefined === undefined` green tick in register-instrument.js.
//
// The last test is the contract that matters in production: restart-trading.ps1 branches on the
// CLI's EXIT CODE, so the exit code is asserted directly rather than inferred from internals.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pf = require('../trading/scripts/preflight');

const GB = 1024 ** 3;
const CLI = path.join(__dirname, '..', 'trading', 'scripts', 'preflight.js');

/** A throwaway tree. Returns its path. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

// A healthy amount of free space for tests that are not about free space. Injected rather than
// read, so these assertions do not change meaning when the real machine gets full.
const PLENTY = 500 * GB;

test('★★ REFUSE: a ZERO-BYTE module fails the preflight — the 2026-10-01 failure, reproduced', () => {
  const dir = fixture({ 'good.js': 'module.exports = { ok: 1 };\n', 'agent/zero.js': '' });
  const r = pf.runChecks({ dir, freeBytes: PLENTY });

  assert.strictEqual(r.ok, false, 'a zero-byte module MUST fail the preflight');
  const f = r.failures.find((x) => x.check === 'zero-byte');
  assert.ok(f, 'the failure must be attributed to zero-byte, not swallowed by another check');
  assert.strictEqual(f.files.length, 1);
  assert.ok(f.files[0].endsWith('zero.js'));
  // The good file must NOT be implicated - a check that flags everything is not a check.
  assert.ok(!f.files.some((p) => p.endsWith('good.js')));
});

test('★ REFUSE: a module that will not parse fails, and reports the REASON not just the location', () => {
  const dir = fixture({ 'broken.js': 'function ( {\n' });
  const r = pf.runChecks({ dir, freeBytes: PLENTY });

  assert.strictEqual(r.ok, false);
  const f = r.failures.find((x) => x.check === 'syntax');
  assert.ok(f);
  assert.strictEqual(f.files.length, 1);
  // `node --check` prints the offending line first; printing only that gives a location with
  // no cause. The operator needs "SyntaxError: ...".
  assert.match(f.files[0].why, /Error/, `expected the reason, got: ${JSON.stringify(f.files[0].why)}`);
});

test('PASS: a clean tree passes', () => {
  const dir = fixture({ 'good.js': 'module.exports = { ok: 1 };\n' });
  const r = pf.runChecks({ dir, freeBytes: PLENTY });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.failures, []);
  assert.strictEqual(r.checks.zeroByte.verdict, 'pass');
  assert.strictEqual(r.checks.syntax.verdict, 'pass');
});

test('★★ free space: fail below the floor, warn inside the band, pass above it', () => {
  const opts = { minFreeGb: 1, warnFreeGb: 10 };
  assert.strictEqual(pf.classifyFreeSpace(0.5 * GB, opts), 'fail', 'below the floor');
  assert.strictEqual(pf.classifyFreeSpace(1 * GB, opts), 'warn', 'exactly at the floor is not below it');
  assert.strictEqual(pf.classifyFreeSpace(9 * GB, opts), 'warn', 'the live 2026-10-01 condition');
  assert.strictEqual(pf.classifyFreeSpace(10 * GB, opts), 'pass');
  assert.strictEqual(pf.classifyFreeSpace(500 * GB, opts), 'pass');
});

test('★★ a free space that cannot be measured is UNKNOWN — never a silent pass', () => {
  assert.strictEqual(pf.classifyFreeSpace(NaN), 'unknown');
  assert.notStrictEqual(pf.classifyFreeSpace(undefined), 'pass');

  const dir = fixture({ 'good.js': 'module.exports = {};\n' });
  const r = pf.runChecks({ dir, freeBytes: NaN });
  assert.strictEqual(r.checks.freeSpace.verdict, 'unknown');
  // Unknown must NOT block the desk: a guard that causes an outage is a new defect.
  assert.strictEqual(r.ok, true, 'unmeasurable free space must not refuse the restart');
  assert.strictEqual(r.failures.length, 0);
});

test('★ free space below the floor FAILS and says why the floor exists', () => {
  const dir = fixture({ 'good.js': 'module.exports = {};\n' });
  const r = pf.runChecks({ dir, freeBytes: 0.25 * GB });
  assert.strictEqual(r.ok, false);
  const f = r.failures.find((x) => x.check === 'free-space');
  assert.ok(f);
  assert.match(f.detail, /floor/);
});

test('★ the walk skips build output and profile data, and skips public/ only for parsing', () => {
  const dir = fixture({
    'keep.js': 'module.exports = {};\n',
    'node_modules/dep/index.js': 'module.exports = {};\n',
    '.chrome-profile/Default/x.js': 'x = 1;\n',
    'public/js/app.js': 'export default 1;\n',
  });

  const all = pf.walkJs(dir).map((p) => path.relative(dir, p));
  assert.ok(all.includes(path.join('keep.js')), 'real source must be walked');
  assert.ok(all.includes(path.join('public', 'js', 'app.js')), 'public/ is still checked for zero length');
  assert.ok(!all.some((p) => p.includes('node_modules')), 'node_modules must never be walked');
  assert.ok(!all.some((p) => p.includes('.chrome-profile')), '.chrome-profile must never be walked');

  const parsed = pf.walkJs(dir, { forParse: true }).map((p) => path.relative(dir, p));
  assert.ok(!parsed.some((p) => p.includes('public')), 'public/ is browser ESM and must not be parsed as CJS');
  // Browser ESM must not be reported as damage: that would be a false alarm on a healthy tree.
  const r = pf.runChecks({ dir, freeBytes: PLENTY });
  assert.strictEqual(r.checks.syntax.verdict, 'pass', 'export/import in public/ is not a syntax failure');
});

test('★ the real trading/ tree has no zero-byte modules — the invariant that cost us tonight', () => {
  const zero = pf.zeroByteFiles(pf.walkJs(path.join(__dirname, '..', 'trading')));
  assert.deepStrictEqual(zero, [], `zero-byte module(s) on disk: ${zero.join(', ')}`);
});

test('★★ CONTRACT: the CLI exit code is what restart-trading.ps1 branches on', () => {
  const clean = fixture({ 'good.js': 'module.exports = {};\n' });
  const damaged = fixture({ 'good.js': 'module.exports = {};\n', 'zero.js': '' });

  const okRun = spawnSync(process.execPath, [CLI, '--dir', clean, '--min-free-gb', '0', '--warn-free-gb', '0'], {
    encoding: 'utf8',
  });
  assert.strictEqual(okRun.status, 0, `clean tree must exit 0, got ${okRun.status}: ${okRun.stdout}`);

  const badRun = spawnSync(process.execPath, [CLI, '--dir', damaged, '--min-free-gb', '0', '--warn-free-gb', '0'], {
    encoding: 'utf8',
  });
  assert.strictEqual(badRun.status, 1, 'damaged tree MUST exit non-zero or the restart will not abort');
  // The abort has to be legible in the terminal the operator is watching.
  assert.match(badRun.stdout, /PREFLIGHT FAIL/);
  assert.match(badRun.stderr, /PREFLIGHT FAILED/);

  const usageRun = spawnSync(process.execPath, [CLI, '--min-free-gb', '9', '--warn-free-gb', '1'], { encoding: 'utf8' });
  assert.strictEqual(usageRun.status, 2, 'a contradictory threshold is a usage error, not a pass or a fail');
});
