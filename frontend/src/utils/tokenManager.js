const TOKEN_KEY = 'xhp_access_token';
const REFRESH_KEY = 'xhp_refresh_token';
const USER_KEY = 'xhp_user';
const TENANT_KEY = 'xhp_selected_tenant';

let accessToken = null;
let refreshPromise = null;

export function getAccessToken() {
  if (accessToken) return accessToken;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setAccessToken(token) {
  accessToken = token;
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token) {
  if (token) {
    localStorage.setItem(REFRESH_KEY, token);
  } else {
    localStorage.removeItem(REFRESH_KEY);
  }
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user) {
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

export function clearAuth() {
  accessToken = null;
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function authFetch(url, options = {}) {
  const token = getAccessToken();
  const headers = { ...options.headers };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let finalUrl = url;
  try {
    const storedUser = getStoredUser();
    if (storedUser?.role === 'superadmin') {
      const raw = localStorage.getItem(TENANT_KEY);
      if (raw) {
        const tenant = JSON.parse(raw);
        if (tenant?.id) {
          const separator = finalUrl.includes('?') ? '&' : '?';
          finalUrl = `${finalUrl}${separator}tenantId=${tenant.id}`;
        }
      }
    }
  } catch {
    // Ignore parsing errors
  }

  let res = await fetch(finalUrl, { ...options, headers });

  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body.code === 'TOKEN_EXPIRED') {
      const refreshed = await tryRefresh();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${getAccessToken()}`;
        res = await fetch(finalUrl, { ...options, headers });
      } else {
        clearAuth();
        window.location.href = '/login';
        throw new Error('Session expired');
      }
    }
  }

  return res;
}

async function tryRefresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = _doRefresh();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function _doRefresh() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) return false;

    const data = await res.json();
    setAccessToken(data.accessToken);
    if (data.user) setStoredUser(data.user);
    return true;
  } catch {
    return false;
  }
}
