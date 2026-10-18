// config.js — live config loader for the Oswald listings service (fileserver pattern).
// Reads listings/config.json on every call + overlays environment overrides.
const path = require('path');
const { loadEnv, readJsonFile } = require('../shared/config');

loadEnv();

function readBase() {
  return readJsonFile(path.join(__dirname, 'config.json'));
}

function overlayEnv(c) {
  const o = { ...c };
  const e = process.env;
  if (e.LISTINGS_PORT) o.port = Number(e.LISTINGS_PORT);
  if (e.LISTINGS_HOST) o.host = e.LISTINGS_HOST;
  if (e.LISTINGS_DASHBOARD_BASE) o.dashboardBase = e.LISTINGS_DASHBOARD_BASE;
  if (e.LISTINGS_TLS === '0') o.tls = { ...(o.tls || {}), enabled: false };
  return o;
}

function getConfig() {
  return overlayEnv(readBase());
}

module.exports = { getConfig };
