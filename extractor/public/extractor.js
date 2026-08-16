// extractor/public/extractor.js — segmented UI for the /api/extract endpoints.
// Reuses the dashboard JWT (localStorage 'oswald_token') via /js/api/api.js.

import { getToken, isLoggedIn } from '/js/api/api.js';

let sessionId = null;
let entries = []; // [{ id, url, status, mimeType, size }]
const pulled = new Map(); // entryId -> { mime }

const $ = (sel) => document.querySelector(sel);

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function showError(msg) {
  const el = $('#error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() {
  $('#error').classList.add('hidden');
}

async function request(method, url, body) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error(`${method} ${url} -> ${res.status} ${detail}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// --- auth gate --------------------------------------------------------------
function refreshGate() {
  $('#gate').classList.toggle('hidden', isLoggedIn());
  $('#app').classList.toggle('hidden', !isLoggedIn());
}

// --- import -----------------------------------------------------------------
async function importHar(file) {
  clearError();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/extract/import/har', { method: 'POST', headers: authHeaders(), body: fd });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error(`Import HAR -> ${res.status} ${detail}`);
  }
  return res.json();
}

async function importUrls(urls) {
  clearError();
  return request('POST', '/api/extract/import/url', { urls });
}

function renderSession(data) {
  sessionId = data.sessionId;
  entries = data.images || [];
  pulled.clear();

  $('#session-card').classList.remove('hidden');
  $('#session-title').textContent =
    data.source === 'har' ? `HAR session (${entries.length} images)` : `URL session (${entries.length} images)`;

  const metaParts = [];
  if (data.source === 'har') {
    metaParts.push(`${data.entryCount} entries`);
    if (data.otherCount) metaParts.push(`${data.otherCount} non-image`);
  }
  if (data.templates && data.templates.length) metaParts.push(`${data.templates.length} template(s) detected`);
  $('#session-meta').textContent = metaParts.join(' · ');

  const gallery = $('#gallery');
  gallery.innerHTML = '';
  for (const e of entries) gallery.appendChild(renderTile(e));

  $('#pull-all').disabled = entries.length === 0;
  loadPreviews(entries);
}

function renderTile(entry) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.entry = entry.id;

  const status = entry.status ? `${entry.status}` : '';
  const size = entry.size != null ? formatBytes(entry.size) : '';

  tile.innerHTML = `
    <div class="thumb loading">
      <div class="spinner"></div>
      <img class="preview" alt="" />
    </div>
    <div class="body">
      <div class="meta"><strong>${entry.id}</strong>${status ? ` · ${status}` : ''}${size ? ` · ${size}` : ''}</div>
      <div class="url" title="${escapeAttr(entry.url)}">${escapeHtml(entry.url)}</div>
      <div class="row">
        <button class="btn btn-ghost pull" data-id="${entry.id}">Pull full</button>
        <span class="badge hidden result" data-id="${entry.id}"></span>
      </div>
    </div>`;
  return tile;
}

// --- previews (concurrency-limited) -----------------------------------------
async function loadPreviews(list) {
  const queue = [...list];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) await loadPreview(queue.shift());
  });
  await Promise.all(workers);
}

async function loadPreview(entry) {
  const tile = document.querySelector(`.tile[data-entry="${entry.id}"]`);
  if (!tile) return;
  const thumb = tile.querySelector('.thumb');
  const img = tile.querySelector('img.preview');
  try {
    const res = await fetch(`/api/extract/session/${sessionId}/entry/${entry.id}/preview`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`preview ${res.status}`);
    const blob = await res.blob();
    img.src = URL.createObjectURL(blob);
    thumb.classList.remove('loading');
    thumb.classList.add('loaded');
  } catch {
    thumb.classList.remove('loading');
    thumb.classList.add('failed');
  }
}

// --- pull full --------------------------------------------------------------
async function pull(entryId) {
  const data = await request('POST', `/api/extract/session/${sessionId}/entry/${entryId}/pull`, {
    mode: 'strip',
  });
  pulled.set(entryId, { mime: data.mime });
  const badge = document.querySelector(`.badge.result[data-id="${entryId}"]`);
  if (badge) {
    const dims = data.width && data.height ? `${data.width}×${data.height}` : '';
    badge.textContent = `full ${formatBytes(data.size)}${dims ? ` · ${dims}` : ''}`;
    badge.classList.remove('hidden');
  }
  return data;
}

async function download(entryId) {
  const res = await fetch(`/api/extract/session/${sessionId}/entry/${entryId}/download`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const blob = await res.blob();
  const ext = mimeExt((pulled.get(entryId) || {}).mime);
  const a = document.createElement('a');
  const objUrl = URL.createObjectURL(blob);
  a.href = objUrl;
  a.download = `${entryId}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
}

// --- helpers ----------------------------------------------------------------
function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function mimeExt(mime) {
  if (!mime) return 'img';
  const m = String(mime).toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('avif')) return 'avif';
  return 'img';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

// --- wiring -----------------------------------------------------------------
function init() {
  refreshGate();

  const harInput = $('#har-file');
  const harLabel = $('#har-label');
  const harSubmit = $('#har-submit');
  const harDrop = $('#har-drop');

  harInput.addEventListener('change', () => {
    harLabel.textContent = harInput.files.length ? harInput.files[0].name : 'Choose a .har file';
    harSubmit.disabled = !harInput.files.length;
  });

  ['dragover', 'dragleave', 'drop'].forEach((evt) => {
    harDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'dragover') harDrop.classList.add('dragover');
      else if (evt === 'drop') {
        harDrop.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
          harInput.files = e.dataTransfer.files;
          harInput.dispatchEvent(new Event('change'));
        }
      } else harDrop.classList.remove('dragover');
    });
  });

  $('#har-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!harInput.files.length) return;
    harSubmit.disabled = true;
    try {
      const data = await importHar(harInput.files[0]);
      renderSession(data);
    } catch (err) {
      showError(err.message);
    } finally {
      harSubmit.disabled = false;
    }
  });

  $('#url-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const urls = $('#url-input').value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return;
    try {
      const data = await importUrls(urls);
      renderSession(data);
    } catch (err) {
      showError(err.message);
    }
  });

  $('#clear-session').addEventListener('click', async () => {
    if (sessionId) {
      try { await request('DELETE', `/api/extract/session/${sessionId}`); } catch { /* ignore */ }
    }
    sessionId = null;
    entries = [];
    pulled.clear();
    $('#session-card').classList.add('hidden');
    $('#gallery').innerHTML = '';
  });

  $('#gallery').addEventListener('click', async (e) => {
    const pullBtn = e.target.closest('.pull');
    if (!pullBtn) return;
    const id = pullBtn.dataset.id;
    pullBtn.disabled = true;
    try {
      await pull(id);
    } catch (err) {
      const badge = document.querySelector(`.badge.result[data-id="${id}"]`);
      if (badge) { badge.textContent = err.message; badge.classList.add('err'); badge.classList.remove('hidden'); }
    } finally {
      pullBtn.disabled = false;
    }
  });

  $('#pull-all').addEventListener('click', async () => {
    const btn = $('#pull-all');
    btn.disabled = true;
    let n = 0;
    for (const entry of entries) {
      btn.textContent = `Pulling ${n + 1}/${entries.length}`;
      try {
        await pull(entry.id);
        n++;
      } catch (err) {
        showError(`${entry.id}: ${err.message}`);
        break;
      }
    }
    btn.textContent = 'Pull all full';
    btn.disabled = false;
  });

  // Let the user right-click a pulled image to save it directly.
  $('#gallery').addEventListener('click', async (e) => {
    const tile = e.target.closest('.tile');
    const img = tile && tile.querySelector('img.preview');
    const entryId = tile && tile.dataset.entry;
    if (!entryId) return;
    if (e.target === img && pulled.has(entryId)) {
      try { await download(entryId); } catch (err) { showError(err.message); }
    }
  });
}

init();
