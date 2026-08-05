// main page script
// index.js purpose to display all policies, and links to their individual pages

// api/api.js
import { apiGet, isLoggedIn, clearToken } from '../api/api.js'; // generic API wrapper functions for calling backend routes. all fetch calls should be made through these functions for better error handling and consistency. do not use fetch() directly in other files, use these apiGet/apiPost/etc functions instead.
// settings
import { getSetting, setSetting, loadSettings } from '../utils/settingsStore.js';
// components
//import "../components/policyRow.js"; // not currently used, but may be useful for future refactor to make code more modular
import '../components/servicesTray.js'; // the services tray in the top right corner

const policyCountEl = document.getElementById('policy-count');
const policyListEl = document.getElementById('policy-list');

let edictsCache = [];

// Collapsible sidebar sections (services, server, monitoring, links) — same pattern as trends.
// The CSS collapses to max-height:0, but the fixed 480px cap makes the transition
// overshoot for short panels (choppy). We measure the real content height and
// animate to/from it instead, so expand/collapse is 1:1 and smooth.
function initCollapsibleSection(toggleId, bodyId, defaultCollapsed = false) {
  const toggle = document.getElementById(toggleId);
  const body = document.getElementById(bodyId);
  if (!toggle || !body) return;
  const chevron = toggle.querySelector('.sidebar-chevron');

  const setCollapsed = (collapsed) => {
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
    if (collapsed) {
      body.style.maxHeight = body.scrollHeight + 'px'; // start from the real height
      body.classList.add('collapsed');
      void body.offsetHeight; // synchronous reflow — browser records the start height
      body.style.maxHeight = '0px'; // then animate down
    } else {
      body.classList.remove('collapsed');
      body.style.maxHeight = body.scrollHeight + 'px'; // animate to the real height
      const onEnd = (e) => {
        if (e.propertyName !== 'max-height') return;
        body.style.maxHeight = '';
        body.removeEventListener('transitionend', onEnd);
      };
      body.addEventListener('transitionend', onEnd);
      setTimeout(onEnd, 350); // safety net (reduced-motion / no transition)
    }
  };

  toggle.addEventListener('click', () => setCollapsed(!body.classList.contains('collapsed')));
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setCollapsed(!body.classList.contains('collapsed'));
    }
  });

  // Apply the initial state without animating.
  body.classList.toggle('collapsed', defaultCollapsed);
  if (defaultCollapsed) body.style.maxHeight = '0px';
  toggle.setAttribute('aria-expanded', String(!defaultCollapsed));
  if (chevron) chevron.textContent = defaultCollapsed ? '▸' : '▾';
}

initCollapsibleSection('services-toggle', 'services-menu', true);
initCollapsibleSection('mcp-toggle', 'mcp-body', false);
initCollapsibleSection('monitor-toggle', 'monitor-body', false);
initCollapsibleSection('experiments-toggle', 'experiments-body', false);

let sortKey = 'createdAt';
let sortDir = 'desc'; // "asc" | "desc"

function formatDate(value) {
  if (!value) return '-';
  try {
    const date = new Date(value);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return value;
  }
}

function formatState(state) {
  if (state === null || state === undefined) return '-';
  const stateLabels = { 1: 'Draft', 2: 'Published', 3: 'Archived' };
  return stateLabels[state] || `State ${state}`;
}

function normalizeSortDir(dir) {
  return dir === 'asc' ? 'asc' : 'desc';
}

function isSortableDateKey(key) {
  return key === 'plannedStart' || key === 'plannedEnd' || key === 'createdAt';
}

function isSortableNumberKey(key) {
  return (
    key === 'taskCount' ||
    key === 'resourceCount' ||
    key === 'priority' ||
    key === 'state' ||
    key === 'active'
  );
}

