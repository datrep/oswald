// responsibility: standard api helpers
import { apiGet, apiPost, apiPut, apiDelete, isLoggedIn, getToken } from '../api/api.js';
// settings
import { getSetting, setSetting, loadSettings, applyGlobalSettings, initSessionTimeout } from '../utils/settingsStore.js';
// NAV-1 breadcrumb
import { initBreadcrumb, setBreadcrumbName } from '../components/breadcrumb.js';
initBreadcrumb();

// responsibility: query params and mode flags
const params = new URLSearchParams(window.location.search);
let policyId = params.get('id');
let isCreateMode = !policyId;
// local queues for create-before-policy flows
// replaced to arrays for bulk form submissions.
let pendingTasks = [];
let pendingResources = [];

// responsibility: shared state caches
let resourcesCache = [];
let editingResourceId = null;
let currentTasks = [];
let currentTaskId = null;
let currentPolicy = null;

// responsibility: element lookups
const titleEl = document.getElementById('policy-title');
const nameEl = document.getElementById('policy-name');
const startEl = document.getElementById('policy-start');
const endEl = document.getElementById('policy-end');
const priorityEl = document.getElementById('policy-priority');
const stateEl = document.getElementById('policy-state');
const infoEl = document.getElementById('policy-info');

// responsibility: resource form elements
const resourceFileInput = document.getElementById('resource-file');
const resourceDescriptionInput = document.getElementById('resource-description');
const saveResourceBtn = document.getElementById('save-resource');

// responsibility: policy buttons + edit modal
const saveBtn = document.getElementById('save-policy');
const deleteBtn = document.getElementById('delete-policy');
const editBtn = document.getElementById('edit-policy');
const policyFormEl = document.getElementById('policy-form');
const policyModalEl = document.getElementById('policy-modal');
const modalSaveBtn = document.getElementById('modal-save-policy');
const modalDeleteBtn = document.getElementById('modal-delete-policy');
const cancelPolicyBtn = document.getElementById('cancel-policy');
const policyListEl = document.getElementById('policy-list');

// responsibility: task/resource lists
const taskListEl = document.getElementById('task-list');
const resourceListEl = document.getElementById('resource-list');
const resourcePreviewListEl = document.getElementById('resource-preview-list');

// responsibility: task modal elements
const cancelTaskBtn = document.getElementById('cancel-task');
const createTaskBtn = document.getElementById('create-task');

// responsibility: resource modal elements
const cancelResourceBtn = document.getElementById('cancel-resource');

// responsibility: misc constants
const STATE_LABELS = { 1: 'Draft', 2: 'Published', 3: 'Archived' };

// responsibility: safe event binding helper
const bind = (el, evt, fn) => {
  if (el && fn) el.addEventListener(evt, fn);
};

// responsibility: pick a user-facing error message, calling out 401s explicitly
// (a missing/expired session needs a clear "sign in" prompt, not a generic failure)
function actionErrorMessage(err, action, fallback) {
  return /401|Unauthorized/i.test(String((err && err.message) || err))
    ? `You must be signed in (session expired) to ${action}. Sign in and try again.`
    : fallback;
}

// responsibility: check a permission claim from the JWT payload
function hasPerm(code) {
  try {
    const t = getToken();
    if (!t) return false;
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Array.isArray(payload.permissions) && payload.permissions.includes(code);
  } catch {
    return false;
  }
}

// --- drag-to-reorder tasks (task #26) ---
let draggedTaskId = null;

function onTaskDragStart(e) {
  draggedTaskId = e.currentTarget.dataset.taskId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedTaskId);
  e.currentTarget.classList.add('dragging');
}

function onTaskDragOver(e) {
  e.preventDefault(); // allow drop
  e.dataTransfer.dropEffect = 'move';
  const row = e.currentTarget;
  if (draggedTaskId && row.dataset.taskId !== draggedTaskId) row.classList.add('drag-over');
}

function onTaskDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function onTaskDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  target.classList.remove('drag-over');
  if (!draggedTaskId || target.dataset.taskId === draggedTaskId) return;
  await saveTaskOrder(draggedTaskId, target.dataset.taskId);
}

function onTaskDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  taskListEl.querySelectorAll('.drag-over').forEach((c) => c.classList.remove('drag-over'));
  draggedTaskId = null;
}

// Persist a drag: reorder in the DOM, then PUT the numeric task ids in order.
async function saveTaskOrder(draggedId, targetId) {
  const rows = Array.from(taskListEl.querySelectorAll('.task-card'));
  const from = rows.findIndex((r) => r.dataset.taskId === draggedId);
  const to = rows.findIndex((r) => r.dataset.taskId === targetId);
  if (from === -1 || to === -1 || from === to) return;

  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);

  const visibleIds = rows.map((r) => r.dataset.taskId).filter((id) => /^\d+$/.test(id));
  // Hidden (archived) tasks aren't in the DOM — keep them after the visible
  // ones in their current relative order so a filtered reorder doesn't clobber
  // their sortOrder.
  const hiddenIds = currentTasks.map((t) => String(t.id)).filter((id) => !visibleIds.includes(id));
  const orderedIds = [...visibleIds, ...hiddenIds];
  if (!policyId || !orderedIds.length) {
    // No persisted policy yet (or nothing server-backed): just re-render local order
    taskListEl.innerHTML = '';
    rows.forEach((r) => taskListEl.appendChild(r));
    return;
  }

  try {
    await apiPut('/api/tasks/reorder', { edictId: policyId, orderedIds });
    await loadTasks();
  } catch (err) {
    console.error('[Task] Reorder failed', err);
    alert(actionErrorMessage(err, 'reorder tasks', 'Failed to reorder tasks.'));
    await loadTasks(); // revert to server order
  }
}

// --- drag-to-reorder resources (task #26, other data tables) ---
let draggedResourceId = null;

function onResourceDragStart(e) {
  draggedResourceId = e.currentTarget.dataset.resourceId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedResourceId);
  e.currentTarget.classList.add('dragging');
}

function onResourceDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.currentTarget;
  if (draggedResourceId && row.dataset.resourceId !== draggedResourceId) row.classList.add('drag-over');
}

function onResourceDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function onResourceDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  target.classList.remove('drag-over');
  if (!draggedResourceId || target.dataset.resourceId === draggedResourceId) return;
  await saveResourceOrder(draggedResourceId, target.dataset.resourceId);
}

function onResourceDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  resourcePreviewListEl.querySelectorAll('.drag-over').forEach((c) => c.classList.remove('drag-over'));
  draggedResourceId = null;
}

// Persist a drag: reorder in the DOM, then PUT the numeric resource ids in order.
async function saveResourceOrder(draggedId, targetId) {
  const rows = Array.from(resourcePreviewListEl.querySelectorAll('.resource-preview-row'));
  const from = rows.findIndex((r) => r.dataset.resourceId === draggedId);
  const to = rows.findIndex((r) => r.dataset.resourceId === targetId);
  if (from === -1 || to === -1 || from === to) return;

  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);

  const orderedIds = rows.map((r) => r.dataset.resourceId).filter((id) => /^\d+$/.test(id));
  if (!policyId || !orderedIds.length) {
    resourcePreviewListEl.innerHTML = '';
    rows.forEach((r) => resourcePreviewListEl.appendChild(r));
    return;
  }

  try {
    await apiPut('/api/resources/reorder', { edictId: policyId, orderedIds });
    await loadResources();
  } catch (err) {
    console.error('[Resource] Reorder failed', err);
    alert(actionErrorMessage(err, 'reorder resources', 'Failed to reorder resources.'));
    await loadResources();
  }
}

// responsibility: page mode (which actions are available)
function configurePageMode() {
  const show = (el, visible) => {
    if (!el) return;
    el.style.display = visible ? '' : 'none';
  };
  const actionEdit = document.getElementById('action-edit-policy');

  if (isCreateMode) {
    show(saveBtn, true);
    show(editBtn, false);
    show(deleteBtn, false);
    show(actionEdit, false);
    if (modalDeleteBtn) modalDeleteBtn.style.display = 'none';
  } else {
    show(saveBtn, true);
    show(editBtn, true);
    show(deleteBtn, true);
    show(actionEdit, true);
    if (modalDeleteBtn) modalDeleteBtn.style.display = '';
  }
}

// responsibility: open/close the policy edit modal
function openPolicyModal() {
  if (!policyModalEl) return;
  populatePolicyForm();
  const advancedFields = document.getElementById('policy-advanced-fields');
  const advancedToggle = document.getElementById('policy-advanced-toggle');
  if (advancedFields) advancedFields.classList.add('hidden');
  if (advancedToggle) advancedToggle.classList.remove('expanded');
  const feedback = document.getElementById('policy-form-feedback');
  if (feedback) feedback.classList.add('hidden');
  policyModalEl.style.display = 'flex';
  setTimeout(() => nameEl && nameEl.focus(), 100);
}

function closePolicyModal() {
  if (!policyModalEl) return;
  policyModalEl.style.display = 'none';
}

