// components/serverControl.js
// Renders a Start/Stop/Status card for every managed side service (MCP
// filesystem server, Oswald Fileserver) into #mcp-control. Backed by the
// generic /api/servers endpoints (utils/serverManager.js). Status is visible
// to any signed-in user; the Start/Stop buttons require services.manage.
import { apiGet, apiPost, getToken, isLoggedIn } from '../api/api.js';

function hasPerm(code) {
  try {
    const t = getToken();
    if (!t) return false;
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Array.isArray(payload.permissions) && payload.permissions.includes(code);
  } catch {
    return false;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let firstRender = true; // only animate the entry (15s poll must not flicker)

async function refresh() {
  const container = document.getElementById('mcp-control');
  if (!container) return;

  if (!isLoggedIn()) {
    container.innerHTML = '<div class="muted" style="padding:4px 0">login required</div>';
    return;
  }

  try {
    const { servers } = await apiGet('/api/servers');
    const canManage = hasPerm('services.manage');
    const header =
      '<div class="servers-head"><span class="servers-label">Managed servers</span>' +
      '<a class="servers-link" href="pages/servers.html" target="_blank" rel="noopener">servers &#8250;</a></div>';
    const fmtUptime = (sec) => {
      if (!Number.isFinite(sec) || sec == null) return '';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return `${h ? h + 'h ' : ''}${m}m`;
    };
    container.innerHTML =
      header +
      servers
      .map((s, i) => {
        const running = !!s.running;
        const attached = !!s.attached;
        const portHeld = !running && !attached && !!s.portActive; // external/detached instance
        const state = running ? 'running' : attached ? 'attached' : portHeld ? 'detached' : 'stopped';
        const note = portHeld ? 'detached — Attach to control' : attached ? `attached pid ${s.attached}` : '';
        const meta = [s.pid ? 'pid ' + s.pid : '', s.uptimeSec != null ? fmtUptime(s.uptimeSec) : '', s.healthy === true ? 'healthy' : ''].filter(Boolean).join(' · ');
        const cls = 'mcp-control' + (firstRender ? ' anim-enter' : '');
        const delay = firstRender ? ` style="animation-delay:${i * 0.06}s"` : '';
        return `
      <div class="${cls}" data-name="${esc(s.name)}"${delay}>
        <div class="mcp-title">${esc(s.label)}</div>
        <div class="mcp-status-line">
          Status: <span class="server-status ${state}">${state}</span>
          <span class="mcp-pid">${meta}</span>
          ${note ? '<span class="server-note">' + note + '</span>' : ''}
        </div>
        <div class="mcp-actions">
          <button type="button" class="server-start" data-name="${esc(s.name)}" ${!canManage || running || portHeld ? 'disabled' : ''}>Start</button>
          <button type="button" class="server-stop" data-name="${esc(s.name)}" ${!canManage || (!running && !attached) ? 'disabled' : ''}>Stop</button>
          <button type="button" class="server-restart" data-name="${esc(s.name)}" ${!canManage || !running ? 'disabled' : ''}>Restart</button>
          ${portHeld ? `<button type="button" class="server-attach" data-name="${esc(s.name)}" ${!canManage ? 'disabled' : ''}>Attach</button>` : ''}
        </div>
        <p class="mcp-error" data-error="${esc(s.name)}"></p>
      </div>`;
      })
      .join('');
    firstRender = false;

    container.querySelectorAll('.server-start').forEach((b) =>
      b.addEventListener('click', () => act(b.dataset.name, 'start'))
    );
    container.querySelectorAll('.server-stop').forEach((b) =>
      b.addEventListener('click', () => act(b.dataset.name, 'stop'))
    );
    container.querySelectorAll('.server-restart').forEach((b) =>
      b.addEventListener('click', () => act(b.dataset.name, 'restart'))
    );
    container.querySelectorAll('.server-attach').forEach((b) =>
      b.addEventListener('click', () => act(b.dataset.name, 'attach'))
    );
  } catch (err) {
    container.innerHTML =
      '<div class="mcp-control"><div class="mcp-title">Server</div><p class="mcp-error">Could not reach server</p></div>';
    console.error('[Server] status check failed', err);
  }
}

async function act(name, action) {
  const errorEl = document.querySelector(`[data-error="${name}"]`);
  try {
    const r = await apiPost(`/api/servers/${name}/${action}`);
    if (r && r.error) throw new Error(r.error);
    await refresh();
  } catch (err) {
    if (errorEl) errorEl.textContent = (action === 'start' ? 'Start' : 'Stop') + ' failed: ' + (err.message || 'unknown error');
    console.error(`[Server] ${action} ${name} failed`, err);
  }
}

// Re-render on auth changes (login / logout / expired token); re-animate on login.
window.addEventListener('auth:login', () => { firstRender = true; refresh(); });
window.addEventListener('auth:logout', refresh);
// Light poll so external state (e.g. a detached fileserver on :8090) stays fresh.
setInterval(refresh, 15000);

refresh();
