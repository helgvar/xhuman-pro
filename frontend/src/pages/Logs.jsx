import React, { useState, useEffect, useRef } from 'react';
import { authFetch } from '../utils/tokenManager';

function api(path) {
  return authFetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' } }).then(r => r.json());
}

const LEVEL_STYLE = {
  fatal: 'bg-red-200 text-red-900 border-red-400 font-bold',
  error: 'bg-red-100 text-red-800 border-red-300',
  warn:  'bg-amber-100 text-amber-800 border-amber-300',
  info:  'bg-blue-50 text-blue-800 border-blue-200',
  debug: 'bg-gray-100 text-gray-600 border-gray-200',
};

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug'];

function LevelBadge({ level }) {
  const cls = LEVEL_STYLE[level] || 'bg-gray-100 text-gray-700 border-gray-200';
  return <span className={`inline-block px-1.5 py-0.5 text-[10px] uppercase font-semibold border rounded ${cls}`}>{level}</span>;
}

function fmtTs(ts) {
  const d = new Date(ts);
  const t = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ago = (Date.now() - d.getTime()) / 1000;
  let agoLabel;
  if (ago < 60) agoLabel = `${Math.round(ago)}s fa`;
  else if (ago < 3600) agoLabel = `${Math.round(ago / 60)}m fa`;
  else if (ago < 86400) agoLabel = `${Math.round(ago / 3600)}h fa`;
  else agoLabel = `${Math.round(ago / 86400)}gg fa`;
  return { t, agoLabel };
}

function RowDetail({ row, onClose }) {
  return (
    <tr className="bg-gray-50">
      <td colSpan={5} className="px-3 py-2 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="font-semibold text-gray-700">Trace ID</div>
            <div className="font-mono">{row.trace_id || '—'}</div>
          </div>
          <div>
            <div className="font-semibold text-gray-700">Hostname / uptime</div>
            <div className="font-mono">{row.hostname || '—'} · {row.process_uptime_sec}s</div>
          </div>
        </div>
        {row.payload && (
          <>
            <div className="mt-2 font-semibold text-gray-700">Payload</div>
            <pre className="bg-white border border-gray-200 rounded p-2 text-[11px] overflow-x-auto max-h-64">{JSON.stringify(row.payload, null, 2)}</pre>
          </>
        )}
        {row.stack && (
          <>
            <div className="mt-2 font-semibold text-gray-700">Stack</div>
            <pre className="bg-gray-900 text-gray-100 rounded p-2 text-[11px] overflow-x-auto max-h-80 font-mono whitespace-pre-wrap">{row.stack}</pre>
          </>
        )}
      </td>
    </tr>
  );
}

