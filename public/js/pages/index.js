// main page script
// index.js purpose to display all policies, and links to their individual pages

import { apiGet } from "../api/api.js";

const edicts = await apiGet("/edicts");