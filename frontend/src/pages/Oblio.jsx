import { useEffect, useState } from 'react';
import { authFetch } from '../utils/authFetch';

function api(path, opts = {}) {
  return authFetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json());
}

export default function Oblio() {
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({ total: 0, total_cost_30d: 0, cost_per_day: 0 });
  const [statusFilter, setStatusFilter] = useState('active');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const r = await api(`/oblio?status=${statusFilter}`);
      setItems(r.items || []);
      setSummary(r.summary || { total: 0, total_cost_30d: 0, cost_per_day: 0 });
    } finally { setLoading(false); }
  }

  useEffect(() => { reload(); }, [statusFilter]);

  async function exportCsv() {
    const res = await authFetch(`/api/oblio/export.csv?status=${statusFilter}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `oblio_${statusFilter}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function populate() {
    setBusy(true);
    try {
      const r = await api('/oblio/populate', { method: 'POST', body: JSON.stringify({ batchSize: 50 }) });
      alert(`Inseriti ${r.inserted} nuovi SKU. ${r.alreadyActive} già attivi esclusi.`);
      reload();
    } catch (e) { alert('Errore: ' + e.message); }
    finally { setBusy(false); }
  }

  async function checkSales() {
    setBusy(true);
    try {
      const r = await api('/oblio/check', { method: 'POST' });
      alert(`Verificati ${r.checked} SKU. Rilasciati ${r.released} (hanno venduto).`);
      reload();
    } catch (e) { alert('Errore: ' + e.message); }
    finally { setBusy(false); }
  }

  async function releaseSku(id) {
    if (!confirm('Rilasciare manualmente questo SKU dall\\'OBLIO?')) return;
    await api(`/oblio/${id}/release`, { method: 'POST' });
    reload();
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">🔒 OBLIO Cross-Tenant</h1>
      <p className="text-gray-600 mb-6">SKU burner che accumulano click su 3+ tenant senza vendere mai. Esclusi automaticamente dal feed di tutti i tenant.</p>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">SKU in OBLIO</div>
          <div className="text-3xl font-bold">{summary.total}</div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Costo 30g cumulato</div>
          <div className="text-3xl font-bold text-red-600">€{(+summary.total_cost_30d).toFixed(0)}</div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-sm text-gray-500">Costo medio/giorno</div>
          <div className="text-3xl font-bold text-orange-600">€{(+summary.cost_per_day).toFixed(0)}</div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="border rounded px-3 py-2">
          <option value="active">Attivi (in OBLIO)</option>
          <option value="released">Rilasciati</option>
        </select>
        <button onClick={exportCsv} className="bg-emerald-600 text-white px-4 py-2 rounded hover:bg-emerald-700">📥 Esporta CSV</button>
        <button onClick={populate} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">➕ Popola +50</button>
        <button onClick={checkSales} disabled={busy} className="bg-amber-600 text-white px-4 py-2 rounded hover:bg-amber-700 disabled:opacity-50">🔄 Check vendite</button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-8 text-gray-500">Caricamento...</div>
      ) : (
        <div className="bg-white rounded-lg border overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">SKU</th>
                <th className="text-left px-3 py-2 font-semibold">Nome</th>
                <th className="text-left px-3 py-2 font-semibold">Brand</th>
                <th className="text-right px-3 py-2 font-semibold">Tenant</th>
                <th className="text-right px-3 py-2 font-semibold">Click 30g</th>
                <th className="text-right px-3 py-2 font-semibold">Cost 30g</th>
                <th className="text-left px-3 py-2 font-semibold">Aggiunto</th>
                {statusFilter === 'released' && <th className="text-left px-3 py-2 font-semibold">Rilascio</th>}
                {statusFilter === 'active' && <th className="text-right px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map(r => (
                <tr key={r.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono">{r.sku}</td>
                  <td className="px-3 py-2">{r.product_name?.slice(0, 50)}</td>
                  <td className="px-3 py-2">{r.brand}</td>
                  <td className="px-3 py-2 text-right">{r.tenants_affected}</td>
                  <td className="px-3 py-2 text-right">{r.click_at_add}</td>
                  <td className="px-3 py-2 text-right text-red-600 font-semibold">€{(+r.cost_at_add).toFixed(2)}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{new Date(r.added_at).toLocaleDateString('it')}</td>
                  {statusFilter === 'released' && (
                    <td className="px-3 py-2 text-xs">
                      <div className="text-gray-500">{new Date(r.released_at).toLocaleDateString('it')}</div>
                      <div>{r.released_reason}</div>
                    </td>
                  )}
                  {statusFilter === 'active' && (
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => releaseSku(r.id)} className="text-xs text-blue-600 hover:underline">rilascia</button>
                    </td>
                  )}
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={9} className="text-center py-8 text-gray-400">Nessun SKU</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 text-xs text-gray-500">
        <div>📅 Cron giovedì 02:00 UTC: aggiunge ~50 nuovi burner</div>
        <div>🔄 Cron giornaliero 03:00 UTC: rilascia SKU che hanno venduto</div>
      </div>
    </div>
  );
}
