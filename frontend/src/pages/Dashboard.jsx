import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authFetch } from '../utils/tokenManager';
import { useNavigate } from 'react-router-dom';

function api(path) {
  return authFetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' } }).then(r => r.json());
}

function formatEur(v) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(v);
}

function KpiCard({ label, value, sub, accent, icon, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl border border-gray-200 p-5 ${onClick ? 'cursor-pointer hover:border-brand-300 hover:shadow-sm transition-all' : ''}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
        {icon && <span className="text-gray-300">{icon}</span>}
      </div>
      <div className={`text-2xl font-bold ${accent || 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

function ProductRow({ p, showRevenue, showMargin, showSales }) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-2.5">
        <div className="font-medium text-gray-900 truncate max-w-[220px]">{p.product_name || p.sku}</div>
        <div className="text-xs text-gray-400">{p.sku} {p.brand ? `- ${p.brand}` : ''}</div>
      </td>
      {showRevenue && (
        <td className="px-3 py-2.5 text-right text-green-600 font-medium">
          {parseFloat(p.ga4_tp_revenue) > 0 ? formatEur(p.ga4_tp_revenue) : '-'}
        </td>
      )}
      {showSales && (
        <td className="px-3 py-2.5 text-right text-gray-700">
          {parseInt(p.ga4_tp_purchases || p.sales_30d_seller) || 0}
        </td>
      )}
      {showMargin && (
        <td className="px-3 py-2.5 text-right text-gray-700">
          {parseFloat(p.margin_pct) > 0 ? parseFloat(p.margin_pct).toFixed(1) + '%' : '-'}
        </td>
      )}
      <td className="px-3 py-2.5 text-right text-gray-600">{formatEur(parseFloat(p.sell_price) || 0)}</td>
      <td className="px-3 py-2.5 text-right">
        <span className={`text-xs font-medium ${
          parseFloat(p.health_score) >= 60 ? 'text-green-600' :
          parseFloat(p.health_score) >= 40 ? 'text-amber-600' : 'text-gray-400'
        }`}>{parseFloat(p.health_score)?.toFixed(0) || '-'}</span>
      </td>
    </tr>
  );
}

function MiniTable({ title, products, showRevenue, showMargin, showSales, linkTo, emptyMsg }) {
  const navigate = useNavigate();
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        {linkTo && (
          <button onClick={() => navigate(linkTo)} className="text-xs text-brand-500 hover:text-brand-700 font-medium">
            Vedi tutti &rarr;
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
            <tr>
              <th className="px-4 py-2 text-left">Prodotto</th>
              {showRevenue && <th className="px-3 py-2 text-right">Revenue TP</th>}
              {showSales && <th className="px-3 py-2 text-right">Vendite</th>}
              {showMargin && <th className="px-3 py-2 text-right">Margine</th>}
              <th className="px-3 py-2 text-right">Prezzo</th>
              <th className="px-3 py-2 text-right">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {products.length > 0 ? products.map(p => (
              <ProductRow key={p.sku} p={p} showRevenue={showRevenue} showMargin={showMargin} showSales={showSales} />
            )) : (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">{emptyMsg || 'Nessun dato'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { selectedTenant } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/optimization/dashboard')
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500" />
      </div>
    );
  }

  const k = data?.kpis || {};

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">
          Panoramica {selectedTenant?.name || 'e-commerce'} - dati aggregati da Trovaprezzi, GA4, Merchant Center
        </p>
      </div>

      {/* KPI principali */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Incidenza TP"
          value={k.incidence > 0 ? k.incidence + '%' : '-'}
          sub="costo click / fatturato TP"
          accent={k.incidence <= 5 ? 'text-green-600' : k.incidence <= 8 ? 'text-amber-600' : 'text-red-600'}
          onClick={() => navigate('/optimization')}
        />
        <KpiCard
          label="Fatturato TP (GA4)"
          value={formatEur(k.tpRevenue || 0)}
          sub={`${k.tpTransactions || 0} transazioni, conv. ${k.convRate || 0}%`}
          accent="text-green-700"
          onClick={() => navigate('/statistiche')}
        />
        <KpiCard
          label="Costo Click TP"
          value={formatEur(k.clickCost || 0)}
          sub={`${k.tpSessions || 0} sessioni`}
          accent="text-red-600"
          onClick={() => navigate('/trovaprezzi')}
        />
        <KpiCard
          label="Prodotti nel Feed"
          value={k.feedActive || 0}
          sub={`${k.toRemove || 0} da rimuovere, ${k.pepite || 0} pepite`}
          onClick={() => navigate('/optimization')}
        />
      </div>

      {/* Piano di Ottimizzazione */}
      {k.currentCost14d > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Piano di Ottimizzazione</h2>
            <div className="flex items-center gap-3">
              {k.feedLastRun && <span className="text-xs text-gray-400">Aggiornato: {new Date(k.feedLastRun).toLocaleString('it-IT')}</span>}
              <button onClick={() => navigate('/optimization')} className="text-xs text-brand-500 hover:text-brand-700 font-medium">Dettagli &rarr;</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="border rounded-xl p-4 bg-gray-50">
              <h4 className="text-xs font-medium text-gray-500 uppercase mb-3">Oggi (14gg)</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Spesa Click TP</span>
                  <span className="font-bold text-red-600">{formatEur(k.currentCost14d)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Incasso TP (GA4)</span>
                  <span className="font-bold text-green-600">{formatEur(k.currentRevenue14d)}</span>
                </div>
                <div className="border-t pt-2 flex justify-between">
                  <span className="text-gray-700 font-medium">Incidenza</span>
                  <span className={`font-bold ${k.incidence <= 5 ? 'text-green-600' : k.incidence <= 8 ? 'text-amber-600' : 'text-red-600'}`}>
                    {k.incidence}%
                  </span>
                </div>
              </div>
            </div>

            <div className="border-2 border-brand-300 rounded-xl p-4 bg-brand-50">
              <h4 className="text-xs font-medium text-brand-600 uppercase mb-3">Proiezione (7gg)</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Spesa Click TP</span>
                  <span className="font-bold text-green-600">{formatEur(k.projectedCost14d)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Risparmio</span>
                  <span className="font-bold text-green-600">-{formatEur(k.savings)}</span>
                </div>
                <div className="border-t pt-2 flex justify-between">
                  <span className="text-gray-700 font-medium">Incidenza prevista</span>
                  {(() => {
                    const proj = k.currentRevenue14d > 0 ? (k.projectedCost14d / k.currentRevenue14d) * 100 : 0;
                    return <span className={`font-bold ${proj <= 5 ? 'text-green-600' : proj <= 8 ? 'text-amber-600' : 'text-red-600'}`}>{proj.toFixed(1)}%</span>;
                  })()}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="text-center p-3 bg-red-50 rounded-lg cursor-pointer hover:bg-red-100" onClick={() => navigate('/optimization')}>
              <div className="text-xl font-bold text-red-700">{k.toRemove}</div>
              <div className="text-xs text-red-600">Da rimuovere</div>
            </div>
            <div className="text-center p-3 bg-amber-50 rounded-lg cursor-pointer hover:bg-amber-100" onClick={() => navigate('/optimization')}>
              <div className="text-xl font-bold text-amber-700">{k.priceCuts}</div>
              <div className="text-xs text-amber-600">Tagli prezzo</div>
            </div>
            <div className="text-center p-3 bg-green-50 rounded-lg cursor-pointer hover:bg-green-100" onClick={() => navigate('/optimization')}>
              <div className="text-xl font-bold text-green-700">{k.additions || k.pepite}</div>
              <div className="text-xs text-green-600">Pepite da attivare</div>
            </div>
          </div>
        </div>
      )}

      {/* Scorciatoie rapide */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Ottimizzazione Feed', to: '/optimization', color: 'bg-brand-50 text-brand-700 border-brand-200' },
          { label: 'Analytics & GA4', to: '/statistiche', color: 'bg-green-50 text-green-700 border-green-200' },
          { label: 'Trovaprezzi Click', to: '/trovaprezzi', color: 'bg-amber-50 text-amber-700 border-amber-200' },
          { label: 'Statistiche MC', to: '/statistiche', color: 'bg-blue-50 text-blue-700 border-blue-200' },
        ].map(s => (
          <button
            key={s.to}
            onClick={() => navigate(s.to)}
            className={`px-4 py-3 rounded-lg border text-sm font-medium text-left hover:shadow-sm transition-all ${s.color}`}
          >
            {s.label} &rarr;
          </button>
        ))}
      </div>

      {/* Top prodotti */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MiniTable
          title="Top Vendite TP"
          products={data?.topSellers || []}
          showRevenue showSales
          linkTo="/optimization"
          emptyMsg="Nessun dato GA4 disponibile"
        />
        <MiniTable
          title="Alta Marginalit\u00e0 + Vendite"
          products={data?.highMargin || []}
          showMargin showSales
          linkTo="/products"
          emptyMsg="Nessun prodotto ad alta marginalit\u00e0"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MiniTable
          title="Alto Rotanti (30gg)"
          products={data?.highRotation || []}
          showSales showRevenue
          linkTo="/products"
          emptyMsg="Nessun dato di rotazione"
        />
        <MiniTable
          title="Best Stagionali (in stagione)"
          products={data?.seasonal || []}
          showRevenue showSales
          linkTo="/optimization"
          emptyMsg="Nessun prodotto stagionale in questo periodo"
        />
      </div>
    </div>
  );
}
