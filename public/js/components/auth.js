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
}

init();

export { getToken, clearToken, isLoggedIn };
