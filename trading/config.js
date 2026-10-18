// trading/config.js — live config loader for the Oswald trading service (listings/expenses pattern).
// Reads trading/config.json on every call + overlays environment overrides.
const path = require('path');
const { loadEnv, readJsonFile } = require('../shared/config');

loadEnv();

function readBase() {
  return readJsonFile(path.join(__dirname, 'config.json'));
}

function overlayEnv(c) {
  const o = { ...c, browser: { ...(c.browser || {}) } };
  const e = process.env;
  if (e.TRADING_PORT) o.port = Number(e.TRADING_PORT);
  if (e.TRADING_HOST) o.host = e.TRADING_HOST;
  if (e.TRADING_DASHBOARD_BASE) o.dashboardBase = e.TRADING_DASHBOARD_BASE;
  if (e.TRADING_TLS === '0') o.tls = { ...(o.tls || {}), enabled: false };
  if (e.TRADING_BROWSER_EXE) o.browser.executable = e.TRADING_BROWSER_EXE;
  if (e.TRADING_BROWSER_PROFILE) o.browser.profileDir = e.TRADING_BROWSER_PROFILE;
  if (e.TRADING_BROWSER_PORT) o.browser.debugPort = Number(e.TRADING_BROWSER_PORT);
  return o;
}

function getConfig() {
  return overlayEnv(readBase());
}

module.exports = { getConfig };
