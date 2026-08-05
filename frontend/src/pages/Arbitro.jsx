import React, { useEffect, useState } from 'react';
import { authFetch } from '../utils/tokenManager';

function api(path, opts = {}) {
  return authFetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json());
}

const OP_STYLE = {
  veto_arbitro: { badge: 'bg-red-100 text-red-800 border border-red-300', label: '🛡️ VETO', row: 'bg-red-50' },
  neutralizza: { badge: 'bg-amber-100 text-amber-800', label: 'neutralizza', row: '' },
  modifica: { badge: 'bg-blue-100 text-blue-800', label: 'modifica', row: '' },
  delete: { badge: 'bg-slate-200 text-slate-700', label: 'delete', row: '' },
};

const HOURS_OPTS = [
  { v: 6, label: '6 ore' },
  { v: 24, label: '24 ore' },
  { v: 72, label: '3 giorni' },
  { v: 168, label: '7 giorni' },
];

function Card({ title, value, sub, tone = 'text-gray-900' }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{title}</div>
      <div className={`text-2xl font-bold ${tone}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

export default function Arbitro() {
  const [hours, setHours] = useState(24);
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [writers, setWriters] = useState([]);
  const [fTenant, setFTenant] = useState('tutti');
  const [fWriter, setFWriter] = useState('tutti');
  const [fOp, setFOp] = useState('tutte');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);        // 'writer|operazione'
  const [detail, setDetail] = useState({});              // chiave -> righe
  const [detailLoading, setDetailLoading] = useState(false);

  const toggleDetail = (writer, operazione) => {
    const key = `${writer}|${operazione}`;
    if (expanded === key) { setExpanded(null); return; }
    setExpanded(key);
    if (!detail[key]) {
      setDetailLoading(true);
      api(`/arbitro/log?hours=${hours}&writer=${encodeURIComponent(writer)}&operazione=${encodeURIComponent(operazione)}&limit=500`)
        .then(r => setDetail(d => ({ ...d, [key]: r.items || [] })))
        .finally(() => setDetailLoading(false));
    }
  };

  useEffect(() => {
    api('/tenants').then(r => setTenants(r.tenants || r.items || r || []));
    api('/arbitro/writers').then(r => setWriters(r.items || []));
  }, []);

  useEffect(() => {
    api(`/arbitro/summary?hours=${hours}`).then(setSummary);
  }, [hours]);

  useEffect(() => {
    setLoading(true);
    api(`/arbitro/log?hours=${hours}&tenant_id=${fTenant}&writer=${fWriter}&operazione=${fOp}&limit=300`)
      .then(r => setItems(r.items || []))
      .finally(() => setLoading(false));
  }, [hours, fTenant, fWriter, fOp]);

  const tot = summary?.totali || {};
  const ars = summary?.arsenale || {};

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">
            ⚖️ Arbitro delle Azioni
            {summary?.tenant && (
              <span className="ml-3 align-middle text-sm px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 font-semibold">
                {summary.tenant}
              </span>
            )}
          </h1>
          <p className="text-sm text-gray-500">
            L'ultimo che scrive non vince più: ogni tocco ai prezzi raccomandati è a verbale.
            {summary?.tenant
              ? ` Stai vedendo solo le azioni di ${summary.tenant} (tenant selezionato in alto).`
              : ' Vista RETE: seleziona un tenant dalla barra in alto per vedere solo le sue azioni.'}
          </p>
        </div>
        <select className="border rounded-lg px-3 py-2 text-sm" value={hours}
          onChange={e => setHours(+e.target.value)}>
          {HOURS_OPTS.map(o => <option key={o.v} value={o.v}>Ultime {o.label}</option>)}
        </select>
      </div>

      {/* Contatori */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-4">
        <Card title="Tocchi a verbale" value={tot.tocchi ?? '—'} sub={`ultime ${hours}h`} />
        <Card title="🛡️ Veti (fuoco amico bloccato)" value={tot.veti ?? '—'}
          tone={tot.veti > 0 ? 'text-red-600' : 'text-emerald-600'} sub={tot.veti > 0 ? 'falciate anonime respinte' : 'nessun attacco anonimo'} />
        <Card title="Neutralizzazioni firmate" value={tot.neutralizzate ?? '—'} sub="ritiri con motivo legale" />
        <Card title="Modifiche" value={tot.modifiche ?? '—'} sub="prezzi ricalcolati" />
        <Card title="Delete" value={tot.delete ?? '—'} sub="righe rimosse (sempre permesso)" />
        <Card title="Tocchi anonimi" value={tot.anonimi ?? '—'}
          tone={tot.anonimi > 0 ? 'text-amber-600' : 'text-emerald-600'} sub="da identificare e firmare" />
      </div>

      {/* Arsenale protetto */}
      <div className="grid grid-cols-3 gap-3 mt-3">
        <Card title="Arsenale PC vivi" value={ars.pc_vivi ?? '—'} sub="recommended attivi adesso" />
        <Card title="di cui manuali/sessione" value={ars.pc_manuali ?? '—'} sub="protetti dal veto arbitro" tone="text-emerald-700" />
        <Card title="Scavalchi muro" value={ars.scavalchi ?? '—'} sub="protetti dai rewrite di massa" />
      </div>

      {/* Classifica scrittori — click sulla riga = dettaglio prodotto per prodotto */}
      <div className="bg-white rounded-xl shadow-sm border p-4 mt-4">
        <h2 className="font-semibold mb-1">Chi ha toccato cosa (ultime {hours}h)</h2>
        <p className="text-xs text-gray-400 mb-2">Clicca su una riga per vedere prodotto per prodotto cosa ha fatto</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-500 border-b">
              <th className="py-1 pr-4"></th>
              <th className="py-1 pr-4">Scrittore</th><th className="py-1 pr-4">Operazione</th>
              <th className="py-1 pr-4">Tocchi</th><th className="py-1">Ultimo</th>
            </tr></thead>
            <tbody>
              {(summary?.scrittori || []).map((s, i) => {
                const key = `${s.writer}|${s.operazione}`;
                const open = expanded === key;
                const rows = detail[key] || [];
                return (
                  <React.Fragment key={i}>
                    <tr className={`border-b last:border-0 cursor-pointer hover:bg-gray-50 ${open ? 'bg-gray-50' : ''}`}
                        onClick={() => toggleDetail(s.writer, s.operazione)}>
                      <td className="py-1.5 pr-2 text-gray-400 w-5">{open ? '▼' : '▶'}</td>
                      <td className={`py-1.5 pr-4 font-mono text-xs ${s.writer === 'anonimo' ? 'text-amber-600 font-bold' : ''}`}>{s.writer}</td>
                      <td className="py-1.5 pr-4">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${(OP_STYLE[s.operazione] || {}).badge || 'bg-gray-100'}`}>
                          {(OP_STYLE[s.operazione] || {}).label || s.operazione}
                        </span>
                      </td>
                      <td className="py-1.5 pr-4 font-semibold">{s.n}</td>
                      <td className="py-1.5 text-gray-500 text-xs">{new Date(s.ultimo).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    </tr>
                    {open && (
                      <tr className="border-b last:border-0">
                        <td colSpan="5" className="bg-gray-50 px-3 pb-3 pt-1">
                          {detailLoading && rows.length === 0 ? (
                            <div className="text-gray-400 py-3 text-center text-xs">Carico il dettaglio…</div>
                          ) : (
                            <div className="overflow-x-auto max-h-96 overflow-y-auto border rounded-lg bg-white">
                              <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-gray-100">
                                  <tr className="text-left text-gray-500">
                                    <th className="py-1.5 px-2">Ora</th><th className="py-1.5 px-2">Tenant</th>
                                    <th className="py-1.5 px-2">SKU</th><th className="py-1.5 px-2">Prodotto</th>
                                    <th className="py-1.5 px-2">Prima → Dopo</th><th className="py-1.5 px-2">Sorgente</th>
                                    <th className="py-1.5 px-2">Motivo</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rows.map(l => (
                                    <tr key={l.id} className={`border-t ${(OP_STYLE[l.operazione] || {}).row}`}>
                                      <td className="py-1 px-2 text-gray-500 whitespace-nowrap">
                                        {new Date(l.touched_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                      </td>
                                      <td className="py-1 px-2">{l.tenant_name || '—'}</td>
                                      <td className="py-1 px-2 font-mono">{l.sku}</td>
                                      <td className="py-1 px-2 max-w-xs truncate" title={l.product_name || ''}>{l.product_name || '—'}</td>
                                      <td className="py-1 px-2 font-mono whitespace-nowrap">
                                        {l.old_value ? `€${l.old_value}` : '—'} → {l.new_value && !String(l.new_value).startsWith('NULL') ? `€${l.new_value}` : (l.new_value || 'NULL')}
                                      </td>
                                      <td className="py-1 px-2 text-gray-500">{l.action_source || '—'}</td>
                                      <td className="py-1 px-2 text-gray-600 max-w-sm truncate" title={l.motivo || ''}>{l.motivo || '—'}</td>
                                    </tr>
                                  ))}
                                  {rows.length === 0 && !detailLoading && (
                                    <tr><td colSpan="7" className="py-3 text-center text-gray-400">Nessun dettaglio nel periodo</td></tr>
                                  )}
                                </tbody>
                              </table>
                              {rows.length >= 500 && (
                                <div className="text-center text-gray-400 text-xs py-1 border-t">Mostro i primi 500 — usa il verbale sotto coi filtri per il resto</div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {(summary?.scrittori || []).length === 0 && (
                <tr><td colSpan="5" className="py-4 text-center text-gray-400">Nessun tocco nel periodo</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Verbale */}
      <div className="bg-white rounded-xl shadow-sm border p-4 mt-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold">📜 Il verbale</h2>
          <div className="flex gap-2 flex-wrap">
            {!summary?.tenant && (
              <select className="border rounded-lg px-2 py-1.5 text-sm" value={fTenant} onChange={e => setFTenant(e.target.value)}>
                <option value="tutti">Tutti i tenant</option>
                {(Array.isArray(tenants) ? tenants : []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            <select className="border rounded-lg px-2 py-1.5 text-sm" value={fWriter} onChange={e => setFWriter(e.target.value)}>
              <option value="tutti">Tutti gli scrittori</option>
              {writers.map(w => <option key={w.writer} value={w.writer}>{w.writer} ({w.n})</option>)}
            </select>
            <select className="border rounded-lg px-2 py-1.5 text-sm" value={fOp} onChange={e => setFOp(e.target.value)}>
              <option value="tutte">Tutte le operazioni</option>
              <option value="veto_arbitro">🛡️ Veti</option>
              <option value="neutralizza">Neutralizzazioni</option>
              <option value="modifica">Modifiche</option>
              <option value="delete">Delete</option>
            </select>
          </div>
        </div>
        {loading ? (
          <div className="text-gray-400 py-8 text-center">Caricamento…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 border-b">
                <th className="py-1 pr-3">Quando</th><th className="py-1 pr-3">Tenant</th>
                <th className="py-1 pr-3">SKU</th><th className="py-1 pr-3">Op</th>
                <th className="py-1 pr-3">Prima → Dopo</th><th className="py-1 pr-3">Scrittore</th>
                <th className="py-1 pr-3">Sorgente</th><th className="py-1">Motivo</th>
              </tr></thead>
              <tbody>
                {items.map(l => (
                  <tr key={l.id} className={`border-b last:border-0 ${(OP_STYLE[l.operazione] || {}).row}`}>
                    <td className="py-1.5 pr-3 text-xs text-gray-500 whitespace-nowrap">
                      {new Date(l.touched_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="py-1.5 pr-3 text-xs">{l.tenant_name || '—'}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs" title={l.product_name || ''}>{l.sku}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${(OP_STYLE[l.operazione] || {}).badge || 'bg-gray-100'}`}>
                        {(OP_STYLE[l.operazione] || {}).label || l.operazione}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap">
                      {l.old_value ? `€${l.old_value}` : '—'} → {l.new_value && !l.new_value.startsWith('NULL') ? `€${l.new_value}` : (l.new_value || 'NULL')}
                    </td>
                    <td className={`py-1.5 pr-3 font-mono text-xs ${l.writer === 'anonimo' ? 'text-amber-600 font-bold' : ''}`}>{l.writer}</td>
                    <td className="py-1.5 pr-3 text-xs text-gray-500">{l.action_source || '—'}</td>
                    <td className="py-1.5 text-xs text-gray-600 max-w-xs truncate" title={l.motivo || ''}>{l.motivo || '—'}</td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan="8" className="py-8 text-center text-gray-400">Nessun tocco per questi filtri</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
