// pages/logs.js — ApiLogs viewer (#58 UI). Shows traffic from BOTH the Oswald
// dashboard ([policy:services]) and the fileserver ([fileserver:<operation>])
// via GET /api/logs. Requires the users.manage permission.
//
// FUTURE SCOPE: when observability grows (log levels, categories, retention,
// live streaming over SSE/WebSocket, request IDs), extend this viewer rather
// than changing the /api/logs contract.

import { apiGet } from '../api/api.js';
import { getToken } from '../api/api.js';
import { initBreadcrumb } from '../components/breadcrumb.js';
initBreadcrumb();

const $ = (id) => document.getElementById(id);

let autoOn = true;
let autoTimer = null;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Local, human-readable timestamp matching the Oswald clock (#myClock) format:
// YYYY/MM/DD HH:MM:SS in the machine's local time (ApiLogs stores UTC).
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${mo}/${day} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

function statusClass(s) {
  if (s < 300) return 's2xx';
  if (s < 500) return 's4xx';
  return 's5xx';
}

function showGate(msg) {
  $('logs-gate').classList.remove('hidden');
  $('logs-app').classList.add('hidden');
  const p = $('logs-gate').querySelector('p');
  if (p && msg) p.textContent = msg;
}

function showApp() {
  $('logs-gate').classList.add('hidden');
  $('logs-app').classList.remove('hidden');
}

function render(rows) {
  const body = $('log-body');
  if (!rows || !rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="log-empty">No matching log entries.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="time" title="${esc(r.createdAt)}">${fmtTime(r.createdAt)}</td>
        <td><span class="src-badge ${esc(r.source || '')}">${esc(r.source || '—')}</span></td>
        <td class="lbl">${esc(r.label || '—')}</td>
        <td>${esc(r.method || '')}</td>
        <td class="path" title="${esc(r.path || '')}">${esc(r.path || '')}</td>
        <td><span class="status ${statusClass(Number(r.status))}">${r.status}</span></td>
        <td>${r.durationMs != null ? r.durationMs : '—'}</td>
        <td>${r.userId != null ? '#' + r.userId : '—'}</td>
      </tr>`
    )
    .join('');
}

async function load() {
  try {
    const params = new URLSearchParams({ limit: $('log-limit').value || '200' });
    const source = $('log-source').value;
    if (source) params.set('source', source);
    const rows = await apiGet('/api/logs?' + params.toString());
    render(rows);
    $('log-stats').textContent =
      `${rows.length} entries${source ? ` · ${source}` : ''} · ${new Date().toLocaleTimeString([], { hour12: false })}`;
    $('log-status').textContent = '';
    showApp();
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg.includes('403')) showGate('You need the users.manage permission to view logs.');
    else if (msg.includes('401')) showGate('Sign in to view logs.');
    else $('log-status').textContent = 'Load failed: ' + msg;
  }
}

function scheduleAuto() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    await load();
    scheduleAuto();
  }, 5000);
}

function setAuto(on) {
  autoOn = on;
  clearTimeout(autoTimer);
  autoTimer = null;
  const btn = $('log-auto');
  if (btn) {
    btn.innerHTML = `<span class="live-dot${autoOn ? '' : ' paused'}" id="log-live-dot"></span>${autoOn ? 'Auto-refresh' : 'Auto-refresh (paused)'}`;
    btn.classList.toggle('primary', !autoOn);
  }
  if (autoOn) scheduleAuto();
}

function init() {
  const back = $('btn-back');
  if (back) {
    back.addEventListener('click', () => {
      // Same-tab navigation means the browser Back button also returns here;
      // the button itself prefers history, falling back to the dashboard.
      if (window.history.length > 1) window.history.back();
      else window.location.href = '/index.html';
    });
  }

  $('log-refresh')?.addEventListener('click', load);
  $('log-source')?.addEventListener('change', load);
  $('log-limit')?.addEventListener('change', load);
  $('log-auto')?.addEventListener('click', () => setAuto(!autoOn));

  window.addEventListener('auth:login', () => { setAuto(true); load(); });
  window.addEventListener('auth:logout', () => { setAuto(false); showGate('Sign in to view logs.'); });

  if (getToken()) {
    load();
    setAuto(true);
  } else {
    showGate();
  }
}

init();
