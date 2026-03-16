// main page script
// index.js purpose to display all policies, and links to their individual pages

// api/api.js
import * as api from "../api/api.js";

const modal = document.getElementById("policy-modal");
const addBtn = document.getElementById("add-policy");
const closeBtn = document.getElementById("close-policy-modal");
const form = document.getElementById("policy-form");

addBtn.onclick = () => modal.classList.remove("hidden");

closeBtn.onclick = () => modal.classList.add("hidden");


form.onsubmit = async (e) => {

    e.preventDefault();

    const data = Object.fromEntries(new FormData(form));

    /*
    ASSUMPTION:
    POST /api/edicts expects
    {
        name,
        startDate,
        endDate
    }
    */

    await api.createEdict(data);

    modal.classList.add("hidden");

    init(); // reload dashboard

};

async function init() {

    try {

        const [edicts, tasks] = await Promise.all([ // sample rows can be found in sql/DB_init_table.sql
            api.getEdicts(),
            api.getTasks()
        ]);

        // Keep a reference to the raw payload so you can inspect every column in the browser (matches the SQL sample data above).
        window.__oswaldRawEdicts = edicts;
        window.__oswaldRawTasks = tasks;
        console.group("Raw edicts table payload");
        console.log(edicts);
        console.groupEnd();
        console.group("Raw tasks table payload");
        console.log(tasks);
        console.groupEnd();

        renderPolicies(edicts, tasks);

    } catch (err) {

        console.error("Failed to load policies:", err);

    }

}

function renderPolicies(edicts, tasks) {

    const container = document.getElementById("policy-list");

    container.innerHTML = "";

    edicts.forEach(e => {

        const policyTasks = tasks.filter(t => t.edictId === e.id);

        /*
        ASSUMPTION:
        task table includes:
        status field
        status = "completed" when finished
        */

        const completed = policyTasks.filter(t => t.status === "completed").length;

        const row = document.createElement("div");

        row.className = "policy-row";

        row.innerHTML = `
            <span>${e.name}</span>
            <span>${e.startDate || "-"}</span>
            <span>${e.endDate || "-"}</span>
            <span>${policyTasks.length}</span>
            <span>${completed}</span>
            <span>-</span>
        `;

        row.onclick = () => {

            window.location.href = `/policy.html?id=${e.id}`;

        };

        container.appendChild(row);

    });

}

init();
