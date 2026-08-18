// components/auth.js
// Auth control for #auth-control. Signed out: a Login button + inline form.
// Signed in: a user chip (initials + username + role) whose popover has
// Sign out and, for admins, a live "Recent logins" list (UAC-5). Stores the
// JWT + identity in localStorage so api.js can attach the token to requests.

import { getToken, clearToken, isLoggedIn, TOKEN_KEY } from '../api/api.js';

const USER_KEY = 'oswald_username';
const ROLES_KEY = 'oswald_roles';
const SESSION_KEY = 'oswald_session';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hasPerm(code) {
  try {
    const t = getToken();
    if (!t) return false;
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Array.isArray(p.permissions) && p.permissions.includes(code);
  } catch { return false; }
}
function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
}
function deviceLabel(ua) {
  if (!ua) return 'Unknown device';
  let os = 'OS';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return `${browser} · ${os}`;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function storeIdentity(username, roles) {
  try { localStorage.setItem(USER_KEY, username); localStorage.setItem(ROLES_KEY, JSON.stringify(roles || [])); } catch { /* ignore */ }
}
function storeSession(sessionId) {
  try { localStorage.setItem(SESSION_KEY, sessionId || ''); } catch { /* ignore */ }
}
function clearIdentity() {
  try { localStorage.removeItem(USER_KEY); localStorage.removeItem(ROLES_KEY); localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
function storedName() { try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; } }
function storedRoles() { try { return JSON.parse(localStorage.getItem(ROLES_KEY) || '[]'); } catch { return []; } }
function storedSessionId() { try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; } }

async function submitLogin(username, password) {
  const res = await fetch('/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Login failed');
  storeIdentity(username, data.roles || []);
  storeSession(data.sessionId);
  return data;
}

// Populate the chip from an existing session if identity wasn't stored.
async function ensureIdentity() {
  if (storedName()) return;
  try {
    const res = await fetch('/api/users/me', { headers: { Authorization: 'Bearer ' + getToken() } });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.username) storeIdentity(data.username, data.roles || []);
  } catch { /* non-fatal */ }
}

async function renderRecentLogins(pop) {
  const slot = pop.querySelector('.user-recent-slot');
  if (!slot) return;
  const box = document.createElement('div');
  box.className = 'user-recent';
  box.innerHTML = '<div class="user-recent-title">Recent logins</div><div class="user-recent-body muted">Loading…</div>';
  slot.innerHTML = '';
  slot.appendChild(box);
  const body = box.querySelector('.user-recent-body');
  try {
    const res = await fetch('/api/users/sessions?limit=8', { headers: { Authorization: 'Bearer ' + getToken() } });
    const data = await res.json().catch(() => ({}));
    const s = data.sessions || [];
    if (!s.length) { body.textContent = 'No logins recorded yet.'; return; }
    body.innerHTML = s.map((x) => `
      <div class="user-recent-row">
        <span class="user-recent-user">${escapeHtml(x.username)}</span>
        <span class="user-recent-meta" title="${escapeHtml(x.userAgent || '')}">${escapeHtml(deviceLabel(x.userAgent))} · ${escapeHtml(x.ip || '')}</span>
        <span class="user-recent-time">${escapeHtml(fmtTime(x.loggedInAt))}</span>
      </div>`).join('');
  } catch {
    body.textContent = 'Could not load logins.';
  }
}

function renderUserPop() {
  const pop = document.getElementById('user-pop');
  if (!pop) return;
  const name = storedName() || 'User';
  const roles = storedRoles();
  pop.innerHTML = `
    <div class="user-pop-head"><span class="user-avatar">${escapeHtml(initials(name))}</span><div><strong>${escapeHtml(name)} <span class="online-dot" title="You are online"></span></strong><div class="muted user-roles">${escapeHtml(roles.join(', ') || 'no roles')}</div></div></div>
    <button type="button" class="user-pop-item" data-user-act="signout">Sign out</button>
    ${hasPerm('users.manage') ? '<div class="user-recent-slot"></div>' : ''}
  `;
  pop.querySelector('[data-user-act="signout"]').addEventListener('click', () => {
    clearIdentity();
    clearToken();
    setLoggedOutUI();
    window.dispatchEvent(new CustomEvent('auth:logout'));
  });
  if (pop.querySelector('.user-recent-slot')) renderRecentLogins(pop);
}

async function submitRegister(username, password) {
  const res = await fetch('/api/users/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  return data;
}

// True while the Users table is empty (first-run bootstrap).
async function needsSetup() {
  try {
    const res = await fetch('/api/users/bootstrap');
    const data = await res.json().catch(() => ({}));
    return !!data.needsSetup;
  } catch {
    return false;
  }
}

// ---- UAC-5 live presence (heartbeat) ----
// While signed in, ping the server every 60s so the dashboard can show who is
// online. Stops on logout or when the server rejects the heartbeat (revoked /
// expired token) — the next real request will surface the login-again state.
let heartbeatTimer = null;

async function heartbeat() {
  const sid = storedSessionId();
  if (!isLoggedIn() || !sid) return;
  try {
    const res = await fetch('/api/users/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ sessionId: sid }),
    });
    if (res.status === 401 || res.status === 403) stopHeartbeat();
  } catch { /* transient network error — retried next tick */ }
}

function onVisible() { if (!document.hidden) heartbeat(); }

function startHeartbeat() {
  stopHeartbeat();
  if (!isLoggedIn()) return;
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, 60000);
  document.addEventListener('visibilitychange', onVisible);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  document.removeEventListener('visibilitychange', onVisible);
}

