import React, { useState, useEffect } from 'react';
import { authFetch } from '../utils/tokenManager';

function api(path) {
  return authFetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
  }).then(r => r.json());
}

export default function Statistiche() {
  const [mcData, setMcData] = useState(null);
  const [tpData, setTpData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const mc = await api('/merchant-center/overview').catch(() => null);
        const tp = await api('/trovaprezzi/overview').catch(() => null);
        setMcData(mc);
        setTpData(tp);
      } catch (err) {
        setError(err.message);
      }
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-500"></div>
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-red-600">Errore: {error}</div>;
  }

  const mc = mcData?.mcStats || {};
  const tp = tpData || {};
  const tpClick = tp.clickStats;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Analytics & Statistiche</h1>
        <p className="text-sm text-gray-500 mt-1">Google Shopping + Trovaprezzi</p>
      </div>

      {/* MC KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPI label="Prodotti MC" value={n(mc.mc_total)} />
        <KPI label="Approvati MC" value={n(mc.mc_approved)} />
        <KPI label="Click GS (14gg)" value={n(mc.total_clicks_14d)} />
        <KPI label="Impressioni (14gg)" value={n(mc.total_impressions_14d)} />
      </div>

      {/* TP KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPI label="Prodotti Scraper" value={n(tp.scraperStats?.scraper_products)} />
        <KPI label="Merchant TP" value={n(tp.scraperStats?.scraper_merchants)} />
        <KPI label="Click TP (ultimo gg)" value={tpClick ? n(tpClick.total_clicks) : 'N/D'} />
        <KPI label="Prodotti con click" value={tpClick ? n(tpClick.products_with_clicks) : 'N/D'} />
      </div>

      {/* Click Potential Distribution */}
      {(mc.high_potential > 0 || mc.medium_potential > 0 || mc.low_potential > 0) && (
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-semibold mb-3">Click Potential (Merchant Center)</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-3 bg-green-50 rounded">
              <div className="text-2xl font-bold text-green-700">{n(mc.high_potential)}</div>
              <div className="text-xs text-green-600">HIGH</div>
            </div>
            <div className="text-center p-3 bg-yellow-50 rounded">
              <div className="text-2xl font-bold text-yellow-700">{n(mc.medium_potential)}</div>
              <div className="text-xs text-yellow-600">MEDIUM</div>
            </div>
            <div className="text-center p-3 bg-gray-50 rounded">
              <div className="text-2xl font-bold text-gray-700">{n(mc.low_potential)}</div>
              <div className="text-xs text-gray-600">LOW</div>
            </div>
          </div>
        </div>
      )}

      {/* Top MC Products */}
      {mcData?.topClicksMC && mcData.topClicksMC.length > 0 && (
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-semibold mb-3">Top Prodotti Google Shopping (click 14gg)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Prodotto</th>
                  <th className="px-3 py-2 text-right">Click</th>
                  <th className="px-3 py-2 text-right">Impressioni</th>
                  <th className="px-3 py-2 text-right">CTR</th>
                  <th className="px-3 py-2 text-right">Prezzo</th>
                  <th className="px-3 py-2 text-right">Benchmark</th>
                  <th className="px-3 py-2">Potenziale</th>
                </tr>
              </thead>
              <tbody>
                {mcData.topClicksMC.map((p, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2 max-w-[300px] truncate">{p.mc_title || p.offer_id}</td>
                    <td className="px-3 py-2 text-right font-medium">{p.clicks_14d}</td>
                    <td className="px-3 py-2 text-right">{n(p.impressions_14d)}</td>
                    <td className="px-3 py-2 text-right">{(parseFloat(p.ctr_14d || 0) * 100).toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right">{money(p.mc_sale_price)}</td>
                    <td className="px-3 py-2 text-right">{money(p.benchmark_price)}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs ${p.click_potential === 'HIGH' ? 'bg-green-100 text-green-700' : p.click_potential === 'MEDIUM' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                        {p.click_potential || '-'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Click trend */}
      {tp.clickTrend && tp.clickTrend.length > 0 && (
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-semibold mb-3">Trend Click Trovaprezzi</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Data</th>
                  <th className="px-3 py-2 text-right">Prodotti</th>
                  <th className="px-3 py-2 text-right">Click</th>
                  <th className="px-3 py-2 text-right">Costo (€0.27)</th>
                </tr>
              </thead>
              <tbody>
                {tp.clickTrend.map((d, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2">{new Date(d.fetch_date).toLocaleDateString('it-IT')}</td>
                    <td className="px-3 py-2 text-right">{d.products}</td>
                    <td className="px-3 py-2 text-right font-medium">{n(d.total_clicks)}</td>
                    <td className="px-3 py-2 text-right text-red-600">{money(parseInt(d.total_clicks) * 0.27)}</td>
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

function KPI({ label, value }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="text-xl font-bold mt-1">{value}</div>
    </div>
  );
}

function n(val) { return parseInt(val || 0).toLocaleString('it-IT'); }
function money(val) { return val ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(parseFloat(val)) : '-'; }
