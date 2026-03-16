import React, { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../utils/tokenManager';
import { useAuth } from '../contexts/AuthContext';

function api(path) {
  return authFetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
  }).then(r => r.json());
}

function apiPost(path, body) {
  return authFetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json());
}

function formatEur(value) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(value);
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

// --- TAB: Setup ---
function TabSetup({ status, onRefresh }) {
  const { user } = useAuth();
  const [propertyId, setPropertyId] = useState('');
  const [saJson, setSaJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const isAdmin = user?.role === 'superadmin' || user?.role === 'admin';

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = {};
      if (propertyId.trim()) body.ga4PropertyId = propertyId.trim();
      if (saJson.trim()) body.serviceAccountJson = saJson.trim();
      await apiPost('/ga4/credentials', body);
      setPropertyId('');
      setSaJson('');
      onRefresh();
    } catch (err) {
      console.error(err);
    }
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api('/ga4/test-connection');
      setTestResult(result);
    } catch (err) {
      setTestResult({ error: err.message });
    }
    setTesting(false);
  };

  return (
    <div className="space-y-6">
      {/* Status */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Stato Configurazione</h3>
        <div className="flex items-center gap-3">
          <span className={`inline-block w-3 h-3 rounded-full ${status?.configured ? 'bg-green-500' : 'bg-red-400'}`} />
          <span className="text-sm text-gray-700">
            {status?.configured ? 'GA4 configurato' : 'GA4 non configurato'}
          </span>
          {status?.lastUpdate && (
            <span className="text-xs text-gray-400 ml-auto">
              Ultimo aggiornamento: {new Date(status.lastUpdate).toLocaleString('it-IT')}
            </span>
          )}
        </div>

        {status?.configured && status?.trovaprezzi && (
          <div className="mt-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="text-center">
              <div className="text-lg font-bold text-gray-900">{formatEur(status.trovaprezzi.revenue)}</div>
              <div className="text-xs text-gray-500">Revenue TP (GA4)</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-gray-900">{status.trovaprezzi.transactions}</div>
              <div className="text-xs text-gray-500">Transazioni TP</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-gray-900">{status.trovaprezzi.sessions}</div>
              <div className="text-xs text-gray-500">Sessioni TP</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-gray-900">{formatEur(status.trovaprezzi.avgBasket)}</div>
              <div className="text-xs text-gray-500">Carrello medio</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-gray-900">{status.trovaprezzi.convRate}%</div>
              <div className="text-xs text-gray-500">Tasso conversione</div>
            </div>
          </div>
        )}
      </div>

      {/* Last Run Info */}
      {status?.lastRun && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Ultimo Import</h3>
          <div className="text-sm text-gray-600 space-y-1">
            <p>Stato: <span className={status.lastRun.status === 'completed' ? 'text-green-600 font-medium' : 'text-amber-600'}>{status.lastRun.status}</span></p>
            {status.lastRun.completed_at && <p>Completato: {new Date(status.lastRun.completed_at).toLocaleString('it-IT')}</p>}
            {status.lastRun.products_attributed > 0 && <p>Prodotti attribuiti: {status.lastRun.products_attributed}</p>}
            {status.lastRun.error && <p className="text-red-600">Errore: {status.lastRun.error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// --- TAB: Canali (shows source/medium like GA4 Acquisition) ---
function TabChannels() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/ga4/sources').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data?.configured) return <div className="text-center text-gray-400 py-8">GA4 non configurato. Configura le credenziali in Configurazione.</div>;

  const sources = data.sources || [];
  const totalRevenue = sources.reduce((s, v) => s + v.revenue, 0);
  const totalSessions = sources.reduce((s, v) => s + v.sessions, 0);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
              <tr>
                <th className="px-4 py-3 text-left">Sorgente / Mezzo</th>
                <th className="px-3 py-3 text-right">Sessioni</th>
                <th className="px-3 py-3 text-right">% Sessioni</th>
                <th className="px-3 py-3 text-right">Transazioni</th>
                <th className="px-3 py-3 text-right">Revenue</th>
                <th className="px-3 py-3 text-right">% Revenue</th>
                <th className="px-3 py-3 text-right">Conv. Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sources.map((s, i) => {
                const isTP = s.source.toLowerCase().includes('trovaprezzi');
                const convRate = s.sessions > 0 ? ((s.transactions / s.sessions) * 100).toFixed(2) : '0';
                return (
                  <tr key={i} className={`hover:bg-gray-50 ${isTP ? 'bg-yellow-50 font-medium' : ''}`}>
                    <td className="px-4 py-3 text-gray-900">
                      {s.source} / {s.medium}
                      {isTP && <span className="ml-2 text-xs text-yellow-600">TP</span>}
                    </td>
                    <td className="px-3 py-3 text-right text-gray-700">{s.sessions.toLocaleString('it-IT')}</td>
                    <td className="px-3 py-3 text-right text-gray-500">
                      {totalSessions > 0 ? ((s.sessions / totalSessions) * 100).toFixed(1) + '%' : '-'}
                    </td>
                    <td className="px-3 py-3 text-right text-gray-700">{s.transactions}</td>
                    <td className="px-3 py-3 text-right text-gray-700">{formatEur(s.revenue)}</td>
                    <td className="px-3 py-3 text-right text-gray-500">
                      {totalRevenue > 0 ? ((s.revenue / totalRevenue) * 100).toFixed(1) + '%' : '-'}
                    </td>
                    <td className="px-3 py-3 text-right text-gray-700">{convRate}%</td>
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

// --- TAB: Sorgenti ---
function TabSources() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/ga4/sources').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;
  if (!data?.configured) return <div className="text-center text-gray-400 py-8">GA4 non configurato.</div>;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
            <tr>
              <th className="px-4 py-3 text-left">Sorgente</th>
              <th className="px-3 py-3 text-left">Mezzo</th>
              <th className="px-3 py-3 text-right">Sessioni</th>
              <th className="px-3 py-3 text-right">Transazioni</th>
              <th className="px-3 py-3 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(data.sources || []).map((s, i) => {
              const isTP = s.source.toLowerCase().includes('trovaprezzi');
              return (
                <tr key={i} className={`hover:bg-gray-50 ${isTP ? 'bg-yellow-50 font-medium' : ''}`}>
                  <td className="px-4 py-3 text-gray-900">{s.source}</td>
                  <td className="px-3 py-3 text-gray-600">{s.medium}</td>
                  <td className="px-3 py-3 text-right text-gray-700">{s.sessions.toLocaleString('it-IT')}</td>
                  <td className="px-3 py-3 text-right text-gray-700">{s.transactions}</td>
                  <td className="px-3 py-3 text-right text-gray-700">{formatEur(s.revenue)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- TAB: Attribuzione ---
function TabAttribution() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/ga4/attribution').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500" /></div>;

  const products = data?.products || [];
  const s = data?.summary || {};
  const period = data?.period || {};
  if (products.length === 0) return <div className="text-center text-gray-400 py-8">Nessun dato di attribuzione disponibile. Esegui un import GA4.</div>;

  const totalTpRevenue = s.totalTpRevenue || 0;
  const totalAssistedRevenue = s.totalAssistedRevenue || 0;
  const totalClickCost = s.totalClickCost || 0;
  const totalTpValue = s.totalTpValue || 0;
  const roas = totalClickCost > 0 ? totalTpValue / totalClickCost : 0;

  return (
    <div className="space-y-4">
      {/* Period info */}
      <div className="text-xs text-gray-400 text-right">
        Click: {period.clicks} | Attribuzione GA4: {period.ga4Attribution}
        {period.lastUpdate && <> | Aggiornato: {new Date(period.lastUpdate).toLocaleString('it-IT')}</>}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="Revenue Diretta TP" value={formatEur(totalTpRevenue)} sub={`${s.totalTpPurchases || 0} vendite (30gg)`} accent="text-green-600" />
        <KpiCard label="Revenue Assistita" value={formatEur(totalAssistedRevenue)} sub={`${s.totalAssistedSales || 0} vendite indirette (30gg)`} accent="text-blue-600" />
        <KpiCard label="Valore Totale TP" value={formatEur(totalTpValue)} sub="diretta + assistita (30gg)" />
        <KpiCard label="Costo Click TP" value={formatEur(totalClickCost)} sub={`${s.totalClicks || 0} click (30gg)`} accent="text-red-600" />
        <KpiCard label="ROAS TP" value={roas.toFixed(2) + 'x'} sub="valore / costo" accent={roas >= 3 ? 'text-green-600' : roas >= 1 ? 'text-amber-600' : 'text-red-600'} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
              <tr>
                <th className="px-4 py-3 text-left">Prodotto</th>
                <th className="px-3 py-3 text-right">Click TP</th>
                <th className="px-3 py-3 text-right">Costo Click</th>
                <th className="px-3 py-3 text-right">Vendite Dirette</th>
                <th className="px-3 py-3 text-right">Rev. Diretta</th>
                <th className="px-3 py-3 text-right">Vendite Assist.</th>
                <th className="px-3 py-3 text-right">Rev. Assistita</th>
                <th className="px-3 py-3 text-right">Valore Totale</th>
                <th className="px-3 py-3 text-center">Civetta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.slice(0, 100).map(p => {
                const totalVal = (parseFloat(p.ga4_tp_revenue) || 0) + (parseFloat(p.ga4_assisted_revenue) || 0);
                return (
                  <tr key={p.sku} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 truncate max-w-[200px]">{p.product_name || p.sku}</div>
                      <div className="text-xs text-gray-400">{p.sku}</div>
                    </td>
                    <td className="px-3 py-3 text-right text-gray-700">{parseInt(p.tp_clicks_30d) || 0}</td>
                    <td className="px-3 py-3 text-right text-gray-700">{formatEur(parseFloat(p.tp_click_cost_30d) || 0)}</td>
                    <td className="px-3 py-3 text-right text-gray-700">{parseInt(p.ga4_tp_purchases) || 0}</td>
                    <td className="px-3 py-3 text-right text-green-600 font-medium">
                      {parseFloat(p.ga4_tp_revenue) > 0 ? formatEur(p.ga4_tp_revenue) : '-'}
                    </td>
                    <td className="px-3 py-3 text-right text-gray-700">{parseInt(p.ga4_assisted_sales) || 0}</td>
                    <td className="px-3 py-3 text-right text-blue-600">
                      {parseFloat(p.ga4_assisted_revenue) > 0 ? formatEur(p.ga4_assisted_revenue) : '-'}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold text-gray-900">
                      {totalVal > 0 ? formatEur(totalVal) : '-'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-block w-3 h-3 rounded-full ${p.is_civetta ? 'bg-green-500' : 'bg-gray-300'}`} />
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

// --- MAIN PAGE ---
export default function GA4Analytics() {
  const { user } = useAuth();
  const [tab, setTab] = useState('setup');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api('/ga4/status');
      setStatus(s);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleImport = async () => {
    setImporting(true);
    try {
      await apiPost('/ga4/import');
      setTimeout(() => { loadStatus(); setImporting(false); }, 20000);
    } catch { setImporting(false); }
  };

  const tabs = [
    { id: 'setup', label: 'Panoramica' },
    { id: 'channels', label: 'Sorgenti / Mezzi' },
    { id: 'attribution', label: 'Attribuzione TP' },
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Google Analytics 4</h1>
          <p className="text-sm text-gray-500 mt-1">
            Attribuzione sorgente, canali e revenue per sessione
          </p>
        </div>
        {(user?.role === 'superadmin' || user?.role === 'admin') && status?.configured && (
          <button
            onClick={handleImport}
            disabled={importing}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 text-sm font-medium"
          >
            {importing ? 'Import in corso...' : 'Importa Dati GA4'}
          </button>
        )}
      </div>

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

      {tab === 'setup' && <TabSetup status={status} onRefresh={loadStatus} />}
      {tab === 'channels' && <TabChannels />}
      {tab === 'attribution' && <TabAttribution />}
    </div>
  );
}
