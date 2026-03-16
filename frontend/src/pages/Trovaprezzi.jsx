import React, { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../utils/tokenManager';
import { useAuth } from '../contexts/AuthContext';

function api(path, opts = {}) {
  return authFetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  }).then(r => r.json());
}

export default function Trovaprezzi() {
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);

  // Clicks tab state
  const [clicks, setClicks] = useState([]);
  const [clicksPagination, setClicksPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [clicksSearch, setClicksSearch] = useState('');
  const [clicksDate, setClicksDate] = useState('');
  const [clicksCategory, setClicksCategory] = useState('');
  const [clicksSortBy, setClicksSortBy] = useState('clicks');
  const [clicksSortDir, setClicksSortDir] = useState('desc');
  const [clicksDates, setClicksDates] = useState([]);
  const [clicksCategories, setClicksCategories] = useState([]);
  const [loadingClicks, setLoadingClicks] = useState(false);

  // Zombie run state
  const [runningZombie, setRunningZombie] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/trovaprezzi/overview');
      setOverview(data);
    } catch (err) {
      console.error('Overview error:', err);
    }
    setLoading(false);
  }, []);

  const loadClicks = useCallback(async (page = 1) => {
    setLoadingClicks(true);
    try {
      const params = new URLSearchParams({ page, limit: 25, sortBy: clicksSortBy, sortDir: clicksSortDir });
      if (clicksSearch) params.set('search', clicksSearch);
      if (clicksDate) params.set('date', clicksDate);
      if (clicksCategory) params.set('category', clicksCategory);

      const data = await api(`/trovaprezzi/clicks?${params}`);
      setClicks(data.data || []);
      setClicksPagination(data.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
    } catch (err) {
      console.error('Clicks error:', err);
    }
    setLoadingClicks(false);
  }, [clicksSearch, clicksDate, clicksCategory, clicksSortBy, clicksSortDir]);

  const loadClicksMeta = useCallback(async () => {
    try {
      const [datesData, catsData] = await Promise.all([
        api('/trovaprezzi/clicks/dates'),
        api('/trovaprezzi/clicks/categories'),
      ]);
      setClicksDates(datesData.dates || []);
      setClicksCategories(catsData.categories || []);
    } catch {}
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  useEffect(() => {
    if (tab === 'clicks') {
      loadClicks(1);
      loadClicksMeta();
    }
  }, [tab, loadClicks, loadClicksMeta]);

  const triggerZombie = async () => {
    if (runningZombie) return;
    setRunningZombie(true);
    try {
      await api('/trovaprezzi/zombie/run', { method: 'POST' });
      // Reload overview after a delay
      setTimeout(() => { loadOverview(); setRunningZombie(false); }, 5000);
    } catch {
      setRunningZombie(false);
    }
  };

  const handleClicksSort = (col) => {
    if (clicksSortBy === col) {
      setClicksSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setClicksSortBy(col);
      setClicksSortDir('desc');
    }
  };

  const SortIcon = ({ col }) => {
    if (clicksSortBy !== col) return null;
    return <span className="ml-1">{clicksSortDir === 'asc' ? '\u2191' : '\u2193'}</span>;
  };

  const statusColors = { completed: 'bg-green-100 text-green-800', failed: 'bg-red-100 text-red-800', running: 'bg-blue-100 text-blue-800', no_data: 'bg-yellow-100 text-yellow-800', pending: 'bg-gray-100 text-gray-800' };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Trovaprezzi</h1>
          <p className="text-sm text-gray-500 mt-1">
            Classifica competitor, click giornalieri e statistiche
            {overview?.sellerName && <span className="ml-2 text-brand-600 font-medium">Seller: {overview.sellerName}</span>}
          </p>
        </div>
        {(user?.role === 'superadmin' || user?.role === 'admin') && (
          <button
            onClick={triggerZombie}
            disabled={runningZombie}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 text-sm font-medium"
          >
            {runningZombie ? 'Download in corso...' : 'Scarica Click Oggi'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex -mb-px">
          {[
            { id: 'overview', label: 'Panoramica' },
            { id: 'clicks', label: 'Click Giornalieri' },
            { id: 'merchants', label: 'Competitor' },
            { id: 'runs', label: 'Storico Esecuzioni' },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab overview={overview} statusColors={statusColors} />}
      {tab === 'clicks' && (
        <ClicksTab
          clicks={clicks} pagination={clicksPagination} loading={loadingClicks}
          search={clicksSearch} setSearch={setClicksSearch}
          date={clicksDate} setDate={setClicksDate}
          category={clicksCategory} setCategory={setClicksCategory}
          dates={clicksDates} categories={clicksCategories}
          onSort={handleClicksSort} SortIcon={SortIcon}
          onPageChange={(p) => loadClicks(p)}
        />
      )}
      {tab === 'merchants' && <MerchantsTab overview={overview} />}
      {tab === 'runs' && <RunsTab overview={overview} statusColors={statusColors} />}
    </div>
  );
}

// ─── Overview Tab ──────────────────────────────────────

function OverviewTab({ overview, statusColors }) {
  if (!overview) return null;

  const { scraperStats, clickStats, clickTrend, topClicked, positionDistribution } = overview;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard label="Prodotti Monitorati" value={parseInt(scraperStats?.scraper_products || 0).toLocaleString()} color="blue" />
        <KPICard label="Competitor Totali" value={parseInt(scraperStats?.scraper_merchants || 0).toLocaleString()} color="purple" />
        <KPICard
          label="Click Totali (ultimo giorno)"
          value={clickStats ? parseInt(clickStats.total_clicks || 0).toLocaleString() : 'N/D'}
          sub={clickStats?.fetch_date ? `Data: ${clickStats.fetch_date}` : ''}
          color="green"
        />
        <KPICard
          label="Prodotti con Click"
          value={clickStats ? parseInt(clickStats.products_with_clicks || 0).toLocaleString() : 'N/D'}
          sub={clickStats ? `Media: ${parseFloat(clickStats.avg_clicks || 0).toFixed(1)} click/prodotto` : ''}
          color="orange"
        />
      </div>

      {/* Position Distribution */}
      {positionDistribution && positionDistribution.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Distribuzione Posizioni ({overview.sellerName})</h3>
          <div className="flex gap-3">
            {positionDistribution.map((p, i) => {
              const colors = ['bg-green-500', 'bg-green-400', 'bg-yellow-400', 'bg-orange-400', 'bg-red-400'];
              const total = positionDistribution.reduce((s, x) => s + parseInt(x.count), 0);
              const pct = total > 0 ? ((parseInt(p.count) / total) * 100).toFixed(1) : 0;
              return (
                <div key={i} className="flex-1 text-center">
                  <div className="text-xs text-gray-500 mb-1">Pos. {p.position_range}</div>
                  <div className={`${colors[i] || 'bg-gray-400'} text-white rounded-lg py-3 text-lg font-bold`}>
                    {parseInt(p.count).toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">{pct}%</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Click Trend Chart (simple bar chart) */}
      {clickTrend && clickTrend.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Trend Click Ultimi 30 Giorni</h3>
          <div className="flex items-end gap-1 h-32">
            {clickTrend.map((day, i) => {
              const maxClicks = Math.max(...clickTrend.map(d => parseInt(d.total_clicks)));
              const height = maxClicks > 0 ? (parseInt(day.total_clicks) / maxClicks) * 100 : 0;
              return (
                <div key={i} className="flex-1 flex flex-col items-center" title={`${day.fetch_date}: ${parseInt(day.total_clicks).toLocaleString()} click`}>
                  <div
                    className="w-full bg-brand-400 rounded-t hover:bg-brand-500 transition-colors min-h-[2px]"
                    style={{ height: `${height}%` }}
                  ></div>
                  {i % 5 === 0 && (
                    <div className="text-[9px] text-gray-400 mt-1 -rotate-45 origin-left whitespace-nowrap">
                      {day.fetch_date.slice(5)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Clicked Products */}
      {topClicked && topClicked.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Top 10 Prodotti per Click</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2 pl-2">#</th>
                <th className="pb-2">Codice</th>
                <th className="pb-2">Prodotto</th>
                <th className="pb-2">Categoria</th>
                <th className="pb-2 text-right">Click</th>
                <th className="pb-2 text-right">Prezzo</th>
                <th className="pb-2 text-right">Margine</th>
              </tr>
            </thead>
            <tbody>
              {topClicked.map((p, i) => (
                <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2 pl-2 text-gray-400">{i + 1}</td>
                  <td className="py-2 font-mono text-xs">{p.product_code}</td>
                  <td className="py-2 truncate max-w-[200px]" title={p.product_name}>{p.product_name}</td>
                  <td className="py-2 text-gray-500 text-xs truncate max-w-[120px]">{p.trovaprezzi_category}</td>
                  <td className="py-2 text-right font-semibold text-brand-600">{parseInt(p.clicks).toLocaleString()}</td>
                  <td className="py-2 text-right">{p.sell_price ? `${parseFloat(p.sell_price).toFixed(2)}` : '-'}</td>
                  <td className="py-2 text-right">
                    {p.margin_pct != null ? (
                      <span className={parseFloat(p.margin_pct) >= 15 ? 'text-green-600' : parseFloat(p.margin_pct) >= 5 ? 'text-yellow-600' : 'text-red-600'}>
                        {parseFloat(p.margin_pct).toFixed(1)}%
                      </span>
                    ) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Last Runs */}
      {overview.lastRuns && overview.lastRuns.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Ultime Esecuzioni Zombie</h3>
          <div className="space-y-2">
            {overview.lastRuns.map(run => (
              <div key={run.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div className="flex items-center gap-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[run.status] || 'bg-gray-100'}`}>
                    {run.status}
                  </span>
                  <span className="text-sm text-gray-600">{run.run_date}</span>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <span>{run.products_count} prodotti</span>
                  <span>{parseInt(run.total_clicks || 0).toLocaleString()} click</span>
                  {run.ftp_uploaded && <span className="text-green-600 text-xs">FTP OK</span>}
                  {run.error_message && <span className="text-red-500 text-xs truncate max-w-[200px]" title={run.error_message}>{run.error_message}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Clicks Tab ────────────────────────────────────────

function ClicksTab({ clicks, pagination, loading, search, setSearch, date, setDate, category, setCategory, dates, categories, onSort, SortIcon, onPageChange }) {
  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Cerca codice o nome..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border rounded-lg text-sm w-64"
        />
        <select value={date} onChange={e => setDate(e.target.value)} className="px-3 py-2 border rounded-lg text-sm">
          <option value="">Data pi recente</option>
          {dates.map(d => (
            <option key={d.fetch_date} value={d.fetch_date}>
              {d.fetch_date} ({parseInt(d.total_clicks).toLocaleString()} click)
            </option>
          ))}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} className="px-3 py-2 border rounded-lg text-sm">
          <option value="">Tutte le categorie</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-sm text-gray-500 ml-auto">
          {pagination.total.toLocaleString()} risultati
        </span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b bg-gray-50">
              <th className="px-3 py-3 cursor-pointer" onClick={() => onSort('product_code')}>
                Codice <SortIcon col="product_code" />
              </th>
              <th className="px-3 py-3 cursor-pointer" onClick={() => onSort('product_name')}>
                Prodotto <SortIcon col="product_name" />
              </th>
              <th className="px-3 py-3 cursor-pointer" onClick={() => onSort('trovaprezzi_category')}>
                Categoria <SortIcon col="trovaprezzi_category" />
              </th>
              <th className="px-3 py-3 text-right cursor-pointer" onClick={() => onSort('clicks')}>
                Click <SortIcon col="clicks" />
              </th>
              <th className="px-3 py-3 text-right">Prezzo</th>
              <th className="px-3 py-3 text-right">Margine</th>
              <th className="px-3 py-3 text-center">Pos.</th>
              <th className="px-3 py-3 text-center">Competitor</th>
              <th className="px-3 py-3 text-center">Flags</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="text-center py-8 text-gray-400">Caricamento...</td></tr>
            ) : clicks.length === 0 ? (
              <tr><td colSpan={9} className="text-center py-8 text-gray-400">Nessun dato disponibile</td></tr>
            ) : (
              clicks.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">{row.product_code}</td>
                  <td className="px-3 py-2 truncate max-w-[220px]" title={row.product_name}>{row.product_name}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs truncate max-w-[120px]">{row.trovaprezzi_category}</td>
                  <td className="px-3 py-2 text-right font-semibold text-brand-600">{parseInt(row.clicks).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{row.sell_price ? `${parseFloat(row.sell_price).toFixed(2)}` : '-'}</td>
                  <td className="px-3 py-2 text-right">
                    {row.margin_pct != null ? (
                      <span className={parseFloat(row.margin_pct) >= 15 ? 'text-green-600' : parseFloat(row.margin_pct) >= 5 ? 'text-yellow-600' : 'text-red-600'}>
                        {parseFloat(row.margin_pct).toFixed(1)}%
                      </span>
                    ) : '-'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {row.my_position ? (
                      <span className={`font-medium ${row.my_position <= 3 ? 'text-green-600' : row.my_position <= 5 ? 'text-yellow-600' : 'text-red-600'}`}>
                        #{row.my_position}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {row.competitor_count ? (
                      <span className="text-gray-600">
                        {row.competitor_count}
                        {row.scraper_best_price && (
                          <span className="text-xs ml-1 text-gray-400">({parseFloat(row.scraper_best_price).toFixed(2)})</span>
                        )}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex gap-1 justify-center">
                      {row.is_civetta && <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-800 text-[10px] rounded">CIV</span>}
                      {row.is_topsearch && <span className="px-1.5 py-0.5 bg-blue-100 text-blue-800 text-[10px] rounded">TOP</span>}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">
            Pagina {pagination.page} di {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onPageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1 border rounded text-sm disabled:opacity-50"
            >
              Precedente
            </button>
            <button
              onClick={() => onPageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1 border rounded text-sm disabled:opacity-50"
            >
              Successiva
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Merchants Tab ─────────────────────────────────────

function MerchantsTab({ overview }) {
  if (!overview?.topMerchants) return <div className="text-gray-400 text-center py-8">Nessun dato</div>;

  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b bg-gray-50">
            <th className="px-3 py-3">#</th>
            <th className="px-3 py-3">Merchant</th>
            <th className="px-3 py-3 text-right">Prodotti</th>
            <th className="px-3 py-3 text-right">Pos. Media</th>
            <th className="px-3 py-3 text-right">Prezzo Medio</th>
          </tr>
        </thead>
        <tbody>
          {overview.topMerchants.map((m, i) => {
            const isSelf = overview.sellerName && m.merchant.toLowerCase().includes(overview.sellerName.toLowerCase());
            return (
              <tr key={i} className={`border-b border-gray-100 ${isSelf ? 'bg-brand-50 font-medium' : 'hover:bg-gray-50'}`}>
                <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                <td className="px-3 py-2">
                  {m.merchant}
                  {isSelf && <span className="ml-2 px-1.5 py-0.5 bg-brand-100 text-brand-700 text-[10px] rounded font-bold">TU</span>}
                </td>
                <td className="px-3 py-2 text-right font-medium">{parseInt(m.product_count).toLocaleString()}</td>
                <td className="px-3 py-2 text-right">
                  <span className={parseFloat(m.avg_position) <= 3 ? 'text-green-600' : parseFloat(m.avg_position) <= 5 ? 'text-yellow-600' : 'text-red-600'}>
                    {parseFloat(m.avg_position).toFixed(1)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">{parseFloat(m.avg_price).toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Runs Tab ──────────────────────────────────────────

function RunsTab({ overview, statusColors }) {
  const [runs, setRuns] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api('/trovaprezzi/zombie/runs').then(data => {
      setRuns(data.runs || []);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  if (!loaded) return <div className="text-center py-8 text-gray-400">Caricamento...</div>;

  if (runs.length === 0) return <div className="text-center py-8 text-gray-400">Nessuna esecuzione registrata</div>;

  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b bg-gray-50">
            <th className="px-3 py-3">Data</th>
            <th className="px-3 py-3">Stato</th>
            <th className="px-3 py-3 text-right">Prodotti</th>
            <th className="px-3 py-3 text-right">Click Totali</th>
            <th className="px-3 py-3 text-center">FTP</th>
            <th className="px-3 py-3">Inizio</th>
            <th className="px-3 py-3">Fine</th>
            <th className="px-3 py-3">Errore</th>
          </tr>
        </thead>
        <tbody>
          {runs.map(run => (
            <tr key={run.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-2 font-medium">{run.run_date}</td>
              <td className="px-3 py-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[run.status] || 'bg-gray-100'}`}>
                  {run.status}
                </span>
              </td>
              <td className="px-3 py-2 text-right">{run.products_count}</td>
              <td className="px-3 py-2 text-right font-medium">{parseInt(run.total_clicks || 0).toLocaleString()}</td>
              <td className="px-3 py-2 text-center">
                {run.ftp_uploaded ? (
                  <span className="text-green-600 font-medium">OK</span>
                ) : (
                  <span className="text-gray-400">-</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-gray-500">
                {run.started_at ? new Date(run.started_at).toLocaleString('it-IT') : '-'}
              </td>
              <td className="px-3 py-2 text-xs text-gray-500">
                {run.completed_at ? new Date(run.completed_at).toLocaleString('it-IT') : '-'}
              </td>
              <td className="px-3 py-2 text-xs text-red-500 truncate max-w-[200px]" title={run.error_message || ''}>
                {run.error_message || '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── KPI Card ──────────────────────────────────────────

function KPICard({ label, value, sub, color }) {
  const colors = {
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    green: 'bg-green-50 border-green-200 text-green-800',
    purple: 'bg-purple-50 border-purple-200 text-purple-800',
    orange: 'bg-orange-50 border-orange-200 text-orange-800',
  };

  return (
    <div className={`rounded-lg border p-4 ${colors[color] || colors.blue}`}>
      <div className="text-xs font-medium opacity-70">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sub && <div className="text-xs mt-1 opacity-60">{sub}</div>}
    </div>
  );
}
