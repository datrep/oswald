// Oswald Fileserver — FS-1 local web UI.
import { FS } from './api.js';
import { openViewer, closeViewer, getFileKind, escapeHtml } from './viewer.js';

const $ = (id) => document.getElementById(id);

const state = {
  roots: [],
  root: null,          // current root id
  path: '',            // current rel path ('' = root)
  view: 'list',        // 'list' | 'grid'
  sortBy: 'name',
  sortDir: 1,
  filter: 'all',
  query: '',
  favOnly: false,      // FS-2: favorites-only filter
  tagFilter: '',       // FS-2: active tag filter
  access: null,        // FS-2: effective {read,write,admin} for the current folder
  favSet: new Set(),   // "root|path" favorites
  tagsByPath: new Map(), // "root|path" -> [tags]
  tagsAll: [],
  nodeMap: new Map(),  // tree rel -> {expanded}
  mode: 'fileserver',  // ARCH: 'fileserver' (drop/upload) | 'mirror' (sync, read-only)
  zoom: 1,             // grid thumbnail zoom 0.4-2.5x (ctrl+scrollwheel on #file-list)
};

const KIND_ICON = {
  dir: 'DIR', image: 'IMG', pdf: 'PDF', text: 'TXT', audio: 'AUD',
  video: 'VID', office: 'DOC', archive: 'ZIP', other: 'FILE',
};

