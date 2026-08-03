// components/mcpControl.js
// Renders a small Start/Stop/Status control for the MCP filesystem server into #mcp-control.
import { apiGet, apiPost, isLoggedIn } from '../api/api.js';

async function refresh() {
  const statusEl = document.getElementById('mcp-status');
  const startBtn = document.getElementById('mcp-start');
  const stopBtn = document.getElementById('mcp-stop');
  if (!isLoggedIn()) {
    if (statusEl) statusEl.textContent = 'login required';
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;
    return;
  }
  try {
    const status = await apiGet('/api/mcp/status');
    if (statusEl) statusEl.textContent = status.running ? 'running' : 'stopped';
    if (startBtn) startBtn.disabled = status.running;
    if (stopBtn) stopBtn.disabled = !status.running;
  } catch (err) {
    if (statusEl) statusEl.textContent = 'error';
    console.error('[MCP] status check failed', err);
  }
}

function init() {
  const container = document.getElementById('mcp-control');
  if (!container) return;

  container.innerHTML = `
    <div class="mcp-control">
      <div class="mcp-title">MCP Filesystem Server</div>
      <div class="mcp-status-line">Status: <span id="mcp-status">…</span></div>
      <div class="mcp-actions">
        <button type="button" id="mcp-start">Start</button>
        <button type="button" id="mcp-stop">Stop</button>
      </div>
    </div>
  `;

  document.getElementById('mcp-start').addEventListener('click', async () => {
    try {
      await apiPost('/api/mcp/start');
      await refresh();
    } catch (err) {
      console.error('[MCP] start failed', err);
    }
  });

  document.getElementById('mcp-stop').addEventListener('click', async () => {
    try {
      await apiPost('/api/mcp/stop');
      await refresh();
    } catch (err) {
      console.error('[MCP] stop failed', err);
    }
  });

  // Re-evaluate when auth state changes (login / logout / expired token).
  window.addEventListener('auth:login', refresh);
  window.addEventListener('auth:logout', refresh);

  refresh();
}

init();
