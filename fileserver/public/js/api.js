// Fileserver API client + auth (shares the Oswald login).
const TOKEN_KEY = 'oswald_fs_token';
const CONFIG = {
  dashboardBase: 'http://172.22.160.3:8080',
};

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

  async login(username, password) {
    const r = await fetch(`${CONFIG.dashboardBase}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Login failed');
    return body; // { token, roles, permissions }
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

  // ---- endpoints ----
  roots() {
    return this.json('/api/fs/roots');
  },
  list(root, path) {
    return this.json(`/api/fs/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path || '')}`);
  },
  search(root, q, path) {
    return this.json(`/api/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&path=${encodeURIComponent(path || '')}`);
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
    return this.json(`/api/fs?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path || '')}`, { method: 'DELETE' });
  },
  async getContent(root, path) {
    const r = await this.request(`/api/fs/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path || '')}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Load failed');
    return r.text();
  },
  saveContent(root, path, text) {
    return this.json(`/api/fs/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path || '')}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text });
  },
  async upload(root, path, files) {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const r = await this.request(`/api/fs/upload?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path || '')}`, { method: 'POST', body: fd });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Upload failed');
    return body;
  },

  // URL helpers
  downloadUrl(root, path, { dl = false } = {}) {
    return `/api/fs/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path || '')}${dl ? '&dl=1' : ''}`;
  },
  thumbUrl(root, path, size = 256) {
    return `/api/fs/thumb?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path || '')}&size=${size}`;
  },
};
