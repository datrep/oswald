// pages/career-files.js — Career Files module (MOD-1): the user's resume/certs
// documents stored under /resources/career. Owner-scoped.
//
// FUTURE SCOPE: tags, versioning, or cert-expiry tracking would extend this page.

import { apiGet, apiPost, apiDelete } from '../api/api.js';
import { getToken } from '../api/api.js';

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const KIND_LABEL = { resume: 'Resume', cert: 'Cert / Credential', other: 'Other' };

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
    list.innerHTML = '<div class="cf-empty">No career files yet — upload a resume or certificate above.</div>';
    return;
  }
  list.innerHTML = '';
  for (const f of files) {
    const card = document.createElement('div');
    card.className = 'cf-card';
    card.innerHTML = `
      <div class="cf-card-head">
        <span class="cf-kind ${esc(f.kind)}">${KIND_LABEL[f.kind] || esc(f.kind)}</span>
      </div>
      <div class="cf-name" title="${esc(f.fileName)}">${esc(f.fileName)}</div>
      <div class="cf-desc">${esc(f.description || 'No description')}</div>
      <div class="cf-time">${fmtTime(f.createdAt)}</div>
      <div class="cf-actions">
        <a href="/${esc(f.filePath)}" target="_blank" rel="noopener">View</a>
        <button type="button" class="danger" data-id="${f.id}" title="Delete file">Delete</button>
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
    if (msg.includes('401')) showGate();
    else $('cf-status').textContent = 'Load failed: ' + msg;
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
