import { useState } from 'react';
import { authFetch } from '../utils/tokenManager';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

// Colori per grossista (niente viola/indaco/porpora)
const COLORS = ['#0d7d74', '#c26608', '#178a45', '#2358c8', '#0a7ba0', '#b1194a', '#64748b'];

export default function StoricoCosti() {
  const [sku, setSku] = useState('943008589');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function load(e) {
    if (e) e.preventDefault();
    setLoading(true); setErr(null); setData(null);
    try {
      const res = await authFetch(`/api/products/${sku.trim()}/history`);
      if (!res.ok) throw new Error('Errore ' + res.status);
      const j = await res.json();
      setData(j);
    } catch (ex) { setErr(ex.message); }
    setLoading(false);
  }

  // Pivot: una riga per data, colonne = grossisti + Prezzo
  let chart = [];
  let sources = [];
  if (data) {
    sources = [...new Set(data.cost.map((r) => r.source))].sort();
    const byDate = {};
    for (const r of data.cost) {
      byDate[r.data] = byDate[r.data] || { data: r.data };
      byDate[r.data][r.source] = Number(r.costo);
    }
    for (const r of data.price) {
      byDate[r.data] = byDate[r.data] || { data: r.data };
      byDate[r.data].Prezzo = Number(r.prezzo);
    }
    chart = Object.values(byDate).sort((a, b) => (a.data < b.data ? -1 : 1));
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>Cronologia Costi &amp; Prezzo</h1>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 0 }}>
        Storico costi per grossista + prezzo di vendita, ultimi 15 giorni. <b>Solo visualizzazione</b> — non usato da nessun loop.
      </p>

      <form onSubmit={load} style={{ margin: '14px 0 20px', display: 'flex', gap: 8 }}>
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="MINSAN (es. 943008589)"
          style={{ padding: '9px 12px', fontSize: 15, width: 220, border: '1px solid #cbd5e1', borderRadius: 8 }}
        />
        <button type="submit" style={{ padding: '9px 18px', fontSize: 15, fontWeight: 700, background: '#2358c8', color: '#fff', border: 0, borderRadius: 8, cursor: 'pointer' }}>
          Mostra
        </button>
      </form>

      {loading && <p>Caricamento…</p>}
      {err && <p style={{ color: '#d21f1f' }}>{err}</p>}
      {data && chart.length === 0 && (
        <p style={{ color: '#64748b' }}>
          Nessuno storico per <b>{data.sku}</b> nel tenant selezionato. Deve prima essere importato, o cambia tenant.
        </p>
      )}

      {chart.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
          <ResponsiveContainer width="100%" height={460}>
            <LineChart data={chart} margin={{ top: 10, right: 24, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="data" tick={{ fontSize: 11 }} />
              <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => (v == null ? '-' : '€' + Number(v).toFixed(2))} />
              <Legend />
              {sources.map((s, i) => (
                <Line key={s} type="monotone" dataKey={s} name={s} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} connectNulls />
              ))}
              <Line type="monotone" dataKey="Prezzo" name="Prezzo vendita" stroke="#111827" strokeWidth={3.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
