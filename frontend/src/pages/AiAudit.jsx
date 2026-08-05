import { useEffect, useState } from 'react';
import { authFetch } from '../utils/tokenManager';

const SEVERITY_BADGE = {
  high:   { label: 'HIGH',   classes: 'bg-red-100 text-red-700 border-red-200' },
  medium: { label: 'MEDIUM', classes: 'bg-amber-100 text-amber-700 border-amber-200' },
  low:    { label: 'LOW',    classes: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
};

const CATEGORY_ICON = {
  spesa: '💸', fatturato: '📈', conversion: '🎯',
  killer: '☠️', magazzino: '📦', briglie: '⚙️',
};

function api(path, opts = {}) {
  return authFetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => r.json());
}

export default function AiAudit() {
  const [list, setList] = useState([]);
  const [stats, setStats] = useState(null);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  async function reload() {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([
        api(`/ai-audit/suggestions?status=${statusFilter}&limit=100`),
        api('/ai-audit/stats'),
      ]);
      setList(s.suggestions || []);
      setStats(t);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, [statusFilter]);

  async function review(id, decision) {
    setBusy(id);
    try {
      await api(`/ai-audit/suggestions/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function triggerAudit() {
    setBusy('audit');
    try {
      await api('/ai-audit/run', { method: 'POST' });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function triggerAutoApply(dryRun = false) {
    setBusy('apply');
    try {
      const r = await api(`/ai-audit/auto-apply?dry_run=${dryRun ? '1' : '0'}`, { method: 'POST' });
      alert(`Auto-apply ${dryRun ? '(dry-run)' : ''}: applied=${r.applied} skipped=${r.skipped}`);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🤖 AI Audit</h1>
          <p className="text-sm text-gray-500 mt-1">
            Suggerimenti generati da Claude dopo ogni ciclo del feed engine. Tu approvi, AI esegue.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={triggerAudit} disabled={busy === 'audit'} className="px-4 py-2 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
            {busy === 'audit' ? 'Audit in corso...' : '+ Nuovo audit'}
          </button>
          <button onClick={() => triggerAutoApply(true)} disabled={busy === 'apply'} className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
            Dry-run
          </button>
          <button onClick={() => triggerAutoApply(false)} disabled={busy === 'apply'} className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
            Auto-apply
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <Card label="Pending"   value={stats.pending} color="text-amber-600" />
          <Card label="Approved"  value={stats.approved} color="text-emerald-600" />
          <Card label="Rejected"  value={stats.rejected} color="text-gray-400" />
          <Card label="Token IN"  value={Number(stats.tokens_in_total).toLocaleString()} small />
          <Card label="Token OUT" value={Number(stats.tokens_out_total).toLocaleString()} small />
        </div>
      )}

      <div className="flex gap-2 mb-4">
        {['pending','approved','rejected','applied'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
              statusFilter === s ? 'bg-gray-900 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Caricamento...</div>
      ) : list.length === 0 ? (
        <div className="text-center py-12 text-gray-400 bg-white rounded-lg border border-gray-200">
          Nessun suggerimento <span className="font-mono">{statusFilter}</span>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map(s => (
            <SuggestionCard
              key={s.id}
              s={s}
              onReview={review}
              busy={busy === s.id}
              showActions={statusFilter === 'pending'}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ label, value, color = 'text-gray-900', small }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`mt-1 ${small ? 'text-lg' : 'text-2xl'} font-bold ${color}`}>{value}</div>
    </div>
  );
}

function SuggestionCard({ s, onReview, busy, showActions }) {
  const sev = SEVERITY_BADGE[s.severity] || SEVERITY_BADGE.low;
  const actions = Array.isArray(s.suggested_actions) ? s.suggested_actions : [];
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-sm transition">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-2 py-0.5 text-xs font-semibold rounded border ${sev.classes}`}>{sev.label}</span>
            {s.tenant_name && (
              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-gray-100 text-gray-700">{s.tenant_name}</span>
            )}
            <span className="text-xs text-gray-500">{CATEGORY_ICON[s.category] || '•'} {s.category}</span>
            <span className="text-xs text-gray-400">· {new Date(s.run_at).toLocaleString('it-IT')}</span>
          </div>
          <h3 className="font-semibold text-gray-900">{s.title}</h3>
          {s.description && <p className="text-sm text-gray-600 mt-1">{s.description}</p>}
          {actions.length > 0 && (
            <div className="mt-3 space-y-1">
              {actions.map((a, i) => (
                <div key={i} className="text-xs bg-gray-50 rounded px-2 py-1 font-mono">
                  <span className="text-brand-700 font-semibold">{a.type}</span>
                  {a.target && <> · <span className="text-gray-700">{a.target}</span></>}
                  {a.params && Object.keys(a.params).length > 0 && (
                    <> · {Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(' ')}</>
                  )}
                  {a.reasoning && <div className="text-gray-500 mt-0.5 font-sans">{a.reasoning}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
        {showActions && (
          <div className="flex flex-col gap-1">
            <button onClick={() => onReview(s.id, 'approved')} disabled={busy} className="px-3 py-1.5 rounded text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              ✓ Approva
            </button>
            <button onClick={() => onReview(s.id, 'rejected')} disabled={busy} className="px-3 py-1.5 rounded text-sm bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50">
              ✗ Rigetta
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