// ---------- helpers ----------
function joinRel(path, name) {
  if (!path) return name;
  return path.replace(/\/+$/, '') + '/' + name;
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function toast(msg) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- cached UI state (sort, list/grid) ----------
const FS_STATE_KEY = 'oswald_fs_state';

function saveFsState() {
  try {
    localStorage.setItem(FS_STATE_KEY, JSON.stringify({ view: state.view, sortBy: state.sortBy, sortDir: state.sortDir, zoom: state.zoom }));
  } catch { /* ignore */ }
}

function loadFsState() {
  try {
    const raw = localStorage.getItem(FS_STATE_KEY);
    const s = raw ? JSON.parse(raw) : {};
    if (s.view === 'list' || s.view === 'grid') state.view = s.view;
    if (['name', 'size', 'mtime'].includes(s.sortBy)) state.sortBy = s.sortBy;
    if (s.sortDir === 1 || s.sortDir === -1) state.sortDir = s.sortDir;
    if (typeof s.zoom === 'number' && s.zoom >= 0.4 && s.zoom <= 2.5) state.zoom = s.zoom;
  } catch { /* ignore */ }
}

// Grid zoom (0.4-2.5x): ctrl+scrollwheel over #file-list (the only zoomed element).
function applyZoom() {
  $('file-list').style.setProperty('--fs-zoom', state.zoom);
}
function zoomBy(factor) {
  state.zoom = Math.min(2.5, Math.max(0.4, Math.round(state.zoom * factor * 100) / 100));
  applyZoom();
  saveFsState();
}

// List-view column header ("titles on top").
function listHeader() {
  return '<div class="fs-list-head"><span>Name</span><span>Size</span><span>Modified</span></div>';
}

function syncViewControls() {
  $('view-list').classList.toggle('active', state.view === 'list');
  $('view-grid').classList.toggle('active', state.view === 'grid');
  $('sort-select').value = state.sortBy;
  $('sort-dir').textContent = state.sortDir === 1 ? '↑' : '↓';
}

// ---------- FS-2: favorites + tags ----------
function favKey(root, rel) { return root + '|' + rel; }
function isFav(root, rel) { return state.favSet.has(favKey(root, rel)); }

async function loadFavorites() {
  try {
    const { favorites } = await FS.favorites();
    state.favSet = new Set(favorites.map((f) => favKey(f.rootId, f.filePath)));
  } catch {
    state.favSet = new Set();
  }
}

async function loadTagsAll() {
  try {
    const { tags } = await FS.tagsAll();
    state.tagsAll = tags.map((t) => t.tag);
    const sel = $('tag-filter');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All tags</option>' +
      state.tagsAll.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    sel.value = state.tagsAll.includes(cur) ? cur : '';
  } catch {
    state.tagsAll = [];
  }
}

async function toggleFav(root, rel) {
  const key = favKey(root, rel);
  try {
    if (isFav(root, rel)) {
      await FS.favoriteRemove(root, rel);
      state.favSet.delete(key);
      toast('Removed from favorites');
    } else {
      await FS.favoriteAdd(root, rel);
      state.favSet.add(key);
      toast('Favorited');
    }
    document.querySelectorAll('.fav-star').forEach((s) => {
      if (s.dataset.key === key) s.classList.toggle('on', isFav(root, rel));
    });
  } catch (err) {
    toast(err.message);
  }
}

// Fetch + cache tags for the file entries in a listing (parallel).
async function loadTagsFor(entries) {
  const targets = [];
  for (const e of entries) {
    if (e.isDir) continue;
    targets.push({ key: favKey(state.root, joinRel(state.path, e.name)), rel: joinRel(state.path, e.name) });
  }
  await Promise.allSettled(
    targets.map(async ({ key, rel }) => {
      try {
        const { tags } = await FS.tags(state.root, rel);
        state.tagsByPath.set(key, tags);
      } catch {
        state.tagsByPath.set(key, []);
      }
    })
  );
}

function tagsFor(root, rel) {
  return state.tagsByPath.get(favKey(root, rel)) || [];
}

// ---------- auth ----------
function showLogin() { $('modal-login').classList.add('show'); }

let loginMode = 'signin';

function setLoginMode(mode) {
  loginMode = mode;
  $('login-title').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('login-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('login-pass2').classList.toggle('hidden', mode !== 'signup');
  $('login-toggle').textContent = mode === 'signup' ? 'Already have an account? Sign in' : 'No account? Sign up';
  $('login-error').classList.add('hidden');
}

// Hide the sign-up link if the server has self-registration disabled.
async function applyBootstrap() {
  try {
    const { allowSignup } = await FS.config();
    $('login-toggle').classList.toggle('hidden', !allowSignup);
  } catch { /* ignore */ }
}

async function initAuth() {
  if (!FS.isLoggedIn()) { showLogin(); return; }
  // Fresh load with a stored session: hide the login modal (it starts .show in HTML).
  $('modal-login').classList.remove('show');
  // Ensure the session cookie exists (media requests over HTTPS need it).
  setSessionCookie(FS.getToken());
  try {
    await FS.roots(); // validates token
  } catch {
    showLogin();
  }
}

function setSessionCookie(token) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `oswald_fs_token=${encodeURIComponent(token)}; path=/; SameSite=Lax${secure}`;
}

function clearSessionCookie() {
  document.cookie = 'oswald_fs_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

async function handleLogin(e) {
  e.preventDefault();
  const user = $('login-user').value.trim();
  const pass = $('login-pass').value;
  const pass2 = $('login-pass2').value;
  const errEl = $('login-error');
  const wasSignup = loginMode === 'signup';
  errEl.classList.add('hidden');
  if (!user || !pass) { errEl.textContent = 'Enter username and password.'; errEl.classList.remove('hidden'); return; }
  try {
    if (wasSignup) {
      if (pass !== pass2) { errEl.textContent = 'Passwords do not match.'; errEl.classList.remove('hidden'); return; }
      if (pass.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.classList.remove('hidden'); return; }
      await FS.register(user, pass); // creates a read-only account
    }
    const body = await FS.login(user, pass);
    FS.setToken(body.token);
    setSessionCookie(body.token);
    $('modal-login').classList.remove('show');
    $('login-user').value = '';
    $('login-pass').value = '';
    $('login-pass2').value = '';
    setLoginMode('signin');
    toast(wasSignup ? `Account created — signed in as ${user}` : `Signed in as ${user}`);
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

function signOut() {
  FS.clearToken();
  clearSessionCookie();
  location.reload();
}

// ---------- roots + tree ----------
async function loadRoots() {
  const { roots } = await FS.roots();
  state.roots = roots;
  if (!state.root && roots.length) state.root = roots[0].id;

  const sel = $('root-select');
  sel.innerHTML = '';
  for (const r of roots) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.name;
    sel.appendChild(o);
  }
  sel.value = state.root;
  renderTree();
}

function renderTree() {
  const tree = $('fs-tree');
  tree.innerHTML = '';
  for (const r of state.roots) {
    const rootEl = document.createElement('div');
    rootEl.className = 'tree-root' + (r.id === state.root ? ' active' : '');
    const caret = r.id === state.root ? '<span class="caret">▾</span>' : '<span class="caret">›</span>';
    rootEl.innerHTML = `${caret}<svg class="icon tree-folder-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>${r.name}</span>`;
    rootEl.onclick = async () => {
      state.root = r.id;
      state.path = '';
      $('root-select').value = r.id;
      state.nodeMap.clear();
      await reload();
    };
    tree.appendChild(rootEl);
    if (r.id === state.root) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      children.dataset.root = r.id;
      children.dataset.rel = '';
      tree.appendChild(children);
      expandNode(children, r.id, '');
    }
  }
}

async function expandNode(container, root, rel) {
  container.innerHTML = '<div class="muted tiny" style="padding:6px 8px">Loading…</div>';
  try {
    const data = await FS.list(root, rel);
    const dirs = data.entries.filter((e) => e.isDir);
    if (!dirs.length) {
      container.innerHTML = '<div class="muted tiny" style="padding:6px 8px">(empty)</div>';
      return;
    }
    container.innerHTML = '';
    for (const d of dirs) {
      const rel2 = joinRel(rel, d.name);
      const node = document.createElement('div');
      node.className = 'tree-node' + (state.root === root && state.path === rel2 ? ' active' : '');
      const expanded = state.nodeMap.get(rel2)?.expanded;
      node.innerHTML = `<span class="caret">${expanded ? '▾' : '›'}</span><svg class="icon tree-folder-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>${d.name}</span>`;
      const childBox = document.createElement('div');
      childBox.className = 'tree-children';
      childBox.dataset.root = root;
      childBox.dataset.rel = rel2;
      node.onclick = async (ev) => {
        ev.stopPropagation();
        state.root = root;
        state.path = rel2;
        $('root-select').value = root;
        const cur = state.nodeMap.get(rel2) || { expanded: false };
        cur.expanded = !cur.expanded;
        state.nodeMap.set(rel2, cur);
        if (cur.expanded) { await expandNode(childBox, root, rel2); } else { childBox.innerHTML = ''; }
        renderTree();
        renderBreadcrumb();
        await loadDir();
      };
      node.appendChild(childBox);
      container.appendChild(node);
      if (expanded) await expandNode(childBox, root, rel2);
    }
  } catch (err) {
    container.innerHTML = `<div class="muted tiny" style="padding:6px 8px">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- breadcrumb ----------
function renderBreadcrumb() {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  const parts = state.path ? state.path.split('/') : [];
  const segs = [{ label: state.roots.find((r) => r.id === state.root)?.name || state.root, rel: '' }];
  let acc = '';
  for (const p of parts) {
    acc = acc ? acc + '/' + p : p;
    segs.push({ label: p, rel: acc });
  }
  segs.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb sep';
      sep.textContent = '/';
      bc.appendChild(sep);
    }
    const c = document.createElement('span');
    c.className = 'crumb' + (i === segs.length - 1 ? ' current' : '');
    c.textContent = seg.label;
    if (i < segs.length - 1) {
      c.onclick = async () => { state.path = seg.rel; await reload(); };
    }
    bc.appendChild(c);
  });
}

// ---------- directory listing ----------
function sortEntries(entries) {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);
  const cmp = (a, b) => {
    const dir = state.sortDir;
    if (state.sortBy === 'size') return (a.size || 0) < (b.size || 0) ? dir : -dir;
    if (state.sortBy === 'mtime') return (a.mtime || '') < (b.mtime || '') ? dir : -dir;
    return a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
  };
  return [...dirs.sort(cmp), ...files.sort(cmp)];
}

function matchesFilter(e) {
  if (state.filter === 'all') return true;
  if (state.filter === 'other') return !['image', 'office', 'pdf', 'text', 'audio', 'video', 'archive'].includes(e.kind);
  return e.kind === state.filter;
}

async function loadDir() {
  const list = $('file-list');
  try {
    const data = await FS.list(state.root, state.path);
    state.access = data.access || null;
    $('btn-upload').classList.toggle('hidden', !data.access?.write);
    $('btn-newfolder').classList.toggle('hidden', !data.access?.write);
    $('btn-newfile').classList.toggle('hidden', !data.access?.write);
    let entries = sortEntries(data.entries).filter(matchesFilter);
    if (state.favOnly) entries = entries.filter((e) => isFav(state.root, joinRel(state.path, e.name)));
    if (state.tagFilter) entries = entries.filter((e) => e.isDir || tagsFor(state.root, joinRel(state.path, e.name)).includes(state.tagFilter));
    const shown = state.favOnly || state.tagFilter ? ` (${entries.length} shown)` : '';
    $('dir-info').textContent = `${data.entries.length} item${data.entries.length === 1 ? '' : 's'}${shown}`;
    list.dataset.mode = 'dir';
    list.classList.toggle('list-mode', state.view === 'list');
    list.classList.toggle('grid-mode', state.view === 'grid');
    list.classList.remove('searching');
    if (!entries.length) {
      list.innerHTML = '<div class="fs-empty">This folder is empty — drop files here to upload.</div>';
      return;
    }
    await loadTagsFor(entries);
    list.innerHTML = state.view === 'grid' ? renderGrid(entries) : renderRows(entries);
    renderBreadcrumb();
  } catch (err) {
    list.innerHTML = `<div class="fs-empty">${escapeHtml(err.message)}</div>`;
  }
}

function rowActions(entry, canWrite) {
  const rel = joinRel(state.path, entry.name);
  const writeActions = canWrite
    ? `${!entry.isDir && (entry.kind === 'text' || entry.kind === 'image') ? `<button data-act="edit" title="Edit"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>` : ''}
      <button data-act="rename" title="Rename"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
      <button data-act="move" title="Move"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg></button>
      <button data-act="del" class="act-del" title="Delete"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`
    : '';
  return `
    <div class="row-actions">
      ${!entry.isDir ? `<a href="${FS.downloadUrl(state.root, rel)}" download title="Download"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>` : ''}
      ${writeActions}
    </div>`;
}

function renderRows(entries) {
  const canWrite = !!state.access?.write;
  return listHeader() + entries.map((e) => {
    const rel = joinRel(state.path, e.name);
    const key = favKey(state.root, rel);
    const iconCls = e.isDir ? 'dir' : 'k-' + (e.kind || 'other');
    const star = `<button class="fav-star${isFav(state.root, rel) ? ' on' : ''}" data-key="${key}" title="Favorite">★</button>`;
    const tags = e.isDir ? '' : tagsFor(state.root, rel).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');
    return `<div class="fs-row" data-rel="${escapeHtml(rel)}" data-name="${escapeHtml(e.name)}" data-kind="${e.isDir ? 'dir' : e.kind}">
      <div class="name"><span class="file-icon ${iconCls}">${KIND_ICON[e.isDir ? 'dir' : e.kind] || 'FILE'}</span><span title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>${star}${tags ? `<span class="tag-line">${tags}</span>` : ''}</div>
      <div class="size">${e.isDir ? '—' : fmtBytes(e.size)}</div>
      <div class="mtime">${fmtTime(e.mtime)}</div>
      ${rowActions(e, canWrite)}
    </div>`;
  }).join('');
}

function renderGrid(entries) {
  return entries.map((e) => {
    const rel = joinRel(state.path, e.name);
    const key = favKey(state.root, rel);
    const iconCls = e.isDir ? 'dir' : 'k-' + (e.kind || 'other');
    const thumb = e.isDir
      ? `<div class="thumb"><span class="file-icon dir">DIR</span></div>`
      : e.kind === 'image'
        ? `<div class="thumb"><img loading="lazy" src="${FS.thumbUrl(state.root, rel)}" alt="${escapeHtml(e.name)}" onerror="this.outerHTML='<span class=&quot;file-icon k-image&quot;>IMG</span>'"></div>`
        : `<div class="thumb"><span class="file-icon ${iconCls}">${KIND_ICON[e.kind] || 'FILE'}</span></div>`;
    const star = `<button class="fav-star grid${isFav(state.root, rel) ? ' on' : ''}" data-key="${key}" title="Favorite">★</button>`;
    const tags = e.isDir ? '' : tagsFor(state.root, rel).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');
    return `<div class="fs-grid-card" data-rel="${escapeHtml(rel)}" data-name="${escapeHtml(e.name)}" data-kind="${e.isDir ? 'dir' : e.kind}">
      ${thumb}
      ${star}
      <div class="gname" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
      ${tags ? `<div class="g-tags">${tags}</div>` : ''}
    </div>`;
  }).join('');
}

// ---------- search ----------
async function runSearch() {
  const q = state.query.trim();
  const list = $('file-list');
  if (!q) { await loadDir(); return; }
  try {
    const { results } = await FS.search(state.root, q, state.path);
    $('dir-info').textContent = `${results.length} result${results.length === 1 ? '' : 's'} for “${q}”`;
    list.dataset.mode = 'search';
    list.classList.add('list-mode');
    list.classList.remove('grid-mode');
    list.classList.add('searching');
    if (!results.length) {
      list.innerHTML = `<div class="fs-empty">No matches for “${escapeHtml(q)}”.</div>`;
      return;
    }
    list.innerHTML = listHeader() + results.map((e) => {
      const iconCls = e.isDir ? 'dir' : 'k-' + (e.kind || 'other');
      return `<div class="fs-row" data-rel="${escapeHtml(e.rel)}" data-name="${escapeHtml(e.name)}" data-kind="${e.isDir ? 'dir' : e.kind}">
        <div class="name"><span class="file-icon ${iconCls}">${KIND_ICON[e.isDir ? 'dir' : e.kind] || 'FILE'}</span><span title="${escapeHtml(e.name)}">${escapeHtml(e.rel)}</span></div>
        <div class="size">${e.isDir ? '—' : fmtBytes(e.size)}</div>
        <div class="mtime">—</div>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="fs-empty">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- actions ----------
function navigateTo(rel, name) {
  state.path = rel;
  state.query = '';
  $('search-input').value = '';
  reload();
}

function openEntry(entry, mode) {
  const write = !!state.access?.write;
  if (mode === 'search') {
    if (entry.kind === 'dir') { navigateTo(entry.rel); return; }
    openViewer({ root: state.root, rel: entry.rel, name: entry.name, write });
    return;
  }
  const rel = joinRel(state.path, entry.name);
  if (entry.kind === 'dir') { navigateTo(rel); return; }
  openViewer({ root: state.root, rel, name: entry.name, write });
}

async function handleListClick(ev) {
  const row = ev.target.closest('.fs-row, .fs-grid-card');
  if (!row) return;
  const mode = $('file-list').dataset.mode || 'dir';
  const actBtn = ev.target.closest('[data-act]');
  const entry = { rel: row.dataset.rel, name: row.dataset.name, kind: row.dataset.kind, write: !!state.access?.write };

  const favStar = ev.target.closest('.fav-star');
  if (favStar) {
    ev.stopPropagation();
    toggleFav(state.root, entry.rel);
    return;
  }

  if (actBtn) {
    ev.stopPropagation();
    const act = actBtn.dataset.act;
    if (act === 'rename') return openRename(entry, mode);
    if (act === 'move') return openMove(entry, mode);
    if (act === 'del') return confirmDelete(entry, mode);
    if (act === 'edit') return openEditor(entry.root || state.root, entry.rel, entry.name);
    return;
  }
  const anchor = ev.target.closest('a[download]');
  if (anchor) { ev.stopPropagation(); return; }
  openEntry(entry, mode);
}

function openRename(entry, mode) {
  const modal = $('modal-rename');
  $('rename-title').textContent = `Rename “${entry.name}”`;
  const input = $('rn-input');
  input.value = entry.name;
  modal.classList.add('show');
  input.focus();
  input.select();
  input._onOk = async () => {
    const newName = input.value.trim();
    if (!newName || newName === entry.name) { modal.classList.remove('show'); return; }
    try {
      await FS.rename(state.root, entry.rel, newName);
      toast('Renamed');
      modal.classList.remove('show');
      await reload();
    } catch (err) { toast(err.message); }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') input._onOk(); if (e.key === 'Escape') modal.classList.remove('show'); };
}

function confirmDelete(entry, mode) {
  const modal = $('modal-confirm');
  $('confirm-title').textContent = entry.kind === 'dir' ? 'Delete folder?' : 'Delete file?';
  $('confirm-text').textContent = `“${entry.name}” will be permanently deleted. This cannot be undone.`;
  modal.classList.add('show');
  $('confirm-ok').onclick = async () => {
    try {
      await FS.remove(state.root, entry.rel);
      toast('Deleted');
      modal.classList.remove('show');
      await reload();
    } catch (err) { toast(err.message); }
  };
}

async function openMove(entry, mode) {
  const modal = $('modal-move');
  $('move-title').textContent = `Move “${entry.name}” to…`;
  const treeEl = $('move-tree');
  treeEl.innerHTML = '<div class="muted tiny">Loading…</div>';
  modal.classList.add('show');
  const sel = { root: state.root, rel: entry.kind === 'dir' ? entry.rel.split('/').slice(0, -1).join('/') : state.path };
  const render = async () => {
    treeEl.innerHTML = '';
    for (const r of state.roots) {
      const rootRow = document.createElement('div');
      rootRow.className = 'mt-node mt-root' + (sel.root === r.id && sel.rel === '' ? ' selected' : '');
      rootRow.innerHTML = `<svg class="icon tree-folder-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>${r.name}</span>`;
      rootRow.onclick = () => { sel.root = r.id; sel.rel = ''; render(); };
      treeEl.appendChild(rootRow);
      if (sel.root === r.id && sel.rel.startsWith('')) {
        await renderMoveChildren(treeEl, r.id, '', sel, render, 0);
      }
    }
  };
  await render();
  $('move-ok').onclick = async () => {
    try {
      await FS.move(state.root, entry.rel, sel.root, sel.rel);
      toast('Moved');
      modal.classList.remove('show');
      await reload();
    } catch (err) { toast(err.message); }
  };
}

async function renderMoveChildren(container, root, rel, sel, rerender, depth) {
  if (depth > 5) return;
  try {
    const data = await FS.list(root, rel);
    const dirs = data.entries.filter((e) => e.isDir);
    const box = document.createElement('div');
    box.className = 'mt-children';
    container.appendChild(box);
    for (const d of dirs) {
      const rel2 = joinRel(rel, d.name);
      const row = document.createElement('div');
      row.className = 'mt-node' + (sel.root === root && sel.rel === rel2 ? ' selected' : '');
      row.innerHTML = `<svg class="icon tree-folder-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>${d.name}</span>`;
      row.onclick = (ev) => {
        ev.stopPropagation();
        sel.root = root;
        sel.rel = rel2;
        rerender();
      };
      box.appendChild(row);
      await renderMoveChildren(row, root, rel2, sel, rerender, depth + 1);
    }
  } catch { /* ignore */ }
}

// ---------- text editor ----------
async function openEditor(root, rel, name) {
  const modal = $('modal-textedit');
  const ta = $('editor-body');
  $('editor-title').textContent = name;
  $('editor-status').textContent = 'Loading…';
  ta.value = '';
  modal.classList.add('show');
  try {
    ta.value = await FS.getContent(root, rel);
    $('editor-status').textContent = 'Editing — Ctrl+S to save.';
  } catch (err) {
    $('editor-status').textContent = err.message;
    ta.value = '';
  }
  $('editor-save').onclick = () => saveEditor(root, rel);
  ta.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEditor(root, rel); } };
  ta.focus();
}

async function saveEditor(root, rel) {
  const ta = $('editor-body');
  const status = $('editor-status');
  status.textContent = 'Saving…';
  try {
    await FS.saveContent(root, rel, ta.value);
    status.textContent = 'Saved ✓';
    toast('Saved');
  } catch (err) {
    status.textContent = 'Save failed: ' + err.message;
  }
}

// ---------- upload (with progress meter) ----------
function showUploadProgress(pct, label) {
  const bar = $('upload-progress');
  if (!bar) return;
  bar.classList.remove('hidden');
  const fill = $('upload-progress-fill');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  const text = $('upload-progress-text');
  if (text) text.textContent = label || (pct > 0 ? `Uploading… ${Math.round(pct)}%` : 'Starting upload…');
}

function hideUploadProgress() {
  const bar = $('upload-progress');
  if (bar) bar.classList.add('hidden');
}

async function uploadFiles(files) {
  if (!files || !files.length) return;
  showUploadProgress(0, 'Starting upload…');
  try {
    const body = await FS.upload(state.root, state.path, files, (pct) => showUploadProgress(pct));
    hideUploadProgress();
    const n = body.added.length;
    toast(`Uploaded ${n} item${n === 1 ? '' : 's'} (ZIPs stored as-is, no extract)`);
    await reload();
  } catch (err) {
    hideUploadProgress();
    toast(err.message);
  }
}

function initUpload() {
  const input = $('file-input');
  $('btn-upload').onclick = () => input.click();
  input.onchange = async () => { await uploadFiles([...input.files]); input.value = ''; };

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) await uploadFiles([...e.dataTransfer.files]);
  });
}

