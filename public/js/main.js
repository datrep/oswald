
import { apiGet, apiPost, apiDelete } from "./api/api.js";

async function main() {
    const settings = await apiGet("/api/settings");

    console.log("Settings loaded:", settings);
    const statusStrip = document.querySelector('.status-strip');
    if (statusStrip) {
        statusStrip.style.display = settings.enableStatusStrip ? 'flex' : 'none';
    }
}

main();


