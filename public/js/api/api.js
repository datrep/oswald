// Place for API call functions (fetch) to backend routes
// please do not code fetch everywhere else
    
// api.js
// Central networking layer for all backend API calls

const API = "/api";

async function fetchJson(path, options = {}) {
    const res = await fetch(path, { cache: "no-store", ...options });
    return res.json();
}

/*
ASSUMPTION:
Backend returns JSON in the format:

[
  {
    id: 1,
    name: "Policy Name",
    startDate: "...",
    endDate: "..."
  }
]
*/

export async function getEdicts() {
    console.log("Requesting edicts...");
    return fetchJson(`${API}/edicts`);
}

export async function getEdict(id) {
    return fetchJson(`${API}/edicts/${id}`);
}

export async function createEdict(data) {
    const res = await fetchJson(`${API}/edicts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });

    return res;
}

export async function deleteEdict(id) {
    return fetch(`${API}/edicts/${id}`, {
        method: "DELETE"
    });
}

export async function getTasks() {
    return fetchJson(`${API}/tasks`);
}

export async function getTasksByEdict(id) {
    return fetchJson(`${API}/tasks/edict/${id}`);
}

export async function getResourcesByEdict(id) {
    return fetchJson(`${API}/resources/edict/${id}`);
}

export async function getAuditByEdict(id) {
    return fetchJson(`${API}/audit/edict/${id}`);
}

/*
OPTIONAL PERFORMANCE ROUTE

ASSUMPTION:
You may add backend route:

GET /api/tasks/summary

return format:

[
  { edictId: 1, taskCount: 4 },
  { edictId: 2, taskCount: 8 }
]
*/

export async function getTaskSummary() {
    return fetchJson(`${API}/tasks/summary`);
}