function toDateMillis(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function compareNullable(aValue, bValue) {
  const aNull = aValue === null || aValue === undefined;
  const bNull = bValue === null || bValue === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return null;
}

function makeComparator(key, dir) {
  const direction = normalizeSortDir(dir) === 'asc' ? 1 : -1;

  return (a, b) => {
    let aValue = a?.[key];
    let bValue = b?.[key];

    // Treat empty strings as null for sorting.
    if (aValue === '') aValue = null;
    if (bValue === '') bValue = null;

    if (isSortableDateKey(key)) {
      aValue = aValue ? toDateMillis(aValue) : null;
      bValue = bValue ? toDateMillis(bValue) : null;
    } else if (isSortableNumberKey(key)) {
      aValue = aValue === null || aValue === undefined ? null : Number(aValue);
      bValue = bValue === null || bValue === undefined ? null : Number(bValue);
      if (!Number.isFinite(aValue)) aValue = null;
      if (!Number.isFinite(bValue)) bValue = null;
    } else {
      aValue = aValue === null || aValue === undefined ? null : String(aValue);
      bValue = bValue === null || bValue === undefined ? null : String(bValue);
    }

    const nullCompare = compareNullable(aValue, bValue);
    if (nullCompare !== null) return nullCompare * direction;

    if (typeof aValue === 'number' && typeof bValue === 'number') {
      if (aValue === bValue) return 0;
      return aValue < bValue ? -1 * direction : 1 * direction;
    }

    const result = String(aValue).localeCompare(String(bValue), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    return result * direction;
  };
}

function applySortAndRender() {
  const sorted = [...edictsCache];

  // If the user clicks "Tasks", use resources as a secondary tie-breaker so the column feels stable.
  if (sortKey === 'taskCount') {
    const primary = makeComparator('taskCount', sortDir);
    const secondary = makeComparator('resourceCount', sortDir);
    const byName = makeComparator('name', 'asc');
    sorted.sort((a, b) => primary(a, b) || secondary(a, b) || byName(a, b));
  } else {
    const primary = makeComparator(sortKey, sortDir);
    const byName = makeComparator('name', 'asc');
    sorted.sort((a, b) => primary(a, b) || byName(a, b));
  }

  renderPolicyRows(sorted);
  updateSortIndicatorsSafe();
}

function updateSortIndicatorsSafe() {
  const header = document.querySelector('.policy-header');
  if (!header) return;
  const spans = [...header.querySelectorAll('span[data-sort]')];

  spans.forEach((span) => {
    const key = span.dataset.sort;
    const baseLabel =
      span.dataset.baseLabel || span.textContent.replace(/\s*[^A-Za-z0-9]+$/, '').trim();
    span.dataset.baseLabel = baseLabel;

    const isSorted = key === sortKey;
    span.classList.toggle('sorted', isSorted);
    span.textContent = isSorted
      ? `${baseLabel} ${sortDir === 'asc' ? '\u2191' : '\u2193'}`
      : baseLabel;
  });
}

function setupSortHeader() {
  const header = document.querySelector('.policy-header');
  if (!header) return;
  const spans = [...header.querySelectorAll('span[data-sort]')];

  spans.forEach((span) => {
    span.tabIndex = 0;
    span.addEventListener('click', () => {
      const key = span.dataset.sort;
      if (!key) return;
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = 'asc';
      }
      applySortAndRender();
    });

    span.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      span.click();
    });
  });
}

