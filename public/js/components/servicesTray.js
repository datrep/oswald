import { apiGet } from "../api/api.js";

// Services Tray Component
const servicesList =
    document.getElementById("services-list");
const servicesToggle =
    document.getElementById("services-toggle");
const addButton =
    document.getElementById("service-add-button");
const addForm =
    document.getElementById("service-add-form");



servicesToggle.addEventListener("click", () => {

    servicesList.classList.toggle("services-menu"); 
});


addButton.addEventListener("click", () => {

    addForm.classList.toggle("hidden");

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