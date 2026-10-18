// utils/files.js — shared filename/kind helpers for media + resources.
// (Small, dependency-free so both the dashboard media panel and any resource
// UI can reuse them without importing the heavy policy page.)

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'avi', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus']);

export function getFileKind(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'other';
}

// The dashboard media panel accepts images (incl. GIF) and video — never audio.
export function isMediaFile(name) {
  const k = getFileKind(name);
  return k === 'image' || k === 'video';
}

export function extractFilename(p) {
  const seg = String(p || '').split(/[\\/]/).filter(Boolean);
  return seg.length ? seg[seg.length - 1] : String(p || '');
}

// Normalize a stored resource path to a web-servable path under /resources/…
export function formatResourcePath(path) {
  if (!path) return '';
  const normalized = String(path).replaceAll('\\', '/');
  const i = normalized.indexOf('resources/');
  return i !== -1 ? normalized.slice(i) : normalized;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