// Render all policies (already enriched with counts)
function renderPolicyRows(edicts) {  policyListEl.innerHTML = '';
  policyCountEl.textContent = `Showing ${edicts.length} polic${edicts.length === 1 ? 'y' : 'ies'}`;

  if (edicts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'policy-row anim-fade-in';
    empty.textContent = 'No policies available';
    policyListEl.appendChild(empty);
    return;
  }

  edicts.forEach((edict, i) => {
    const row = document.createElement('div');
    row.className = 'policy-row anim-enter';
    row.style.animationDelay = `${i * 0.03}s`;
    row.style.cursor = 'pointer';

    // Include description inside the same row, below the main info
    //policy-row not congruent with policy-main?
    const stateLabel = formatState(edict.state);
    const stateChip = ['Draft', 'Published', 'Archived'].includes(stateLabel)
      ? `<span class="state-chip state-${stateLabel.toLowerCase()}">${stateLabel}</span>`
      : stateLabel;

    row.innerHTML = `\
                <span class="col-name" title="${edict.name || ''}">${edict.name || '-'}</span>
                <span class="col-date">${formatDate(edict.plannedStart)}</span>
                <span class="col-date${endDateTone(edict.plannedEnd) ? ' ' + endDateTone(edict.plannedEnd) : ''}">${formatDate(edict.plannedEnd)}</span>
                <span class="col-tasks">${edict.taskCount ?? 0} / ${edict.resourceCount ?? 0}</span>
                <span class="col-active">${
                  edict.active
                    ? '<span class="pill pill-active"><span class="dot dot-on"></span>Active</span>'
                    : '<span class="pill pill-inactive"><span class="dot dot-off"></span>Inactive</span>'
                }</span>
                <span class="col-priority">${
                  edict.priority !== null && edict.priority !== undefined
                    ? `<span class="badge badge-p${edict.priority}">P${edict.priority}</span>`
                    : '-'
                }</span>
                <span class="col-state">${stateChip}</span>
                <span class="col-info">${edict.info || 'No description available.'}</span>
                <span class="policy-chips">${moduleChipsHtml(edict)}</span>
                <span class="policy-id">#${edict.id}</span>
        `;

    // Make row clickable
    row.addEventListener('click', () => {
      window.location.href = `/pages/policy.html?id=${edict.id}`;
    });

    policyListEl.appendChild(row);
  });
}

function renderPolicyStats() {
  const container = document.getElementById('policy-stats');
  if (!container) return;

  const total = edictsCache.length;
  const active = edictsCache.filter((e) => e.active).length;
  const overdue = unfinishedEdicts.length;
  const archived = edictsCache.filter((e) => Number(e.state) === 3).length;

  const cards = [
    { label: 'Total Policies', value: total, tone: '' },
    { label: 'Active Now', value: active, tone: 'accent' },
    { label: 'Overdue', value: overdue, tone: overdue > 0 ? 'danger' : '' },
    { label: 'Archived', value: archived, tone: '' },
  ];

  container.innerHTML = cards
    .map(
      (c, i) => `
        <div class="stat-card ${c.tone ? `stat-${c.tone}` : ''} anim-bounce-in" style="animation-delay:${i * 0.06}s">
          <div class="stat-value">${c.value}</div>
          <div class="stat-label">${c.label}</div>
        </div>`
    )
    .join('');
}

async function initPolicies() {
  try {
    const edicts = await apiGet('/api/edicts');

    // Preload tasks & resources in parallel for all policies (so "Tasks" sorting works locally).
    const tasksMap = {};
    const resourcesMap = {};

    await Promise.all(
      edicts.map(async (edict) => {
        try {
          const [tasks, resources] = await Promise.all([
            apiGet(`/api/tasks/edict/${edict.id}`),
            apiGet(`/api/resources/edict/${edict.id}`),
          ]);
          tasksMap[edict.id] = tasks.length;
          resourcesMap[edict.id] = resources.length;
        } catch (err) {
          console.warn(`[UI] Failed to load tasks/resources for edict ${edict.id}`, err);
          tasksMap[edict.id] = 0;
          resourcesMap[edict.id] = 0;
        }
      })
    );

    edictsCache = edicts.map((edict) => ({
      ...edict,
      taskCount: tasksMap[edict.id] ?? 0,
      resourceCount: resourcesMap[edict.id] ?? 0,
    }));

    setupSortHeader();
    applySortAndRender();
    renderPolicyStats();
  } catch (err) {
    console.error('[UI] Failed to load policies', err);
    policyCountEl.textContent = 'Unable to load policies.';
  }
}

// (IP status strip removed — monitoring now lives in the sidebar panel)

