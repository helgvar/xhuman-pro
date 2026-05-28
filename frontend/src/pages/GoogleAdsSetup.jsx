import React, { useState, useEffect } from 'react';
import { authFetch } from '../utils/tokenManager';

function api(path, opts = {}) {
  return authFetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(r => r.json());
}

const fmt = v => v == null ? '—' : v;

function StatusBadge({ ok, code }) {
  if (ok) return <span className="inline-flex px-2 py-0.5 text-xs font-bold border rounded bg-emerald-100 text-emerald-800 border-emerald-300">CONNECTION OK</span>;
  const colorMap = {
    DEVELOPER_TOKEN_NOT_APPROVED: 'bg-amber-100 text-amber-800 border-amber-300',
    CONFIG_INCOMPLETE: 'bg-gray-100 text-gray-700 border-gray-300',
    PERMISSION_DENIED: 'bg-red-100 text-red-800 border-red-300',
    UNAUTHENTICATED: 'bg-red-100 text-red-800 border-red-300',
    CUSTOMER_NOT_ENABLED: 'bg-red-100 text-red-800 border-red-300',
  };
  return <span className={`inline-flex px-2 py-0.5 text-xs font-bold border rounded ${colorMap[code] || 'bg-red-100 text-red-800 border-red-300'}`}>{code || 'ERROR'}</span>;
}

const HELP = {
  DEVELOPER_TOKEN_NOT_APPROVED: {
    title: 'Token in modalità "Test access"',
    body: 'Il developer token funziona solo su test accounts. Per leggere campagne reali serve "Basic access": clicca "Richiedi l\'accesso di base" su https://ads.google.com/aw/apicenter. Tempo tipico 1-3 giorni.',
  },
  CONFIG_INCOMPLETE: {
    title: 'Configurazione incompleta',
    body: 'Mancano alcune chiavi in global_config o tenant_configs. Vedi sezione "Configurazione richiesta" sotto.',
  },
  PERMISSION_DENIED: {
    title: 'Permessi insufficienti',
    body: 'L\'utente OAuth non ha accesso al customer_id richiesto. Verifica che sia stato invitato come Admin/Standard sull\'account Google Ads del tenant.',
  },
  UNAUTHENTICATED: {
    title: 'Refresh token scaduto/revocato',
    body: 'Rigenera il refresh_token con scripts/google-ads-oauth.js e re-inseriscilo in global_config.',
  },
  CUSTOMER_NOT_ENABLED: {
    title: 'Account non abilitato',
    body: 'Il customer_id esiste ma è sospeso o disabilitato lato Google.',
  },
};