function setLoggedInUI() {
  const toggle = document.getElementById('auth-toggle');
  const panel = document.getElementById('auth-panel');
  const chip = document.getElementById('user-chip');
  const pop = document.getElementById('user-pop');
  if (toggle) toggle.classList.add('hidden');
  if (panel) panel.classList.add('hidden');
  if (chip) {
    chip.classList.remove('hidden');
    const name = storedName() || '…';
    const nm = document.getElementById('user-name'); if (nm) nm.textContent = name;
    const av = document.getElementById('user-avatar'); if (av) av.textContent = initials(name);
  }
  if (pop) pop.classList.add('hidden');
}

function setLoggedOutUI() {
  const toggle = document.getElementById('auth-toggle');
  const chip = document.getElementById('user-chip');
  const pop = document.getElementById('user-pop');
  if (toggle) toggle.classList.remove('hidden');
  if (chip) chip.classList.add('hidden');
  if (pop) pop.classList.add('hidden');
}

function refreshUI() {
  if (isLoggedIn()) { ensureIdentity().then(setLoggedInUI); }
  else setLoggedOutUI();
}

// First-run: replace the login control with an admin account setup form.
// Shown only while /api/users/bootstrap reports no accounts yet.
function renderSetup() {
  const container = document.getElementById('auth-control');
  if (!container) return;

  container.innerHTML = `
    <div class="auth-control">
      <form id="auth-setup-form" class="auth-panel" autocomplete="off">
        <h3 style="margin:0;font-size:0.95rem">Create admin account</h3>
        <p style="margin:0 0 4px;font-size:0.78rem;color:var(--muted)">
          No accounts yet — the first account becomes the administrator.
        </p>
        <input id="setup-username" type="text" placeholder="Username" autocomplete="username" required />
        <input id="setup-password" type="password" placeholder="Password" autocomplete="new-password" required />
        <input id="setup-confirm" type="password" placeholder="Confirm password" autocomplete="new-password" required />
        <button type="submit">Create admin account</button>
        <p class="auth-error" id="setup-error"></p>
      </form>
    </div>`;

  const form = document.getElementById('auth-setup-form');
  const error = document.getElementById('setup-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('setup-username').value.trim();
    const password = document.getElementById('setup-password').value;
    const confirm = document.getElementById('setup-confirm').value;

    if (!username) {
      error.textContent = 'Username is required';
      return;
    }
    if (password !== confirm) {
      error.textContent = 'Passwords do not match';
      return;
    }
    if (password.length < 8) {
      error.textContent = 'Password must be at least 8 characters';
      return;
    }

    try {
      await submitRegister(username, password);
      const data = await submitLogin(username, password);
      localStorage.setItem(TOKEN_KEY, data.token);
      setLoggedInUI();
      window.dispatchEvent(new CustomEvent('auth:login'));
      init(); // rebuild the normal login/logout control now that setup is done
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

function init() {
  const container = document.getElementById('auth-control');
  if (!container) return;

  container.innerHTML = `
    <div class="auth-control">
      <button type="button" id="auth-toggle" class="auth-toggle">Login</button>
      <div id="user-chip" class="user-chip hidden" role="button" tabindex="0" title="Account">
        <span id="user-avatar" class="user-avatar"></span>
        <span id="user-name" class="user-name"></span>
      </div>
      <div id="user-pop" class="user-pop hidden"></div>
      <form id="auth-panel" class="auth-panel hidden" autocomplete="off">
        <input id="auth-username" type="text" placeholder="Username" autocomplete="username" required>
        <input id="auth-password" type="password" placeholder="Password" autocomplete="current-password" required>
        <button type="submit" id="auth-submit">Sign in</button>
        <p class="auth-error" id="auth-error"></p>
      </form>
    </div>
  `;

  const toggle = document.getElementById('auth-toggle');
  const panel = document.getElementById('auth-panel');
  const chip = document.getElementById('user-chip');
  const pop = document.getElementById('user-pop');

  toggle.addEventListener('click', () => panel.classList.toggle('hidden'));

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop.classList.contains('hidden')) { renderUserPop(); pop.classList.remove('hidden'); }
    else pop.classList.add('hidden');
  });
  chip.addEventListener('keydown', (e) => { if (e.key === 'Enter') chip.click(); });

  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameEl = document.getElementById('auth-username');
    const passwordEl = document.getElementById('auth-password');
    const error = document.getElementById('auth-error');
    try {
      const data = await submitLogin(usernameEl.value, passwordEl.value);
      localStorage.setItem(TOKEN_KEY, data.token);
      usernameEl.value = '';
      passwordEl.value = '';
      setLoggedInUI();
      window.dispatchEvent(new CustomEvent('auth:login'));
    } catch (err) {
      if (error) error.textContent = err.message;
    }
  });

  // Close the panel / popover when clicking elsewhere.
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) { panel.classList.add('hidden'); pop.classList.add('hidden'); }
  });

  // Keep the control in sync if the token is dropped elsewhere (e.g. a 401 in api.js).
  window.addEventListener('auth:logout', () => { stopHeartbeat(); refreshUI(); });
  window.addEventListener('auth:login', () => { ensureIdentity().then(setLoggedInUI); startHeartbeat(); });

  refreshUI();
  startHeartbeat();

  // First-run bootstrap: no accounts yet -> show the admin setup form.
  needsSetup().then((setup) => {
    if (setup) renderSetup();
  });
}

init();

export { getToken, clearToken, isLoggedIn };
