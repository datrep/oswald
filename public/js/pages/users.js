// pages/users.js — Users & Permissions admin page (requires users.manage).
// Full UAC CRUD: multi-role assignment, enable/disable, password reset, delete,
// and role CRUD with editable permissions. Backed by session revocation — any
// access change logs the affected user(s) out immediately (Users.tokenVersion).
import { apiGet, apiPut, apiPost, apiDelete, isLoggedIn, getToken } from '../api/api.js';

const $ = (id) => document.getElementById(id);
let STATE = { users: [], roles: [], permissions: [], myId: null, editUserId: null, search: '' };

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

function statusChip(user) {
  return user.isActive === false
    ? '<span class="status-chip disabled">Disabled</span>'
    : '<span class="status-chip active">Active</span>';
}

function feedback(msg) {
  $('users-status').textContent = msg;
}

function renderStats() {
  const el = $('uac-stats');
  if (!el) return;
  const active = STATE.users.filter((u) => u.isActive !== false).length;
  el.innerHTML = `
    <span class="uac-stat users"><b>${STATE.users.length}</b> users</span>
    <span class="uac-stat active"><b>${active}</b> active</span>
    <span class="uac-stat disabled"><b>${STATE.users.length - active}</b> disabled</span>
    <span class="uac-stat roles"><b>${STATE.roles.length}</b> roles</span>
    <span class="uac-stat perms"><b>${STATE.permissions.length}</b> permissions</span>
  `;
}

function fmtLastLogin(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Short device label from a user-agent string (mirrors the login capture).
function deviceLabel(ua) {
  if (!ua) return '—';
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

// ---------- Users table ----------
function renderUsers() {
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  const q = (STATE.search || '').toLowerCase();
  const list = STATE.users.filter((u) => !q || u.username.toLowerCase().includes(q));
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">No matching users.</td></tr>';
    return;
  }
  for (const u of list) {
    const isSelf = u.id === STATE.myId;
    const actions = [];
    const menuItems = [];
    if (isSelf) {
      actions.push('<button class="btn btn--sm" data-act="reset">Reset pw</button>');
    } else {
      // Two most-used actions stay visible; the rest live in a "⋯" menu.
      actions.push('<button class="btn btn--sm" data-act="roles">Roles</button>');
      actions.push('<button class="btn btn--sm" data-act="reset">Reset pw</button>');
      menuItems.push(
        u.isActive === false
          ? '<button class="btn btn--sm" data-act="enable">Enable</button>'
          : '<button class="btn btn--sm btn--danger" data-act="disable">Disable</button>'
      );
      menuItems.push('<button class="btn btn--sm btn--danger" data-act="del">Delete</button>');
      actions.push(
        '<span class="row-menu"><button type="button" class="btn btn--sm menu-trigger" title="More actions">⋯</button>' +
          '<div class="menu-pop hidden">' + menuItems.join('') + '</div></span>'
      );
    }
    const tr = document.createElement('tr');
    tr.dataset.id = u.id;
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}${isSelf ? ' <span class="muted">(you)</span>' : ''}</td>
      <td>${roleChips(u.roles)}</td>
      <td>${statusChip(u)}</td>
      <td class="last">${fmtLastLogin(u.lastLoginAt)}</td>
      <td class="device" title="${escapeHtml(u.lastUserAgent || '')}">${escapeHtml(deviceLabel(u.lastUserAgent))}</td>
      <td class="actions">${actions.join(' ')}</td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => act(btn.dataset.act, btn.closest('tr').dataset.id));
  });
}

async function act(name, userId) {
  const u = STATE.users.find((x) => String(x.id) === String(userId));
  if (!u) return;
  try {
    if (name === 'roles') openUserRoles(u);
    else if (name === 'enable') await setActive(u, true);
    else if (name === 'disable') await setActive(u, false);
    else if (name === 'reset') openResetPw(u);
    else if (name === 'del') await removeUser(u);
  } catch (err) {
    feedback('Error: ' + err.message);
  }
}

