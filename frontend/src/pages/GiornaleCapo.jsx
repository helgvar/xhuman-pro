import { useEffect, useState } from 'react';
import { authFetch } from '../utils/tokenManager';

function api(path, opts = {}) {
  return authFetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json());
}

const CAT_COLORS = {
  feed: 'bg-blue-100 text-blue-800',
  prezzi: 'bg-emerald-100 text-emerald-800',
  blocchi: 'bg-red-100 text-red-800',
  config: 'bg-amber-100 text-amber-800',
  infra: 'bg-slate-200 text-slate-800',
  monitor: 'bg-cyan-100 text-cyan-800',
};

export default function GiornaleCapo() {
  const [items, setItems] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [tenantFilter, setTenantFilter] = useState('tutti');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/tenants').then(r => setTenants(r.tenants || r.items || r || []));
  }, []);

  useEffect(() => {
    setLoading(true);
    api(`/capo-ordini?tenant_id=${tenantFilter}`)
      .then(r => setItems(r.items || []))
      .finally(() => setLoading(false));
  }, [tenantFilter]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">📖 Giornale Ordini</h1>
          <p className="text-sm text-gray-500">
            Libro giornale degli ordini impartiti — per tenant, con data/ora, azione eseguita ed esito
          </p>
        </div>
        <select
          className="border rounded-lg px-3 py-2 text-sm"
          value={tenantFilter}
          onChange={e => setTenantFilter(e.target.value)}
        >
          <option value="tutti">Tutti</option>
          <option value="rete">Solo ordini di RETE</option>
          {(Array.isArray(tenants) ? tenants : []).map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-gray-400 py-10 text-center">Caricamento…</div>
      ) : (
        <div className="space-y-3">
          {items.map(o => (
            <div key={o.id} className={`bg-white rounded-xl shadow-sm border p-4 ${o.attivo ? '' : 'opacity-60'}`}>
              <div className="flex items-center gap-2 flex-wrap text-xs mb-2">
                <span className="font-mono text-gray-500">
                  {new Date(o.ordinato_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
                <span className={`px-2 py-0.5 rounded-full font-semibold ${CAT_COLORS[o.categoria] || 'bg-gray-100 text-gray-700'}`}>
                  {o.categoria || 'generale'}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-semibold">
                  {o.tenant_name || 'RETE'}
                </span>
                {!o.attivo && <span className="px-2 py-0.5 rounded-full bg-gray-200 text-gray-500">revocato/superato</span>}
              </div>
              <div className="font-medium text-gray-900 mb-1">«{o.ordine}»</div>
              {o.azione_eseguita && (
                <div className="text-sm text-gray-600"><span className="font-semibold">Azione:</span> {o.azione_eseguita}</div>
              )}
              {o.esito && (
                <div className="text-sm text-gray-600"><span className="font-semibold">Esito:</span> {o.esito}</div>
              )}
            </div>
          ))}
          {items.length === 0 && (
            <div className="text-gray-400 py-10 text-center">Nessun ordine registrato per questo filtro</div>
          )}
        </div>
      )}
    </div>
  );
}