function populatePolicyForm() {
  const p = currentPolicy;
  if (!p) {
    nameEl.value = '';
    startEl.value = formatDateInput(roundToClosestMinute(new Date()));
    endEl.value = '';
    // QoL: prefill a default end date when the setting asks for one.
    const endOffsetDays = Number(getSetting('defaultPolicyEndOffset') || 0);
    if (endOffsetDays > 0) {
      endEl.value = formatDateInput(roundToClosestMinute(new Date(Date.now() + endOffsetDays * 86400000)));
    }
    ensureSelectHasValue(priorityEl, null);
    priorityEl.value = getSetting('defaultPolicyPriority') ?? '';
    stateEl.value = isCreateMode ? '1' : '';
    infoEl.value = '';
    return;
  }
  nameEl.value = p.name || '';
  startEl.value = formatDateInput(p.plannedStart);
  endEl.value = formatDateInput(p.plannedEnd);
  ensureSelectHasValue(priorityEl, p.priority);
  priorityEl.value = p.priority ?? '';
  stateEl.value = p.state ?? '';
  infoEl.value = p.info ?? '';
}

// responsibility: date formatting helpers
function formatDateInput(value) {
  // Return a value compatible with <input type="datetime-local"> in the user's local timezone.
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad2 = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return date.toLocaleDateString();
}

function formatState(state) {
  return STATE_LABELS[state] || state;
}

// Derive a human "due" status from plannedEnd: overdue / due today / days left.
function formatDue(plannedEnd) {
  if (!plannedEnd) return { text: 'no end date', state: 'ok' };
  const end = new Date(plannedEnd).getTime();
  if (!Number.isFinite(end)) return { text: '—', state: 'ok' };
  const days = Math.round((end - Date.now()) / 86400000);
  if (days < 0) return { text: `${-days}d overdue`, state: 'overdue' };
  if (days === 0) return { text: 'due today', state: 'today' };
  return { text: `${days}d left`, state: 'ok' };
}

// responsibility: simple helpers
function extractFilename(path) {
  if (!path) return '-';
  return path.split('/').pop();
}

function roundToClosestMinute(date) {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return new Date();
  const seconds = d.getSeconds();
  d.setSeconds(0, 0);
  if (seconds >= 30) d.setMinutes(d.getMinutes() + 1);
  return d;
}

function setDatetimeLocalNow(inputEl) {
  if (!inputEl) return;
  inputEl.value = formatDateInput(roundToClosestMinute(new Date()));
}

function setInputBlank(inputEl) {
  if (!inputEl) return;
  inputEl.value = '';
}

function toOptionalInt(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

function ensureSelectHasValue(selectEl, value) {
  if (!selectEl) return;
  if (value === null || value === undefined) return;
  const str = String(value);
  const has = [...selectEl.options].some((o) => o.value === str);
  if (has) return;
  const opt = document.createElement('option');
  opt.value = str;
  opt.textContent = str;
  selectEl.appendChild(opt);
}

function populateStateSelect(selectEl) {
  if (!selectEl) return;
  const currentValue = selectEl.value;
  selectEl.innerHTML = '';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '-';
  selectEl.appendChild(blank);

  Object.entries(STATE_LABELS).forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    selectEl.appendChild(option);
  });

  if (currentValue) selectEl.value = currentValue;
}

function collectPolicyData() {
  if (!nameEl || !startEl || !endEl || !priorityEl || !stateEl || !infoEl) {
    console.error('One or more form elements are missing');
    throw new Error('Form elements not found');
  }
  return {
    name: nameEl.value,
    plannedStart: startEl.value || null,
    plannedEnd: endEl.value || null, // optional (DB allows NULL)
    priority: toOptionalInt(priorityEl.value),
    state: toOptionalInt(stateEl.value),
    info: infoEl.value,
  };
}

// ===========================
// CONTEXTUAL TOOLBAR HELPERS (LLM-assisted)
// Purpose: manage task and resource selection state and UI
// ===========================

function updateTaskContextToolbar() {
  const selected = getSelectedTaskIds();
  const toolbar = document.getElementById('task-context-toolbar');
  const countEl = document.getElementById('task-selected-count');
  if (!toolbar) return;
  if (selected.length === 0) {
    toolbar.classList.add('hidden');
  } else {
    toolbar.classList.remove('hidden');
    countEl.textContent = `${selected.length} selected`;
  }
}

function updateResourceContextToolbar() {
  const selected = document.querySelectorAll('.resource-select:checked');
  const toolbar = document.getElementById('resource-context-toolbar');
  const countEl = document.getElementById('resource-selected-count');
  if (!toolbar) return;
  if (selected.length === 0) {
    toolbar.classList.add('hidden');
  } else {
    toolbar.classList.remove('hidden');
    countEl.textContent = `${selected.length} selected`;
  }
}

// ===========================
// END CONTEXTUAL TOOLBAR HELPERS (LLM-assisted)
// ===========================

