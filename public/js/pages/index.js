// main page script
// index.js purpose to display all policies, and links to their individual pages

// api/api.js
import { apiGet } from "../api/api.js";

const policyCountEl = document.getElementById("policy-count");
const policyListEl = document.getElementById("policy-list");

let edictsCache = [];
let globalSettings = null;

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
            console.error("Failed to load settings", err);
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
let sortKey = "createdAt";
let sortDir = "desc"; // "asc" | "desc"

// ===========================
// HELP POPOVERS (LLM-assisted)
// Purpose: add a reusable "?" button popover pattern for inline field help (no hover required).
// Notes: this block was implemented with LLM assistance and then adapted to the existing codebase.
//
// How to reuse:
// - Add a button element with class `help-btn` and a stable id (e.g. `help-foo`).
// - Call `attachHelpPopover(document.getElementById("help-foo"), { title, body })`.
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

function normalizeSortDir(dir) {
    return dir === "asc" ? "asc" : "desc";
}

function isSortableDateKey(key) {
    return key === "plannedStart" || key === "plannedEnd" || key === "createdAt";
}

function isSortableNumberKey(key) {
    return key === "taskCount" || key === "resourceCount" || key === "priority" || key === "state" || key === "active";
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
    const direction = normalizeSortDir(dir) === "asc" ? 1 : -1;

    return (a, b) => {
        let aValue = a?.[key];
        let bValue = b?.[key];

        // Treat empty strings as null for sorting.
        if (aValue === "") aValue = null;
        if (bValue === "") bValue = null;

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

        if (typeof aValue === "number" && typeof bValue === "number") {
            if (aValue === bValue) return 0;
            return aValue < bValue ? -1 * direction : 1 * direction;
        }

        const result = String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: "base" });
        return result * direction;
        
    };
}

function applySortAndRender() {
    const sorted = [...edictsCache];

    // If the user clicks "Tasks", use resources as a secondary tie-breaker so the column feels stable.
    if (sortKey === "taskCount") {
        const primary = makeComparator("taskCount", sortDir);
        const secondary = makeComparator("resourceCount", sortDir);
        const byName = makeComparator("name", "asc");
        sorted.sort((a, b) => primary(a, b) || secondary(a, b) || byName(a, b));
    } else {
        const primary = makeComparator(sortKey, sortDir);
        const byName = makeComparator("name", "asc");
        sorted.sort((a, b) => primary(a, b) || byName(a, b));
    }

    renderPolicyRows(sorted);
    updateSortIndicatorsSafe();
}

function updateSortIndicatorsSafe() {
    const header = document.querySelector(".policy-header");
    if (!header) return;
    const spans = [...header.querySelectorAll("span[data-sort]")];

    spans.forEach((span) => {
        const key = span.dataset.sort;
        const baseLabel = span.dataset.baseLabel || span.textContent.replace(/\s*[^A-Za-z0-9]+$/, "").trim();
        span.dataset.baseLabel = baseLabel;

        const isSorted = key === sortKey;
        span.classList.toggle("sorted", isSorted);
        span.textContent = isSorted ? `${baseLabel} ${sortDir === "asc" ? "\u2191" : "\u2193"}` : baseLabel;
    });
}

function updateSortIndicators() {
    const header = document.querySelector(".policy-header");
    if (!header) return;
    const spans = [...header.querySelectorAll("span[data-sort]")];

    spans.forEach((span) => {
        const key = span.dataset.sort;
        const baseLabel = span.dataset.baseLabel || span.textContent.replace(/[↑↓]\s*$/, "").trim();
        span.dataset.baseLabel = baseLabel;

        const isSorted = key === sortKey;
        span.classList.toggle("sorted", isSorted);
        span.textContent = isSorted ? `${baseLabel} ${sortDir === "asc" ? "↑" : "↓"}` : baseLabel;
    });
}

