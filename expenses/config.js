// config.js — live config loader for the Oswald expenses service (listings pattern).
// Reads expenses/config.json on every call + overlays environment overrides.
const path = require('path');
const { loadEnv, readJsonFile } = require('../shared/config');

loadEnv();

function readBase() {
  return readJsonFile(path.join(__dirname, 'config.json'));
}

function overlayEnv(c) {
  const o = { ...c };
  const e = process.env;
  if (e.EXPENSES_PORT) o.port = Number(e.EXPENSES_PORT);
  if (e.EXPENSES_HOST) o.host = e.EXPENSES_HOST;
  if (e.EXPENSES_DASHBOARD_BASE) o.dashboardBase = e.EXPENSES_DASHBOARD_BASE;
  if (e.EXPENSES_TLS === '0') o.tls = { ...(o.tls || {}), enabled: false };
  return o;
}

function getConfig() {
  return overlayEnv(readBase());
}

module.exports = { getConfig };
