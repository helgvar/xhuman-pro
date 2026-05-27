import React, { useState, useEffect } from 'react';
import { authFetch } from '../utils/tokenManager';

function fmtEur(n) {
  if (n == null || n === undefined) return '—';
  return Number(n).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(n) {
  if (n == null || n === undefined) return '—';
  return Number(n).toLocaleString('it-IT');
}
function fmtPct(n) {
  if (n == null || n === undefined) return '—';
  return `${Number(n).toFixed(1)}%`;
}

export default function ParetoRule() {
  const [days, setDays] = useState(90);
  const [cumulativePct, setCumulativePct] = useState(80);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(100);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/pareto/products?days=${days}&cumulative_pct=${cumulativePct}`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [days, cumulativePct]);

  const filtered = (data?.products || []).filter(p => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (p.sku || '').toLowerCase().includes(s)
      || (p.product_name || '').toLowerCase().includes(s)
      || (p.brand || '').toLowerCase().includes(s);
  });
  const visible = filtered.slice(0, limit);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Regola di Pareto</h1>
          <p className="text-sm text-gray-500 mt-1">
            Cross-tenant: il <b>{data?.cumulative_pct_target || cumulativePct}%</b> di fatturato concentrato in pochi SKU. Solo ordini <code>complete</code> + <code>processing</code>.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600">Finestra:</label>
          <select
            value={days}
            onChange={e => setDays(parseInt(e.target.value))}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
          >
            <option value={30}>30 giorni</option>
            <option value={60}>60 giorni</option>
            <option value={90}>90 giorni</option>
            <option value={180}>180 giorni</option>
            <option value={365}>1 anno</option>
          </select>
          <label className="text-sm text-gray-600 ml-2">Soglia cum %:</label>
          <select
            value={cumulativePct}
            onChange={e => setCumulativePct(parseInt(e.target.value))}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
          >
            <option value={50}>50%</option>
            <option value={70}>70%</option>
            <option value={80}>80%</option>
            <option value={90}>90%</option>
          </select>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-500"></div>
        </div>
      )}
      {error && <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded">Errore: {error}</div>}

      {data && !loading && (
        <>
          {/* Headline KPI */}
          <div className="bg-gradient-to-br from-teal-50 to-emerald-50 border border-teal-200 rounded-lg p-5">
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-bold text-teal-700">{fmtPct(data.pareto.skus_pct_of_total)}</span>
              <span className="text-gray-600">degli SKU genera</span>
              <span className="text-4xl font-bold text-teal-700">{fmtPct(data.pareto.revenue_pct_of_total)}</span>
              <span className="text-gray-600">del fatturato cross-tenant</span>
            </div>
            <div className="mt-2 text-sm text-gray-600">
              <b>{fmtNum(data.pareto.skus_in_pareto)}</b> SKU su <b>{fmtNum(data.stats.total_unique_skus)}</b> totali ·
              fatturato pareto <b>{fmtEur(data.pareto.revenue_in_pareto)}</b> su <b>{fmtEur(data.stats.total_revenue)}</b> ·
              ratio efficienza <b>{data.pareto.ratio.toFixed(2)}x</b>
            </div>
          </div>

          {/* Tenant leaderboard - top 50 Pareto */}
          {data.tenant_leaderboard?.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-900">
                  Classifica tenant — top {data.tenant_leaderboard_top_n} prodotti Pareto
                </h2>
                <span className="text-xs text-gray-500">
                  Quanti dei top {data.tenant_leaderboard_top_n} SKU per fatturato cross-tenant ogni tenant ha venduto
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <Th>#</Th>
                      <Th>Tenant</Th>
                      <Th right>SKU su top {data.tenant_leaderboard_top_n}</Th>
                      <Th right>Coverage</Th>
                      <Th right>Pezzi venduti</Th>
                      <Th right>Fatturato top</Th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {data.tenant_leaderboard.map((row, i) => (
                      <tr key={row.tenant_id} className="hover:bg-teal-50/40">
                        <Td className="text-gray-400">{i + 1}</Td>
                        <Td strong>{row.tenant_name}</Td>
                        <Td right strong>{fmtNum(row.skus_in_top)} <span className="text-xs text-gray-400">/ {data.tenant_leaderboard_top_n}</span></Td>
                        <Td right className={row.coverage_pct >= 70 ? 'text-emerald-700 font-medium' : row.coverage_pct >= 40 ? 'text-amber-700' : 'text-gray-500'}>
                          {fmtPct(row.coverage_pct)}
                        </Td>
                        <Td right>{fmtNum(row.qty_in_top)}</Td>
                        <Td right strong>{fmtEur(row.revenue_in_top)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* KPI grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <KPI label="Tenant attivi" value={fmtNum(data.stats.active_tenants)} />
            <KPI label="Ordini totali" value={fmtNum(data.stats.total_orders)} />
            <KPI label="SKU venduti" value={fmtNum(data.stats.total_unique_skus)} />
            <KPI label="Fatturato totale" value={fmtEur(data.stats.total_revenue)} />
            <KPI label="Pezzi venduti" value={fmtNum(data.stats.total_qty)} />
          </div>

          {/* Search + limit */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="text"
              placeholder="Cerca SKU, nome, brand..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 max-w-md border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <span className="text-sm text-gray-600">Mostra:</span>
            <select
              value={limit}
              onChange={e => setLimit(parseInt(e.target.value))}
              className="border border-gray-300 rounded-md px-2 py-1.5 text-sm"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={500}>500</option>
              <option value={5000}>tutti ({fmtNum(filtered.length)})</option>
            </select>
            <span className="text-xs text-gray-500">{visible.length} di {fmtNum(filtered.length)} visualizzati</span>
          </div>

          {/* Table */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <Th>#</Th>
                    <Th>SKU</Th>
                    <Th>Prodotto</Th>
                    <Th>Brand</Th>
                    <Th right>Fatturato</Th>
                    <Th right>Pezzi</Th>
                    <Th right>N° tenant</Th>
                    <Th right>P. min (best)</Th>
                    <Th>Tenant min</Th>
                    <Th right>P. medio</Th>
                    <Th right>P. max</Th>
                    <Th>Tenant max</Th>
                    <Th right>Spread</Th>
                    <Th right>Cum %</Th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-100">
                  {visible.map(p => (
                    <tr key={p.sku} className="hover:bg-teal-50/40">
                      <Td className="text-gray-400">{p.rn}</Td>
                      <Td mono>{p.sku}</Td>
                      <Td className="max-w-md">
                        <span className="text-gray-900">{p.product_name || '—'}</span>
                      </Td>
                      <Td>{p.brand || '—'}</Td>
                      <Td right strong>{fmtEur(p.total_revenue)}</Td>
                      <Td right>{fmtNum(p.total_qty)}</Td>
                      <Td right>{p.n_tenants}</Td>
                      <Td right className="text-emerald-700 font-medium">{fmtEur(p.price_min)}</Td>
                      <Td className="text-xs text-emerald-700">{p.tenant_min || '—'}</Td>
                      <Td right>{fmtEur(p.price_avg)}</Td>
                      <Td right className="text-gray-500">{fmtEur(p.price_max)}</Td>
                      <Td className="text-xs text-gray-500">{p.tenant_max || '—'}</Td>
                      <Td right className={`text-xs ${p.spread_pct >= 20 ? 'text-amber-700 font-medium' : 'text-gray-500'}`}>
                        {p.spread_pct != null ? `${p.spread_pct}%` : '—'}
                      </Td>
                      <Td right className="text-xs text-gray-500">{fmtPct(p.cum_pct)}</Td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan={14} className="text-center py-8 text-gray-400">Nessun risultato</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function KPI({ label, value }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 mt-1">{value}</div>
    </div>
  );
}
function Th({ children, right }) {
  return <th className={`px-3 py-2 text-${right ? 'right' : 'left'} text-xs font-semibold text-gray-600 uppercase tracking-wider`}>{children}</th>;
}
function Td({ children, right, mono, strong, className = '' }) {
  return (
    <td className={`px-3 py-2 text-sm ${right ? 'text-right' : 'text-left'} ${mono ? 'font-mono text-xs' : ''} ${strong ? 'font-semibold' : ''} ${className}`}>
      {children}
    </td>
  );
}
