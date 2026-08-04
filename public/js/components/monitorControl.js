// components/monitorControl.js
// Renders a small host-management panel for the IP monitoring strip into #monitor-control.
import { apiGet, apiPost, apiPut, apiDelete, isLoggedIn } from '../api/api.js';
import { getSetting } from '../utils/settingsStore.js';

let editingHostId = null;
let hosts = [];
let statusMap = {};
let statusTimer = null;

function getErrorEl() {
  return document.getElementById('monitor-error');
}

async function refresh() {
  const listEl = document.getElementById('monitor-list');
  const errorEl = getErrorEl();
  if (errorEl) errorEl.textContent = '';
  if (!listEl) return;

  if (!isLoggedIn()) {
    listEl.innerHTML = '<div class="monitor-empty">login required</div>';
    return;
  }

  try {
    hosts = await apiGet('/api/ips/hosts');
    render();
  } catch (err) {
    if (errorEl) errorEl.textContent = 'Failed to load hosts';
    console.error('[Monitor] load failed', err);
  }
}

function render() {
  const listEl = document.getElementById('monitor-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!hosts.length) {
    listEl.innerHTML = '<div class="monitor-empty">No hosts configured</div>';
    return;
  }
  hosts.forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'monitor-row anim-enter';
    row.style.animationDelay = `${i * 0.05}s`;
    row.dataset.ip = h.ip;
    const s = statusMap[h.ip];
    const dotClass = dotClassFor(h, s);
    const latency = s ? (s.alive ? `${s.time}ms` : 'down') : '';
    row.innerHTML = `
      <span class="monitor-dot ${dotClass}"></span>
      <span class="monitor-label">${h.label || h.ip}</span>
      <span class="monitor-ip">${h.ip}</span>
      <span class="monitor-latency">${latency}</span>
      <div class="monitor-actions">
        <button type="button" class="monitor-edit" title="Edit host">✎</button>
        <button type="button" class="monitor-delete" title="Delete host">✕</button>
      </div>
    `;
    row.querySelector('.monitor-edit').addEventListener('click', () => openEdit(h));
    row.querySelector('.monitor-delete').addEventListener('click', async () => {
      if (!confirm(`Remove host "${h.label || h.ip}"?`)) return;
      try {
        await apiDelete(`/api/ips/hosts/${h.id}`);
        await refresh();
      } catch (err) {
        console.error('[Monitor] delete failed', err);
      }
    });
    listEl.appendChild(row);
  });
}

function dotClassFor(h, s) {
  if (!h.enabled) return 'disabled';
  if (!s) return 'idle';
  if (s.alive) return 'online';
  const t = parseFloat(s.time);
  return !Number.isNaN(t) && t >= 200 ? 'warning' : 'offline';
}

// Live status: poll /api/ips/check every 5s and update dots in place
async function refreshStatus() {
  if (!isLoggedIn()) return;
  try {
    const resp = await apiGet('/api/ips/check');
    if (resp && resp.results) {
      statusMap = {};
      resp.results.forEach((r) => {
        statusMap[r.ip] = r;
      });
      applyStatus();
    }
  } catch (err) {
    // transient failure — keep last known status
  }
}

function applyStatus() {
  document.querySelectorAll('.monitor-row[data-ip]').forEach((row) => {
    const s = statusMap[row.dataset.ip];
    if (!s) return;
    const dot = row.querySelector('.monitor-dot');
    const lat = row.querySelector('.monitor-latency');
    if (dot) {
      const oldClass = dot.className;
      const newClass =
        'monitor-dot ' +
        (s.alive ? 'online' : parseFloat(s.time) >= 200 ? 'warning' : 'offline');
      if (oldClass !== newClass) {
        dot.className = newClass;
        // Brief scale pulse on status change
        dot.style.transform = 'scale(1.6)';
        requestAnimationFrame(() => {
          dot.style.transition = 'transform 0.25s ease';
          dot.style.transform = 'scale(1)';
        });
      }
    }
    if (lat) {
      const newText = s.alive ? `${s.time}ms` : 'down';
      if (lat.textContent !== newText) {
        lat.textContent = newText;
        lat.style.transition = 'opacity 0.2s ease';
        lat.style.opacity = '0';
        requestAnimationFrame(() => {
          lat.style.opacity = '1';
        });
      }
    }
  });
}

