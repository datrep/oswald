// utils/settingsStore.js
// Central settings store: merges server defaults (GET /api/settings -> settings.json)
// with per-user overrides persisted in localStorage as a diff.
//
// - SETTINGS_SCHEMA drives BOTH the settings modal and value resolution.
// - Overrides are stored under `oswald_settings`; server settings are read-only here.
// - Any change dispatches `settings:changed` ({ key, value }); reset dispatches `settings:reset`.

import { apiGet, clearToken } from '../api/api.js';

export const SETTINGS_STORAGE_KEY = 'oswald_settings';

// Legacy key used by the pre-settings-store trends collapse. Migrated on first load.
const LEGACY_TRENDS_KEY = 'oswald_trends_collapsed';

// Hierarchical structure: categories -> sections -> settings.
export const SETTINGS_CATEGORIES = [
  { id: 'general', title: 'General' },
  { id: 'dashboard', title: 'Dashboard' },
  { id: 'workspace', title: 'Policy Workspace' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'peripherals', title: 'Peripherals' },
  { id: 'account', title: 'Account & Data' },
  { id: 'server', title: 'Server' },
];

// Sub-groups; each belongs to a category.
export const SETTINGS_SECTIONS = [
  { id: 'appearance', title: 'Appearance', category: 'general' },
  { id: 'behaviour', title: 'Behaviour', category: 'general' },
  { id: 'panels', title: 'Sidebar Panels', category: 'dashboard' },
  { id: 'trends', title: 'Trends', category: 'dashboard' },
  { id: 'statusstrip', title: 'Status Strip', category: 'dashboard' },
  { id: 'rails', title: 'Side Rails', category: 'workspace' },
  { id: 'forms', title: 'Form Defaults', category: 'workspace' },
  { id: 'resources', title: 'Resources', category: 'workspace' },
  { id: 'popup', title: 'Unfinished Popup', category: 'notifications' },
  { id: 'monitoring', title: 'Monitoring', category: 'peripherals' },
  { id: 'mcp', title: 'MCP', category: 'peripherals' },
  { id: 'session', title: 'Session', category: 'account' },
  { id: 'data', title: 'Data', category: 'account' },
  { id: 'server', title: 'Server Flags', category: 'server', server: true },
];