// ===========================
// POPUP MANAGEMENT SYSTEM (Extensible Framework)
// Purpose: Generic popup/modal framework for managing all notification and popup types
//
// How to add new popup types:
// 1. Add popup HTML structure to index.html with unique id (e.g., id="popup-{type}-modal")
// 2. Create popup handler functions:
//    - renderPopup{Type}() - render content
//    - openPopup{Type}() - open the popup
//    - closePopup{Type}() - close the popup
// 3. Register the popup in the popupRegistry below with handlers
// 4. Add opening trigger (button click, notification icon, etc.)
//
// Example:
// popupRegistry['alerts'] = {
//     open: openAlerts,
//     close: closeAlerts,
//     render: renderAlerts,
//     element: document.getElementById('popup-alerts-modal')
// };
// ===========================

const popupRegistry = {};

function registerPopup(type, handlers) {
  popupRegistry[type] = handlers;
  console.log(`[Popups] Registered popup type: ${type}`);
}

function openPopup(type) {
  const popup = popupRegistry[type];
  if (!popup) {
    console.warn(`[Popups] Popup type not registered: ${type}`);
    return;
  }
  if (popup.render) popup.render();
  if (popup.open) popup.open();
}

function closePopup(type) {
  const popup = popupRegistry[type];
  if (!popup) return;
  if (popup.close) popup.close();
}

function closeAllPopups() {
  Object.keys(popupRegistry).forEach((type) => closePopup(type));
}

// ===========================
// END POPUP MANAGEMENT SYSTEM
// ===========================

// ===========================
// JOB FOLLOW-UPS (MOD-2) — dashboard sidebar reminders for application follow-ups
// ===========================
let jobFollowUps = [];
let jobStats = null; // { total, active, offers, ... } from /api/applications/stats

// A policy is "job-linked" when it has the jobs module attached (comma-joined
// `modules` field from GET /api/edicts).
function hasJobsModule(edict) {
  return String(edict.modules || '').split(',').includes('jobs');
}
function hasCertsModule(edict) {
  return String(edict.modules || '').split(',').includes('certificates');
}

function jobsChipText() {
  if (!jobStats) return '💼 …';
  return `💼 ${jobStats.active} active · ${jobStats.offers} offers`;
}
function certChipText() {
  if (!certStats) return '🎓 …';
  return `🎓 ${certStats.obtained} obtained`;
}

// Live module-status chips for a policy row (bottom-left, mirrors #id).
function moduleChipsHtml(edict) {
  const chips = [];
  if (hasJobsModule(edict)) chips.push(`<span class="jobs-chip">${jobsChipText()}</span>`);
  if (hasCertsModule(edict)) chips.push(`<span class="cert-chip">${certChipText()}</span>`);
  return chips.join('');
}

async function loadJobStats() {
  try {
    jobStats = await apiGet('/api/applications/stats');
  } catch (err) {
    // 403 = invalid/expired token on these owner-scoped routes — drop it so
    // the personal widgets don't silently stay empty on a stale session.
    if (String((err && err.message) || err).includes('403')) clearToken();
    jobStats = null;
  }
  // Fill in any already-rendered chips without a full re-render.
  document.querySelectorAll('.policy-row .jobs-chip').forEach((chip) => {
    chip.textContent = jobsChipText();
  });
}

// Follow-up tone: overdue (red), due today (yellow), else upcoming.
function followUpTone(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const now = Date.now();
  const day = 86400000;
  if (t < now) return 'is-overdue';
  if (t - now <= day) return 'is-today';
  return 'is-soon';
}

function followUpLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const base = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const tone = followUpTone(iso);
  if (tone === 'is-overdue') return `${base} · overdue`;
  if (tone === 'is-today') return `${base} · today`;
  return base;
}

