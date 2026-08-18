// pages/jobs.js — Job Applications module (MOD-1): owner-scoped tracker with a
// kanban pipeline (default) + list view, CRUD, stats, follow-up highlighting,
// source-site quick links, and resume attachments from Career Files.
//
// FUTURE SCOPE: per-policy scoping, notifications, or more funnel analytics
// would extend this page (see the policy-20 roadmap).

import { apiGet, apiPost, apiPut, apiDelete } from '../api/api.js';
import { getToken, clearToken } from '../api/api.js';
import { initModuleTabs } from '../components/moduleTabs.js';
import { initNotepad, appendNotepad } from '../components/notepad.js';
import { initBreadcrumb } from '../components/breadcrumb.js';
initBreadcrumb();

const $ = (id) => document.getElementById(id);

const SOURCES = {
  mycareersfuture: { label: 'MyCareersFuture', url: 'https://www.mycareersfuture.gov.sg/' },
  jobstreet: { label: 'JobStreet', url: 'https://sg.jobstreet.com/' },
  internsg: { label: 'InternSG', url: 'https://www.internsg.com/' },
  other: { label: 'Other', url: null },
};

const STATUS_LABEL = {
  applied: 'Applied', screening: 'Screening', assessment: 'Assessment',
  interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn',
};
// Kanban columns: active pipeline + a Closed bucket for terminal statuses.
const COLUMNS = [
  { status: 'applied', label: 'Applied', terminal: false },
  { status: 'screening', label: 'Screening', terminal: false },
  { status: 'assessment', label: 'Assessment', terminal: false },
  { status: 'interview', label: 'Interview', terminal: false },
  { status: 'offer', label: 'Offer', terminal: false },
  { status: 'closed', label: 'Closed', terminal: true },
];
const TERMINAL = ['hired', 'rejected', 'withdrawn'];

const state = { view: 'kanban', source: '', query: '', sort: 'newest', apps: [], careerFiles: [], editingId: null };

// Client-side sorters applied to a copy before rendering (owner-scoped data is small).
const SORTERS = {
  newest: (a, b) => (b.appliedAt || '').localeCompare(a.appliedAt || ''),
  oldest: (a, b) => (a.appliedAt || '').localeCompare(b.appliedAt || ''),
  company: (a, b) => String(a.company || '').localeCompare(String(b.company || ''), undefined, { sensitivity: 'base' }),
  company_desc: (a, b) => String(b.company || '').localeCompare(String(a.company || ''), undefined, { sensitivity: 'base' }),
  salary: (a, b) => num(b.salary) - num(a.salary) || (b.appliedAt || '').localeCompare(a.appliedAt || ''),
  due: (a, b) => dueSortKey(a.followUpAt) - dueSortKey(b.followUpAt) || (b.appliedAt || '').localeCompare(a.appliedAt || ''),
};
function num(v) { const m = String(v || '').match(/[\d,.]+/); return m ? parseFloat(m[0].replace(/,/g, '')) || 0 : 0; }
function dueSortKey(iso) { return iso ? new Date(iso).getTime() : Infinity; } // no follow-up sinks last

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dueState(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  const now = Date.now();
  const day = 86400000;
  if (t < now) return 'is-overdue';
  if (t - now <= day) return 'is-today';
  return null;
}
function showGate() { $('jb-gate').classList.remove('hidden'); $('jb-app').classList.add('hidden'); }
function showApp() { $('jb-gate').classList.add('hidden'); $('jb-app').classList.remove('hidden'); }

