import React, { useState, useEffect } from 'react';
import { authFetch } from '../utils/tokenManager';

function api(path) {
  return authFetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' } }).then(r => r.json());
}

const fmtEur = v => v == null ? '—' : Number(v).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtNum = v => v == null ? '—' : Number(v).toLocaleString('it-IT');
const fmtPct = v => v == null ? '—' : `${Number(v).toFixed(1)}%`;

const ANOMALY_META = {
  wasted_serving:    { label: 'Servire a vuoto',     color: 'bg-amber-100 text-amber-800 border-amber-300',     desc: 'MC approved + impressioni > 0 + 0 click' },
  feed_blocked:      { label: 'Feed bloccato',       color: 'bg-red-100 text-red-800 border-red-300',           desc: 'Disapproved/pending ma con ordini reali' },
  loss_leader:       { label: 'Loss leader',         color: 'bg-red-100 text-red-800 border-red-300',           desc: 'MOL sotto floor 15% su revenue alto' },
  dead_stock_mc:     { label: 'Inerte 30g',          color: 'bg-gray-100 text-gray-700 border-gray-300',        desc: 'Approved + 0 vendite + impressioni' },
  high_ctr_low_cvr:  { label: 'CTR alto, 0 conv',    color: 'bg-cyan-100 text-cyan-800 border-cyan-300',        desc: 'CTR > 5% ma 0 conversioni MC' },
};

const SEVERITY_DOT = {
  high:   'bg-red-500',
  medium: 'bg-amber-500',
  low:    'bg-gray-400',
};

function ApprovalBadge({ s }) {
  if (!s) return <span className="text-xs text-gray-400">—</span>;
  const v = String(s).toLowerCase();
  const map = {
    approved:    'bg-emerald-100 text-emerald-800 border-emerald-300',
    pending:     'bg-amber-100 text-amber-800 border-amber-300',
    disapproved: 'bg-red-100 text-red-800 border-red-300',
  };
  return <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold uppercase border rounded ${map[v] || 'bg-gray-100 text-gray-700 border-gray-300'}`}>{s}</span>;
}

function AnomalyBadge({ code, severity }) {
  const m = ANOMALY_META[code] || { label: code, color: 'bg-gray-100 text-gray-700 border-gray-300' };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium border rounded ${m.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[severity] || 'bg-gray-400'}`}></span>
      {m.label}
    </span>
  );
}

function KpiCard({ label, value, sub, accent }) {
  return (
    <div className={`bg-white rounded-lg border p-4 ${accent || 'border-gray-200'}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function CrossChannel() {
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState('all');
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([
        api(`/cross-channel/summary?days=${days}`),
        api(`/cross-channel/products?days=${days}${filter !== 'all' ? `&anomaly=${filter}` : ''}`),
      ]);
      if (s.error) throw new Error(s.error);
      if (p.error) throw new Error(p.error);
      setSummary(s);
      setRows(p.rows || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [days, filter]);

  const filteredRows = filter === 'all'
    ? rows.filter(r => r.anomalies.length > 0)
    : rows;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cross-Channel Analysis</h1>
          <p className="text-sm text-gray-500 mt-0.5">Merchant Center ↔ GA4 ↔ Vendite ↔ Trovaprezzi — finestra {days}g</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={e => setDays(+e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm">
            <option value={7}>7 giorni</option>
            <option value={14}>14 giorni</option>
            <option value={30}>30 giorni</option>
            <option value={60}>60 giorni</option>
            <option value={90}>90 giorni</option>
          </select>
          <button onClick={load} disabled={loading} className="px-3 py-1 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">
            {loading ? '…' : 'Aggiorna'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded px-3 py-2 text-sm">{error}</div>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <KpiCard label="SKU totali" value={fmtNum(summary.sku_total)} sub={`${summary.mc_approved} approved`} />
            <KpiCard label="MC disapproved" value={fmtNum(summary.mc_disapproved)} sub={`${summary.mc_pending} pending`} accent={summary.mc_disapproved > 0 ? 'border-red-300' : ''} />
            <KpiCard label="Revenue totale" value={fmtEur(summary.revenue_total)} sub={`${days}g`} />
            <KpiCard label="Revenue con anomalia" value={fmtEur(summary.revenue_with_anomaly)} sub={summary.revenue_total > 0 ? `${((summary.revenue_with_anomaly / summary.revenue_total) * 100).toFixed(1)}% del totale` : ''} accent="border-amber-300" />
            <KpiCard label="SKU con anomalia" value={fmtNum(rows.filter(r => r.anomalies.length > 0).length)} sub="da rivedere" />
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="text-sm font-semibold text-gray-700 mb-2">Anomalie per tipo</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFilter('all')}
                className={`px-2 py-1 text-xs rounded border ${filter === 'all' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-700 border-gray-300'}`}
              >
                Tutte ({Object.values(summary.anomalies_by_code || {}).reduce((a, b) => a + b, 0)})
              </button>
              {Object.entries(summary.anomalies_by_code || {}).map(([code, count]) => (
                <button
                  key={code}
                  onClick={() => setFilter(code)}
                  className={`px-2 py-1 text-xs rounded border ${filter === code ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-700 border-gray-300'}`}
                  title={ANOMALY_META[code]?.desc}
                >
                  {ANOMALY_META[code]?.label || code} ({count})
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between">
          <div className="text-sm font-semibold text-gray-700">
            {filter === 'all' ? 'SKU con anomalie' : `Filtrati: ${ANOMALY_META[filter]?.label || filter}`}
            <span className="text-gray-400 font-normal ml-2">({filteredRows.length})</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-left">Prodotto</th>
                <th className="px-3 py-2 text-center">MC</th>
                <th className="px-3 py-2 text-right">Imp.</th>
                <th className="px-3 py-2 text-right">Click MC</th>
                <th className="px-3 py-2 text-right">CTR</th>
                <th className="px-3 py-2 text-right">Conv MC</th>
                <th className="px-3 py-2 text-right">TP click</th>
                <th className="px-3 py-2 text-right">Ordini</th>
                <th className="px-3 py-2 text-right">Revenue</th>
                <th className="px-3 py-2 text-right">MOL</th>
                <th className="px-3 py-2 text-left">Anomalie</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-gray-400">Nessuna anomalia rilevata in questa finestra.</td></tr>
              )}
              {filteredRows.map(r => (
                <tr key={r.sku || r.offer_id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">{r.sku || r.offer_id}</td>
                  <td className="px-3 py-2 max-w-xs truncate" title={r.product_name}>{r.product_name || <span className="text-gray-400">—</span>}</td>
                  <td className="px-3 py-2 text-center"><ApprovalBadge s={r.approval_status} /></td>
                  <td className="px-3 py-2 text-right">{fmtNum(r.mc_impressions)}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(r.mc_clicks)}</td>
                  <td className="px-3 py-2 text-right">{fmtPct(r.mc_ctr_pct)}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(r.mc_conversions)}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(r.tp_clicks)}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(r.orders_count)}</td>
                  <td className="px-3 py-2 text-right font-medium">{fmtEur(r.revenue)}</td>
                  <td className={`px-3 py-2 text-right ${r.mol_pct != null && r.mol_pct < 15 ? 'text-red-700 font-bold' : ''}`}>{fmtPct(r.mol_pct)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {r.anomalies.map((a, i) => <AnomalyBadge key={i} code={a.code} severity={a.severity} />)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
