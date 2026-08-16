'use strict';
// extractor/index.js — segmented image-extraction router.
//
// Self-contained module (like fileserver/ is a self-contained service, and MCP
// is a self-contained side module). Mounted in server.js at /api/extract.
//
// Flow: import (HAR upload or URL list) -> in-memory session -> GUI previews ->
// per-entry "pull full" -> download.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { parseHar } = require('./harParser');
const { applyTransform, fetchImageBuffer, EXT_BY_TYPE } = require('./fetcher');
const store = require('./store');
const schemas = require('./schemas');
const { readDashboardSettings } = require('../shared/config');

const router = express.Router();

const authenticateToken = require('../middlewares/auth');
router.use(authenticateToken);

// --- settings --------------------------------------------------------------
function extractorSettings() {
  const s = readDashboardSettings().extractor || {};
  return {
    blockPrivateIps: !!s.blockPrivateIps,
    maxBytes: Number(s.maxBytes || 50 * 1024 * 1024),
    timeoutMs: Number(s.timeoutMs || 15000),
    maxRedirects: Number(s.maxRedirects || 5),
  };
}

// --- HAR upload -------------------------------------------------------------
const uploadDir = path.join(__dirname, '..', 'temp', 'extractor-uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(har|json)$/i.test(path.extname(file.originalname || ''))) return cb(null, true);
    cb(new Error('Only .har or .json files are accepted'));
  },
});

function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}

function publicEntry(rec, entry) {
  return {
    id: entry.id,
    url: entry.url,
    method: entry.method,
    mimeType: entry.mimeType,
    status: entry.status,
    size: entry.size,
    startedDateTime: entry.startedDateTime,
    time: entry.time,
    full: entry.full
      ? {
          width: entry.full.width,
          height: entry.full.height,
          size: entry.full.size,
          mime: entry.full.mime,
          downloadUrl: `/api/extract/session/${rec.id}/entry/${entry.id}/download`,
        }
      : null,
  };
}

// POST /api/extract/import/har — upload a .har, parse it, open a session.
router.post('/import/har', uploadSingle, (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A .har file is required (field: file)' });
    const raw = fs.readFileSync(req.file.path, 'utf8');
    fs.rmSync(req.file.path, { force: true });

    let plan;
    try {
      plan = parseHar(raw);
    } catch (err) {
      return res.status(400).json({ error: 'Not valid JSON / HAR: ' + err.message });
    }

    const rec = store.createSession('har', plan.images, {
      entryCount: plan.entryCount,
      otherCount: plan.otherCount,
      templates: plan.templates,
    });

    res.json({
      sessionId: rec.id,
      source: 'har',
      entryCount: plan.entryCount,
      imageCount: plan.imageCount,
      otherCount: plan.otherCount,
      templates: plan.templates,
      images: rec.images.map((e) => publicEntry(rec, e)),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/extract/import/url — add one or more image URLs as a session.
router.post('/import/url', (req, res, next) => {
  try {
    const { error, value } = schemas.importUrl.validate(req.body || {});
    if (error) return res.status(400).json({ error: error.message });

    const urls = value.urls || [value.url];
    const seen = new Set();
    const images = [];
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      images.push({
        id: `e${images.length}`,
        url: u,
        method: 'GET',
        mimeType: null,
        status: null,
        size: null,
        startedDateTime: null,
        time: null,
      });
    }

    const rec = store.createSession('url', images, { entryCount: urls.length });
    res.json({
      sessionId: rec.id,
      source: 'url',
      imageCount: images.length,
      images: images.map((e) => publicEntry(rec, e)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/extract/session/:id
router.get('/session/:id', (req, res) => {
  const rec = store.getSession(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({
    sessionId: rec.id,
    source: rec.source,
    imageCount: rec.images.length,
    meta: rec.meta,
    images: rec.images.map((e) => publicEntry(rec, e)),
  });
});

// DELETE /api/extract/session/:id
router.delete('/session/:id', (req, res) => {
  store.deleteSession(req.params.id);
  res.status(204).end();
});

// GET /api/extract/session/:id/entry/:entryId/preview — proxy the captured URL.
router.get('/session/:id/entry/:entryId/preview', async (req, res, next) => {
  try {
    const rec = store.getSession(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Session not found or expired' });
    const entry = store.findEntry(rec, req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const cached = fs
      .readdirSync(rec.tmpDir)
      .find((f) => f.startsWith(`preview_${entry.id}.`));
    if (cached) return res.sendFile(path.join(rec.tmpDir, cached));

    const { buf, type } = await fetchImageBuffer(entry.url, extractorSettings());
    const ext = (type && EXT_BY_TYPE[type]) || 'bin';
    const file = path.join(rec.tmpDir, `preview_${entry.id}.${ext}`);
    fs.writeFileSync(file, buf);
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
});

// POST /api/extract/session/:id/entry/:entryId/pull — fetch the full image.
router.post('/session/:id/entry/:entryId/pull', async (req, res, next) => {
  try {
    const rec = store.getSession(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Session not found or expired' });
    const entry = store.findEntry(rec, req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const { error, value } = schemas.pull.validate(req.body || {});
    if (error) return res.status(400).json({ error: error.message });

    const finalUrl = applyTransform(entry.url, value);
    const { buf, mime, type, width, height } = await fetchImageBuffer(finalUrl, extractorSettings());
    const ext = (type && EXT_BY_TYPE[type]) || 'bin';
    const file = path.join(rec.tmpDir, `full_${entry.id}.${ext}`);
    fs.writeFileSync(file, buf);

    entry.full = { file, mime, size: buf.length, width, height, url: finalUrl };

    res.json({
      ok: true,
      entryId: entry.id,
      url: finalUrl,
      mime,
      width,
      height,
      size: buf.length,
      downloadUrl: `/api/extract/session/${rec.id}/entry/${entry.id}/download`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/extract/session/:id/entry/:entryId/download — stream the pulled file.
router.get('/session/:id/entry/:entryId/download', (req, res, next) => {
  try {
    const rec = store.getSession(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Session not found or expired' });
    const entry = store.findEntry(rec, req.params.entryId);
    if (!entry || !entry.full || !entry.full.file) {
      return res.status(404).json({ error: 'Image not pulled yet — call pull first' });
    }
    const ext = path.extname(entry.full.file).replace('.', '');
    res.download(entry.full.file, `${entry.id}.${ext || 'img'}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
