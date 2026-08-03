// Place for API call functions (fetch) to backend routes
// please do not code fetch everywhere else
// I CANNOT MAKE IT MORE EXPLICIT USE /API/...
// do it.

// Auth token helpers (shared with components/auth.js)
export const TOKEN_KEY = 'oswald_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return !!getToken();
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

// Generic request wrapper
async function request(method, url, data = null) {
  const options = {
    method,
    headers: {},
  };

  // Attach the bearer token if we have one (protects the write endpoints).
  const token = getToken();
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }

  if (data) {
    if (data instanceof FormData) {
      // multer upload
      options.body = data;
    } else {
      // JSON request
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    }
  }

  const response = await fetch(url, options);

  // Token missing/expired -> drop it and let the UI switch back to login.
  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('auth:logout'));
  }

  if (!response.ok) {
    const text = await response.text();

    throw new Error(`[API ERROR] ${method} ${url} -> ${response.status} ${text}`);
  }

  // some endpoints may return empty response
  const contentType = response.headers.get('content-type');

  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

export async function apiGet(url) {
  return request('GET', url);
}

export async function apiPost(url, data) {
  return request('POST', url, data);
}

export async function apiPut(url, data) {
  return request('PUT', url, data);
}

export async function apiDelete(url) {
  return request('DELETE', url);
}