// responsibility: render helpers
function renderTaskRow(task, index) {
  const row = document.createElement('div');
  row.className = 'task-card anim-enter';
  if (index !== undefined && index !== null) {
    row.style.animationDelay = `${index * 0.04}s`;
  }
  const id = task.id ?? task._tempId ?? '';
  row.dataset.taskId = id;
  const priorityChip =
    task.priority != null && task.priority !== ''
      ? `<span class="task-chip task-chip-priority">P${task.priority}</span>`
      : '';
  const stateChip = `<span class="task-chip task-chip-state">${formatState(task.state)}</span>`;
  const activeChip = `<span class="task-chip task-chip-active">${task.active ? 'Active' : 'Inactive'}</span>`;

  const due = formatDue(task.plannedEnd);
  const dueClass = due.state === 'overdue' ? ' is-overdue' : due.state === 'today' ? ' is-today' : '';
  const info = task.info || '';
  const infoClass = info ? '' : ' is-empty';
  const assigned = task.assignedToUserId != null ? `User #${task.assignedToUserId}` : '—';

  row.innerHTML = `
        <div class="task-card-head">
            <input type="checkbox" class="task-select" data-id="${id}" title="Select task">
            <span class="task-card-name" title="${task.name || ''}">${task.name || '-'}</span>
            ${getSetting('showTaskIds') ? `<span class="task-card-id" title="Task ID">#${id}</span>` : ''}
            <span class="task-card-chips">
                ${priorityChip}${stateChip}${activeChip}
            </span>
        </div>
        <div class="task-card-grid">
            <div class="task-cell"><span class="task-cell-label">Start</span><span class="task-cell-value">${formatDate(task.plannedStart)}</span></div>
            <div class="task-cell"><span class="task-cell-label">End</span><span class="task-cell-value">${formatDate(task.plannedEnd)}</span></div>
            <div class="task-cell"><span class="task-cell-label">Created</span><span class="task-cell-value">${formatDate(task.createdAt)}</span></div>
            <div class="task-cell"><span class="task-cell-label">Due</span><span class="task-cell-value${dueClass}">${due.text}</span></div>
            <div class="task-cell"><span class="task-cell-label">Assigned</span><span class="task-cell-value">${assigned}</span></div>
            <div class="task-cell"><span class="task-cell-label">Completed</span><span class="task-cell-value">${formatDate(task.completedAt)}</span></div>
        </div>
        <div class="task-card-info${infoClass}" title="${task.info || ''}">${info || 'No description'}</div>
        <div class="task-card-actions">
            <button type="button" class="duplicate-btn" data-id="${id}" title="Duplicate this task">+</button>
        </div>
    `;

  const checkbox = row.querySelector('.task-select');
  if (checkbox) {
    checkbox.addEventListener('change', updateTaskContextToolbar);
  }

  const dupBtn = row.querySelector('.duplicate-btn');
  if (dupBtn) {
    dupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dup = { ...task };
      delete dup.id;
      delete dup._tempId;
      dup.name = (dup.name || '') + ' (copy)';
      openTaskModal(dup);
    });
  }

  // Drag-to-reorder only for users who can manage tasks + the setting is on
  if (isLoggedIn() && hasPerm('tasks.manage') && getSetting('taskDragReorder') !== false) {
    row.draggable = true;
    row.classList.add('draggable');
    row.addEventListener('dragstart', onTaskDragStart);
    row.addEventListener('dragover', onTaskDragOver);
    row.addEventListener('dragleave', onTaskDragLeave);
    row.addEventListener('drop', onTaskDrop);
    row.addEventListener('dragend', onTaskDragEnd);
  }

  return row;
}

function renderResourcePreview(resource, index) {
  const isPending = !!resource._tempId && !resource.resourcePath;
  const fileName = extractFilename(resource.resourcePath || resource.file?.name || '');
  const webPath = isPending
    ? ''
    : formatResourcePath(resource.resourcePath || resource.file?.name || '');
  const kind = getFileKind(fileName);
  const id = resource.id ?? resource._tempId ?? '';
  const row = document.createElement('div');
  row.className = 'resource-preview-row anim-enter';
  row.dataset.resourceId = id;
  if (index !== undefined && index !== null) {
    row.style.animationDelay = `${index * 0.06}s`;
  }

  let thumb;
  if (!webPath) {
    thumb = '<div class="thumbnail-placeholder">Pending</div>';
  } else if (kind === 'image') {
    thumb = `<img src="/${webPath}" alt="${fileName}" class="resource-thumb">`;
  } else {
    thumb = `<div class="resource-type-badge" data-kind="${kind}">${getFileLabel(kind)}</div>`;
  }

  const actions = webPath
    ? `<button type="button" class="resource-view-btn" title="View ${fileName}">View</button>`
    : '<span class="resource-missing">Pending</span>';

  row.innerHTML = `
        <div class="thumbnail-preview">
            ${thumb}
        </div>
        <div class="resource-preview-text">
            <div class="resource-preview-path" title="${fileName}">${fileName}</div>
            <div class="resource-preview-description">${resource.description || 'No description'}</div>
        </div>
        <div class="resource-actions">
            ${actions}
            <input type="checkbox" class="resource-select" data-id="${id}" title="Select for edit/delete">
        </div>
    `;

  const img = row.querySelector('img.resource-thumb');
  if (img) {
    img.addEventListener('error', () => {
      img.replaceWith(
        Object.assign(document.createElement('div'), {
          className: 'resource-type-badge',
          dataset: { kind },
          textContent: getFileLabel(kind),
        })
      );
    });
  }
  const viewBtn = row.querySelector('.resource-view-btn');
  if (viewBtn) {
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openResourceViewer(resource);
    });
  }
  const checkbox = row.querySelector('.resource-select');
  if (checkbox) {
    // Check only — don't let the click bubble to the row and open the viewer.
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      updateResourceContextToolbar();
    });
  }
  // Clicking anywhere on the card opens the viewer (if enabled)
  if (webPath && getSetting('openResourceOnClick')) {
    row.classList.add('resource-clickable');
    row.addEventListener('click', () => openResourceViewer(resource));
  }

  // Drag-to-reorder only for users who can manage resources + the setting is on
  if (isLoggedIn() && hasPerm('resources.manage') && getSetting('taskDragReorder') !== false) {
    row.draggable = true;
    row.classList.add('draggable');
    row.addEventListener('dragstart', onResourceDragStart);
    row.addEventListener('dragover', onResourceDragOver);
    row.addEventListener('dragleave', onResourceDragLeave);
    row.addEventListener('drop', onResourceDrop);
    row.addEventListener('dragend', onResourceDragEnd);
  }
  return row;
}

function getSelectedTaskIds() {
  return Array.from(document.querySelectorAll('.task-select:checked'))
    .map((cb) => cb.dataset.id)
    .filter(Boolean);
}

function getSelectedResource() {
  const selected = document.querySelectorAll('.resource-select:checked');
  if (selected.length === 0) {
    alert('Select a resource to edit.');
    return null;
  }
  if (selected.length > 1) {
    alert('Only one resource can be edited at a time.');
    return null;
  }
  const rawId = selected[0].dataset.id;
  // numeric id -> existing resource from server
  const numeric = Number.parseInt(rawId, 10);
  if (Number.isFinite(numeric)) {
    return resourcesCache.find((r) => r.id === numeric);
  }
  // otherwise look in pendingResources by _tempId
  return pendingResources.find((r) => r._tempId === rawId) || null;
}

// responsibility: load policy data
async function loadPolicy() {
  const titleIdEl = document.getElementById('policy-title-id');
  if (!policyId) {
    titleEl.textContent = 'Policy';
    if (titleIdEl) titleIdEl.textContent = '';
    titleEl.title = '';
    currentPolicy = null;
    setBreadcrumbName(isCreateMode ? 'New policy' : 'Policy');
    renderPolicyRows(null);
    return;
  }
  try {
    const policy = await apiGet(`/api/edicts/${policyId}`);
    currentPolicy = policy;
    titleEl.textContent = policy.name;
    if (titleIdEl) titleIdEl.textContent = '#' + policy.id;
    titleEl.title = policy.name;
    setBreadcrumbName('Policy: ' + policy.name);
    renderPolicyRows(currentPolicy);
  } catch (err) {
    console.error('[UI] Failed to load policy', err);
    currentPolicy = null;
    setBreadcrumbName('Policy');
    renderPolicyRows(null);
  }
}

// responsibility: load tasks list
async function loadTasks() {
  if (!policyId) return;
  try {
    const tasks = await apiGet(`/api/tasks/edict/${policyId}`);
    currentTasks = tasks;
    // Archived (state 3) tasks are hidden by default; the toggle reveals them.
    // currentTasks keeps ALL tasks so the policy card counter + rail progress
    // still reflect the whole policy.
    const showArchived = !!getSetting('showArchivedTasks');
    const visible = showArchived ? tasks : tasks.filter((t) => Number(t.state) !== 3);
    taskListEl.innerHTML = '';
    visible.forEach((task, i) => taskListEl.appendChild(renderTaskRow(task, i)));
    renderPolicyRows(currentPolicy);
    renderRailProgress();
  } catch (err) {
    console.error('[UI] Failed to load tasks', err);
    currentTasks = [];
    renderPolicyRows(currentPolicy);
    renderRailProgress();
  }
}

// responsibility: load resources list
async function loadResources() {
  if (!policyId) return;
  try {
    const resources = await apiGet(`/api/resources/edict/${policyId}`);
    resourcesCache = resources;
    resourcePreviewListEl.innerHTML = '';
    resources.forEach((resource, i) => {
      resourcePreviewListEl.appendChild(renderResourcePreview(resource, i));
    });
    renderPolicyRows(currentPolicy);
    renderRailProgress();
  } catch (err) {
    console.error('[UI] Failed to load resources', err);
    resourcesCache = [];
    renderPolicyRows(currentPolicy);
    renderRailProgress();
  }
}

// responsibility: left rail — quick nav between policies (dropdown)
async function loadPolicyNav() {
  const sel = document.getElementById('policy-nav-select');
  if (!sel) return;
  try {
    const policies = await apiGet('/api/edicts');
    const currentId = Number(policyId);
    sel.innerHTML = '';
    policies.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name || 'Untitled'}${p.active ? ' • active' : ''}`;
      opt.selected = p.id === currentId;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      const id = sel.value;
      if (id && Number(id) !== currentId) window.location.href = `/pages/policy.html?id=${id}`;
    });
  } catch (err) {
    console.error('[Rail] Failed to load policy nav', err);
  }
}

// responsibility: right rail — task completion progress
function renderRailProgress() {
  const el = document.getElementById('rail-progress');
  if (!el) return;
  const total = currentTasks.length;
  const done = currentTasks.filter((t) => Number(t.state) === 3).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const overdue = currentTasks.filter((t) => formatDue(t.plannedEnd).state === 'overdue').length;
  el.innerHTML = `
    <div class="rail-progress-bar"><div class="rail-progress-fill" style="width:${pct}%"></div></div>
    <div class="rail-progress-row">${done} / ${total} tasks complete</div>
    ${overdue ? `<div class="rail-progress-row is-warn">${overdue} task${overdue === 1 ? '' : 's'} overdue</div>` : ''}
    <div class="rail-progress-row">${resourcesCache.length} resource${resourcesCache.length === 1 ? '' : 's'}</div>
  `;
}

// Confirm a destructive action only if the setting allows it.
function confirmIfEnabled(message) {
  return getSetting('confirmDelete') ? confirm(message) : true;
}

// Left/right rails visibility from settings.
function applyPolicyRails() {
  const show = getSetting('showPolicyRails');
  document.querySelectorAll('.policy-rail').forEach((r) => {
    r.style.display = show ? '' : 'none';
  });
}

// responsibility: create policy
async function createPolicy() {
  const advancedHidden = document.getElementById('policy-advanced-fields')?.classList.contains('hidden');

  const data = {
    name: nameEl.value,
    plannedStart: startEl.value || null,
    plannedEnd: endEl.value || null, // optional (DB allows NULL)
    priority: advancedHidden ? null : toOptionalInt(priorityEl.value),
    state: advancedHidden ? 1 : toOptionalInt(stateEl.value), // default Draft
    info: advancedHidden ? '' : (infoEl.value || ''),
  };

  if (!data.plannedStart) {
    showFieldError(startEl, 'Planned start date is required.');
    throw new Error('Validation failed');
  }
  if (!data.name || !data.name.trim()) {
    showFieldError(nameEl, 'Policy name is required.');
    throw new Error('Validation failed');
  }
  console.log('[Policy.save_policy] Executed: create_policy');
  const result = await apiPost('/api/edicts', data);
  console.log(`[Policy.save_policy] Completed: create_policy (id: ${result.id})`);
  // Switch the current page into view-mode for the newly created policy
  policyId = result.id;
  isCreateMode = false;
  // Flush any queued tasks/resources that were added while policy did not exist
  await flushPendingSubmissions(policyId);
  // Reload server-backed lists
  await loadPolicy();
  await loadTasks();
  await loadResources();
  await loadModules();
  // Close the edit modal now that the policy exists
  closePolicyModal();
}

