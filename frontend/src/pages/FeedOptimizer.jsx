import React, { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../utils/tokenManager';
import { useAuth } from '../contexts/AuthContext';

function api(path) {
  return authFetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
  }).then(r => r.json());
}

function apiPost(path) {
  return authFetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).then(r => r.json());
}

const classLabels = {
  star: { label: 'Star', color: 'bg-yellow-100 text-yellow-800', icon: '\u2605' },
  cash_cow: { label: 'Cash Cow', color: 'bg-green-100 text-green-800', icon: '\u2713' },
  burner: { label: 'Burner', color: 'bg-red-100 text-red-800', icon: '\u2716' },
  opportunity: { label: 'Opportunit\u00e0', color: 'bg-blue-100 text-blue-800', icon: '\u2191' },
  question_mark: { label: '?', color: 'bg-gray-100 text-gray-600', icon: '?' },
};

const priorityColors = {
  high: 'text-red-600 font-semibold',
  medium: 'text-amber-600',
  low: 'text-gray-400',
};

function ClassBadge({ classification }) {
  const cls = classLabels[classification] || classLabels.question_mark;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cls.color}`}>
      {cls.icon} {cls.label}
    </span>
  );
}

function HealthBar({ score }) {
  const s = parseFloat(score) || 0;
  const color = s >= 70 ? 'bg-green-500' : s >= 50 ? 'bg-yellow-500' : s >= 30 ? 'bg-orange-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${Math.min(100, s)}%` }} />
      </div>
      <span className="text-xs text-gray-600 w-8">{s.toFixed(0)}</span>
    </div>
  );
}

function KpiCard({ label, value, sub, accent }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent || 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

function IncidenceGauge({ value, min, max }) {
  const pct = parseFloat(value) * 100;
  const targetMin = parseFloat(min) || 3;
  const targetMax = parseFloat(max) || 5;
  const isGood = pct <= targetMax;
  const color = pct <= targetMax ? 'text-green-600' : pct <= 8 ? 'text-amber-600' : 'text-red-600';

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="text-xs text-gray-500 uppercase tracking-wider">Incidenza Costo TP</div>
      <div className={`text-3xl font-bold mt-1 ${color}`}>{pct.toFixed(2)}%</div>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1 h-3 bg-gray-200 rounded-full overflow-hidden relative">
          {/* Target zone */}
          <div
            className="absolute h-full bg-green-100 border-l border-r border-green-300"
            style={{ left: `${targetMin * 5}%`, width: `${(targetMax - targetMin) * 5}%` }}
          />
          {/* Actual */}
          <div
            className={`absolute h-full w-1.5 rounded ${isGood ? 'bg-green-600' : 'bg-red-500'}`}
            style={{ left: `${Math.min(95, pct * 5)}%` }}
          />
        </div>
      </div>
      <div className="text-xs text-gray-400 mt-1">Target: {targetMin}% - {targetMax}%</div>
    </div>
  );
}

// --- TABS ---

function formatEur(value) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(value);
}

function formatPct(value) {
  return (parseFloat(value) * 100).toFixed(2) + '%';
}

