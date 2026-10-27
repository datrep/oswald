'use strict';
// scripts/deliver-code.js — build the public delivery tree from `main` and commit it on top of `origin/main`.
//
// ★★ WHY THIS FILE EXISTS. The delivery was previously a procedure held in an agent's memory: which paths to copy,
// which to leave out. On 2026-10-27 that procedure let **47 Plus500 premium-analysis screenshots** into a PUBLIC
// repository, where they sat for nine days. The exclusion list is a fact with exactly one correct home, and a
// remembered list is a second producer that drifts the moment nobody is looking. So it lives here.
//
// ⚠⚠ THE LIST FAILS CLOSED: an entry ships only if it is NAMED. A blacklist fails open — a new directory appears and
// is published by default. Every one of those 47 files would have been excluded by a whitelist without anyone
// remembering to add it.
//
// ⚠ SECOND DEFECT THIS FILE CLOSES. The old procedure ran `git checkout main -- .`, which copies COMMITTED state
// only. On 2026-10-27 that shipped a tree in which this session's work was absent while the commit message claimed
// it — so the "fresh clone builds clean" proof was run against stale code and proved less than it appeared to. The
// dirty check below is scoped to the paths that actually ship, and it REFUSES rather than proceeding quietly.
//
// Usage:
//   node scripts/deliver-code.js                 # build and commit into a temp worktree, then report
//   node scripts/deliver-code.js --push          # ...and force-push the branch
//   node scripts/deliver-code.js --keep          # leave the worktree for inspection
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SOURCE = 'main';
const BASE = 'origin/main';
const BRANCH = 'code-delivery';

// ── WHAT SHIPS ───────────────────────────────────────────────────────────────────────────────────────────────
// Top-level entries that are CODE. Everything not named here is absent from the delivery by default.
const ALLOW_TOP = [
  '.gitignore', 'Enable-DeskWol.ps1', 'Ensure-Services.ps1', 'README.md',
  'config', 'controllers', 'expenses', 'fileserver', 'listings', 'middlewares', 'models',
  'package.json', 'package-lock.json', 'public', 'routes', 'scripts', 'services', 'shared',
  'sql', 'test', 'trading', 'utils',
];

// Removed even though they sit inside an allowed tree. `trading/data` is the one that mattered: it holds captured
// Plus500 premium-analysis screenshots — THIRD-PARTY COPYRIGHTED CONTENT, never ours to publish.
// ⚠ The three `.json` files are GENERATED desk state, not assets: the desk rewrites them every wake, and
// `desk-mirror.json` carries live equity and position data. Publishing them would leak account state, and shipping
// their committed copies would publish a snapshot that was already stale when it was written.
const DENY = [
  'trading/docs',      // internal analysis, not code
  'trading/data',      // captured artefacts, incl. third-party copyrighted images
  'trading/archive',   // retained evidence, gitignored on purpose
  'trading/public/bridge-state.json',
  'trading/public/bridge-state-graph.json',
  'trading/public/desk-mirror.json',
];

// ── BUILD INPUTS: the one legitimate reason a document ships ─────────────────────────────────────────────────
// Not "docs are now allowed". These are files the CODE READS, so a tree without them cannot run its own suite:
// `test/ownership-doc-sync.test.js` binds both to `store/ownership.js` and throws at module load if either is
// missing. The rule this encodes: exclude prose freely; ship anything a test reads, or the guard is unrunnable in
// the only tree that has CI.
const BUILD_INPUTS = [
  'AGENTS.md',
  'docs/adr/ARCHITECTURE-DECISIONS.md',
];

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const git = (args, cwd = REPO) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitQuiet = (args, cwd = REPO) => { try { return git(args, cwd); } catch { return null; } };
const under = (p, prefix) => p === prefix || p.startsWith(prefix + '/');
const allowed = (p) => {
  if (BUILD_INPUTS.includes(p)) return true;
  if (!ALLOW_TOP.some((t) => under(p, t))) return false;
  if (DENY.some((d) => under(p, d))) return false;
  return true;
};

