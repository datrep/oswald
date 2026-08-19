// pages/servers.js — Managed servers page.
// Lists every managed service (built-in + user-defined) with status, health,
// uptime, and controls: Start (open) / Stop (close) / Restart / Attach (adopt
// a detached instance on the port) / Detach, plus an inline log tail and an
// add/edit/delete config form. Viewing is open to any signed-in user; all
// controls + config require services.manage.
import { apiGet, apiPost, apiPut, apiDelete, isLoggedIn, getToken } from '../api/api.js';
import { initBreadcrumb, setBreadcrumbName } from '../components/breadcrumb.js';
initBreadcrumb();
setBreadcrumbName('Servers');

const $ = (id) => document.getElementById(id);
const STATE = { servers: [], configs: [], editName: null };
const openLogs = new Set(); // server names whose log panel is expanded

function hasPerm(code) {
  try {
    const t = getToken();
    if (!t) return false;
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Array.isArray(p.permissions) && p.permissions.includes(code);
  } catch { return false; }
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtUptime(sec) {
  if (!Number.isFinite(sec) || sec == null) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `up ${h ? h + 'h ' : ''}${m}m ${s}s`;
}

function stateOf(s) {
  if (s.running) return { chip: 'running', dot: 'on', label: 'running' };
  if (s.attached) return { chip: 'attached', dot: 'attached', label: 'attached' };
  if (s.portActive) return { chip: 'detached', dot: 'err', label: 'detached' };
  return { chip: 'stopped', dot: '', label: 'stopped' };
}

function feedback(msg) { const el = $('servers-status'); if (el) el.textContent = msg; }

async function refreshLog(name, force) {
  const box = document.querySelector(`.srv-log[data-name="${CSS.escape(name)}"]`);
  if (!box || !box.classList.contains('open')) return;
  try {
    const { log } = await apiGet(`/api/servers/${name}/log?lines=120`);
    const text = (log || []).join('\n');
    if (force || box.dataset.last !== text) {
      box.textContent = text || '(log is empty)';
      box.dataset.last = text;
      box.scrollTop = box.scrollHeight;
    }
  } catch { /* non-fatal */ }
}

function renderCard(s, canManage) {
  const st = stateOf(s);
  const builtin = s.builtin;
  const meta = [];
  if (s.pid) meta.push(`pid ${s.pid}`);
  if (s.attached) meta.push(`external pid ${s.attached}`);
  if (s.port) meta.push(`port ${s.port}`);
  if (s.uptimeSec != null) meta.push(fmtUptime(s.uptimeSec));
  if (s.healthy === true) meta.push('healthy');
  else if (s.healthy === false && s.running) meta.push('not responding');
  const openUrl = s.port ? `http${s.port === 8090 || s.port === 8443 ? 's' : ''}://localhost:${s.port}` : null;

  const card = document.createElement('div');
  card.className = 'server-card';
  card.dataset.name = s.name;
  card.innerHTML = `
    <div class="server-card__head">
      <div>
        <h3 class="server-card__name">${esc(s.label)}<code>${esc(s.name)}</code></h3>
        ${s.description ? `<p class="server-card__desc">${esc(s.description)}</p>` : ''}
      </div>
      <span class="srv-chip ${st.chip}">${st.label}</span>
    </div>
    <div class="server-status-line">
      <span class="srv-dot ${st.dot}"></span>
      <span class="srv-chip ${st.chip}">${st.label}</span>
      <span class="srv-meta">${meta.join(' · ')}</span>
    </div>
    <div class="server-card__actions">
      <button type="button" class="btn btn--sm server-start" data-name="${esc(s.name)}" ${!canManage || s.running || s.portActive ? 'disabled' : ''}>Start</button>
      <button type="button" class="btn btn--sm btn--danger server-stop" data-name="${esc(s.name)}" ${!canManage || (!s.running && !s.attached) ? 'disabled' : ''}>Stop</button>
      <button type="button" class="btn btn--sm server-restart" data-name="${esc(s.name)}" ${!canManage || !s.running ? 'disabled' : ''}>Restart</button>
      ${!s.running && s.portActive && !s.attached ? `<button type="button" class="btn btn--sm server-attach" data-name="${esc(s.name)}" ${!canManage ? 'disabled' : ''}>Attach</button>` : ''}
      ${s.attached ? `<button type="button" class="btn btn--sm server-detach" data-name="${esc(s.name)}" ${!canManage ? 'disabled' : ''}>Detach</button>` : ''}
      ${openUrl ? `<a class="btn btn--sm" href="${openUrl}" target="_blank" rel="noopener">Open ↗</a>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn--sm server-logs" data-name="${esc(s.name)}">${openLogs.has(s.name) ? 'Hide logs' : 'Logs'}</button>
      ${!builtin ? `<button type="button" class="btn btn--sm server-edit" data-name="${esc(s.name)}" data-manage>Edit</button>` : ''}
      ${!builtin ? `<button type="button" class="btn btn--sm btn--danger server-del" data-name="${esc(s.name)}" data-manage>×</button>` : ''}
    </div>
    <div class="srv-log ${openLogs.has(s.name) ? 'open' : ''}" data-name="${esc(s.name)}"></div>
  `;

  card.querySelector('.server-start')?.addEventListener('click', () => act(s.name, 'start'));
  card.querySelector('.server-stop')?.addEventListener('click', () => act(s.name, 'stop'));
  card.querySelector('.server-restart')?.addEventListener('click', () => act(s.name, 'restart'));
  card.querySelector('.server-attach')?.addEventListener('click', () => act(s.name, 'attach'));
  card.querySelector('.server-detach')?.addEventListener('click', () => act(s.name, 'detach'));
  card.querySelector('.server-logs')?.addEventListener('click', () => {
    if (openLogs.has(s.name)) openLogs.delete(s.name);
    else { openLogs.add(s.name); refreshLog(s.name, true); }
    render();
  });
  card.querySelector('.server-edit')?.addEventListener('click', () => openEdit(s.name));
  card.querySelector('.server-del')?.addEventListener('click', () => removeServer(s.name));
  return card;
}

function render() {
  const grid = $('servers-grid');
  const canManage = hasPerm('services.manage');
  document.querySelectorAll('[data-manage]').forEach((el) => el.classList.toggle('hidden', !canManage));
  grid.innerHTML = '';
  for (const s of STATE.servers) grid.appendChild(renderCard(s, canManage));
  feedback(`${STATE.servers.length} managed service(s) · status refreshed`);
}

async function act(name, action) {
  feedback(`${action} ${name}…`);
  try {
    const r = await apiPost(`/api/servers/${name}/${action}`);
    feedback(r.error ? r.error : `${action} → ${r.running ? 'running' : 'stopped'}${r.attached ? ' (attached pid ' + r.pid + ')' : ''}`);
    await load();
  } catch (err) { feedback('Error: ' + err.message); }
}

async function removeServer(name) {
  if (!confirm(`Remove server "${name}"? This also stops it if running.`)) return;
  try { await apiDelete(`/api/servers/config/${name}`); feedback('Server removed.'); openLogs.delete(name); await load(); }
  catch (err) { feedback('Error: ' + err.message); }
}

async function load() {
  if (!isLoggedIn()) {
    $('servers-gate').classList.remove('hidden');
    $('servers-content').classList.add('hidden');
    return;
  }
  $('servers-gate').classList.add('hidden');
  $('servers-content').classList.remove('hidden');
  try {
    const { servers } = await apiGet('/api/servers');
    STATE.servers = servers;
    render();
    for (const s of servers) if (openLogs.has(s.name)) refreshLog(s.name, false);
  } catch (err) { feedback('Could not load servers: ' + err.message); }
}

// ---- config modal ----
function openModal() { $('server-modal').classList.add('show'); }
function closeModal() { $('server-modal').classList.remove('show'); }

function openAdd() {
  STATE.editName = null;
  $('server-modal-title').textContent = 'New server';
  ['sv-name', 'sv-label', 'sv-desc', 'sv-command', 'sv-args', 'sv-cwd', 'sv-port', 'sv-logfile', 'sv-health'].forEach((id) => { $(id).value = ''; });
  $('sv-autostart').checked = false;
  $('sv-name').disabled = false;
  $('server-modal-status').textContent = '';
  openModal();
}

function openEdit(name) {
  const def = STATE.configs.find((d) => d.name === name);
  if (!def) return;
  STATE.editName = name;
  $('server-modal-title').textContent = 'Edit — ' + (def.label || name);
  $('sv-name').value = def.name;
  $('sv-label').value = def.label || '';
  $('sv-desc').value = def.description || '';
  $('sv-command').value = def.command || '';
  $('sv-args').value = (def.args || []).join('\n');
  $('sv-cwd').value = def.cwd || '';
  $('sv-port').value = def.port || '';
  $('sv-logfile').value = def.logFile || '';
  $('sv-health').value = def.healthUrl || '';
  $('sv-autostart').checked = !!def.autoStart;
  $('sv-name').disabled = true;
  $('server-modal-status').textContent = '';
  openModal();
}

async function saveModal() {
  const name = $('sv-name').value.trim();
  const body = {
    name,
    label: $('sv-label').value.trim(),
    description: $('sv-desc').value.trim(),
    command: $('sv-command').value.trim(),
    args: $('sv-args').value.split('\n').map((a) => a.trim()).filter(Boolean),
    cwd: $('sv-cwd').value.trim(),
    port: $('sv-port').value ? Number($('sv-port').value) : null,
    logFile: $('sv-logfile').value.trim(),
    healthUrl: $('sv-health').value.trim(),
    autoStart: $('sv-autostart').checked,
  };
  $('server-modal-status').textContent = 'Saving…';
  try {
    if (STATE.editName) await apiPut(`/api/servers/config/${STATE.editName}`, body);
    else await apiPost('/api/servers/config', body);
    closeModal();
    feedback(STATE.editName ? 'Server updated.' : 'Server added.');
    await loadConfigs();
    await load(); // re-render immediately so the new/edited card appears
  } catch (err) { $('server-modal-status').textContent = err.message; }
}

async function loadConfigs() {
  try { STATE.configs = (await apiGet('/api/servers/config')).definitions || []; } catch { STATE.configs = []; }
}

// ---- init ----
function init() {
  $('add-server').addEventListener('click', openAdd);
  $('server-modal-save').addEventListener('click', saveModal);
  $('server-modal-cancel').addEventListener('click', closeModal);
  $('server-modal-close').addEventListener('click', closeModal);
  $('server-modal').addEventListener('click', (e) => { if (e.target === $('server-modal')) closeModal(); });
  $('sv-command').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveModal(); } });

  load();
  loadConfigs();
  setInterval(load, 5000);
  window.addEventListener('auth:login', load);
  window.addEventListener('auth:logout', load);
}

init();
