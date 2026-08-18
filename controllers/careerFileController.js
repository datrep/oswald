// controllers/careerFileController.js
// Career Files module (MOD-1): upload/list/delete the user's career documents
// under the configured resources dir's /career subfolder. Owner-scoped — a user
// can only see/manage their own files (best practice for personal content).

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const model = require('../models/careerFileModel');
const { resourcesDirPath } = require('../shared/config');
const { NotFoundError } = require('../utils/errors');
const { isAllowedExtension, uniqueFilename } = require('../shared/upload');

// Resolve the career-files folder (default <resourcesDir>/career) and ensure it exists.
function careerDir() {
  const dir = path.join(resourcesDirPath(), 'career');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Same allowed document types as the resource uploads.
function fileFilter(req, file, cb) {
  if (isAllowedExtension(file.originalname)) return cb(null, true);
  cb(new Error('File type not allowed. Allowed: images, PDF, text, JSON, Word, Excel, ZIP.'));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, careerDir()),
  filename: (req, file, cb) => cb(null, uniqueFilename(file)),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter });

function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}

// POST /api/career-files — upload a career document (multipart: file, kind, description).
async function create(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    const userId = req.user.userID;
    const fileName = req.file.originalname;
    // Stored relative to public/ (like resources) so /resources/career/<file> serves it.
    const publicDir = path.resolve(__dirname, '..', 'public');
    const filePath = path.relative(publicDir, req.file.path).replace(/\\/g, '/');
    const kind = ['resume', 'cert', 'other'].includes(req.body?.kind) ? req.body.kind : 'other';
    await model.createCareerFile(userId, fileName, filePath, kind, req.body?.description || null);
    const files = await model.getCareerFilesByUser(userId);
    res.json({ success: true, files });
  } catch (err) {
    next(err);
  }
}

// GET /api/career-files — list the user's career files.
async function list(req, res, next) {
  try {
    const userId = req.user.userID;
    const files = await model.getCareerFilesByUser(userId);
    res.json(files);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/career-files/:id — remove a career file (owner only).
async function remove(req, res, next) {
  try {
    const userId = req.user.userID;
    const id = Number(req.params.id);
    const file = await model.getCareerFileById(id, userId);
    if (!file) throw new NotFoundError('File not found');
    const removed = await model.deleteCareerFile(id, userId);
    // Best-effort: remove the stored file from disk (the DB row is the source of truth).
    if (removed) {
      try {
        const publicDir = path.resolve(__dirname, '..', 'public');
        const abs = path.resolve(publicDir, file.filePath);
        fs.unlink(abs, () => {});
      } catch { /* ignore */ }
    }
    const files = await model.getCareerFilesByUser(userId);
    res.json({ success: true, files });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list, remove, uploadSingle };