// ---------- data ----------
async function load() {
  try {
    const params = new URLSearchParams();
    if (state.source) params.set('source', state.source);
    if (state.query) params.set('q', state.query);
    const qs = params.toString();
    state.apps = await apiGet('/api/applications' + (qs ? '?' + qs : ''));
    render();
    await loadStats();
    $('jb-status').textContent = '';
    showApp();
  } catch (err) {
    const msg = String((err && err.message) || err);
    // 401 = no token, 403 = invalid/expired token (dashboard authenticateToken
    // uses invalidStatus:403). These personal routes have no permission tiers,
    // so either means "sign in again" — drop the stale token + show the gate.
    if (msg.includes('401') || msg.includes('403')) {
      clearToken();
      showGate();
    } else {
      $('jb-status').textContent = 'Load failed: ' + msg;
    }
  }
}

// Map job statuses to the ONE semantic chip color map (main.css .chip--*).
const STATUS_TONE = { applied: 'neutral', screening: 'info', assessment: 'warn', interview: 'info', offer: 'success', hired: 'success', rejected: 'danger', withdrawn: 'danger' };

async function loadStats() {
  try {
    const s = await apiGet('/api/applications/stats');
    $('jb-stats').innerHTML = [
      ['Applied this week', s.appliedThisWeek],
      ['Total', s.total],
      ['Active', s.active],
      ['Interviews', s.interviews],
      ['Offers', s.offers],
      ['Hired', s.hired],
    ].map(([l, v]) => `<span class="stat"><span class="stat__value">${v}</span>${l}</span>`).join('');
  } catch { /* stats are non-critical */ }
}

// ---------- rendering ----------
function render() {
  $('jb-board').classList.toggle('hidden', state.view !== 'kanban');
  $('jb-list').classList.toggle('hidden', state.view !== 'list');
  $('jb-view-kanban').classList.toggle('active', state.view === 'kanban');
  $('jb-view-list').classList.toggle('active', state.view === 'list');
  state.apps.sort(SORTERS[state.sort] || SORTERS.newest);
  if (state.view === 'kanban') renderKanban();
  else renderList();
}

function cardInner(a) {
  const src = SOURCES[a.source] || SOURCES.other;
  const due = dueState(a.followUpAt);
  const dueTxt = due ? `<span class="jb-due ${due}">${due === 'is-overdue' ? 'overdue' : 'due today'}</span>` : '';
  return `
    <div class="jb-company">${esc(a.company)}</div>
    <div class="jb-role">${esc(a.role || '')}</div>
    <div class="jb-card-meta">
      <span class="jb-src ${esc(a.source || 'other')}">${esc(src.label)}</span>
      ${a.salary ? `<span class="jb-salary">${esc(a.salary)}</span>` : ''}
      ${dueTxt}
    </div>
    <div class="jb-card-actions">
      <button type="button" class="btn btn--sm edit" data-id="${a.id}">Edit</button>
      <button type="button" class="btn btn--sm np-add" data-id="${a.id}" title="Copy to notepad">✎</button>
      <button type="button" class="btn btn--sm btn--danger danger" data-id="${a.id}">Delete</button>
    </div>
  `;
}

// Snippet to copy into the persistent notepad when the ✎ action is clicked.
function notepadSnippet(a) {
  const lines = [a.company + (a.role ? ` — ${a.role}` : '')];
  if (a.jobUrl) lines.push(a.jobUrl);
  if (a.notes) lines.push(a.notes);
  return lines.join('\n');
}

function attachCardActions(card, a) {
  card.querySelector('.edit')?.addEventListener('click', (e) => { e.stopPropagation(); openForm(a); });
  card.querySelector('.np-add')?.addEventListener('click', (e) => { e.stopPropagation(); appendNotepad(notepadSnippet(a)); });
  card.querySelector('.danger')?.addEventListener('click', (e) => { e.stopPropagation(); remove(a); });
}

