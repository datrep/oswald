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
  nodeMap: new Map(),  // tree rel -> {expanded}
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

// ---------- auth ----------
function showLogin() { $('modal-login').classList.add('show'); }

async function initAuth() {
  if (!FS.isLoggedIn()) { showLogin(); return; }
  // Fresh load with a stored session: hide the login modal (it starts .show in HTML).
  $('modal-login').classList.remove('show');
  try {
    await FS.roots(); // validates token
  } catch {
    showLogin();
  }
}

function setSessionCookie(token) {
  document.cookie = `oswald_fs_token=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
}

function clearSessionCookie() {
  document.cookie = 'oswald_fs_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

async function handleLogin(e) {
  e.preventDefault();
  const user = $('login-user').value.trim();
  const pass = $('login-pass').value;
  const errEl = $('login-error');
  errEl.classList.add('hidden');
  if (!user || !pass) { errEl.textContent = 'Enter username and password.'; errEl.classList.remove('hidden'); return; }
  try {
    const body = await FS.login(user, pass);
    FS.setToken(body.token);
    setSessionCookie(body.token);
    $('modal-login').classList.remove('show');
    $('login-user').value = '';
    $('login-pass').value = '';
    toast(`Signed in as ${user}`);
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
    $('dir-info').textContent = `${data.entries.length} item${data.entries.length === 1 ? '' : 's'}`;
    const entries = sortEntries(data.entries).filter(matchesFilter);
    list.dataset.mode = 'dir';
    list.classList.toggle('list-mode', state.view === 'list');
    list.classList.toggle('grid-mode', state.view === 'grid');
    list.classList.remove('searching');
    if (!entries.length) {
      list.innerHTML = '<div class="fs-empty">This folder is empty — drop files here to upload.</div>';
      return;
    }
    list.innerHTML = state.view === 'grid' ? renderGrid(entries) : renderRows(entries);
    renderBreadcrumb();
  } catch (err) {
    list.innerHTML = `<div class="fs-empty">${escapeHtml(err.message)}</div>`;
  }
}

function rowActions(entry) {
  const rel = joinRel(state.path, entry.name);
  return `
    <div class="row-actions">
      ${!entry.isDir ? `<a href="${FS.downloadUrl(state.root, rel)}" download title="Download"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>` : ''}
      ${!entry.isDir && (entry.kind === 'text' || entry.kind === 'image') ? `<button data-act="edit" title="Edit"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>` : ''}
      <button data-act="rename" title="Rename"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
      <button data-act="move" title="Move"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg></button>
      <button data-act="del" class="act-del" title="Delete"><svg class="icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
    </div>`;
}

function renderRows(entries) {
  return entries.map((e) => {
    const rel = joinRel(state.path, e.name);
    const iconCls = e.isDir ? 'dir' : 'k-' + (e.kind || 'other');
    return `<div class="fs-row" data-rel="${escapeHtml(rel)}" data-name="${escapeHtml(e.name)}" data-kind="${e.isDir ? 'dir' : e.kind}">
      <div class="name"><span class="file-icon ${iconCls}">${KIND_ICON[e.isDir ? 'dir' : e.kind] || 'FILE'}</span><span title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span></div>
      <div class="size">${e.isDir ? '—' : fmtBytes(e.size)}</div>
      <div class="mtime">${fmtTime(e.mtime)}</div>
      ${rowActions(e)}
    </div>`;
  }).join('');
}

function renderGrid(entries) {
  return entries.map((e) => {
    const rel = joinRel(state.path, e.name);
    const iconCls = e.isDir ? 'dir' : 'k-' + (e.kind || 'other');
    const thumb = e.isDir
      ? `<div class="thumb"><span class="file-icon dir">DIR</span></div>`
      : e.kind === 'image'
        ? `<div class="thumb"><img loading="lazy" src="${FS.thumbUrl(state.root, rel)}" alt="${escapeHtml(e.name)}" onerror="this.outerHTML='<span class=&quot;file-icon k-image&quot;>IMG</span>'"></div>`
        : `<div class="thumb"><span class="file-icon ${iconCls}">${KIND_ICON[e.kind] || 'FILE'}</span></div>`;
    return `<div class="fs-grid-card" data-rel="${escapeHtml(rel)}" data-name="${escapeHtml(e.name)}" data-kind="${e.isDir ? 'dir' : e.kind}">
      ${thumb}
      <div class="gname" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
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
    list.innerHTML = results.map((e) => {
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
  if (mode === 'search') {
    if (entry.kind === 'dir') { navigateTo(entry.rel); return; }
    openViewer({ root: state.root, rel: entry.rel, name: entry.name });
    return;
  }
  const rel = joinRel(state.path, entry.name);
  if (entry.kind === 'dir') { navigateTo(rel); return; }
  openViewer({ root: state.root, rel, name: entry.name });
}

async function handleListClick(ev) {
  const row = ev.target.closest('.fs-row, .fs-grid-card');
  if (!row) return;
  const mode = $('file-list').dataset.mode || 'dir';
  const actBtn = ev.target.closest('[data-act]');
  const entry = { rel: row.dataset.rel, name: row.dataset.name, kind: row.dataset.kind };

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

// ---------- upload ----------
async function uploadFiles(files) {
  if (!files || !files.length) return;
  try {
    const body = await FS.upload(state.root, state.path, files);
    const n = body.added.length;
    toast(`Uploaded ${n} item${n === 1 ? '' : 's'} (ZIPs extracted)`);
    await reload();
  } catch (err) {
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
    ['modal-rename', 'rn-cancel'],
    ['modal-move', 'move-cancel'],
    ['modal-confirm', 'confirm-cancel'],
    ['modal-textedit', 'editor-cancel'],
    ['modal-viewer', 'viewer-close'],
  ];
  for (const [mid, btnId] of closers) {
    $(btnId).onclick = () => $(mid).classList.remove('show');
  }
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
<<<<<<< HEAD
  $('rn-ok').onclick = () => $('rn-input')._onOk?.();
=======
>>>>>>> 42f89b810a3b5cb89dc8769974f82228c1346fdf
  $('rn-input').onkeydown = (e) => { if (e.key === 'Enter') $('rn-input')._onOk?.(); };

  $('btn-newfolder').onclick = () => { $('modal-newfolder').classList.add('show'); $('nf-input').focus(); };

  $('viewer-edit').onclick = () => {
    const b = $('viewer-edit');
    if (b.dataset.rel) { closeViewer(); openEditor(state.root, b.dataset.rel, b.dataset.rel.split('/').pop()); }
  };
}

// ---------- reload / boot ----------
async function reload() {
  renderTree();
  renderBreadcrumb();
  if (state.query.trim()) await runSearch();
  else await loadDir();
}

function bindStatic() {
  bindModals();
  initUpload();
  $('login-submit').onclick = handleLogin;
  $('login-pass').onkeydown = (e) => { if (e.key === 'Enter') handleLogin(e); };
  $('btn-signout').onclick = signOut;
  window.addEventListener('fs:unauthorized', () => { showLogin(); toast('Session expired — sign in again'); });
}

async function boot() {
  await loadRoots();
  renderBreadcrumb();
  await loadDir();

  $('root-select').onchange = async () => {
    state.root = $('root-select').value;
    state.path = '';
    state.nodeMap.clear();
    await reload();
  };

  $('view-list').onclick = () => { state.view = 'list'; $('view-list').classList.add('active'); $('view-grid').classList.remove('active'); reload(); };
  $('view-grid').onclick = () => { state.view = 'grid'; $('view-grid').classList.add('active'); $('view-list').classList.remove('active'); reload(); };

  $('sort-select').onchange = () => { state.sortBy = $('sort-select').value; reload(); };
  $('sort-dir').onclick = () => { state.sortDir *= -1; $('sort-dir').textContent = state.sortDir === 1 ? '↑' : '↓'; reload(); };
  $('filter-select').onchange = () => { state.filter = $('filter-select').value; reload(); };

  let debounce;
  $('search-input').oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.query = $('search-input').value; reload(); }, 280);
  };

  $('file-list').addEventListener('click', handleListClick);
}

bindStatic();
initAuth().then(() => { if (FS.isLoggedIn()) boot(); });