function WeeklyTable({ weeks }) {
  if (!weeks || weeks.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">Andamento Settimanale (4 settimane)</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
            <tr>
              <th className="px-4 py-3 text-left">Settimana</th>
              <th className="px-3 py-3 text-right">Click TP</th>
              <th className="px-3 py-3 text-right">Costo TP</th>
              <th className="px-3 py-3 text-right">Fatt. Store</th>
              <th className="px-3 py-3 text-right">Fatt. TP</th>
              <th className="px-3 py-3 text-right">% TP/Store</th>
              <th className="px-3 py-3 text-right">Incidenza</th>
              <th className="px-3 py-3 text-center">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {weeks.map((w, i) => {
              const prev = weeks[i + 1];
              const incPct = w.incidence * 100;
              const incColor = incPct === 0 ? 'text-gray-400' : incPct <= 5 ? 'text-green-600' : incPct <= 8 ? 'text-amber-600' : 'text-red-600';
              const trend = prev && prev.incidence > 0 && w.incidence > 0
                ? w.incidence < prev.incidence ? 'down' : w.incidence > prev.incidence ? 'up' : 'flat'
                : null;
              const storeRev = w.store_revenue || 0;
              const tpRev = w.tp_revenue || 0;
              const tpShare = storeRev > 0 ? (tpRev / storeRev) * 100 : 0;
              return (
                <tr key={w.week_start} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {new Date(w.week_start).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}
                    {' - '}
                    {new Date(w.week_end).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}
                  </td>
                  <td className="px-3 py-3 text-right text-gray-700">{w.clicks.toLocaleString('it-IT')}</td>
                  <td className="px-3 py-3 text-right text-gray-700">{formatEur(w.click_cost)}</td>
                  <td className="px-3 py-3 text-right text-gray-700">{formatEur(storeRev)}</td>
                  <td className="px-3 py-3 text-right font-medium text-green-700">{tpRev > 0 ? formatEur(tpRev) : '-'}</td>
                  <td className="px-3 py-3 text-right text-gray-500">{tpShare > 0 ? tpShare.toFixed(1) + '%' : '-'}</td>
                  <td className={`px-3 py-3 text-right font-semibold ${incColor}`}>
                    {w.clicks > 0 && tpRev > 0 ? incPct.toFixed(2) + '%' : w.clicks > 0 ? '---' : '-'}
                  </td>
                  <td className="px-3 py-3 text-center">
                    {trend === 'down' && <span className="text-green-600">&#9660;</span>}
                    {trend === 'up' && <span className="text-red-600">&#9650;</span>}
                    {trend === 'flat' && <span className="text-gray-400">&#9644;</span>}
                    {!trend && <span className="text-gray-300">-</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TabOverview({ health, recommendations, weekly }) {
  if (!health) return null;

  const h = health;
  const totalClickCost = parseFloat(h.total_click_cost) || 0;
  const storeRevenue = parseFloat(h.store_revenue) || 0;
  const storeOrders = parseInt(h.store_orders) || 0;
  const burnerWaste = parseFloat(h.burner_waste) || 0;
  const avgScore = parseFloat(h.avg_health_score) || 0;

  // GA4 data
  const ga4TpRevenue = parseFloat(h.ga4_tp_revenue) || 0;
  const ga4TpTransactions = parseInt(h.ga4_tp_transactions) || 0;
  const ga4TpSessions = parseInt(h.ga4_tp_sessions) || 0;
  const ga4TpCos = parseFloat(h.ga4_tp_cost_of_sale) || 0;
  const ga4TpConvRate = parseFloat(h.ga4_tp_conv_rate) || 0;
  const hasGA4 = ga4TpRevenue > 0;

  return (
    <div className="space-y-6">
      {/* KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <IncidenceGauge value={h.global_incidence || 0} />
        <KpiCard
          label="Costo Click TP 30gg"
          value={formatEur(totalClickCost)}
          sub={`${(parseInt(h.total_clicks) || 0).toLocaleString('it-IT')} click (zombie)`}
        />
        <KpiCard
          label="Fatturato TP 30gg"
          value={formatEur(ga4TpRevenue)}
          sub={hasGA4 ? `${ga4TpTransactions} transazioni (GA4, no spedizioni)` : 'GA4 non configurato'}
          accent={hasGA4 ? 'text-green-700' : undefined}
        />
        <KpiCard
          label="Spreco Burner"
          value={formatEur(burnerWaste)}
          sub={`${parseInt(h.burners) || 0} prodotti burner`}
          accent="text-red-600"
        />
      </div>

      {/* GA4 Trovaprezzi Channel KPIs */}
      {hasGA4 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Canale Trovaprezzi (da GA4)</h3>
            {h.ga4_last_update && (
              <span className="text-xs text-gray-400">Aggiornato: {new Date(h.ga4_last_update).toLocaleString('it-IT')}</span>
            )}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="text-center">
              <div className="text-xl font-bold text-gray-900">{ga4TpSessions.toLocaleString('it-IT')}</div>
              <div className="text-xs text-gray-500">Sessioni TP</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-gray-900">{ga4TpTransactions}</div>
              <div className="text-xs text-gray-500">Transazioni TP</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-gray-900">{formatEur(parseFloat(h.ga4_tp_avg_basket) || 0)}</div>
              <div className="text-xs text-gray-500">Carrello Medio TP</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-gray-900">{ga4TpConvRate}%</div>
              <div className="text-xs text-gray-500">Conv. Rate TP</div>
            </div>
          </div>
        </div>
      )}

      {/* Valore Indiretto TP */}
      {hasGA4 && (parseFloat(h.ga4_cross_session_revenue) > 0 || parseFloat(h.ga4_assisted_revenue) > 0) && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Valore Indiretto Trovaprezzi</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="text-center">
              <div className="text-xl font-bold text-gray-900">{formatEur(parseFloat(h.ga4_ft_revenue) || 0)}</div>
              <div className="text-xs text-gray-500">Revenue utenti acquisiti da TP</div>
              <div className="text-xs text-gray-400">(first-touch attribution)</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-blue-600">{formatEur(parseFloat(h.ga4_cross_session_revenue) || 0)}</div>
              <div className="text-xs text-gray-500">Revenue cross-sessione</div>
              <div className="text-xs text-gray-400">{parseInt(h.ga4_cross_session_transactions) || 0} transazioni da altre sorgenti</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-blue-600">{formatEur(parseFloat(h.ga4_assisted_revenue) || 0)}</div>
              <div className="text-xs text-gray-500">Revenue cross-sell in sessione</div>
              <div className="text-xs text-gray-400">{parseInt(h.ga4_assisted_sales) || 0} vendite di altri prodotti</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-green-600">
                {formatEur((parseFloat(h.ga4_tp_revenue) || 0) + (parseFloat(h.ga4_cross_session_revenue) || 0) + (parseFloat(h.ga4_assisted_revenue) || 0))}
              </div>
              <div className="text-xs text-gray-500">Valore Totale TP</div>
              <div className="text-xs text-gray-400">diretto + indiretto</div>
            </div>
          </div>
        </div>
      )}

      {/* Weekly Breakdown */}
      <WeeklyTable weeks={weekly} />

      {/* Classification Distribution */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Distribuzione Prodotti</h3>
        <div className="grid grid-cols-5 gap-4">
          {[
            { key: 'stars', label: 'Star', color: 'border-yellow-400 bg-yellow-50', count: h.stars },
            { key: 'cash_cows', label: 'Cash Cow', color: 'border-green-400 bg-green-50', count: h.cash_cows },
            { key: 'burners', label: 'Burner', color: 'border-red-400 bg-red-50', count: h.burners },
            { key: 'opportunities', label: 'Opportunit\u00e0', color: 'border-blue-400 bg-blue-50', count: h.opportunities },
            { key: 'question_marks', label: 'In Analisi', color: 'border-gray-300 bg-gray-50', count: h.question_marks },
          ].map(item => (
            <div key={item.key} className={`border-l-4 ${item.color} rounded-lg p-4 text-center`}>
              <div className="text-2xl font-bold text-gray-900">{parseInt(item.count) || 0}</div>
              <div className="text-xs text-gray-500">{item.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Health Score & Feed Stats */}
      <div className="grid grid-cols-2 gap-4">
        <KpiCard
          label="Health Score Medio"
          value={avgScore.toFixed(1)}
          sub={`su ${parseInt(h.total_products) || 0} prodotti`}
        />
        <KpiCard
          label="Prodotti nel Feed"
          value={parseInt(h.feed_products) || 0}
          sub={`su ${parseInt(h.total_products) || 0} totali`}
        />
      </div>

      {/* Recommendations Summary */}
      {recommendations && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Raccomandazioni Attive</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xl font-bold text-red-600">{recommendations.summary?.toDeactivate || 0}</div>
              <div className="text-xs text-gray-500">Da Disattivare</div>
            </div>
            <div>
              <div className="text-xl font-bold text-green-600">{recommendations.summary?.toActivate || 0}</div>
              <div className="text-xs text-gray-500">Da Attivare</div>
            </div>
            <div>
              <div className="text-xl font-bold text-brand-600">{formatEur(recommendations.summary?.estimatedSavings || 0)}</div>
              <div className="text-xs text-gray-500">Risparmio Stimato/mese</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabProducts({ tenantId }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [classification, setClassification] = useState('');
  const [sortBy, setSortBy] = useState('health_score');
  const [sortDir, setSortDir] = useState('desc');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 25, sortBy, sortDir });
      if (search) params.set('search', search);
      if (classification) params.set('classification', classification);
      const result = await api(`/optimization/health/products?${params}`);
      setData(result);
    } catch (err) { console.error(err); }
    setLoading(false);
  }, [page, search, classification, sortBy, sortDir]);

  useEffect(() => { load(); }, [load]);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
    setPage(1);
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-3 items-center">
        <input
          type="text"
          placeholder="Cerca SKU o nome..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-64"
        />
        <select
          value={classification}
          onChange={e => { setClassification(e.target.value); setPage(1); }}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="">Tutte le classi</option>
          <option value="star">Star</option>
          <option value="cash_cow">Cash Cow</option>
          <option value="burner">Burner</option>
          <option value="opportunity">Opportunit\u00e0</option>
          <option value="question_mark">In Analisi</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" />
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
                  <tr>
                    <th className="px-4 py-3 text-left">Prodotto</th>
                    <th className="px-3 py-3 text-center cursor-pointer hover:text-gray-700"
                        onClick={() => handleSort('classification')}>Classe</th>
                    <th className="px-3 py-3 text-center cursor-pointer hover:text-gray-700"
                        onClick={() => handleSort('health_score')}>
                      Score {sortBy === 'health_score' ? (sortDir === 'desc' ? '\u2193' : '\u2191') : ''}
                    </th>
                    <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700"
                        onClick={() => handleSort('tp_clicks_30d')}>
                      Click 30gg {sortBy === 'tp_clicks_30d' ? (sortDir === 'desc' ? '\u2193' : '\u2191') : ''}
                    </th>
                    <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700"
                        onClick={() => handleSort('tp_attributed_revenue')}>
                      Revenue {sortBy === 'tp_attributed_revenue' ? (sortDir === 'desc' ? '\u2193' : '\u2191') : ''}
                    </th>
                    <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700"
                        onClick={() => handleSort('tp_cost_incidence')}>
                      Incid. {sortBy === 'tp_cost_incidence' ? (sortDir === 'desc' ? '\u2193' : '\u2191') : ''}
                    </th>
                    <th className="px-3 py-3 text-center">Civetta</th>
                    <th className="px-3 py-3 text-center">Priorit\u00e0</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(data?.data || []).map(row => (
                    <tr key={row.sku} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 truncate max-w-xs">{row.product_name || row.sku}</div>
                        <div className="text-xs text-gray-400">{row.sku} {row.brand ? `\u2022 ${row.brand}` : ''}</div>
                      </td>
                      <td className="px-3 py-3 text-center"><ClassBadge classification={row.classification} /></td>
                      <td className="px-3 py-3 text-center"><HealthBar score={row.health_score} /></td>
                      <td className="px-3 py-3 text-right text-gray-700">{parseInt(row.tp_clicks_30d) || 0}</td>
                      <td className="px-3 py-3 text-right text-gray-700">
                        {parseFloat(row.tp_attributed_revenue) > 0 ? formatEur(row.tp_attributed_revenue) : '-'}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {parseFloat(row.tp_cost_incidence) > 0 ? (
                          <span className={parseFloat(row.tp_cost_incidence) > 0.05 ? 'text-red-600 font-medium' : 'text-green-600'}>
                            {(parseFloat(row.tp_cost_incidence) * 100).toFixed(1)}%
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`inline-block w-3 h-3 rounded-full ${row.is_civetta ? 'bg-green-500' : 'bg-gray-300'}`} />
                        {row.rec_civetta !== null && row.rec_civetta !== row.is_civetta && (
                          <span className="ml-1 text-xs text-amber-600">{row.rec_civetta ? '\u2191' : '\u2193'}</span>
                        )}
                      </td>
                      <td className={`px-3 py-3 text-center text-xs ${priorityColors[row.rec_priority] || ''}`}>
                        {row.rec_priority || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {data?.pagination && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-500">
                {data.pagination.total} prodotti totali
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-30"
                >Prec</button>
                <span className="px-3 py-1 text-sm text-gray-600">
                  {page} / {data.pagination.totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(data.pagination.totalPages, p + 1))}
                  disabled={page >= data.pagination.totalPages}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-30"
                >Succ</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TabBurners() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/optimization/burners').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Prodotti Burner" value={data.summary?.total_burners || 0} accent="text-red-600" />
        <KpiCard label="Spreco Totale 30gg" value={formatEur(parseFloat(data.summary?.total_waste || 0))} accent="text-red-600" />
        <KpiCard label="Click Sprecati" value={parseInt(data.summary?.total_wasted_clicks) || 0} />
      </div>

      {/* Burner Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-red-50 text-gray-500 uppercase text-xs">
              <tr>
                <th className="px-4 py-3 text-left">Prodotto</th>
                <th className="px-3 py-3 text-right">Click 30gg</th>
                <th className="px-3 py-3 text-right">Spreco</th>
                <th className="px-3 py-3 text-right">Revenue</th>
                <th className="px-3 py-3 text-right">Prezzo</th>
                <th className="px-3 py-3 text-right">MC Suggested</th>
                <th className="px-3 py-3 text-center">Civetta</th>
                <th className="px-4 py-3 text-left">Diagnosi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data.burners || []).map(row => (
                <tr key={row.sku} className="hover:bg-red-50/30">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 truncate max-w-[200px]">{row.product_name || row.sku}</div>
                    <div className="text-xs text-gray-400">{row.sku}</div>
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-red-600">{parseInt(row.tp_clicks_30d)}</td>
                  <td className="px-3 py-3 text-right font-medium text-red-600">{formatEur(parseFloat(row.tp_click_cost_30d))}</td>
                  <td className="px-3 py-3 text-right text-gray-600">
                    {parseFloat(row.tp_attributed_revenue) > 0 ? formatEur(row.tp_attributed_revenue) : '-'}
                  </td>
                  <td className="px-3 py-3 text-right text-gray-600">{formatEur(parseFloat(row.sell_price || 0))}</td>
                  <td className="px-3 py-3 text-right text-gray-600">
                    {row.mc_suggested_price ? formatEur(parseFloat(row.mc_suggested_price)) : '-'}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className={`inline-block w-3 h-3 rounded-full ${row.is_civetta ? 'bg-green-500' : 'bg-gray-300'}`} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 max-w-[300px] truncate">{row.rec_reasoning}</td>
                </tr>
              ))}
              {(!data.burners || data.burners.length === 0) && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">Nessun burner rilevato</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TabOpportunities() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/optimization/opportunities').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-blue-50 text-gray-500 uppercase text-xs">
              <tr>
                <th className="px-4 py-3 text-left">Prodotto</th>
                <th className="px-3 py-3 text-center">Health Score</th>
                <th className="px-3 py-3 text-center">MC Click Potential</th>
                <th className="px-3 py-3 text-right">Prezzo Attuale</th>
                <th className="px-3 py-3 text-right">Benchmark MC</th>
                <th className="px-3 py-3 text-right">Prezzo Suggerito</th>
                <th className="px-3 py-3 text-right">Vendite 30gg</th>
                <th className="px-3 py-3 text-right">Competitor</th>
                <th className="px-4 py-3 text-left">Analisi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data.opportunities || []).map(row => (
                <tr key={row.sku} className="hover:bg-blue-50/30">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 truncate max-w-[200px]">{row.product_name || row.sku}</div>
                    <div className="text-xs text-gray-400">{row.sku}</div>
                  </td>
                  <td className="px-3 py-3 text-center"><HealthBar score={row.health_score} /></td>
                  <td className="px-3 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      row.mc_click_potential === 'HIGH' ? 'bg-green-100 text-green-700' :
                      row.mc_click_potential === 'MEDIUM' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>{row.mc_click_potential || '-'}</span>
                  </td>
                  <td className="px-3 py-3 text-right">{formatEur(parseFloat(row.sell_price || 0))}</td>
                  <td className="px-3 py-3 text-right text-gray-600">
                    {row.mc_benchmark_price ? formatEur(parseFloat(row.mc_benchmark_price)) : '-'}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {row.rec_price ? (
                      <span className="text-blue-600 font-medium">{formatEur(parseFloat(row.rec_price))}</span>
                    ) : '-'}
                  </td>
                  <td className="px-3 py-3 text-right">{parseInt(row.sales_30d_seller) || 0}</td>
                  <td className="px-3 py-3 text-right">{parseInt(row.scraper_competitor_count) || 0}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 max-w-[300px] truncate">{row.rec_reasoning}</td>
                </tr>
              ))}
              {(!data.opportunities || data.opportunities.length === 0) && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">Nessuna opportunit\u00e0 rilevata</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// --- TAB: Feed Actions ---

const actionColors = {
  REMOVE: { bg: 'bg-red-50', text: 'text-red-700', badge: 'bg-red-100 text-red-800' },
  ADD: { bg: 'bg-green-50', text: 'text-green-700', badge: 'bg-green-100 text-green-800' },
  PRICE_CUT: { bg: 'bg-amber-50', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-800' },
  KEEP: { bg: 'bg-gray-50', text: 'text-gray-600', badge: 'bg-gray-100 text-gray-600' },
  MONITOR: { bg: 'bg-blue-50', text: 'text-blue-700', badge: 'bg-blue-100 text-blue-800' },
};

function TabFeedActions() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 25 });
      if (filter) params.set('action', filter);
      const result = await api(`/optimization/feed-actions?${params}`);
      setData(result);
    } catch (err) { console.error(err); }
    setLoading(false);
  }, [filter, page]);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary || [];
  const actions = data?.actions || [];
  const pagination = data?.pagination || {};

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {['REMOVE', 'ADD', 'PRICE_CUT', 'KEEP', 'MONITOR'].map(act => {
          const s = summary.find(r => r.action === act);
          const colors = actionColors[act];
          return (
            <button
              key={act}
              onClick={() => { setFilter(filter === act ? '' : act); setPage(1); }}
              className={`rounded-xl border p-4 text-center transition-all ${
                filter === act ? 'ring-2 ring-brand-400 border-brand-400' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${colors.badge}`}>{act}</span>
              <div className="text-2xl font-bold text-gray-900 mt-2">{parseInt(s?.count) || 0}</div>
              {s?.total_cost && parseFloat(s.total_cost) > 0 && (
                <div className="text-xs text-gray-400 mt-1">costo {formatEur(parseFloat(s.total_cost))}</div>
              )}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
                  <tr>
                    <th className="px-4 py-3 text-left">Prodotto</th>
                    <th className="px-3 py-3 text-center">Azione</th>
                    <th className="px-3 py-3 text-right">Click</th>
                    <th className="px-3 py-3 text-right">Costo</th>
                    <th className="px-3 py-3 text-right">Budget %</th>
                    <th className="px-3 py-3 text-right">Pos. TP</th>
                    <th className="px-3 py-3 text-right">Prezzo</th>
                    <th className="px-3 py-3 text-right">Nuovo Prezzo</th>
                    <th className="px-4 py-3 text-left">Motivazione</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {actions.map(a => {
                    const colors = actionColors[a.action] || actionColors.MONITOR;
                    return (
                      <tr key={a.sku} className={`hover:bg-gray-50 ${colors.bg}`}>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 truncate max-w-[180px]">{a.product_name || a.sku}</div>
                          <div className="text-xs text-gray-400">{a.sku} {a.brand ? `- ${a.brand}` : ''}</div>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-bold ${colors.badge}`}>{a.action}</span>
                        </td>
                        <td className="px-3 py-3 text-right text-gray-700">{a.clicks_consumed || 0}</td>
                        <td className="px-3 py-3 text-right text-gray-700">{formatEur(parseFloat(a.cost_consumed) || 0)}</td>
                        <td className="px-3 py-3 text-right">
                          <span className={parseFloat(a.budget_pct_used) > 100 ? 'text-red-600 font-medium' : 'text-gray-600'}>
                            {parseFloat(a.budget_pct_used) > 0 ? parseFloat(a.budget_pct_used).toFixed(0) + '%' : '-'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-gray-700">{a.tp_position || '-'}</td>
                        <td className="px-3 py-3 text-right text-gray-700">{formatEur(parseFloat(a.current_price) || 0)}</td>
                        <td className="px-3 py-3 text-right">
                          {a.recommended_price ? (
                            <span className="text-amber-600 font-medium">{formatEur(parseFloat(a.recommended_price))}</span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 max-w-[280px]">
                          <div className="truncate" title={a.action_reason}>{a.action_reason}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-500">{pagination.total} azioni totali</div>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-30">Prec</button>
                <span className="px-3 py-1 text-sm text-gray-600">{page} / {pagination.totalPages}</span>
                <button onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))} disabled={page >= pagination.totalPages}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-30">Succ</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- TAB: Piano Ottimizzazione (Global Prediction) ---

function TabPlan() {
  const [data, setData] = useState(null);
  const [predictions, setPredictions] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/optimization/health'),
      api('/optimization/predictions'),
    ]).then(([h, p]) => {
      setData(h);
      setPredictions(p);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data) return null;

  // Feed engine global data from health_config (saved by feedEngine)
  const currentCost = parseFloat(data.feed_current_cost_14d) || 0;
  const currentRevenue = parseFloat(data.feed_current_revenue_14d) || 0;
  const projectedCost = parseFloat(data.feed_projected_cost_14d) || 0;
  const savings = parseFloat(data.feed_savings_from_removals) || 0;
  const removals = parseInt(data.feed_action_removals) || 0;
  const priceCuts = parseInt(data.feed_action_price_cuts) || 0;
  const additions = parseInt(data.feed_action_additions) || 0;
  const currentIncidence = currentRevenue > 0 ? (currentCost / currentRevenue) * 100 : 0;
  const projectedIncidence = currentRevenue > 0 ? (projectedCost / currentRevenue) * 100 : 0;
  const lastRun = data.feed_last_run;

  // Prediction status summary
  const predSummary = predictions?.summary || [];
  const predList = predictions?.predictions || [];

  return (
    <div className="space-y-6">
      {/* Global Plan */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Piano di Ottimizzazione</h3>
          {lastRun && <span className="text-xs text-gray-400">Aggiornato: {new Date(lastRun).toLocaleString('it-IT')}</span>}
        </div>

        <div className="grid grid-cols-2 gap-8">
          {/* OGGI */}
          <div className="border rounded-xl p-5 bg-gray-50">
            <h4 className="text-sm font-medium text-gray-500 uppercase mb-3">Oggi (14gg)</h4>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600">Spesa Click TP</span>
                <span className="font-bold text-red-600">{formatEur(currentCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Incasso TP (GA4)</span>
                <span className="font-bold text-green-600">{formatEur(currentRevenue)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between">
                <span className="text-gray-700 font-medium">Incidenza</span>
                <span className={`font-bold text-lg ${currentIncidence <= 5 ? 'text-green-600' : currentIncidence <= 8 ? 'text-amber-600' : 'text-red-600'}`}>
                  {currentIncidence.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>

          {/* PROIEZIONE */}
          <div className="border-2 border-brand-300 rounded-xl p-5 bg-brand-50">
            <h4 className="text-sm font-medium text-brand-600 uppercase mb-3">Proiezione (prossimi 7gg)</h4>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600">Spesa Click TP</span>
                <span className="font-bold text-green-600">{formatEur(projectedCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Risparmio</span>
                <span className="font-bold text-green-600">-{formatEur(savings)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between">
                <span className="text-gray-700 font-medium">Incidenza prevista</span>
                <span className={`font-bold text-lg ${projectedIncidence <= 5 ? 'text-green-600' : projectedIncidence <= 8 ? 'text-amber-600' : 'text-red-600'}`}>
                  {projectedIncidence.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Actions summary */}
        <div className="mt-6 grid grid-cols-3 gap-4">
          <div className="text-center p-3 bg-red-50 rounded-lg">
            <div className="text-2xl font-bold text-red-700">{removals}</div>
            <div className="text-xs text-red-600">Prodotti da rimuovere</div>
            <div className="text-xs text-gray-400">click senza conversioni</div>
          </div>
          <div className="text-center p-3 bg-amber-50 rounded-lg">
            <div className="text-2xl font-bold text-amber-700">{priceCuts}</div>
            <div className="text-xs text-amber-600">Tagli prezzo</div>
            <div className="text-xs text-gray-400">per migliorare posizione</div>
          </div>
          <div className="text-center p-3 bg-green-50 rounded-lg">
            <div className="text-2xl font-bold text-green-700">{additions}</div>
            <div className="text-xs text-green-600">Pepite da attivare</div>
            <div className="text-xs text-gray-400">alto potenziale</div>
          </div>
        </div>
      </div>

      {/* Active predictions monitoring */}
      {predList.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            Monitoring Azioni ({predList.filter(p => p.status === 'active' || p.status === 'on_track').length} attive)
          </h3>
          <div className="flex gap-2 mb-3 flex-wrap">
            {predSummary.map(s => (
              <span key={s.status} className={`px-2 py-1 rounded text-xs font-medium ${
                s.status === 'on_track' ? 'bg-green-100 text-green-700' :
                s.status === 'underperforming' ? 'bg-red-100 text-red-700' :
                s.status === 'corrected' ? 'bg-amber-100 text-amber-700' :
                s.status === 'exceeded' ? 'bg-green-200 text-green-800' :
                'bg-gray-100 text-gray-600'
              }`}>{s.status}: {s.count}</span>
            ))}
          </div>

          {/* Show only REMOVE/ADD predictions that need attention */}
          {predList.filter(p => ['underperforming', 'corrected', 'active'].includes(p.status)).length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
                  <tr>
                    <th className="px-4 py-2 text-left">Prodotto</th>
                    <th className="px-3 py-2 text-center">Azione</th>
                    <th className="px-3 py-2 text-center">Status</th>
                    <th className="px-3 py-2 text-right">Click reali</th>
                    <th className="px-3 py-2 text-right">Ordini reali</th>
                    <th className="px-4 py-2 text-left">Correzione</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {predList.filter(p => ['underperforming', 'corrected', 'active'].includes(p.status)).slice(0, 30).map(p => (
                    <tr key={p.sku} className="hover:bg-gray-50">
                      <td className="px-4 py-2">
                        <div className="font-medium text-gray-900 truncate max-w-[180px]">{p.product_name || p.sku}</div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${(actionColors[p.action] || actionColors.MONITOR).badge}`}>{p.action}</span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          p.status === 'on_track' ? 'bg-green-100 text-green-700' :
                          p.status === 'underperforming' ? 'bg-red-100 text-red-700' :
                          p.status === 'corrected' ? 'bg-amber-100 text-amber-700' :
                          'bg-blue-100 text-blue-700'
                        }`}>{p.status}</span>
                      </td>
                      <td className="px-3 py-2 text-right">{p.actual_clicks || 0}</td>
                      <td className="px-3 py-2 text-right">{p.actual_orders || 0}</td>
                      <td className="px-4 py-2 text-xs text-gray-500 truncate max-w-[200px]">
                        {p.correction_reason || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- MAIN PAGE ---

export default function FeedOptimizer() {
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [health, setHealth] = useState(null);
  const [recommendations, setRecommendations] = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [h, r, w] = await Promise.all([
        api('/optimization/health'),
        api('/optimization/recommendations'),
        api('/optimization/weekly'),
      ]);
      setHealth(h);
      setRecommendations(r);
      setWeekly(w.weeks);
    } catch (err) {
      console.error('Load error:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const triggerEnrich = async () => {
    setEnriching(true);
    try {
      await apiPost('/optimization/enrich');
      // Wait a bit then reload
      setTimeout(() => { loadData(); setEnriching(false); }, 15000);
    } catch { setEnriching(false); }
  };

  const tabs = [
    { id: 'overview', label: 'Panoramica' },
    { id: 'feed-actions', label: 'Azioni Feed' },
    { id: 'plan', label: 'Piano' },
    { id: 'products', label: 'Prodotti' },
    { id: 'burners', label: 'Burner' },
    { id: 'opportunities', label: 'Opportunit\u00e0' },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ottimizzazione Feed</h1>
          <p className="text-sm text-gray-500 mt-1">
            Analisi prodotti, scoring, P&L e raccomandazioni per Trovaprezzi
          </p>
        </div>
        {(user?.role === 'superadmin' || user?.role === 'admin') && (
          <button
            onClick={triggerEnrich}
            disabled={enriching}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 text-sm font-medium"
          >
            {enriching ? 'Calcolo in corso...' : 'Ricalcola Score'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-6">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >{t.label}</button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {tab === 'overview' && <TabOverview health={health} recommendations={recommendations} weekly={weekly} />}
      {tab === 'feed-actions' && <TabFeedActions />}
      {tab === 'plan' && <TabPlan />}
      {tab === 'products' && <TabProducts />}
      {tab === 'burners' && <TabBurners />}
      {tab === 'opportunities' && <TabOpportunities />}
    </div>
  );
}