async function setActive(u, isActive) {
  const verb = isActive ? 'Enable' : 'Disable';
  if (!confirm(`${verb} "${u.username}"?${isActive ? '' : ' All their sessions will be revoked immediately.'}`)) return;
  const r = await apiPut(`/api/users/${u.id}/active`, { isActive });
  feedback(r.message || (isActive ? 'User enabled' : 'User disabled'));
  await load();
}

async function removeUser(u) {
  if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
  const r = await apiDelete(`/api/users/${u.id}`);
  feedback(r.message || 'User deleted');
  await load();
}

// ---------- Modals ----------
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

function openUserRoles(u) {
  STATE.editUserId = u.id;
  $('user-roles-title').textContent = 'Set roles — ' + u.username;
  $('user-roles-body').innerHTML = STATE.roles
    .map(
      (r) => `
        <label class="role-assign">
          <input type="checkbox" value="${escapeHtml(r.name)}" ${u.roles.includes(r.name) ? 'checked' : ''} />
          <span class="role-assign__text">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="muted role-assign__desc">${escapeHtml(r.description || 'no description')}</span>
          </span>
        </label>
      `
    )
    .join('');
  openModal('user-roles-modal');
}

async function saveUserRoles() {
  const roles = [...$('user-roles-body').querySelectorAll('input:checked')].map((i) => i.value);
  const r = await apiPut(`/api/users/${STATE.editUserId}/roles`, { roles });
  feedback(r.message || 'Roles updated');
  closeModal('user-roles-modal');
  await load();
}

function openResetPw(u) {
  STATE.editUserId = u.id;
  $('reset-pw-title').textContent = 'Reset password — ' + u.username;
  $('reset-pw-input').value = '';
  openModal('reset-pw-modal');
}

async function saveResetPw() {
  const pw = $('reset-pw-input').value;
  if (!pw || pw.length < 6) {
    feedback('Password must be at least 6 characters');
    return;
  }
  const r = await apiPut(`/api/users/${STATE.editUserId}/password`, { password: pw });
  feedback(r.message || 'Password reset — sessions revoked');
  closeModal('reset-pw-modal');
}

// ---------- Roles manager ----------
function renderRoles() {
  const el = $('roles-list');
  el.innerHTML = '';
  for (const role of STATE.roles) {
    const card = document.createElement('div');
    card.className = 'card role-card';
    card.dataset.roleId = role.id;
    card.innerHTML = `
      <div class="role-card__head">
        <strong>${escapeHtml(role.name)}</strong>
        <span class="muted" style="font-size:0.72rem">${role.userCount} user(s)</span>
      </div>
      <input type="text" class="role-name" value="${escapeHtml(role.name)}" ${role.name === 'admin' ? 'disabled title="The admin role cannot be renamed or deleted"' : ''} />
      <input type="text" class="role-desc" value="${escapeHtml(role.description || '')}" placeholder="Description" />
      <div class="perm-grid">
        ${STATE.permissions
          .map(
            (p) => `
              <label title="${escapeHtml(p.description || '')}">
                <input type="checkbox" class="perm" value="${escapeHtml(p.code)}" ${role.permissions.includes(p.code) ? 'checked' : ''} />
                <span class="perm-name">${escapeHtml(p.code)}</span>
              </label>
            `
          )
          .join('')}
      </div>
      <div class="role-card-actions">
        <button type="button" class="btn btn--sm btn--primary role-save">Save</button>
        ${role.name === 'admin' ? '' : '<button type="button" class="btn btn--sm btn--danger role-del">Delete</button>'}
      </div>
    `;
    el.appendChild(card);
  }
  el.querySelectorAll('.role-save').forEach((btn) => btn.addEventListener('click', () => saveRole(btn.closest('.role-card'))));
  el.querySelectorAll('.role-del').forEach((btn) => btn.addEventListener('click', () => deleteRole(btn.closest('.role-card'))));
}

