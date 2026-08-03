// main page script
// index.js purpose to display all policies, and links to their individual pages

// api/api.js
import { apiGet, isLoggedIn } from '../api/api.js'; // generic API wrapper functions for calling backend routes. all fetch calls should be made through these functions for better error handling and consistency. do not use fetch() directly in other files, use these apiGet/apiPost/etc functions instead.
// components
//import "../components/policyRow.js"; // not currently used, but may be useful for future refactor to make code more modular
import '../components/servicesTray.js'; // the services tray in the top right corner

const policyCountEl = document.getElementById('policy-count');
const policyListEl = document.getElementById('policy-list');

let edictsCache = [];
let globalSettings = null;

const toggle = document.getElementById('services-toggle');
const menu = document.getElementById('services-menu');

toggle.addEventListener('click', () => {
  menu.classList.toggle('hidden');
});

document.addEventListener('click', (event) => {
  if (!menu.contains(event.target) && !toggle.contains(event.target)) {
    menu.classList.add('hidden');
  }
});

// Load settings from server. Browser caches HTTP responses by default (304 Not Modified),
// so we use cache: 'no-store' to bypass browser cache. On page load, this ensures we get
// the latest settings.json from the server. However, changes made to settings.json during
// runtime won't be reflected until you call loadSettings(true) to force-refresh, or reload the page.
async function loadSettings(forceRefresh = false) {
  if (!globalSettings || forceRefresh) {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to fetch settings');
      globalSettings = await response.json();
      applySettingsChanges(); // Apply any UI changes from new settings
    } catch (err) {
      console.error('Failed to load settings', err);
      globalSettings = { enableStatusStrip: true }; // default
    }
  }
  return globalSettings;
}

