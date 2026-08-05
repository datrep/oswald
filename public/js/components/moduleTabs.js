// components/moduleTabs.js
// Shared module-page switcher for the personal module pages (MOD framework).
// Renders a tab bar into #module-tabs so the user can hop between module pages
// (Job Applications / Career Files today; Certificates etc. later) from either.
//
// FUTURE SCOPE: a new module page = add one entry to MODULE_TABS + a #module-tabs
// div + initModuleTabs() call on that page.

const MODULE_TABS = [
  { id: 'jobs', label: 'Job Applications', page: '/pages/jobs.html' },
  { id: 'career_files', label: 'Career Files', page: '/pages/career-files.html' },
  { id: 'certificates', label: 'Certificates', page: '/pages/certs.html' },
];

export function initModuleTabs() {
  const mount = document.getElementById('module-tabs');
  if (!mount) return;
  const current = location.pathname.replace(/^\/+/, ''); // e.g. "pages/jobs.html"
  mount.innerHTML = MODULE_TABS.map((m) => {
    const active = current === m.page.replace(/^\/+/, '');
    return `<a class="module-tab${active ? ' active' : ''}" href="${m.page}">${m.label}</a>`;
  }).join('');
}
