import React, { useState, useEffect } from 'react';
import { authFetch } from '../utils/tokenManager';

function api(path) {
  return authFetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' } }).then(r => r.json());
}

const fmtEur = v => v == null ? '—' : Number(v).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtNum = v => v == null ? '—' : Number(v).toLocaleString('it-IT');
const fmtPct = (v, d = 1) => v == null ? '—' : `${Number(v).toFixed(d)}%`;
const fmtDelta = v => {
  if (v == null) return <span className="text-gray-400">—</span>;
  const n = Number(v);
  if (n === 0) return <span className="text-gray-500">0%</span>;
  const cls = n > 0 ? 'text-emerald-600' : 'text-red-600';
  return <span className={cls}>{n > 0 ? '+' : ''}{n.toFixed(1)}%</span>;
};

function KpiCard({ label, value, sub, accent }) {
  return (
    <div className={`bg-white rounded-lg border p-4 ${accent || 'border-gray-200'}`}>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function ApprovalBadge({ s }) {
  if (!s) return <span className="text-xs text-gray-400">—</span>;
  const v = String(s).toLowerCase();
  const map = {
    approved:    'bg-emerald-100 text-emerald-800 border-emerald-300',
    pending:     'bg-amber-100 text-amber-800 border-amber-300',
    disapproved: 'bg-red-100 text-red-800 border-red-300',
    unknown:     'bg-gray-100 text-gray-700 border-gray-300',
  };
  return <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold uppercase border rounded ${map[v] || 'bg-gray-100 text-gray-700 border-gray-300'}`}>{s}</span>;
}

function RecBadge({ rec }) {
  const map = {
    exclude_from_feed: { label: 'Escludi feed', color: 'bg-red-100 text-red-800 border-red-300' },
    lower_bid:         { label: 'Abbassa bid', color: 'bg-orange-100 text-orange-800 border-orange-300' },
    check_landing:    { label: 'Check landing', color: 'bg-cyan-100 text-cyan-800 border-cyan-300' },
    monitor:           { label: 'Monitora', color: 'bg-gray-100 text-gray-700 border-gray-300' },
    boost_bid:         { label: 'Aumenta bid', color: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
    price_align_to_benchmark: { label: 'Allinea prezzo', color: 'bg-blue-100 text-blue-800 border-blue-300' },
    review_label:      { label: 'Verifica label', color: 'bg-amber-100 text-amber-800 border-amber-300' },
    price_cut_blocked_low_margin: { label: 'No promo: margine basso', color: 'bg-gray-100 text-gray-700 border-gray-300' },
  };
  const m = map[rec] || { label: rec, color: 'bg-gray-100 text-gray-700 border-gray-300' };
  return <span className={`inline-flex px-2 py-0.5 text-[11px] font-medium border rounded ${m.color}`}>{m.label}</span>;
}

function PotentialPill({ p }) {
  if (!p) return <span className="text-xs text-gray-400">—</span>;
  const map = { HIGH: 'bg-emerald-100 text-emerald-800', MEDIUM: 'bg-amber-100 text-amber-800', LOW: 'bg-gray-100 text-gray-700' };
  return <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold uppercase rounded ${map[p] || 'bg-gray-100 text-gray-700'}`}>{p}</span>;
}

const TABS = [
  { key: 'overview', label: 'Overview', desc: 'KPI 14g + trend' },
  { key: 'burners', label: 'Burner Detector', desc: 'SKU che bruciano budget' },
  { key: 'opportunities', label: 'Occasioni perse', desc: 'Potenziale non sfruttato' },
  { key: 'feed', label: 'Feed Health', desc: 'Approval status & issues' },
];

export default function Shopping() {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [burners, setBurners] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [feedHealth, setFeedHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function load(forTab = tab) {
    setLoading(true); setError(null);
    try {
      if (forTab === 'overview' && !overview) {
        const r = await api('/shopping/overview'); if (r.error) throw new Error(r.error);
        setOverview(r);
      } else if (forTab === 'burners' && burners.length === 0) {
        const r = await api('/shopping/burners?limit=50'); if (r.error) throw new Error(r.error);
        setBurners(r);
      } else if (forTab === 'opportunities' && opportunities.length === 0) {
        const r = await api('/shopping/opportunities?limit=50'); if (r.error) throw new Error(r.error);
        setOpportunities(r);
      } else if (forTab === 'feed' && !feedHealth) {
        const r = await api('/shopping/feed-health'); if (r.error) throw new Error(r.error);
        setFeedHealth(r);
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(tab); /* eslint-disable-next-line */ }, [tab]);

  function refreshAll() {
    setOverview(null); setBurners([]); setOpportunities([]); setFeedHealth(null);
    setTimeout(() => load(tab), 50);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Google Shopping Optimizer</h1>
          <p className="text-sm text-gray-500 mt-0.5">Merchant Center: ottimizzazione campagne, burner detection, recupero opportunità</p>
        </div>
        <button onClick={refreshAll} disabled={loading} className="px-3 py-1 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">
          {loading ? '…' : 'Aggiorna'}
        </button>
      </div>

      <div className="border-b border-gray-200 flex gap-1">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <div>{t.label}</div>
            <div className="text-[10px] text-gray-400 font-normal">{t.desc}</div>
          </button>
        ))}
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}

      {tab === 'overview' && overview && <OverviewPanel data={overview} />}
      {tab === 'burners' && <BurnersPanel rows={burners} loading={loading} />}
      {tab === 'opportunities' && <OpportunitiesPanel rows={opportunities} loading={loading} />}
      {tab === 'feed' && feedHealth && <FeedHealthPanel data={feedHealth} />}

      {loading && !overview && !burners.length && !opportunities.length && !feedHealth && (
        <div className="text-gray-500 text-sm">Caricamento…</div>
      )}
    </div>
  );
}

