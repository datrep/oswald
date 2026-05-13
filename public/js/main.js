
import { apiGet, apiPost, apiDelete } from "./api/api.js";

//TODO:// POST /api/settings to update settings in real time. JSON file in settings.json
async function main() {
    const settings = await apiGet("/api/settings");

    console.log("Settings loaded:", settings);
    const statusStrip = document.querySelector('.status-strip');
    if (statusStrip) {
        statusStrip.style.display = settings.enableStatusStrip ? 'flex' : 'none';
    }
}

main();


