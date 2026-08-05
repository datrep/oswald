// shared/config.js — central config + JSON-file access used by BOTH the Oswald
// dashboard and the fileserver (#69).
//
// Today the dashboard's "config" is the repo-root .env (JWT_SECRET, DB creds…)
// plus public/js/api/settings.json; this module is the single place those are
// read/written so no service re-implements the parsing.
//
// FUTURE SCOPE: if this project expands, this is the natural home for a typed
// settings schema, per-environment config files, secrets management, or a
// settings UI that writes back through here. Keep new config concerns here.

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');

let envLoaded = false;
/** Load the repo-root .env exactly once (idempotent), regardless of cwd. */
function loadEnv() {
  if (envLoaded) return;
  dotenv.config({ path: path.join(ROOT, '.env') });
  envLoaded = true;
}

/** Typed env getter (returns the fallback when unset/empty). */
function env(name, fallback) {
  loadEnv();
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Safe JSON file read — returns `fallback` (default {}) instead of throwing. */
function readJsonFile(absPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return fallback !== undefined ? fallback : {};
  }
}

/** Absolute path to the dashboard's server settings file. */
function dashboardSettingsPath() {
  return path.join(ROOT, 'public', 'js', 'api', 'settings.json');
}

/** Read the dashboard's server settings (settings.json). */
function readDashboardSettings() {
  return readJsonFile(dashboardSettingsPath());
}

/** Persist the dashboard's server settings (pretty-printed). */
function writeDashboardSettings(settings) {
  fs.writeFileSync(dashboardSettingsPath(), JSON.stringify(settings, null, 2) + '\n');
}

module.exports = { loadEnv, env, readJsonFile, dashboardSettingsPath, readDashboardSettings, writeDashboardSettings };
