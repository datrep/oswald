// components/dashboardMedia.js — the dashboard media panel (index page) + the
// "Dashboard Media" settings editor.
//
// The media lives as a resource under the "Dashboard Media" policy so it shows
// up in the attach-existing-resource picker; the current selection (path, title,
// description, video tweaks) is persisted SERVER-WIDE in settings.json
// (dashboardMedia). Changing media is admin-only (resources.manage).

import { apiGet, apiPost, apiPut, isLoggedIn, getToken } from '../api/api.js';
import { getFileKind, formatResourcePath, extractFilename, escapeHtml } from '../utils/files.js';
import { initResourcePicker } from './resourcePicker.js';

// "Dashboard Media" policy id — owns the dashboard media resources.
export const DASHBOARD_MEDIA_EDICT_ID = 44;

function hasPerm(code) {
  try {
    const t = getToken();
    if (!t) return false;
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Array.isArray(p.permissions) && p.permissions.includes(code);
  } catch { return false; }
}
export function canEditMedia() { return isLoggedIn() && hasPerm('resources.manage'); }

export async function loadMediaConfig() {
  try { const s = await apiGet('/api/settings'); return (s && s.dashboardMedia) || {}; } catch { return {}; }
}

export async function saveMediaConfig(patch) {
  const s = await apiGet('/api/settings');
  const cur = (s && s.dashboardMedia) || {};
  const dm = { ...cur, ...patch, video: { ...(cur.video || {}), ...(patch.video || {}) } };
  await apiPut('/api/settings', { dashboardMedia: dm });
  window.dispatchEvent(new CustomEvent('settings:changed', { detail: { key: 'dashboardMedia', value: dm } }));
  return dm;
}

export async function uploadMediaFile(file, description) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('edictID', String(DASHBOARD_MEDIA_EDICT_ID));
  fd.append('filesize', String(file.size));
  fd.append('description', description || '');
  return apiPost('/api/resources/media', fd); // -> { resourcePath, id }
}

export function mediaSrc(resourcePath) { return '/' + formatResourcePath(resourcePath || ''); }

function setPanelMsg(text) {
  const m = document.getElementById('media-msg');
  if (m) m.textContent = text;
}

// ---------- index-page media panel ----------
function panelEls() {
  return {
    stage: document.getElementById('media-stage'),
    img: document.getElementById('media-img'),
    video: document.getElementById('media-video'),
    empty: document.getElementById('media-empty'),
    title: document.getElementById('media-title'),
    desc: document.getElementById('media-desc'),
    attach: document.getElementById('media-attach'),
    drophint: document.getElementById('media-drophint'),
  };
}

export async function renderPanel() {
  const els = panelEls();
  if (!els.stage) return;
  const cfg = await loadMediaConfig();
  const can = canEditMedia();
  if (els.title) els.title.textContent = cfg.title || 'Dashboard Media';
  if (els.desc) { els.desc.textContent = cfg.description || ''; els.desc.classList.toggle('hidden', !cfg.description); }
  if (els.attach) els.attach.classList.toggle('hidden', !can);
  if (els.drophint) els.drophint.classList.toggle('hidden', !can);
  els.stage.classList.toggle('can-edit', can);
  setPanelMsg('');

  els.img.classList.add('hidden');
  els.video.classList.add('hidden');
  if (els.empty) els.empty.classList.remove('hidden');

  if (cfg.resourcePath) {
    const kind = getFileKind(cfg.resourcePath);
    const src = mediaSrc(cfg.resourcePath);
    if (els.empty) els.empty.classList.add('hidden');
    if (kind === 'video') {
      els.video.src = src;
      els.video.muted = true; // "no audio" — muted always (also enables autoplay)
      els.video.loop = !!(cfg.video && cfg.video.loop);
      els.video.controls = !!(cfg.video && cfg.video.controls);
      els.video.classList.remove('hidden');
    } else if (kind === 'image' || kind === 'other') {
      els.img.src = src;
      els.img.alt = cfg.title || '';
      els.img.classList.remove('hidden');
    } else {
      setPanelMsg('The selected resource is not supported media (images/GIFs/video only).');
    }
  }
}

function attachPicker(onPick) {
  return initResourcePicker({ title: 'Attach media from resources', filterMedia: true, onPick });
}

export function initDashboardMedia() {
  const els = panelEls();
  if (!els.stage) return;
  if (els.attach) {
    els.attach.addEventListener('click', () => {
      if (!canEditMedia()) { setPanelMsg('Sign in with an admin account to change media.'); return; }
      attachPicker(async (r) => {
        const cfg = await saveMediaConfig({ resourcePath: r.resourcePath, title: extractFilename(r.resourcePath) });
        setPanelMsg(`Media set to ${cfg.title || 'resource'}.`);
        renderPanel();
      }).open();
    });
  }

  ['dragenter', 'dragover'].forEach((ev) =>
    els.stage.addEventListener(ev, (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; els.stage.classList.add('drag-over'); })
  );
  els.stage.addEventListener('dragleave', (e) => { if (!els.stage.contains(e.relatedTarget)) els.stage.classList.remove('drag-over'); });
  els.stage.addEventListener('drop', (e) => {
    e.preventDefault();
    els.stage.classList.remove('drag-over');
    if (!canEditMedia()) { setPanelMsg('Sign in with an admin account to change media.'); return; }
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) {
      const kind = getFileKind(f.name);
      if (kind !== 'image' && kind !== 'video') { setPanelMsg('Unsupported — drop an image, GIF, or video (no audio).'); return; }
      setPanelMsg('Uploading media…');
      uploadMediaFile(f, 'Dashboard media')
        .then(async (r) => { await saveMediaConfig({ resourcePath: r.resourcePath, title: extractFilename(f.name) }); setPanelMsg('Media updated.'); renderPanel(); })
        .catch((err) => setPanelMsg('Upload failed: ' + (err.message || 'check file type/size')));
    }
  });

  renderPanel();
  window.addEventListener('settings:changed', (e) => {
    if (e.detail && e.detail.key === 'dashboardMedia') renderPanel();
  });
}

