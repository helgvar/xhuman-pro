import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authFetch } from '../utils/tokenManager';
import { useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip as RTooltip, Legend, CartesianGrid,
  PieChart, Pie, Cell,
} from 'recharts';

function api(path) {
  return authFetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' } }).then(r => r.json());
}

function fmtEur(v) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(v || 0);
}
function fmtNum(v) {
  return Number(v || 0).toLocaleString('it-IT');
}
function fmtDateShort(s) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

// Tooltip info icon — popup on hover/click
function InfoTip({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen(o => !o)}
        className="text-gray-300 hover:text-gray-500 transition-colors"
        aria-label="Info"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      {open && (
        <span className="absolute z-50 right-0 top-full mt-1 w-72 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg shadow-lg leading-relaxed">
          {children}
        </span>
      )}
    </span>
  );
}

function KpiCard({ label, value, sub, accent, info, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl border border-gray-200 p-5 ${onClick ? 'cursor-pointer hover:border-teal-300 hover:shadow-sm transition-all' : ''}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
        {info && <InfoTip>{info}</InfoTip>}
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
          {parseFloat(p.ga4_tp_revenue) > 0 ? fmtEur(p.ga4_tp_revenue) : '-'}
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
      <td className="px-3 py-2.5 text-right text-gray-600">{fmtEur(parseFloat(p.sell_price) || 0)}</td>
      <td className="px-3 py-2.5 text-right">
        <span className={`text-xs font-medium ${
          parseFloat(p.health_score) >= 60 ? 'text-green-600' :
          parseFloat(p.health_score) >= 40 ? 'text-amber-600' : 'text-gray-400'
        }`}>{parseFloat(p.health_score)?.toFixed(0) || '-'}</span>
      </td>
    </tr>
  );
}