// ⚠ A build input under a DENY prefix is a contradiction, and silently preferring one side would either publish
// denied content or break the suite. Refuse.
for (const bi of BUILD_INPUTS) {
  const clash = DENY.find((d) => under(bi, d));
  if (clash) {
    console.error(`FATAL: build input "${bi}" is under denied prefix "${clash}" — resolve the contradiction in the script, do not let one win silently.`);
    process.exit(2);
  }
}

// ── the dirty check, SCOPED TO WHAT SHIPS ────────────────────────────────────────────────────────────────────
// A dirty `legal/` is irrelevant; a dirty `trading/constraints.js` means the delivery would carry the old version.
// ⚠ A DENIED path is exempt by construction: it cannot ship, so its dirtiness cannot make the delivery stale. Two of
// those are rewritten by the desk several times an hour, and a check that is permanently red on them is a check
// nobody keeps.
function dirtyInScope() {
  const out = git(['status', '--porcelain', '-uall']).split('\n').filter(Boolean);
  return out.filter((line) => {
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    p = p.replace(/^"|"$/g, '').split(path.sep).join('/');
    if (DENY.some((d) => under(p, d))) return false;
    return allowed(p);
  });
}

const dirty = dirtyInScope();
if (dirty.length) {
  console.error('REFUSED: these shipping paths have uncommitted changes, so the delivery would carry the COMMITTED version while claiming the working one:');
  for (const d of dirty.slice(0, 20)) console.error('  ' + d);
  if (dirty.length > 20) console.error(`  … and ${dirty.length - 20} more`);
  console.error('\nCommit them, or exclude the paths in ALLOW_TOP/DENY, then re-run. This refusal exists because on 2026-10-27 a delivery shipped without the session\'s work and the build proof passed against stale code.');
  process.exit(1);
}

