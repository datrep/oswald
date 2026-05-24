import { apiGet, apiPost } from "../api/api.js"; // Helper function to make GET requests to the API

// Services Tray Component
const servicesList =
    document.getElementById("services-list");
const servicesToggle =
    document.getElementById("services-toggle");
const addButton =
    document.getElementById("service-add-button");
const addForm =
    document.getElementById("service-add-form");

// form elements
const saveServiceButton =
    document.getElementById("save-service-button");

const serviceNameInput =
    document.getElementById("service-name");

const serviceTypeInput =
    document.getElementById("service-type");

const serviceTargetInput =
    document.getElementById("service-target");

const serviceIconInput =
    document.getElementById("service-icon");



servicesToggle.addEventListener("click", () => {

    servicesList.classList.toggle("services-menu"); 
});
addButton.addEventListener("click", () => {

    addForm.classList.toggle("hidden");

});



saveServiceButton.addEventListener("click", async () => {
    try {
        const serviceData = {
            name: serviceNameInput.value,
            type: serviceTypeInput.value,
            target: serviceTargetInput.value,
            iconPath: serviceIconInput.value,
            description: "", // You can add a description field to the form if needed
            enabled: true, // Default to enabled
            sortOrder: 0 // Default sort order, you can modify this as needed
        };
        await apiPost("/api/services", serviceData);

        await loadServices(); // Refresh the services list after adding a new service

        // Clear form inputs
        serviceNameInput.value = "";
        serviceTypeInput.value = "";
        serviceTargetInput.value = "";
        serviceIconInput.value = "";

        addForm.classList.add("hidden"); // Hide the form after saving

        serviceNameInput.value = "";
        serviceTargetInput.value = "";
        serviceIconInput.value = "";
    } catch (err) {
        console.error("[ServicesTray] Failed to save service", err);
    }
});

    


// servicesList
function renderServices(services) {

    // clear existing services
    servicesList.innerHTML = "";

    services.forEach((service) => {

        const item = document.createElement("a");

        item.className = "service-item";

        item.href = service.target;

        item.target = "_blank";

        item.innerHTML = `
            <img
                class="service-icon"
                src="${service.iconPath}"
                alt="${service.name}"
            >

            <span>${service.name}</span>
        `;

        servicesList.appendChild(item);

    });

}


async function loadServices() {

    try {

        const services =
            await apiGet("/api/services");

        renderServices(services);

    } catch (err) {

        console.error(
            "[ServicesTray] Failed to load services",
            err
        );

    }

}


loadServices();
console.log("[ServicesTray] loaded");