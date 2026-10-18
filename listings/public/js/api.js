// listings/public/js/api.js — API client for the Listing Workbench.
const TOKEN_KEY = 'oswald_listings_token';

export const api = {
  getToken: () => localStorage.getItem(TOKEN_KEY),
  setToken: (t) => localStorage.setItem(TOKEN_KEY, t),
  clearToken: () => localStorage.removeItem(TOKEN_KEY),
  isLoggedIn: () => !!localStorage.getItem(TOKEN_KEY),

  async login(username, password) {
    const r = await fetch('/api/listings/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch { d = text; }
    if (!r.ok) throw new Error((d && d.error) || 'Login failed');
    return d;
  },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) {
      this.clearToken();
      document.dispatchEvent(new CustomEvent('auth:logout'));
      throw new Error('Session expired — sign in again');
    }
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch { d = text; }
    if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
    return d;
  },

  get: (p) => api.request('GET', p),
  post: (p, b) => api.request('POST', p, b),
  put: (p, b) => api.request('PUT', p, b),
  del: (p) => api.request('DELETE', p),
};
