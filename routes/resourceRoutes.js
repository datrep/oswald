const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');
const { resourcesDirPath } = require('../shared/config');
const { isAllowedExtension, isAllowedMime, isAllowedMediaExtension, isAllowedMediaMime, uniqueFilename } = require('../shared/upload');
const resourceController = require('../controllers/resourceController');
const {
  validateReorder,
  normalizeResourceEdictId,
  validateResourceCreate,
  validateResourceAttach,
} = require('../middlewares/validators');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = resourcesDirPath();
    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: function (req, file, cb) {
    cb(null, uniqueFilename(file));
  },
});

// Restrict uploads to non-executable document/image types (no HTML/SVG/JS -> stored XSS).
function fileFilter(req, file, cb) {
  if (isAllowedExtension(file.originalname) && isAllowedMime(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('File type not allowed. Allowed: images, PDF, text, JSON, Word, Excel, ZIP.'));
  }
}

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: fileFilter,
});

// Wrap multer so its errors (wrong type / too large) return a clean 400 instead of a 500.
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}

// Media uploads for the dashboard media panel (images/GIFs + video, no audio).
const uploadMedia = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB (video)
  fileFilter: (req, file, cb) => {
    if (isAllowedMediaExtension(file.originalname) && isAllowedMediaMime(file.mimetype)) cb(null, true);
    else cb(new Error('Media not supported. Allowed: images, GIFs, and video (no audio).'));
  },
});
function uploadMediaSingle(req, res, next) {
  uploadMedia.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}

router.get('/', resourceController.getAllResources);
router.post('/', authenticateToken, requirePermission('resources.manage'), uploadSingle, normalizeResourceEdictId, validateResourceCreate, resourceController.createResource);
router.post('/media', authenticateToken, requirePermission('resources.manage'), uploadMediaSingle, normalizeResourceEdictId, validateResourceCreate, resourceController.createResource);
router.post('/attach', authenticateToken, requirePermission('resources.manage'), normalizeResourceEdictId, validateResourceAttach, resourceController.attachResource);
router.put('/reorder', authenticateToken, requirePermission('resources.manage'), validateReorder, resourceController.reorderResources);
router.put('/:id', authenticateToken, requirePermission('resources.manage'), resourceController.updateResource);
router.delete('/:id', authenticateToken, requirePermission('resources.manage'), resourceController.deleteResourceById);
router.get('/edict/:edictId', resourceController.getResourcesByEdict);

module.exports = router;