function setupSortHeader() {
    const header = document.querySelector(".policy-header");
    if (!header) return;
    const spans = [...header.querySelectorAll("span[data-sort]")];

    spans.forEach((span) => {
        span.tabIndex = 0;
        span.addEventListener("click", () => {
            const key = span.dataset.sort;
            if (!key) return;
            if (sortKey === key) {
                sortDir = sortDir === "asc" ? "desc" : "asc";
            } else {
                sortKey = key;
                sortDir = "asc";
            }
            applySortAndRender();
        });

        span.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            span.click();
        });
    });
}

function formatipstatus(status) {
    if (status === null || status === undefined) return "-";
    const statusLabels = { active: "Active", slow: "Slow", inactive: "Inactive" };
    return statusLabels[status] || status;
}


// Render all policies (already enriched with counts)
function renderPolicyRows(edicts) {
    policyListEl.innerHTML = "";
    policyCountEl.textContent = `Showing ${edicts.length} polic${edicts.length === 1 ? "y" : "ies"}`;

    if (edicts.length === 0) {
        const empty = document.createElement("div");
        empty.className = "policy-row";
        empty.textContent = "No policies available";
        policyListEl.appendChild(empty);
        return;
    }

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
                <span>${edict.taskCount ?? 0} / ${edict.resourceCount ?? 0}</span>
                <span>${edict.active ? "Yes" : "No"}</span>
                <span>${edict.priority ?? "-"}</span>
                <span>${formatState(edict.state)}</span>
                <span class="policy-info">${edict.info || "No description available. check database."}</span>
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

        // Preload tasks & resources in parallel for all policies (so "Tasks" sorting works locally).
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

        edictsCache = edicts.map((edict) => ({
            ...edict,
            taskCount: tasksMap[edict.id] ?? 0,
            resourceCount: resourcesMap[edict.id] ?? 0
        }));

        setupSortHeader();
        applySortAndRender();
    } catch (err) {
        console.error("[UI] Failed to load policies", err);
        policyCountEl.textContent = "Unable to load policies.";
    }
}

function renderipstatus() {
    // Deprecated placeholder; real rendering done by `renderIPResults(results)`.
}

async function fetchIPStatuses() {
    const settings = await loadSettings();
    if (!settings.enableStatusStrip) {
        const strip = document.querySelector('.status-strip');
        if (strip) strip.style.display = 'none';
        return;
    }
    try {
        const resp = await apiGet('/api/ip/check');
        if (!resp || !resp.ok) {
            console.warn('[IP] bad response', resp);
            renderIPResults([]);
            return;
        }
        renderIPResults(resp.results || []);
    } catch (err) {
        console.error('[IP] Failed to fetch statuses', err);
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

    results.forEach(r => {
        const item = document.createElement('div');
        item.className = 'status-item';
        item.title = r.ip + (r.time ? ` responded in ${r.time}ms` : '') + (r.error ? `, error: ${r.error}` : ''); // tooltip for more info

        const dot = document.createElement('span');
        dot.className = 'status-dot';
        // choose visual class
        if (r.alive) dot.classList.add('online');
        else if (r.time && Number(r.time) > 1000) dot.classList.add('warning');
        else dot.classList.add('offline');

        const label = document.createElement('span');
        label.textContent = r.ip + (r.time ? ` (${r.time}ms)` : '');

        item.appendChild(dot);
        item.appendChild(label);
        strip.appendChild(item);
    });
}

// Initial fetch and periodic polling
fetchIPStatuses();
setInterval(fetchIPStatuses, 5000); // refresh every 5s


// Add policy button listener
document.getElementById("add-policy")?.addEventListener("click", () => {
    window.location.href = "/pages/policy.html";
});

attachHelpPopover(document.getElementById("help-add-policy-name"), {
    title: "Policy name",
    body: "Use a short, descriptive title. Example: “Initial Policy” or “Follow-up Policy”."
});

initPolicies();  