// ---------- modals / misc wiring ----------
function bindModals() {
  const closers = [
    ['modal-newfolder', 'nf-cancel'],
    ['modal-newfile', 'nfile-cancel'],
    ['modal-rename', 'rn-cancel'],
    ['modal-move', 'move-cancel'],
    ['modal-confirm', 'confirm-cancel'],
    ['modal-textedit', 'editor-cancel'],
    ['modal-viewer', 'viewer-close'],
    ['modal-share', 'share-cancel'],
  ];
  for (const [mid, btnId] of closers) {
    $(btnId).onclick = () => $(mid).classList.remove('show');
  }
  $('share-close').onclick = () => $('modal-share').classList.remove('show');
  $('btn-share').onclick = openShare;
  // outside click + Escape closes modals
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal.show').forEach((m) => {
        if (m.id !== 'modal-login') m.classList.remove('show');
      });
    }
  });

  $('nf-ok').onclick = async () => {
    const name = $('nf-input').value.trim();
    if (!name) return;
    try {
      await FS.makeDir(state.root, state.path, name);
      $('modal-newfolder').classList.remove('show');
      $('nf-input').value = '';
      toast('Folder created');
      await reload();
    } catch (err) { toast(err.message); }
  };
  $('nf-input').onkeydown = (e) => { if (e.key === 'Enter') $('nf-ok').click(); };
  $('rn-ok').onclick = () => $('rn-input')._onOk?.();
  $('rn-input').onkeydown = (e) => { if (e.key === 'Enter') $('rn-input')._onOk?.(); };

  $('btn-newfolder').onclick = () => { $('modal-newfolder').classList.add('show'); $('nf-input').focus(); };

  // New file (type-selectable on creation)
  $('nfile-type').onchange = () => {
    $('nfile-custom-ext').classList.toggle('hidden', $('nfile-type').value !== 'custom');
  };
  $('nfile-ok').onclick = async () => {
    const base = $('nfile-input').value.trim();
    if (!base) return;
    let ext = $('nfile-type').value;
    if (ext === 'custom') ext = ($('nfile-custom-ext').value.trim() || '.txt').replace(/^\.?/, '.');
    try {
      await FS.makeFile(state.root, state.path, base + ext);
      $('modal-newfile').classList.remove('show');
      $('nfile-input').value = '';
      $('nfile-custom-ext').value = '';
      toast('File created');
      await reload();
    } catch (err) { toast(err.message); }
  };
  $('nfile-input').onkeydown = (e) => { if (e.key === 'Enter') $('nfile-ok').click(); };
  $('btn-newfile').onclick = () => { $('modal-newfile').classList.add('show'); $('nfile-input').focus(); };

  $('viewer-edit').onclick = () => {
    const b = $('viewer-edit');
    if (b.dataset.rel) { closeViewer(); openEditor(state.root, b.dataset.rel, b.dataset.rel.split('/').pop()); }
  };
}