// Flush pending tasks and resources after a policy has been created
async function flushPendingSubmissions(createdPolicyId) {
  if (!createdPolicyId) return;

  let flushed = 0;
  let unauthorized = false;

  // Submit tasks first
  if (pendingTasks.length) {
    console.log(`[Policy] Flushing ${pendingTasks.length} pending task(s)`);
    for (const t of pendingTasks) {
      try {
        const payload = Object.assign({}, t, { edictId: createdPolicyId });
        await apiPost('/api/tasks', payload);
        flushed += 1;
      } catch (err) {
        console.error('[Policy] Failed to flush pending task', err, t);
        // 401 = session missing/expired: every remaining item fails the same way,
        // so stop and tell the user instead of silently dropping their data.
        if (/401|Unauthorized/i.test(String((err && err.message) || err))) {
          unauthorized = true;
          break;
        }
      }
    }
    if (!unauthorized) pendingTasks = [];
  }

  // Then submit resources (uploads or queued attach-existing entries)
  if (pendingResources.length && !unauthorized) {
    console.log(`[Policy] Flushing ${pendingResources.length} pending resource(s)`);
    for (const r of pendingResources) {
      try {
        if (r.resourcePath && !r.file) {
          // Queued "attach existing" resource (from the picker)
          await apiPost('/api/resources/attach', {
            edictId: createdPolicyId,
            resourcePath: r.resourcePath,
            description: r.description || '',
          });
        } else {
          const form = new FormData();
          form.append('file', r.file);
          // resourceController tolerates different edict param names
          form.append('edictID', createdPolicyId);
          form.append('description', r.description || '');
          await apiPost('/api/resources', form);
        }
        flushed += 1;
      } catch (err) {
        console.error('[Policy] Failed to flush pending resource', err, r);
        if (/401|Unauthorized/i.test(String((err && err.message) || err))) {
          unauthorized = true;
          break;
        }
      }
    }
    if (!unauthorized) pendingResources = [];
  }

  if (unauthorized) {
    alert(
      'Your session expired while saving — pending tasks/resources were NOT saved. Sign in and try again.'
    );
  } else if (flushed > 0) {
    alert('Pending tasks and resources have been saved.');
  }
}

// responsibility: update policy
async function updatePolicy() {
  if (!policyId) {
    throw new Error('No policy selected.');
  }
  // When editing, advanced fields are always shown — read all values from form
  const data = collectPolicyData();
  if (!data.plannedStart) {
    showFieldError(startEl, 'Planned start date is required.');
    throw new Error('Validation failed');
  }
  if (!data.name || !data.name.trim()) {
    showFieldError(nameEl, 'Policy name is required.');
    throw new Error('Validation failed');
  }
  console.log(`[Policy.save_policy] Executed: update_policy (id: ${policyId})`);
  await apiPut(`/api/edicts/${policyId}`, data);
  console.log(`[Policy.save_policy] Completed: update_policy (id: ${policyId})`);
  await loadPolicy();
}

// responsibility: delete policy
async function handleDelete(btn = deleteBtn) {
  if (!policyId) {
    alert('No policy to delete.');
    return;
  }
  const confirmDelete = confirmIfEnabled('Are you sure you want to delete this policy?');
  if (!confirmDelete) return;

  setSaveState(btn, true, 'Delete');
  try {
    console.log(`[Policy.delete_policy] Executed: delete_policy (id: ${policyId})`);
    await apiDelete(`/api/edicts/${policyId}`);
    console.log(`[Policy.delete_policy] Completed: delete_policy (id: ${policyId})`);
    window.location.href = '/index.html';
  } catch (err) {
    console.error('[Policy] Delete failed', err);
    alert('Error deleting policy: ' + err.message);
    setSaveState(btn, false, 'Delete');
  }
}

// responsibility: save policy (create or update)
async function handleSave() {
  setSaveState(modalSaveBtn, true);
  try {
    if (isCreateMode) {
      await createPolicy();
    } else {
      await updatePolicy();
    }
    closePolicyModal();
  } catch (err) {
    showFormFeedback(
      document.getElementById('policy-form-feedback'),
      'error',
      actionErrorMessage(err, 'save policies', 'Failed to save policy.')
    );
  } finally {
    setSaveState(modalSaveBtn, false);
  }
}

// responsibility: reset task form fields
function resetTaskForm() {
  const modal = document.getElementById('task-modal');
  if (!modal) return;
  const fields = modal.querySelectorAll('input, textarea, select');
  fields.forEach((field) => {
    if (field.type === 'checkbox' || field.type === 'radio') {
      field.checked = false;
    } else {
      field.value = '';
    }
  });
}

// responsibility: open task modal
function openTaskModal(task = null) {
  const modal = document.getElementById('task-modal');
  if (!modal) return;
  currentTaskId = task && task.id ? task.id : null;

  const titleEl = document.getElementById('task-modal-title');
  if (titleEl) titleEl.textContent = currentTaskId ? 'Edit Task' : 'Add Task';

  document.getElementById('task-name').value = task?.name ?? '';
  document.getElementById('task-start').value = task?.plannedStart
    ? formatDateInput(task.plannedStart)
    : formatDateInput(roundToClosestMinute(new Date())); // auto-fill to now for new tasks
  document.getElementById('task-end').value = formatDateInput(task?.plannedEnd);
  ensureSelectHasValue(document.getElementById('task-priority'), task?.priority);
  document.getElementById('task-priority').value =
    task?.priority ?? getSetting('defaultTaskPriority') ?? '';
  document.getElementById('task-state').value = task?.state ?? getSetting('defaultTaskState') ?? 1;
  document.getElementById('task-info').value = task?.info ?? '';
  document.getElementById('task-user').value = task?.assignedToUserId ?? '';

  // Advanced fields default to closed (user expands when needed)
  const advancedFields = document.getElementById('task-advanced-fields');
  const advancedToggle = document.getElementById('task-advanced-toggle');
  advancedFields?.classList.add('hidden');
  advancedToggle?.classList.remove('expanded');

  modal.style.display = 'flex';
  // Focus the name field for quick keyboard entry
  setTimeout(() => document.getElementById('task-name')?.focus(), 100);
}

// responsibility: close task modal
function closeTaskModal() {
  const modal = document.getElementById('task-modal');
  if (!modal) return;
  modal.style.display = 'none';
  resetTaskForm();
}

