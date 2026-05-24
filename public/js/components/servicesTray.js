import { apiGet } from "../api/api.js";

const servicesMenu =
    document.getElementById("services-menu");

const servicesToggle =
    document.getElementById("services-toggle");


servicesToggle.addEventListener("click", () => {

    servicesMenu.classList.toggle("hidden"); 
});

function renderServices(services) {

    servicesMenu.innerHTML = "";

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

        servicesMenu.appendChild(item);

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
