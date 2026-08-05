// pages/certs.js — Certificates module (Certificate Dashboard): owner-scoped
// certification tracker. Card grid + status filter, CRUD, expiry/renewal
// highlighting, stats, study-material links, and Career File attachments.
//
// FUTURE SCOPE: verification, course progress, or renewal workflow automation
// would extend this page (see the policy-21 roadmap).

import { apiGet, apiPost, apiPut, apiDelete } from '../api/api.js';
import { getToken, clearToken } from '../api/api.js';
import { initModuleTabs } from '../components/moduleTabs.js';

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = { planned: 'Planned', in_progress: 'In progress', obtained: 'Obtained', expired: 'Expired' };
// Map cert statuses to the ONE semantic chip color map (main.css .chip--*).
const STATUS_TONE = { planned: 'neutral', in_progress: 'info', obtained: 'success', expired: 'danger' };
const EXPIRY_SOON_MS = 90 * 24 * 60 * 60 * 1000; // renewal watch window (task 90)

const state = { status: '', query: '', sort: 'expiry', certs: [], careerFiles: [], editingId: null };

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Expiry tone: already-expired status, past-expiry (not yet marked), or within the
// 90-day renewal window.
function expiryTone(cert) {
  if (cert.status === 'expired') return 'is-overdue';
  if (!cert.expiryAt) return '';
  const t = new Date(cert.expiryAt).getTime();
  if (Number.isNaN(t)) return '';
  const now = Date.now();
  if (t < now) return 'is-overdue';
  if (t - now <= EXPIRY_SOON_MS) return 'is-soon';
  return '';
}
function isUrl(v) {
  return /^https?:\/\//i.test(String(v || '').trim());
}
function showGate() { $('ct-gate').classList.remove('hidden'); $('ct-app').classList.add('hidden'); }
function showApp() { $('ct-gate').classList.add('hidden'); $('ct-app').classList.remove('hidden'); }

// ---------- data ----------
async function load() {
  try {
    const params = new URLSearchParams();
    if (state.status) params.set('status', state.status);
    if (state.query) params.set('q', state.query);
    const qs = params.toString();
    state.certs = await apiGet('/api/certifications' + (qs ? '?' + qs : ''));
    render();
    await loadStats();
    $('ct-status').textContent = '';
    showApp();
  } catch (err) {
    const msg = String((err && err.message) || err);
    // 401 = no token, 403 = invalid/expired token on this owner-scoped route.
    if (msg.includes('401') || msg.includes('403')) {
      clearToken();
      showGate();
    } else {
      $('ct-status').textContent = 'Load failed: ' + msg;
    }
  }
}

async function loadStats() {
  try {
    const s = await apiGet('/api/certifications/stats');
    $('ct-stats').innerHTML = [
      ['Total', s.total],
      ['Obtained', s.obtained],
      ['In progress', s.inProgress],
      ['Planned', s.planned],
      ['Expiring ≤ 90d', s.expiringWithin90],
      ['Expired', s.expired],
    ].map(([l, v]) => `<span class="stat"><span class="stat__value">${v}</span>${l}</span>`).join('');
  } catch { /* stats are non-critical */ }
}

// ---------- rendering ----------
const SORTERS = {
  expiry: (a, b) => dueKey(a.expiryAt) - dueKey(b.expiryAt),
  obtained: (a, b) => (b.obtainedAt || '').localeCompare(a.obtainedAt || ''),
  name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }),
  name_desc: (a, b) => String(b.name || '').localeCompare(String(a.name || ''), undefined, { sensitivity: 'base' }),
  newest: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
};
function dueKey(iso) { return iso ? new Date(iso).getTime() : Infinity; }

