// pages/users.js — Users & Permissions admin page (requires users.manage).
import { apiGet, apiPut, isLoggedIn, getToken } from '../api/api.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

function roleChips(roles) {
  if (!roles.length) return '<span class="muted">—</span>';
  return roles
    .map((r) => `<span class="role-chip${r === 'admin' ? ' admin' : ''}">${escapeHtml(r)}</span>`)
    .join(' ');
}

function renderUsers(users, myId) {
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const isAdmin = u.roles.includes('admin');
    const tr = document.createElement('tr');
    const action = u.id === myId
      ? '<span class="muted">you</span>'
      : isAdmin
        ? `<button class="btn-demote" data-id="${u.id}" data-name="${escapeHtml(u.username)}">Make user</button>`
        : `<button class="btn-promote" data-id="${u.id}" data-name="${escapeHtml(u.username)}">Make admin</button>`;
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}</td>
      <td>${roleChips(u.roles)}</td>
      <td class="actions">${action}</td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const role = btn.classList.contains('btn-promote') ? 'admin' : 'user';
      if (!confirm(`Change "${btn.dataset.name}" to role "${role}"?`)) return;
      try {
        await apiPut(`/api/users/${btn.dataset.id}/role`, { role });
        await load();
      } catch (err) {
        alert('Failed to change role: ' + err.message);
      }
    });
  });
}

function renderMatrix(roles, permissions) {
  const el = document.getElementById('permission-matrix');
  const rows = permissions
    .map((p) => {
      const cells = roles
        .map((r) => (r.permissions.includes(p.code) ? '<td class="yes">✓</td>' : '<td class="no">–</td>'))
        .join('');
      return `<tr><td title="${escapeHtml(p.description || '')}">${escapeHtml(p.code)}</td>${cells}</tr>`;
    })
    .join('');
  const heads = roles.map((r) => `<th>${escapeHtml(r.name)}</th>`).join('');
  el.innerHTML = `<div class="matrix"><table><thead><tr><th>Permission</th>${heads}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function load() {
  const gate = document.getElementById('users-gate');
  const content = document.getElementById('users-content');
  const status = document.getElementById('users-status');

  if (!isLoggedIn() || !hasPerm('users.manage')) {
    content.classList.add('hidden');
    gate.classList.remove('hidden');
    return;
  }
  gate.classList.add('hidden');
  content.classList.remove('hidden');
  status.textContent = 'Loading…';

  try {
    const [{ users }, { roles, permissions }, me] = await Promise.all([
      apiGet('/api/users'),
      apiGet('/api/users/roles'),
      apiGet('/api/users/me'),
    ]);
    renderUsers(users, me.id);
    renderMatrix(roles, permissions);
    status.textContent = `${users.length} user(s) · ${roles.length} role(s) · ${permissions.length} permission(s).`;
  } catch (err) {
    status.textContent = 'Failed to load: ' + err.message;
  }
}

// Re-render when auth changes (login/logout via the topbar control or a 401).
window.addEventListener('auth:login', load);
window.addEventListener('auth:logout', load);

load();