function OverviewPanel({ data }) {
  const { skus, traffic, trend_vs_prev_14d: trend } = data;
  const disapprovedPct = skus.total > 0 ? Math.round((skus.disapproved / skus.total) * 100) : 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="SKU nel feed" value={fmtNum(skus.total)}
          sub={`${fmtNum(skus.approved)} approved · ${fmtNum(skus.disapproved)} disapproved · ${fmtNum(skus.pending)} pending`}
          accent={disapprovedPct > 30 ? 'border-red-400' : ''} />
        <KpiCard label="Impressions 14g" value={fmtNum(traffic.impressions)}
          sub={<>vs prev: {fmtDelta(trend.impressions_delta_pct)}</>} />
        <KpiCard label="Click 14g" value={fmtNum(traffic.clicks)}
          sub={<>CTR {fmtPct(traffic.ctr_pct)} · vs prev: {fmtDelta(trend.clicks_delta_pct)}</>} />
        <KpiCard label="Conversioni 14g" value={fmtNum(traffic.conversions)}
          sub={<>CVR {fmtPct(traffic.cvr_pct)} · {fmtEur(traffic.conversion_value)} · vs prev: {fmtDelta(trend.conversions_delta_pct)}</>} />
      </div>

      {disapprovedPct > 30 && (
        <div className="bg-red-50 border border-red-300 text-red-800 p-3 rounded text-sm">
          <div className="font-semibold">⚠ Feed in difficoltà</div>
          <div>Il {disapprovedPct}% degli SKU è disapproved. Vai nel tab <strong>Feed Health</strong> per vedere le cause.</div>
        </div>
      )}

      {traffic.clicks > 0 && traffic.conversions === 0 && (
        <div className="bg-amber-50 border border-amber-300 text-amber-800 p-3 rounded text-sm">
          <div className="font-semibold">⚠ Conversioni a 0</div>
          <div>{fmtNum(traffic.clicks)} click in 14g senza conversioni tracciate. Possibili cause: conv tag Shopping non installato, finestra attribution sbagliata, oppure budget interamente speso su burner. Apri il tab <strong>Burner Detector</strong>.</div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-gray-900 mb-2">AOV</h3>
        <div className="text-3xl font-bold text-gray-900">{fmtEur(traffic.aov_eur)}</div>
        <div className="text-xs text-gray-500 mt-1">Valore medio ordine Shopping in finestra</div>
      </div>
    </div>
  );
}

function BurnersPanel({ rows, loading }) {
  if (loading && rows.length === 0) return <div className="text-gray-500 text-sm">Caricamento…</div>;
  if (rows.length === 0) return <div className="text-gray-500 text-sm">Nessun burner identificato (criterio: ≥5 click + 0 conversioni Shopping in 14g).</div>;
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
          <tr>
            <th className="px-3 py-2">SKU / Nome</th>
            <th className="px-3 py-2 text-right">Imp 14g</th>
            <th className="px-3 py-2 text-right">Click 14g</th>
            <th className="px-3 py-2 text-right">CTR</th>
            <th className="px-3 py-2 text-right">Vendite store 30g</th>
            <th className="px-3 py-2 text-right">Margine</th>
            <th className="px-3 py-2">Azione</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(r => (
            <tr key={r.sku} className="hover:bg-gray-50">
              <td className="px-3 py-2">
                <div className="font-mono text-xs">{r.sku}</div>
                <div className="text-xs text-gray-600 truncate max-w-xs">{r.name}</div>
                {r.brand && <div className="text-[10px] text-gray-400">{r.brand}</div>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.impressions_14d)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.clicks_14d)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.ctr_pct, 2)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.store_sales_30d)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.margin_pct)}</td>
              <td className="px-3 py-2">
                <RecBadge rec={r.recommendation} />
                <div className="text-[11px] text-gray-500 mt-1">{r.reason}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpportunitiesPanel({ rows, loading }) {
  if (loading && rows.length === 0) return <div className="text-gray-500 text-sm">Caricamento…</div>;
  if (rows.length === 0) return <div className="text-gray-500 text-sm">Nessuna occasione persa identificata (criterio: click_potential HIGH/MEDIUM + ≤2 click in 14g + stock disponibile + margine ≥10%).</div>;
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
          <tr>
            <th className="px-3 py-2">SKU / Nome</th>
            <th className="px-3 py-2 text-center">Potenziale</th>
            <th className="px-3 py-2 text-right">Imp 14g</th>
            <th className="px-3 py-2 text-right">Click 14g</th>
            <th className="px-3 py-2 text-right">Vendite globali 30g</th>
            <th className="px-3 py-2 text-right">Margine</th>
            <th className="px-3 py-2 text-right">Prezzo / Benchmark</th>
            <th className="px-3 py-2">Azione</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(r => (
            <tr key={r.sku} className="hover:bg-gray-50">
              <td className="px-3 py-2">
                <div className="font-mono text-xs">{r.sku}</div>
                <div className="text-xs text-gray-600 truncate max-w-xs">{r.name}</div>
                {r.brand && <div className="text-[10px] text-gray-400">{r.brand}</div>}
              </td>
              <td className="px-3 py-2 text-center">
                <PotentialPill p={r.click_potential} />
                {r.click_potential_rank && <div className="text-[10px] text-gray-400 mt-0.5">rank {r.click_potential_rank}</div>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.impressions_14d)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.clicks_14d)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.global_sales_30d)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.margin_pct)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">
                {fmtEur(r.current_price)} / <span className="text-gray-500">{fmtEur(r.benchmark_price)}</span>
              </td>
              <td className="px-3 py-2">
                <RecBadge rec={r.recommendation} />
                <div className="text-[11px] text-gray-500 mt-1">{r.reason}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeedHealthPanel({ data }) {
  const { distribution, lost_sales, dead_listings } = data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {distribution.map(d => (
          <KpiCard key={d.status} label={d.status} value={fmtNum(d.count)}
            sub={`${d.pct}% · ${fmtNum(d.total_issues)} issues`}
            accent={d.status === 'disapproved' ? 'border-red-400' : d.status === 'pending' ? 'border-amber-400' : ''} />
        ))}
      </div>

      <section>
        <h3 className="font-semibold text-gray-900 mb-2">SKU disapproved con vendite store reali (= bug feed)</h3>
        <p className="text-xs text-gray-500 mb-2">Questi SKU vendono nel tuo store ma sono bloccati su Merchant Center. Probabilmente perdiamo Shopping su SKU che convertirebbero.</p>
        {lost_sales.length === 0 ? <div className="text-sm text-gray-500">Nessuno — feed in salute su questo aspetto.</div> : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
                <tr>
                  <th className="px-3 py-2">SKU / Nome</th>
                  <th className="px-3 py-2">Stato</th>
                  <th className="px-3 py-2 text-right">Issues</th>
                  <th className="px-3 py-2 text-right">Vendite store 30g</th>
                  <th className="px-3 py-2 text-right">Revenue store 30g</th>
                  <th className="px-3 py-2 text-right">Margine</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lost_sales.map(r => (
                  <tr key={r.sku} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{r.sku}</div>
                      <div className="text-xs text-gray-600 truncate max-w-xs">{r.name}</div>
                      {r.brand && <div className="text-[10px] text-gray-400">{r.brand}</div>}
                    </td>
                    <td className="px-3 py-2"><ApprovalBadge s={r.approval_status} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.item_issues_count)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.store_sales_30d)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtEur(r.store_revenue_30d)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.margin_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 mb-2">Inserzioni inerti (approved, impression ma 0 click)</h3>
        <p className="text-xs text-gray-500 mb-2">Questi SKU sono mostrati su Shopping ma nessuno clicca. Possibili cause: immagine, prezzo, titolo non competitivi.</p>
        {dead_listings.length === 0 ? <div className="text-sm text-gray-500">Nessuna inserzione inerte (≥50 impression + 0 click).</div> : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-600 uppercase">
                <tr>
                  <th className="px-3 py-2">SKU / Nome</th>
                  <th className="px-3 py-2 text-right">Impressions</th>
                  <th className="px-3 py-2 text-center">Potenziale Google</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {dead_listings.map(r => (
                  <tr key={r.sku} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{r.sku}</div>
                      <div className="text-xs text-gray-600 truncate max-w-xs">{r.name}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.impressions_14d)}</td>
                    <td className="px-3 py-2 text-center"><PotentialPill p={r.click_potential} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
