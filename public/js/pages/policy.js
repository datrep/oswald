import * as api from "../api/api.js";


const params = new URLSearchParams(window.location.search);
const policyId = params.get("id");


const taskModal = document.getElementById("task-modal");
const resourceModal = document.getElementById("resource-modal");


document.getElementById("add-task").onclick = () =>
    taskModal.classList.remove("hidden");

document.getElementById("close-task").onclick = () =>
    taskModal.classList.add("hidden");


document.getElementById("add-resource").onclick = () =>
    resourceModal.classList.remove("hidden");

document.getElementById("close-resource").onclick = () =>
    resourceModal.classList.add("hidden");



document.getElementById("task-form").onsubmit = async e => {

    e.preventDefault();

    const data = Object.fromEntries(new FormData(e.target));

    data.edictId = policyId;

    /*
    ASSUMPTION:
    POST /api/tasks expects:

    {
      title,
      description,
      edictId
    }
    */

    await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });

    location.reload();

};



document.getElementById("resource-form").onsubmit = async e => {

    e.preventDefault();

    const data = Object.fromEntries(new FormData(e.target));

    data.edictId = policyId;

    /*
    ASSUMPTION:
    POST /api/resources expects:

    {
      name,
      type,
      path,
      edictId
    }
    */

    await fetch("/api/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });

    location.reload();

};



async function init() {

    const [
        policy,
        tasks,
        resources,
        audit
    ] = await Promise.all([
        api.getEdict(policyId),
        api.getTasksByEdict(policyId),
        api.getResourcesByEdict(policyId),
        api.getAuditByEdict(policyId)
    ]);

    document.getElementById("policy-title").innerText = policy.name;

}

init();