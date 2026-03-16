import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authFetch } from '../utils/tokenManager';
import { useAuth } from '../contexts/AuthContext';

export default function TenantSelector() {
  const { selectTenant, user, logout } = useAuth();
  const navigate = useNavigate();
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadTenants();
  }, []);

  async function loadTenants() {
    try {
      const res = await authFetch('/api/tenants');
      if (!res.ok) throw new Error('Errore nel caricamento');
      const data = await res.json();
      setTenants(data.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(tenant) {
    selectTenant(tenant);
    navigate('/', { replace: true });
  }

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const statusColors = {
    active: 'border-brand-200 hover:border-brand-400 hover:shadow-lg',
    suspended: 'border-red-200 opacity-60 cursor-not-allowed',
    trial: 'border-yellow-200 hover:border-yellow-400 hover:shadow-lg',
  };

  const statusBadge = {
    active: 'bg-green-100 text-green-700',
    suspended: 'bg-red-100 text-red-700',
    trial: 'bg-yellow-100 text-yellow-700',
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-gray-900 text-white px-8 py-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-brand-400">xHUMANPRO</h1>
          <p className="text-sm text-gray-400 mt-1">Seleziona un e-commerce per accedere alla dashboard</p>
        </div>
        <div className="flex items-center gap-4">
          {user && (
            <div className="text-right">
              <div className="text-sm font-medium">{user.name}</div>
              <div className="text-xs text-gray-400">Super Admin</div>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-600 hover:border-gray-400 rounded-lg transition-colors"
          >
            Esci
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-8 py-12">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-xl font-bold text-gray-800">E-commerce disponibili</h2>
          <button
            onClick={() => navigate('/admin/tenants')}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium"
          >
            + Nuovo Tenant
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6 text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-gray-500 text-center py-20">Caricamento tenant...</div>
        ) : tenants.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-gray-400 text-lg mb-4">Nessun tenant configurato</div>
            <p className="text-gray-500 text-sm mb-6">Crea il primo tenant per iniziare</p>
            <button
              onClick={() => navigate('/admin/tenants')}
              className="px-6 py-3 bg-brand-600 text-white rounded-lg hover:bg-brand-700 font-medium"
            >
              Crea Tenant
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tenants.map(tenant => (
              <button
                key={tenant.id}
                onClick={() => tenant.status !== 'suspended' && handleSelect(tenant)}
                disabled={tenant.status === 'suspended'}
                className={`bg-white rounded-xl border-2 p-6 text-left transition-all ${statusColors[tenant.status] || statusColors.active}`}
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="w-12 h-12 bg-brand-50 rounded-xl flex items-center justify-center">
                    <svg className="w-6 h-6 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                    </svg>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusBadge[tenant.status] || statusBadge.active}`}>
                    {tenant.status}
                  </span>
                </div>

                <h3 className="text-lg font-semibold text-gray-800 mb-1">{tenant.name}</h3>
                <p className="text-sm text-gray-500">{tenant.slug}</p>

                {tenant.status !== 'suspended' && (
                  <div className="mt-4 flex items-center text-sm text-brand-600 font-medium">
                    Apri dashboard
                    <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