function renderKanban() {
  const board = $('jb-board');
  board.innerHTML = '';
  for (const col of COLUMNS) {
    const inCol = col.terminal
      ? state.apps.filter((a) => TERMINAL.includes(a.status))
      : state.apps.filter((a) => a.status === col.status);
    const colEl = document.createElement('div');
    colEl.className = 'jb-col';
    colEl.dataset.status = col.status;
    colEl.innerHTML = `
      <div class="jb-col-head"><span>${col.label}</span><span class="jb-col-count">${inCol.length}</span></div>
      <div class="jb-col-body"></div>
    `;
    const body = colEl.querySelector('.jb-col-body');
    for (const a of inCol) {
      const card = document.createElement('div');
      card.className = 'jb-card';
      card.draggable = !col.terminal; // terminal statuses move via the edit form
      card.dataset.id = a.id;
      card.innerHTML = cardInner(a);
      attachCardActions(card, a);
      body.appendChild(card);
    }
    if (!inCol.length) body.innerHTML = '<div class="empty" style="padding:8px;font-size:0.74rem">Empty</div>';
    // Drop target for active pipeline columns only.
    if (!col.terminal) {
      colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drag-over'); });
      colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
      colEl.addEventListener('drop', (e) => { e.preventDefault(); colEl.classList.remove('drag-over'); onDrop(e.dataTransfer.getData('text/plain'), col.status); });
    }
    board.appendChild(colEl);
  }
}

