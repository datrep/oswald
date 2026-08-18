// shared/upload.js — shared constants/helpers for multer-based uploads.
// Centralizes the allowed document/image types and the on-disk filename scheme
// so the dashboard upload sites agree on one definition.

const path = require('path');

// Allowed document/image types (no HTML/SVG/JS -> stored XSS).
const ALLOWED_EXT = /\.(png|jpe?g|gif|webp|pdf|txt|md|json|docx?|xlsx?|zip)$/i;

const DOCUMENT_MIME = new Set([
  'application/pdf',
  'text/plain',
  'application/json',
  'application/msword',
  'application/vnd.ms-excel',
  'application/zip',
]);

function isAllowedExtension(originalname) {
  return ALLOWED_EXT.test(path.extname(originalname || ''));
}

function isAllowedMime(mimetype) {
  return (
    !!mimetype &&
    (mimetype.startsWith('image/') ||
      DOCUMENT_MIME.has(mimetype) ||
      mimetype.includes('officedocument'))
  );
}

// Unique on-disk filename: timestamp-random-original, with path separators
// neutralized so a crafted name can't escape the destination directory.
function uniqueFilename(file) {
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}-${(file.originalname || 'file').replace(/[\\/]/g, '_')}`;
}

module.exports = { ALLOWED_EXT, isAllowedExtension, isAllowedMime, uniqueFilename };
