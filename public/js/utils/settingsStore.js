// utils/settingsStore.js
// Central settings store: merges server defaults (GET /api/settings -> settings.json)
// with per-user overrides persisted in localStorage as a diff.
//
// - SETTINGS_SCHEMA drives BOTH the settings modal and value resolution.
// - Overrides are stored under `oswald_settings`; server settings are read-only here.
// - Any change dispatches `settings:changed` ({ key, value }); reset dispatches `settings:reset`.

import { apiGet } from '../api/api.js';

export const SETTINGS_STORAGE_KEY = 'oswald_settings';

// Legacy key used by the pre-settings-store trends collapse. Migrated on first load.
const LEGACY_TRENDS_KEY = 'oswald_trends_collapsed';

// Groups shown in the settings modal (order matters).
export const SETTINGS_SECTIONS = [
  {
    id: 'view',
    title: 'View',
    description: 'Which panels and sections are visible in the sidebar.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Behavior of popups and reminders.',
  },
  {
    id: 'monitoring',
    title: 'Monitoring',
    description: 'Network host status polling.',
  },
  {
    id: 'server',
    title: 'Server',
    description: 'Server-side flags — managed in public/js/api/settings.json.',
  },
];

// type: 'boolean' | 'select' | 'readonly'
// `server: true` marks values that come from settings.json and cannot be changed here.
export const SETTINGS_SCHEMA = [
  // ---- View ----
  {
    key: 'trendsCollapsed',
    label: 'Collapse completion trends',
    description: 'Start the trends section collapsed.',
    section: 'view',
    type: 'boolean',
    default: false,
  },
  {
    key: 'showMonitoring',
    label: 'Show Monitoring panel',
    description: 'Show the network host monitoring section in the sidebar.',
    section: 'view',
    type: 'boolean',
    default: true,
  },
  {
    key: 'showServicesTray',
    label: 'Show Services tray',
    description: 'Show the services tray in the sidebar.',
    section: 'view',
    type: 'boolean',
    default: true,
  },
  {
    key: 'showMcp',
    label: 'Show Server (MCP) panel',
    description: 'Show the MCP server status section in the sidebar.',
    section: 'view',
    type: 'boolean',
    default: true,
  },
  // ---- Notifications ----
  {
    key: 'showUnfinishedPopup',
    label: 'Unfinished policy popup',
    description: 'Automatically pop up unfinished policies on page load.',
    section: 'notifications',
    type: 'boolean',
    default: true,
  },
  // ---- Monitoring ----
  {
    key: 'monitorPollInterval',
    label: 'Status refresh interval',
    description: 'How often host status is re-checked (seconds).',
    section: 'monitoring',
    type: 'select',
    options: [3, 5, 10, 15, 30],
    default: 5,
  },
  // ---- Server (read-only, surfaced from settings.json) ----
  {
    key: 'enableResources',
    label: 'Enable resources',
    section: 'server',
    type: 'readonly',
    default: true,
    server: true,
  },
  {
    key: 'enableAuditLogs',
    label: 'Enable audit logs',
    section: 'server',
    type: 'readonly',
    default: false,
    server: true,
  },
  {
    key: 'enableStatusStrip',
    label: 'Enable status strip',
    section: 'server',
    type: 'readonly',
    default: true,
    server: true,
  },
  {
    key: 'filldefaultvalues',
    label: 'Fill default values',
    section: 'server',
    type: 'readonly',
    default: true,
    server: true,
  },
];

let serverDefaults = null; // from GET /api/settings
let overrides = null; // user overrides (localStorage diff)
let loadPromise = null;

function schemaFor(key) {
  return SETTINGS_SCHEMA.find((s) => s.key === key);
}

function readOverrides() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeOverrides() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(overrides || {}));
  } catch {
    /* ignore */
  }
}

/**
 * Load server defaults + user overrides. Concurrent callers share a single fetch.
 * @param {boolean} force - bypass the cached promise and re-fetch.
 */
export function loadSettings(force = false) {
  if (!force && loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      serverDefaults = await apiGet('/api/settings');
    } catch (err) {
      console.error('[Settings] Failed to load server defaults', err);
      serverDefaults = null;
    }
    overrides = readOverrides();
    // Migrate the legacy trends-collapse key into the store (one-time).
    if (overrides.trendsCollapsed === undefined) {
      try {
        const legacy = localStorage.getItem(LEGACY_TRENDS_KEY);
        if (legacy === '1' || legacy === '0') {
          overrides.trendsCollapsed = legacy === '1';
          localStorage.removeItem(LEGACY_TRENDS_KEY);
        }
      } catch {
        /* ignore */
      }
      writeOverrides();
    }
  })();
  return loadPromise;
}

/** Resolve a setting: override > server default > schema default. */
export function getSetting(key) {
  if (overrides && overrides[key] !== undefined) return overrides[key];
  if (serverDefaults && serverDefaults[key] !== undefined) return serverDefaults[key];
  const schema = schemaFor(key);
  return schema ? schema.default : undefined;
}

/** Persist a user override (client-side only) and notify listeners. */
export function setSetting(key, value) {
  const schema = schemaFor(key);
  if (!schema) return;
  if (schema.server) {
    console.warn(`[Settings] "${key}" is server-managed and cannot be changed here.`);
    return;
  }
  if (!overrides) overrides = {};
  let normalized = value;
  if (schema.type === 'boolean') normalized = Boolean(value);
  else if (schema.type === 'select' || schema.type === 'number') normalized = Number(value);
  if (overrides[key] === normalized) return; // no-op
  overrides[key] = normalized;
  writeOverrides();
  window.dispatchEvent(new CustomEvent('settings:changed', { detail: { key, value: normalized } }));
}

/** Clear all user overrides (server defaults remain active). */
export function resetSettings() {
  overrides = {};
  writeOverrides();
  window.dispatchEvent(new CustomEvent('settings:reset'));
}
