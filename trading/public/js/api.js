// trading/public/js/api.js — API client for the Trading Agent UI (ES module).
// Token lives in localStorage (oswald_trading_token); cookie set by the login proxy.
const TOKEN_KEY = 'oswald_trading_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }
export function isLoggedIn() { return !!getToken(); }

export async function request(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('auth:logout'));
    throw new Error('Session expired');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

export async function login(username, password) {
  const data = await request('POST', '/api/trading/login', { username, password });
  setToken(data.token);
  return data;
}

export const apiGet = (url) => request('GET', url);
export const apiPost = (url, body) => request('POST', url, body);
export const apiPut = (url, body) => request('PUT', url, body);
export const apiDelete = (url) => request('DELETE', url);
