// main page script
// index.js purpose to display all policies, and links to their individual pages

// api/api.js
import { apiGet } from "../api/api.js";

const policyCountEl = document.getElementById("policy-count");
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
    policyListEl.innerHTML = "";
    policyCountEl.textContent = `Showing ${edicts.length} polic${edicts.length === 1 ? "y" : "ies"}`;

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
                apiGet(`/api/tasks/edict/${edict.id}`),
                apiGet(`/api/resources/edict/${edict.id}`)
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
        const row = document.createElement("div");
        row.className = "policy-row";
        row.style.cursor = "pointer";

        // Include description inside the same row, below the main info
        //policy-row not congruent with policy-main?
        row.innerHTML = `\
                <span>${edict.name || "-"}</span>
                <span>${formatDate(edict.plannedStart)}</span>
                <span>${formatDate(edict.plannedEnd)}</span>
                <span>${tasksMap[edict.id]} / ${resourcesMap[edict.id]}</span>
                <span>${edict.active ? "Yes" : "No"}</span>
                <span>${edict.priority ?? "-"}</span>
                <span>${formatState(edict.state)}</span>
            ${edict.info ? `<div class="policy-info">Description: ${edict.info}</div>` : ""}
        `;

        // Make row clickable
        row.addEventListener("click", () => {
            window.location.href = `/pages/policy.html?id=${edict.id}`;
        });

        policyListEl.appendChild(row);
    });
}

async function initPolicies() {
    try {
        const edicts = await apiGet("/api/edicts");
        // Sort newest first (by createdAt)
        edicts.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
        renderPolicies(edicts);
    } catch (err) {
        console.error("[UI] Failed to load policies", err);
        policyCountEl.textContent = "Unable to load policies.";
    }
}

// Add policy button listener
document.getElementById("add-policy")?.addEventListener("click", () => {
    window.location.href = "/pages/policy.html";
});

initPolicies();  