function renderFollowUpSidebar() {
  const badge = document.getElementById('followup-badge');
  const list = document.getElementById('sidebar-followup-list');
  if (!badge || !list) return;
  badge.textContent = jobFollowUps.length;
  if (jobFollowUps.length === 0) {
    badge.classList.add('none');
    list.innerHTML = `<div style="color:#aaa;font-size:0.8rem;padding:10px;text-align:center;">No follow-ups due</div>`;
    return;
  }
  badge.classList.remove('none');
  list.innerHTML = '';
  jobFollowUps.slice(0, 5).forEach((app, i) => {
    const item = document.createElement('div');
    item.className = 'notification-item anim-enter';
    item.style.animationDelay = `${i * 0.05}s`;
    const tone = followUpTone(app.followUpAt);
    item.innerHTML = `
            <div class="notification-item-name">${app.company}${app.role ? ` — ${app.role}` : ''}</div>
            <div class="followup-due ${tone}">${followUpLabel(app.followUpAt)}</div>
        `;
    item.addEventListener('click', () => {
      window.location.href = '/pages/jobs.html';
    });
    list.appendChild(item);
  });
}

async function loadJobFollowUps() {
  try {
    const days = Number(getSetting('followUpLookaheadDays')) || 7;
    jobFollowUps = await apiGet(`/api/applications/follow-ups?days=${days}`);
    renderFollowUpSidebar();
  } catch (err) {
    // 403 = invalid/expired token on these owner-scoped routes — drop it so
    // the follow-ups section doesn't silently stay empty on a stale session.
    if (String((err && err.message) || err).includes('403')) clearToken();
    console.error('[Follow-ups] Failed to load', err);
  }
}

// ===========================
// CERT EXPIRIES (Certificate Dashboard) — sidebar renewal reminders
// ===========================
let certExpiries = [];
let certStats = null; // from /api/certifications/stats

function certExpiryTone(expiryAt, status) {
  if (status === 'expired') return 'is-overdue';
  if (!expiryAt) return '';
  const t = new Date(expiryAt).getTime();
  if (Number.isNaN(t)) return '';
  return t < Date.now() ? 'is-overdue' : 'is-soon';
}

function renderCertExpirySidebar() {
  const badge = document.getElementById('certexpiry-badge');
  const list = document.getElementById('sidebar-certexpiry-list');
  if (!badge || !list) return;
  badge.textContent = certExpiries.length;
  if (certExpiries.length === 0) {
    badge.classList.add('none');
    list.innerHTML = `<div style="color:#aaa;font-size:0.8rem;padding:10px;text-align:center;">No certs expiring</div>`;
    return;
  }
  badge.classList.remove('none');
  list.innerHTML = '';
  certExpiries.slice(0, 5).forEach((cert, i) => {
    const item = document.createElement('div');
    item.className = 'notification-item anim-enter';
    item.style.animationDelay = `${i * 0.05}s`;
    const tone = certExpiryTone(cert.expiryAt, cert.status);
    const label = cert.status === 'expired' || (cert.expiryAt && new Date(cert.expiryAt).getTime() < Date.now())
      ? 'expired'
      : 'expires';
    item.innerHTML = `
            <div class="notification-item-name">${cert.name}${cert.issuer ? ` — ${cert.issuer}` : ''}</div>
            <div class="followup-due ${tone}">${label} ${formatDate(cert.expiryAt)}</div>
        `;
    item.addEventListener('click', () => {
      window.location.href = '/pages/certs.html';
    });
    list.appendChild(item);
  });
}

async function loadCertExpiries() {
  try {
    const days = Number(getSetting('certExpiryLookaheadDays')) || 90;
    certExpiries = await apiGet(`/api/certifications/expiries?days=${days}`);
    renderCertExpirySidebar();
  } catch (err) {
    if (String((err && err.message) || err).includes('403')) clearToken();
    console.error('[Cert expiries] Failed to load', err);
  }
}

async function loadCertStats() {
  try {
    certStats = await apiGet('/api/certifications/stats');
  } catch (err) {
    if (String((err && err.message) || err).includes('403')) clearToken();
    certStats = null;
  }
  document.querySelectorAll('.policy-row .cert-chip').forEach((chip) => {
    chip.textContent = certChipText();
  });
}