function MiniTable({ title, info, products, showRevenue, showMargin, showSales, linkTo, emptyMsg }) {
  const navigate = useNavigate();
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
          {info && <InfoTip>{info}</InfoTip>}
        </div>
        {linkTo && (
          <button onClick={() => navigate(linkTo)} className="text-xs text-teal-600 hover:text-teal-800 font-medium">
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

function Section({ title, info, children, action }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          {info && <InfoTip>{info}</InfoTip>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

const CHANNEL_COLORS = ['#0d9488', '#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#cbd5e1', '#fbbf24', '#f97316'];

function FindingBadge({ severity }) {
  const map = {
    red: 'bg-red-100 text-red-700 border-red-300',
    yellow: 'bg-amber-100 text-amber-700 border-amber-300',
    green: 'bg-green-100 text-green-700 border-green-300',
  };
  return (
    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold uppercase border rounded ${map[severity] || ''}`}>
      {severity}
    </span>
  );
}

// Segment pie chart with click-to-drill
function SegmentPieChart({ tenantSwitch, feedTotal }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [drillData, setDrillData] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);

  useEffect(() => {
    api('/optimization/segments').then(setData).catch(console.error);
  }, [tenantSwitch]);

  async function openDrill(type) {
    setSelected(type);
    setDrillLoading(true);
    setDrillData(null);
    try {
      const r = await api(`/optimization/segments/${encodeURIComponent(type)}`);
      setDrillData(r);
    } catch (e) { console.error(e); }
    setDrillLoading(false);
  }

  if (!data) return <div className="text-sm text-gray-400">Caricamento...</div>;

  // Costruisci segmenti dal payload
  const counts = {};
  for (const a of (data.action_counts || [])) counts[a.action] = a;
  const burner = data.burner_30d || { n: 0, clicks: 0, cost: 0 };

  // Segmenti "attivi" (con segnale recente o decisione del feedEngine)
  const activeSegments = [
    { key: 'BURNER', label: 'Burner', n: burner.n, color: '#ef4444', detail: `Click 30gg: ${fmtNum(burner.clicks)} · Spesa: ${fmtEur(burner.cost)}` },
    { key: 'ADD', label: 'Pepite (ADD)', n: counts.ADD?.n || 0, color: '#10b981', detail: counts.ADD ? `Revenue: ${fmtEur(counts.ADD.revenue)}` : 'Da espandere' },
    { key: 'KEEP', label: 'Convertitori (KEEP)', n: counts.KEEP?.n || 0, color: '#0d9488', detail: counts.KEEP ? `Revenue: ${fmtEur(counts.KEEP.revenue)}` : '' },
    { key: 'PRICE_CUT', label: 'Tagli prezzo', n: counts.PRICE_CUT?.n || 0, color: '#f59e0b', detail: counts.PRICE_CUT ? `Spesa: ${fmtEur(counts.PRICE_CUT.cost)}` : '' },
    { key: 'MONITOR', label: 'In osservazione', n: counts.MONITOR?.n || 0, color: '#a78bfa', detail: counts.MONITOR ? `Spesa: ${fmtEur(counts.MONITOR.cost)}` : '' },
    { key: 'QUARANTENA', label: 'Quarantena', n: data.quarantine_count || 0, color: '#9ca3af', detail: 'Temporaneamente fuori dal feed' },
  ].filter(s => s.n > 0);

  // INERTI = SKU civetta=true nel feed esportato senza click 30gg.
  // Sub-segmentati lato backend in high-potential (vendono altrove, margine OK) vs low-potential.
  const activeInFeed = (counts.ADD?.n || 0) + (counts.KEEP?.n || 0) + (counts.PRICE_CUT?.n || 0) + (counts.MONITOR?.n || 0);
  const feedTotalCount = (data.feed_total || feedTotal) || 0;
  const inertiData = data.inerti || { high_potential: 0, low_potential: 0, total: 0 };
  const segments = [
    ...activeSegments,
    inertiData.high_potential > 0 && { key: 'INERTI_HIGH', label: 'Inerti pepite nascoste', n: inertiData.high_potential, color: '#22d3ee', detail: 'Nel feed, no click 30gg, vendono altrove + margine ≥12%' },
    inertiData.low_potential > 0 && { key: 'INERTI_LOW', label: 'Inerti senza segnale', n: inertiData.low_potential, color: '#e5e7eb', detail: 'Nel feed ma niente vendite altrove o margine basso' },
  ].filter(Boolean);

  const segmentTotal = segments.reduce((s, x) => s + x.n, 0);

  return (
    <>
      {/* Totals header */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3 pb-3 border-b border-gray-100">
        <div className="text-sm">
          <span className="text-gray-500">Prodotti esportati a TP:</span>{' '}
          <b className="text-teal-700 text-lg">{fmtNum(feedTotalCount)}</b>
        </div>
        <div className="text-sm flex items-center gap-3 flex-wrap">
          <span><span className="text-gray-500">Con segnale TP 30gg:</span>{' '}<b>{fmtNum(activeInFeed)}</b></span>
          <span><span className="text-cyan-600">Pepite nascoste:</span>{' '}<b className="text-cyan-700">{fmtNum(inertiData.high_potential)}</b></span>
          <span><span className="text-gray-400">Senza segnale:</span>{' '}<b className="text-gray-600">{fmtNum(inertiData.low_potential)}</b></span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={segments}
                dataKey="n"
                nameKey="label"
                cx="50%" cy="50%" outerRadius={90} innerRadius={40}
                onClick={(d) => openDrill(d.key)}
                cursor="pointer"
                label={({ percent }) => percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ''}
                labelLine={false}
              >
                {segments.map((s, i) => <Cell key={i} fill={s.color} />)}
              </Pie>
              <RTooltip formatter={(v, name) => [fmtNum(v) + ' SKU (' + ((v/segmentTotal)*100).toFixed(1) + '%)', name]} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="space-y-1.5">
          {segments.map(s => (
            <button
              key={s.key}
              onClick={() => openDrill(s.key)}
              className="w-full flex items-center gap-2 text-sm px-2 py-1.5 rounded hover:bg-gray-50 text-left"
            >
              <span className="w-3 h-3 rounded" style={{ background: s.color }} />
              <span className="flex-1 text-gray-700">{s.label}</span>
              <span className="font-semibold text-gray-900">{fmtNum(s.n)}</span>
              <span className="text-xs text-gray-400 hidden sm:block">{s.detail}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Drill-down modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-xl max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Segmento: {selected}</h3>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
            </div>
            <div className="overflow-y-auto p-5">
              {drillLoading ? (
                <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-teal-500" /></div>
              ) : drillData?.items?.length > 0 ? (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left">SKU</th>
                      <th className="px-3 py-2 text-left">Prodotto</th>
                      {drillData.items[0].clicks != null && <th className="px-3 py-2 text-right">Click</th>}
                      {drillData.items[0].cost != null && <th className="px-3 py-2 text-right">Costo</th>}
                      {drillData.items[0].sell_price != null && <th className="px-3 py-2 text-right">Prezzo</th>}
                      {drillData.items[0].margin_pct != null && <th className="px-3 py-2 text-right">Mg%</th>}
                      {drillData.items[0].reason && <th className="px-3 py-2 text-left">Motivo</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {drillData.items.map(it => (
                      <tr key={it.sku}>
                        <td className="px-3 py-2 font-mono text-xs">{it.sku}</td>
                        <td className="px-3 py-2 max-w-md truncate">{it.product_name || '—'} {it.brand && <span className="text-gray-400 text-xs">{it.brand}</span>}</td>
                        {it.clicks != null && <td className="px-3 py-2 text-right">{it.clicks}</td>}
                        {it.cost != null && <td className="px-3 py-2 text-right text-red-600">{fmtEur(it.cost)}</td>}
                        {it.sell_price != null && <td className="px-3 py-2 text-right">{fmtEur(it.sell_price)}</td>}
                        {it.margin_pct != null && <td className="px-3 py-2 text-right">{it.margin_pct?.toFixed(1)}%</td>}
                        {it.reason && <td className="px-3 py-2 text-xs text-gray-500">{it.reason}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-center text-gray-400 py-8">Nessun dato per questo segmento</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Timeline messaggi Supervisor + Optimizer
function MessageTimeline({ tenantSwitch }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all'); // all|supervisor|optimizer
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    api('/optimization/messages?limit=30').then(setData).catch(console.error);
  }, [tenantSwitch]);

  if (!data) return <div className="text-sm text-gray-400">Caricamento...</div>;

  // Merge cronologico
  const items = [];
  if (filter === 'all' || filter === 'supervisor') {
    for (const m of (data.supervisor || [])) items.push({ source: 'supervisor', date: m.started_at, ...m });
  }
  if (filter === 'all' || filter === 'optimizer') {
    for (const m of (data.optimizer || [])) items.push({ source: 'optimizer', date: m.action_date, ...m });
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        {[['all','Tutti'],['supervisor','Supervisor'],['optimizer','Ottimizzatore']].map(([k,l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`px-2.5 py-1 text-xs rounded-full ${filter === k ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {l}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-400">{items.length} eventi</span>
      </div>
      <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2">
        {items.length === 0 && <div className="text-sm text-gray-400 text-center py-4">Nessun messaggio</div>}
        {items.map((it, i) => {
          const id = `${it.source}_${it.id}`;
          const isExp = !!expanded[id];
          const hasContent = it.source === 'supervisor' && it.summary;
          return (
            <div key={id} className="border border-gray-200 rounded-lg p-3 hover:border-gray-300">
              <div className="flex items-start gap-3">
                <span className={`px-1.5 py-0.5 text-[10px] font-bold uppercase rounded ${it.source === 'supervisor' ? 'bg-amber-100 text-amber-800' : 'bg-teal-100 text-teal-800'}`}>
                  {it.source === 'supervisor' ? 'SUP' : 'OPT'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-gray-900">
                      {it.source === 'supervisor'
                        ? `${it.run_type === 'weekly' ? '📊 Weekly review' : it.run_type === 'slow' ? '🔍 Audit (slow)' : '⚡ Audit (fast)'} · ${it.findings_count || 0} findings (${it.red_count || 0} red, ${it.yellow_count || 0} yellow)`
                        : `🛠️ ${it.action_type} · ${it.products_affected || 0} prodotti`}
                    </span>
                    <span className="text-xs text-gray-400 ml-auto">{new Date(it.date).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  {it.source === 'optimizer' ? (
                    <div className="text-xs text-gray-600 mt-1">{it.description}</div>
                  ) : (
                    <>
                      <div className="text-xs text-gray-600 mt-1">
                        {it.model_used && <span>{it.model_used}</span>}
                        {it.cost_usd != null && <span> · ${(+it.cost_usd).toFixed(4)}</span>}
                      </div>
                      {hasContent && (
                        <button onClick={() => setExpanded(p => ({ ...p, [id]: !isExp }))}
                          className="text-xs text-teal-600 hover:text-teal-700 mt-1">
                          {isExp ? 'Nascondi' : 'Mostra'} report &rarr;
                        </button>
                      )}
                      {isExp && (
                        <div className="mt-2 p-3 bg-gray-50 rounded text-xs text-gray-700 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto">
                          {it.summary}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
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
  }, [selectedTenant?.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-500" />
      </div>
    );
  }

  const k = data?.kpis || {};
  const trend = data?.dailyTrend || [];
  const channels = data?.channelDistribution || [];
  const findings = data?.openFindings || [];

  // Aggregati derivati
  const trendAgg = trend.reduce((acc, d) => ({
    clicks: acc.clicks + (d.clicks || 0),
    cost: acc.cost + (d.cost || 0),
    revenue: acc.revenue + (d.revenue || 0),
    orders: acc.orders + (d.orders || 0),
  }), { clicks: 0, cost: 0, revenue: 0, orders: 0 });

  const channelTotal = channels.reduce((s, c) => s + (c.revenue || 0), 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">
          Panoramica <b>{selectedTenant?.name || 'e-commerce'}</b> —
          {k.effectiveStartDate ? (
            <> dal <b>{new Date(k.effectiveStartDate).toLocaleDateString('it-IT')}</b> a oggi</>
          ) : (
            <> ultimi <b>{k.windowDays || 30} giorni</b></>
          )}
          {' · '}<b>{k.activeDays || 0} giorni TP attivi</b>
          {k.feedLastRun && <span className="ml-3 text-xs text-gray-400">FeedEngine: {new Date(k.feedLastRun).toLocaleString('it-IT')}</span>}
        </p>
      </div>

      {/* Allarmi attivi (Supervisor) */}
      {findings.length > 0 && (
        <div className="bg-white rounded-xl border border-amber-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-700">⚠️ Allarmi attivi del Supervisor</h2>
              <InfoTip>
                <b>Supervisor Agent</b> esegue ogni 2 ore controlli automatici su:
                <br />• Salute cron (zombie, orders, GA4, scraper)
                <br />• Anomalie KPI (revenue/click drop)
                <br />• Pacing budget mensile
                <br />• Qualità dati (prezzi, margini popolati)
                <br /><br />Mostra fino a 5 problemi aperti, prioritizzati per severità.
              </InfoTip>
            </div>
            <span className="text-xs text-gray-400">{findings.length} aperti</span>
          </div>
          <div className="space-y-2">
            {findings.map(f => (
              <div key={f.id} className="flex items-start gap-3 text-sm border-l-2 border-gray-200 pl-3 py-1">
                <FindingBadge severity={f.severity} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900">{f.title}</div>
                  {f.recommended_action && <div className="text-xs text-gray-500 mt-0.5">→ {f.recommended_action}</div>}
                </div>
                <span className="text-[10px] text-gray-400 whitespace-nowrap">{f.category}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* KPI principali */}
      {(() => {
        const incidenceStore = trendAgg.revenue > 0
          ? +((k.clickCost || 0) / trendAgg.revenue * 100).toFixed(2)
          : null;
        return (
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard
          label="Incidenza GA4-attribuita"
          value={k.incidence > 0 ? k.incidence + '%' : '-'}
          sub={k.incidenceBasis === 'tp_attributed'
            ? `costo / fatt. TP-attribuito (dir+indir)`
            : 'costo / fatt. store (GA4 non disponibile)'}
          accent={k.incidence == null ? '' : k.incidence <= 15 ? 'text-emerald-600' : k.incidence <= 30 ? 'text-amber-600' : 'text-red-600'}
          info={
            <>
              <b>Incidenza GA4-attribuita</b> = costo click / fatturato attribuito a TP da GA4
              (last-click + cross-session). Visione restrittiva, utile per ROAS canale.
              <br /><br />Soglie:
              <br />🟢 ≤15% = ottimo
              <br />🟡 15-30% = sano
              <br />🔴 30-60% = monitora
              <br />⛔ &gt;60% = critico
              <br /><br />Calcolata su <b>{k.activeDays || 0} giorni TP attivi reali</b>, no proiezioni.
            </>
          }
          onClick={() => navigate('/optimization')}
        />
        <KpiCard
          label="Incidenza Store"
          value={incidenceStore != null ? incidenceStore + '%' : '-'}
          sub={`costo TP / fatturato store totale`}
          accent={incidenceStore == null ? '' : incidenceStore <= 5 ? 'text-emerald-600' : incidenceStore <= 8 ? 'text-amber-600' : 'text-red-600'}
          info={
            <>
              <b>Incidenza Store</b> = costo click TP / fatturato store totale (Magento).
              È la metrica strategica del feed: include anche gli ordini che TP genera
              ma GA4 non riesce ad attribuire.
              <br /><br />Soglie:
              <br />🟢 ≤5% = ottimo
              <br />🟡 5-8% = sano
              <br />🔴 &gt;8% = monitora
            </>
          }
          onClick={() => navigate('/optimization')}
        />
        <KpiCard
          label="Fatturato TP attribuito"
          value={fmtEur(k.tpRevenueTotal || 0)}
          sub={`${k.tpTransactions || 0} ordini · conv. ${(k.convRate || 0).toFixed(2)}%${k.tpRevenueIndirect > 0 ? ' (incl. ' + fmtEur(k.tpRevenueIndirect) + ' indir.)' : ''}`}
          accent="text-emerald-700"
          info={
            <>
              <b>Fatturato attribuibile a Trovaprezzi</b>.
              <br /><br />• <b>Diretto</b>: TP è stato l'ultimo click prima dell'acquisto (last-click).
              <br />• <b>Indiretto</b>: TP è stato la prima sessione, conversione in sessione successiva (cross-session GA4).
              <br /><br />Per l'incidenza vera serve sommarli.
            </>
          }
          onClick={() => navigate('/statistiche')}
        />
        <KpiCard
          label="Costo Click TP"
          value={fmtEur(k.clickCost || 0)}
          sub={`${fmtNum(k.totalClicks)} click × €0.27`}
          accent="text-red-600"
          info={
            <>
              <b>Spesa stimata</b> per click su Trovaprezzi nel periodo.
              <br /><br />Costo = numero click × CPC stimato (default €0.27, configurabile per tenant in <i>health_config.avg_tp_cpc</i>).
              <br /><br />Solo giorni TP attivi reali, no proiezioni.
            </>
          }
          onClick={() => navigate('/trovaprezzi')}
        />
        <KpiCard
          label="Prodotti nel Feed"
          value={fmtNum(k.feedTotal || 0)}
          sub={`${fmtNum(k.toRemove)} in quarantena · ${fmtNum(k.priceCuts)} tagli prezzo`}
          info={
            <>
              <b>Prodotti effettivamente esportati a Trovaprezzi</b> (fonte: <i>stable_feed_codes</i>).
              <br /><br />Conta SKU con stock &gt; 0 + prezzo &gt; 0 + civetta=true (oppure ADD da feedEngine), esclusi quelli in quarantena.
              <br /><br />La quarantena è la lista di SKU temporaneamente fuori dal feed (burner, killer, mass).
            </>
          }
          onClick={() => navigate('/optimization')}
        />
      </div>
        );
      })()}

      {/* Trend giornaliero — line + bar */}
      {trend.length > 0 && (
        <Section
          title="Trend giornaliero"
          info={
            <>
              <b>Andamento giornaliero</b> di costo TP (barre rosse) e fatturato store (linea verde) negli ultimi 30gg.
              <br /><br />• Barre rosse: <b>spesa click</b> di quel giorno
              <br />• Linea verde: <b>fatturato store</b> totale (Magento)
              <br />• Barre azzurre: <b>click TP</b>
              <br /><br />Se vedi giorni con spesa nulla è perché TP era spento (budget esaurito o sospensione).
            </>
          }
        >
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="date" tickFormatter={fmtDateShort} fontSize={11} />
                <YAxis yAxisId="left" fontSize={11} tickFormatter={v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v} />
                <YAxis yAxisId="right" orientation="right" fontSize={11} tickFormatter={v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v} />
                <RTooltip
                  formatter={(v, name) => name === 'clicks' || name === 'orders' ? [fmtNum(v), name] : [fmtEur(v), name]}
                  labelFormatter={d => `Giorno ${new Date(d).toLocaleDateString('it-IT')}`}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="left" dataKey="cost" name="Costo TP €" fill="#ef4444" />
                <Bar yAxisId="left" dataKey="clicks" name="Click TP" fill="#93c5fd" hide />
                <Line yAxisId="right" type="monotone" dataKey="revenue" name="Fatturato Store €" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="orders" name="Ordini" stroke="#0ea5e9" strokeWidth={1.5} dot={false} hide />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div><span className="text-gray-500">Costo totale:</span> <b className="text-red-600">{fmtEur(trendAgg.cost)}</b></div>
            <div><span className="text-gray-500">Fatturato store:</span> <b className="text-emerald-700">{fmtEur(trendAgg.revenue)}</b></div>
            <div><span className="text-gray-500">Click totali:</span> <b>{fmtNum(trendAgg.clicks)}</b></div>
            <div><span className="text-gray-500">Ordini:</span> <b>{fmtNum(trendAgg.orders)}</b></div>
          </div>
        </Section>
      )}

      {/* Distribuzione canali GA4 + Quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Section
            title="Distribuzione fatturato TP per touch"
            info={
              <>
                Suddivisione del <b>fatturato TP-attribuito</b> tra:
                <br />• <b>Last-click</b>: TP era l'ultimo touchpoint prima della conversione
                <br />• <b>Cross-session</b>: TP è stato il primo touchpoint, l'utente è tornato e ha comprato in una sessione successiva
                <br /><br />Entrambi contribuiscono al fatturato attribuibile a TP.
              </>
            }
          >
            {channels.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={channels} dataKey="revenue" nameKey="channel" cx="50%" cy="50%" outerRadius={80} innerRadius={40}>
                        {channels.map((c, i) => <Cell key={i} fill={CHANNEL_COLORS[i % CHANNEL_COLORS.length]} />)}
                      </Pie>
                      <RTooltip formatter={(v) => fmtEur(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2">
                  {channels.map((c, i) => (
                    <div key={c.channel} className="flex items-center gap-2 text-sm">
                      <span className="w-3 h-3 rounded" style={{ background: CHANNEL_COLORS[i % CHANNEL_COLORS.length] }} />
                      <span className="flex-1 text-gray-700">{c.channel}</span>
                      <span className="font-semibold text-gray-900">{fmtEur(c.revenue)}</span>
                      <span className="text-xs text-gray-400">{channelTotal > 0 ? ((c.revenue / channelTotal) * 100).toFixed(0) + '%' : ''}</span>
                    </div>
                  ))}
                  <div className="border-t pt-2 mt-2 flex items-center text-sm">
                    <span className="flex-1 font-semibold">Totale TP-attribuito</span>
                    <span className="font-bold text-emerald-700">{fmtEur(channelTotal)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-400 text-center py-8">Dati GA4 non disponibili per questo tenant</div>
            )}
          </Section>
        </div>

        {/* Quick actions */}
        <div>
          <Section
            title="Vai a..."
            info="Scorciatoie alle altre sezioni: Ottimizzazione Feed (decisioni feedEngine), Pareto (top SKU per fatturato), Trovaprezzi (click giornalieri), Statistiche (GA4 + Merchant Center)."
          >
            <div className="space-y-2">
              {[
                { label: 'Ottimizzazione Feed', to: '/optimization', desc: 'Decisioni feedEngine, REMOVE/ADD/PRICE_CUT' },
                { label: 'Regola di Pareto', to: '/pareto', desc: 'Top SKU cross-tenant, leaderboard' },
                { label: 'Trovaprezzi Click', to: '/trovaprezzi', desc: 'Click giornalieri, andamento competitor' },
                { label: 'Analytics & GA4', to: '/statistiche', desc: 'GA4 channel KPIs + Merchant Center' },
              ].map(s => (
                <button
                  key={s.to}
                  onClick={() => navigate(s.to)}
                  className="w-full text-left px-3 py-2 rounded-lg border border-gray-200 hover:border-teal-300 hover:bg-teal-50/50 transition-all"
                >
                  <div className="text-sm font-medium text-gray-900">{s.label} →</div>
                  <div className="text-xs text-gray-500 mt-0.5">{s.desc}</div>
                </button>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {/* Segmenti prodotti + Timeline messaggi */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Segmenti Feed"
          info={
            <>
              <b>Distribuzione SKU per stato</b> nel feed:
              <br />• <b>Burner</b>: hanno click ma non vendono (ultimi 30gg)
              <br />• <b>Pepite (ADD)</b>: nuovi candidati promossi dal feedEngine
              <br />• <b>Convertitori (KEEP)</b>: SKU che convertono bene, da mantenere
              <br />• <b>Tagli prezzo</b>: SKU con PRICE_CUT attivo
              <br />• <b>In osservazione (MONITOR)</b>: in attesa di decisione
              <br />• <b>Quarantena</b>: temporaneamente fuori dal feed
              <br /><br />Click su un segmento per vedere il dettaglio dei top 50 SKU.
            </>
          }
        >
          <SegmentPieChart tenantSwitch={selectedTenant?.id} feedTotal={k.feedTotal} />
        </Section>
        <Section
          title="Timeline Supervisor & Ottimizzatore"
          info={
            <>
              <b>Cronologia eventi automatici</b>:
              <br />• <span className="font-bold text-amber-700">SUP</span> = Supervisor Agent (audit ogni 2h, weekly review)
              <br />• <span className="font-bold text-teal-700">OPT</span> = FeedEngine (decisioni REMOVE/ADD/PRICE_CUT)
              <br /><br />I report Supervisor sono espandibili (Sonnet 4.6 / Opus 4.7).
              <br />Le azioni Optimizer mostrano cosa il feedEngine ha applicato.
            </>
          }
        >
          <MessageTimeline tenantSwitch={selectedTenant?.id} />
        </Section>
      </div>

      {/* Top prodotti */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MiniTable
          title="Top Vendite TP"
          info="I 10 prodotti che hanno generato più fatturato attribuito a Trovaprezzi (GA4 last-click) negli ultimi 30 giorni. Ordinati per revenue decrescente."
          products={data?.topSellers || []}
          showRevenue showSales
          linkTo="/optimization"
          emptyMsg="Nessun dato disponibile"
        />
        <MiniTable
          title="Alta Marginalità + Vendite"
          info="Prodotti che combinano margine alto (>15%) con vendite recenti (TP o store). Sono i candidati ideali per spinta TP: alta redditività + domanda confermata."
          products={data?.highMargin || []}
          showMargin showSales
          linkTo="/products"
          emptyMsg="Nessun prodotto ad alta marginalità"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MiniTable
          title="Alta Rotazione (30gg)"
          info="Prodotti con il maggior volume di vendite store negli ultimi 30 giorni. Indicatore di domanda spontanea (anche fuori da TP)."
          products={data?.highRotation || []}
          showSales showRevenue
          linkTo="/products"
          emptyMsg="Nessun dato di rotazione"
        />
        <MiniTable
          title="Stagionali in periodo"
          info="Prodotti marcati come stagionali (es. allergie primavera, raffreddore inverno) attualmente nel loro picco di domanda. Spingere ora per massimizzare il fatturato stagionale."
          products={data?.seasonal || []}
          showRevenue showSales
          linkTo="/optimization"
          emptyMsg="Nessun prodotto stagionale in questo periodo"
        />
      </div>
    </div>
  );
}
