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
const policyform = document.getElementById("policy-form");

// responsibility: task/resource lists
const taskListEl = document.getElementById("task-list");
const resourceListEl = document.getElementById("resource-list");

// responsibility: task modal elements
const cancelTaskBtn = document.getElementById("cancel-task");
const createTaskBtn = document.getElementById("create-task");
const removeTaskBtn = document.getElementById("remove-task");
const addTaskBtn = document.getElementById("add-task");
const editTaskBtn = document.getElementById("edit-task");

// responsibility: resource modal elements
const addResourceBtn = document.getElementById("add-resource");
const cancelResourceBtn = document.getElementById("cancel-resource");
const removeResourceBtn = document.getElementById("remove-resource");
const editResourceBtn = document.getElementById("edit-resource");

// responsibility: misc constants
const STATE_LABELS = { 1: "Draft", 2: "Published", 3: "Archived" };

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

// responsibility: date formatting helpers
function formatDateInput(value) {
    if (!value) return "";
    const date = new Date(value);
    return date.toISOString().slice(0, 16);
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

function collectPolicyData() {
    if (!nameEl || !startEl || !endEl || !priorityEl || !stateEl || !infoEl) {
        console.error("One or more form elements are missing");
        throw new Error("Form elements not found");
    }
    return {
        name: nameEl.value,
        plannedStart: startEl.value,
        plannedEnd: endEl.value,
        priority: priorityEl.value,
        state: stateEl.value,
        info: infoEl.value
    };
}

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
        return;
    }
    try {
        const policy = await apiGet(`/api/edicts/${policyId}`);
        titleEl.textContent = policy.name;
        nameEl.value = policy.name || "";
        startEl.value = formatDateInput(policy.plannedStart);
        endEl.value = formatDateInput(policy.plannedEnd);
        priorityEl.value = policy.priority ?? "";
        stateEl.value = policy.state ?? "";
        infoEl.value = policy.info ?? "";
    } catch (err) {
        console.error("[UI] Failed to load policy", err);
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
    } catch (err) {
        console.error("[UI] Failed to load tasks", err);
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
    } catch (err) {
        console.error("[UI] Failed to load resources", err);
    }
}

// responsibility: create policy
async function createPolicy() {
    try {
        const data = collectPolicyData();
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
        const response = await fetch(`/api/edicts/${policyId}`, { method: "DELETE" });
        if (!response.ok) {
            const result = await response.json();
            alert(result.message || "Failed to delete policy");
            return;
        }
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
    document.getElementById("task-start").value = (task?.plannedStart ?? "").slice(0, 10);
    document.getElementById("task-end").value = (task?.plannedEnd ?? "").slice(0, 10);
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
    const payload = {
        name: document.getElementById("task-name").value,
        plannedStart: document.getElementById("task-start").value,
        plannedEnd: document.getElementById("task-end").value,
        priority: document.getElementById("task-priority").value,
        state: document.getElementById("task-state").value,
        info: document.getElementById("task-info").value,
        assignedToUserId: document.getElementById("task-user").value,
        edictId: policyId
    };
    if (currentTaskId) {
        payload.id = currentTaskId;
        console.log("EDIT TASK", payload); // placeholder for PUT /api/tasks/:id
    } else {
        await apiPost("/api/tasks", payload);
    }
    closeTaskModal();
    loadTasks();
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
        await Promise.all(selected.map(id => apiDelete(`/api/tasks/${id}`)));
        await loadTasks();
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
            await fetch(`/api/resources/${editingResourceId}`, { method: "DELETE" });
        }
        const formData = new FormData();
        formData.append("file", file);
        formData.append("edictID", policyId);
        formData.append("filesize", file.size);
        formData.append("description", description);
        const response = await fetch("/api/resources", { method: "POST", body: formData });
        if (!response.ok) throw new Error("Upload failed");
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
        for (const checkbox of selected) {
            const id = checkbox.dataset.id;
            await fetch(`/api/resources/${id}`, { method: "DELETE" });
        }
        await loadResources();
    } catch (err) {
        console.error("[UI] Failed to delete resources", err);
        alert("Delete failed");
    }
}

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

    bind(saveBtn, "click", handleSave);
    bind(deleteBtn, "click", handleDelete);

    bind(cancelTaskBtn, "click", closeTaskModal);
    bind(createTaskBtn, "click", handleCreateTask);
    bind(removeTaskBtn, "click", handleRemoveTasks);
    bind(addTaskBtn, "click", openTaskModal);
    bind(editTaskBtn, "click", () => {
        const selectedIds = getSelectedTaskIds();
        if (selectedIds.length !== 1) {
            alert("Please select exactly one task to edit.");
            return;
        }
        const task = currentTasks.find(t => t.id == selectedIds[0]);
        if (!task) return;
        openTaskModal(task);
    });

    bind(addResourceBtn, "click", openResourceModal);
    bind(cancelResourceBtn, "click", closeResourceModal);
    bind(saveResourceBtn, "click", saveResource);
    bind(removeResourceBtn, "click", deleteSelectedResources);
    bind(editResourceBtn, "click", openEditResource);

    if (isCreateMode) {
        console.log("[Policy] Create mode");
        return;
    }

    console.log("[Policy] View mode", policyId);
    await loadPolicy();
    await loadTasks();
    await loadResources();
}

init();
