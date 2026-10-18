// components/breadcrumb.js — NAV-1 shared breadcrumb.
// Renders "Dashboard › <Page>" into a `#breadcrumb` element. Pages set a
// dynamic name via setBreadcrumbName() (e.g. the Policy Workspace shows the
// loaded policy name). Home (index.html) has no trail and renders nothing.

const TRAILS = {
  '/pages/policy.html': 'Policy',
  '/pages/jobs.html': 'Job Applications',
  '/pages/certs.html': 'Certificates',
  '/pages/career-files.html': 'Career Files',
  '/pages/users.html': 'Users & Permissions',
  '/pages/logs.html': 'API logs',
  '/pages/servers.html': 'Servers',
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initBreadcrumb() {
  const el = document.getElementById('breadcrumb');
  if (!el) return;
  const label = TRAILS[location.pathname];
  if (!label) { el.innerHTML = ''; return; }
  const name = el.dataset.name || label;
  el.innerHTML = `<a href="/index.html">Dashboard</a><span class="sep">›</span><span class="current">${escapeHtml(name)}</span>`;
}

export function setBreadcrumbName(name) {
  const el = document.getElementById('breadcrumb');
  if (el) { el.dataset.name = name || ''; initBreadcrumb(); }
}
