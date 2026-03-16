import { apiGet } from "../api/api.js";

const params = new URLSearchParams(window.location.search);
const policyId = params.get("id");

const titleEl = document.getElementById("policy-title");

const nameEl = document.getElementById("policy-name");
const startEl = document.getElementById("policy-start");
const endEl = document.getElementById("policy-end");
const priorityEl = document.getElementById("policy-priority");
const stateEl = document.getElementById("policy-state");
const infoEl = document.getElementById("policy-info");

const taskListEl = document.getElementById("task-list");
const resourceListEl = document.getElementById("resource-list");


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


function formatState(state) {
    const labels = {
        1: "Draft",
        2: "Published",
        3: "Archived"
    };
    return labels[state] || state;
}


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


async function init() {

    await loadPolicy();
    await loadTasks();
    await loadResources();

}

init();