// ===========================
// END JOB FOLLOW-UPS / CERT EXPIRIES
// ===========================

// ===========================
// UNFINISHED POLICIES NOTIFICATIONS
// ===========================

let unfinishedEdicts = [];

function calculateDaysOverdue(endDate) {
  const now = new Date();
  const end = new Date(endDate);
  const diffTime = now - end;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

// End-date urgency for the dashboard policy rows: red when overdue, yellow when
// due within SOON_MS, normal (default) otherwise.
const END_SOON_MS = 3 * 24 * 60 * 60 * 1000; // warn within 3 days
function endDateTone(plannedEnd) {
  if (!plannedEnd) return '';
  const end = new Date(plannedEnd).getTime();
  if (Number.isNaN(end)) return '';
  const now = Date.now();
  if (end < now) return 'is-overdue';
  if (end - now <= END_SOON_MS) return 'is-soon';
  return '';
}

function renderNotificationModal() {
  const modal = document.getElementById('notification-modal');
  const tableBody = document.getElementById('notification-table-body');
  const emptyMessage = document.getElementById('notification-empty-message');

  tableBody.innerHTML = '';

  if (unfinishedEdicts.length === 0) {
    emptyMessage.style.display = 'block';
    return;
  }

  emptyMessage.style.display = 'none';

  unfinishedEdicts.forEach((edict) => {
    const row = document.createElement('tr');
    row.className = 'anim-fade-in-up';
    const DaysOverdue = calculateDaysOverdue(edict.plannedEnd);
    const priorityLabel = edict.priority ? `P${edict.priority}` : '-';

    // DaysOverdue also name of text, so renamed CamelCase
    row.innerHTML = `
            <td>${edict.name || '-'}</td>
            <td>${formatDate(edict.plannedEnd)}</td>
            <td>${DaysOverdue} day${DaysOverdue !== 1 ? 's' : ''}</td> 
            <td>${priorityLabel}</td>
        `;

    // Make row clickable to navigate to policy detail page
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      window.location.href = `/pages/policy.html?id=${edict.id}`;
    });

    tableBody.appendChild(row);
  });
}

function renderNotificationSidebar() {
  const badge = document.getElementById('notification-badge');
  const list = document.getElementById('sidebar-notifications-list');

  badge.textContent = unfinishedEdicts.length;

  if (unfinishedEdicts.length === 0) {
    badge.classList.add('none');
    list.innerHTML = `<div style="color: #aaa; font-size: 0.8rem; padding: 10px; text-align: center;">No unfinished policies</div>`;
    return;
  }

  badge.classList.remove('none');
  list.innerHTML = '';

  // Small "view all" header, right-aligned at the top of the list.
  if (unfinishedEdicts.length > 5) {
    const head = document.createElement('div');
    head.className = 'notifications-head';
    const va = document.createElement('button');
    va.type = 'button';
    va.className = 'notifications-viewall';
    va.textContent = `View all (${unfinishedEdicts.length})`;
    va.addEventListener('click', openNotificationModal);
    head.appendChild(va);
    list.appendChild(head);
  }

  unfinishedEdicts.slice(0, 5).forEach((edict, i) => {
    const daysOverdue = calculateDaysOverdue(edict.plannedEnd);
    const item = document.createElement('div');
    item.className = 'notification-item anim-enter';
    item.style.animationDelay = `${i * 0.05}s`;

    item.innerHTML = `
            <div class="notification-item-name">${edict.name}</div>
            <div class="notification-item-date">${daysOverdue} Day${daysOverdue !== 1 ? 's' : ''} overdue </div>
            ${edict.priority ? `<div class="notification-item-priority">Priority ${edict.priority}</div>` : ''}
        `;

    // Click to navigate directly to policy page
    item.addEventListener('click', () => {
      window.location.href = `/pages/policy.html?id=${edict.id}`;
    });

    list.appendChild(item);
  });
}