function renderList() {
  const list = $('jb-list');
  if (!state.apps.length) {
    list.innerHTML = '<div class="empty">No applications yet — add one.</div>';
    return;
  }
  list.innerHTML = state.apps.map((a) => {
    const src = SOURCES[a.source] || SOURCES.other;
    const due = dueState(a.followUpAt);
    return `
      <div class="jb-list-row">
        <div><div class="jb-company">${esc(a.company)}</div><div class="jb-role">${esc(a.role || '')}</div></div>
        <div class="jb-src ${esc(a.source || 'other')}" style="justify-self:start">${esc(src.label)}</div>
        <div><span class="chip chip--${STATUS_TONE[a.status] || 'neutral'}">${STATUS_LABEL[a.status] || esc(a.status)}</span></div>
        <div class="jb-salary">${fmtDate(a.followUpAt)}${due ? `<span class="jb-due ${due}"> • ${due === 'is-overdue' ? 'overdue' : 'due'}</span>` : ''}</div>
        <div class="jb-salary">${esc(a.salary || '')}</div>
        <div class="jb-card-actions">
          <button type="button" class="btn btn--sm edit" data-id="${a.id}">Edit</button>
          <button type="button" class="btn btn--sm np-add" data-id="${a.id}" title="Copy to notepad">✎</button>
          <button type="button" class="btn btn--sm btn--danger danger" data-id="${a.id}">Delete</button>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('.edit').forEach((b) => b.addEventListener('click', () => openForm(state.apps.find((x) => x.id === Number(b.dataset.id)))));
  list.querySelectorAll('.np-add').forEach((b) => b.addEventListener('click', () => appendNotepad(notepadSnippet(state.apps.find((x) => x.id === Number(b.dataset.id))))));
  list.querySelectorAll('.danger').forEach((b) => b.addEventListener('click', () => remove(state.apps.find((x) => x.id === Number(b.dataset.id)))));
}

// ---------- kanban drag ----------
function onDrop(id, status) {
  const app = state.apps.find((a) => a.id === Number(id));
  if (!app || app.status === status) return;
  changeStatus(app, status);
}

async function changeStatus(app, status) {
  try {
    await apiPut(`/api/applications/${app.id}`, { status });
    await load();
  } catch (err) {
    $('jb-status').textContent = 'Status change failed: ' + err.message;
  }
}

// ---------- form ----------
async function openForm(app) {
  state.editingId = app?.id ?? null;
  $('jb-modal-title').textContent = app ? 'Edit application' : 'Add application';
  // populate career-files for the resume select (only if the user has any)
  try {
    state.careerFiles = await apiGet('/api/career-files');
  } catch { state.careerFiles = []; }
  const resumeSel = $('f-resume');
  resumeSel.innerHTML = '<option value="">None</option>' + state.careerFiles.map((f) => `<option value="${esc(f.filePath)}">${esc(f.fileName)}</option>`).join('');
  $('f-company').value = app?.company ?? '';
  $('f-role').value = app?.role ?? '';
  $('f-source').value = app?.source ?? 'other';
  $('f-status').value = app?.status ?? 'applied';
  $('f-joburl').value = app?.jobUrl ?? '';
  $('f-applied').value = toLocalInput(app?.appliedAt);
  $('f-followup').value = toLocalInput(app?.followUpAt);
  $('f-salary').value = app?.salary ?? '';
  $('f-location').value = app?.location ?? '';
  $('f-contact').value = app?.contact ?? '';
  $('f-resume').value = app?.resumePath ?? '';
  $('f-tags').value = app?.tags ?? '';
  $('f-notes').value = app?.notes ?? '';
  $('jb-modal').classList.add('show');
  $('f-company').focus();
}

function closeForm() { $('jb-modal').classList.remove('show'); }

function collect() {
  const dt = (v) => (v ? new Date(v).toISOString() : null);
  return {
    company: $('f-company').value.trim(),
    role: $('f-role').value.trim(),
    source: $('f-source').value,
    status: $('f-status').value,
    jobUrl: $('f-joburl').value.trim(),
    appliedAt: dt($('f-applied').value),
    followUpAt: dt($('f-followup').value),
    salary: $('f-salary').value.trim(),
    location: $('f-location').value.trim(),
    contact: $('f-contact').value.trim(),
    resumePath: $('f-resume').value || null,
    tags: $('f-tags').value.trim(),
    notes: $('f-notes').value.trim(),
  };
}

async function save() {
  const data = collect();
  if (!data.company || !data.role) {
    $('jb-status').textContent = 'Company and role are required.';
    return;
  }
  try {
    if (state.editingId) await apiPut(`/api/applications/${state.editingId}`, data);
    else await apiPost('/api/applications', data);
    closeForm();
    $('jb-status').textContent = '';
    await load();
  } catch (err) {
    $('jb-status').textContent = 'Save failed: ' + err.message;
  }
}

async function remove(app) {
  if (!confirm(`Delete the application at ${app.company} (${app.role || 'no role'})?`)) return;
  try {
    await apiDelete(`/api/applications/${app.id}`);
    await load();
  } catch (err) {
    $('jb-status').textContent = 'Delete failed: ' + err.message;
  }
}

// ---------- init ----------
function init() {
  initModuleTabs();
  initNotepad();
  $('jb-back')?.addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/index.html';
  });
  $('jb-add')?.addEventListener('click', () => openForm(null));
  $('f-save')?.addEventListener('click', save);
  $('f-cancel')?.addEventListener('click', closeForm);
  $('jb-modal')?.addEventListener('click', (e) => { if (e.target === $('jb-modal')) closeForm(); });
  $('jb-source')?.addEventListener('change', (e) => { state.source = e.target.value; load(); });
  $('jb-sort')?.addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('jb-view-kanban')?.addEventListener('click', () => { state.view = 'kanban'; render(); });
  $('jb-view-list')?.addEventListener('click', () => { state.view = 'list'; render(); });
  let debounce;
  $('jb-search')?.addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.query = e.target.value.trim(); load(); }, 280);
  });
  // card-level drag (dragstart must be delegated since cards are re-rendered)
  $('jb-board')?.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.jb-card');
    if (card && card.draggable) {
      e.dataTransfer.setData('text/plain', String(card.dataset.id));
      card.classList.add('dragging');
    }
  });
  $('jb-board')?.addEventListener('dragend', (e) => {
    const card = e.target.closest('.jb-card');
    if (card) card.classList.remove('dragging');
    document.querySelectorAll('.jb-col.drag-over').forEach((c) => c.classList.remove('drag-over'));
  });

  window.addEventListener('auth:login', () => { showApp(); load(); });
  window.addEventListener('auth:logout', () => showGate());

  if (getToken()) load();
  else showGate();
}

init();