// type: 'boolean' | 'select' | 'color' | 'readonly'
// `server: true` marks values that come from settings.json and cannot be changed here.
export const SETTINGS_SCHEMA = [
  // ---- General / Appearance ----
  {
    key: 'theme',
    label: 'Theme',
    description: 'Dark or light color scheme.',
    section: 'appearance',
    type: 'select',
    options: [
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
    ],
    default: 'dark',
  },
  {
    key: 'accentColor',
    label: 'Accent color',
    description: 'Primary highlight color used across the UI.',
    section: 'appearance',
    type: 'color',
    default: '#7c8cf8',
  },
  // ---- General / Behaviour ----
  {
    key: 'confirmDelete',
    label: 'Confirm before deleting',
    description: 'Ask for confirmation on destructive actions.',
    section: 'behaviour',
    type: 'boolean',
    default: true,
  },
  // ---- Dashboard / Sidebar Panels ----
  {
    key: 'showMonitoring',
    label: 'Show Monitoring panel',
    description: 'Show the network host monitoring section in the sidebar.',
    section: 'panels',
    type: 'boolean',
    default: true,
  },
  {
    key: 'showServicesTray',
    label: 'Show Services tray',
    description: 'Show the services tray in the sidebar.',
    section: 'panels',
    type: 'boolean',
    default: true,
  },
  {
    key: 'showMcp',
    label: 'Show Server (MCP) panel',
    description: 'Show the MCP server status section in the sidebar.',
    section: 'panels',
    type: 'boolean',
    default: true,
  },
  // ---- Dashboard / Trends ----
  {
    key: 'trendsCollapsed',
    label: 'Collapse completion trends',
    description: 'Start the trends section collapsed.',
    section: 'trends',
    type: 'boolean',
    default: false,
  },
  // ---- Dashboard / Status Strip (server read-only) ----
  {
    key: 'enableStatusStrip',
    label: 'Enable status strip',
    section: 'statusstrip',
    type: 'readonly',
    default: true,
    server: true,
  },
  // ---- Policy Workspace / Side Rails ----
  {
    key: 'showPolicyRails',
    label: 'Show side rails',
    description: 'Show the left nav + right actions/progress rails in the policy workspace.',
    section: 'rails',
    type: 'boolean',
    default: true,
  },
  // ---- Policy Workspace / Form Defaults ----
  {
    key: 'defaultPolicyPriority',
    label: 'Default policy priority',
    description: 'Prefill priority when creating a policy.',
    section: 'forms',
    type: 'select',
    options: [
      { value: '', label: 'None (blank)' },
      { value: 0, label: 'P0 Critical' },
      { value: 1, label: 'P1 High' },
      { value: 2, label: 'P2 Medium' },
      { value: 3, label: 'P3 Low' },
    ],
    default: '',
  },
  {
    key: 'defaultTaskPriority',
    label: 'Default task priority',
    description: 'Prefill priority when creating a task.',
    section: 'forms',
    type: 'select',
    options: [
      { value: '', label: 'None (inherit)' },
      { value: 0, label: 'P0 Critical' },
      { value: 1, label: 'P1 High' },
      { value: 2, label: 'P2 Medium' },
      { value: 3, label: 'P3 Low' },
    ],
    default: '',
  },
  {
    key: 'defaultTaskState',
    label: 'Default task state',
    description: 'Prefill state when creating a task.',
    section: 'forms',
    type: 'select',
    options: [
      { value: 1, label: 'Draft' },
      { value: 2, label: 'Published' },
      { value: 3, label: 'Archived' },
    ],
    default: 1,
  },
  // ---- Policy Workspace / Resources ----
  {
    key: 'openResourceOnClick',
    label: 'Open resource on click',
    description: 'Clicking a resource card opens the viewer (otherwise use the View button).',
    section: 'resources',
    type: 'boolean',
    default: true,
  },
  // ---- Notifications / Unfinished Popup ----
  {
    key: 'showUnfinishedPopup',
    label: 'Unfinished policy popup',
    description: 'Automatically pop up unfinished policies on page load.',
    section: 'popup',
    type: 'boolean',
    default: true,
  },
  // ---- Peripherals / Monitoring ----
  {
    key: 'monitorPollInterval',
    label: 'Status refresh interval',
    description: 'How often host status is re-checked (seconds).',
    section: 'monitoring',
    type: 'select',
    options: [3, 5, 10, 15, 30],
    default: 5,
  },
  // ---- Account / Session ----
  {
    key: 'sessionTimeout',
    label: 'Auto sign-out',
    description: 'Sign out after this many minutes idle (Off disables).',
    section: 'session',
    type: 'select',
    options: [
      { value: 0, label: 'Off' },
      { value: 5, label: '5 minutes' },
      { value: 15, label: '15 minutes' },
      { value: 30, label: '30 minutes' },
      { value: 60, label: '60 minutes' },
    ],
    default: 0,
  },
  // ---- Server Flags (read-only, surfaced from settings.json) ----
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
  else if (schema.type === 'number') normalized = Number(value);
  else if (schema.type === 'select') {
    const num = Number(value);
    normalized = Number.isNaN(num) ? value : num; // keep string options (e.g. theme) as strings
  }
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

// ===========================
// GLOBAL APPLY + ACTIONS
// ===========================
function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return 'rgba(124, 140, 248, 0.14)';
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

/** Apply global (page-independent) settings: theme + accent color. */
export function applyGlobalSettings() {
  const theme = getSetting('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const accent = getSetting('accentColor') || '#7c8cf8';
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(accent, 0.14));
}

let sessionTimer = null;
let sessionBound = false;
let sessionMinutes = 0;

function resetSessionTimer() {
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
  if (!sessionMinutes) return;
  sessionTimer = setTimeout(() => {
    console.warn('[Settings] Signed out due to inactivity');
    clearToken();
    window.dispatchEvent(new CustomEvent('auth:logout'));
  }, sessionMinutes * 60 * 1000);
}

/** Start (or restart) the idle sign-out timer from the sessionTimeout setting. */
export function initSessionTimeout() {
  sessionMinutes = Number(getSetting('sessionTimeout')) || 0;
  if (!sessionBound) {
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach((e) =>
      window.addEventListener(e, resetSessionTimer, { passive: true })
    );
    sessionBound = true;
  }
  resetSessionTimer();
}

/** Download the current settings (overrides + resolved values) as JSON. */
export function exportSettings() {
  const resolved = {};
  SETTINGS_SCHEMA.forEach((s) => {
    resolved[s.key] = getSetting(s.key);
  });
  const data = { exportedAt: new Date().toISOString(), overrides: overrides || {}, resolved };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'oswald-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  return data;
}

/** Merge overrides from an exported settings JSON. */
export function importSettings(jsonText) {
  const data = JSON.parse(jsonText);
  const incoming = data.overrides || {};
  overrides = { ...(overrides || {}), ...incoming };
  writeOverrides();
  window.dispatchEvent(new CustomEvent('settings:reset'));
  return incoming;
}

/** Clear all client-side local data (settings overrides + transient keys). */
export function clearLocalData() {
  [SETTINGS_STORAGE_KEY, LEGACY_TRENDS_KEY, 'oswald_unfinished_dismiss_date'].forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  });
  overrides = {};
}

/** Reset the per-day "don't show for today" popup flag. */
export function resetDismissals() {
  try {
    localStorage.removeItem('oswald_unfinished_dismiss_date');
  } catch {
    /* ignore */
  }
}
