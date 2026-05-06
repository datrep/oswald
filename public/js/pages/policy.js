// responsibility: standard api helpers
import { apiGet, apiPost, apiDelete } from "../api/api.js";

// responsibility: query params and mode flags
const params = new URLSearchParams(window.location.search);
const policyId = params.get("id");
const isCreateMode = !policyId;
const edictId = parseInt(policyId); // reserved for future counts

// responsibility: shared state caches
let resourcesCache = [];
let editingResourceId = null;
let currentTasks = [];
let currentTaskId = null;
let currentPolicy = null;

// responsibility: element lookups
const titleEl = document.getElementById("policy-title");
const nameEl = document.getElementById("policy-name");
const startEl = document.getElementById("policy-start");
const endEl = document.getElementById("policy-end");
const priorityEl = document.getElementById("policy-priority");
const stateEl = document.getElementById("policy-state");
const infoEl = document.getElementById("policy-info");

// responsibility: resource form elements
const resourceFileInput = document.getElementById("resource-file");
const resourceDescriptionInput = document.getElementById("resource-description");
const saveResourceBtn = document.getElementById("save-resource");

// responsibility: policy buttons
const saveBtn = document.getElementById("save-policy");
const deleteBtn = document.getElementById("delete-policy");
const editBtn = document.getElementById("edit-policy");
const policyFormEl = document.getElementById("policy-form");
const policyFormPanelEl = document.getElementById("policy-form-panel");
const policyListEl = document.getElementById("policy-list");

// responsibility: task/resource lists
const taskListEl = document.getElementById("task-list");
const resourceListEl = document.getElementById("resource-list");

// responsibility: task modal elements
const cancelTaskBtn = document.getElementById("cancel-task");
const createTaskBtn = document.getElementById("create-task");
const addTaskBtn = document.getElementById("add-task");

// responsibility: resource modal elements
const addResourceBtn = document.getElementById("add-resource");
const cancelResourceBtn = document.getElementById("cancel-resource");

// responsibility: misc constants
const STATE_LABELS = { 1: "Draft", 2: "Published", 3: "Archived" };

// ===========================
// HELP POPOVERS (LLM-assisted)
// Purpose: add a reusable "?" button popover pattern for inline field help (no hover required).
// Notes: this block was implemented with LLM assistance and then adapted to the existing codebase.
//
// How to reuse:
// - Add a button element with class `help-btn` and a stable id (e.g. `help-foo`).
// - Call `attachHelpPopover(document.getElementById("help-foo"), { title, body })` in `init()`.
// ===========================
function attachHelpPopover(buttonEl, { title, body }) {
    if (!buttonEl) return;

    let popoverEl = null;
    let isOpen = false;

    const close = () => {
        if (!popoverEl) return;
        popoverEl.remove();
        popoverEl = null;
        isOpen = false;
        buttonEl.setAttribute("aria-expanded", "false");
    };

    const open = () => {
        close();

        popoverEl = document.createElement("div");
        popoverEl.className = "help-popover";
        popoverEl.setAttribute("role", "tooltip");
        popoverEl.innerHTML = `
            <div class="help-popover-title"></div>
            <div class="help-popover-body"></div>
        `;
        popoverEl.querySelector(".help-popover-title").textContent = title || "More info";
        popoverEl.querySelector(".help-popover-body").textContent = body || "";

        document.body.appendChild(popoverEl);

        const rect = buttonEl.getBoundingClientRect();
        const gap = 8;
        const maxRight = window.innerWidth - 12;

        // Position under the button; clamp horizontally to stay on screen.
        let left = rect.left;
        let top = rect.bottom + gap;

        const popRect = popoverEl.getBoundingClientRect();
        if (left + popRect.width > maxRight) {
            left = Math.max(12, maxRight - popRect.width);
        }
        if (top + popRect.height > window.innerHeight - 12) {
            top = Math.max(12, rect.top - gap - popRect.height);
        }

        popoverEl.style.left = `${left}px`;
        popoverEl.style.top = `${top}px`;

        isOpen = true;
        buttonEl.setAttribute("aria-expanded", "true");
    };

    const toggle = () => {
        if (isOpen) close();
        else open();
    };

    buttonEl.setAttribute("aria-haspopup", "true");
    buttonEl.setAttribute("aria-expanded", "false");

    buttonEl.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
    });

    document.addEventListener("click", (e) => {
        if (!isOpen) return;
        if (e.target === buttonEl) return;
        if (popoverEl && popoverEl.contains(e.target)) return;
        close();
    });

    document.addEventListener("keydown", (e) => {
        if (!isOpen) return;
        if (e.key === "Escape") close();
    });
}
// ===========================
// END HELP POPOVERS (LLM-assisted)
// ===========================

