// pages/career-files.js — Career Files module (MOD-1): the user's resume/certs
// documents stored under /resources/career. Owner-scoped.
//
// FUTURE SCOPE: tags, versioning, or cert-expiry tracking would extend this page.

import { apiGet, apiPost, apiDelete } from '../api/api.js';
import { getToken, clearToken } from '../api/api.js';
import { initModuleTabs } from '../components/moduleTabs.js';

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const KIND_LABEL = { resume: 'Resume', cert: 'Cert / Credential', other: 'Other' };
// Map file kinds to the ONE semantic chip color map (main.css .chip--*).
const KIND_TONE = { resume: 'success', cert: 'info', other: 'neutral' };

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${mo}/${day} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

function showGate() {
  $('cf-gate').classList.remove('hidden');
  $('cf-app').classList.add('hidden');
}

function showApp() {
  $('cf-gate').classList.add('hidden');
  $('cf-app').classList.remove('hidden');
}

function render(files) {
  const list = $('cf-list');
  $('cf-count').textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
  if (!files.length) {
    list.innerHTML = '<div class="empty">No career files yet — upload a resume or certificate above.</div>';
    return;
  }
  list.innerHTML = '';
  for (const f of files) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card__head">
        <span class="chip chip--${KIND_TONE[f.kind] || 'neutral'}">${KIND_LABEL[f.kind] || esc(f.kind)}</span>
      </div>
      <div class="card__title" title="${esc(f.fileName)}">${esc(f.fileName)}</div>
      <div class="card__body">${esc(f.description || 'No description')}</div>
      <div class="card__meta">${fmtTime(f.createdAt)}</div>
      <div class="card__actions">
        <a class="btn btn--sm" href="/${esc(f.filePath)}" target="_blank" rel="noopener">View</a>
        <button type="button" class="btn btn--sm btn--danger danger" data-id="${f.id}" title="Delete file">Delete</button>
      </div>
    `;
    const del = card.querySelector('button.danger');
    del.addEventListener('click', () => remove(f));
    list.appendChild(card);
  }
}

async function load() {
  try {
    const files = await apiGet('/api/career-files');
    render(files);
    $('cf-status').textContent = '';
    showApp();
  } catch (err) {
    const msg = String((err && err.message) || err);
    // 401 = no token, 403 = invalid/expired token (dashboard authenticateToken
    // uses invalidStatus:403). Personal owner-scoped routes have no permission
    // tiers, so either means "sign in again" — drop the stale token + gate.
    if (msg.includes('401') || msg.includes('403')) {
      clearToken();
      showGate();
    } else {
      $('cf-status').textContent = 'Load failed: ' + msg;
    }
  }
}

async function upload() {
  const input = $('cf-file');
  const file = input.files[0];
  if (!file) {
    $('cf-status').textContent = 'Choose a file to upload.';
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', $('cf-kind').value || 'other');
  fd.append('description', $('cf-desc').value || '');
  try {
    await apiPost('/api/career-files', fd);
    input.value = '';
    $('cf-desc').value = '';
    $('cf-status').textContent = '';
    await load();
  } catch (err) {
    $('cf-status').textContent = 'Upload failed: ' + err.message;
  }
}

async function remove(f) {
  if (!confirm(`Delete "${f.fileName}"?`)) return;
  try {
    await apiDelete(`/api/career-files/${f.id}`);
    await load();
  } catch (err) {
    $('cf-status').textContent = 'Delete failed: ' + err.message;
  }
}

function init() {
  initModuleTabs();
  $('cf-back')?.addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/index.html';
  });
  $('cf-upload')?.addEventListener('click', upload);
  $('cf-file')?.addEventListener('change', () => ($('cf-status').textContent = ''));

  window.addEventListener('auth:login', () => { showApp(); load(); });
  window.addEventListener('auth:logout', () => showGate());

  if (getToken()) {
    load();
  } else {
    showGate();
  }
}

init();
