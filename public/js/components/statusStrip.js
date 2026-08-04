// components/statusStrip.js
// Live status strip rendered into #status-strip (below the topbar).
// Visibility is driven by the settings store (enableStatusStrip, from settings.json).
// Polls the lightweight public /api/health endpoint every 10s while logged in.

import { apiGet, isLoggedIn } from '../api/api.js';
import { getSetting, loadSettings } from '../utils/settingsStore.js';

const POLL_MS = 10000;

let timer = null;

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function render(chips) {
  const strip = document.getElementById('status-strip');
  if (!strip) return;
  strip.innerHTML = '';
  chips.forEach((c) => {
    const item = document.createElement('span');
    item.className = 'status-item';
    item.title = c.title || c.label;
    item.innerHTML = `<span class="status-dot ${c.dot}"></span>${c.label}`;
    strip.appendChild(item);
  });
}

async function refresh() {
  const strip = document.getElementById('status-strip');
  if (!strip) return;

  if (!isLoggedIn()) {
    render([{ dot: 'idle', label: 'login required', title: 'Sign in to see live status' }]);
    return;
  }

  try {
    const h = await apiGet('/api/health');
    render([
      {
        dot: 'online',
        label: `Server · up ${fmtUptime(h.uptime)}`,
        title: `Health checked ${h.checkedAt}`,
      },
      {
        dot: h.db ? 'online' : 'offline',
        label: `Database ${h.db ? 'up' : 'down'}`,
        title: h.db ? 'Connected to DB_Oswald' : 'Database unreachable',
      },
      {
        dot: h.mcp.running ? 'online' : 'idle',
        label: `MCP ${h.mcp.running ? 'running' : 'stopped'}`,
        title: h.mcp.running ? `MCP filesystem server (pid ${h.mcp.pid})` : 'MCP server stopped',
      },
      {
        dot: h.hosts.total > 0 ? 'online' : 'idle',
        label: `${h.hosts.total} hosts${h.hosts.enabled ? ` · ${h.hosts.enabled} enabled` : ''}`,
        title: 'Configured network hosts',
      },
    ]);
  } catch (err) {
    console.error('[StatusStrip] health check failed', err);
    render([{ dot: 'offline', label: 'Server unreachable', title: 'Failed to reach /api/health' }]);
  }
}

function startPolling() {
  stopPolling();
  refresh();
  timer = setInterval(refresh, POLL_MS);
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function apply() {
  const strip = document.getElementById('status-strip');
  if (!strip) return;
  const enabled = getSetting('enableStatusStrip');
  if (!enabled) {
    stopPolling();
    strip.style.display = 'none';
    strip.innerHTML = '';
    return;
  }
  strip.style.display = 'flex';
  if (isLoggedIn()) startPolling();
  else {
    stopPolling();
    render([{ dot: 'idle', label: 'login required', title: 'Sign in to see live status' }]);
  }
}

async function init() {
  if (!document.getElementById('status-strip')) return;
  await loadSettings();

  window.addEventListener('auth:login', apply);
  window.addEventListener('auth:logout', apply);
  window.addEventListener('settings:changed', apply);
  window.addEventListener('settings:reset', apply);

  apply();
}

init();