function render() {
  state.certs.sort(SORTERS[state.sort] || SORTERS.expiry);
  const grid = $('ct-grid');
  if (!state.certs.length) {
    grid.innerHTML = '<div class="empty">No certifications yet — add one.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const c of state.certs) grid.appendChild(card(c));
}

function card(c) {
  const el = document.createElement('div');
  el.className = 'card';
  const tone = expiryTone(c);
  const credential = c.credential
    ? isUrl(c.credential)
      ? `<a href="${esc(c.credential)}" target="_blank" rel="noopener">${esc(c.credential)}</a>`
      : `<span>${esc(c.credential)}</span>`
    : '';
  const links = (c.studyLinks || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => (isUrl(l) ? `<a class="ct-link" href="${esc(l)}" target="_blank" rel="noopener">${esc(l)}</a>` : `<span class="ct-link">${esc(l)}</span>`))
    .join('');
  el.innerHTML = `
    <div class="card__head">
      <div>
        <div class="card__title">${esc(c.name)}</div>
        ${c.issuer ? `<div class="card__sub">${esc(c.issuer)}</div>` : ''}
      </div>
      <span class="chip chip--${STATUS_TONE[c.status] || 'neutral'}">${STATUS_LABEL[c.status] || esc(c.status)}</span>
    </div>
    <div class="card__meta">
      ${c.obtainedAt ? `<span>Obtained <b>${fmtDate(c.obtainedAt)}</b></span>` : ''}
      ${c.expiryAt ? `<span class="${tone}">Expires <b>${fmtDate(c.expiryAt)}</b></span>` : ''}
    </div>
    ${credential ? `<div class="ct-credential">${credential}</div>` : ''}
    ${c.careerFilePath ? `<div class="ct-file">📄 <a href="/${esc(c.careerFilePath)}" target="_blank" rel="noopener">View document</a></div>` : ''}
    ${links ? `<div class="ct-links">${links}</div>` : ''}
    ${c.notes ? `<div class="card__body">${esc(c.notes)}</div>` : ''}
    ${c.tags ? `<div class="ct-tags">${c.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => `<span class="ct-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="card__actions">
      <button type="button" class="btn btn--sm edit" data-id="${c.id}">Edit</button>
      <button type="button" class="btn btn--sm btn--danger danger" data-id="${c.id}">Delete</button>
    </div>
  `;
  el.querySelector('.edit')?.addEventListener('click', () => openForm(c));
  el.querySelector('.danger')?.addEventListener('click', () => remove(c));
  return el;
}

// ---------- form ----------
async function openForm(cert) {
  state.editingId = cert?.id ?? null;
  $('ct-modal-title').textContent = cert ? 'Edit certification' : 'Add certification';
  try {
    state.careerFiles = await apiGet('/api/career-files');
  } catch { state.careerFiles = []; }
  const sel = $('f-careerfile');
  sel.innerHTML = '<option value="">None</option>' + state.careerFiles.map((f) => `<option value="${esc(f.filePath)}">${esc(f.fileName)}</option>`).join('');
  $('f-name').value = cert?.name ?? '';
  $('f-issuer').value = cert?.issuer ?? '';
  $('f-status').value = cert?.status ?? 'planned';
  $('f-start').value = toLocalInput(cert?.startAt);
  $('f-obtained').value = toLocalInput(cert?.obtainedAt);
  $('f-expiry').value = toLocalInput(cert?.expiryAt);
  $('f-credential').value = cert?.credential ?? '';
  $('f-careerfile').value = cert?.careerFilePath ?? '';
  $('f-studylinks').value = cert?.studyLinks ?? '';
  $('f-tags').value = cert?.tags ?? '';
  $('f-notes').value = cert?.notes ?? '';
  $('ct-modal').classList.add('show');
  $('f-name').focus();
}

function closeForm() {
  $('ct-modal').classList.remove('show');
  state.editingId = null;
}

async function save() {
  const body = {
    name: $('f-name').value.trim(),
    issuer: $('f-issuer').value.trim(),
    status: $('f-status').value,
    startAt: $('f-start').value ? new Date($('f-start').value).toISOString() : null,
    obtainedAt: $('f-obtained').value ? new Date($('f-obtained').value).toISOString() : null,
    expiryAt: $('f-expiry').value ? new Date($('f-expiry').value).toISOString() : null,
    credential: $('f-credential').value.trim(),
    careerFilePath: $('f-careerfile').value,
    studyLinks: $('f-studylinks').value.trim(),
    tags: $('f-tags').value.trim(),
    notes: $('f-notes').value.trim(),
  };
  if (!body.name) {
    $('ct-status').textContent = 'Name is required.';
    return;
  }
  try {
    if (state.editingId) await apiPut(`/api/certifications/${state.editingId}`, body);
    else await apiPost('/api/certifications', body);
    closeForm();
    await load();
  } catch (err) {
    $('ct-status').textContent = 'Save failed: ' + err.message;
  }
}

async function remove(cert) {
  if (!window.confirm(`Delete "${cert.name}"?`)) return;
  try {
    await apiDelete(`/api/certifications/${cert.id}`);
    await load();
  } catch (err) {
    $('ct-status').textContent = 'Delete failed: ' + err.message;
  }
}

// ---------- init ----------
function init() {
  initModuleTabs();
  $('ct-back')?.addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/index.html';
  });
  $('ct-add')?.addEventListener('click', () => openForm(null));
  $('f-save')?.addEventListener('click', save);
  $('f-cancel')?.addEventListener('click', closeForm);
  $('ct-modal')?.addEventListener('click', (e) => { if (e.target === $('ct-modal')) closeForm(); });
  $('ct-status-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-status]');
    if (!btn) return;
    state.status = btn.dataset.status;
    $('ct-status-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    load();
  });
  let debounce;
  $('ct-search')?.addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.query = e.target.value.trim(); load(); }, 280);
  });
  $('ct-sort')?.addEventListener('change', (e) => { state.sort = e.target.value; render(); });

  window.addEventListener('auth:login', () => { showApp(); load(); });
  window.addEventListener('auth:logout', () => showGate());

  if (getToken()) load();
  else showGate();
}

init();
