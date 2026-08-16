'use strict';
// extractor/store.js — in-memory session store for extraction sessions.
//
// Deliberately NOT backed by SQL so extraction keeps working while the DB is
// down. Sessions expire after TTL_MS and are lazily cleaned on access.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TMP_ROOT = path.join(__dirname, '..', 'temp', 'extractor');
const TTL_MS = 30 * 60 * 1000;

const sessions = new Map();

function tmpDirFor(sessionId) {
  const dir = path.join(TMP_ROOT, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createSession(source, images, meta = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const rec = {
    id,
    source,
    images,
    meta,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    tmpDir: tmpDirFor(id),
  };
  sessions.set(id, rec);
  return rec;
}

function getSession(id) {
  const rec = sessions.get(id);
  if (!rec) return null;
  if (Date.now() - rec.lastAccess > TTL_MS) {
    cleanup(rec);
    return null;
  }
  rec.lastAccess = Date.now();
  return rec;
}

function findEntry(rec, entryId) {
  return rec.images.find((i) => i.id === entryId) || null;
}

function cleanup(rec) {
  sessions.delete(rec.id);
  try {
    fs.rmSync(rec.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function deleteSession(id) {
  const rec = sessions.get(id);
  if (rec) cleanup(rec);
}

module.exports = { createSession, getSession, findEntry, deleteSession };
