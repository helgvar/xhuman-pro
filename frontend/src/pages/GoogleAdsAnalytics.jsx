import { useEffect, useState } from 'react';
import { authFetch } from '../utils/tokenManager';

function api(path, opts = {}) {
  return authFetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json());
}

const eur = v => v == null ? '—' : '€' + Number(v).toLocaleString('it', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = v => v == null ? '—' : Number(v).toLocaleString('it');

const VERDETTO = {
  brucia:     { label: 'BRUCIA',      cls: 'bg-red-100 text-red-800 border-red-300' },
  perdita:    { label: 'PERDITA',     cls: 'bg-orange-100 text-orange-800 border-orange-300' },
  attenzione: { label: 'ATTENZIONE',  cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  ok:         { label: 'OK',          cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  'no-costo': { label: 'NO COSTO',    cls: 'bg-gray-100 text-gray-600 border-gray-300' },
};

function Badge({ v }) {
  const cfg = VERDETTO[v] || VERDETTO['no-costo'];
  return <span className={`inline-flex px-2 py-0.5 text-xs font-bold border rounded ${cfg.cls}`}>{cfg.label}</span>;
}

export default function GoogleAdsAnalytics() {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState(null);
  const [products, setProducts] = useState([]);
  const [sort, setSort] = useState('spend');
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function reload() {
    setLoading(true); setError(null);
    try {
      const [ov, pr] = await Promise.all([
        api(`/google-ads/overview?days=${days}`),
        api(`/google-ads/products?days=${days}&sort=${sort}&limit=400`),
      ]);
      if (ov.error) throw new Error(ov.error);
      setOverview(ov);
      setProducts(pr.products || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { reload(); }, [days, sort]);

  const k = overview?.kpi || {};
  const spend = Number(k.spend || 0);
  const revenue = Number(k.revenue || 0);
  const roas = spend > 0 ? (revenue / spend) : null;
  const cpc = Number(k.clicks) > 0 ? spend / Number(k.clicks) : null;
  const cpa = Number(k.conversions) > 0 ? spend / Number(k.conversions) : null;

  const filtered = products.filter(p => {
    if (filter === 'burner') return p.verdetto === 'brucia' || p.verdetto === 'perdita';
    if (filter === 'spesa0conv') return Number(p.spend) > 0 && Number(p.conversions) === 0;
    if (filter === 'winner') return p.verdetto === 'ok' && Number(p.conversions) > 0;
    return true;
  });

  const sprecato = products
    .filter(p => Number(p.spend) > 0 && Number(p.conversions) === 0)
    .reduce((s, p) => s + Number(p.spend), 0);
  const perdita = products
    .filter(p => p.verdetto === 'brucia' || p.verdetto === 'perdita')
    .reduce((s, p) => s + Number(p.spend), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">📈 Google Ads — Analisi (read-only)</h1>
      <p className="text-gray-600 mb-4">
        Solo lettura, nessuna scrittura sulle campagne. Il ROAS di Google è sul <b>fatturato</b>;
        qui aggiungiamo il <b>margine vero</b> (costo sorgente) per capire cosa rende davvero.
      </p>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={days} onChange={e => setDays(+e.target.value)} className="border rounded px-3 py-2">
          <option value={7}>Ultimi 7 giorni</option>
          <option value={14}>Ultimi 14 giorni</option>
          <option value={30}>Ultimi 30 giorni</option>
        </select>
        <button onClick={reload} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">🔄 Aggiorna</button>
        {overview?.lastRun && (
          <span className="text-xs text-gray-500">
            Ultimo sync: {new Date(overview.lastRun.completed_at).toLocaleString('it')} · {num(overview.lastRun.product_rows)} righe prodotto
          </span>
        )}
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 mb-4 text-sm">Errore: {error}</div>}

      {loading ? (
        <div className="text-center py-10 text-gray-500">Caricamento...</div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div className="bg-white rounded-lg border p-4">
              <div className="text-sm text-gray-500">Spesa</div>
              <div className="text-2xl font-bold text-red-600">{eur(spend)}</div>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <div className="text-sm text-gray-500">Fatturato attribuito</div>
              <div className="text-2xl font-bold text-emerald-600">{eur(revenue)}</div>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <div className="text-sm text-gray-500">ROAS (fatturato)</div>
              <div className="text-2xl font-bold">{roas == null ? '—' : roas.toFixed(2) + '×'}</div>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <div className="text-sm text-gray-500">Conversioni</div>
              <div className="text-2xl font-bold">{num(k.conversions)}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div className="bg-white rounded-lg border p-4">
              <div className="text-sm text-gray-500">Click · Impr.</div>
              <div className="text-lg font-bold">{num(k.clicks)} · {num(k.impressions)}</div>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <div className="text-sm text-gray-500">CPC medio · CPA</div>
              <div className="text-lg font-bold">{eur(cpc)} · {eur(cpa)}</div>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <div className="text-sm text-gray-500">Speso a 0 conversioni</div>
              <div className="text-2xl font-bold text-orange-600">{eur(sprecato)}</div>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <div className="text-sm text-gray-500">Spesa su prodotti in perdita*</div>
              <div className="text-2xl font-bold text-red-600">{eur(perdita)}</div>
            </div>
          </div>

          {/* Campaigns */}
          <h2 className="text-lg font-bold mb-2">Campagne</h2>
          <div className="bg-white rounded-lg border overflow-x-auto mb-8">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Campagna</th>
                  <th className="text-left px-3 py-2 font-semibold">Tipo</th>
                  <th className="text-right px-3 py-2 font-semibold">Spesa</th>
                  <th className="text-right px-3 py-2 font-semibold">Fatturato</th>
                  <th className="text-right px-3 py-2 font-semibold">ROAS</th>
                  <th className="text-right px-3 py-2 font-semibold">Conv.</th>
                  <th className="text-right px-3 py-2 font-semibold">CPA</th>
                  <th className="text-right px-3 py-2 font-semibold">Click</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.campaigns || []).map(c => (
                  <tr key={c.campaign_id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{c.campaign_type}</td>
                    <td className="px-3 py-2 text-right text-red-600 font-semibold">{eur(c.spend)}</td>
                    <td className="px-3 py-2 text-right text-emerald-700">{eur(c.revenue)}</td>
                    <td className="px-3 py-2 text-right font-bold">{c.roas == null ? '—' : Number(c.roas).toFixed(2) + '×'}</td>
                    <td className="px-3 py-2 text-right">{num(c.conversions)}</td>
                    <td className="px-3 py-2 text-right">{eur(c.cpa)}</td>
                    <td className="px-3 py-2 text-right">{num(c.clicks)}</td>
                  </tr>
                ))}
                {(overview?.campaigns || []).length === 0 && (
                  <tr><td colSpan={8} className="text-center py-6 text-gray-400">Nessuna campagna</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Products */}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-lg font-bold">Prodotti — margine vero</h2>
            <div className="flex gap-2">
              <select value={filter} onChange={e => setFilter(e.target.value)} className="border rounded px-3 py-2 text-sm">
                <option value="all">Tutti</option>
                <option value="burner">🔴 Brucia / Perdita</option>
                <option value="spesa0conv">💸 Speso, 0 conversioni</option>
                <option value="winner">🟢 OK (rendono)</option>
              </select>
              <select value={sort} onChange={e => setSort(e.target.value)} className="border rounded px-3 py-2 text-sm">
                <option value="spend">Ordina per spesa</option>
                <option value="margine">Ordina per margine</option>
              </select>
            </div>
          </div>
          <div className="bg-white rounded-lg border overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">SKU</th>
                  <th className="text-left px-3 py-2 font-semibold">Nome</th>
                  <th className="text-right px-3 py-2 font-semibold">Stock</th>
                  <th className="text-right px-3 py-2 font-semibold">Spesa</th>
                  <th className="text-right px-3 py-2 font-semibold">Fatt.</th>
                  <th className="text-right px-3 py-2 font-semibold">Conv.</th>
                  <th className="text-right px-3 py-2 font-semibold">ROAS</th>
                  <th className="text-right px-3 py-2 font-semibold">Margine*</th>
                  <th className="text-right px-3 py-2 font-semibold">ROAS margine</th>
                  <th className="text-center px-3 py-2 font-semibold">Verdetto</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.sku} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs">{p.sku}{p.protetto && <span title="protetto" className="ml-1">🔒</span>}</td>
                    <td className="px-3 py-2">{(p.name || '').slice(0, 42)}</td>
                    <td className="px-3 py-2 text-right">{num(p.erp_stock)}</td>
                    <td className="px-3 py-2 text-right text-red-600 font-semibold">{eur(p.spend)}</td>
                    <td className="px-3 py-2 text-right text-emerald-700">{eur(p.revenue)}</td>
                    <td className="px-3 py-2 text-right">{num(p.conversions)}</td>
                    <td className="px-3 py-2 text-right">{p.roas == null ? '—' : Number(p.roas).toFixed(2) + '×'}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${Number(p.margine_stimato) < 0 ? 'text-red-600' : 'text-gray-800'}`}>{eur(p.margine_stimato)}</td>
                    <td className="px-3 py-2 text-right font-bold">{p.profit_roas == null ? '—' : Number(p.profit_roas).toFixed(2) + '×'}</td>
                    <td className="px-3 py-2 text-center"><Badge v={p.verdetto} /></td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={10} className="text-center py-6 text-gray-400">Nessun prodotto</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 text-xs text-gray-500 space-y-1">
            <div>* <b>Margine stimato</b> = fatturato − (conversioni × costo vero sorgente). Assume 1 pezzo per conversione (Google Ads non dà le unità). Costo vero = costo acquisto se stock fisico, altrimenti min-cost grossista.</div>
            <div><b>Verdetto</b> (dottrina margine-first 80%): <b>BRUCIA</b> margine ≤ 0 · <b>PERDITA</b> spesa &gt; margine · <b>ATTENZIONE</b> spesa &gt; 80% margine · <b>OK</b> spesa ≤ 80% margine.</div>
            <div>🔒 = prodotto protetto (carrello/brand/stock/seller). ROAS margine = margine / spesa.</div>
          </div>
        </>
      )}
    </div>
  );
}
