import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';

const STEPS = [
  { id: 'config', label: 'Verifica Configurazione', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
  { id: 'products', label: 'Import Prodotti', icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
  { id: 'civetta', label: 'Sync Civetta', icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15' },
  { id: 'orders', label: 'Import Ordini', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
  { id: 'zombie', label: 'Download Click TP', icon: 'M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122' },
  { id: 'scraper', label: 'Import Competitor', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
  { id: 'health', label: 'Health Scores', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  { id: 'ga4', label: 'GA4 Attribution', icon: 'M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z' },
  { id: 'feed', label: 'Feed Engine', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { id: 'stable', label: 'Cache External API', icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2' },
];

export default function Onboarding() {
  const { authFetch, effectiveTenantId: tenantId } = useAuth();
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(null);
  const [apiKey, setApiKey] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [revenueSource, setRevenueSource] = useState('magento');
  const [monthlyBudget, setMonthlyBudget] = useState('3500');
  const logRef = useRef(null);

  const loadStatus = useCallback(async () => {
    if (!tenantId) return;
    try {
      const token = sessionStorage.getItem('token');
      const resp = await fetch(`/api/onboarding/${tenantId}/status`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        setStatus(data);
      }
    } catch (e) { console.error('loadStatus error:', e); }
  }, [tenantId]);

  useEffect(() => { if (tenantId) loadStatus(); }, [tenantId, loadStatus]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const generateApiKey = async () => {
    try {
      const token = sessionStorage.getItem('token');
      const resp = await fetch(`/api/onboarding/${tenantId}/generate-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Errore generazione API key');
      setApiKey(data.apiKey);
      loadStatus();
    } catch (e) { alert('Errore: ' + e.message); }
  };

  const runOnboarding = async () => {
    setRunning(true);
    setLogs([]);
    setCurrentStep(null);

    try {
      const token = sessionStorage.getItem('token');
      const response = await fetch(`/api/onboarding/${tenantId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ config: { revenue_source: revenueSource, monthly_budget: monthlyBudget } }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.done) {
              setRunning(false);
              loadStatus();
              continue;
            }
            if (data.level === 'step') setCurrentStep(data.message);
            setLogs(prev => [...prev, data]);
          } catch { }
        }
      }
    } catch (e) {
      setLogs(prev => [...prev, { ts: new Date().toISOString(), level: 'error', message: 'Connessione persa: ' + e.message }]);
    }
    setRunning(false);
  };

  const levelColor = (level) => {
    switch (level) {
      case 'success': return 'text-green-600';
      case 'error': return 'text-red-600';
      case 'warn': return 'text-yellow-600';
      case 'step': return 'text-blue-600 font-semibold';
      default: return 'text-gray-600';
    }
  };

  const levelIcon = (level) => {
    switch (level) {
      case 'success': return '\u2705';
      case 'error': return '\u274C';
      case 'warn': return '\u26A0\uFE0F';
      case 'step': return '\u25B6\uFE0F';
      default: return '\u2139\uFE0F';
    }
  };

  const getStepStatus = (stepId) => {
    if (!status) return 'pending';
    switch (stepId) {
      case 'config': return status.config?.missing?.length === 0 ? 'done' : 'warn';
      case 'products': return status.products > 0 ? 'done' : 'pending';
      case 'civetta': return status.products > 0 ? 'done' : 'pending';
      case 'orders': return status.orders > 0 ? 'done' : 'pending';
      case 'zombie': return status.zombie?.days > 0 ? 'done' : 'pending';
      case 'scraper': return status.scraper > 0 ? 'done' : 'pending';
      case 'health': return status.health > 0 ? 'done' : 'pending';
      case 'ga4': return status.ga4Revenue ? 'done' : 'pending';
      case 'feed': return Object.keys(status.feed || {}).length > 0 ? 'done' : 'pending';
      case 'stable': return status.apiKey ? 'done' : 'pending';
      default: return 'pending';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold">Onboarding Tenant</h1>
          <p className="text-gray-500">Setup completo: import dati, ottimizzazione e connessione Farmabooster</p>
        </div>
        <div className="flex gap-3">
          <button onClick={loadStatus} className="px-4 py-2 border rounded-lg hover:bg-gray-50">
            Aggiorna Stato
          </button>
          <button
            onClick={runOnboarding}
            disabled={running}
            className={`px-6 py-2 rounded-lg text-white font-medium ${running ? 'bg-gray-400' : 'bg-teal-600 hover:bg-teal-700'}`}
          >
            {running ? 'In esecuzione...' : 'Avvia Onboarding Completo'}
          </button>
        </div>
      </div>

      {/* Config section */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border p-4">
          <h3 className="font-semibold mb-3">Configurazione Onboarding</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Revenue Source</label>
              <select value={revenueSource} onChange={e => setRevenueSource(e.target.value)}
                className="w-full border rounded px-3 py-2">
                <option value="magento">Magento (ordini totali store)</option>
                <option value="ga4">GA4 (sessioni Trovaprezzi)</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">GA4 se il tracciamento e-commerce funziona bene, Magento altrimenti</p>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Budget Mensile TP</label>
              <input type="number" value={monthlyBudget} onChange={e => setMonthlyBudget(e.target.value)}
                className="w-full border rounded px-3 py-2" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border p-4">
          <h3 className="font-semibold mb-3">API Key Farmabooster</h3>
          {status?.apiKey ? (
            <div className="text-sm">
              <p className="text-green-600 font-medium">Attiva: {status.apiKey.name}</p>
              <p className="text-gray-500 mb-2">Ultimo uso: {status.apiKey.lastUsed ? new Date(status.apiKey.lastUsed).toLocaleString('it-IT') : 'Mai'}</p>
              <div className="flex gap-2">
                <button onClick={async () => {
                  try {
                    const token = sessionStorage.getItem('token');
                    const resp = await fetch(`/api/onboarding/${tenantId}/api-key`, { headers: { 'Authorization': `Bearer ${token}` } });
                    const data = await resp.json();
                    if (data.apiKey) { setApiKey(data.apiKey); setShowKey(true); }
                    else alert('Key non recuperabile. Genera una nuova.');
                  } catch (e) { alert('Errore: ' + e.message); }
                }} className="px-3 py-1 bg-gray-100 border rounded text-xs hover:bg-gray-200">
                  {showKey ? 'Nascondi' : 'Mostra Key'}
                </button>
                {apiKey && <button onClick={() => { navigator.clipboard.writeText(apiKey); alert('Copiata!'); }} className="px-3 py-1 bg-gray-100 border rounded text-xs hover:bg-gray-200">
                  Copia
                </button>}
              </div>
            </div>
          ) : (
            <p className="text-yellow-600 text-sm">Nessuna API Key generata</p>
          )}
          <button onClick={generateApiKey} className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
            Genera Nuova API Key
          </button>
          {apiKey && showKey && (
            <div className="mt-3 p-3 bg-gray-900 rounded-lg">
              <p className="text-xs text-gray-400 mb-1">Copia questa chiave e configurala in Farmabooster:</p>
              <code className="text-green-400 text-xs break-all select-all">{apiKey}</code>
            </div>
          )}
        </div>
      </div>

      {/* Steps overview */}
      <div className="bg-white rounded-xl border p-4">
        <h3 className="font-semibold mb-3">Step Onboarding</h3>
        <div className="grid grid-cols-5 gap-2">
          {STEPS.map(step => {
            const s = getStepStatus(step.id);
            return (
              <div key={step.id} className={`p-3 rounded-lg text-center text-sm ${
                s === 'done' ? 'bg-green-50 border border-green-200' :
                s === 'warn' ? 'bg-yellow-50 border border-yellow-200' :
                'bg-gray-50 border border-gray-200'
              }`}>
                <div className="text-lg mb-1">
                  {s === 'done' ? '\u2705' : s === 'warn' ? '\u26A0\uFE0F' : '\u23F3'}
                </div>
                <div className="font-medium text-xs">{step.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Status summary */}
      {status && (
        <div className="bg-white rounded-xl border p-4">
          <h3 className="font-semibold mb-3">Stato Attuale</h3>
          <div className="grid grid-cols-4 gap-4 text-sm">
            <div><span className="text-gray-500">Prodotti:</span> <strong>{status.products?.toLocaleString()}</strong></div>
            <div><span className="text-gray-500">Ordini:</span> <strong>{status.orders?.toLocaleString()}</strong></div>
            <div><span className="text-gray-500">Health:</span> <strong>{status.health?.toLocaleString()}</strong></div>
            <div><span className="text-gray-500">Click TP:</span> <strong>{status.zombie?.clicks?.toLocaleString()} ({status.zombie?.days}gg)</strong></div>
            <div><span className="text-gray-500">Competitor:</span> <strong>{status.scraper?.toLocaleString()}</strong></div>
            <div><span className="text-gray-500">GA4 Rev:</span> <strong>{status.ga4Revenue ? '\u20AC' + parseFloat(status.ga4Revenue).toLocaleString('it-IT', {minimumFractionDigits: 2}) : '-'}</strong></div>
            <div><span className="text-gray-500">Quarantena:</span> <strong>{status.quarantine}</strong></div>
            <div><span className="text-gray-500">Incidenza:</span> <strong className={status.incidence > 5 ? 'text-red-600' : 'text-green-600'}>{status.incidence ? status.incidence.toFixed(1) + '%' : '-'}</strong></div>
            <div><span className="text-gray-500">Revenue src:</span> <strong>{status.revenueSource}</strong></div>
            <div><span className="text-gray-500">Config mancanti:</span> <strong className={status.config?.missing?.length > 0 ? 'text-red-600' : 'text-green-600'}>{status.config?.missing?.length || 0}</strong></div>
            <div><span className="text-gray-500">Feed REMOVE:</span> <strong>{status.feed?.REMOVE || 0}</strong></div>
            <div><span className="text-gray-500">Feed KEEP:</span> <strong>{status.feed?.KEEP || 0}</strong></div>
          </div>
          {status.config?.missing?.length > 0 && (
            <div className="mt-3 p-2 bg-yellow-50 rounded text-xs text-yellow-800">
              Config mancanti: {status.config.missing.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Log console */}
      {logs.length > 0 && (
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-white font-semibold">Log Onboarding</h3>
            {running && <span className="text-teal-400 text-sm animate-pulse">{currentStep}</span>}
          </div>
          <div ref={logRef} className="h-96 overflow-y-auto font-mono text-xs space-y-1">
            {logs.map((log, i) => (
              <div key={i} className={levelColor(log.level)}>
                <span className="text-gray-500">{log.ts?.slice(11, 19)}</span>
                {' '}{levelIcon(log.level)} {log.message}
                {log.data && <span className="text-gray-500 ml-2">{typeof log.data === 'object' ? JSON.stringify(log.data) : log.data}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