// responsibility: safe event binding helper
const bind = (el, evt, fn) => {
    if (el && fn) el.addEventListener(evt, fn);
};

// responsibility: field edit toggles
function configurePageMode() {
    const show = (el, visible) => {
        if (!el) return;
        el.style.display = visible ? "" : "none";
    };

    if (isCreateMode) {
        show(saveBtn, true);
        show(editBtn, false);
        show(deleteBtn, false);
    } else {
        show(saveBtn, true);
        show(editBtn, true);
        show(deleteBtn, true);
    }
}

// responsibility: enable/disable base fields
function setFieldsEditable(enabled) {
    nameEl.disabled = !enabled;
    startEl.disabled = !enabled;
    endEl.disabled = !enabled;
    priorityEl.disabled = !enabled;
    stateEl.disabled = !enabled;
    infoEl.disabled = !enabled;
}

function setPolicyFormVisible(visible) {
    if (!policyFormPanelEl) return;
    policyFormPanelEl.classList.toggle("hidden", !visible);
}

function togglePolicyEditor() {
    if (!policyFormPanelEl) return;
    const isHidden = policyFormPanelEl.classList.contains("hidden");
    const show = isHidden;
    setPolicyFormVisible(show);
    setFieldsEditable(show);
    if (editBtn) editBtn.textContent = show ? "Hide Editor" : "Edit Policy";
}

// responsibility: date formatting helpers
function formatDateInput(value) {
    // Return a value compatible with <input type="datetime-local"> in the user's local timezone.
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const pad2 = (n) => String(n).padStart(2, "0");
    const yyyy = date.getFullYear();
    const mm = pad2(date.getMonth() + 1);
    const dd = pad2(date.getDate());
    const hh = pad2(date.getHours());
    const min = pad2(date.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    return date.toLocaleDateString();
}

function formatState(state) {
    return STATE_LABELS[state] || state;
}

// responsibility: simple helpers
function extractFilename(path) {
    if (!path) return "-";
    return path.split("/").pop();
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
    inputEl.value = "";
}

function toOptionalInt(value) {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (trimmed === "") return null;
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) ? n : null;
}

function ensureSelectHasValue(selectEl, value) {
    if (!selectEl) return;
    if (value === null || value === undefined) return;
    const str = String(value);
    const has = [...selectEl.options].some(o => o.value === str);
    if (has) return;
    const opt = document.createElement("option");
    opt.value = str;
    opt.textContent = str;
    selectEl.appendChild(opt);
}

function populateStateSelect(selectEl) {
    if (!selectEl) return;
    const currentValue = selectEl.value;
    selectEl.innerHTML = "";

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "-";
    selectEl.appendChild(blank);

    Object.entries(STATE_LABELS).forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        selectEl.appendChild(option);
    });

    if (currentValue) selectEl.value = currentValue;
}

function collectPolicyData() {
    if (!nameEl || !startEl || !endEl || !priorityEl || !stateEl || !infoEl) {
        console.error("One or more form elements are missing");
        throw new Error("Form elements not found");
    }
    return {
        name: nameEl.value,
        plannedStart: startEl.value || null,
        plannedEnd: endEl.value || null, // optional
        priority: toOptionalInt(priorityEl.value),
        state: toOptionalInt(stateEl.value),
        info: infoEl.value
    };
}

// ===========================
// CONTEXTUAL TOOLBAR HELPERS (LLM-assisted)
// Purpose: manage task and resource selection state and UI
// ===========================

function updateTaskContextToolbar() {
    const selected = getSelectedTaskIds();
    const toolbar = document.getElementById("task-context-toolbar");
    const countEl = document.getElementById("task-selected-count");
    if (!toolbar) return;
    if (selected.length === 0) {
        toolbar.classList.add("hidden");
    } else {
        toolbar.classList.remove("hidden");
        countEl.textContent = `${selected.length} selected`;
    }
}

function updateResourceContextToolbar() {
    const selected = document.querySelectorAll(".resource-select:checked");
    const toolbar = document.getElementById("resource-context-toolbar");
    const countEl = document.getElementById("resource-selected-count");
    if (!toolbar) return;
    if (selected.length === 0) {
        toolbar.classList.add("hidden");
    } else {
        toolbar.classList.remove("hidden");
        countEl.textContent = `${selected.length} selected`;
    }
}

