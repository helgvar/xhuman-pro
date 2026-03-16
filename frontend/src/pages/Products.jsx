import React, { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../utils/tokenManager';
import { useAuth } from '../contexts/AuthContext';

const EXPORT_STATUS = {
  '1': { label: 'Nuovo', color: 'bg-gray-100 text-gray-700' },
  '2': { label: 'Esportabile', color: 'bg-yellow-100 text-yellow-700' },
  '3': { label: 'Esportato', color: 'bg-green-100 text-green-700' },
  '4': { label: 'Da Verificare', color: 'bg-orange-100 text-orange-700' },
  '5': { label: 'Non Esportabile', color: 'bg-red-100 text-red-700' },
};

const getExportStatus = (code) => EXPORT_STATUS[String(code)] || { label: code || '-', color: 'bg-gray-100 text-gray-500' };

export default function Products() {
  const { effectiveTenantId } = useAuth();
  const [products, setProducts] = useState([]);
  const [stats, setStats] = useState(null);
  const [rules, setRules] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCivetta, setFilterCivetta] = useState(false);
  const [filterTopSearch, setFilterTopSearch] = useState(false);
  const [filterStock, setFilterStock] = useState('instock');
  const [filterExport, setFilterExport] = useState('3');
  const [filterPriceRule, setFilterPriceRule] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterSaleable, setFilterSaleable] = useState('');
  const [filterMarginMin, setFilterMarginMin] = useState('');
  const [filterMarginMax, setFilterMarginMax] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [sortBy, setSortBy] = useState('updated_at');
  const [sortDir, setSortDir] = useState('desc');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null); // { pct, phase_label, records_processed, ... }
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('success');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [competitors, setCompetitors] = useState([]);
  const [loadingCompetitors, setLoadingCompetitors] = useState(false);
  const [showShipping, setShowShipping] = useState(false);
  const [tab, setTab] = useState('products');
  const pollRef = useRef(null);

  const showMessage = (msg, type = 'success') => {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(''), 5000);
  };

  const loadProducts = useCallback(async (page = 1) => {
    if (!effectiveTenantId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 25, sortBy, sortDir });
      if (search) params.set('search', search);
      if (filterCivetta) params.set('civetta', 'true');
      if (filterTopSearch) params.set('topsearch', 'true');
      if (filterStock) params.set('stock', filterStock);
      if (filterExport) params.set('export_status', filterExport);
      if (filterPriceRule) params.set('price_rule_id', filterPriceRule);
      if (filterBrand) params.set('brand', filterBrand);
      if (filterSaleable) params.set('saleable', filterSaleable);
      if (filterMarginMin) params.set('margin_min', filterMarginMin);
      if (filterMarginMax) params.set('margin_max', filterMarginMax);
      if (filterCategory) params.set('category', filterCategory);

      const res = await authFetch(`/api/products?${params}`);
      const data = await res.json();
      setProducts(data.data || []);
      setPagination(data.pagination || {});
    } catch {
      showMessage('Errore nel caricamento prodotti', 'error');
    } finally {
      setLoading(false);
    }
  }, [effectiveTenantId, search, filterCivetta, filterTopSearch, filterStock, filterExport, filterPriceRule, filterBrand, filterSaleable, filterMarginMin, filterMarginMax, filterCategory, sortBy, sortDir]);

  const loadStats = useCallback(async () => {
    if (!effectiveTenantId) return;
    try {
      const res = await authFetch('/api/products/stats');
      const data = await res.json();
      setStats(data.stats);
    } catch {}
  }, [effectiveTenantId]);

  const loadRules = useCallback(async () => {
    if (!effectiveTenantId) return;
    try {
      const res = await authFetch('/api/products/rules');
      const data = await res.json();
      setRules(data.rules || []);
    } catch {}
  }, [effectiveTenantId]);

  const loadFilterOptions = useCallback(async () => {
    if (!effectiveTenantId) return;
    try {
      const [catRes, brandRes, rulesRes] = await Promise.all([
        authFetch('/api/products/categories'),
        authFetch('/api/products/brands'),
        authFetch('/api/products/rules'),
      ]);
      const catData = await catRes.json();
      const brandData = await brandRes.json();
      const rulesData = await rulesRes.json();
      setCategories(catData.categories || []);
      setBrands(brandData.brands || []);
      setRules(rulesData.rules || []);
    } catch {}
  }, [effectiveTenantId]);

  // Check for running import on mount
  const checkRunningImport = useCallback(async () => {
    if (!effectiveTenantId) return;
    try {
      const res = await authFetch('/api/products/import/status');
      const data = await res.json();
      const latest = data.jobs?.[0];
      if (latest && (latest.status === 'pending' || latest.status === 'running')) {
        setImporting(true);
        setImportProgress(latest.metadata || null);
        startPolling();
      }
    } catch {}
  }, [effectiveTenantId]);

  const startPolling = () => {
    if (pollRef.current) return; // already polling
    pollRef.current = setInterval(async () => {
      try {
        const res = await authFetch('/api/products/import/status');
        const data = await res.json();
        const latest = data.jobs?.[0];
        if (!latest) return;

        if (latest.status === 'running' || latest.status === 'pending') {
          setImportProgress(latest.metadata || null);
        } else if (latest.status === 'completed') {
          stopPolling();
          setImporting(false);
          setImportProgress(null);
          showMessage(`Import completato: ${latest.records_imported || 0} nuovi, ${latest.records_updated || 0} aggiornati`);
          loadProducts();
          loadStats();
        } else if (latest.status === 'failed') {
          stopPolling();
          setImporting(false);
          setImportProgress(null);
          showMessage(`Import fallito: ${latest.error_message}`, 'error');
        }
      } catch {
        stopPolling();
        setImporting(false);
        setImportProgress(null);
      }
    }, 3000);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    loadProducts();
    loadStats();
    loadFilterOptions();
    checkRunningImport();
    return () => stopPolling();
  }, [loadProducts, loadStats, loadFilterOptions, checkRunningImport]);

  useEffect(() => { if (tab === 'rules') loadRules(); }, [tab, loadRules]);

  const handleImport = async () => {
    if (importing) return;
    setImporting(true);
    setImportProgress({ pct: 0, phase_label: 'Avvio import...' });
    try {
      const res = await authFetch('/api/products/import', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        startPolling();
      } else {
        showMessage(data.error || 'Errore avvio import', 'error');
        setImporting(false);
        setImportProgress(null);
      }
    } catch {
      showMessage('Errore di rete', 'error');
      setImporting(false);
      setImportProgress(null);
    }
  };

  const openProductDetail = async (product) => {
    setSelectedProduct(product);
    setCompetitors([]);
    setLoadingCompetitors(true);
    setShowShipping(false);
    try {
      const res = await authFetch(`/api/products/${product.id}`);
      const data = await res.json();
      setCompetitors(data.competitors || []);
      if (data.product) setSelectedProduct(data.product);
    } catch {}
    setLoadingCompetitors(false);
  };

  const handleSort = (col) => {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const SortIcon = ({ col }) => {
    if (sortBy !== col) return <span className="text-gray-300 ml-1">&#8597;</span>;
    return <span className="text-brand-500 ml-1">{sortDir === 'asc' ? '&#8593;' : '&#8595;'}</span>;
  };

  const fmt = (n) => parseFloat(n || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInt = (n) => parseInt(n || 0).toLocaleString('it-IT');

  const formatDate = (d) => {
    if (!d) return '-';
    const date = new Date(d);
    return date.toLocaleDateString('it-IT') + ' ' + date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Prodotti</h1>
          <p className="text-gray-500 mt-1">Catalogo prodotti e regole prezzo da Farmabooster</p>
        </div>
        <button
          onClick={handleImport}
          disabled={importing}
          className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-2"
        >
          {importing ? (
            <>
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Importazione in corso...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Importa Prodotti
            </>
          )}
        </button>
      </div>

      {/* Import progress bar */}
      {importing && importProgress && (
        <div className="mb-6 bg-white rounded-xl border border-blue-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <svg className="animate-spin w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-sm font-medium text-blue-800">
                {importProgress.phase_label || 'Import in corso...'}
              </span>
            </div>
            <span className="text-sm font-bold text-blue-600">{importProgress.pct || 0}%</span>
          </div>
          <div className="w-full bg-blue-100 rounded-full h-3">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.max(2, importProgress.pct || 0)}%` }}
            />
          </div>
          {(importProgress.records_processed > 0 || importProgress.total_products > 0) && (
            <div className="flex gap-4 mt-2 text-xs text-gray-500">
              {importProgress.total_products > 0 && (
                <span>Totale: {fmtInt(importProgress.total_products)} prodotti</span>
              )}
              {importProgress.records_processed > 0 && (
                <span>Salvati: {fmtInt(importProgress.records_processed)}</span>
              )}
              {importProgress.records_imported > 0 && (
                <span>Nuovi: {fmtInt(importProgress.records_imported)}</span>
              )}
              {importProgress.records_updated > 0 && (
                <span>Aggiornati: {fmtInt(importProgress.records_updated)}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Message */}
      {message && (
        <div className={`mb-4 px-4 py-3 rounded-lg border text-sm ${
          messageType === 'error'
            ? 'bg-red-100 text-red-800 border-red-300'
            : 'bg-green-100 text-green-800 border-green-300'
        }`}>
          {message}
        </div>
      )}

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
          <StatCard label="Totale Prodotti" value={fmtInt(stats.total_products)} />
          <StatCard label="Esportati (sul sito)" value={fmtInt(stats.exported_count)} color="text-green-600" />
          <StatCard label="Non Esportati" value={fmtInt(stats.not_exported_count)} color="text-amber-600" />
          <StatCard label="In Stock" value={fmtInt(stats.in_stock)} color="text-green-600" />
          <StatCard label="Civetta" value={fmtInt(stats.civetta_count)} color="text-yellow-600" />
          <StatCard label="TopSearch" value={fmtInt(stats.topsearch_count)} color="text-blue-600" />
          <StatCard
            label="Ultimo Import"
            value={stats.last_import_at ? formatDate(stats.last_import_at) : 'Mai'}
            small
          />
        </div>
      )}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <StatCard label="Margine Medio" value={`${fmt(stats.avg_margin_pct)}%`} color="text-amber-600" />
          <StatCard label="Venduti 30gg (globale)" value={fmtInt(stats.total_sales_30d)} color="text-green-600" />
          <StatCard label="Vendibili" value={fmtInt(stats.saleable_count)} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        <button
          onClick={() => setTab('products')}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            tab === 'products' ? 'bg-white text-brand-600 border border-b-0 border-gray-200' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Catalogo Prodotti
        </button>
        <button
          onClick={() => setTab('rules')}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            tab === 'rules' ? 'bg-white text-brand-600 border border-b-0 border-gray-200' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Regole Prezzo ({rules.length})
        </button>
      </div>

      {tab === 'products' && (
        <div className="bg-white rounded-xl border border-gray-200">
          {/* Filters */}
          <div className="p-4 border-b border-gray-100">
            <div className="flex flex-wrap gap-3 items-center">
              <input
                type="text"
                placeholder="Cerca SKU, nome, EAN, brand..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && loadProducts(1)}
                className="flex-1 min-w-[200px] px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500"
              />
              <label className="flex items-center gap-1.5 text-sm font-medium text-yellow-700 cursor-pointer bg-yellow-50 px-3 py-2 rounded-lg border border-yellow-300">
                <input type="checkbox" checked={filterCivetta} onChange={e => setFilterCivetta(e.target.checked)}
                  className="rounded text-yellow-600 focus:ring-yellow-500" />
                Civetta
              </label>
              <label className="flex items-center gap-1.5 text-sm font-medium text-blue-700 cursor-pointer bg-blue-50 px-3 py-2 rounded-lg border border-blue-200">
                <input type="checkbox" checked={filterTopSearch} onChange={e => setFilterTopSearch(e.target.checked)}
                  className="rounded text-blue-600 focus:ring-blue-500" />
                TopSearch
              </label>
              <select value={filterStock} onChange={e => setFilterStock(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500">
                <option value="">Tutti stock</option>
                <option value="instock">In stock</option>
                <option value="outofstock">Esauriti</option>
              </select>
              <select value={filterExport} onChange={e => setFilterExport(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500">
                <option value="">Tutti stati</option>
                <option value="1">Nuovo</option>
                <option value="2">Esportabile</option>
                <option value="3">Esportato</option>
                <option value="4">Da Verificare</option>
                <option value="5">Non Esportabile</option>
              </select>
              <button onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
                className={`px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 ${showAdvancedFilters ? 'bg-brand-100 text-brand-700 border border-brand-300' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border border-gray-200'}`}>
                <svg className={`w-4 h-4 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                Filtri avanzati
              </button>
              <button onClick={() => loadProducts(1)}
                className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700">
                Filtra
              </button>
              {pagination.total !== undefined && (
                <span className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-700">
                  {fmtInt(pagination.total)} <span className="text-gray-400 font-normal">risultati</span>
                </span>
              )}
            </div>

            {/* Advanced Filters */}
            {showAdvancedFilters && (
              <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Regola Prezzo</label>
                  <select value={filterPriceRule} onChange={e => setFilterPriceRule(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500">
                    <option value="">Tutte le regole</option>
                    {rules.map(r => (
                      <option key={r.rule_id} value={r.rule_id}>#{r.rule_id} - {r.rule_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Categoria</label>
                  <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500">
                    <option value="">Tutte le categorie</option>
                    {categories.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Brand</label>
                  <input type="text" placeholder="Filtra brand..." value={filterBrand} onChange={e => setFilterBrand(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && loadProducts(1)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Vendibile</label>
                  <select value={filterSaleable} onChange={e => setFilterSaleable(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500">
                    <option value="">Tutti</option>
                    <option value="true">Vendibile</option>
                    <option value="false">Non Vendibile</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Margine Min %</label>
                  <input type="number" step="0.01" placeholder="0" value={filterMarginMin} onChange={e => setFilterMarginMin(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Margine Max %</label>
                  <input type="number" step="0.01" placeholder="100" value={filterMarginMax} onChange={e => setFilterMarginMax(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-brand-500 focus:border-brand-500" />
                </div>
                <div className="col-span-full flex justify-end">
                  <button onClick={() => {
                    setFilterPriceRule(''); setFilterBrand(''); setFilterSaleable('');
                    setFilterMarginMin(''); setFilterMarginMax(''); setFilterCategory('');
                    setFilterCivetta(false); setFilterTopSearch(false);
                    setFilterStock(''); setFilterExport(''); setSearch('');
                  }}
                    className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded">
                    Reset tutti i filtri
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left">
                  <th className="px-4 py-3 font-medium text-gray-600 cursor-pointer" onClick={() => handleSort('sku')}>
                    SKU <SortIcon col="sku" />
                  </th>
                  <th className="px-4 py-3 font-medium text-gray-600 cursor-pointer" onClick={() => handleSort('product_name')}>
                    Prodotto <SortIcon col="product_name" />
                  </th>
                  <th className="px-4 py-3 font-medium text-gray-600 cursor-pointer text-right" onClick={() => handleSort('sell_price')}>
                    Prezzo <SortIcon col="sell_price" />
                  </th>
                  <th className="px-4 py-3 font-medium text-gray-600 cursor-pointer text-right" onClick={() => handleSort('erp_cost')}>
                    Costo <SortIcon col="erp_cost" />
                  </th>
                  <th className="px-4 py-3 font-medium text-gray-600 cursor-pointer text-right" onClick={() => handleSort('margin_pct')}>
                    Margine <SortIcon col="margin_pct" />
                  </th>
                  <th className="px-4 py-3 font-medium text-gray-600 cursor-pointer text-right" onClick={() => handleSort('sales_30d_seller')}>
                    Vend. Seller <SortIcon col="sales_30d_seller" />
                  </th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-right">
                    Vend. Globale
                  </th>
                  <th className="px-4 py-3 font-medium text-gray-600 cursor-pointer text-right" onClick={() => handleSort('erp_stock')}>
                    Stock <SortIcon col="erp_stock" />
                  </th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-center">Competitor</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Regola Prezzo</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-center">Stato</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-center">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan="12" className="text-center py-12 text-gray-400">Caricamento...</td></tr>
                ) : products.length === 0 ? (
                  <tr><td colSpan="12" className="text-center py-12 text-gray-400">Nessun prodotto trovato</td></tr>
                ) : products.map(p => (
                  <tr key={p.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => openProductDetail(p)}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.sku}</td>
                    <td className="px-4 py-3 max-w-[300px]">
                      <div className="truncate font-medium text-gray-800">{p.product_name}</div>
                      {p.brand && <div className="text-xs text-gray-400 truncate">{p.brand}</div>}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{fmt(p.sell_price)}</td>
                    <td className="px-4 py-3 text-right text-gray-500">{fmt(p.erp_cost)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={parseFloat(p.margin_pct) > 20 ? 'text-green-600' : parseFloat(p.margin_pct) > 10 ? 'text-amber-600' : 'text-red-600'}>
                        {fmt(p.margin_pct)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">{fmtInt(p.sales_30d_seller)}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{fmtInt(p.sales_30d_aggregated)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={parseInt(p.erp_stock) > 0 ? 'text-green-600' : 'text-red-500'}>
                        {fmtInt(p.erp_stock)}
                      </span>
                      {parseInt(p.supplier_stock) > 0 && (
                        <span className="text-xs text-blue-500 ml-1">(+{fmtInt(p.supplier_stock)})</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {parseInt(p.competitor_count) > 0 ? (
                        <div>
                          <span className="text-sm font-medium text-gray-700">{fmtInt(p.competitor_count)}</span>
                          {parseFloat(p.scraper_best_price) > 0 && (
                            <div className={`text-xs ${parseFloat(p.scraper_best_price) < parseFloat(p.sell_price) ? 'text-red-500' : 'text-green-600'}`}>
                              {fmt(p.scraper_best_price)}
                            </div>
                          )}
                        </div>
                      ) : <span className="text-gray-300">-</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 max-w-[150px] truncate">
                      {p.price_rule_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {(() => { const es = getExportStatus(p.export_status); return (
                        <span className={`inline-block px-2 py-0.5 text-xs rounded ${es.color}`}>{es.label}</span>
                      ); })()}
                    </td>
                    <td className="px-4 py-3 text-center space-x-1">
                      {p.is_civetta && <span className="inline-block px-1.5 py-0.5 text-xs bg-yellow-100 text-yellow-700 rounded">C</span>}
                      {p.is_topsearch && <span className="inline-block px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">TS</span>}
                      {p.is_topkey && <span className="inline-block px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">TK</span>}
                      {!p.saleable && <span className="inline-block px-1.5 py-0.5 text-xs bg-red-100 text-red-700 rounded">NS</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
              <span className="text-sm text-gray-500">
                {fmtInt(pagination.total)} prodotti - Pagina {pagination.page} di {pagination.totalPages}
              </span>
              <div className="flex gap-2">
                <button onClick={() => loadProducts(pagination.page - 1)} disabled={pagination.page <= 1}
                  className="px-3 py-1 border border-gray-300 rounded text-sm disabled:opacity-30 hover:bg-gray-50">
                  Prec
                </button>
                <button onClick={() => loadProducts(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages}
                  className="px-3 py-1 border border-gray-300 rounded text-sm disabled:opacity-30 hover:bg-gray-50">
                  Succ
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Price Rules Tab */}
      {tab === 'rules' && (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left">
                  <th className="px-4 py-3 font-medium text-gray-600">ID</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Regola</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Tipo</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-right">Ricarico %</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-right">Fascia Costo</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-right">Pos. Scraper</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-right">Prodotti</th>
                  <th className="px-4 py-3 font-medium text-gray-600 text-center">Priorità</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Stato</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rules.length === 0 ? (
                  <tr><td colSpan="9" className="text-center py-12 text-gray-400">Nessuna regola prezzo trovata. Importa i prodotti per caricare le regole.</td></tr>
                ) : rules.map(r => {
                  const rData = r.rule_data || {};
                  const typeLabels = { diretto: 'Diretto', sconto: 'Sconto', salva_bilancio: 'Salva Bilancio', muro: 'Muro' };
                  const typeColors = { diretto: 'bg-blue-100 text-blue-700', sconto: 'bg-purple-100 text-purple-700', salva_bilancio: 'bg-amber-100 text-amber-700', muro: 'bg-red-100 text-red-700' };
                  return (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-xs text-gray-400">#{r.rule_id}</td>
                      <td className="px-4 py-3 font-medium text-gray-800">{r.rule_name}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs ${typeColors[r.rule_type] || 'bg-gray-100 text-gray-600'}`}>
                          {typeLabels[r.rule_type] || r.rule_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {rData.recharge_pct > 0 ? `+${fmt(rData.recharge_pct)}%` : ''}
                        {rData.discount_pct > 0 ? <span className="text-red-600 ml-1">-{fmt(rData.discount_pct)}%</span> : ''}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-gray-500">
                        {rData.from_cost !== undefined ? `€${fmt(rData.from_cost)} - €${fmt(rData.to_cost)}` : '-'}
                      </td>
                      <td className="px-4 py-3 text-right">{rData.scraper_position || '-'}</td>
                      <td className="px-4 py-3 text-right font-medium">{fmtInt(r.product_count)}</td>
                      <td className="px-4 py-3 text-center text-gray-500">{r.priority}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs ${r.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {r.is_active ? 'Attiva' : 'Inattiva'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Product detail modal */}
      {selectedProduct && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => { setSelectedProduct(null); setCompetitors([]); }}>
          <div className="bg-white rounded-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-800">{selectedProduct.product_name}</h2>
                <p className="text-sm text-gray-500 font-mono">{selectedProduct.sku}</p>
              </div>
              <button onClick={() => { setSelectedProduct(null); setCompetitors([]); }} className="text-gray-400 hover:text-gray-600">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Detail label="Brand" value={selectedProduct.brand} />
                <Detail label="Produttore" value={selectedProduct.manufacturer} />
                <Detail label="EAN" value={selectedProduct.ean} />
                <Detail label="Categoria" value={selectedProduct.category} />
              </div>
              <hr className="border-gray-100" />
              <div className="grid grid-cols-3 gap-4">
                <Detail label="Prezzo Vendita" value={`€ ${fmt(selectedProduct.sell_price)}`} />
                <Detail label="Costo ERP" value={`€ ${fmt(selectedProduct.erp_cost)}`} />
                <Detail label="Prezzo Rif." value={`€ ${fmt(selectedProduct.reference_price)}`} />
                <Detail label="Margine" value={`€ ${fmt(selectedProduct.margin)}`} />
                <Detail label="Margine %" value={`${fmt(selectedProduct.margin_pct)}%`} />
                <Detail label="Markup" value={`${fmt(selectedProduct.markup)}%`} />
              </div>
              <hr className="border-gray-100" />
              <div className="grid grid-cols-3 gap-4">
                <Detail label="Stock ERP" value={fmtInt(selectedProduct.erp_stock)} />
                <Detail label="Stock Fornitore" value={fmtInt(selectedProduct.supplier_stock)} />
                <Detail label="Venduti 30gg (seller)" value={`${fmtInt(selectedProduct.sales_30d_seller)} pz`} />
                <Detail label="Venduti 30gg (globale)" value={`${fmtInt(selectedProduct.sales_30d_aggregated)} pz`} />
                <Detail label="Pos. Scraper" value={selectedProduct.scraper_position || '-'} />
                <Detail label="Regola Prezzo" value={selectedProduct.price_rule_name ? `#${selectedProduct.price_rule_id} - ${selectedProduct.price_rule_name}` : '-'} />
              </div>
              <hr className="border-gray-100" />
              <div className="flex flex-wrap gap-2">
                {(() => { const es = getExportStatus(selectedProduct.export_status); return (
                  <span className={`px-2 py-1 text-xs rounded-full ${es.color}`}>{es.label}</span>
                ); })()}
                {selectedProduct.is_civetta && <span className="px-2 py-1 text-xs bg-yellow-100 text-yellow-700 rounded-full">Civetta</span>}
                {selectedProduct.is_topsearch && <span className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded-full">TopSearch</span>}
                {selectedProduct.is_topkey && <span className="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded-full">TopKey</span>}
                {selectedProduct.saleable && <span className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded-full">Vendibile</span>}
                {!selectedProduct.saleable && <span className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-full">Non Vendibile</span>}
                {selectedProduct.unmanage_stock && <span className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded-full">Stock non gestito</span>}
              </div>

              {/* Competitor ranking */}
              <hr className="border-gray-100" />
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-gray-700">
                    Classifica Competitor Trovaprezzi
                    {competitors.length > 0 && <span className="ml-2 text-xs font-normal text-gray-400">({competitors.length} merchant)</span>}
                  </h3>
                  {competitors.length > 0 && (
                    <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                      <input type="checkbox" checked={showShipping} onChange={e => setShowShipping(e.target.checked)}
                        className="rounded text-brand-600 focus:ring-brand-500" />
                      Mostra spedizione
                    </label>
                  )}
                </div>
                {loadingCompetitors ? (
                  <div className="text-center py-4 text-gray-400 text-sm">Caricamento competitor...</div>
                ) : competitors.length === 0 ? (
                  <div className="text-center py-4 text-gray-400 text-sm">Nessun dato competitor disponibile</div>
                ) : (
                  <div className="overflow-x-auto max-h-[300px] overflow-y-auto border border-gray-200 rounded-lg">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">#</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">Merchant</th>
                          <th className="px-3 py-2 text-right font-medium text-gray-500">Prezzo</th>
                          {showShipping && <th className="px-3 py-2 text-right font-medium text-gray-500">Spedizione</th>}
                          {showShipping && <th className="px-3 py-2 text-right font-medium text-gray-500">Totale</th>}
                          <th className="px-3 py-2 text-right font-medium text-gray-500">Recensioni</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {competitors.map((c, i) => {
                          const isFarmacri = c.merchant.toLowerCase().includes('farmacri');
                          const isFirst = i === 0;
                          return (
                            <tr key={`${c.merchant}-${i}`} className={`${isFarmacri ? 'bg-brand-50 font-bold' : ''} ${isFirst && !isFarmacri ? 'bg-green-50' : ''}`}>
                              <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                              <td className="px-3 py-2">
                                <span className={isFarmacri ? 'text-brand-700' : 'text-gray-700'}>{c.merchant}</span>
                                {isFarmacri && <span className="ml-1 text-[10px] bg-brand-200 text-brand-800 px-1 rounded">TU</span>}
                              </td>
                              <td className={`px-3 py-2 text-right font-mono font-medium ${isFarmacri ? 'text-brand-700' : isFirst ? 'text-green-700' : 'text-gray-800'}`}>
                                € {fmt(c.base_price)}
                              </td>
                              {showShipping && (
                                <td className="px-3 py-2 text-right font-mono text-gray-400">
                                  {parseFloat(c.shipping_cost) > 0 ? `€ ${fmt(c.shipping_cost)}` : 'Gratis'}
                                </td>
                              )}
                              {showShipping && (
                                <td className="px-3 py-2 text-right font-mono font-medium text-gray-600">
                                  € {fmt(c.total_price)}
                                </td>
                              )}
                              <td className="px-3 py-2 text-right text-gray-400">{fmtInt(c.reviews)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <p className="text-xs text-gray-400">Aggiornato: {formatDate(selectedProduct.updated_at)}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color = 'text-gray-800', small = false }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`${small ? 'text-sm' : 'text-xl'} font-bold ${color}`}>{value}</div>
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm font-medium text-gray-800 truncate">{value || '-'}</div>
    </div>
  );
}
