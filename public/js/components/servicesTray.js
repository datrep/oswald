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

    
function getServiceIcon(service) {
    // Priority: 1. Custom icon path (if provided), 2. Google favicon, 3. Fallback
    if (service.iconPath && service.iconPath.startsWith("http")) {
        return service.iconPath; // Use remote icons directly if valid HTTP/HTTPS
    }

    try {
        const url = new URL(service.target);
        const domain = url.hostname.replace(/^www\./, ''); // Remove 'www.' prefix

        // Google's favicon API supports sizes (16, 32, 48)
        return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
    } catch (err) {
        console.warn("[ServicesTray] Invalid URL for service target:", service.target);
        return "/assets/icons/default.png"; // Fallback
    }
}

// servicesList
function renderServices(services) {
    servicesList.innerHTML = "";

    services.forEach((service) => {
        const item = document.createElement("a");
        item.className = "service-item";
        item.href = service.target;
        item.target = "_blank";

        // Use dynamic favicon logic
        const iconSrc = getServiceIcon(service);

        item.innerHTML = `
            <img
                class="service-icon"
                src="${iconSrc}"
                alt="${service.name}"
                onerror="this.src='/assets/icons/default.png'"
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