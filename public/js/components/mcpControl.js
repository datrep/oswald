// components/mcpControl.js
// Renders a Start/Stop/Status control for the MCP filesystem server into #mcp-control.
import { apiGet, apiPost, isLoggedIn } from '../api/api.js';

async function refresh() {
  const statusEl = document.getElementById('mcp-status');
  const rootEl = document.getElementById('mcp-root');
  const pidEl = document.getElementById('mcp-pid');
  const errorEl = document.getElementById('mcp-error');
  const startBtn = document.getElementById('mcp-start');
  const stopBtn = document.getElementById('mcp-stop');

  if (errorEl) errorEl.textContent = '';

  if (!isLoggedIn()) {
    if (statusEl) { statusEl.textContent = 'login required'; statusEl.style.transition = 'color 0.3s ease'; }
    if (rootEl) rootEl.textContent = '—';
    if (pidEl) pidEl.textContent = '';
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;
    return;
  }

  try {
    const status = await apiGet('/api/mcp/status');
    if (statusEl) {
      const newStatus = status.running ? 'running' : 'stopped';
      if (statusEl.textContent !== newStatus) {
        statusEl.style.transition = 'color 0.3s ease, opacity 0.25s ease';
        statusEl.style.opacity = '0';
        requestAnimationFrame(() => {
          statusEl.textContent = newStatus;
          statusEl.style.color = status.running ? 'var(--success)' : 'var(--muted)';
          statusEl.style.opacity = '1';
        });
      }
    }
    if (rootEl) rootEl.textContent = status.allowedDir || '—';
    if (pidEl) pidEl.textContent = status.pid ? `pid ${status.pid}` : '';
    if (startBtn) startBtn.disabled = status.running;
    if (stopBtn) stopBtn.disabled = !status.running;
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'error'; statusEl.style.color = 'var(--danger)'; }
    if (errorEl) errorEl.textContent = 'Could not reach server';
    console.error('[MCP] status check failed', err);
  }
}

function init() {
  const container = document.getElementById('mcp-control');
  if (!container) return;

  container.innerHTML = `
    <div class="mcp-control">
      <div class="mcp-title">MCP Filesystem Server</div>
      <div class="mcp-status-line">Status: <span id="mcp-status">…</span> <span id="mcp-pid" class="mcp-pid"></span></div>
      <div class="mcp-roots">Root: <code id="mcp-root">…</code></div>
      <div class="mcp-actions">
        <button type="button" id="mcp-start">Start</button>
        <button type="button" id="mcp-stop">Stop</button>
      </div>
      <p class="mcp-error" id="mcp-error"></p>
    </div>
  `;

  document.getElementById('mcp-start').addEventListener('click', async () => {
    const errorEl = document.getElementById('mcp-error');
    try {
      const r = await apiPost('/api/mcp/start');
      if (r && r.error) throw new Error(r.error);
      await refresh();
    } catch (err) {
      if (errorEl) errorEl.textContent = 'Start failed: ' + (err.message || 'unknown error');
      console.error('[MCP] start failed', err);
    }
  });

  document.getElementById('mcp-stop').addEventListener('click', async () => {
    const errorEl = document.getElementById('mcp-error');
    try {
      const r = await apiPost('/api/mcp/stop');
      if (r && r.error) throw new Error(r.error);
      await refresh();
    } catch (err) {
      if (errorEl) errorEl.textContent = 'Stop failed: ' + (err.message || 'unknown error');
      console.error('[MCP] stop failed', err);
    }
  });

  // Re-evaluate when auth state changes (login / logout / expired token).
  window.addEventListener('auth:login', refresh);
  window.addEventListener('auth:logout', refresh);

  refresh();
}

init();
