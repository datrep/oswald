// main page script
// index.js purpose to display all policies, and links to their individual pages

import { apiGet } from "../api/api.js";

const policyCountEl = document.getElementById("policy-count");
const policyHeaderEl = document.querySelector(".policy-header");
const policyListEl = document.getElementById("policy-list");

function formatDate(value) {
    if (!value) return "-";
    try {
        const date = new Date(value);
        return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch {
        return value;
    }
}

function formatState(state) {
    if (state === null || state === undefined) return "-";
    const stateLabels = { 1: "Draft", 2: "Published", 3: "Archived" };
    return stateLabels[state] || `State ${state}`;
}

// Render all policies
async function renderPolicies(edicts) {

    if (policyHeaderEl && policyCountEl) {
        policyHeaderEl.parentElement?.insertBefore(policyCountEl, policyHeaderEl);
    }
    policyCountEl.textContent = `Showing ${edicts.length} polic${edicts.length === 1 ? "y" : "ies"}`;

    policyListEl.innerHTML = "";


    if (edicts.length === 0) {
        const empty = document.createElement("div");
        empty.className = "policy-row";
        empty.textContent = "No policies available";
        policyListEl.appendChild(empty);
        return;
    }

    // Preload tasks & resources in parallel for all policies
    const tasksMap = {};
    const resourcesMap = {};

    await Promise.all(edicts.map(async (edict) => {
        try {
            const [tasks, resources] = await Promise.all([
                apiGet(`/tasks/edict/${edict.id}`),
                apiGet(`/resources/edict/${edict.id}`)
            ]);
            tasksMap[edict.id] = tasks.length;
            resourcesMap[edict.id] = resources.length;
        } catch (err) {
            console.warn(`[UI] Failed to load tasks/resources for edict ${edict.id}`, err);
            tasksMap[edict.id] = 0;
            resourcesMap[edict.id] = 0;
        }
    }));

    edicts.forEach((edict) => {
        // Main row
        const row = document.createElement("div");
        row.className = "policy-row";
        row.innerHTML = `
            <span>${edict.name || "-"}</span>
            <span>${formatDate(edict.plannedStart)}</span>
            <span>${formatDate(edict.plannedEnd)}</span>
            <span>${tasksMap[edict.id]} / ${resourcesMap[edict.id]}</span>
            <span>${edict.active ? "Yes" : "No"}</span>
            <span>${edict.priority ?? "-"}</span>
            <span>${formatState(edict.state)}</span>
        `;

        // Make row clickable
        row.style.cursor = "pointer";
        row.addEventListener("click", () => {
            window.location.href = `/pages/policy.html?id=${edict.id}`;
        });

        policyListEl.appendChild(row);

        // Add description inline inside the same row
        row.innerHTML += edict.info 
        ? `<div class="policy-info">Description: ${edict.info}</div>` : "";
    });
}

async function initPolicies() {
    try {
        const edicts = await apiGet("/edicts");
        // Sort newest first (by createdAt)
        edicts.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
        renderPolicies(edicts);
    } catch (err) {
        console.error("[UI] Failed to load policies", err);
        policyCountEl.textContent = "Unable to load policies.";
    }
}

const addPolicyButton = document.getElementById("add-policy");
const addPolicyForm = document.getElementById("add-policy-form");
const cancelAddPolicyButton = document.getElementById("cancel-add-policy");
const addPolicyFeedback = document.getElementById("add-policy-feedback");

const showAddPolicyForm = () => {
    addPolicyForm?.classList.remove("hidden");
    addPolicyFeedback?.classList.add("hidden");
    addPolicyForm?.querySelector("input")?.focus();
};

const hideAddPolicyForm = () => {
    if (!addPolicyForm) return;
    addPolicyForm.classList.add("hidden");
    addPolicyForm.reset();
    addPolicyFeedback?.classList.add("hidden");
};

addPolicyButton?.addEventListener("click", showAddPolicyForm);
cancelAddPolicyButton?.addEventListener("click", hideAddPolicyForm);

addPolicyForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(addPolicyForm);
    const payload = {
        name: formData.get("policyName")?.toString().trim(),
        plannedStart: formData.get("policyStart")?.toString(),
        plannedEnd: formData.get("policyEnd")?.toString(),
    };
    addPolicyFeedback.textContent = `Captured ${payload.name || "policy"} dates (mock save).`;
    addPolicyFeedback?.classList.remove("hidden");
    setTimeout(hideAddPolicyForm, 1200);
});

initPolicies();
