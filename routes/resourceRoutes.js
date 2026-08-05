const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');
const resourceController = require('../controllers/resourceController');

// The resources storage directory is a server setting (settings.json -> resourcesDir,
// default public/resources). Resolved fresh per upload so a settings change is honored.
function resourcesDir() {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api', 'settings.json'), 'utf8')
    );
    return path.resolve(__dirname, '..', settings.resourcesDir || 'public/resources');
  } catch {
    return path.resolve(__dirname, '..', 'public', 'resources');
  }
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = resourcesDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
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

router.get('/', resourceController.getAllResources);
router.post('/', authenticateToken, requirePermission('resources.manage'), uploadSingle, resourceController.createResource);
router.post('/attach', authenticateToken, requirePermission('resources.manage'), resourceController.attachResource);
router.put('/reorder', authenticateToken, requirePermission('resources.manage'), resourceController.reorderResources);
router.put('/:id', authenticateToken, requirePermission('resources.manage'), resourceController.updateResource);
router.delete('/:id', authenticateToken, requirePermission('resources.manage'), resourceController.deleteResourceById);
router.get('/edict/:edictId', resourceController.getResourcesByEdict);

module.exports = router;
