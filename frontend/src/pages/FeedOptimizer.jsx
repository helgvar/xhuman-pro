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

function downloadExcel(type, query = '') {
  return authFetch(`/api/optimization/export/${type}${query ? '?' + query : ''}`)
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `xhumanpro-${type}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    });
}

function ExportButton({ type, query, label }) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      onClick={() => { setLoading(true); downloadExcel(type, query).finally(() => setLoading(false)); }}
      disabled={loading}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 disabled:opacity-50"
    >
      {loading ? (
        <div className="animate-spin h-3 w-3 border-2 border-green-500 border-t-transparent rounded-full" />
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
      )}
      {label || 'Excel'}
    </button>
  );
}

// --- DATE RANGE SELECTOR ---

function formatDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return formatDate(d); }

function DateRangeKpi() {
  const [preset, setPreset] = useState('7');
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(formatDate(new Date()));
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareFrom, setCompareFrom] = useState(daysAgo(13));
  const [compareTo, setCompareTo] = useState(daysAgo(7));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ from, to });
    if (compareEnabled) { params.set('compare_from', compareFrom); params.set('compare_to', compareTo); }
    const result = await api(`/optimization/kpi-range?${params}`);
    setData(result);
    setLoading(false);
  }, [from, to, compareEnabled, compareFrom, compareTo]);

  useEffect(() => { load(); }, [load]);

  const applyPreset = (days) => {
    setPreset(days);
    const newTo = formatDate(new Date());
    // "Oggi" (days=1) → from=to=oggi. "7gg" → ultimi 7 giorni (from=6gg fa, to=oggi).
    // Prima usava daysAgo(days) che dava 8 giorni per "7gg" e 2 giorni per "Oggi".
    const newFrom = daysAgo(Math.max(0, parseInt(days) - 1));
    setFrom(newFrom);
    setTo(newTo);
    if (compareEnabled) {
      // Finestra confronto della stessa lunghezza, immediatamente precedente.
      const len = parseInt(days);
      setCompareTo(daysAgo(len));
      setCompareFrom(daysAgo(len * 2 - 1));
    }
  };

  const delta = (curr, prev) => {
    if (!prev || prev === 0) return null;
    return +((curr - prev) / prev * 100).toFixed(1);
  };
  const deltaColor = (d, inverted) => {
    if (d === null) return '';
    if (inverted) return d > 0 ? 'text-red-500' : 'text-green-500';
    return d > 0 ? 'text-green-500' : 'text-red-500';
  };
  const deltaStr = (d) => d === null ? '' : (d > 0 ? '+' : '') + d + '%';

  const c = data?.current;
  const p = data?.comparison;

  return (
    <div className="space-y-3">
      {/* Date Range Selector */}
      <div className="bg-white rounded-xl border border-gray-200 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-gray-500 uppercase">Periodo:</span>
          {[['1', 'Oggi'], ['7', '7gg'], ['15', '15gg'], ['30', '30gg']].map(([v, l]) => (
            <button key={v} onClick={() => applyPreset(v)}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-all ${preset === v ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {l}
            </button>
          ))}
          <div className="flex items-center gap-1 ml-2">
            <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPreset('custom'); }}
              className="px-2 py-1 text-xs border rounded-lg" />
            <span className="text-gray-400">-</span>
            <input type="date" value={to} onChange={e => { setTo(e.target.value); setPreset('custom'); }}
              className="px-2 py-1 text-xs border rounded-lg" />
          </div>
          <label className="flex items-center gap-1.5 ml-4 cursor-pointer">
            <input type="checkbox" checked={compareEnabled} onChange={e => {
              setCompareEnabled(e.target.checked);
              if (e.target.checked) { setCompareTo(from); setCompareFrom(daysAgo(parseInt(preset || '7') * 2)); }
            }} className="w-3.5 h-3.5 text-brand-600 rounded" />
            <span className="text-xs text-gray-600">Confronta</span>
          </label>
          {compareEnabled && (
            <div className="flex items-center gap-1">
              <input type="date" value={compareFrom} onChange={e => setCompareFrom(e.target.value)}
                className="px-2 py-1 text-xs border rounded-lg bg-yellow-50" />
              <span className="text-gray-400">-</span>
              <input type="date" value={compareTo} onChange={e => setCompareTo(e.target.value)}
                className="px-2 py-1 text-xs border rounded-lg bg-yellow-50" />
            </div>
          )}
          {data?.dataAvailable && (
            <span className="text-[10px] text-gray-400 ml-auto">
              Dati disponibili: {data.dataAvailable.firstDate} - {data.dataAvailable.lastDate} ({data.dataAvailable.totalDays}gg)
            </span>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      {loading ? (
        <div className="flex justify-center py-4"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-brand-500" /></div>
      ) : c && (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <div className="bg-white rounded-xl border p-3">
            <div className="text-[10px] text-gray-500 uppercase">Click TP</div>
            <div className="text-lg font-bold">{c.clicks.toLocaleString()}</div>
            <div className="text-[10px] text-gray-400">{c.daysWithClicks}gg con click</div>
            {p && <div className={`text-xs font-medium ${deltaColor(delta(c.clicks, p.clicks), false)}`}>{deltaStr(delta(c.clicks, p.clicks))}</div>}
          </div>
          <div className="bg-white rounded-xl border p-3">
            <div className="text-[10px] text-gray-500 uppercase">Costo Click</div>
            <div className="text-lg font-bold text-red-600">{formatEur(c.clickCost)}</div>
            {p && <div className={`text-xs font-medium ${deltaColor(delta(c.clickCost, p.clickCost), true)}`}>{deltaStr(delta(c.clickCost, p.clickCost))}</div>}
          </div>
          <div className="bg-white rounded-xl border p-3">
            <div className="text-[10px] text-gray-500 uppercase">Ordini Store</div>
            <div className="text-lg font-bold">{c.storeOrders}</div>
            <div className="text-[10px] text-gray-400">media {c.storeOrders > 0 && c.daysWithClicks > 0 ? (c.storeOrders / c.daysWithClicks).toFixed(1) : '-'}/gg</div>
            {p && <div className={`text-xs font-medium ${deltaColor(delta(c.storeOrders, p.storeOrders), false)}`}>{deltaStr(delta(c.storeOrders, p.storeOrders))}</div>}
          </div>
          <div className="bg-white rounded-xl border p-3">
            <div className="text-[10px] text-gray-500 uppercase">Fatturato Store</div>
            <div className="text-lg font-bold text-green-600">{formatEur(c.storeRevenue)}</div>
            {p && <div className={`text-xs font-medium ${deltaColor(delta(c.storeRevenue, p.storeRevenue), false)}`}>{deltaStr(delta(c.storeRevenue, p.storeRevenue))}</div>}
          </div>
          <div className="bg-white rounded-xl border p-3">
            <div className="text-[10px] text-gray-500 uppercase" title="Costo click / fatturato store totale del periodo">Incidenza Store (rif.)</div>
            <div className={`text-lg font-bold ${c.incidenceStore > 10 ? 'text-red-600' : c.incidenceStore > 5 ? 'text-yellow-600' : 'text-green-600'}`}>
              {c.incidenceStore ? c.incidenceStore + '%' : '-'}
            </div>
            <div className="text-[10px] text-gray-400">costo / fatt. store · vedi snapshot TP per quella vera</div>
            {p && <div className={`text-xs font-medium ${deltaColor(delta(c.incidenceStore, p.incidenceStore), true)}`}>{deltaStr(delta(c.incidenceStore, p.incidenceStore))}</div>}
          </div>
          <div className="bg-white rounded-xl border p-3">
            <div className="text-[10px] text-gray-500 uppercase">Conv. Rate</div>
            <div className="text-lg font-bold text-brand-600">{c.convRate ? c.convRate + '%' : '-'}</div>
            <div className="text-[10px] text-gray-400">ordini / click</div>
            {p && <div className={`text-xs font-medium ${deltaColor(delta(c.convRate, p.convRate), false)}`}>{deltaStr(delta(c.convRate, p.convRate))}</div>}
          </div>
        </div>
      )}

      {/* Period info banner */}
      {c && (
        <div className="bg-gray-50 rounded-lg px-4 py-2 text-xs text-gray-500 flex items-center justify-between">
          <span>Periodo selezionato: <strong>{c.dateFrom}</strong> - <strong>{c.dateTo}</strong> | Click dal {c.firstClick || '-'} al {c.lastClick || '-'}</span>
          {p && <span className="bg-yellow-50 px-2 py-0.5 rounded">vs {p.dateFrom} - {p.dateTo}</span>}
        </div>
      )}
    </div>
  );
}

// --- SORTABLE TABLE HELPER ---
function useSortable(defaultCol = '', defaultDir = 'desc') {
  const [sortBy, setSortBy] = useState(defaultCol);
  const [sortDir, setSortDir] = useState(defaultDir);
  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };
  const sortIcon = (col) => sortBy === col ? (sortDir === 'desc' ? ' \u25BC' : ' \u25B2') : '';
  const sortRows = (rows, valFn) => {
    if (!sortBy) return rows;
    return [...rows].sort((a, b) => {
      const va = valFn ? valFn(a, sortBy) : (parseFloat(a[sortBy]) || 0);
      const vb = valFn ? valFn(b, sortBy) : (parseFloat(b[sortBy]) || 0);
      return sortDir === 'desc' ? vb - va : va - vb;
    });
  };
  const thClass = "cursor-pointer hover:text-gray-700 select-none";
  return { sortBy, sortDir, handleSort, sortIcon, sortRows, thClass };
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
  const totalClickCost = parseFloat(h.real_click_cost) || parseFloat(h.total_click_cost) || 0;
  const realRevenue = parseFloat(h.real_revenue) || 0;
  const realClicks = parseInt(h.real_clicks) || 0;
  const realOrders = parseInt(h.real_orders) || parseInt(h.store_orders) || 0;
  const revenueSource = h.revenue_source || 'magento';
  const burnerWaste = parseFloat(h.burner_waste) || 0;

  // GA4 data
  const ga4TpRevenue = parseFloat(h.ga4_tp_revenue) || 0;
  const ga4TpTransactions = parseInt(h.ga4_tp_transactions) || 0;
  const ga4TpSessions = parseInt(h.ga4_tp_sessions) || 0;
  const ga4TpConvRate = parseFloat(h.ga4_tp_conv_rate) || 0;
  const hasGA4 = ga4TpRevenue > 0;
  const avgScore = parseFloat(h.avg_health_score) || 0;

  return (
    <div className="space-y-6">
      {/* SNAPSHOT TP-attribuito - riferimento unico */}
      <div className="bg-gradient-to-br from-teal-50 to-emerald-50 border border-teal-200 rounded-xl p-5 mb-1">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-teal-900 uppercase tracking-wide">
            Snapshot TP-attribuito
            {h.ga4_data_start_date
              ? ' (dal ' + new Date(h.ga4_data_start_date).toLocaleDateString('it-IT') + ')'
              : ' (ultimi 30gg)'}
          </h2>
          <span className="text-xs text-teal-700">Fonte: GA4 last-click + cross-session</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {(() => {
            const tpDirect = parseFloat(h.ga4_tp_revenue) || 0;
            const tpIndir = parseFloat(h.ga4_cross_session_revenue) || 0;
            const tpTotal = +(tpDirect + tpIndir).toFixed(2);
            const tpTx = (parseInt(h.ga4_tp_transactions) || 0) + (parseInt(h.ga4_cross_session_transactions) || 0);
            // costo allineato alla finestra GA4 (30gg o ga4_data_start_date) — NON cumulativo
            const cost30d = parseFloat(h.click_cost_30d) || 0;
            const clicks30d = parseInt(h.clicks_30d) || 0;
            const incTP = tpTotal > 0 ? +(cost30d / tpTotal * 100).toFixed(2) : null;
            const incClass = incTP == null ? '' : incTP <= 15 ? 'text-emerald-700' : incTP <= 30 ? 'text-amber-700' : 'text-red-600';
            return (
              <>
                <KpiCard
                  label="Incidenza TP"
                  value={incTP != null ? incTP + '%' : '-'}
                  sub={cost30d > 0 ? 'costo ' + formatEur(cost30d) + ' / TP-attribuito' : 'costo click / fatt. TP-attribuito'}
                  accent={incClass}
                />
                <KpiCard label="Fatturato TP attribuito" value={tpTotal > 0 ? formatEur(tpTotal) : '-'} sub={tpTotal > 0 ? 'direct ' + formatEur(tpDirect) + ' + indir. ' + formatEur(tpIndir) : 'GA4 non disponibile'} accent="text-teal-700" />
                <KpiCard label="Ordini TP" value={tpTx > 0 ? tpTx.toLocaleString('it-IT') : '-'} sub={tpTx > 0 ? (parseInt(h.ga4_tp_transactions) || 0) + ' direct + ' + (parseInt(h.ga4_cross_session_transactions) || 0) + ' cross-session' : '-'} />
                <KpiCard label="Spreco Burner" value={formatEur(burnerWaste)} sub={(parseInt(h.burners) || 0) + ' prodotti burner attivi'} accent="text-red-600" />
              </>
            );
          })()}
        </div>
      </div>

      {/* KPI Grid - HIDDEN: ridondante con Snapshot TP, mantenuto solo come fallback se GA4 mancante */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 hidden">
        <IncidenceGauge value={h.global_incidence || 0} />
        <KpiCard
          label="Costo Click TP"
          value={formatEur(totalClickCost)}
          sub={`${realClicks.toLocaleString('it-IT')} click x \u20AC0.27`}
        />
        <KpiCard
          label="Fatturato Store"
          value={formatEur(parseFloat(h.store_revenue) || 0)}
          sub={`${parseInt(h.store_orders) || 0} ordini (Magento)`}
          accent="text-green-700"
        />
        <KpiCard
          label="Spreco Burner"
          value={formatEur(burnerWaste)}
          sub={`${parseInt(h.burners) || 0} prodotti burner`}
          accent="text-red-600"
        />
      </div>

      {/* Revenue Breakdown: HIDDEN - ridondante con Snapshot TP, sostituita da blocco singolo */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 hidden">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Distribuzione Fatturato per Canale</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="border rounded-lg p-3">
            <div className="text-[10px] text-gray-500 uppercase">Fatturato Store Totale</div>
            <div className="text-xl font-bold text-gray-900">{formatEur(parseFloat(h.store_revenue) || 0)}</div>
            <div className="text-xs text-gray-400">{parseInt(h.store_orders) || 0} ordini (Magento 30gg)</div>
          </div>
          <div className="border rounded-lg p-3 bg-blue-50/30">
            <div className="text-[10px] text-gray-500 uppercase">Fatturato Trovaprezzi (GA4)</div>
            <div className="text-xl font-bold text-blue-600">{formatEur(parseFloat(h.ga4_ft_revenue) || 0)}</div>
            <div className="text-xs text-gray-400">{parseInt(h.ga4_ft_transactions) || 0} ordini TP (first-touch)</div>
            {parseFloat(h.store_revenue) > 0 && parseFloat(h.ga4_ft_revenue) > 0 && (
              <div className="text-xs text-blue-500 mt-1">{((parseFloat(h.ga4_ft_revenue) / parseFloat(h.store_revenue)) * 100).toFixed(1)}% del totale store</div>
            )}
          </div>
          <div className="border rounded-lg p-3 bg-green-50/30">
            <div className="text-[10px] text-gray-500 uppercase">Incidenza su Store</div>
            <div className={`text-xl font-bold ${(totalClickCost / Math.max(parseFloat(h.store_revenue) || 1, 1) * 100) > 10 ? 'text-red-600' : 'text-green-600'}`}>
              {parseFloat(h.store_revenue) > 0 ? ((totalClickCost / parseFloat(h.store_revenue)) * 100).toFixed(1) + '%' : '-'}
            </div>
            <div className="text-xs text-gray-400">costo click / fatt. store</div>
          </div>
          <div className="border rounded-lg p-3 bg-yellow-50/30">
            <div className="text-[10px] text-gray-500 uppercase">Incidenza su TP (GA4)</div>
            <div className={`text-xl font-bold ${parseFloat(h.ga4_ft_revenue) > 0 && (totalClickCost / parseFloat(h.ga4_ft_revenue) * 100) > 15 ? 'text-red-600' : 'text-yellow-600'}`}>
              {parseFloat(h.ga4_ft_revenue) > 0 ? ((totalClickCost / parseFloat(h.ga4_ft_revenue)) * 100).toFixed(1) + '%' : '-'}
            </div>
            <div className="text-xs text-gray-400">costo click / fatt. TP GA4</div>
          </div>
        </div>
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
        <div className="ml-auto">
          <ExportButton type="products" query={classification ? `classification=${classification}` : ''} label="Scarica Excel" />
        </div>
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
  const { handleSort, sortIcon, sortRows, thClass } = useSortable('tp_click_cost_30d');

  useEffect(() => {
    api('/optimization/burners').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data) return null;

  const burners = sortRows(data.burners || []);

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
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
          <span className="text-sm font-medium text-gray-700">Dettaglio Burner</span>
          <ExportButton type="burners" label="Scarica Excel" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-red-50 text-gray-500 uppercase text-xs">
              <tr>
                <th className="px-4 py-3 text-left">Prodotto</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('tp_clicks_30d')}>Click 30gg{sortIcon('tp_clicks_30d')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('tp_click_cost_30d')}>Spreco{sortIcon('tp_click_cost_30d')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('tp_attributed_revenue')}>Revenue{sortIcon('tp_attributed_revenue')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('sell_price')}>Prezzo{sortIcon('sell_price')}</th>
                <th className="px-3 py-3 text-right">MC Suggested</th>
                <th className="px-3 py-3 text-center">Civetta</th>
                <th className="px-4 py-3 text-left">Diagnosi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {burners.map(row => (
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
  const { handleSort, sortIcon, sortRows, thClass } = useSortable('health_score');

  useEffect(() => {
    api('/optimization/opportunities').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
          <span className="text-sm font-medium text-gray-700">Opportunit&agrave;</span>
          <ExportButton type="opportunities" label="Scarica Excel" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-blue-50 text-gray-500 uppercase text-xs">
              <tr>
                <th className="px-4 py-3 text-left">Prodotto</th>
                <th className={`px-3 py-3 text-center ${thClass}`} onClick={() => handleSort('health_score')}>Health Score{sortIcon('health_score')}</th>
                <th className="px-3 py-3 text-center">MC Click Potential</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('sell_price')}>Prezzo Attuale{sortIcon('sell_price')}</th>
                <th className="px-3 py-3 text-right">Benchmark MC</th>
                <th className="px-3 py-3 text-right">Prezzo Suggerito</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('sales_30d_aggregated')}>Vendite 30gg{sortIcon('sales_30d_aggregated')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('scraper_competitor_count')}>Competitor{sortIcon('scraper_competitor_count')}</th>
                <th className="px-4 py-3 text-left">Analisi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sortRows(data.opportunities || []).map(row => (
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
  const [availableOnly, setAvailableOnly] = useState(true);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 25 });
      if (filter) params.set('action', filter);
      if (availableOnly) params.set('available', '1');
      const result = await api(`/optimization/feed-actions?${params}`);
      setData(result);
    } catch (err) { console.error(err); }
    setLoading(false);
  }, [filter, availableOnly, page]);

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
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-gray-700">Feed Actions {filter ? `(${filter})` : ''}</span>
                <label className="inline-flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={availableOnly}
                    onChange={(e) => { setAvailableOnly(e.target.checked); setPage(1); }}
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  Solo disponibili (stock &gt; 0)
                </label>
              </div>
              <ExportButton type="feed-actions" label="Scarica Excel" />
            </div>
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
                          <span className={parseFloat(a.display_budget_pct ?? a.budget_pct_used) > 100 ? 'text-red-600 font-medium' : 'text-gray-600'}>
                            {parseFloat(a.display_budget_pct ?? a.budget_pct_used) > 0 ? parseFloat(a.display_budget_pct ?? a.budget_pct_used).toFixed(0) + '%' : '-'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right text-gray-700">{a.display_tp_position ?? a.tp_position ?? '-'}</td>
                        <td className="px-3 py-3 text-right text-gray-700">{formatEur(parseFloat(a.display_price ?? a.current_price ?? a.p_sell_price) || 0)}</td>
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

// --- MODULE: Category Rules (Tab) ---

function TabCategoryRules() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [localRules, setLocalRules] = useState({});
  const [enabled, setEnabled] = useState(false);
  const { handleSort, sortIcon, sortRows, thClass } = useSortable('clicks');

  useEffect(() => {
    api('/optimization/category-rules').then(d => {
      setData(d);
      setLocalRules(d.rules || {});
      setEnabled(d.enabled || false);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const saveRules = async () => {
    setSaving(true);
    await authFetch('/api/optimization/category-rules', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, rules: localRules }),
    });
    setSaving(false);
  };

  const toggleCategory = (cat, field, value) => {
    setLocalRules(prev => ({
      ...prev,
      [cat]: { ...(prev[cat] || {}), [field]: value },
    }));
  };

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
              className="w-4 h-4 text-brand-600 rounded" />
            <span className="text-sm font-medium">Modulo attivo</span>
          </label>
          {enabled && <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded">Attivo</span>}
        </div>
        <div className="flex gap-2">
          <ExportButton type="category-rules" label="Excel" />
          <button onClick={saveRules} disabled={saving}
            className="px-4 py-1.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
            {saving ? 'Salvando...' : 'Salva Regole'}
          </button>
        </div>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
              <tr>
                <th className="px-4 py-3 text-left">Categoria TP</th>
                <th className="px-3 py-3 text-center">Attiva</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('products')}>Prodotti{sortIcon('products')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('clicks')}>Click{sortIcon('clicks')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('orders')}>Ordini{sortIcon('orders')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('revenue')}>Revenue{sortIcon('revenue')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('incidence')}>Incidenza{sortIcon('incidence')}</th>
                <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('avg_margin')}>Margine{sortIcon('avg_margin')}</th>
                <th className="px-3 py-3 text-center">Max Incid.</th>
                <th className="px-3 py-3 text-center">Min Margine</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sortRows(data.categories || []).map(c => {
                const rule = localRules[c.category] || {};
                const inc = parseFloat(c.incidence);
                return (
                  <tr key={c.category} className={rule.enabled === false ? 'bg-red-50/30' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-2 font-medium text-gray-900 text-xs">{c.category}</td>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={rule.enabled !== false}
                        onChange={e => toggleCategory(c.category, 'enabled', e.target.checked)}
                        className="w-3.5 h-3.5 text-brand-600 rounded" />
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">{parseInt(c.products)}</td>
                    <td className="px-3 py-2 text-right">{parseInt(c.clicks).toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{parseInt(c.orders)}</td>
                    <td className="px-3 py-2 text-right text-green-600">{formatEur(parseFloat(c.revenue))}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={inc > 15 ? 'text-red-600 font-medium' : inc > 8 ? 'text-yellow-600' : 'text-green-600'}>
                        {inc ? inc + '%' : '-'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-500">{c.avg_margin}%</td>
                    <td className="px-3 py-2 text-center">
                      <input type="number" min="0" max="100" step="1"
                        value={rule.max_incidence || ''} placeholder="-"
                        onChange={e => toggleCategory(c.category, 'max_incidence', e.target.value ? parseInt(e.target.value) : null)}
                        className="w-14 px-1 py-0.5 text-xs text-center border rounded" />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input type="number" min="0" max="50" step="1"
                        value={rule.min_margin || ''} placeholder="-"
                        onChange={e => toggleCategory(c.category, 'min_margin', e.target.value ? parseInt(e.target.value) : null)}
                        className="w-14 px-1 py-0.5 text-xs text-center border rounded" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// --- MODULE: Feed Cap (Tab) ---

function TabFeedCap() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [capMax, setCapMax] = useState(25000);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/optimization/feed-cap').then(d => {
      setData(d);
      setCapMax(d.capMax || 25000);
      setEnabled(d.enabled || false);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    await authFetch('/api/optimization/feed-cap', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, capMax }),
    });
    setSaving(false);
  };

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
              className="w-4 h-4 text-brand-600 rounded" />
            <span className="text-sm font-medium">Feed Cap attivo</span>
          </label>
        </div>
        <button onClick={save} disabled={saving}
          className="px-4 py-1.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
          {saving ? 'Salvando...' : 'Salva'}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Prodotti nel Feed" value={data?.currentFeedCount?.toLocaleString() || 0} />
        <KpiCard label="Cap Massimo" value={capMax.toLocaleString()} accent={enabled ? 'text-brand-600' : 'text-gray-400'} />
        <KpiCard label="Differenza" value={data?.currentFeedCount > capMax ? `-${(data.currentFeedCount - capMax).toLocaleString()}` : 'Sotto cap'}
          accent={data?.currentFeedCount > capMax ? 'text-red-600' : 'text-green-600'} />
      </div>
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <label className="text-sm font-medium text-gray-700">Numero massimo prodotti nel feed</label>
        <div className="flex items-center gap-4 mt-2">
          <input type="range" min="5000" max="50000" step="100" value={capMax} onChange={e => setCapMax(parseInt(e.target.value))}
            className="flex-1" />
          <input type="number" value={capMax} onChange={e => setCapMax(parseInt(e.target.value) || 25000)}
            className="w-24 px-3 py-2 border rounded-lg text-sm text-center" />
        </div>
        <p className="text-xs text-gray-400 mt-2">I prodotti sono ordinati per priorita (ordini, revenue, health score). Quelli sotto il cap vengono esclusi dal feed.</p>
      </div>
    </div>
  );
}

// --- MODULE: Competitor Gaps (Tab) ---

function TabCompetitorGaps() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const { handleSort, sortIcon, sortRows, thClass } = useSortable('merchants_lost');

  useEffect(() => {
    api('/optimization/competitor-gaps').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;

  const gaps = data?.gaps || [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Prodotti con Gap" value={gaps.length} />
        <KpiCard label="Competitor Persi" value={gaps.reduce((s, g) => s + parseInt(g.merchants_lost || 0), 0)} accent="text-green-600" />
        <KpiCard label="Ultimo Snapshot" value={data?.snapshotDate || 'In accumulo...'} />
      </div>
      {gaps.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400">
          Nessun gap rilevato. Servono almeno 7 giorni di snapshot per rilevare variazioni.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
            <span className="text-sm font-medium text-gray-700">Opportunita: competitor in uscita</span>
            <ExportButton type="competitor-gaps" label="Excel" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-green-50 text-gray-500 uppercase text-xs">
                <tr>
                  <th className="px-4 py-3 text-left">Prodotto</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('merchants_now')}>Merchant Ora{sortIcon('merchants_now')}</th>
                  <th className="px-3 py-3 text-right">7gg Fa</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('merchants_lost')}>Persi{sortIcon('merchants_lost')}</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('best_price')}>Best Price{sortIcon('best_price')}</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('our_position')}>Nostra Pos.{sortIcon('our_position')}</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('clicks')}>Click{sortIcon('clicks')}</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('orders')}>Ordini{sortIcon('orders')}</th>
                  <th className="px-3 py-3 text-center">Feed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortRows(gaps).map(g => (
                  <tr key={g.sku} className="hover:bg-green-50/30">
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-900 truncate max-w-[200px]">{g.product_name}</div>
                      <div className="text-xs text-gray-400">{g.sku}</div>
                    </td>
                    <td className="px-3 py-2 text-right">{g.merchants_now}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{g.merchants_7d_ago}</td>
                    <td className="px-3 py-2 text-right font-medium text-green-600">-{g.merchants_lost}</td>
                    <td className="px-3 py-2 text-right">{g.best_price ? formatEur(parseFloat(g.best_price)) : '-'}</td>
                    <td className="px-3 py-2 text-right">{g.our_position || '-'}</td>
                    <td className="px-3 py-2 text-right">{parseInt(g.clicks) || 0}</td>
                    <td className="px-3 py-2 text-right">{parseInt(g.orders) || 0}</td>
                    <td className="px-3 py-2 text-center text-xs">{g.feed_action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// --- MODULE: Position Analysis (Tab) ---

function TabPositionAnalysis() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const { handleSort, sortIcon, sortRows, thClass } = useSortable('potential_savings');

  useEffect(() => {
    api('/optimization/position-analysis').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;

  const products = data?.products || [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Prodotti Analizzati" value={products.length} />
        <KpiCard label="Risparmio Potenziale" value={formatEur(products.reduce((s, p) => s + (parseFloat(p.potential_savings) || 0), 0))} accent="text-green-600" />
        <KpiCard label="Ultima Analisi" value={data?.analysisDate || 'In accumulo...'} />
      </div>
      {products.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400">
          Nessuna analisi disponibile. Servono almeno 7 giorni di dati posizione per l'analisi.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
            <span className="text-sm font-medium text-gray-700">Posizione Ottimale per ROI</span>
            <ExportButton type="position-analysis" label="Excel" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-blue-50 text-gray-500 uppercase text-xs">
                <tr>
                  <th className="px-4 py-3 text-left">Prodotto</th>
                  <th className={`px-3 py-3 text-center ${thClass}`} onClick={() => handleSort('current_position')}>Pos. Attuale{sortIcon('current_position')}</th>
                  <th className={`px-3 py-3 text-center ${thClass}`} onClick={() => handleSort('optimal_position')}>Pos. Ottimale{sortIcon('optimal_position')}</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('current_price')}>Prezzo Attuale{sortIcon('current_price')}</th>
                  <th className="px-3 py-3 text-right">Prezzo Target</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('potential_savings')}>Risparmio{sortIcon('potential_savings')}</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('total_orders')}>Ordini{sortIcon('total_orders')}</th>
                  <th className={`px-3 py-3 text-right ${thClass}`} onClick={() => handleSort('total_revenue')}>Revenue{sortIcon('total_revenue')}</th>
                  <th className="px-3 py-3 text-left">Motivo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortRows(products).map(p => (
                  <tr key={p.sku} className="hover:bg-blue-50/30">
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-900 truncate max-w-[200px]">{p.product_name}</div>
                      <div className="text-xs text-gray-400">{p.sku}</div>
                    </td>
                    <td className="px-3 py-2 text-center font-medium">{p.current_position || '-'}</td>
                    <td className="px-3 py-2 text-center font-bold text-brand-600">{p.optimal_position}</td>
                    <td className="px-3 py-2 text-right">{p.current_price ? formatEur(parseFloat(p.current_price)) : '-'}</td>
                    <td className="px-3 py-2 text-right text-green-600">{p.recommended_price ? formatEur(parseFloat(p.recommended_price)) : '-'}</td>
                    <td className="px-3 py-2 text-right text-green-600 font-medium">{p.potential_savings ? formatEur(parseFloat(p.potential_savings)) : '-'}</td>
                    <td className="px-3 py-2 text-right">{parseInt(p.total_orders) || 0}</td>
                    <td className="px-3 py-2 text-right">{p.total_revenue ? formatEur(parseFloat(p.total_revenue)) : '-'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 max-w-[200px] truncate">{p.optimal_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// --- TAB PRICE RULES ---

function TabPriceRules() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [sortBy, setSortBy] = useState('clicks_30d');
  const [sortDir, setSortDir] = useState('desc');
  const [filterType, setFilterType] = useState('');
  const [filterMinClicks, setFilterMinClicks] = useState('');
  const [filterMaxIncidence, setFilterMaxIncidence] = useState('');
  const [filterHasBurners, setFilterHasBurners] = useState(false);
  const [filterSearch, setFilterSearch] = useState('');

  useEffect(() => {
    api('/optimization/price-rules').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data) return null;

  const topByRule = data.topByRule || {};
  const totals = data.totals || {};

  const ruleTypeColors = {
    diretto: 'bg-blue-100 text-blue-800',
    muro: 'bg-gray-100 text-gray-800',
    salva_bilancio: 'bg-yellow-100 text-yellow-800',
    sconto: 'bg-green-100 text-green-800',
    ricarico: 'bg-teal-100 text-teal-800',
  };

  // Sort
  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };
  const sortIcon = (col) => sortBy === col ? (sortDir === 'desc' ? ' \u25BC' : ' \u25B2') : '';

  // Filter + Sort
  let rules = [...(data.rules || [])];
  if (filterType) rules = rules.filter(r => r.rule_type === filterType);
  if (filterMinClicks) rules = rules.filter(r => parseInt(r.clicks_30d) >= parseInt(filterMinClicks));
  if (filterMaxIncidence) rules = rules.filter(r => {
    const inc = parseFloat(r.incidence_pct);
    return inc && inc <= parseFloat(filterMaxIncidence);
  });
  if (filterHasBurners) rules = rules.filter(r => parseInt(r.burners) > 0);
  if (filterSearch) rules = rules.filter(r => r.rule_name.toLowerCase().includes(filterSearch.toLowerCase()));

  const numVal = (r, col) => parseFloat(r[col]) || 0;
  rules.sort((a, b) => {
    const va = numVal(a, sortBy), vb = numVal(b, sortBy);
    return sortDir === 'desc' ? vb - va : va - vb;
  });

  // Unique types for filter
  const ruleTypes = [...new Set((data.rules || []).map(r => r.rule_type))];

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard label="Regole Attive" value={(data.rules || []).length} />
        <KpiCard label="Click Totali" value={totals.totalClicks?.toLocaleString()} />
        <KpiCard label="Costo Click" value={formatEur(totals.totalCost)} accent="text-red-600" />
        <KpiCard label="Revenue TP" value={formatEur(totals.totalRevenue)} accent="text-green-600" />
        <KpiCard label="Incidenza" value={totals.incidence ? totals.incidence + '%' : '-'}
          accent={totals.incidence > 10 ? 'text-red-600' : totals.incidence > 5 ? 'text-yellow-600' : 'text-green-600'} />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-3">
        <div className="flex flex-wrap gap-3 items-center">
          <input type="text" placeholder="Cerca regola..." value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm w-48" />
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm">
            <option value="">Tutti i tipi</option>
            {ruleTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">Min click:</span>
            <input type="number" min="0" value={filterMinClicks} onChange={e => setFilterMinClicks(e.target.value)}
              placeholder="-" className="w-16 px-2 py-1.5 border border-gray-300 rounded-lg text-sm text-center" />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">Max incid.:</span>
            <input type="number" min="0" max="100" value={filterMaxIncidence} onChange={e => setFilterMaxIncidence(e.target.value)}
              placeholder="-" className="w-16 px-2 py-1.5 border border-gray-300 rounded-lg text-sm text-center" />
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={filterHasBurners} onChange={e => setFilterHasBurners(e.target.checked)}
              className="w-3.5 h-3.5 text-red-600 rounded" />
            <span className="text-xs text-gray-600">Solo con burner</span>
          </label>
          {(filterType || filterMinClicks || filterMaxIncidence || filterHasBurners || filterSearch) && (
            <button onClick={() => { setFilterType(''); setFilterMinClicks(''); setFilterMaxIncidence(''); setFilterHasBurners(false); setFilterSearch(''); }}
              className="text-xs text-gray-400 hover:text-gray-600 underline">Reset filtri</button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-gray-400">{rules.length} regole</span>
            <ExportButton type="price-rules" label="Excel" />
          </div>
        </div>
      </div>

      {/* Rules Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs select-none">
              <tr>
                <th className="px-4 py-3 text-left">Regola</th>
                <th className="px-3 py-3 text-center">Tipo</th>
                <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700" onClick={() => handleSort('products')}>Prodotti{sortIcon('products')}</th>
                <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700" onClick={() => handleSort('with_clicks')}>Con Click{sortIcon('with_clicks')}</th>
                <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700" onClick={() => handleSort('clicks_30d')}>Click{sortIcon('clicks_30d')}</th>
                <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700" onClick={() => handleSort('click_cost_30d')}>Costo{sortIcon('click_cost_30d')}</th>
                <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700" onClick={() => handleSort('orders_30d')}>Ordini{sortIcon('orders_30d')}</th>
                <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700" onClick={() => handleSort('revenue_30d')}>Revenue{sortIcon('revenue_30d')}</th>
                <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700" onClick={() => handleSort('incidence_pct')}>Incidenza{sortIcon('incidence_pct')}</th>
                <th className="px-3 py-3 text-right cursor-pointer hover:text-gray-700" onClick={() => handleSort('avg_margin_pct')}>Margine{sortIcon('avg_margin_pct')}</th>
                <th className="px-3 py-3 text-center cursor-pointer hover:text-gray-700" onClick={() => handleSort('stars')}>Star{sortIcon('stars')}</th>
                <th className="px-3 py-3 text-center cursor-pointer hover:text-gray-700" onClick={() => handleSort('burners')}>Burner{sortIcon('burners')}</th>
                <th className="px-3 py-3 text-center cursor-pointer hover:text-gray-700" onClick={() => handleSort('removed')}>Rimossi{sortIcon('removed')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rules.map(rule => {
                const incidence = parseFloat(rule.incidence_pct);
                const tops = topByRule[rule.rule_id] || [];
                const isExpanded = expanded === rule.rule_id;
                return (
                  <React.Fragment key={rule.rule_id}>
                    <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setExpanded(isExpanded ? null : rule.rule_id)}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                          <span className="font-medium text-gray-900">{rule.rule_name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${ruleTypeColors[rule.rule_type] || 'bg-gray-100'}`}>
                          {rule.rule_type}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-gray-600">{parseInt(rule.products).toLocaleString()}</td>
                      <td className="px-3 py-3 text-right text-gray-600">{parseInt(rule.with_clicks)}</td>
                      <td className="px-3 py-3 text-right font-medium">{parseInt(rule.clicks_30d).toLocaleString()}</td>
                      <td className="px-3 py-3 text-right text-red-600">{formatEur(parseFloat(rule.click_cost_30d))}</td>
                      <td className="px-3 py-3 text-right text-gray-700">{parseInt(rule.orders_30d)}</td>
                      <td className="px-3 py-3 text-right text-green-600 font-medium">{formatEur(parseFloat(rule.revenue_30d))}</td>
                      <td className="px-3 py-3 text-right">
                        <span className={`font-medium ${incidence > 15 ? 'text-red-600' : incidence > 8 ? 'text-yellow-600' : 'text-green-600'}`}>
                          {incidence ? incidence + '%' : '-'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-gray-500">{rule.avg_margin_pct}%</td>
                      <td className="px-3 py-3 text-center"><span className="text-yellow-600 font-medium">{parseInt(rule.stars)}</span></td>
                      <td className="px-3 py-3 text-center"><span className="text-red-600 font-medium">{parseInt(rule.burners)}</span></td>
                      <td className="px-3 py-3 text-center"><span className="text-gray-500">{parseInt(rule.removed)}</span></td>
                    </tr>
                    {isExpanded && tops.length > 0 && (
                      <tr>
                        <td colSpan={13} className="px-0 py-0">
                          <div className="bg-gray-50 border-t border-b border-gray-200 px-8 py-3">
                            <div className="text-xs font-medium text-gray-500 mb-2">Top 5 prodotti per click</div>
                            <table className="w-full text-xs">
                              <thead className="text-gray-400 uppercase">
                                <tr>
                                  <th className="py-1 text-left">Prodotto</th>
                                  <th className="py-1 text-right">Click</th>
                                  <th className="py-1 text-right">Ordini</th>
                                  <th className="py-1 text-right">Revenue</th>
                                  <th className="py-1 text-right">Prezzo</th>
                                  <th className="py-1 text-right">Pos.</th>
                                  <th className="py-1 text-center">Classe</th>
                                  <th className="py-1 text-center">Feed</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-200">
                                {tops.map(p => (
                                  <tr key={p.sku}>
                                    <td className="py-1.5 text-gray-800">
                                      <span className="truncate block max-w-[250px]">{p.product_name}</span>
                                      <span className="text-gray-400">{p.sku}</span>
                                    </td>
                                    <td className="py-1.5 text-right font-medium">{parseInt(p.clicks)}</td>
                                    <td className="py-1.5 text-right">{parseInt(p.orders) || '-'}</td>
                                    <td className="py-1.5 text-right text-green-600">{parseFloat(p.revenue) > 0 ? formatEur(p.revenue) : '-'}</td>
                                    <td className="py-1.5 text-right">{formatEur(parseFloat(p.sell_price))}</td>
                                    <td className="py-1.5 text-right">{p.scraper_position || '-'}</td>
                                    <td className="py-1.5 text-center">
                                      {p.classification && <span className={`px-1.5 py-0.5 rounded text-xs ${classLabels[p.classification]?.color || 'bg-gray-100'}`}>
                                        {classLabels[p.classification]?.label || p.classification}
                                      </span>}
                                    </td>
                                    <td className="py-1.5 text-center">
                                      <span className={`text-xs ${p.feed_action === 'REMOVE' ? 'text-red-500' : p.feed_action === 'PRICE_CUT' ? 'text-yellow-600' : 'text-green-500'}`}>
                                        {p.feed_action || 'IN FEED'}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {rules.length === 0 && (
                <tr><td colSpan={13} className="px-4 py-8 text-center text-gray-400">Nessuna regola trovata con i filtri selezionati</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// --- TAB OPT LOG ---

function TabOptLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/optimization/log').then(d => setLogs(d.logs || [])).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;

  const typeColors = {
    push_converter: 'bg-green-100 text-green-800',
    gold_price_cut: 'bg-yellow-100 text-yellow-800',
    gold_conservative: 'bg-yellow-100 text-yellow-800',
    category_rule: 'bg-blue-100 text-blue-800',
    quarantine_reset: 'bg-gray-100 text-gray-800',
    reactivation_demand: 'bg-teal-100 text-teal-800',
    invisible_activation: 'bg-green-100 text-green-800',
    feed_engine: 'bg-gray-100 text-gray-800',
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-medium text-gray-700">Storico Modifiche Feed</span>
          <span className="text-xs text-gray-400 ml-2">Ogni modifica con snapshot KPI del momento</span>
        </div>
        {logs.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-400">Nessuna modifica registrata</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
                <tr>
                  <th className="px-4 py-3 text-left">Data</th>
                  <th className="px-3 py-3 text-center">Tipo</th>
                  <th className="px-3 py-3 text-left">Descrizione</th>
                  <th className="px-3 py-3 text-right">Prodotti</th>
                  <th className="px-3 py-3 text-right">Incidenza</th>
                  <th className="px-3 py-3 text-right">Fatturato</th>
                  <th className="px-3 py-3 text-right">Costo Click</th>
                  <th className="px-3 py-3 text-right">Costo/gg</th>
                  <th className="px-3 py-3 text-right">Nel Feed</th>
                  <th className="px-3 py-3 text-right">Price Cuts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log, i) => {
                  const prevLog = logs[i + 1];
                  const incDelta = prevLog && log.snapshot_incidence && prevLog.snapshot_incidence
                    ? (parseFloat(log.snapshot_incidence) - parseFloat(prevLog.snapshot_incidence)).toFixed(1) : null;
                  const revDelta = prevLog && log.snapshot_revenue && prevLog.snapshot_revenue
                    ? Math.round(parseFloat(log.snapshot_revenue) - parseFloat(prevLog.snapshot_revenue)) : null;
                  return (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                        {new Date(log.action_date).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${typeColors[log.action_type] || 'bg-gray-100 text-gray-600'}`}>
                          {log.action_type}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-700 max-w-[300px]">{log.description}</td>
                      <td className="px-3 py-3 text-right text-xs">{log.products_affected}</td>
                      <td className="px-3 py-3 text-right">
                        <span className={`text-xs font-medium ${parseFloat(log.snapshot_incidence) > 10 ? 'text-red-600' : parseFloat(log.snapshot_incidence) > 5 ? 'text-yellow-600' : 'text-green-600'}`}>
                          {log.snapshot_incidence ? log.snapshot_incidence + '%' : '-'}
                        </span>
                        {incDelta !== null && (
                          <span className={`block text-[10px] ${parseFloat(incDelta) > 0 ? 'text-red-400' : 'text-green-400'}`}>
                            {parseFloat(incDelta) > 0 ? '+' : ''}{incDelta}%
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-xs text-green-600">
                        {log.snapshot_revenue ? formatEur(parseFloat(log.snapshot_revenue)) : '-'}
                        {revDelta !== null && (
                          <span className={`block text-[10px] ${revDelta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {revDelta > 0 ? '+' : ''}{revDelta}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-xs text-red-600">{log.snapshot_click_cost ? formatEur(parseFloat(log.snapshot_click_cost)) : '-'}</td>
                      <td className="px-3 py-3 text-right text-xs">{log.snapshot_avg_daily_cost ? formatEur(parseFloat(log.snapshot_avg_daily_cost)) : '-'}</td>
                      <td className="px-3 py-3 text-right text-xs">{log.snapshot_products_in_feed?.toLocaleString() || '-'}</td>
                      <td className="px-3 py-3 text-right text-xs">{log.snapshot_price_cuts || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
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
    { id: 'price-rules', label: 'Regole Prezzo' },
    { id: 'category-rules', label: 'Regole Categoria' },
    { id: 'feed-cap', label: 'Feed Cap' },
    { id: 'competitor-gaps', label: 'Gap Competitor' },
    { id: 'position-analysis', label: 'Posizione Ottimale' },
    { id: 'opt-log', label: 'Log Modifiche' },
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

      {/* Date Range KPI — sempre visibile */}
      <DateRangeKpi />

      {/* Tab Content */}
      {tab === 'overview' && <TabOverview health={health} recommendations={recommendations} weekly={weekly} />}
      {tab === 'feed-actions' && <TabFeedActions />}
      {tab === 'plan' && <TabPlan />}
      {tab === 'products' && <TabProducts />}
      {tab === 'burners' && <TabBurners />}
      {tab === 'opportunities' && <TabOpportunities />}
      {tab === 'price-rules' && <TabPriceRules />}
      {tab === 'category-rules' && <TabCategoryRules />}
      {tab === 'feed-cap' && <TabFeedCap />}
      {tab === 'competitor-gaps' && <TabCompetitorGaps />}
      {tab === 'position-analysis' && <TabPositionAnalysis />}
      {tab === 'opt-log' && <TabOptLog />}
    </div>
  );
}