// ---------- settings-modal media editor ----------
function renderPreview(els, cfg) {
  const kind = getFileKind(cfg.resourcePath || '');
  if (!cfg.resourcePath) {
    els.preview.innerHTML = '';
    els.preview.classList.add('hidden');
    els.empty.classList.remove('hidden');
    return;
  }
  els.empty.classList.add('hidden');
  els.preview.classList.remove('hidden');
  els.preview.innerHTML =
    kind === 'video'
      ? `<video src="${mediaSrc(cfg.resourcePath)}" muted playsinline controls></video>`
      : `<img src="${mediaSrc(cfg.resourcePath)}" alt="">`;
}

export async function renderMediaEditor(container) {
  if (!container) return;
  const cfg = await loadMediaConfig();
  container.innerHTML = `
    <div class="dm-editor">
      <label class="dm-field">Title <input type="text" id="dm-title" value="${escapeHtml(cfg.title || '')}" /></label>
      <label class="dm-field">Description <input type="text" id="dm-desc" value="${escapeHtml(cfg.description || '')}" placeholder="Small text under the title" /></label>
      <div class="dm-media" id="dm-media" title="Drag an image, GIF, or video here">
        <div class="dm-preview hidden" id="dm-preview"></div>
        <div class="dm-empty" id="dm-empty">Drag an image / GIF / video here</div>
        <div class="dm-drophint">Drop image / GIF / video (mp4 · webm)</div>
      </div>
      <div class="dm-actions">
        <button type="button" id="dm-attach">Attach existing…</button>
        <button type="button" id="dm-clear" class="${cfg.resourcePath ? '' : 'hidden'}">Remove</button>
      </div>
      <div class="dm-toggles">
        <label class="settings-switch dm-toggle"><input type="checkbox" id="dm-loop" ${cfg.video && cfg.video.loop ? 'checked' : ''} /><span class="slider"></span><span class="dm-toggle-label">Loop video</span></label>
        <label class="settings-switch dm-toggle"><input type="checkbox" id="dm-controls" ${cfg.video && cfg.video.controls ? 'checked' : ''} /><span class="slider"></span><span class="dm-toggle-label">Show video controls</span></label>
      </div>
      <div class="dm-save"><button type="button" id="dm-save" class="btn btn--sm btn--primary">Save</button><span class="muted" id="dm-status"></span></div>
    </div>`;

  const els = {
    media: container.querySelector('#dm-media'),
    preview: container.querySelector('#dm-preview'),
    empty: container.querySelector('#dm-empty'),
    attach: container.querySelector('#dm-attach'),
    clear: container.querySelector('#dm-clear'),
    save: container.querySelector('#dm-save'),
    status: container.querySelector('#dm-status'),
  };
  let pendingResourcePath; // undefined = keep current; '' = remove; string = new path

  renderPreview(els, cfg);

  const picker = attachPicker((r) => {
    pendingResourcePath = r.resourcePath;
    renderPreview(els, { resourcePath: r.resourcePath });
    els.clear.classList.remove('hidden');
    els.status.textContent = 'Selected — press Save to apply.';
  });

  ['dragenter', 'dragover'].forEach((ev) => els.media.addEventListener(ev, (e) => { e.preventDefault(); els.media.classList.add('drag-over'); }));
  els.media.addEventListener('dragleave', (e) => { if (!els.media.contains(e.relatedTarget)) els.media.classList.remove('drag-over'); });
  els.media.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.media.classList.remove('drag-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const kind = getFileKind(f.name);
    if (kind !== 'image' && kind !== 'video') { els.status.textContent = 'Unsupported — image/GIF/video only.'; return; }
    els.status.textContent = 'Uploading…';
    try {
      const r = await uploadMediaFile(f, container.querySelector('#dm-title').value || '');
      pendingResourcePath = r.resourcePath;
      renderPreview(els, { resourcePath: r.resourcePath });
      els.clear.classList.remove('hidden');
      els.status.textContent = 'Uploaded — press Save to apply.';
    } catch (err) { els.status.textContent = 'Upload failed: ' + (err.message || 'check file type/size'); }
  });

  els.attach.addEventListener('click', () => picker.open());
  els.clear.addEventListener('click', () => {
    pendingResourcePath = '';
    renderPreview(els, {});
    els.clear.classList.add('hidden');
    els.status.textContent = 'Media will be removed on Save.';
  });
  els.save.addEventListener('click', async () => {
    els.status.textContent = 'Saving…';
    try {
      await saveMediaConfig({
        title: container.querySelector('#dm-title').value.trim(),
        description: container.querySelector('#dm-desc').value.trim(),
        resourcePath: pendingResourcePath !== undefined ? pendingResourcePath : (cfg.resourcePath || ''),
        video: { loop: container.querySelector('#dm-loop').checked, controls: container.querySelector('#dm-controls').checked },
      });
      els.status.textContent = 'Saved.';
    } catch (err) { els.status.textContent = 'Save failed: ' + (err.message || 'check admin permission'); }
  });
}
