const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const authenticateToken = require('../middlewares/auth');
const resourceController = require('../controllers/resourceController');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'public', 'resources'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  },
});

// Restrict uploads to non-executable document/image types (no HTML/SVG/JS -> stored XSS).
const ALLOWED_EXT = /\.(png|jpe?g|gif|webp|pdf|txt|md|json|docx?|xlsx?|zip)$/i;
function fileFilter(req, file, cb) {
  const extOk = ALLOWED_EXT.test(path.extname(file.originalname));
  const mimeOk =
    file.mimetype &&
    (file.mimetype.startsWith('image/') ||
      file.mimetype === 'application/pdf' ||
      file.mimetype === 'text/plain' ||
      file.mimetype === 'application/json' ||
      file.mimetype === 'application/msword' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'application/zip' ||
      file.mimetype.includes('officedocument'));
  if (extOk && mimeOk) {
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

router.post('/', authenticateToken, uploadSingle, resourceController.createResource);
router.delete('/:id', authenticateToken, resourceController.deleteResourceById);
router.get('/edict/:edictId', resourceController.getResourcesByEdict);

module.exports = router;