function startStatusPolling() {
  stopStatusPolling();
  refreshStatus();
  const seconds = Number(getSetting('monitorPollInterval')) || 5;
  statusTimer = setInterval(refreshStatus, Math.max(2, seconds) * 1000);
}

function stopStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

function resetForm() {
  editingHostId = null;
  const label = document.getElementById('monitor-label');
  const ip = document.getElementById('monitor-ip');
  if (label) label.value = '';
  if (ip) ip.value = '';
  const addBtn = document.getElementById('monitor-add');
  if (addBtn) addBtn.textContent = '+ Add Host';
  const form = document.getElementById('monitor-add-form');
  if (form) form.classList.add('hidden');
}

function openAdd() {
  resetForm();
  const form = document.getElementById('monitor-add-form');
  if (form) form.classList.remove('hidden');
  const label = document.getElementById('monitor-label');
  if (label) label.focus();
}

function openEdit(host) {
  editingHostId = host.id;
  const label = document.getElementById('monitor-label');
  const ip = document.getElementById('monitor-ip');
  if (label) label.value = host.label || '';
  if (ip) ip.value = host.ip || '';
  const addBtn = document.getElementById('monitor-add');
  if (addBtn) addBtn.textContent = 'Cancel';
  const form = document.getElementById('monitor-add-form');
  if (form) form.classList.remove('hidden');
  if (label) label.focus();
}

function init() {
  const container = document.getElementById('monitor-control');
  if (!container) return;

  container.innerHTML = `
    <div class="monitor-control">
      <div class="monitor-list" id="monitor-list"></div>
      <button type="button" id="monitor-add" class="monitor-add">+ Add Host</button>
      <form id="monitor-add-form" class="monitor-add-form hidden">
        <div class="form-field">
          <label for="monitor-label">Label</label>
          <input id="monitor-label" type="text" placeholder="e.g. NAS" />
        </div>
        <div class="form-field">
          <label for="monitor-ip">IP Address</label>
          <input id="monitor-ip" type="text" placeholder="192.168.1.10" required />
        </div>
        <div class="monitor-form-actions">
          <button type="submit">Save</button>
          <button type="button" id="monitor-cancel">Cancel</button>
        </div>
      </form>
      <p class="monitor-error" id="monitor-error"></p>
    </div>
  `;

  document.getElementById('monitor-add').addEventListener('click', () => {
    const form = document.getElementById('monitor-add-form');
    if (form && !form.classList.contains('hidden')) {
      resetForm();
    } else {
      openAdd();
    }
  });

  document.getElementById('monitor-cancel').addEventListener('click', resetForm);

  document.getElementById('monitor-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = getErrorEl();
    const label = document.getElementById('monitor-label').value.trim();
    const ip = document.getElementById('monitor-ip').value.trim();
    if (!label || !ip) {
      if (errorEl) errorEl.textContent = 'Label and IP are required.';
      return;
    }
    try {
      if (editingHostId) {
        await apiPut(`/api/ips/hosts/${editingHostId}`, { label, ip });
      } else {
        await apiPost('/api/ips/hosts', { label, ip });
      }
      resetForm();
      await refresh();
    } catch (err) {
      if (errorEl) errorEl.textContent = 'Failed to save host';
      console.error('[Monitor] save failed', err);
    }
  });

  window.addEventListener('auth:login', () => {
    refresh();
    startStatusPolling();
  });
  window.addEventListener('auth:logout', () => {
    stopStatusPolling();
    statusMap = {};
    refresh();
  });
  // Re-apply the polling interval when the setting changes.
  window.addEventListener('settings:changed', (e) => {
    if (e.detail && e.detail.key === 'monitorPollInterval') startStatusPolling();
  });

  if (isLoggedIn()) startStatusPolling();
  refresh();
}

init();
