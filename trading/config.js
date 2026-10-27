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
  // ★ 2026-10-27 — THE HEALTH PORT IS NOW OVERRIDABLE, AND THAT IS WHAT MAKES THE SMOKE SUITE RUNNABLE.
  // `server.js` refuses to boot when something already answers /healthz on this port (desk-singleton-guard), and it
  // hard-coded 8115 — the port the LIVE desk is on. So `npm test` could never run while the desk was up: the smoke
  // child probed 8115, found the real desk, and exited 3. It failed for a reason that said nothing about the code,
  // which is why it was never part of the protocol and nobody noticed.
  // ⚠ THE GUARD ITSELF IS UNCHANGED — it still asks "is another desk on MY health port?". The smoke run now HAS its
  // own port, so the answer is correctly "no". No bypass flag, nothing to forget to unset.
  if (e.TRADING_HEALTH_PORT) o.tls = { ...(o.tls || {}), healthPort: Number(e.TRADING_HEALTH_PORT) };
  if (e.TRADING_BROWSER_EXE) o.browser.executable = e.TRADING_BROWSER_EXE;
  if (e.TRADING_BROWSER_PROFILE) o.browser.profileDir = e.TRADING_BROWSER_PROFILE;
  if (e.TRADING_BROWSER_PORT) o.browser.debugPort = Number(e.TRADING_BROWSER_PORT);
  return o;
}

function getConfig() {
  return overlayEnv(readBase());
}

module.exports = { getConfig };