export default function GoogleAdsSetup() {
  const [diag, setDiag] = useState(null);
  const [test, setTest] = useState(null);
  const [runs, setRuns] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);

  async function loadAll() {
    setError(null);
    try {
      const [d, r] = await Promise.all([
        api('/google-ads/diagnose'),
        api('/google-ads/runs'),
      ]);
      if (d.error) throw new Error(d.error);
      setDiag(d);
      setRuns(r || []);
    } catch (e) { setError(e.message); }
  }

  async function runTest() {
    setTest(null); setError(null);
    try {
      const r = await api('/google-ads/test');
      setTest(r);
    } catch (e) { setError(e.message); }
  }

  async function runSync() {
    setSyncing(true); setError(null);
    try {
      const r = await api('/google-ads/sync', { method: 'POST', body: JSON.stringify({ days: 30 }) });
      if (r.error) throw new Error(r.error);
      await loadAll();
      alert(`Sync OK: campagne ${r.campaigns}, daily rows ${r.campaign_days}, product rows ${r.product_rows}`);
    } catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  }

  useEffect(() => { loadAll(); }, []);

  const help = test && !test.ok ? HELP[test.code] : null;

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Google Ads Setup</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configurazione + diagnostica + sync manuale Google Ads API per questo tenant</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}

      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="font-semibold text-gray-900 mb-2">Stato configurazione</h2>
        {diag ? (
          <div className="text-sm space-y-2">
            <div>Customer ID: <span className="font-mono">{fmt(diag.customer_id)}</span></div>
            <div>Login Customer ID (MCC): <span className="font-mono">{fmt(diag.login_customer_id)}</span></div>
            <div>Ready: {diag.ready ? <span className="text-emerald-700 font-bold">SI</span> : <span className="text-red-700 font-bold">NO</span>}</div>
            {diag.missing?.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500 mt-2">Chiavi mancanti</div>
                <ul className="list-disc list-inside text-xs text-red-700 mt-1">
                  {diag.missing.map(k => <li key={k} className="font-mono">{k}</li>)}
                </ul>
              </div>
            )}
          </div>
        ) : <div className="text-sm text-gray-500">Caricamento…</div>}
      </section>

      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-gray-900">Test connessione</h2>
          <button onClick={runTest} className="px-3 py-1 text-sm bg-brand-600 text-white rounded hover:bg-brand-700">
            Esegui test
          </button>
        </div>
        {test && (
          <div className="text-sm space-y-2">
            <div><StatusBadge ok={test.ok} code={test.code} /></div>
            {test.ok && test.customer && (
              <div>
                <div>Customer trovato: <strong>{test.customer.descriptive_name}</strong></div>
                <div className="text-xs text-gray-500">ID: {test.customer.id} · valuta {test.customer.currency_code}</div>
              </div>
            )}
            {!test.ok && help && (
              <div className="bg-amber-50 border border-amber-200 p-3 rounded text-amber-800 text-xs">
                <div className="font-semibold mb-1">{help.title}</div>
                <div>{help.body}</div>
              </div>
            )}
            {!test.ok && test.message && (
              <details className="text-xs">
                <summary className="cursor-pointer text-gray-500">Messaggio errore raw</summary>
                <pre className="bg-gray-50 p-2 rounded overflow-x-auto mt-1">{test.message}</pre>
              </details>
            )}
          </div>
        )}
        {!test && <div className="text-sm text-gray-500">Non ancora eseguito.</div>}
      </section>

      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-gray-900">Sync manuale (campagne + 30g daily + product perf)</h2>
          <button onClick={runSync} disabled={syncing || !diag?.ready} className="px-3 py-1 text-sm bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50">
            {syncing ? 'Sync in corso…' : 'Esegui sync'}
          </button>
        </div>
        {!diag?.ready && <div className="text-xs text-gray-500">Disabilitato finché la configurazione non è completa.</div>}

        <h3 className="text-xs uppercase tracking-wide text-gray-500 mt-4 mb-1">Ultimi 20 run</h3>
        {runs.length === 0 ? <div className="text-sm text-gray-500">Nessun sync eseguito.</div> : (
          <div className="overflow-hidden border border-gray-200 rounded text-sm">
            <table className="w-full">
              <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
                <tr>
                  <th className="px-2 py-1">Quando</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1 text-right">Camp.</th>
                  <th className="px-2 py-1 text-right">Daily</th>
                  <th className="px-2 py-1 text-right">Prod.</th>
                  <th className="px-2 py-1 text-right">Durata</th>
                  <th className="px-2 py-1">Errore</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {runs.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-2 py-1 text-xs">{new Date(r.started_at).toLocaleString('it-IT')}</td>
                    <td className="px-2 py-1 text-xs">{r.status}</td>
                    <td className="px-2 py-1 text-xs text-right tabular-nums">{r.campaigns_count}</td>
                    <td className="px-2 py-1 text-xs text-right tabular-nums">{r.campaign_days}</td>
                    <td className="px-2 py-1 text-xs text-right tabular-nums">{r.product_rows}</td>
                    <td className="px-2 py-1 text-xs text-right tabular-nums">{r.duration_sec != null ? `${r.duration_sec}s` : '—'}</td>
                    <td className="px-2 py-1 text-xs text-red-700 truncate max-w-md">{r.error_message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h2 className="font-semibold text-blue-900 mb-2">Configurazione richiesta (one-time)</h2>
        <div className="text-sm text-blue-900 space-y-2">
          <div>
            <strong>1. global_config</strong> (chiavi globali, criptate):
            <ul className="list-disc list-inside text-xs mt-1 space-y-0.5">
              <li><code>google_ads_developer_token</code> — da <a className="underline" href="https://ads.google.com/aw/apicenter" target="_blank" rel="noreferrer">https://ads.google.com/aw/apicenter</a></li>
              <li><code>google_ads_oauth_client_id</code> — OAuth2 client su Google Cloud Console</li>
              <li><code>google_ads_oauth_client_secret</code></li>
              <li><code>google_ads_oauth_refresh_token</code> — ottenuto con <code>scripts/google-ads-oauth.js</code></li>
              <li><code>google_ads_login_customer_id</code> — CID MCC senza trattini (opzionale)</li>
            </ul>
          </div>
          <div>
            <strong>2. tenant_configs</strong> (per ciascun tenant):
            <ul className="list-disc list-inside text-xs mt-1 space-y-0.5">
              <li><code>google_ads_customer_id</code> — CID dell'account farmacia (senza trattini)</li>
            </ul>
          </div>
          <div className="text-xs">
            Quando il dev token è ancora in <em>Test access</em>, il test connessione tornerà <code>DEVELOPER_TOKEN_NOT_APPROVED</code>: significa che il setup è corretto ma serve approvazione Google del Basic access.
          </div>
        </div>
      </section>
    </div>
  );
}
