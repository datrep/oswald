// responsibility: standard api helpers
import { apiGet, apiPost, apiPut, apiDelete } from '../api/api.js';

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
const addTaskBtn = document.getElementById('add-task');

// responsibility: resource modal elements
const addResourceBtn = document.getElementById('add-resource');
const cancelResourceBtn = document.getElementById('cancel-resource');

// responsibility: misc constants
const STATE_LABELS = { 1: 'Draft', 2: 'Published', 3: 'Archived' };

// responsibility: safe event binding helper
const bind = (el, evt, fn) => {
  if (el && fn) el.addEventListener(evt, fn);
};

// responsibility: page mode (which actions are available)
function configurePageMode() {
  const show = (el, visible) => {
    if (!el) return;
    el.style.display = visible ? '' : 'none';
  };

  if (isCreateMode) {
    show(saveBtn, true);
    show(editBtn, false);
    show(deleteBtn, false);
    if (modalDeleteBtn) modalDeleteBtn.style.display = 'none';
  } else {
    show(saveBtn, true);
    show(editBtn, true);
    show(deleteBtn, true);
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
    ensureSelectHasValue(priorityEl, null);
    priorityEl.value = '';
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
  row.className = 'task-row anim-enter';
  if (index !== undefined && index !== null) {
    row.style.animationDelay = `${index * 0.04}s`;
  }
  const id = task.id ?? task._tempId ?? '';
  row.innerHTML = `
        <span class="task-name" title="${task.name || ''}">${task.name || '-'}</span>
        <span class="task-date">${formatDate(task.plannedStart)}</span>
        <span class="task-date">${formatDate(task.plannedEnd)}</span>
        <span class="task-priority">${task.priority ?? '-'}</span>
        <span class="task-state">${formatState(task.state)}</span>
        <span class="task-active">${task.active ? 'Yes' : 'No'}</span>
        <span class="task-description" title="${task.info || ''}">${task.info || ''}</span>
        <span class="task-actions">
            <input type="checkbox" class="task-select" data-id="${id}">
            <button type="button" class="duplicate-btn" data-id="${id}" title="Duplicate this task">+</button>
        </span>
    `;

  // Add listener to checkbox for contextual toolbar updates
  const checkbox = row.querySelector('.task-select');
  if (checkbox) {
    checkbox.addEventListener('change', updateTaskContextToolbar);
  }

  // Duplicate button: open task modal pre-filled with this task's data
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
    viewBtn.addEventListener('click', () => openResourceViewer(resource));
  }
  const checkbox = row.querySelector('.resource-select');
  if (checkbox) {
    checkbox.addEventListener('change', updateResourceContextToolbar);
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
  if (!policyId) {
    titleEl.textContent = 'Policy';
    titleEl.title = '';
    currentPolicy = null;
    renderPolicyRows(null);
    return;
  }
  try {
    const policy = await apiGet(`/api/edicts/${policyId}`);
    currentPolicy = policy;
    titleEl.textContent = policy.name;
    titleEl.title = policy.name;
    renderPolicyRows(currentPolicy);
  } catch (err) {
    console.error('[UI] Failed to load policy', err);
    currentPolicy = null;
    renderPolicyRows(null);
  }
}

// responsibility: load tasks list
async function loadTasks() {
  if (!policyId) return;
  try {
    const tasks = await apiGet(`/api/tasks/edict/${policyId}`);
    currentTasks = tasks;
    taskListEl.innerHTML = '';
    tasks.forEach((task, i) => taskListEl.appendChild(renderTaskRow(task, i)));
    renderPolicyRows(currentPolicy);
  } catch (err) {
    console.error('[UI] Failed to load tasks', err);
    currentTasks = [];
    renderPolicyRows(currentPolicy);
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
  } catch (err) {
    console.error('[UI] Failed to load resources', err);
    resourcesCache = [];
    renderPolicyRows(currentPolicy);
  }
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
  const response = await fetch('/api/edicts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || 'Failed to create policy');
  }
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
  // Close the edit modal now that the policy exists
  closePolicyModal();
}

// Flush pending tasks and resources after a policy has been created
async function flushPendingSubmissions(createdPolicyId) {
  if (!createdPolicyId) return;

  let flushed = 0;

  // Submit tasks first
  if (pendingTasks.length) {
    console.log(`[Policy] Flushing ${pendingTasks.length} pending task(s)`);
    for (const t of pendingTasks) {
      try {
        const payload = Object.assign({}, t, { edictId: createdPolicyId });
        await apiPost('/api/tasks', payload);
      } catch (err) {
        console.error('[Policy] Failed to flush pending task', err, t);
      }
    }
    flushed += pendingTasks.length;
    pendingTasks = [];
  }

  // Then submit resources (uploads)
  if (pendingResources.length) {
    console.log(`[Policy] Flushing ${pendingResources.length} pending resource(s)`);
    for (const r of pendingResources) {
      try {
        const form = new FormData();
        form.append('file', r.file);
        // resourceController tolerates different edict param names
        form.append('edictID', createdPolicyId);
        form.append('description', r.description || '');
        await apiPost('/api/resources', form);
      } catch (err) {
        console.error('[Policy] Failed to flush pending resource', err, r);
      }
    }
    flushed += pendingResources.length;
    pendingResources = [];
  }

  if (flushed > 0) {
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
  const response = await fetch(`/api/edicts/${policyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || 'Failed to update policy');
  }
  console.log(`[Policy.save_policy] Completed: update_policy (id: ${policyId})`);
  await loadPolicy();
}

// responsibility: delete policy
async function handleDelete(btn = deleteBtn) {
  if (!policyId) {
    alert('No policy to delete.');
    return;
  }
  const confirmDelete = confirm('Are you sure you want to delete this policy?');
  if (!confirmDelete) return;

  setSaveState(btn, true, 'Delete');
  try {
    console.log(`[Policy.delete_policy] Executed: delete_policy (id: ${policyId})`);
    const response = await fetch(`/api/edicts/${policyId}`, { method: 'DELETE' });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.message || 'Failed to delete policy');
    }
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
      'Failed to save policy.'
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
  document.getElementById('task-priority').value = task?.priority ?? '';
  document.getElementById('task-state').value = task?.state ?? 1;
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
    alert('Failed to save task: ' + (err.message || 'Unknown error'));
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
  if (!confirm('Delete selected tasks?')) return;
  try {
    console.log(`[Policy.delete_task] Executed: delete_task (${selected.length} task(s))`);
    for (const id of selected) {
      if (String(id).startsWith('temp-')) {
        const idx = pendingTasks.findIndex((t) => t._tempId === id);
        if (idx !== -1) pendingTasks.splice(idx, 1);
        // remove DOM row
        const cb = document.querySelector(`.task-select[data-id="${id}"]`);
        const row = cb ? cb.closest('.task-row') : null;
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
    alert('Failed to delete selected tasks');
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
}

// responsibility: open resource modal (edit)
function openEditResource() {
  const resource = getSelectedResource();
  if (!resource) return;
  editingResourceId = resource.id;
  openResourceModal();
  resourceDescriptionInput.value = resource.description || '';
}

// responsibility: close resource modal
function closeResourceModal() {
  const modal = document.getElementById('resource-modal');
  if (!modal) return;
  modal.style.display = 'none';
  resetResourceForm();
}

// responsibility: save resource (create or replace)
async function saveResource() {
  const file = resourceFileInput.files[0];
  if (editingResourceId && !file) {
    alert('Please select a file when editing a resource.');
    return;
  }
  const description = resourceDescriptionInput.value || '';

  setSaveState(saveResourceBtn, true);

  try {
    if (!policyId) {
      // Queue resource until policy is created
      if (!file) {
        alert('Please choose a file to add as a resource.');
        return;
      }
      if (editingResourceId && String(editingResourceId).startsWith('temp-res-')) {
        // Replace existing queued resource
        const idx = pendingResources.findIndex((r) => r._tempId === editingResourceId);
        if (idx !== -1) {
          pendingResources[idx] = { _tempId: editingResourceId, file, description };
          // update DOM card if present
          const checkbox = document.querySelector(
            `.resource-select[data-id="${editingResourceId}"]`
          );
          const row = checkbox ? checkbox.closest('.resource-preview-row') : null;
          if (row) {
            row.querySelector('.resource-preview-path').textContent = file.name;
            row.querySelector('.resource-preview-description').textContent = description || '';
          }
          editingResourceId = null;
          closeResourceModal();
          return;
        }
      }
      const tempId = `temp-res-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      pendingResources.push({ _tempId: tempId, file, description });
      // Render immediately so user sees the queued resource
      resourcePreviewListEl.appendChild(
        renderResourcePreview({ _tempId: tempId, file, description })
      );
      closeResourceModal();
      console.log('[Policy] Queued resource until policy is created', file.name);
      return;
    }

    if (editingResourceId) {
      console.log(`[Policy.edit_resource] Executed: edit_resource (id: ${editingResourceId})`);
      await apiDelete(`/api/resources/${editingResourceId}`);
    } else {
      console.log('[Policy.add_resource] Executed: add_resource');
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('edictID', policyId);
    formData.append('filesize', file.size);
    formData.append('description', description);
    await apiPost('/api/resources', formData);
    if (editingResourceId) {
      console.log(`[Policy.edit_resource] Completed: edit_resource (id: ${editingResourceId})`);
    } else {
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
  if (!confirm('Delete selected resources?')) return;
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
  editingResourceId = resource.id ?? resource._tempId;
  openResourceModal();
  resourceDescriptionInput.value = resource.description || '';
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
  bind(addTaskBtn, 'click', () => openTaskModal(null));

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

  bind(addResourceBtn, 'click', openResourceModal);
  bind(cancelResourceBtn, 'click', closeResourceModal);
  bind(saveResourceBtn, 'click', saveResource);

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
}

function renderPolicyRows(policy) {
  if (!policyListEl) return;

  policyListEl.innerHTML = '';

  if (!policy) {
    const empty = document.createElement('div');
    empty.className = 'policy-row anim-fade-in';
    empty.textContent = isCreateMode
      ? 'Policy summary will appear after save.'
      : 'No policy selected.';
    policyListEl.appendChild(empty);
    return;
  }

  const row = document.createElement('div');
  row.className = 'policy-row anim-fade-in-up';
  row.innerHTML = `
        <span>${formatDate(policy.plannedStart)}</span>
        <span>${formatDate(policy.plannedEnd)}</span>
        <span>${policy.taskCount ?? 0} / ${policy.resourceCount ?? 0}</span>
        <span>${policy.active ? 'Yes' : 'No'}</span>
        <span>${policy.priority ?? '-'}</span>
        <span>${formatState(policy.state)}</span>
        <span class="policy-info">${policy.info || 'No description available.'}</span>
    `;

  policyListEl.appendChild(row);
}

init();