// responsibility: create or edit task
async function handleCreateTask() {
  // Clear previous field errors
  showFieldError(document.getElementById('task-start'), '');
  showFieldError(document.getElementById('task-name'), '');

  // Writes need an authenticated session — fail loudly instead of queueing silently
  if (!isLoggedIn()) {
    alert('You must be signed in to add tasks. Sign in and try again.');
    return;
  }

  if (!document.getElementById('task-start').value) {
    showFieldError(document.getElementById('task-start'), 'Planned start date is required.');
    return;
  }

  // Smart defaults: if advanced fields are hidden, inherit from parent policy
  const advancedHidden = document.getElementById('task-advanced-fields')?.classList.contains('hidden');
  const priorityVal = advancedHidden && currentPolicy
    ? (currentPolicy.priority ?? '')
    : document.getElementById('task-priority').value;
  const stateVal = advancedHidden ? '1' : document.getElementById('task-state').value;
  const endVal = document.getElementById('task-end').value || null; // optional (DB allows NULL)
  const infoVal = advancedHidden ? '' : document.getElementById('task-info').value;
  const userVal = advancedHidden ? '' : document.getElementById('task-user').value;

  const payload = {
    name: document.getElementById('task-name').value,
    plannedStart: document.getElementById('task-start').value,
    plannedEnd: endVal,
    priority: toOptionalInt(priorityVal),
    state: toOptionalInt(stateVal),
    info: infoVal,
    assignedToUserId: toOptionalInt(userVal),
  };

  setSaveState(createTaskBtn, true);

  try {
    if (!policyId) {
      // Queue task locally until policy is created
      const tempId = `temp-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      const queued = Object.assign({}, payload, { _tempId: tempId });
      pendingTasks.push(queued);
      // Render immediately so user sees the queued task
      taskListEl.appendChild(renderTaskRow(queued, pendingTasks.length - 1));
      console.log('[Policy] Queued task until policy is created', queued);
    } else {
      if (currentTaskId) {
        // Update existing task via PUT
        console.log(`[Policy.edit_task] Executed: edit_task (id: ${currentTaskId})`);
        await apiPut(`/api/tasks/${currentTaskId}`, payload);
        console.log(`[Policy.edit_task] Completed: edit_task (id: ${currentTaskId})`);
      } else {
        payload.edictId = policyId;
        console.log('[Policy.add_task] Executed: add_task');
        await apiPost('/api/tasks', payload);
        console.log('[Policy.add_task] Completed: add_task');
      }
    }
    closeTaskModal();
    await loadTasks();
  } catch (err) {
    console.error('[Task] Save failed', err);
    alert(actionErrorMessage(err, 'add tasks', 'Failed to save task: ' + (err.message || 'Unknown error')));
  } finally {
    setSaveState(createTaskBtn, false);
  }
}

// responsibility: remove tasks
async function handleRemoveTasks() {
  const selected = getSelectedTaskIds();
  if (!selected.length) {
    alert('Select at least one task to delete.');
    return;
  }
  if (!confirmIfEnabled('Delete selected tasks?')) return;
  try {
    console.log(`[Policy.delete_task] Executed: delete_task (${selected.length} task(s))`);
    for (const id of selected) {
      if (String(id).startsWith('temp-')) {
        const idx = pendingTasks.findIndex((t) => t._tempId === id);
        if (idx !== -1) pendingTasks.splice(idx, 1);
        // remove DOM row (rows are rendered as .task-card, not .task-row)
        const cb = document.querySelector(`.task-select[data-id="${id}"]`);
        const row = cb ? cb.closest('.task-card') : null;
        if (row) row.remove();
      } else {
        await apiDelete(`/api/tasks/${id}`);
      }
    }
    console.log(`[Policy.delete_task] Completed: delete_task (${selected.length} task(s) deleted)`);
    await loadTasks();
    updateTaskContextToolbar();
  } catch (err) {
    console.error('[Task] Delete failed', err);
    alert(actionErrorMessage(err, 'delete tasks', 'Failed to delete selected tasks'));
  }
}

// responsibility: reset resource form
function resetResourceForm() {
  const modal = document.getElementById('resource-modal');
  if (!modal) return;
  const fields = modal.querySelectorAll('input, textarea, select');
  fields.forEach((field) => {
    if (field.type === 'checkbox' || field.type === 'radio') {
      field.checked = false;
    } else {
      field.value = '';
    }
  });
}

// responsibility: open resource modal (new)
function openResourceModal() {
  const modal = document.getElementById('resource-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const title = document.getElementById('resource-modal-title');
  if (title) title.textContent = 'Add Resource';
  // Create mode: no replace-file toggle, file input enabled.
  const wrap = document.getElementById('resource-replace-wrap');
  if (wrap) wrap.style.display = 'none';
  const cb = document.getElementById('resource-replace-file');
  if (cb) cb.checked = false;
  resourceFileInput.disabled = false;
  resourceFileInput.value = '';
}

// responsibility: open resource modal (edit)
function openEditResource() {
  const resource = getSelectedResource();
  if (!resource) return;
  editingResourceId = resource.id ?? resource._tempId;
  openResourceModal();
  resourceDescriptionInput.value = resource.description || '';
  const title = document.getElementById('resource-modal-title');
  if (title) title.textContent = 'Edit Resource';
  // Editing: replace-file is OFF by default and the file input is greyed out
  // until the user ticks "Replace the file" — description-only edits need no file.
  const wrap = document.getElementById('resource-replace-wrap');
  if (wrap) wrap.style.display = '';
  const cb = document.getElementById('resource-replace-file');
  if (cb) cb.checked = false;
  resourceFileInput.disabled = true;
  resourceFileInput.value = '';
}

// responsibility: close resource modal
function closeResourceModal() {
  const modal = document.getElementById('resource-modal');
  if (!modal) return;
  modal.style.display = 'none';
  resetResourceForm();
}

// Discard resources queued for a not-yet-saved policy (create mode only).
function discardQueuedResources() {
  pendingResources = pendingResources.filter(
    (r) => !String(r._tempId || '').startsWith('temp-res-')
  );
  resourcePreviewListEl.innerHTML = '';
}

// Cancel = discard queued resources, then close. (closeResourceModal itself is
// also called right after a real save, where the queue must be kept.)
function cancelResourceModal() {
  discardQueuedResources();
  closeResourceModal();
}

// ---- Attach-existing resource picker (task 56: pull from oswald's /resources) ----
let resourcePickerCache = [];

function openResourcePicker() {
  const modal = document.getElementById('resource-picker');
  if (!modal) return;
  const search = document.getElementById('resource-picker-search');
  const list = document.getElementById('resource-picker-list');
  modal.style.display = 'flex';
  if (search) search.value = '';
  if (list) list.innerHTML = '<div class="picker-status muted">Loading resources…</div>';
  if (search) search.focus();
  loadResourcePicker();
}

async function loadResourcePicker() {
  const list = document.getElementById('resource-picker-list');
  const status = document.getElementById('resource-picker-status');
  try {
    resourcePickerCache = await apiGet('/api/resources');
    const q = (document.getElementById('resource-picker-search').value || '').trim();
    renderResourcePicker(resourcePickerCache, q);
    if (status) status.textContent = `${resourcePickerCache.length} resource(s) available`;
  } catch (err) {
    console.error('[Policy] Failed to load resources for picker', err);
    const message = /401|Unauthorized/i.test(String(err))
      ? 'You must be logged in to attach resources.'
      : 'Could not load resources. Please try again.';
    if (list) list.innerHTML = `<div class="picker-status muted">${message}</div>`;
  }
}

function renderResourcePicker(resources, q) {
  const list = document.getElementById('resource-picker-list');
  const showThumbs = getSetting('resourcePickerThumbnails') !== false;
  const hoverPreview = getSetting('pickerHoverPreview') !== false;
  const query = (q || '').toLowerCase();
  const filtered = query
    ? resources.filter(
        (r) =>
          (r.resourcePath || '').toLowerCase().includes(query) ||
          (r.description || '').toLowerCase().includes(query) ||
          (r.edictName || '').toLowerCase().includes(query)
      )
    : resources;
  if (!list) return;
  if (!filtered.length) {
    list.innerHTML = '<div class="picker-status muted">No resources found.</div>';
    return;
  }
  list.innerHTML = '';
  for (const r of filtered) {
    const name = extractFilename(r.resourcePath || '');
    const kind = getFileKind(name);
    const webPath = formatResourcePath(r.resourcePath || '');
    const row = document.createElement('div');
    row.className = 'picker-row';
    const thumbSlot = document.createElement('span');
    thumbSlot.className = 'picker-thumb-slot';
    if (kind === 'image' && showThumbs) {
      const img = document.createElement('img');
      img.className = 'picker-thumb';
      img.loading = 'lazy';
      img.src = '/' + webPath;
      img.alt = '';
      img.onerror = () => {
        thumbSlot.innerHTML = `<span class="resource-type-badge" data-kind="${kind}">${getFileLabel(kind)}</span>`;
      };
      thumbSlot.appendChild(img);
    } else {
      thumbSlot.innerHTML = `<span class="resource-type-badge" data-kind="${kind}">${getFileLabel(kind)}</span>`;
    }
    row.appendChild(thumbSlot);
    row.insertAdjacentHTML('beforeend', `
      <span class="p-name">${escapeHtml(name)}</span>
      <span class="p-meta">${r.edictName ? escapeHtml(r.edictName) : '—'}</span>
      <span class="p-attach">Attach</span>
    `);
    row.addEventListener('mouseenter', () => {
      if (hoverPreview) showPickerTip(row, { name, path: r.resourcePath, policy: r.edictName, webPath, kind });
    });
    row.addEventListener('mouseleave', hidePickerTip);
    row.addEventListener('click', () => attachExistingResource(r));
    list.appendChild(row);
  }
}

// Custom hover preview for a picker row: thumbnail + name, mounted path, policy.
function getPickerTip() {
  let tip = document.getElementById('picker-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'picker-tip';
    tip.className = 'picker-tip';
    document.getElementById('resource-picker').appendChild(tip);
  }
  return tip;
}

function showPickerTip(row, info) {
  const tip = getPickerTip();
  const thumb =
    info.kind === 'image'
      ? `<img class="picker-tip-thumb" src="/${info.webPath}" alt="">`
      : `<span class="resource-type-badge" data-kind="${info.kind}">${getFileLabel(info.kind)}</span>`;
  tip.innerHTML = `
    <div class="picker-tip-thumb-slot">${thumb}</div>
    <div class="picker-tip-fields">
      <div><span class="lbl">Name</span><span class="val">${escapeHtml(info.name)}</span></div>
      <div><span class="lbl">Path</span><span class="val mono">${escapeHtml(info.path || '—')}</span></div>
      <div><span class="lbl">Policy</span><span class="val">${escapeHtml(info.policy || '—')}</span></div>
    </div>
  `;
  const tipImg = tip.querySelector('.picker-tip-thumb');
  if (tipImg) {
    tipImg.onerror = () => {
      const slot = tip.querySelector('.picker-tip-thumb-slot');
      if (slot) {
        slot.innerHTML = `<span class="resource-type-badge" data-kind="${info.kind}">${getFileLabel(info.kind)}</span>`;
      }
    };
  }
  tip.style.display = 'block';
  const rect = row.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.right + 10;
  if (left + tipRect.width > window.innerWidth - 8) {
    left = Math.max(8, rect.left - tipRect.width - 10);
  }
  const top = Math.min(Math.max(rect.top, 8), window.innerHeight - tipRect.height - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hidePickerTip() {
  const tip = document.getElementById('picker-tip');
  if (tip) tip.style.display = 'none';
}

async function attachExistingResource(resource) {
  const status = document.getElementById('resource-picker-status');
  const name = extractFilename(resource.resourcePath || '');
  try {
    if (!policyId) {
      // Create mode: queue the attach until the policy exists
      const tempId = `temp-res-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      pendingResources.push({
        _tempId: tempId,
        resourcePath: resource.resourcePath,
        description: resource.description || '',
      });
      resourcePreviewListEl.appendChild(
        renderResourcePreview({
          _tempId: tempId,
          resourcePath: resource.resourcePath,
          description: resource.description || '',
        })
      );
      closeResourcePicker();
      alert(`Queued "${name}" — it will be attached once the policy is saved.`);
      return;
    }
    await apiPost('/api/resources/attach', {
      edictId: policyId,
      resourcePath: resource.resourcePath,
      description: resource.description || '',
    });
    closeResourcePicker();
    await loadResources();
  } catch (err) {
    console.error('[Policy] Failed to attach resource', err);
    const message = /401|Unauthorized/i.test(String(err))
      ? 'You must be logged in to attach resources.'
      : 'Attach failed. Please try again.';
    if (status) status.textContent = message;
    else alert(message);
  }
}

