// edictID on SQL is broken, pls fix. TODO://

import { apiGet, apiPost, apiDelete } from "../api/api.js";

const params = new URLSearchParams(window.location.search);
const policyId = params.get("id");
const isCreateMode = !policyId; 

// unused elements from index page - will be used to show counts on policy cards TODO://
const edictId = parseInt(policyId);

let currentTasks = [];

// auto gen Elements
const titleEl = document.getElementById("policy-title");
const nameEl = document.getElementById("policy-name");
const startEl = document.getElementById("policy-start");
const endEl = document.getElementById("policy-end");
const priorityEl = document.getElementById("policy-priority");
const stateEl = document.getElementById("policy-state");
const infoEl = document.getElementById("policy-info");


// Policybutton elements
const saveBtn = document.getElementById("save-policy");
const deleteBtn = document.getElementById("delete-policy");
const editBtn = document.getElementById("edit-policy");

// unused form element - will be used to hide form on policy.html?id
const policyform = document.getElementById("policy-form"); 

// Task and Resource lists
const taskListEl = document.getElementById("task-list");
const resourceListEl = document.getElementById("resource-list");

// Task modal elements
// Guard the bindings and modal logic so they only run when the modal markup exists.
const cancelTaskBtn = document.getElementById("cancel-task");
if (cancelTaskBtn) {
    cancelTaskBtn.addEventListener("click", closeTaskModal);
}
// The create task button is inside the modal, so only bind if it exists
const createTaskBtn = document.getElementById("create-task");
if (createTaskBtn) {
    createTaskBtn.addEventListener("click", handleCreateTask);
} // this looks... bad, but modal logic would be tightly coupled to the create task button, so we need to guard it like this. TODO:// standardise modal logic across pages to avoid this kind of thing

const removeTaskBtn = document.getElementById("remove-task");
if (removeTaskBtn) {
    removeTaskBtn.addEventListener("click", handleRemoveTasks);
}

const addTaskBtn = document.getElementById("add-task");
if (addTaskBtn) {
    addTaskBtn.addEventListener("click", openTaskModal);
}

