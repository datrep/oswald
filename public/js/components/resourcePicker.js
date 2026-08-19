// components/resourcePicker.js — reusable "Attach existing resource" picker.
// The same UX as the policy workspace picker (same #resource-picker markup +
// main.css styles), but self-contained: it injects its modal into the page so
// any page (index, settings) can use it without duplicating HTML.
//
//   const picker = initResourcePicker({ title, filterMedia, onPick });
//   picker.open();
//
// onPick(resource) is called when a row is clicked; the picker closes itself.

import { apiGet } from '../api/api.js';
import { getFileKind, formatResourcePath, extractFilename, escapeHtml, isMediaFile } from '../utils/files.js';

let modal = null;
let opts = { title: 'Attach existing resource', filterMedia: false, onPick: null };
let cache = [];

function ensureModal() {
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'resource-picker';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="modal-resource-content">
      <h3 id="rp-title">${escapeHtml(opts.title)}</h3>
      <input type="search" id="resource-picker-search" placeholder="Search resources…" autocomplete="off" />
      <div id="resource-picker-list" class="resource-picker-list"></div>
      <p id="resource-picker-status" class="picker-status muted"></p>
      <div class="modal-actions">
        <button id="resource-picker-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#resource-picker-close').addEventListener('click', close);
  modal.querySelector('#resource-picker-search').addEventListener('input', (e) => render(e.target.value));
  return modal;
}

function close() { if (modal) modal.style.display = 'none'; }

async function load() {
  const list = modal.querySelector('#resource-picker-list');
  const status = modal.querySelector('#resource-picker-status');
  list.innerHTML = '<div class="picker-status muted">Loading resources…</div>';
  try {
    const resources = await apiGet('/api/resources');
    cache = opts.filterMedia ? resources.filter((r) => isMediaResource(r)) : resources;
    render('');
    if (status) status.textContent = `${cache.length} resource(s) available${opts.filterMedia ? ' (media only)' : ''}`;
  } catch (err) {
    console.error('[ResourcePicker] Failed to load resources', err);
    list.innerHTML = `<div class="picker-status muted">${/401|Unauthorized/i.test(String(err)) ? 'You must be logged in to attach resources.' : 'Could not load resources.'}</div>`;
  }
}

function isMediaResource(r) {
  return isMediaFile(extractFilename(r.resourcePath || ''));
}

function render(q) {
  const list = modal.querySelector('#resource-picker-list');
  const query = (q || '').toLowerCase();
  const filtered = query
    ? cache.filter(
        (r) =>
          (r.resourcePath || '').toLowerCase().includes(query) ||
          (r.description || '').toLowerCase().includes(query) ||
          (r.edictName || '').toLowerCase().includes(query)
      )
    : cache;
  if (!filtered.length) {
    list.innerHTML = '<div class="picker-status muted">No resources found.</div>';
    return;
  }
  list.innerHTML = '';
  for (const r of filtered) {
    const name = extractFilename(r.resourcePath || '');
    const kind = getFileKind(name);
    const webPath = formatResourcePath(r.resourcePath || '');
    const row = document.createElement('div');
    row.className = 'picker-row';
    const thumb = document.createElement('span');
    thumb.className = 'picker-thumb-slot';
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'picker-thumb';
      img.loading = 'lazy';
      img.src = '/' + webPath;
      img.alt = '';
      img.onerror = () => { thumb.innerHTML = `<span class="resource-type-badge" data-kind="${kind}">${kind.toUpperCase()}</span>`; };
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = `<span class="resource-type-badge" data-kind="${kind}">${kind.toUpperCase()}</span>`;
    }
    row.appendChild(thumb);
    row.insertAdjacentHTML('beforeend', `
      <span class="p-name">${escapeHtml(name)}</span>
      <span class="p-meta">${r.edictName ? escapeHtml(r.edictName) : '—'}</span>
      <span class="p-attach">Attach</span>
    `);
    row.addEventListener('click', () => { if (opts.onPick) opts.onPick(r); close(); });
    list.appendChild(row);
  }
}

export function initResourcePicker(pickOpts = {}) {
  opts = { title: 'Attach existing resource', filterMedia: false, onPick: null, ...pickOpts };
  ensureModal();
  return {
    open() {
      const m = ensureModal();
      const s = m.querySelector('#resource-picker-search');
      if (s) s.value = '';
      m.style.display = 'flex';
      load();
      if (s) s.focus();
    },
    close,
  };
}