// ---- Policy modules (module-attachment framework, PREREQ) ----
// Registry of module types a policy can attach. The backend allowlist lives in
// models/policyModuleModel.js; this richer registry drives the UI.
//
// FUTURE SCOPE: add new module types here (e.g. { type: 'certificates', ... })
// and to MODULE_TYPES in policyModuleModel.js — the framework handles the rest.
const POLICY_MODULES = [
  { type: 'jobs', label: 'Job Applications', icon: '💼', description: 'Track job applications — pipeline, follow-ups, stats.' },
  { type: 'career_files', label: 'Career Files', icon: '📁', description: 'Resume, certs and career documents.' },
  { type: 'certificates', label: 'Certificates', icon: '🎓', description: 'Certifications, expiry tracking and study links.' },
];
const modulesEl = document.getElementById('policy-modules');

function moduleMeta(type) {
  return POLICY_MODULES.find((x) => x.type === type) || { type, label: type, icon: '🧩', description: '' };
}

async function loadModules() {
  if (!policyId || !modulesEl) return;
  try {
    const modules = await apiGet(`/api/edicts/${policyId}/modules`);
    renderModules(modules);
  } catch (err) {
    console.error('[UI] Failed to load modules', err);
    modulesEl.innerHTML = '<div class="muted" style="padding:8px 2px;font-size:13px">Failed to load modules.</div>';
  }
}

function renderModules(modules) {
  modulesEl.innerHTML = '';
  if (!modules.length) {
    modulesEl.innerHTML = '<div class="muted" style="padding:6px 2px;font-size:13px">No modules attached yet — add one to bring a tool into this policy.</div>';
    return;
  }
  for (const m of modules) modulesEl.appendChild(renderModulePanel(m));
}

function modulePage(type) {
  return { jobs: '/pages/jobs.html', career_files: '/pages/career-files.html', certificates: '/pages/certs.html' }[type] || null;
}

function renderModulePanel(m) {
  const meta = moduleMeta(m.moduleType);
  const card = document.createElement('div');
  card.className = 'module-panel';
  card.dataset.moduleType = m.moduleType;
  const canManage = isLoggedIn() && hasPerm('policies.manage');
  const page = modulePage(m.moduleType);
  card.innerHTML = `
    <div class="module-panel-head">
      <span class="module-panel-icon">${meta.icon}</span>
      <div class="module-panel-title">
        <strong>${escapeHtml(meta.label)}</strong>
        <span class="module-panel-summary muted">…</span>
      </div>
      ${page ? `<a class="module-open" href="${page}" title="Open ${escapeHtml(meta.label)}">Open →</a>` : ''}
      ${canManage ? `<button type="button" class="module-detach" data-type="${escapeHtml(m.moduleType)}" title="Remove this module">✕</button>` : ''}
    </div>
    <div class="module-panel-body">
      <div class="muted module-placeholder">${escapeHtml(meta.description)}</div>
    </div>
  `;
  fillModuleSummary(m.moduleType, card.querySelector('.module-panel-summary'));
  const detach = card.querySelector('.module-detach');
  if (detach) detach.addEventListener('click', () => detachModule(m.moduleType));
  return card;
}

// Compact summary/identifier on a module panel (best-effort; needs a signed-in user).
async function fillModuleSummary(type, el) {
  if (!el) return;
  try {
    if (type === 'jobs') {
      const s = await apiGet('/api/applications/stats');
      el.textContent = `${s.total} applications · ${s.active} active · ${s.offers} offers`;
    } else if (type === 'career_files') {
      const files = await apiGet('/api/career-files');
      el.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
    } else if (type === 'certificates') {
      const s = await apiGet('/api/certifications/stats');
      el.textContent = `${s.total} certs · ${s.obtained} obtained · ${s.expiringWithin90} expiring`;
    }
  } catch {
    el.textContent = '';
  }
}

async function openModulePicker() {
  const modal = document.getElementById('module-picker');
  const list = document.getElementById('module-picker-list');
  if (!modal || !list) return;
  modal.style.display = 'flex';
  list.innerHTML = '<div class="picker-status muted">Loading…</div>';
  const status = document.getElementById('module-picker-status');
  if (status) status.textContent = '';
  let attached = [];
  if (policyId) {
    try {
      attached = await apiGet(`/api/edicts/${policyId}/modules`);
    } catch { /* ignore */ }
  }
  const attachedTypes = new Set(attached.map((m) => m.moduleType));
  const available = POLICY_MODULES.filter((m) => !attachedTypes.has(m.type));
  if (!available.length) {
    list.innerHTML = '<div class="picker-status muted">All available modules are already attached.</div>';
    return;
  }
  list.innerHTML = '';
  for (const m of available) {
    const row = document.createElement('div');
    row.className = 'picker-row';
    row.innerHTML = `
      <span class="picker-thumb-slot module-picker-icon">${m.icon}</span>
      <span class="p-name"><strong>${escapeHtml(m.label)}</strong><span class="muted" style="font-size: 12px; display: block">${escapeHtml(m.description)}</span></span>
      <span class="p-attach">Add</span>
    `;
    row.addEventListener('click', () => attachModule(m.type));
    list.appendChild(row);
  }
}

function closeModulePicker() {
  const modal = document.getElementById('module-picker');
  if (modal) modal.style.display = 'none';
}

async function attachModule(moduleType) {
  if (!policyId) {
    alert('Save the policy first, then attach modules.');
    return;
  }
  try {
    await apiPost(`/api/edicts/${policyId}/modules`, { moduleType });
    closeModulePicker();
    await loadModules();
  } catch (err) {
    alert(actionErrorMessage(err, 'add module', 'Failed to attach module.'));
  }
}

async function detachModule(moduleType) {
  const meta = moduleMeta(moduleType);
  if (!confirm(`Remove the "${meta.label}" module from this policy?`)) return;
  try {
    await apiDelete(`/api/edicts/${policyId}/modules/${encodeURIComponent(moduleType)}`);
    await loadModules();
  } catch (err) {
    alert(actionErrorMessage(err, 'remove module', 'Failed to remove module.'));
  }
}

function closeResourcePicker() {
  const modal = document.getElementById('resource-picker');
  if (!modal) return;
  modal.style.display = 'none';
  hidePickerTip();
}