// Apply settings to the UI
function applySettingsChanges() {
  const strip = document.querySelector('.status-strip');
  if (!strip) return;

  if (!globalSettings.enableStatusStrip) {
    strip.style.display = 'none';
  } else {
    strip.style.display = 'flex';
  }
}
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
function renderPolicyRows(edicts) {
  policyListEl.innerHTML = '';
  policyCountEl.textContent = `Showing ${edicts.length} polic${edicts.length === 1 ? 'y' : 'ies'}`;

  if (edicts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'policy-row';
    empty.textContent = 'No policies available';
    policyListEl.appendChild(empty);
    return;
  }

  edicts.forEach((edict) => {
    const row = document.createElement('div');
    row.className = 'policy-row';
    row.style.cursor = 'pointer';

    // Include description inside the same row, below the main info
    //policy-row not congruent with policy-main?
    const stateLabel = formatState(edict.state);
    const stateChip = ['Draft', 'Published', 'Archived'].includes(stateLabel)
      ? `<span class="state-chip state-${stateLabel.toLowerCase()}">${stateLabel}</span>`
      : stateLabel;

    row.innerHTML = `\
                <span class="col-name">${edict.name || '-'}</span>
                <span class="col-date">${formatDate(edict.plannedStart)}</span>
                <span class="col-date">${formatDate(edict.plannedEnd)}</span>
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
      (c) => `
        <div class="stat-card ${c.tone ? `stat-${c.tone}` : ''}">
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

async function fetchIPStatuses() {
  const settings = await loadSettings();
  if (!settings.enableStatusStrip) {
    const strip = document.querySelector('.status-strip');
    if (strip) strip.style.display = 'none';
    return;
  }
  // Skip polling when logged out — the strip shows a "log in" message instead,
  // so we don't spam the auth-protected endpoint (and the console) with 401s.
  if (!isLoggedIn()) return;
  try {
    const resp = await apiGet('/api/ips/check');
    if (!resp || !resp.ok) {
      console.warn('[IP] bad response', resp);
      renderIPResults([]);
      return;
    }
    renderIPResults(resp.results || []);
  } catch (err) {
    console.warn('[IP] Failed to fetch statuses', err);
    console.warn(
      '[IP] This may be expected if the backend is not configured to /api/ips/check or if there is no network connectivity.'
    );
    renderIPResults([]);
  }
}

function renderIPResults(results) {
  const strip = document.querySelector('.status-strip');
  if (!strip) return;

  strip.style.display = 'flex'; // ensure visible when rendering

  // Clear existing items
  strip.innerHTML = '';

  if (!results || results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-item';
    empty.textContent = 'No IP status available';
    strip.appendChild(empty);
    return;
  }

  results.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'status-item';
    item.title =
      r.ip + (r.time ? ` responded in ${r.time}ms` : '') + (r.error ? `, error: ${r.error}` : ''); // tooltip for more info

    const dot = document.createElement('span');
    dot.className = 'status-dot';
    // choose visual class
    // ensure r.time is treated as a number; treat 200ms and above as a warning
    const respTime = parseFloat(r.time);
    if (r.alive) dot.classList.add('online');
    else if (!isNaN(respTime) && respTime >= 200) dot.classList.add('warning');
    else dot.classList.add('offline');

    const label = document.createElement('span');
    label.textContent = r.ip + (r.time ? ` (${r.time}ms)` : '');

    item.appendChild(dot);
    item.appendChild(label);
    strip.appendChild(item);
  });
}

// Auth-gated IP status polling: only poll while logged in, so we don't spam the
// protected /api/ips/check endpoint (and the console) with 401s when logged out.
let ipPollTimer = null;

function renderIPLoginMessage() {
  const strip = document.querySelector('.status-strip');
  if (!strip) return;
  strip.style.display = 'flex';
  strip.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'status-item';
  item.textContent = 'Log in to view statuses';
  strip.appendChild(item);
}

function stopIPPolling() {
  if (ipPollTimer) {
    clearInterval(ipPollTimer);
    ipPollTimer = null;
  }
}

function startIPPolling() {
  stopIPPolling();
  fetchIPStatuses();
  ipPollTimer = setInterval(fetchIPStatuses, 5000);
}

if (isLoggedIn()) {
  startIPPolling();
} else {
  renderIPLoginMessage();
}

window.addEventListener('auth:login', startIPPolling);
window.addEventListener('auth:logout', () => {
  stopIPPolling();
  renderIPLoginMessage();
});

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

    // Add hover effect
    row.addEventListener('mouseenter', () => {
      row.style.backgroundColor = '#2a2a2a';
    });
    row.addEventListener('mouseleave', () => {
      row.style.backgroundColor = '';
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

  unfinishedEdicts.slice(0, 5).forEach((edict) => {
    const daysOverdue = calculateDaysOverdue(edict.plannedEnd);
    const item = document.createElement('div');
    item.className = 'notification-item';

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

  // Add "view all" link if more than 5
  if (unfinishedEdicts.length > 5) {
    const viewAll = document.createElement('div');
    viewAll.className = 'notification-item';
    viewAll.style.textAlign = 'center';
    viewAll.style.color = '#7279db';
    viewAll.style.fontWeight = '600';
    viewAll.textContent = `View all (${unfinishedEdicts.length})`;
    viewAll.addEventListener('click', () => {
      openNotificationModal();
    });
    list.appendChild(viewAll);
  }
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

async function loadUnfinishedPolicies() {
  try {
    console.log('[Notifications] Fetching unfinished policies...');
    unfinishedEdicts = await apiGet('/api/edicts/unfinished');
    console.log(`[Notifications] Found ${unfinishedEdicts.length} unfinished policies`);

    // Update topbar notification icon count
    const topbarCount = document.getElementById('topbar-notification-count');
    if (topbarCount) {
      topbarCount.textContent = unfinishedEdicts.length;
    }

    // Render sidebar notification panel
    renderNotificationSidebar();
    renderPolicyStats();

    // Show modal if there are unfinished policies
    if (unfinishedEdicts.length > 0) {
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

// Setup topbar notification icon click handler
document.getElementById('topbar-notification-icon')?.addEventListener('click', () => {
  openPopup('unfinishedPolicies');
});

// Load unfinished policies and show notifications
loadUnfinishedPolicies();

initPolicies();
