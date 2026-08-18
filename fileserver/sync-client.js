#!/usr/bin/env node
// fileserver/sync-client.js — SYNC-2: bidirectional remote sync CLIENT (CLI).
// Thin wrapper over the shared engine in sync-core.js. For a GUI, run
// `node fileserver/sync-ui.js` instead (starts a localhost web UI).
//
// Usage:
//   node fileserver/sync-client.js --folder "C:\MyOswaldCopy" [options]
// Options:
//   --server <url>    Fileserver base (default https://172.22.160.3:8090)
//   --root <rootId>   Server root to sync (default 'sync')
//   --path <rel>      Sub-path within the root (default '')
//   --username <u> --password <p>   Login via the fileserver /api/fs/login proxy
//   --token <jwt>     Use a pre-issued token instead of logging in
//   --insecure        Allow self-signed TLS (dev only; prefer trusting the cert)
//   --dry-run         Show what would change without applying anything
//   --watch           Keep running, re-syncing every --interval seconds
//   --interval <sec>  Poll interval for --watch (default 30)
//   --state <path>    Sync-state file (default <folder>/.oswald-sync.json)
const path = require('path');
const { createSync } = require('./sync-core');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(name);

const FOLDER = path.resolve(arg('--folder', ''));
if (!FOLDER) {
  console.error('Usage: node fileserver/sync-client.js --folder <dir> [--server url] [--root id] [--path rel] [--username u --password p | --token jwt] [--insecure] [--dry-run] [--watch] [--interval N]');
  process.exit(2);
}

const WATCH = has('--watch');
const INTERVAL = Math.max(2, Number(arg('--interval', '30')) || 30);

const sync = createSync({
  folder: FOLDER,
  server: arg('--server', 'https://172.22.160.3:8090'),
  root: arg('--root', 'sync'),
  subPath: arg('--path', ''),
  username: arg('--username', ''),
  password: arg('--password', ''),
  token: arg('--token', ''),
  insecure: has('--insecure'),
  dryRun: has('--dry-run'),
  stateFile: arg('--state', ''),
});

const s = sync.getStatus().config;
console.log(`sync: ${s.folder}  <->  ${s.server} root '${s.root}'${s.subPath ? '/' + s.subPath : ''}${s.dryRun ? '  [DRY RUN]' : ''}`);

async function loop() {
  try {
    const rep = await sync.runSync();
    console.log(
      `${new Date().toISOString()}  ↓${rep.downloaded} ↑${rep.uploaded} ⊘${rep.deleted} ⚠${rep.conflicts} dirs+${rep.dirs} unchanged:${rep.unchanged}` +
        (rep.errors?.length ? `  (${rep.errors.length} notes)` : '') +
        (s.dryRun ? '  [dry-run, nothing applied]' : '')
    );
    for (const e of (rep.errors || []).slice(0, 10)) console.log('  • ' + e);
  } catch (e) {
    console.error(`${new Date().toISOString()}  SYNC ERROR: ${e.message}`);
    if (!WATCH) process.exit(1);
  }
  if (WATCH) setTimeout(loop, INTERVAL * 1000);
  else process.exit(0);
}

loop();