// ── build ────────────────────────────────────────────────────────────────────────────────────────────────────
const wt = path.join(os.tmpdir(), `oswald-delivery-${Date.now()}`);
git(['worktree', 'add', '--detach', '-q', wt, BASE]);
let pushed = false;
try {
  // 1. Bring in the named paths from SOURCE **FIRST**. `git checkout` reads the COMMITTED tree, which is why the
  //    dirty check above is the only thing standing between a stale delivery and a green build proof.
  //
  // ⚠⚠ THE ORDER MATTERS, AND THE FIRST VERSION OF THIS FILE HAD IT BACKWARDS. Stripping the base tree BEFORE the
  // checkout let `checkout main -- trading` re-introduce `trading/data/analyses-img` from a branch that still tracks
  // it — 47 third-party screenshots came straight back in, and the suspect check below is the only reason they did
  // not reach a public remote. Removal must run AFTER the copy.
  const present = ALLOW_TOP.concat(BUILD_INPUTS).filter((p) => {
    const ok = gitQuiet(['cat-file', '-e', `${SOURCE}:${p}`]) != null
      || gitQuiet(['rev-parse', '--verify', '--quiet', `${SOURCE}:${p}`]) != null;
    return ok;
  });
  git(['checkout', SOURCE, '--', ...present], wt);

  // 2. Strip anything that must not ship, on the tree AS IT NOW STANDS — by top-level entry (so a base that predates
  //    this script is corrected on the way through) and by denied prefix.
  const top = fs.readdirSync(wt, { withFileTypes: true }).map((e) => e.name).filter((n) => n !== '.git');
  for (const name of top) {
    if (ALLOW_TOP.includes(name) || BUILD_INPUTS.some((b) => under(b, name))) continue;
    gitQuiet(['rm', '-r', '-q', '--ignore-unmatch', '--', name], wt);
    fs.rmSync(path.join(wt, name), { recursive: true, force: true });
  }
  for (const d of DENY) {
    gitQuiet(['rm', '-r', '-q', '--ignore-unmatch', '--', d], wt);
    fs.rmSync(path.join(wt, d), { recursive: true, force: true });
  }

  // 3. Assert every build input actually arrived. A missing one is a suite that cannot run, not a smaller delivery.
  const missing = BUILD_INPUTS.filter((p) => !fs.existsSync(path.join(wt, p)));
  if (missing.length) throw new Error(`build inputs missing from the delivery tree: ${missing.join(', ')}`);

  // 4. Declare the tree's own shape. `.delivery.json` is what lets a guard say "this input is excluded by POLICY"
  // instead of inferring it from absence — so a deleted input in the working repo still fails while a deliberately
  // excluded one is reported as a named skip.
  fs.writeFileSync(path.join(wt, '.delivery.json'), JSON.stringify({
    delivered: true,
    at: new Date().toISOString(),
    branch: BRANCH,
    base: BASE,
    buildInputs: BUILD_INPUTS,
    // `temp` and `legal`/`laptop` are never in the worktree at all (untracked or unshipped), so they are declared
    // here rather than removed above: a test reading their absence must be able to tell policy from damage.
    // ⚠ `docs` is NOT listed: it is absent as a whole EXCEPT the ADR, which ships as a build input. Declaring it
    // excluded would contradict `buildInputs` in the same file, and a manifest that lies is worse than none.
    excluded: [...DENY, 'temp', 'legal', 'laptop'],
  }, null, 2) + '\n');

  git(['add', '-A'], wt);
  const staged = git(['diff', '--cached', '--name-only'], wt).split('\n').filter(Boolean);
  if (!staged.length) {
    console.log('nothing to deliver — the tree already matches ' + BASE);
    process.exit(0);
  }

  // 4. Report the manifest BEFORE committing, so an exclusion is visible in the output rather than inferred.
  const tree = git(['ls-files'], wt).split('\n').filter(Boolean);
  const suspect = tree.filter((p) => /(^legal\/|\/docs\/|^docs\/(?!adr\/ARCHITECTURE-DECISIONS\.md)|\.env$|analyses-img|credential|secret)/.test(p));
  if (suspect.length) throw new Error('suspect paths survived the filter, refusing to commit:\n  ' + suspect.slice(0, 10).join('\n  '));

  const msg = [
    `Oswald code delivery ${new Date().toISOString().slice(0, 10)} (code + build inputs)`,
    '',
    `${tree.length} files. Whitelist-driven: scripts/deliver-code.js ALLOW_TOP.`,
    `Build inputs shipped because the suite reads them: ${BUILD_INPUTS.join(', ')}.`,
    `Denied even inside allowed trees: ${DENY.join(', ')}.`,
  ].join('\n');

  git(['-c', 'user.name=datrep', '-c', 'user.email=datrep@users.noreply.github.com', 'commit', '-q', '-m', msg], wt);
  const sha = git(['rev-parse', '--short', 'HEAD'], wt).trim();

  console.log(`=== DELIVERED ${sha} ===`);
  console.log(`  files            : ${tree.length}`);
  console.log(`  build inputs     : ${BUILD_INPUTS.length} (asserted present)`);
  console.log(`  denied prefixes  : ${DENY.join(', ')}`);
  console.log(`  changed vs base  : ${staged.length}`);
  console.log(`  suspect paths    : 0`);
  if (process.argv.includes('--push')) {
    git(['push', '--force-with-lease', 'origin', `HEAD:${BRANCH}`], wt);
    pushed = true;
    console.log(`  pushed           : origin/${BRANCH}`);
  }
  console.log('\nVerify with a clean clone (this is the only proof that matters):');
  console.log(`  git clone --branch ${BRANCH} <remote> /tmp/v && cd /tmp/v && npm ci && npm run test:unit`);
} finally {
  if (!process.argv.includes('--keep')) gitQuiet(['worktree', 'remove', '--force', wt]);
  else console.log(`\nworktree kept at ${wt}`);
}
if (pushed) process.exit(0);