export default function Logs() {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [sources, setSources] = useState([]);
  const [filters, setFilters] = useState({ level: 'fatal,error,warn', source: '', q: '', limit: 200 });
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openRow, setOpenRow] = useState(null);
  const refreshTimer = useRef(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (filters.level) qs.set('level', filters.level);
      if (filters.source) qs.set('source', filters.source);
      if (filters.q) qs.set('q', filters.q);
      qs.set('limit', filters.limit);
      const [r, s, src] = await Promise.all([
        api(`/logs?${qs}`),
        api(`/logs/summary`),
        api(`/logs/sources`),
      ]);
      if (r.error) throw new Error(r.error);
      setRows(r.rows || []);
      setSummary(s);
      setSources(src.sources || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters.level, filters.source, filters.q, filters.limit]);

  useEffect(() => {
    if (autoRefresh) {
      refreshTimer.current = setInterval(load, 10000);
      return () => clearInterval(refreshTimer.current);
    }
    /* eslint-disable-next-line */
  }, [autoRefresh, filters]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Logs</h1>
          <p className="text-sm text-gray-500 mt-0.5">Eventi strutturati persistenti (ultimi 30gg)</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            Auto-refresh 10s
          </label>
          <button onClick={load} disabled={loading} className="px-3 py-1 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50">
            {loading ? '…' : 'Aggiorna'}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded px-3 py-2 text-sm">{error}</div>}

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {LEVELS.map(lvl => {
            const found = summary.levels.find(x => x.level === lvl);
            return (
              <div key={lvl} className={`bg-white border rounded-lg p-3 ${found && lvl === 'fatal' ? 'border-red-400' : 'border-gray-200'}`}>
                <div className="text-xs text-gray-500 uppercase"><LevelBadge level={lvl} /></div>
                <div className="text-2xl font-bold text-gray-900 mt-1">{found?.count || 0}</div>
                <div className="text-[10px] text-gray-400">ultime 24h</div>
              </div>
            );
          })}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-3 flex flex-wrap gap-2 items-end">
        <div>
          <label className="text-[10px] text-gray-500 uppercase block">Level</label>
          <select value={filters.level} onChange={e => setFilters(f => ({ ...f, level: e.target.value }))} className="border border-gray-300 rounded px-2 py-1 text-sm">
            <option value="fatal,error,warn">fatal+error+warn</option>
            <option value="fatal">fatal</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="">tutti</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-gray-500 uppercase block">Source</label>
          <select value={filters.source} onChange={e => setFilters(f => ({ ...f, source: e.target.value }))} className="border border-gray-300 rounded px-2 py-1 text-sm min-w-32">
            <option value="">tutti</option>
            {sources.map(s => <option key={s.source} value={s.source}>{s.source} ({s.n})</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-48">
          <label className="text-[10px] text-gray-500 uppercase block">Ricerca testo</label>
          <input value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))} placeholder="message o stack..." className="border border-gray-300 rounded px-2 py-1 text-sm w-full" />
        </div>
        <div>
          <label className="text-[10px] text-gray-500 uppercase block">Limit</label>
          <select value={filters.limit} onChange={e => setFilters(f => ({ ...f, limit: +e.target.value }))} className="border border-gray-300 rounded px-2 py-1 text-sm">
            {[100,200,500,1000,2000].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {summary && summary.top_error_sources?.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
          <div className="font-semibold text-red-800 mb-1">Top source errori ultime 24h</div>
          <div className="flex flex-wrap gap-1">
            {summary.top_error_sources.map((s, i) => (
              <button key={i} onClick={() => setFilters(f => ({ ...f, source: s.source }))} className="px-2 py-0.5 bg-white border border-red-300 rounded text-red-700 hover:bg-red-100">
                {s.source || '—'}: <b>{s.count}</b> <LevelBadge level={s.level} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left w-24">Quando</th>
              <th className="px-3 py-2 text-left w-20">Level</th>
              <th className="px-3 py-2 text-left w-32">Source</th>
              <th className="px-3 py-2 text-left">Messaggio</th>
              <th className="px-3 py-2 text-right w-12"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center">
                  <div className="text-gray-500 text-sm font-medium">Nessun log con il filtro corrente</div>
                  <div className="text-gray-400 text-xs mt-1">
                    {filters.level === 'fatal,error,warn'
                      ? <>Stato sano per il filtro <code>fatal+error+warn</code> ultime 24h. Per vedere anche i log info, cambia il filtro <strong>Level</strong> in alto.</>
                      : <>Prova ad allargare i filtri (rimuovi Source/Ricerca, scegli Level "tutti", aumenta Limit).</>}
                  </div>
                  {filters.level === 'fatal,error,warn' && (
                    <button
                      onClick={() => setFilters(f => ({ ...f, level: 'info' }))}
                      className="mt-3 px-3 py-1 text-xs bg-brand-600 text-white rounded hover:bg-brand-700"
                    >
                      Mostra log info ultime 24h
                    </button>
                  )}
                </td>
              </tr>
            )}
            {rows.map(r => {
              const { t, agoLabel } = fmtTs(r.ts);
              const isOpen = openRow === r.id;
              return (
                <React.Fragment key={r.id}>
                  <tr onClick={() => setOpenRow(isOpen ? null : r.id)}
                      className={`border-t border-gray-100 cursor-pointer hover:bg-gray-50 ${r.level === 'fatal' ? 'bg-red-50' : ''}`}>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-mono">{t}</div>
                      <div className="text-gray-400 text-[10px]">{agoLabel}</div>
                    </td>
                    <td className="px-3 py-2"><LevelBadge level={r.level} /></td>
                    <td className="px-3 py-2 text-xs font-mono text-gray-700">{r.source || '—'}</td>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-medium">{r.message}</div>
                      {r.stack && !isOpen && <div className="text-[10px] text-red-600 mt-0.5">stack disponibile (click)</div>}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-400">{isOpen ? '▼' : '▶'}</td>
                  </tr>
                  {isOpen && <RowDetail row={r} onClose={() => setOpenRow(null)} />}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