// ---------- FS-2: Share / folder permissions (files.admin) ----------
async function openShare() {
  const modal = $('modal-share');
  const container = $('share-users');
  $('share-path').textContent = `${state.root}${state.path ? '/' + state.path : ' (whole root)'}`;
  container.innerHTML = '<div class="muted tiny">Loading…</div>';
  modal.classList.add('show');
  try {
    const [{ users }, { acls }] = await Promise.all([FS.users(), FS.acl(state.root)]);
    const folderPath = state.path;
    const byUser = new Map();
    for (const a of acls) if (a.folderPath === folderPath) byUser.set(a.userId, a);
    container.innerHTML = '';
    for (const u of users) {
      const a = byUser.get(u.id);
      const row = document.createElement('div');
      row.className = 'share-user';
      row.dataset.userId = u.id;
      row.innerHTML = `
        <span class="su-name">${escapeHtml(u.username)}</span>
        <label><input type="checkbox" class="su-read" ${a?.canRead ? 'checked' : ''}> read</label>
        <label><input type="checkbox" class="su-write" ${a?.canWrite ? 'checked' : ''}> write</label>
      `;
      container.appendChild(row);
    }
    $('share-save').onclick = async () => {
      try {
        for (const row of container.querySelectorAll('.share-user')) {
          const userId = Number(row.dataset.userId);
          const read = row.querySelector('.su-read').checked;
          const write = row.querySelector('.su-write').checked;
          if (!read && !write) {
            await FS.aclRemove(userId, state.root, folderPath);
          } else {
            await FS.aclSave({ userId, rootId: state.root, folderPath, canRead: read, canWrite: write });
          }
        }
        toast('Permissions saved');
        modal.classList.remove('show');
      } catch (err) {
        toast(err.message);
      }
    };
  } catch (err) {
    container.innerHTML = `<div class="muted tiny">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- FS-3: one-way mirror sync (files.admin) ----------
async function runSync() {
  try {
    const direction = $('sync-direction').value || 'push';
    await FS.syncNow(direction);
    toast(direction === 'collect' ? 'Collect started…' : 'Sync started…');
    const poll = async () => {
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const { running, lastRun } = await FS.syncStatus();
        if (!running) {
          if (lastRun && lastRun.error) {
            toast('Sync error: ' + lastRun.error);
          } else if (lastRun) {
            toast(`Sync done: +${lastRun.added} ~${lastRun.updated} -${lastRun.deleted} (${lastRun.unchanged} unchanged)${lastRun.errors?.length ? ` ⚠${lastRun.errors.length} errors` : ''}`);
          } else {
            toast('Sync done');
          }
          return;
        }
      }
    };
    poll();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- reload / boot ----------
async function reload() {
  renderTree();
  renderBreadcrumb();
  if (state.query.trim()) await runSearch();
  else await loadDir();
}

// ---------- Settings (admin) ----------
const settingsDraft = { roots: [] };

function settingsNum(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function settingsRow(label, control) {
  return `<div class="settings-field"><label>${label}</label>${control}</div>`;
}

function settingsCheck(id, checked) {
  return `<label class="settings-check"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></label>`;
}

function settingsRootRow(r) {
  return `
    <div class="settings-root-row">
      <input type="text" class="sr-id" placeholder="id" value="${escapeHtml(r.id || '')}">
      <input type="text" class="sr-name" placeholder="name" value="${escapeHtml(r.name || '')}">
      <input type="text" class="sr-path" placeholder="C:\\path\\to\\folder" value="${escapeHtml(r.path || '')}">
      <button type="button" class="sr-remove" title="Remove root">✕</button>
    </div>`;
}

function settingsFeedback(msg, ok) {
  const fb = $('settings-feedback');
  if (!fb) return;
  fb.textContent = msg;
  fb.classList.toggle('settings-feedback-ok', !!ok);
  fb.classList.toggle('settings-feedback-err', !ok);
  clearTimeout(fb._to);
  if (msg) fb._to = setTimeout(() => { fb.textContent = ''; }, 4000);
}

function renderSettings() {
  const body = $('settings-body');
  if (!body) return;
  const d = settingsDraft;
  const groups = [
    ['General', settingsRow('Allow self-signup', settingsCheck('st-allowSignup', !!d.allowSignup))],
    ['Storage roots — custom file paths',
      `<div id="st-roots" class="settings-roots">${(d.roots || []).map(settingsRootRow).join('')}</div>
       <button type="button" id="st-roots-add" class="btn ghost tiny">+ Add root</button>
       <p class="muted tiny">The first root is the default browse root. Path changes take effect immediately (no restart).</p>`],
    ['One-way Sync (FS-3)',
      settingsRow('Source', `<input type="text" id="st-sync-source" value="${escapeHtml(d.sync?.source || '')}">`) +
      settingsRow('Destination', `<input type="text" id="st-sync-destination" value="${escapeHtml(d.sync?.destination || '')}">`) +
      settingsRow('Delete extraneous', settingsCheck('st-sync-delete', d.sync?.deleteExtraneous !== false)) +
      settingsRow('Interval (minutes, 0 = manual)', `<input type="number" id="st-sync-interval" min="0" value="${settingsNum(d.sync?.intervalMinutes, 0)}">`)],
    ['Mirror (read-only replica)',
      settingsRow('Mirror path', `<input type="text" id="st-mirror-path" value="${escapeHtml(d.mirror?.mirrorPath || '')}">`) +
      settingsRow('Read-only', settingsCheck('st-mirror-readonly', d.mirror?.readOnly !== false))],
    ['Search',
      settingsRow('Max depth', `<input type="number" id="st-search-depth" min="1" value="${settingsNum(d.search?.maxDepth, 6)}">`) +
      settingsRow('Max results', `<input type="number" id="st-search-results" min="1" value="${settingsNum(d.search?.maxResults, 200)}">`)],
    ['Thumbnails',
      settingsRow('Size (px)', `<input type="number" id="st-thumb-size" min="16" value="${settingsNum(d.thumbnails?.size, 256)}">`) +
      settingsRow('Cache directory', `<input type="text" id="st-thumb-cachedir" value="${escapeHtml(d.thumbnails?.cacheDir || '')}">`)],
    ['Text editor',
      settingsRow('Max file size (bytes)', `<input type="number" id="st-editor-maxbytes" min="1024" value="${settingsNum(d.textEdit?.maxBytes, 5242880)}">`)],
    ['Runtime (read-only)',
      `<div class="settings-kv"><span>Mode</span><code>${escapeHtml(d.mode || '')}</code></div>` +
      `<div class="settings-kv"><span>Host</span><code>${escapeHtml(d.host || '')}</code></div>` +
      `<div class="settings-kv"><span>Port</span><code>${escapeHtml(d.port || '')}</code></div>` +
      `<div class="settings-kv"><span>Dashboard</span><code>${escapeHtml(d.dashboardBase || '')}</code></div>`],
  ];

  body.innerHTML = groups.map(([title, inner]) => `<div class="settings-group"><h4>${title}</h4>${inner}</div>`).join('');

  // Roots: add + remove are DOM-only until Save so typed values are never lost.
  $('st-roots-add')?.addEventListener('click', () => {
    const wrap = $('st-roots');
    if (!wrap) return;
    wrap.insertAdjacentHTML('beforeend', settingsRootRow({ id: '', name: '', path: '' }));
    const last = wrap.lastElementChild;
    if (last) last.querySelector('.sr-path').focus();
  });
  $('st-roots')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sr-remove');
    if (btn) btn.closest('.settings-root-row').remove();
  });
}

function collectSettings() {
  const val = (id) => $(id)?.value.trim() ?? '';
  return {
    allowSignup: !!$('st-allowSignup')?.checked,
    roots: [...document.querySelectorAll('#st-roots .settings-root-row')]
      .map((row) => ({
        id: row.querySelector('.sr-id').value.trim(),
        name: row.querySelector('.sr-name').value.trim(),
        path: row.querySelector('.sr-path').value.trim(),
      }))
      .filter((r) => r.path),
    sync: {
      source: val('st-sync-source'),
      destination: val('st-sync-destination'),
      deleteExtraneous: !!$('st-sync-delete')?.checked,
      intervalMinutes: settingsNum($('st-sync-interval')?.value, 0),
    },
    mirror: {
      mirrorPath: val('st-mirror-path'),
      readOnly: !!$('st-mirror-readonly')?.checked,
    },
    search: {
      maxDepth: settingsNum($('st-search-depth')?.value, 6),
      maxResults: settingsNum($('st-search-results')?.value, 200),
    },
    thumbnails: {
      size: settingsNum($('st-thumb-size')?.value, 256),
      cacheDir: val('st-thumb-cachedir'),
    },
    textEdit: {
      maxBytes: settingsNum($('st-editor-maxbytes')?.value, 5242880),
    },
  };
}

async function openSettings() {
  const modal = $('modal-settings');
  if (!modal) return;
  try {
    const c = await FS.settings();
    settingsDraft.roots = Array.isArray(c.roots) ? c.roots : [];
    settingsDraft.allowSignup = !!c.allowSignup;
    settingsDraft.sync = c.sync || {};
    settingsDraft.mirror = c.mirror || {};
    settingsDraft.search = c.search || {};
    settingsDraft.thumbnails = c.thumbnails || {};
    settingsDraft.textEdit = c.textEdit || {};
    settingsDraft.mode = c.mode;
    settingsDraft.host = c.host;
    settingsDraft.port = c.port;
    settingsDraft.dashboardBase = c.dashboardBase;
    renderSettings();
    modal.classList.add('show');
  } catch (err) {
    toast(err.message || 'Failed to load settings');
  }
}

function closeSettings() {
  $('modal-settings')?.classList.remove('show');
}

async function saveSettings() {
  try {
    const body = collectSettings();
    await FS.saveSettings(body);
    settingsFeedback('Settings saved', true);
    closeSettings();
    toast('Settings saved');
    // Roots / mode may have changed — rebuild the root picker + current listing.
    // Reset root BEFORE loadRoots so it re-picks the first root (loadRoots only
    // picks when state.root is falsy); otherwise the listing falls back to
    // "Unknown root".
    state.root = null;
    state.path = '';
    state.nodeMap.clear();
    await loadRoots();
    renderBreadcrumb();
    await reload();
  } catch (err) {
    settingsFeedback('Save failed: ' + (err.message || 'unknown error'), false);
  }
}

function bindStatic() {
  bindModals();
  initUpload();
  $('login-submit').onclick = handleLogin;
  $('login-pass').onkeydown = (e) => { if (e.key === 'Enter') handleLogin(e); };
  $('login-toggle').onclick = (e) => { e.preventDefault(); setLoginMode(loginMode === 'signup' ? 'signin' : 'signup'); };
  $('btn-signout').onclick = signOut;
  window.addEventListener('fs:unauthorized', () => { showLogin(); toast('Session expired — sign in again'); });
  applyBootstrap();
}

async function boot() {
  // Restore cached view/sort state (per-browser), then keep controls in sync.
  loadFsState();
  syncViewControls();
  applyZoom();
  await loadRoots();
  renderBreadcrumb();
  await loadDir();

  $('root-select').onchange = async () => {
    state.root = $('root-select').value;
    state.path = '';
    state.nodeMap.clear();
    await reload();
  };

  $('view-list').onclick = () => { state.view = 'list'; syncViewControls(); saveFsState(); reload(); };
  $('view-grid').onclick = () => { state.view = 'grid'; syncViewControls(); saveFsState(); reload(); };

  $('sort-select').onchange = () => { state.sortBy = $('sort-select').value; saveFsState(); reload(); };
  $('sort-dir').onclick = () => { state.sortDir *= -1; syncViewControls(); saveFsState(); reload(); };
  $('filter-select').onchange = () => { state.filter = $('filter-select').value; reload(); };

  let debounce;
  $('search-input').oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.query = $('search-input').value; reload(); }, 280);
  };

  $('file-list').addEventListener('click', handleListClick);

  // Grid zoom: ctrl+scrollwheel over the file list (0.4x - 2.5x).
  $('file-list').addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false }
  );

  // FS-2: favorites + tags + share
  $('btn-share').classList.toggle('hidden', !FS.can('files.admin'));
  // FS-3: one-way mirror sync (push/collect directions)
  $('btn-sync').classList.toggle('hidden', !FS.can('files.admin'));
  $('sync-direction').classList.toggle('hidden', !FS.can('files.admin'));
  $('btn-sync').onclick = runSync;

  // Settings (admin only)
  $('btn-settings').classList.toggle('hidden', !FS.can('files.admin'));
  $('btn-settings').onclick = openSettings;
  $('settings-close').onclick = closeSettings;
  $('settings-cancel').onclick = closeSettings;
  $('settings-save').onclick = saveSettings;
  $('modal-settings').addEventListener('click', (e) => {
    if (e.target === $('modal-settings')) closeSettings();
  });

  // ARCH: runtime mode switch (drop/upload server <-> read-only sync mirror)
  const modeSel = $('mode-select');
  modeSel.classList.toggle('hidden', !FS.can('files.admin'));
  FS.config().then((c) => { state.mode = c.mode || 'fileserver'; modeSel.value = state.mode; }).catch(() => {});
  modeSel.onchange = async () => {
    const target = modeSel.value;
    const label = target === 'mirror' ? 'Mirror (sync, read-only)' : 'Server (drop/upload)';
    if (!confirm(`Switch the fileserver to ${label} mode?`)) { modeSel.value = state.mode; return; }
    try {
      await FS.setMode(target);
      state.mode = target;
      state.root = null;
      state.path = '';
      state.nodeMap.clear();
      toast(`Mode: ${label}`);
      await loadRoots();
      await reload();
    } catch (err) {
      toast(err.message);
      modeSel.value = state.mode;
    }
  };
  $('fav-toggle').onclick = () => {
    state.favOnly = !state.favOnly;
    $('fav-toggle').classList.toggle('active', state.favOnly);
    reload();
  };
  $('tag-filter').onchange = () => { state.tagFilter = $('tag-filter').value; reload(); };

  window.addEventListener('fs:favorites-changed', async () => { await loadFavorites(); await reload(); });
  window.addEventListener('fs:tags-changed', async () => { await loadTagsAll(); await reload(); });

  await Promise.all([loadFavorites(), loadTagsAll()]);
  await reload();
}

bindStatic();
initAuth().then(() => { if (FS.isLoggedIn()) boot(); });
