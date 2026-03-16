import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  getAccessToken,
  setAccessToken,
  getRefreshToken,
  setRefreshToken,
  getStoredUser,
  setStoredUser,
  clearAuth,
} from '../utils/tokenManager';

const AuthContext = createContext(null);

const TENANT_KEY = 'xhp_selected_tenant';

function getStoredTenant() {
  try {
    const raw = localStorage.getItem(TENANT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setStoredTenant(tenant) {
  if (tenant) {
    localStorage.setItem(TENANT_KEY, JSON.stringify(tenant));
  } else {
    localStorage.removeItem(TENANT_KEY);
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => getStoredUser());
  const [selectedTenant, setSelectedTenantState] = useState(() => getStoredTenant());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getAccessToken();
    const refresh = getRefreshToken();

    if (token && user) {
      setLoading(false);
      return;
    }

    if (refresh && !token) {
      fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      })
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => {
          setAccessToken(data.accessToken);
          setStoredUser(data.user);
          setUser(data.user);
        })
        .catch(() => {
          clearAuth();
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = useCallback((accessTokenVal, refreshTokenVal, userData) => {
    setAccessToken(accessTokenVal);
    setRefreshToken(refreshTokenVal);
    setStoredUser(userData);
    setUser(userData);
  }, []);

  const logout = useCallback(async () => {
    const refresh = getRefreshToken();
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
    } catch {
      // Ignore logout errors
    }
    clearAuth();
    setStoredTenant(null);
    setUser(null);
    setSelectedTenantState(null);
  }, []);

  const selectTenant = useCallback((tenant) => {
    setSelectedTenantState(tenant);
    setStoredTenant(tenant);
  }, []);

  const clearTenant = useCallback(() => {
    setSelectedTenantState(null);
    setStoredTenant(null);
  }, []);

  // Refresh tenant name from server (in case it was updated)
  useEffect(() => {
    if (!selectedTenant?.id || !getAccessToken()) return;
    const token = getAccessToken();
    fetch('/api/tenants', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const match = data?.data?.find(t => t.id === selectedTenant.id);
        if (match && match.name !== selectedTenant.name) {
          const updated = { ...selectedTenant, name: match.name };
          setSelectedTenantState(updated);
          setStoredTenant(updated);
        }
      })
      .catch(() => {});
  }, [selectedTenant?.id]);

  const isAuthenticated = !!user && !!getAccessToken();
  const needsTenantSelection = isAuthenticated && user?.role === 'superadmin' && !selectedTenant;
  const effectiveTenantId = user?.role === 'superadmin'
    ? selectedTenant?.id || null
    : user?.tenantId || null;

  const value = {
    user,
    loading,
    isAuthenticated,
    login,
    logout,
    selectedTenant,
    selectTenant,
    clearTenant,
    needsTenantSelection,
    effectiveTenantId,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