// responsibility: save resource (create, replace file, or update description only)
async function saveResource() {
  const file = resourceFileInput.files[0];
  const description = resourceDescriptionInput.value || '';

  setSaveState(saveResourceBtn, true);

  try {
    if (!policyId) {
      // Create mode: update a queued temp resource, or queue a new one.
      if (editingResourceId && String(editingResourceId).startsWith('temp-res-')) {
        const idx = pendingResources.findIndex((r) => r._tempId === editingResourceId);
        if (idx !== -1) {
          pendingResources[idx] = { _tempId: editingResourceId, file, description };
          const checkbox = document.querySelector(
            `.resource-select[data-id="${editingResourceId}"]`
          );
          const row = checkbox ? checkbox.closest('.resource-preview-row') : null;
          if (row) {
            if (file) row.querySelector('.resource-preview-path').textContent = file.name;
            row.querySelector('.resource-preview-description').textContent = description || '';
          }
          editingResourceId = null;
          closeResourceModal();
          return;
        }
      }
      if (!file) {
        alert('Please choose a file to add as a resource.');
        return;
      }
      const tempId = `temp-res-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      pendingResources.push({ _tempId: tempId, file, description });
      resourcePreviewListEl.appendChild(renderResourcePreview({ _tempId: tempId, file, description }));
      closeResourceModal();
      console.log('[Policy] Queued resource until policy is created', file.name);
      return;
    }

    if (editingResourceId && file) {
      // Replace the file: delete the old row, upload the new file.
      console.log(`[Policy.edit_resource] Executed: edit_resource (id: ${editingResourceId}, replace file)`);
      await apiDelete(`/api/resources/${editingResourceId}`);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('edictID', policyId);
      formData.append('filesize', file.size);
      formData.append('description', description);
      await apiPost('/api/resources', formData);
      console.log(`[Policy.edit_resource] Completed: edit_resource (id: ${editingResourceId})`);
    } else if (editingResourceId) {
      // Description-only edit — no file required.
      console.log(`[Policy.edit_resource] Executed: edit_resource (id: ${editingResourceId}, description only)`);
      await apiPut(`/api/resources/${editingResourceId}`, { description });
      console.log(`[Policy.edit_resource] Completed: edit_resource (id: ${editingResourceId})`);
    } else {
      console.log('[Policy.add_resource] Executed: add_resource');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('edictID', policyId);
      formData.append('filesize', file.size);
      formData.append('description', description);
      await apiPost('/api/resources', formData);
      console.log('[Policy.add_resource] Completed: add_resource');
    }
    editingResourceId = null;
    closeResourceModal();
    await loadResources();
  } catch (err) {
    console.error('[UI] Failed to save resource', err);
    const message = /401|Unauthorized/i.test(String(err))
      ? 'You must be logged in to add resources.'
      : 'Resource save failed. Please try again.';
    alert(message);
  } finally {
    setSaveState(saveResourceBtn, false);
  }
}

// responsibility: delete resources
async function deleteSelectedResources() {
  const selected = document.querySelectorAll('.resource-select:checked');
  if (selected.length === 0) {
    alert('No resources selected.');
    return;
  }
  if (!confirmIfEnabled('Delete selected resources?')) return;
  try {
    console.log(
      `[Policy.delete_resource] Executed: delete_resource (${selected.length} resource(s))`
    );
    for (const checkbox of selected) {
      const id = checkbox.dataset.id;
      const numeric = Number.parseInt(id, 10);
      if (Number.isFinite(numeric)) {
        await apiDelete(`/api/resources/${id}`);
      } else {
        // remove from local pending queue
        const idx = pendingResources.findIndex((r) => r._tempId === id);
        if (idx !== -1) pendingResources.splice(idx, 1);
      }
      // remove card from DOM
      const row = checkbox.closest('.resource-preview-row');
      if (row) row.remove();
    }
    console.log(
      `[Policy.delete_resource] Completed: delete_resource (${selected.length} resource(s) deleted)`
    );
    await loadResources();
    updateResourceContextToolbar();
  } catch (err) {
    console.error('[UI] Failed to delete resources', err);
    alert('Delete failed');
  }
}

// ===========================
// CONTEXTUAL EDIT/DELETE HANDLERS (LLM-assisted)
// Purpose: handle edit/delete from contextual toolbars
// ===========================

// responsibility: edit selected task from contextual toolbar
function handleEditContextTask() {
  const selectedIds = getSelectedTaskIds();
  if (selectedIds.length !== 1) {
    alert('Please select exactly one task to edit.');
    return;
  }
  const task = currentTasks.find((t) => t.id == selectedIds[0]);
  if (!task) return;
  console.log(`[Policy.edit_task] Executed: edit_task (id: ${task.id})`);
  openTaskModal(task);
}

// responsibility: delete selected tasks from contextual toolbar
function handleDeleteContextTask() {
  console.log('[Policy.delete_task] Executed: delete_task');
  handleRemoveTasks();
}

// responsibility: edit selected resource from contextual toolbar
function handleEditContextResource() {
  const resource = getSelectedResource();
  if (!resource) return;
  console.log(
    `[Policy.edit_resource] Executed: edit_resource (id: ${resource.id ?? resource._tempId})`
  );
  openEditResource();
}

// responsibility: delete selected resources from contextual toolbar
function handleDeleteContextResource() {
  console.log('[Policy.delete_resource] Executed: delete_resource');
  deleteSelectedResources();
}

// ===========================\n// END CONTEXTUAL EDIT/DELETE HANDLERS (LLM-assisted)
// ===========================

// responsibility: format resource paths for display
function formatResourcePath(path) {
  if (!path) return '';
  const normalized = path.replaceAll('\\', '/');
  const resourcesIndex = normalized.indexOf('resources/');
  if (resourcesIndex !== -1) {
    return normalized.slice(resourcesIndex);
  }
  return normalized;
}

// ===========================
// RESOURCE VIEWER (type-aware)
// ===========================
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const TEXT_EXTS = new Set([
  'txt', 'md', 'json', 'log', 'csv', 'ini', 'yaml', 'yml', 'xml',
  'js', 'ts', 'html', 'css', 'py', 'sh', 'sql', 'cfg', 'env',
]);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'avi', 'mkv']);
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']);
const KIND_LABELS = {
  image: 'IMAGE', pdf: 'PDF', text: 'TEXT', audio: 'AUDIO', video: 'VIDEO',
  docx: 'DOCX', xlsx: 'XLSX', archive: 'ARCHIVE', other: 'FILE',
};

function getFileKind(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  return 'other';
}

function getFileLabel(kind) {
  return KIND_LABELS[kind] || 'FILE';
}

function escapeHtml(str) {
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

async function openResourceViewer(resource) {
  const viewer = document.getElementById('resource-viewer');
  if (!viewer) return;
  const webPath = formatResourcePath(resource.resourcePath || '');
  if (!webPath) return;
  const fileName = extractFilename(resource.resourcePath || '');
  const kind = getFileKind(fileName);
  const src = '/' + webPath;
  const titleEl = document.getElementById('resource-viewer-title');
  const body = document.getElementById('resource-viewer-body');
  const download = document.getElementById('resource-viewer-download');
  if (titleEl) titleEl.textContent = fileName;
  if (download) {
    download.href = src;
    download.setAttribute('download', fileName);
  }
  body.innerHTML = '';
  viewer.style.display = 'flex';

  try {
    if (kind === 'image') {
      body.innerHTML = `<div class="rv-center"><img class="rv-image" src="${src}" alt="${escapeHtml(fileName)}"></div>`;
    } else if (kind === 'pdf') {
      body.innerHTML = `<iframe class="rv-pdf" src="${src}" title="${escapeHtml(fileName)}"></iframe>`;
    } else if (kind === 'text') {
      const text = await (await fetch(src)).text();
      let out = text;
      if (fileName.toLowerCase().endsWith('.json')) {
        try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      }
      body.innerHTML = `<pre class="rv-text">${escapeHtml(out)}</pre>`;
    } else if (kind === 'audio') {
      body.innerHTML = `<div class="rv-center"><audio controls src="${src}" class="rv-media"></audio></div>`;
    } else if (kind === 'video') {
      body.innerHTML = `<div class="rv-center"><video controls src="${src}" class="rv-media"></video></div>`;
    } else if (kind === 'docx') {
      await loadScript(DOCX_URL);
      const container = document.createElement('div');
      container.className = 'rv-docx';
      body.appendChild(container);
      const buf = await (await fetch(src)).arrayBuffer();
      await window.docx.renderAsync(buf, container);
    } else if (kind === 'xlsx') {
      await loadScript(SHEETJS_URL);
      const buf = await (await fetch(src)).arrayBuffer();
      const wb = window.XLSX.read(buf);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const html = window.XLSX.utils.sheet_to_html(sheet, { editable: false });
      body.innerHTML = `<div class="rv-xlsx">${html}</div>`;
    } else {
      body.innerHTML = `<div class="rv-download-card">
        <div class="resource-type-badge" data-kind="${kind}">${getFileLabel(kind)}</div>
        <p class="rv-note">No inline preview for this file type — use Download to open it.</p>
      </div>`;
    }
  } catch (err) {
    console.error('[Viewer] Failed to render resource', err);
    body.innerHTML = '<div class="rv-error">Could not render this file inline — use Download to open it.</div>';
  }
}

function closeResourceViewer() {
  const viewer = document.getElementById('resource-viewer');
  if (!viewer) return;
  viewer.style.display = 'none';
  const body = document.getElementById('resource-viewer-body');
  if (body) body.innerHTML = '';
}

// responsibility: initialize task-ender resize drag handler
function initializeTaskEnderResize() {
  const taskEnder = document.querySelector('.task-ender');
  const taskList = document.querySelector('#task-list');

  if (!taskEnder || !taskList) return;

  let isDragging = false;
  let startY = 0;
  let startMaxHeight = 0;

  taskEnder.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startMaxHeight = taskList.offsetHeight;
    taskEnder.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const deltaY = e.clientY - startY;
    const newMaxHeight = Math.max(100, startMaxHeight + deltaY);
    taskList.style.maxHeight = `${newMaxHeight}px`;
    taskList.style.overflowY = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    taskEnder.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
}

// responsibility: init page wiring
async function init() {
  initializeTaskEnderResize();

  configurePageMode();

  // Global settings (theme/accent/session) + workspace rails
  await loadSettings();
  applyGlobalSettings();
  initSessionTimeout();
  applyPolicyRails();
  window.addEventListener('settings:changed', applyPolicyRails);

  populateStateSelect(stateEl);
  populateStateSelect(document.getElementById('task-state'));
  if (isCreateMode && !stateEl.value) stateEl.value = '1';

  attachHelpPopover(document.getElementById('help-policy-name'), {
    title: 'Policy name',
    body: 'Use a short, descriptive title. Example: “Initial Policy” or “Follow-up Policy”.',
  });

  attachHelpPopover(document.getElementById('help-task-name'), {
    title: 'Task name',
    body: 'Use an action-oriented title. Example: “Draft announcement copy” or “Review resources”.',
  });

  bind(document.getElementById('policy-end-now'), 'click', () => setDatetimeLocalNow(endEl));
  bind(document.getElementById('policy-end-clear'), 'click', () => setInputBlank(endEl));

  // Policy advanced fields toggle
  bind(document.getElementById('policy-advanced-toggle'), 'click', () => {
    const fields = document.getElementById('policy-advanced-fields');
    const toggle = document.getElementById('policy-advanced-toggle');
    if (!fields || !toggle) return;
    const isHidden = fields.classList.contains('hidden');
    fields.classList.toggle('hidden', !isHidden);
    toggle.classList.toggle('expanded', isHidden);
  });

  bind(document.getElementById('task-end-now'), 'click', () =>
    setDatetimeLocalNow(document.getElementById('task-end'))
  );
  bind(document.getElementById('task-end-clear'), 'click', () =>
    setInputBlank(document.getElementById('task-end'))
  );

  bind(saveBtn, 'click', () => openPolicyModal());
  bind(deleteBtn, 'click', () => handleDelete(deleteBtn));
  bind(editBtn, 'click', () => openPolicyModal());
  bind(cancelPolicyBtn, 'click', closePolicyModal);
  bind(modalDeleteBtn, 'click', () => handleDelete(modalDeleteBtn));
  // Policy form: pressing Enter in any field saves
  policyFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSave();
  });

  // Clicking the backdrop closes the form modals (policy / task / resource).
  // Suppress it right after a native text drag: dragging selected text out of a
  // field fires a click on the shared ancestor (the modal), which used to close
  // the modal unexpectedly (task #64). dragend clears the flag on the next tick
  // so a later genuine click still closes the modal.
  let modalTextDrag = false;
  const clearModalDrag = () => { setTimeout(() => { modalTextDrag = false; }, 0); };
  document.addEventListener('dragstart', () => { modalTextDrag = true; });
  document.addEventListener('dragend', clearModalDrag);
  document.addEventListener('drop', clearModalDrag);
  const closeOnBackdrop = (el, closeFn) => {
    if (el) el.addEventListener('click', (e) => {
      if (e.target === el && !modalTextDrag) closeFn();
    });
  };
  closeOnBackdrop(policyModalEl, closePolicyModal);
  closeOnBackdrop(document.getElementById('task-modal'), closeTaskModal);
  closeOnBackdrop(document.getElementById('resource-modal'), cancelResourceModal);

  // Clear field errors on input
  bind(nameEl, 'input', () => showFieldError(nameEl, ''));
  bind(startEl, 'input', () => showFieldError(startEl, ''));
  const taskNameEl = document.getElementById('task-name');
  const taskStartEl = document.getElementById('task-start');
  bind(taskNameEl, 'input', () => showFieldError(taskNameEl, ''));
  bind(taskStartEl, 'input', () => showFieldError(taskStartEl, ''));

  bind(cancelTaskBtn, 'click', closeTaskModal);
  // Task form: Enter in any field creates the task; Create button is type=submit
  document.getElementById('task-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleCreateTask();
  });

  // Advanced fields toggle in task modal
  bind(document.getElementById('task-advanced-toggle'), 'click', () => {
    const fields = document.getElementById('task-advanced-fields');
    const toggle = document.getElementById('task-advanced-toggle');
    if (!fields || !toggle) return;
    const isHidden = fields.classList.contains('hidden');
    fields.classList.toggle('hidden', !isHidden);
    toggle.classList.toggle('expanded', isHidden);
  });

  // LLM-assisted: New contextual toolbar bindings for tasks
  bind(document.getElementById('edit-task'), 'click', handleEditContextTask);
  bind(document.getElementById('delete-task'), 'click', handleDeleteContextTask);

  bind(cancelResourceBtn, 'click', cancelResourceModal);
  bind(saveResourceBtn, 'click', saveResource);

  // Replace-file toggle in the resource edit modal: off by default so you can
  // edit just the description; ticking it enables the (greyed) file input.
  const replaceFileCb = document.getElementById('resource-replace-file');
  if (replaceFileCb) {
    replaceFileCb.addEventListener('change', () => {
      resourceFileInput.disabled = !replaceFileCb.checked;
      if (!replaceFileCb.checked) resourceFileInput.value = '';
    });
  }

  // Attach-existing resource picker (task 56)
  bind(document.getElementById('attach-existing-resource'), 'click', openResourcePicker);
  bind(document.getElementById('resource-picker-close'), 'click', closeResourcePicker);
  closeOnBackdrop(document.getElementById('resource-picker'), closeResourcePicker);
  const resourcePickerSearchEl = document.getElementById('resource-picker-search');
  if (resourcePickerSearchEl) {
    resourcePickerSearchEl.addEventListener('input', () =>
      renderResourcePicker(resourcePickerCache, resourcePickerSearchEl.value)
    );
  }

  // Module-attachment framework (PREREQ)
  bind(document.getElementById('action-add-module'), 'click', openModulePicker);
  bind(document.getElementById('module-picker-close'), 'click', closeModulePicker);
  closeOnBackdrop(document.getElementById('module-picker'), closeModulePicker);

  // LLM-assisted: New contextual toolbar bindings for resources
  bind(document.getElementById('edit-resource'), 'click', handleEditContextResource);
  bind(document.getElementById('delete-resource'), 'click', handleDeleteContextResource);

  // Type-aware resource viewer modal
  bind(document.getElementById('resource-viewer-close'), 'click', closeResourceViewer);
  const viewerEl = document.getElementById('resource-viewer');
  bind(viewerEl, 'click', (e) => {
    if (e.target === viewerEl) closeResourceViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && viewerEl && viewerEl.style.display === 'flex') closeResourceViewer();
  });

  // Top action bar: Edit / Add Task / Add Resource
  bind(document.getElementById('action-edit-policy'), 'click', () => openPolicyModal());
  bind(document.getElementById('action-add-task'), 'click', () => openTaskModal(null));
  bind(document.getElementById('action-add-resource'), 'click', () => openResourceModal());

  // Show-archived toggle (archived/state-3 tasks are hidden by default)
  const archiveToggle = document.getElementById('toggle-archived');
  if (archiveToggle) {
    archiveToggle.checked = !!getSetting('showArchivedTasks');
    archiveToggle.addEventListener('change', () => {
      setSetting('showArchivedTasks', archiveToggle.checked);
      loadTasks();
    });
  }
  window.addEventListener('settings:changed', (e) => {
    if (e.detail && e.detail.key === 'showArchivedTasks') {
      if (archiveToggle) archiveToggle.checked = !!e.detail.value;
      loadTasks();
    }
  });

  if (isCreateMode) {
    // Creating: open the edit modal, auto-fill start date
    openPolicyModal();
    renderPolicyRows(null);
    console.log('[Policy] Create mode: True');
    return;
  }

  // Viewing: load data, edit via the Edit Policy button/modal
  console.log('[Policy] View mode', policyId);
  await loadPolicy();
  await loadTasks();
  await loadResources();
  await loadModules();
  loadPolicyNav();
}

function renderPolicyRows(policy) {
  if (!policyListEl) return;

  policyListEl.innerHTML = '';

  if (!policy) {
    const empty = document.createElement('div');
    empty.className = 'policy-empty anim-fade-in';
    empty.textContent = isCreateMode
      ? 'Policy summary will appear after save.'
      : 'No policy selected.';
    policyListEl.appendChild(empty);
    return;
  }

  const due = formatDue(policy.plannedEnd);
  const dueClass = due.state === 'overdue' ? ' is-overdue' : due.state === 'today' ? ' is-today' : '';
  const priorityChip =
    policy.priority != null && policy.priority !== ''
      ? `<span class="policy-chip policy-chip-priority">P${policy.priority}</span>`
      : '';
  const stateChip = `<span class="policy-chip policy-chip-state">${formatState(policy.state)}</span>`;
  const activeChip = `<span class="policy-chip policy-chip-active">${policy.active ? 'Active' : 'Inactive'}</span>`;
  const info = policy.info || '';
  const infoClass = info ? '' : ' is-empty';

  const card = document.createElement('div');
  card.className = 'policy-card anim-fade-in-up';
  card.innerHTML = `
        <div class="policy-card-head">
            <span class="policy-card-name" title="${policy.name || ''}">${policy.name || '-'}</span>
            <span class="policy-card-chips">
                ${stateChip}${priorityChip}${activeChip}
            </span>
        </div>
        <div class="policy-card-grid">
            <div class="policy-cell"><span class="policy-cell-label">Start</span><span class="policy-cell-value">${formatDate(policy.plannedStart)}</span></div>
            <div class="policy-cell"><span class="policy-cell-label">End</span><span class="policy-cell-value">${formatDate(policy.plannedEnd)}</span></div>
            <div class="policy-cell"><span class="policy-cell-label">Created</span><span class="policy-cell-value">${formatDate(policy.createdAt)}</span></div>
            <div class="policy-cell"><span class="policy-cell-label">Due</span><span class="policy-cell-value${dueClass}">${due.text}</span></div>
            <div class="policy-cell"><span class="policy-cell-label">Tasks</span><span class="policy-cell-value">${currentTasks.length} / ${resourcesCache.length}</span></div>
            <div class="policy-cell"><span class="policy-cell-label">Completed</span><span class="policy-cell-value">${formatDate(policy.completedAt)}</span></div>
        </div>
        <div class="policy-card-info${infoClass}">${info || 'No description'}</div>
    `;
  policyListEl.appendChild(card);
}

init();
