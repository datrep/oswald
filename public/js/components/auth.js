// components/auth.js
// Lightweight login/logout control that renders into #auth-control.
// Stores the JWT in localStorage so api.js can attach it to requests.

import { getToken, clearToken, isLoggedIn, TOKEN_KEY } from '../api/api.js';

async function submitLogin(username, password) {
  const res = await fetch('/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data.token;
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

function setLoggedInUI() {
  const toggle = document.getElementById('auth-toggle');
  const panel = document.getElementById('auth-panel');
  if (toggle) {
    toggle.textContent = 'Logout';
    toggle.style.transition = 'background 0.2s ease, transform 0.15s ease';
    toggle.style.transform = 'scale(1.05)';
    requestAnimationFrame(() => { toggle.style.transform = 'scale(1)'; });
  }
  if (panel) panel.classList.add('hidden');
  const error = document.getElementById('auth-error');
  if (error) error.textContent = '';
}

function setLoggedOutUI() {
  const toggle = document.getElementById('auth-toggle');
  if (toggle) {
    toggle.textContent = 'Login';
    toggle.style.transition = 'background 0.2s ease, transform 0.15s ease';
    toggle.style.transform = 'scale(1.05)';
    requestAnimationFrame(() => { toggle.style.transform = 'scale(1)'; });
  }
}

function refreshUI() {
  if (isLoggedIn()) setLoggedInUI();
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
      const token = await submitLogin(username, password);
      localStorage.setItem(TOKEN_KEY, token);
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

  toggle.addEventListener('click', () => {
    if (isLoggedIn()) {
      clearToken();
      setLoggedOutUI();
      window.dispatchEvent(new CustomEvent('auth:logout'));
    } else {
      panel.classList.toggle('hidden');
    }
  });

  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameEl = document.getElementById('auth-username');
    const passwordEl = document.getElementById('auth-password');
    const error = document.getElementById('auth-error');
    try {
      const token = await submitLogin(usernameEl.value, passwordEl.value);
      localStorage.setItem(TOKEN_KEY, token);
      usernameEl.value = '';
      passwordEl.value = '';
      setLoggedInUI();
      window.dispatchEvent(new CustomEvent('auth:login'));
    } catch (err) {
      if (error) error.textContent = err.message;
    }
  });

  // Close the panel when clicking elsewhere.
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) panel.classList.add('hidden');
  });

  // Keep the button in sync if the token is dropped elsewhere (e.g. a 401 in api.js).
  window.addEventListener('auth:logout', refreshUI);

  refreshUI();

  // First-run bootstrap: no accounts yet -> show the admin setup form.
  needsSetup().then((setup) => {
    if (setup) renderSetup();
  });
}

init();

export { getToken, clearToken, isLoggedIn };
