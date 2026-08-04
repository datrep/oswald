// FS-1 preview viewer — lifted from the Oswald policy resource viewer
// (public/js/pages/policy.js) and adapted to source files from the FS API.
import { FS } from './api.js';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'log', 'csv', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'sh', 'bat', 'ps1', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'sql', 'css', 'scss', 'html', 'htm', 'xml', 'svg', 'toml', 'lock', 'gitignore', 'editorconfig', 'prettierrc', 'eslintrc']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'avi', 'mkv']);
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']);
const KIND_LABELS = {
  image: 'IMAGE', pdf: 'PDF', text: 'TEXT', audio: 'AUDIO', video: 'VIDEO',
  office: 'DOC/XLS', archive: 'ARCHIVE', other: 'FILE',
};

export function getFileKind(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return 'office';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  return 'other';
}

function getFileLabel(kind) {
  return KIND_LABELS[kind] || 'FILE';
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const DOCX_URL = 'https://unpkg.com/docx-preview@0.3.2/dist/docx-preview.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

// file = { root, rel, name }
export async function openViewer(file) {
  const viewer = document.getElementById('modal-viewer');
  if (!viewer) return;
  const titleEl = document.getElementById('viewer-title');
  const body = document.getElementById('viewer-body');
  const download = document.getElementById('viewer-download');
  const editBtn = document.getElementById('viewer-edit');
  const kind = getFileKind(file.name);
  const src = FS.downloadUrl(file.root, file.rel);

  titleEl.textContent = file.name;
  titleEl.title = file.name;
  download.href = src;
  download.setAttribute('download', file.name);
  editBtn.classList.toggle('hidden', kind !== 'text');
  editBtn.dataset.root = file.root;
  editBtn.dataset.rel = file.rel;
  body.innerHTML = '';
  viewer.classList.add('show');

  try {
    if (kind === 'image') {
      body.innerHTML = `<div class="rv-center"><img class="rv-image" src="${src}" alt="${escapeHtml(file.name)}"></div>`;
    } else if (kind === 'pdf') {
      body.innerHTML = `<iframe class="rv-pdf" src="${src}" title="${escapeHtml(file.name)}"></iframe>`;
    } else if (kind === 'text') {
      const text = await (await fetch(src)).text();
      let out = text;
      if (file.name.toLowerCase().endsWith('.json')) {
        try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      }
      body.innerHTML = `<pre class="rv-text">${escapeHtml(out)}</pre>`;
    } else if (kind === 'audio') {
      body.innerHTML = `<div class="rv-center"><audio controls src="${src}" class="rv-media"></audio></div>`;
    } else if (kind === 'video') {
      body.innerHTML = `<div class="rv-center"><video controls src="${src}" class="rv-media"></video></div>`;
    } else if (kind === 'office' && file.name.toLowerCase().endsWith('.docx')) {
      await loadScript(DOCX_URL);
      const container = document.createElement('div');
      container.className = 'rv-docx';
      body.appendChild(container);
      const buf = await (await fetch(src)).arrayBuffer();
      await window.docx.renderAsync(buf, container);
    } else if (kind === 'office') { // xlsx / pptx -> SheetJS first sheet
      await loadScript(SHEETJS_URL);
      const buf = await (await fetch(src)).arrayBuffer();
      const wb = window.XLSX.read(buf);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const html = window.XLSX.utils.sheet_to_html(sheet, { editable: false });
      body.innerHTML = `<div class="rv-xlsx">${html}</div>`;
    } else {
      body.innerHTML = `<div class="rv-download-card">
        <div class="resource-type-badge">${getFileLabel(kind)}</div>
        <p class="rv-note">No inline preview for this file type — use Download to open it.</p>
      </div>`;
    }
  } catch (err) {
    console.error('[fs viewer] failed to render', err);
    body.innerHTML = '<div class="rv-download-card"><p class="rv-note">Could not render this file inline — use Download to open it.</p></div>';
  }
}

export function closeViewer() {
  const viewer = document.getElementById('modal-viewer');
  if (!viewer) return;
  viewer.classList.remove('show');
  const body = document.getElementById('viewer-body');
  if (body) body.innerHTML = '';
}
