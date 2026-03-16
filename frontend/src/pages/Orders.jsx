import React, { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../utils/tokenManager';
import { useAuth } from '../contexts/AuthContext';

const STATUS_COLORS = {
  complete: 'bg-green-100 text-green-700',
  processing: 'bg-blue-100 text-blue-700',
  pending: 'bg-amber-100 text-amber-700',
};

const STATUS_LABELS = {
  complete: 'Completato',
  processing: 'In lavorazione',
  pending: 'In attesa',
};

export default function Orders() {
  const { effectiveTenantId } = useAuth();
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState(null);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [importStatus, setImportStatus] = useState(null);
  const [importing, setImporting] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [orderItems, setOrderItems] = useState([]);
  const [message, setMessage] = useState('');

  const loadOrders = useCallback(async (page = 1) => {
    if (!effectiveTenantId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 25 });
      if (filter) params.set('status', filter);
      if (search) params.set('search', search);

      const res = await authFetch(`/api/orders?${params}`);
      const data = await res.json();
      setOrders(data.data || []);
      setPagination(data.pagination || {});
    } catch {
      setMessage('Errore nel caricamento ordini');
    } finally {
      setLoading(false);
    }
  }, [effectiveTenantId, filter, search]);

  const loadStats = useCallback(async () => {
    if (!effectiveTenantId) return;
    try {
      const res = await authFetch('/api/orders/stats');
      const data = await res.json();
      setStats(data.stats);
    } catch {}
  }, [effectiveTenantId]);

  const loadImportStatus = useCallback(async () => {
    if (!effectiveTenantId) return;
    try {
      const res = await authFetch('/api/orders/import/status');
      const data = await res.json();
      setImportStatus(data.jobs || []);
      // Check if import is running
      const running = (data.jobs || []).find(j => j.status === 'running' || j.status === 'pending');
      setImporting(!!running);
    } catch {}
  }, [effectiveTenantId]);

  useEffect(() => {
    if (effectiveTenantId) {
      loadOrders(1);
      loadStats();
      loadImportStatus();
    }
  }, [effectiveTenantId, loadOrders, loadStats, loadImportStatus]);

  // Poll import status while importing
  useEffect(() => {
    if (!importing) return;
    const interval = setInterval(() => {
      loadImportStatus();
      loadStats();
      loadOrders(pagination.page);
    }, 5000);
    return () => clearInterval(interval);
  }, [importing]);

  async function handleImport(daysBack) {
    setImporting(true);
    setMessage('');
    try {
      const res = await authFetch('/api/orders/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysBack }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(`Import avviato (${daysBack} giorni)`);
        loadImportStatus();
      } else {
        setMessage(`Errore: ${data.error || 'Impossibile avviare import'}`);
        setImporting(false);
      }
    } catch {
      setMessage('Errore avvio import');
      setImporting(false);
    }
  }

  async function viewOrderDetail(order) {
    try {
      const res = await authFetch(`/api/orders/${order.id}`);
      const data = await res.json();
      setSelectedOrder(data.order);
      setOrderItems(data.items || []);
    } catch {
      setMessage('Errore caricamento dettaglio');
    }
  }

  function formatCurrency(val) {
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(val || 0);
  }

  function formatDate(d) {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  if (!effectiveTenantId) {
    return <div className="text-gray-400 text-center py-20">Seleziona un tenant</div>;
  }

  const runningJob = (importStatus || []).find(j => j.status === 'running');

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Ordini</h1>
          <p className="text-gray-500 mt-1">Ordini importati dall'e-commerce</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleImport(3)}
            disabled={importing}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Sync 3 giorni
          </button>
          <button
            onClick={() => handleImport(365)}
            disabled={importing}
            className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
          >
            {importing ? 'Import in corso...' : 'Import 12 mesi'}
          </button>
        </div>
      </div>

      {message && (
        <div className={`px-4 py-3 rounded-lg mb-6 text-sm ${
          message.toLowerCase().includes('errore') || message.toLowerCase().includes('error')
            ? 'bg-red-100 text-red-800 border border-red-300'
            : 'bg-green-100 text-green-800 border border-green-300'
        }`}>
          {message}
        </div>
      )}

      {/* Import progress */}
      {runningJob && (
        <div className="bg-brand-50 border border-brand-200 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="animate-spin w-5 h-5 border-2 border-brand-600 border-t-transparent rounded-full" />
            <div>
              <p className="text-sm font-medium text-brand-800">Import in corso...</p>
              <p className="text-xs text-brand-600">
                {runningJob.records_processed || 0} elaborati,{' '}
                {runningJob.records_imported || 0} nuovi,{' '}
                {runningJob.records_updated || 0} aggiornati
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats KPI */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-sm text-gray-500">Totale Ordini</div>
            <div className="text-xl font-bold text-gray-800">{parseInt(stats.total_orders).toLocaleString('it-IT')}</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-sm text-gray-500">Fatturato Prodotti</div>
            <div className="text-xl font-bold text-gray-800">{formatCurrency(stats.total_revenue)}</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-sm text-gray-500">Primo Ordine</div>
            <div className="text-sm font-medium text-gray-800">{stats.oldest_order ? new Date(stats.oldest_order).toLocaleDateString('it-IT') : '-'}</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-sm text-gray-500">Ultimo Ordine</div>
            <div className="text-sm font-medium text-gray-800">{stats.newest_order ? new Date(stats.newest_order).toLocaleDateString('it-IT') : '-'}</div>
            {stats.last_import_at && (
              <div className="text-xs text-gray-400 mt-1">Ultimo import: {formatDate(stats.last_import_at)}</div>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4 mb-4">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadOrders(1)}
          placeholder="Cerca ordine, email, cognome..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500"
        />
        <select
          value={filter}
          onChange={e => { setFilter(e.target.value); }}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
        >
          <option value="">Tutti gli stati</option>
          <option value="complete">Completati</option>
          <option value="processing">In lavorazione</option>
          <option value="pending">In attesa</option>
        </select>
        <button onClick={() => loadOrders(1)} className="px-4 py-2 text-sm bg-gray-100 rounded-lg hover:bg-gray-200">
          Cerca
        </button>
      </div>

      {/* Orders table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="text-gray-500 text-center py-12">Caricamento...</div>
        ) : orders.length === 0 ? (
          <div className="text-gray-400 text-center py-12">
            Nessun ordine trovato. Clicca "Import 12 mesi" per importare gli ordini.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Ordine</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Data</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Cliente</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Prov.</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Stato</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Totale</th>
                    <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Dettaglio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {orders.map(o => (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-800">#{o.order_number}</td>
                      <td className="px-4 py-3 text-sm text-gray-500">{formatDate(o.order_date)}</td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-gray-800">{o.customer_firstname} {o.customer_lastname}</div>
                        <div className="text-xs text-gray-400">{o.customer_email}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">{o.customer_province || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[o.order_status] || 'bg-gray-100 text-gray-700'}`}>
                          {STATUS_LABELS[o.order_status] || o.order_status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-800 text-right">{formatCurrency(o.grand_total_products)}</td>
                      <td className="px-4 py-3 text-center">
                        <button onClick={() => viewOrderDetail(o)} className="text-brand-600 hover:text-brand-700 text-sm font-medium">
                          Vedi
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
                <div className="text-sm text-gray-500">
                  {pagination.total.toLocaleString('it-IT')} ordini totali - Pagina {pagination.page} di {pagination.totalPages}
                </div>
                <div className="flex gap-2">
                  <button
                    disabled={pagination.page <= 1}
                    onClick={() => loadOrders(pagination.page - 1)}
                    className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50"
                  >
                    Precedente
                  </button>
                  <button
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => loadOrders(pagination.page + 1)}
                    className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50"
                  >
                    Successiva
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Import history */}
      {importStatus && importStatus.length > 0 && (
        <div className="mt-6 bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Storico Import</h2>
          <div className="space-y-2">
            {importStatus.slice(0, 5).map(job => (
              <div key={job.id} className="flex items-center justify-between text-sm py-2 border-b border-gray-100 last:border-0">
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${
                    job.status === 'completed' ? 'bg-green-500' :
                    job.status === 'running' ? 'bg-blue-500 animate-pulse' :
                    job.status === 'failed' ? 'bg-red-500' : 'bg-gray-400'
                  }`} />
                  <span className="text-gray-600">{formatDate(job.created_at)}</span>
                  <span className="text-gray-400">
                    {job.metadata?.daysBack ? `${job.metadata.daysBack} giorni` : ''}
                    {job.metadata?.trigger === 'cron' ? ' (auto)' : ''}
                  </span>
                </div>
                <div className="text-gray-500">
                  {job.records_processed || 0} elaborati, {job.records_imported || 0} nuovi, {job.records_updated || 0} aggiornati
                  {job.error_message && <span className="text-red-500 ml-2">{job.error_message}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Order detail modal */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setSelectedOrder(null)}>
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto m-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-800">Ordine #{selectedOrder.order_number}</h2>
              <button onClick={() => setSelectedOrder(null)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
              <div>
                <span className="text-gray-500">Cliente:</span>
                <span className="ml-2 font-medium">{selectedOrder.customer_firstname} {selectedOrder.customer_lastname}</span>
              </div>
              <div>
                <span className="text-gray-500">Email:</span>
                <span className="ml-2">{selectedOrder.customer_email}</span>
              </div>
              <div>
                <span className="text-gray-500">Provincia:</span>
                <span className="ml-2">{selectedOrder.customer_province || '-'}</span>
              </div>
              <div>
                <span className="text-gray-500">Stato:</span>
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[selectedOrder.order_status]}`}>
                  {STATUS_LABELS[selectedOrder.order_status] || selectedOrder.order_status}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Data:</span>
                <span className="ml-2">{formatDate(selectedOrder.order_date)}</span>
              </div>
              <div>
                <span className="text-gray-500">Totale Prodotti:</span>
                <span className="ml-2 font-bold text-brand-700">{formatCurrency(selectedOrder.grand_total_products)}</span>
              </div>
            </div>

            <h3 className="font-semibold text-gray-800 mb-3">Prodotti ({orderItems.length})</h3>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase">SKU</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase">Prodotto</th>
                  <th className="text-center px-3 py-2 text-xs font-medium text-gray-500 uppercase">Qtà</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-gray-500 uppercase">Prezzo</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-gray-500 uppercase">Totale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orderItems.map((item, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-gray-500 font-mono text-xs">{item.sku}</td>
                    <td className="px-3 py-2 text-gray-800">{item.product_name}</td>
                    <td className="px-3 py-2 text-center">{parseFloat(item.qty_ordered)}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(item.price)}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(item.row_total)}</td>
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