const editTaskBtn = document.getElementById("edit-task");
// page mode configuration
function configurePageMode() {

    // Show/hide buttons based on mode
    const show = (el, visible) => { //element, visible
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

function setFieldsEditable(enabled) {

    nameEl.disabled = !enabled;
    startEl.disabled = !enabled;
    endEl.disabled = !enabled;
    priorityEl.disabled = !enabled;
    stateEl.disabled = !enabled;
    infoEl.disabled = !enabled;

}

// formatting helpers

function formatDateInput(value) {
    if (!value) return "";
    const date = new Date(value);
    return date.toISOString().slice(0,16);
}

function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    return date.toLocaleDateString();
}

// Map state num to labels

function formatState(state) {
    const labels = {
        1: "Draft",
        2: "Published",
        3: "Archived"
    };
    return labels[state] || state;
}

// GET

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

async function loadTasks() {

    if (!policyId) return;

    try {

        const tasks = await apiGet(`/api/tasks/edict/${policyId}`);
        currentTasks = tasks;

        taskListEl.innerHTML = "";

        tasks.forEach(task => {

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

            taskListEl.appendChild(row);

        });

    } catch (err) {
        console.error("[UI] Failed to load tasks", err);
    }

}

async function loadResources() {

    if (!policyId) return;

    try {

        const resources = await apiGet(`/api/resources/edict/${policyId}`);

        resourceListEl.innerHTML = "";

        resources.forEach(resource => {

            const row = document.createElement("div");
            row.className = "resource-row";

            row.innerHTML = `
                <span>${resource.resourcePath}</span>
                <span>${resource.description || ""}</span>
            `;

            resourceListEl.appendChild(row);

        });

    } catch (err) {
        console.error("[UI] Failed to load resources", err);
    }

}



// POST

// log
const data = collectPolicyData();
console.log("POST DATA:", JSON.stringify(data));

async function createPolicy() {

    try {

        const data = collectPolicyData();

        const response = await fetch("/api/edicts", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (!response.ok) {
            alert(result.message || "Failed to create policy");
            return;
        }

        const newId = result.id;

        alert("Policy created successfully");

        window.location.href = `/pages/policy.html?id=${newId}`;

    } catch (err) {

        console.error("[Policy] Create failed", err);
        alert("Error creating policy");

    }

}

async function updatePolicy() {

    if (!policyId) {
        alert("No policy selected.");
        return;
    }

    try {

        const data = collectPolicyData();

        const response = await fetch(`/api/edicts/${policyId}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (!response.ok) {
            alert(result.message || "Failed to update policy");
            return;
        }
   
        // Refresh data on page after update
            await
        loadPolicy();
        alert("Policy updated successfully");

    } catch (err) {

        console.error("[Policy] Update failed", err);
        alert("Error updating policy");

    }

}

// Render list of policies on index page
 function collectPolicyData() {
    
    console.log("POST DATA:", JSON.stringify({
        name: nameEl.value,
        plannedStart: startEl.value,
        plannedEnd: endEl.value,
        priority: priorityEl.value,
        state: stateEl.value,
        info: infoEl.value
    }));
    
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

// Button handlers

async function handleSave() {

    if (isCreateMode) {
        await createPolicy();
    } else {
        await updatePolicy();
    }

}
saveBtn.addEventListener("click", handleSave);


async function handleDelete() {

    if (!policyId) {
        alert("No policy to delete.");
        return;
    }

    const confirmDelete = confirm("Are you sure you want to delete this policy?");

    if (!confirmDelete) {
        return;
    }

    try {

        const response = await fetch(`/api/edicts/${policyId}`, {
            method: "DELETE"
        });

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
// tasks
let currentTaskId = null; // tracks which task is being edited

// Create / Save
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
        // TODO: call PUT /api/tasks/:id
        console.log("EDIT TASK", payload);
    } else {
        await apiPost("/api/tasks", payload);
    }

    closeTaskModal();
    loadTasks(); // reload to reflect changes
}

async function handleRemoveTasks() {

    const selected = Array.from(document.querySelectorAll(".task-select:checked"))
        .map(cb => cb.dataset.id)
        .filter(Boolean);

    if (!selected.length) {
        alert("Select at least one task to delete.");
        return;
    }

    const confirmDelete = confirm("Delete selected tasks?");

    if (!confirmDelete) {
        return;
    }

    try {

        await Promise.all(selected.map(id => apiDelete(`/api/tasks/${id}`)));

        await loadTasks();

    } catch (err) {

        console.error("[Task] Delete failed", err);
        alert("Failed to delete selected tasks");

    }

}

// deletebtn POLICY, PLS FIX. TODO://
// the js file needs to be standardised to not have this misinterpretation anyway
deleteBtn.addEventListener("click", handleDelete);

function resetTaskForm() {

    const modal = document.getElementById("task-modal");

    if (!modal) return;

    const fields = modal.querySelectorAll("input, textarea, select");

    fields.forEach(field => {
        if (field.type === "checkbox" || field.type === "radio") {
            field.checked = false;
            return;
        }
        field.value = "";
    });

}
// uhh... closeTaskModal handleCreateTask readds the delete and create POLICY. TODO:// why? 
function openTaskModal(task = null) {
    const modal = document.getElementById("task-modal");
    if (!modal) return;

    // Populate fields if editing
    if (currentTaskId = task?.id || null) {
        document.getElementById("task-name").value = task.name ?? "";
        document.getElementById("task-start").value = (task.plannedStart ?? "").slice(0, 10);
        document.getElementById("task-end").value = (task.plannedEnd ?? "").slice(0, 10);
        document.getElementById("task-priority").value = task.priority ?? "";
        document.getElementById("task-state").value = task.state ?? 1;
        document.getElementById("task-info").value = task.info ?? "";
        document.getElementById("task-user").value = task.assignedToUserId ?? "";
    } else {
        // Clear fields if adding new task
        document.getElementById("task-name").value = "";
        document.getElementById("task-start").value = "";
        document.getElementById("task-end").value = "";
        document.getElementById("task-priority").value = "";
        document.getElementById("task-state").value = 1;
        document.getElementById("task-info").value = "";
        document.getElementById("task-user").value = "";
    }

    modal.style.display = "flex";
}

function closeTaskModal() {

    const modal = document.getElementById("task-modal");
    if (!modal) return;
    modal.style.display = "none";
    resetTaskForm();

}

// Edit button click
editTaskBtn.addEventListener("click", () => {
    const selected = document.querySelectorAll(".task-select:checked");

    if (selected.length !== 1) {
        alert("Please select exactly one task to edit.");
        return;
    }
    const taskId = selected[0].dataset.id;
    const task = currentTasks.find(t => t.id == taskId); // `currentTasks` must be the loaded tasks array
    if (!task) return;
    openTaskModal(task);
});




// Initialize page
async function init() {

    configurePageMode();
    
    // If no policyId, we are in create mode - just show empty form
    if (isCreateMode) {
        console.log("[Policy] Create mode");
        
        return;
    }

    console.log("[Policy] View mode", policyId);

    // pull from api and render
    await loadPolicy();
    await loadTasks();
    await loadResources();

}

init();