function openNotificationModal() {
  const modal = document.getElementById('notification-modal');
  renderNotificationModal();
  modal.classList.add('show');
}

function closeNotificationModal() {
  const modal = document.getElementById('notification-modal');
  modal.classList.remove('show');
}

const UNFINISHED_DISMISS_KEY = 'oswald_unfinished_dismiss_date';

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function dismissedToday() {
  try {
    return localStorage.getItem(UNFINISHED_DISMISS_KEY) === todayKey();
  } catch {
    return false;
  }
}

async function loadUnfinishedPolicies() {
  try {
    await loadSettings();
    console.log('[Notifications] Fetching unfinished policies...');
    unfinishedEdicts = await apiGet('/api/edicts/unfinished');
    console.log(`[Notifications] Found ${unfinishedEdicts.length} unfinished policies`);

    // Render sidebar notification panel
    renderNotificationSidebar();
    renderPolicyStats();

    // Show modal if there are unfinished policies (unless disabled or dismissed for today)
    if (unfinishedEdicts.length > 0 && getSetting('showUnfinishedPopup') && !dismissedToday()) {
      openNotificationModal();
    }
  } catch (err) {
    console.error('[Notifications] Failed to load unfinished policies', err);
  }
}

function setupNotificationModal() {
  const closeBtn = document.getElementById('notification-modal-close');
  const modal = document.getElementById('notification-modal');

  closeBtn?.addEventListener('click', closeNotificationModal);

  // Dismiss the auto-popup for the rest of the day
  document.getElementById('notification-dismiss-today')?.addEventListener('click', () => {
    try {
      localStorage.setItem(UNFINISHED_DISMISS_KEY, todayKey());
    } catch {
      /* ignore */
    }
    closeNotificationModal();
  });

  // Close modal when clicking outside
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeNotificationModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('show')) {
      closeNotificationModal();
    }
  });
}

// Register the unfinished policies notification in the popup system
function registerUnfinishedPoliciesPopup() {
  registerPopup('unfinishedPolicies', {
    render: renderNotificationModal,
    open: openNotificationModal,
    close: closeNotificationModal,
    element: document.getElementById('notification-modal'),
  });
}

apiGet('/api/services') // Preload services for the tray
  .then((services) => {
    console.log('[ServicesTray] Preloaded services:', services);
  })
  .catch((err) => {
    console.error('[ServicesTray] Failed to preload services', err);
  });

// ===========================
// FUTURE EXTENSIONS (IDEAS, NOT IMPLEMENTED)
// service.type could be used to determine how to render the service item in the tray. For example:
// - type "url": render as a simple link with icon
// - type "local_app": render with a launch button that calls an API to start the app
// - type "script": render with a run button that executes a predefined script on the server
//service.type === "url"
//service.type === "local_app"
//service.type === "script"
// ===========================

// ===========================
// END UNFINISHED POLICIES NOTIFICATIONS
// ===========================

// ===========================
// COMPLETION TRENDS
// ===========================

async function loadTrends() {
  const policyCanvas = document.getElementById('policy-trend-chart');
  const taskCanvas = document.getElementById('task-trend-chart');
  if (!policyCanvas || !taskCanvas) return;

  if (typeof Chart === 'undefined') {
    const sec = document.getElementById('trends-section');
    if (sec) {
      sec.innerHTML =
        '<p class="trend-summary">Chart.js failed to load — check the CDN connection.</p>';
    }
    return;
  }

  try {
    const [policyTrends, taskTrends] = await Promise.all([
      apiGet('/api/edicts/trends'),
      apiGet('/api/tasks/trends'),
    ]);
    renderTrendChart(
      policyCanvas,
      policyTrends,
      document.getElementById('policy-trend-summary'),
      'Policies'
    );
    renderTrendChart(
      taskCanvas,
      taskTrends,
      document.getElementById('task-trend-summary'),
      'Tasks'
    );
  } catch (err) {
    console.error('[Trends] Failed to load completion trends', err);
  }
}

