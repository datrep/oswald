// Fileserver API client + auth (shares the Oswald login, FS-2).
const TOKEN_KEY = 'oswald_fs_token';

const enc = encodeURIComponent;

export const FS = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY);
  },
  isLoggedIn() {
    return !!localStorage.getItem(TOKEN_KEY);
  },
  setToken(t) {
    localStorage.setItem(TOKEN_KEY, t);
  },
  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  },

  // Decode the JWT payload (roles/permissions live here).
  getClaims() {
    try {
      const token = this.getToken();
      if (!token) return null;
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(part));
    } catch {
      return null;
    }
  },
  can(permission) {
    const c = this.getClaims();
    return !!c && Array.isArray(c.permissions) && c.permissions.includes(permission);
  },

  // Server-side login proxy (same-origin; the UI is HTTPS so it can't call the
  // HTTP dashboard directly — mixed content). The server sets the session cookie.
  async login(username, password) {
    const r = await this.request('/api/fs/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Login failed');
    return body; // { token, roles, permissions }
  },

  // Public bootstrap + self-service sign-up (read-only account).
  config() {
    return this.json('/api/fs/config');
  },
  async register(username, password) {
    const r = await this.request('/api/fs/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Registration failed');
    return body;
  },

  async request(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = this.getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(path, { ...opts, headers });
    if (r.status === 401) {
      this.clearToken();
      window.dispatchEvent(new CustomEvent('fs:unauthorized'));
      throw new Error('Session expired — please sign in again');
    }
    return r;
  },

  async json(path, opts = {}) {
    const r = await this.request(path, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
    return body;
  },

  // ---- core FS ----
  roots() {
    return this.json('/api/fs/roots');
  },
  list(root, path) {
    return this.json(`/api/fs/list?root=${enc(root)}&path=${enc(path || '')}`);
  },
  search(root, q, path) {
    return this.json(`/api/fs/search?root=${enc(root)}&q=${enc(q)}&path=${enc(path || '')}`);
  },
  makeDir(root, path, name) {
    return this.json('/api/fs/dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, path, name }) });
  },
  rename(root, path, newName) {
    return this.json('/api/fs/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, path, newName }) });
  },
  move(root, path, toRoot, toPath) {
    return this.json('/api/fs/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, path, toRoot, toPath }) });
  },
  remove(root, path) {
    return this.json(`/api/fs?root=${enc(root)}&path=${enc(path || '')}`, { method: 'DELETE' });
  },
  async getContent(root, path) {
    const r = await this.request(`/api/fs/content?root=${enc(root)}&path=${enc(path || '')}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Load failed');
    return r.text();
  },
  saveContent(root, path, text) {
    return this.json(`/api/fs/content?root=${enc(root)}&path=${enc(path || '')}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text });
  },
  async upload(root, path, files) {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const r = await this.request(`/api/fs/upload?root=${enc(root)}&path=${enc(path || '')}`, { method: 'POST', body: fd });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Upload failed');
    return body;
  },

  // ---- favorites (FS-2) ----
  favorites() {
    return this.json('/api/fs/favorites');
  },
  favoriteAdd(root, path) {
    return this.json('/api/fs/favorites', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, path }) });
  },
  favoriteRemove(root, path) {
    return this.json(`/api/fs/favorites?root=${enc(root)}&path=${enc(path || '')}`, { method: 'DELETE' });
  },

  // ---- tags (FS-2) ----
  tags(root, path) {
    return this.json(`/api/fs/tags?root=${enc(root)}&path=${enc(path || '')}`);
  },
  tagsAll() {
    return this.json('/api/fs/tags/all');
  },
  tagAdd(root, path, tag) {
    return this.json('/api/fs/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, path, tag }) });
  },
  tagRemove(root, path, tag) {
    return this.json(`/api/fs/tags?root=${enc(root)}&path=${enc(path || '')}&tag=${enc(tag)}`, { method: 'DELETE' });
  },

  // ---- ACL admin (FS-2, files.admin) ----
  acl(root) {
    return this.json(`/api/fs/acl?root=${enc(root)}`);
  },
  aclSave(body) {
    return this.json('/api/fs/acl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  aclRemove(userId, rootId, folderPath) {
    return this.json(`/api/fs/acl?userId=${userId}&rootId=${enc(rootId)}&folderPath=${enc(folderPath || '')}`, { method: 'DELETE' });
  },
  users() {
    return this.json('/api/fs/users');
  },

  // FS-3 one-way sync (files.admin).
  syncNow() {
    return this.json('/api/fs/sync', { method: 'POST' });
  },
  syncStatus() {
    return this.json('/api/fs/sync/status');
  },

  // URL helpers
  downloadUrl(root, path, { dl = false } = {}) {
    return `/api/fs/download?root=${enc(root)}&path=${enc(path || '')}${dl ? '&dl=1' : ''}`;
  },
  thumbUrl(root, path, size = 256) {
    return `/api/fs/thumb?root=${enc(root)}&path=${enc(path || '')}&size=${size}`;
  },
};