// ===========================
// END CONTEXTUAL TOOLBAR HELPERS (LLM-assisted)
// ===========================

// responsibility: render helpers
function renderTaskRow(task) {
    const row = document.createElement("div");
    row.className = "task-row";
    row.innerHTML = `
        <span>${task.name || "-"}</span>
        <span>${formatDate(task.plannedStart)}</span>
        <span>${formatDate(task.plannedEnd)}</span>
        <span>${task.priority ?? "-"}</span>
        <span>${formatState(task.state)}</span>
        <span>${task.active ? "Yes" : "No"}</span>
        ${task.info ? `<div class="policy-info">${task.info}</div>` : ""}
        <span><input type="checkbox" class="task-select" data-id="${task.id}"></span>
    `;
    
    // LLM-assisted: Add listener to checkbox for contextual toolbar updates
    const checkbox = row.querySelector(".task-select");
    if (checkbox) {
        checkbox.addEventListener("change", updateTaskContextToolbar);
    }
    
    return row;
}

function renderResourceRow(resource) {
    const webPath = formatResourcePath(resource.resourcePath);

    const row = document.createElement("div");
    row.className = "resource-row";
    const fileName = extractFilename(resource.resourcePath);
    row.innerHTML = `
        <!-- <span class="resource-file">${fileName}</span> -->    
        <span class="resource-webpath"><a href="/${webPath}" download>${webPath}</a></span>
        <span class="resource-path">${resource.resourcePath}</span>
        <span class="resource-description">${resource.description || ""}</span>
        <span class="resource-checkbox"><input type="checkbox" class="resource-select" data-id="${resource.id}"></span>
    `;
    
    // LLM-assisted: Add listener to checkbox for contextual toolbar updates
    const checkbox = row.querySelector(".resource-select");
    if (checkbox) {
        checkbox.addEventListener("change", updateResourceContextToolbar);
    }
    
    return row;
}


function getSelectedTaskIds() {
    return Array.from(document.querySelectorAll(".task-select:checked"))
        .map(cb => cb.dataset.id)
        .filter(Boolean);
}

function getSelectedResource() {
    const selected = document.querySelectorAll(".resource-select:checked");
    if (selected.length === 0) {
        alert("Select a resource to edit.");
        return null;
    }
    if (selected.length > 1) {
        alert("Only one resource can be edited at a time.");
        return null;
    }
    const id = parseInt(selected[0].dataset.id);
    return resourcesCache.find(r => r.id === id);
}

// responsibility: load policy data
async function loadPolicy() {
    if (!policyId) {
        titleEl.textContent = "Policy";
        currentPolicy = null;
        renderPolicyRows(null);
        return;
    }
    try {
        const policy = await apiGet(`/api/edicts/${policyId}`);
        currentPolicy = policy;
        titleEl.textContent = policy.name;
        nameEl.value = policy.name || "";
        startEl.value = formatDateInput(policy.plannedStart);
        endEl.value = formatDateInput(policy.plannedEnd);
        ensureSelectHasValue(priorityEl, policy.priority);
        priorityEl.value = policy.priority ?? "";
        stateEl.value = policy.state ?? "";
        infoEl.value = policy.info ?? "";
        renderPolicyRows(currentPolicy);
    } catch (err) {
        console.error("[UI] Failed to load policy", err);
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
        taskListEl.innerHTML = "";
        tasks.forEach(task => taskListEl.appendChild(renderTaskRow(task)));
        renderPolicyRows(currentPolicy);
    } catch (err) {
        console.error("[UI] Failed to load tasks", err);
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
        resourceListEl.innerHTML = "";
        resources.forEach(resource => resourceListEl.appendChild(renderResourceRow(resource)));
        renderPolicyRows(currentPolicy);
    } catch (err) {
        console.error("[UI] Failed to load resources", err);
        resourcesCache = [];
        renderPolicyRows(currentPolicy);
    }
}

// responsibility: create policy
async function createPolicy() {
    try {
        const data = collectPolicyData();
        if (!data.plannedStart) {
            alert("Policy planned start is required.");
            return;
        }
        console.log("[Policy.save_policy] Executed: create_policy");
        const response = await fetch("/api/edicts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) {
            alert(result.message || "Failed to create policy");
            return;
        }
        console.log(`[Policy.save_policy] Completed: create_policy (id: ${result.id})`);
        alert("Policy created successfully");
        window.location.href = `/pages/policy.html?id=${result.id}`;
    } catch (err) {
        console.error("[Policy] Create failed", err);
        alert("Error creating policy");
    }
}