function renderTrendChart(canvas, data, summaryEl, label) {
  const buckets = data.buckets || [];
  const months = buckets.map((b) => b.month);
  const counts = buckets.map((b) => b.completed);

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        {
          label,
          data: counts,
          backgroundColor: 'rgba(124, 140, 248, 0.65)',
          borderColor: '#7c8cf8',
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 20,
          categoryPercentage: 0.6,
          barPercentage: 0.9,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2332',
          titleColor: '#e7ecf4',
          bodyColor: '#8f9aad',
        },
      },
      scales: {
        x: {
          ticks: { color: '#8f9aad', font: { size: 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 12 },
          grid: { color: 'rgba(148,163,184,0.08)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#8f9aad', font: { size: 10 }, precision: 0 },
          grid: { color: 'rgba(148,163,184,0.08)' },
        },
      },
    },
  });

  if (summaryEl) {
    const pct = data.total > 0 ? Math.round((data.totalCompleted / data.total) * 100) : 0;
    summaryEl.textContent = `${data.totalCompleted} of ${data.total} completed (${pct}%)`;
  }
}

// Collapse/expand the trends section (remembered via the settings store)
async function initTrendsCollapse() {
  await loadSettings();
  const header = document.getElementById('trends-toggle');
  const body = document.getElementById('trends-body');
  const chevron = document.getElementById('trends-chevron');
  if (!header || !body) return;

  const wasCollapsed = !!getSetting('trendsCollapsed');

  const setCollapsed = (isCollapsed) => {
    const current = body.classList.contains('collapsed');
    if (current === isCollapsed) return;
    body.classList.toggle('collapsed', isCollapsed);
    header.setAttribute('aria-expanded', String(!isCollapsed));
    if (chevron) chevron.textContent = isCollapsed ? '▸' : '▾';
    setSetting('trendsCollapsed', isCollapsed);
    // Re-fit charts after the expand animation completes
    if (!isCollapsed) {
      setTimeout(() => {
        ['policy-trend-chart', 'task-trend-chart'].forEach((id) => {
          const chart = typeof Chart !== 'undefined' && Chart.getChart ? Chart.getChart(id) : null;
          if (chart) chart.resize();
        });
      }, 400);
    }
  };

  header.addEventListener('click', () => setCollapsed(!body.classList.contains('collapsed')));
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setCollapsed(!body.classList.contains('collapsed'));
    }
  });

  // Keep the trends section and the settings modal in sync (two-way).
  window.addEventListener('settings:changed', (e) => {
    if (e.detail && e.detail.key === 'trendsCollapsed') setCollapsed(Boolean(e.detail.value));
  });

  if (wasCollapsed) setCollapsed(true);
}

// ===========================
// END COMPLETION TRENDS
// ===========================

// Add policy button listener
document.getElementById('add-policy')?.addEventListener('click', () => {
  window.location.href = '/pages/policy.html';
});

attachHelpPopover(document.getElementById('help-add-policy-name'), {
  title: 'Policy name',
  body: `Use a short, descriptive title. Example: "Initial Policy" or "Follow-up Policy".`,
});

// Setup notification modal interactions
setupNotificationModal();

// Register unfinished policies popup in the popup management system
registerUnfinishedPoliciesPopup();

// Setup topbar (removed — notification icon no longer shown)

// Load unfinished policies and show notifications
loadUnfinishedPolicies();

// MOD-2: job follow-up reminders + live jobs-module chips on policy rows.
loadJobFollowUps();
loadJobStats();
// Certificate Dashboard: cert expiry reminders + cert chips.
loadCertExpiries();
loadCertStats();
// Refresh both when the tab regains focus (e.g. after editing on the jobs page).
window.addEventListener('focus', () => {
  loadJobFollowUps();
  loadJobStats();
  loadCertExpiries();
  loadCertStats();
});

initPolicies();

loadTrends();

initTrendsCollapse();
