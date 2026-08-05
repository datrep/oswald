// access.js — FS-2 per-user access control for the fileserver.
// Runs AFTER authenticateToken (req.user carries roles[] + permissions[]).
//
// Effective access for a path (highest priority first):
//   1. files.admin            -> read + write everywhere
//   2. most-specific ACL row  -> exactly that folder's canRead/canWrite
//      ('' ACL = whole root; folder ACLs apply to the folder + descendants)
//   3. permission flags       -> files.read (browse/download), files.write (writes)
const fs = require('fs');
const core = require('./fsCore');
const meta = require('./fsMeta');
const { getConfig } = require('./config');

function hasPerm(user, code) {
  return Array.isArray(user?.permissions) && user.permissions.includes(code);
}

// Resolve the "folder path" that ACLs are checked against for a given item:
//  - a directory -> its own rel path
//  - a file      -> its parent directory
//  - '' (root)   -> ''
async function folderPathFor(rootId, relPath) {
  if (!relPath) return '';
  try {
    const { abs } = core.assertInside(rootId, relPath);
    const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
    if (isDir) return relPath;
  } catch { /* fall through to dirname */ }
  const parts = relPath.split('/');
  parts.pop();
  return parts.join('/');
}

async function effectiveAccess(user, rootId, relPath) {
  // Mirror mode: the served root is a read-only replica (the mirroring engine is
  // FS-3, deferred). Even admins don't write to the mirror — writes go to the source.
  if (getConfig().mode === 'mirror' && rootId === 'mirror') {
    return { read: hasPerm(user, 'files.read'), write: false, admin: false, source: 'mirror' };
  }
  if (hasPerm(user, 'files.admin')) return { read: true, write: true, admin: true, source: 'admin' };
  const folderPath = await folderPathFor(rootId, relPath);
  const acl = await meta.getMostSpecificAcl(user.userID, rootId, folderPath);
  if (acl) {
    return { read: !!acl.canRead, write: !!acl.canWrite, admin: false, source: 'acl' };
  }
  return {
    read: hasPerm(user, 'files.read'),
    write: hasPerm(user, 'files.write'),
    admin: false,
    source: hasPerm(user, 'files.write') ? 'perm' : (hasPerm(user, 'files.read') ? 'perm-read' : 'none'),
  };
}

// Middleware factories. readPath/writePath derive root+path from the request.
function readFrom(req) {
  return {
    root: req.query.root ?? req.body.root,
    path: req.query.path ?? req.body.path ?? '',
  };
}

function requireRead(req, res, next) {
  (async () => {
    const { root, path } = readFrom(req);
    const access = await effectiveAccess(req.user, root, path);
    if (!access.read) {
      return res.status(403).json({ error: 'Access denied: read access required' });
    }
    req.access = access;
    next();
  })().catch(next);
}

function requireWrite(req, res, next) {
  (async () => {
    const { root, path } = readFrom(req);
    const access = await effectiveAccess(req.user, root, path);
    if (!access.write) {
      return res.status(403).json({ error: 'Access denied: write access required' });
    }
    req.access = access;
    next();
  })().catch(next);
}

function requireAdmin(req, res, next) {
  if (!hasPerm(req.user, 'files.admin')) {
    return res.status(403).json({ error: 'Access denied: files.admin required' });
  }
  next();
}

module.exports = { effectiveAccess, requireRead, requireWrite, requireAdmin, hasPerm };