async function saveRole(card) {
  const id = Number(card.dataset.roleId);
  const role = STATE.roles.find((r) => r.id === id);
  const name = card.querySelector('.role-name').value.trim();
  const description = card.querySelector('.role-desc').value.trim();
  const permissions = [...card.querySelectorAll('.perm:checked')].map((i) => i.value);
  if (!name) {
    feedback('Role name is required');
    return;
  }
  const r = await apiPut(`/api/users/roles/${id}`, { name, description, permissions });
  feedback(r.message || `Role "${role.name}" updated — holders logged out`);
  await load();
}

async function deleteRole(card) {
  const id = Number(card.dataset.roleId);
  const role = STATE.roles.find((r) => r.id === id);
  if (!confirm(`Delete role "${role.name}"? Users holding it lose it.`)) return;
  const r = await apiDelete(`/api/users/roles/${id}`);
  feedback(r.message || 'Role deleted');
  await load();
}

function openRoleModal() {
  $('role-name').value = '';
  $('role-desc').value = '';
  openModal('role-modal');
}

async function saveNewRole() {
  const name = $('role-name').value.trim();
  const description = $('role-desc').value.trim();
  if (!name) {
    feedback('Role name is required');
    return;
  }
  const r = await apiPost('/api/users/roles', { name, description });
  feedback(r.message || 'Role created');
  closeModal('role-modal');
  await load();
}

async function load() {
  const gate = $('users-gate');
  const content = $('users-content');

  if (!isLoggedIn() || !hasPerm('users.manage')) {
    content.classList.add('hidden');
    gate.classList.remove('hidden');
    return;
  }
  gate.classList.add('hidden');
  content.classList.remove('hidden');
  feedback('Loading…');

  try {
    const [{ users }, { roles, permissions }, me] = await Promise.all([
      apiGet('/api/users'),
      apiGet('/api/users/roles'),
      apiGet('/api/users/me'),
    ]);
    STATE = { users, roles, permissions, myId: me.id, editUserId: null, search: '' };
    if ($('user-search')) $('user-search').value = '';
    renderUsers();
    renderRoles();
    renderStats();
    feedback(`${users.length} user(s) · ${roles.length} role(s) · ${permissions.length} permission(s).`);
  } catch (err) {
    feedback('Failed to load: ' + err.message);
  }
}

function init() {
  $('user-roles-save').addEventListener('click', saveUserRoles);
  $('user-roles-cancel').addEventListener('click', () => closeModal('user-roles-modal'));
  $('user-roles-modal').addEventListener('click', (e) => { if (e.target === $('user-roles-modal')) closeModal('user-roles-modal'); });

  $('reset-pw-save').addEventListener('click', saveResetPw);
  $('reset-pw-cancel').addEventListener('click', () => closeModal('reset-pw-modal'));
  $('reset-pw-modal').addEventListener('click', (e) => { if (e.target === $('reset-pw-modal')) closeModal('reset-pw-modal'); });

  $('role-add').addEventListener('click', openRoleModal);
  $('role-save').addEventListener('click', saveNewRole);
  $('role-cancel').addEventListener('click', () => closeModal('role-modal'));
  $('role-modal').addEventListener('click', (e) => { if (e.target === $('role-modal')) closeModal('role-modal'); });

  const search = $('user-search');
  if (search) {
    search.addEventListener('input', () => {
      STATE.search = search.value;
      renderUsers();
    });
  }

  // Row "⋯" menu: clicking the trigger toggles its popover and closes the others;
  // any outside click closes all open menus.
  document.addEventListener('click', (e) => {
    const trig = e.target.closest('.menu-trigger');
    const pop = trig ? trig.closest('.row-menu').querySelector('.menu-pop') : null;
    document.querySelectorAll('.menu-pop').forEach((p) => {
      if (p !== pop) p.classList.add('hidden');
    });
    if (pop) pop.classList.toggle('hidden');
  });

  // Re-render when auth changes (login/logout via the topbar control or a 401).
  window.addEventListener('auth:login', load);
  window.addEventListener('auth:logout', load);
}

init();
load();
