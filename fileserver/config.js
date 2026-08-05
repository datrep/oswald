// config.js — live config loader for the Oswald fileserver (ARCH task 50).
//
// Reads fileserver/config.json on EVERY call and overlays environment
// overrides, so the runtime MODE ('fileserver' vs 'mirror'), roots and mirror
// settings can change without a code change (edit config.json / env, restart or
// just let the next request pick it up). The env overrides also let the Docker
// image inject roots/DB/TLS that don't make sense baked into a Windows JSON.
const fs = require('fs');
const path = require('path');

function readBase() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

function overlayEnv(c) {
  const o = { ...c };
  const e = process.env;

  if (e.FILESERVER_PORT) o.port = Number(e.FILESERVER_PORT);
  if (e.FILESERVER_HOST) o.host = e.FILESERVER_HOST;
  if (e.FILESERVER_MODE) o.mode = e.FILESERVER_MODE;
  if (e.FILESERVER_DASHBOARD_BASE) o.dashboardBase = e.FILESERVER_DASHBOARD_BASE;
  if (e.FILESERVER_TLS === '0') o.tls = { ...(o.tls || {}), enabled: false };

  // Single-root override (used by the Docker image).
  if (e.FILESERVER_ROOT_PATH) {
    o.roots = [{
      id: e.FILESERVER_ROOT_ID || 'data',
      name: e.FILESERVER_ROOT_NAME || 'Data',
      path: e.FILESERVER_ROOT_PATH,
    }];
  }

  if (e.FILESERVER_MIRROR_PATH) {
    o.mirror = {
      sourceRootId: e.FILESERVER_MIRROR_SOURCE || 'data',
      mirrorPath: e.FILESERVER_MIRROR_PATH,
      readOnly: e.FILESERVER_MIRROR_READONLY !== '0',
    };
  }

  // FS-3 one-way sync job.
  if (e.FILESERVER_SYNC_SOURCE || e.FILESERVER_SYNC_DEST) {
    o.sync = {
      source: e.FILESERVER_SYNC_SOURCE || o.sync?.source,
      destination: e.FILESERVER_SYNC_DEST || o.sync?.destination,
      deleteExtraneous: e.FILESERVER_SYNC_DELETE === '0' ? false : o.sync?.deleteExtraneous !== false,
      intervalMinutes: e.FILESERVER_SYNC_INTERVAL ? Number(e.FILESERVER_SYNC_INTERVAL) : (o.sync?.intervalMinutes || 0),
    };
  }

  if (e.FILESERVER_THUMB_CACHE) {
    o.thumbnails = { ...(o.thumbnails || {}), cacheDir: e.FILESERVER_THUMB_CACHE };
  }

  return o;
}

function getConfig() {
  return overlayEnv(readBase());
}

// Mode-aware roots: in 'mirror' mode the service presents a single read-only
// mirror root (the mirroring ENGINE is FS-3). To keep mirror mode coherent, the
// served root defaults to the sync destination when mirror.mirrorPath is unset
// — i.e. what the one-way Sync populates IS what mirror mode shows.
function getRoots() {
  const c = getConfig();
  if (c.mode === 'mirror') {
    const mirrorPath = (c.mirror && c.mirror.mirrorPath) || (c.sync && c.sync.destination);
    if (mirrorPath) {
      return [{ id: 'mirror', name: 'Mirror (read-only)', path: mirrorPath }];
    }
  }
  return (c.roots || []).map((r) => ({ id: r.id, name: r.name, path: r.path }));
}

function getRoot(id) {
  return getRoots().find((r) => r.id === id) || null;
}

module.exports = { getConfig, getRoots, getRoot };