// responsibility: update policy
async function updatePolicy() {
    if (!policyId) {
        alert("No policy selected.");
        return;
    }
    try {
        const data = collectPolicyData();
        if (!data.plannedStart) {
            alert("Policy planned start is required.");
            return;
        }
        console.log(`[Policy.save_policy] Executed: update_policy (id: ${policyId})`);
        const response = await fetch(`/api/edicts/${policyId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) {
            alert(result.message || "Failed to update policy");
            return;
        }
        console.log(`[Policy.save_policy] Completed: update_policy (id: ${policyId})`);
        await loadPolicy();
        alert("Policy updated successfully");
    } catch (err) {
        console.error("[Policy] Update failed", err);
        alert("Error updating policy");
    }
}

// responsibility: delete policy
async function handleDelete() {
    if (!policyId) {
        alert("No policy to delete.");
        return;
    }
    const confirmDelete = confirm("Are you sure you want to delete this policy?");
    if (!confirmDelete) return;
    try {
        console.log(`[Policy.delete_policy] Executed: delete_policy (id: ${policyId})`);
        const response = await fetch(`/api/edicts/${policyId}`, { method: "DELETE" });
        if (!response.ok) {
            const result = await response.json();
            alert(result.message || "Failed to delete policy");
            return;
        }
        console.log(`[Policy.delete_policy] Completed: delete_policy (id: ${policyId})`);
        alert("Policy deleted successfully");
        window.location.href = "/index.html";
    } catch (err) {
        console.error("[Policy] Delete failed", err);
        alert("Error deleting policy");
    }
}

// responsibility: save policy (create or update)
async function handleSave() {
    if (isCreateMode) {
        await createPolicy();
    } else {
        await updatePolicy();
    }
}

// responsibility: reset task form fields
function resetTaskForm() {
    const modal = document.getElementById("task-modal");
    if (!modal) return;
    const fields = modal.querySelectorAll("input, textarea, select");
    fields.forEach(field => {
        if (field.type === "checkbox" || field.type === "radio") {
            field.checked = false;
        } else {
            field.value = "";
        }
    });
}

// responsibility: open task modal
function openTaskModal(task = null) {
    const modal = document.getElementById("task-modal");
    if (!modal) return;
    currentTaskId = task ? task.id : null;
    document.getElementById("task-name").value = task?.name ?? "";
    document.getElementById("task-start").value = formatDateInput(task?.plannedStart);
    document.getElementById("task-end").value = formatDateInput(task?.plannedEnd);
    ensureSelectHasValue(document.getElementById("task-priority"), task?.priority);
    document.getElementById("task-priority").value = task?.priority ?? "";
    document.getElementById("task-state").value = task?.state ?? 1;
    document.getElementById("task-info").value = task?.info ?? "";
    document.getElementById("task-user").value = task?.assignedToUserId ?? "";
    modal.style.display = "flex";
}

// responsibility: close task modal
function closeTaskModal() {
    const modal = document.getElementById("task-modal");
    if (!modal) return;
    modal.style.display = "none";
    resetTaskForm();
}

// responsibility: create or edit task
async function handleCreateTask() {
    if (!policyId) {
        alert("Save the policy before adding tasks.");
        return;
    }

    if (!document.getElementById("task-start").value) {
        alert("Task planned start is required.");
        return;
    }

    const payload = {
        name: document.getElementById("task-name").value,
        plannedStart: document.getElementById("task-start").value,
        plannedEnd: document.getElementById("task-end").value || null, // optional
        priority: toOptionalInt(document.getElementById("task-priority").value),
        state: toOptionalInt(document.getElementById("task-state").value),
        info: document.getElementById("task-info").value,
        assignedToUserId: toOptionalInt(document.getElementById("task-user").value),
        edictId: policyId
    };
    if (currentTaskId) {
        payload.id = currentTaskId;
        console.log(`[Policy.edit_task] Executed: edit_task (id: ${currentTaskId})`);
        console.log(`[Policy.edit_task] Completed: edit_task (id: ${currentTaskId})`); // placeholder for PUT /api/tasks/:id
    } else {
        console.log("[Policy.add_task] Executed: add_task");
        await apiPost("/api/tasks", payload);
        console.log("[Policy.add_task] Completed: add_task");
    }
    closeTaskModal();
    await loadTasks();
}

// responsibility: remove tasks
async function handleRemoveTasks() {
    const selected = getSelectedTaskIds();
    if (!selected.length) {
        alert("Select at least one task to delete.");
        return;
    }
    if (!confirm("Delete selected tasks?")) return;
    try {
        console.log(`[Policy.delete_task] Executed: delete_task (${selected.length} task(s))`);
        await Promise.all(selected.map(id => apiDelete(`/api/tasks/${id}`)));
        console.log(`[Policy.delete_task] Completed: delete_task (${selected.length} task(s) deleted)`);
        await loadTasks();
        updateTaskContextToolbar();
    } catch (err) {
        console.error("[Task] Delete failed", err);
        alert("Failed to delete selected tasks");
    }
}

// responsibility: reset resource form
function resetResourceForm() {
    const modal = document.getElementById("resource-modal");
    if (!modal) return;
    const fields = modal.querySelectorAll("input, textarea, select");
    fields.forEach(field => {
        if (field.type === "checkbox" || field.type === "radio") {
            field.checked = false;
        } else {
            field.value = "";
        }
    });
}

// responsibility: open resource modal (new)
function openResourceModal() {
    const modal = document.getElementById("resource-modal");
    if (!modal) return;
    modal.style.display = "block";
}

// responsibility: open resource modal (edit)
function openEditResource() {
    const resource = getSelectedResource();
    if (!resource) return;
    editingResourceId = resource.id;
    openResourceModal();
    resourceDescriptionInput.value = resource.description || "";
}

// responsibility: close resource modal
function closeResourceModal() {
    const modal = document.getElementById("resource-modal");
    if (!modal) return;
    modal.style.display = "none";
    resetResourceForm();
}

// responsibility: save resource (create or replace)
async function saveResource() {
    if (!policyId) return;
    const file = resourceFileInput.files[0];
    if (editingResourceId && !file) {
        alert("Please select a file when editing a resource.");
        return;
    }
    const description = resourceDescriptionInput.value || "";
    try {
        if (editingResourceId) {
            console.log(`[Policy.edit_resource] Executed: edit_resource (id: ${editingResourceId})`);
            await fetch(`/api/resources/${editingResourceId}`, { method: "DELETE" });
        } else {
            console.log("[Policy.add_resource] Executed: add_resource");
        }
        const formData = new FormData();
        formData.append("file", file);
        formData.append("edictID", policyId);
        formData.append("filesize", file.size);
        formData.append("description", description);
        const response = await fetch("/api/resources", { method: "POST", body: formData });
        if (!response.ok) throw new Error("Upload failed");
        if (editingResourceId) {
            console.log(`[Policy.edit_resource] Completed: edit_resource (id: ${editingResourceId})`);
        } else {
            console.log("[Policy.add_resource] Completed: add_resource");
        }
        editingResourceId = null;
        closeResourceModal();
        await loadResources();
    } catch (err) {
        console.error("[UI] Failed to save resource", err);
        alert("Resource save failed");
    }
}

// responsibility: delete resources
async function deleteSelectedResources() {
    const selected = document.querySelectorAll(".resource-select:checked");
    if (selected.length === 0) {
        alert("No resources selected.");
        return;
    }
    if (!confirm("Delete selected resources?")) return;
    try {
        console.log(`[Policy.delete_resource] Executed: delete_resource (${selected.length} resource(s))`);
        for (const checkbox of selected) {
            const id = checkbox.dataset.id;
            await fetch(`/api/resources/${id}`, { method: "DELETE" });
        }
        console.log(`[Policy.delete_resource] Completed: delete_resource (${selected.length} resource(s) deleted)`);
        await loadResources();
        updateResourceContextToolbar();
    } catch (err) {
        console.error("[UI] Failed to delete resources", err);
        alert("Delete failed");
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
        alert("Please select exactly one task to edit.");
        return;
    }
    const task = currentTasks.find(t => t.id == selectedIds[0]);
    if (!task) return;
    console.log(`[Policy.edit_task] Executed: edit_task (id: ${task.id})`);
    openTaskModal(task);
}

// responsibility: delete selected tasks from contextual toolbar
function handleDeleteContextTask() {
    console.log("[Policy.delete_task] Executed: delete_task");
    handleRemoveTasks();
}

// responsibility: edit selected resource from contextual toolbar
function handleEditContextResource() {
    const resource = getSelectedResource();
    if (!resource) return;
    console.log(`[Policy.edit_resource] Executed: edit_resource (id: ${resource.id})`);
    editingResourceId = resource.id;
    openResourceModal();
    resourceDescriptionInput.value = resource.description || "";
}

// responsibility: delete selected resources from contextual toolbar
function handleDeleteContextResource() {
    console.log("[Policy.delete_resource] Executed: delete_resource");
    deleteSelectedResources();
}

// ===========================\n// END CONTEXTUAL EDIT/DELETE HANDLERS (LLM-assisted)
// ===========================

// responsibility: format resource paths for display
function formatResourcePath(path) {
    if (!path) return "";
    const normalized = path.replaceAll("\\", "/");
    const resourcesIndex = normalized.indexOf("resources/");
    if (resourcesIndex !== -1) {
        return normalized.slice(resourcesIndex);
    }
    return normalized;
}



// responsibility: init page wiring
async function init() {
    configurePageMode();

    populateStateSelect(stateEl);
    populateStateSelect(document.getElementById("task-state"));
    if (isCreateMode && !stateEl.value) stateEl.value = "1";

    attachHelpPopover(document.getElementById("help-policy-name"), {
        title: "Policy name",
        body: "Use a short, descriptive title. Example: “Initial Policy” or “Follow-up Policy”."
    });

    attachHelpPopover(document.getElementById("help-task-name"), {
        title: "Task name",
        body: "Use an action-oriented title. Example: “Draft announcement copy” or “Review resources”."
    });

    bind(document.getElementById("policy-start-now"), "click", () => setDatetimeLocalNow(startEl));
    bind(document.getElementById("policy-end-now"), "click", () => setDatetimeLocalNow(endEl));
    bind(document.getElementById("policy-end-clear"), "click", () => setInputBlank(endEl));

    bind(document.getElementById("task-start-now"), "click", () => setDatetimeLocalNow(document.getElementById("task-start")));
    bind(document.getElementById("task-end-now"), "click", () => setDatetimeLocalNow(document.getElementById("task-end")));
    bind(document.getElementById("task-end-clear"), "click", () => setInputBlank(document.getElementById("task-end")));

    bind(saveBtn, "click", handleSave);
    bind(deleteBtn, "click", handleDelete);
    bind(editBtn, "click", togglePolicyEditor);

    bind(cancelTaskBtn, "click", closeTaskModal);
    bind(createTaskBtn, "click", handleCreateTask);
    bind(addTaskBtn, "click", openTaskModal);

    // LLM-assisted: New contextual toolbar bindings for tasks
    bind(document.getElementById("edit-task"), "click", handleEditContextTask);
    bind(document.getElementById("delete-task"), "click", handleDeleteContextTask);

    bind(addResourceBtn, "click", openResourceModal);
    bind(cancelResourceBtn, "click", closeResourceModal);
    bind(saveResourceBtn, "click", saveResource);

    // LLM-assisted: New contextual toolbar bindings for resources
    bind(document.getElementById("edit-resource"), "click", handleEditContextResource);
    bind(document.getElementById("delete-resource"), "click", handleDeleteContextResource);

    if (isCreateMode) {
        // Creating: show editor by default.
        setPolicyFormVisible(true);
        setFieldsEditable(true);
        renderPolicyRows(null);
        console.log("[Policy] Create mode: True");
        return;
    }

    // Viewing: load data and hide editor by default
    console.log("[Policy] View mode", policyId);
    await loadPolicy();
    await loadTasks();
    await loadResources();
    // Enable via Edit Policy button
    setPolicyFormVisible(false);
    setFieldsEditable(false);

}

function renderPolicyRows(policy) {
    if (!policyListEl) return;

    policyListEl.innerHTML = "";

    if (!policy) {
        const empty = document.createElement("div");
        empty.className = "policy-row";
        empty.textContent = isCreateMode
            ? "Policy summary will appear after save."
            : "No policy selected.";
        policyListEl.appendChild(empty);
        return;
    }

    const row = document.createElement("div");
    row.className = "policy-row";
    row.innerHTML = `
        <span>${formatDate(policy.plannedStart)}</span>
        <span>${formatDate(policy.plannedEnd)}</span>
        <span>${policy.taskCount ?? 0} / ${policy.resourceCount ?? 0}</span>
        <span>${policy.active ? "Yes" : "No"}</span>
        <span>${policy.priority ?? "-"}</span>
        <span>${formatState(policy.state)}</span>
        <span class="policy-info">${policy.info || "No description available."}</span>
    `;

    policyListEl.appendChild(row);
}


init();
