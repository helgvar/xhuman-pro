import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authFetch } from '../utils/tokenManager';

function api(path, opts = {}) {
  return authFetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(r => r.json());
}

const fmtEur = v => v == null ? '—' : Number(v).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const fmtNum = v => v == null ? '—' : Number(v).toLocaleString('it-IT');
const fmtPct = v => v == null ? '—' : `${Number(v).toFixed(1)}%`;

function SevBadge({ s }) {
  const map = {
    red: 'bg-red-100 text-red-700 border-red-300',
    yellow: 'bg-amber-100 text-amber-700 border-amber-300',
    green: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  };
  return <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold uppercase border rounded ${map[s] || ''}`}>{s}</span>;
}

const OBJECTIVES = {
  obj_revenue_up: { label: 'Rev↑', color: 'bg-emerald-100 text-emerald-700 border-emerald-300', tip: '1. Aumenta il fatturato TP' },
  obj_cost_down: { label: 'Cost↓', color: 'bg-blue-100 text-blue-700 border-blue-300', tip: '2. Riduce il costo TP' },
  obj_mol_protect: { label: 'MOL≥20', color: 'bg-amber-100 text-amber-700 border-amber-300', tip: '3. Protegge il MOL ≥20%' },
  obj_diretto_priority: { label: 'Diretto', color: 'bg-cyan-100 text-cyan-700 border-cyan-300', tip: '4. Prioritizza sourcing ERP/farmacia' },
};

function ObjectiveBadge({ obj }) {
  const o = OBJECTIVES[obj];
  if (!o) return null;
  return (
    <span title={o.tip} className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold border rounded ${o.color}`}>
      {o.label}
    </span>
  );
}

function StatusBadge({ s }) {
  const map = {
    pending: { c: 'bg-gray-100 text-gray-700', l: 'In attesa' },
    applied: { c: 'bg-emerald-100 text-emerald-700', l: 'Applicato ✓' },
    dismissed: { c: 'bg-gray-100 text-gray-500 line-through', l: 'Ignorato' },
    superseded: { c: 'bg-gray-50 text-gray-400', l: 'Superato' },
  };
  const m = map[s] || map.pending;
  return <span className={`inline-flex px-2 py-0.5 text-[11px] font-medium rounded ${m.c}`}>{m.l}</span>;
}

function VerificationBadge({ v }) {
  if (!v) return null;
  const map = {
    pending:   { c: 'bg-gray-100 text-gray-600',     l: '⏳ Verifica pending' },
    on_track:  { c: 'bg-sky-100 text-sky-700',       l: '↗ On track' },
    success:   { c: 'bg-emerald-100 text-emerald-800', l: '✓ Confermato' },
    deviating: { c: 'bg-amber-100 text-amber-800',   l: '⚠ In deviazione' },
    failed:    { c: 'bg-red-100 text-red-800',       l: '✗ Fallito — correttivo' },
  };
  const m = map[v];
  if (!m) return null;
  return <span className={`inline-flex px-2 py-0.5 text-[11px] font-medium rounded border border-current/20 ${m.c}`}>{m.l}</span>;
}

export default function RuleOptimizer() {
  const { selectedTenant, user } = useAuth();
  const [runs, setRuns] = useState([]);
  const [recs, setRecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState('all'); // all | pending | applied | dismissed
  const [sevFilter, setSevFilter] = useState('all'); // all | red | yellow | green
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([
        api('/rule-optimizer/runs'),
        api('/rule-optimizer/recommendations'),
      ]);
      setRuns(r.runs || []);
      setRecs(c.recommendations || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, [selectedTenant?.id]);

  async function runNow() {
    setRunning(true);
    try {
      await api('/rule-optimizer/run-now', { method: 'POST', body: '{}' });
      await load();
    } catch (e) { setError(e.message); }
    setRunning(false);
  }

  async function runAll() {
    if (!confirm('Lanciare l\'analisi per TUTTI i tenant attivi? (può richiedere alcuni minuti)')) return;
    setRunning(true);
    try {
      await api('/rule-optimizer/run-all', { method: 'POST', body: '{}' });
      await load();
    } catch (e) { setError(e.message); }
    setRunning(false);
  }

  async function markApplied(id) {
    await api(`/rule-optimizer/recommendations/${id}/applied`, { method: 'POST', body: '{}' });
    await load();
  }
  async function markDismissed(id) {
    const reason = prompt('Motivo (opzionale):');
    await api(`/rule-optimizer/recommendations/${id}/dismissed`, { method: 'POST', body: JSON.stringify({ reason }) });
    await load();
  }

  // Classifica ogni recommendation in un "bucket operativo"
  // critical:    applied + verification_status='failed' → rollback urgente
  // deviating:   applied + verification_status='deviating' → osservare
  // actionable:  pending CON proposed_changes concreti (ha qualcosa da applicare)
  // monitor:     pending senza proposta concreta (info, no bottoni)
  // success:     applied + verification ok / on_track / nullo recente
  // dismissed:   ignorate
  // Restituisce l'azione PRECISA per una rec, o null se non c'e' azione concreta.
  function getAction(r) {
    const pc = r.proposed_changes || {};
    // Blocchi: niente azione proponibile
    if (pc.economic_blocked) return null;
    if (pc.mol_blocked) return null;
    // Azioni concrete (in ordine di preferenza)
    if (pc.markup_to != null && pc.markup_from != null) {
      return { type: 'markup', label: `Cambia markup da ${pc.markup_from}% a ${pc.markup_to}%`, target: pc.markup_to };
    }
    if (pc.tolerance_to != null && pc.tolerance_from != null) {
      return { type: 'tolerance', label: `Alza tolleranza da ${pc.tolerance_from}% a ${pc.tolerance_to}%`, target: pc.tolerance_to };
    }
    if (pc.window_to != null && pc.window_to_from != null) {
      return { type: 'window', label: `Restringi finestra da 0-${pc.window_to_from} a 0-${pc.window_to}`, target: pc.window_to };
    }
    // Lo split da solo NON e' un'azione applicabile con click (serve creare nuova regola FB)
    return null;
  }
  // Verifica se un'azione simile e' stata gia' applicata di recente (< 7gg)
  function actionAlreadyApplied(r) {
    const action = getAction(r);
    if (!action) return false;
    const prior = r.metrics?.prior_actions || [];
    return prior.some(p => {
      const s = String(p.summary || '').toLowerCase();
      if (action.type === 'markup' && s.includes('markup')) return s.includes(`${action.target}%`);
      if (action.type === 'tolerance' && s.includes('tolleranza')) return s.includes(`${action.target}%`);
      if (action.type === 'window' && s.includes('finestra')) return s.includes(`0-${action.target}`);
      return false;
    });
  }
  function categorize(r) {
    if (r.status === 'dismissed') return 'dismissed';
    if (r.status === 'applied') {
      if (r.verification_status === 'failed') return 'critical';
      if (r.verification_status === 'deviating') return 'deviating';
      return 'success';
    }
    if (r.status === 'pending') {
      const action = getAction(r);
      if (!action) return 'monitor';              // niente di concreto da applicare
      if (actionAlreadyApplied(r)) return 'monitor'; // gia' fatta recentemente, ridondante
      return 'actionable';
    }
    return 'monitor';
  }
  const grouped = recs.reduce((acc, r) => {
    const b = categorize(r);
    (acc[b] = acc[b] || []).push(r);
    return acc;
  }, {});
  const buckets = {
    critical:   grouped.critical || [],
    deviating:  grouped.deviating || [],
    actionable: grouped.actionable || [],
    monitor:    grouped.monitor || [],
    success:    grouped.success || [],
    dismissed:  grouped.dismissed || [],
  };
  // Filtro severity applicato dopo (solo per le pending actionable/monitor)
  const passSev = r => sevFilter === 'all' || r.severity === sevFilter;

  const isSuperadmin = user?.role === 'superadmin';

  // Render della card singola in 4 blocchi: A·Analisi / B·Problema / C·Proposta / D·Atteso
  // + E·Risultato effettivo (solo se applied + verificato)
  function renderRecCard(r, opts = {}) {
    const showActions = opts.showActions !== false;
    const isExp = !!expanded[r.id];
    const m = r.metrics || {};
    const pc = r.proposed_changes || {};
    const ei = r.expected_impact || {};
    const action = getAction(r);
    const alreadyDone = action && actionAlreadyApplied(r);
    const verificationDays = ei.verification_window_days || m.verification_window_days || 7;
    const sevColor = r.severity === 'red' ? { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-900', accent: 'text-red-700' }
      : r.severity === 'yellow' ? { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-900', accent: 'text-amber-700' }
      : { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-900', accent: 'text-emerald-700' };

    function ProposalBlock() {
      if (r.status === 'pending' && action && !alreadyDone) {
        return (
          <div className="bg-sky-50 border border-sky-200 rounded p-3">
            <div className="text-[10px] font-bold tracking-wider text-sky-700 mb-2">C · PROPOSTA DI MODIFICA</div>
            <div className="text-sm text-sky-900 font-semibold mb-3">🎯 {action.label}</div>
            {showActions && (
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => markApplied(r.id)} className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-700">✓ Confermo modifica applicata</button>
                <button onClick={() => markDismissed(r.id)} className="px-3 py-1.5 text-xs font-medium bg-gray-200 text-gray-700 rounded hover:bg-gray-300">Ignora</button>
              </div>
            )}
          </div>
        );
      }
      if (r.status === 'pending' && action && alreadyDone) {
        return (
          <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-xs text-emerald-900">
            <div className="text-[10px] font-bold tracking-wider text-emerald-700 mb-2">C · PROPOSTA</div>
            ✓ Azione già applicata di recente ({action.label}) — nessuna ulteriore azione
          </div>
        );
      }
      if (r.status === 'pending') {
        let msg = '👁 Nessuna azione raccomandata — solo monitoraggio';
        let color = { bg: 'bg-gray-50', border: 'border-gray-200', accent: 'text-gray-500', text: 'text-gray-700' };
        if (pc.economic_blocked) msg = '🚫 Bloccata da guard economico (PnL atteso negativo) — solo monitoraggio';
        else if (pc.mol_blocked) msg = '🛡 Cut markup bloccato da guard MOL store — solo monitoraggio';
        else if (pc.sub_segment?.should_split) { msg = '💡 Suggerimento strategico: SPLIT regola da creare manualmente in Farmabooster'; color = { bg: 'bg-amber-50', border: 'border-amber-200', accent: 'text-amber-700', text: 'text-amber-900' }; }
        return (
          <div className={`${color.bg} border ${color.border} rounded p-3 text-xs ${color.text}`}>
            <div className={`text-[10px] font-bold tracking-wider ${color.accent} mb-2`}>C · PROPOSTA</div>
            {msg}
          </div>
        );
      }
      // status applied / dismissed
      return (
        <div className="bg-gray-50 border border-gray-200 rounded p-3 text-xs text-gray-700">
          <div className="text-[10px] font-bold tracking-wider text-gray-500 mb-2">C · PROPOSTA</div>
          {r.status === 'applied' && (action ? `Applicata: ${action.label}` : 'Modifica applicata')}
          {r.status === 'dismissed' && 'Proposta ignorata'}
        </div>
      );
    }

    return (
      <div key={r.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* HEADER */}
        <div className="px-5 py-3 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <SevBadge s={r.severity} />
              <StatusBadge s={r.status} />
              {r.status === 'applied' && <VerificationBadge v={r.verification_status} />}
              {m.is_topsearch_rule && <span className="text-[10px] font-bold text-cyan-700 bg-cyan-50 px-1.5 py-0.5 rounded">TOP SEARCH</span>}
              {m.rule_sourcing && m.rule_sourcing !== 'unknown' && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${m.rule_sourcing === 'diretto' ? 'text-cyan-700 bg-cyan-50' : 'text-amber-700 bg-amber-50'}`}>{m.rule_sourcing.toUpperCase()}</span>}
              {(m.objectives || []).map(o => <ObjectiveBadge key={o} obj={o} />)}
              {m.traino_count >= 5 && <span className="text-[10px] font-bold text-pink-700 bg-pink-50 border border-pink-200 px-1.5 py-0.5 rounded">🛒 {m.traino_count} TRAINI</span>}
            </div>
            <h3 className="text-sm font-semibold text-gray-900">{r.rule_name}</h3>
            {/* Timeline date: Analisi → Applicata → Verificata */}
            <div className="flex items-center gap-1 mt-1 text-[11px] text-gray-500 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                Analisi: <b className="text-gray-700">{r.created_at ? new Date(r.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'}</b>
              </span>
              {r.applied_at && (
                <>
                  <span className="text-gray-300">→</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Applicata: <b className="text-emerald-700">{new Date(r.applied_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</b>
                    {r.applied_by && r.applied_by !== 'inherited' && <span className="text-gray-400">({r.applied_by})</span>}
                    {r.applied_by === 'inherited' && <span className="text-gray-400" title="Eredità da run precedente">(eredità)</span>}
                  </span>
                </>
              )}
              {r.verified_at && r.verification_status && r.verification_status !== 'pending' && (
                <>
                  <span className="text-gray-300">→</span>
                  <span className="inline-flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${r.verification_status === 'failed' ? 'bg-red-500' : r.verification_status === 'deviating' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                    Verificata: <b className={r.verification_status === 'failed' ? 'text-red-700' : r.verification_status === 'deviating' ? 'text-amber-700' : 'text-emerald-700'}>{new Date(r.verified_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</b>
                  </span>
                </>
              )}
              {r.dismissed_at && (
                <>
                  <span className="text-gray-300">→</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                    Ignorata: <b className="text-gray-600">{new Date(r.dismissed_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</b>
                  </span>
                </>
              )}
            </div>
          </div>
          <button onClick={() => setExpanded(p => ({ ...p, [r.id]: !isExp }))} className="text-xs text-teal-600 hover:text-teal-700 flex-shrink-0">
            {isExp ? 'Meno dettaglio ▲' : 'Più dettaglio ▼'}
          </button>
        </div>

        {/* GRID A B C D */}
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* A · ANALISI */}
          <div className="bg-gray-50 border border-gray-200 rounded p-3">
            <div className="text-[10px] font-bold tracking-wider text-gray-500 mb-2">A · ANALISI (ultimi 30gg)</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="SKU" value={fmtNum(m.skus_total)} />
              <Stat label="Click" value={fmtNum(m.total_clicks)} />
              <Stat label="Costo TP" value={fmtEur(m.cost)} accent="text-red-600" />
              <Stat label="Revenue" value={fmtEur(m.total_revenue)} accent="text-emerald-700" />
              <Stat label="Incidenza" value={m.incidence_pct != null ? m.incidence_pct + '%' : '—'} accent={m.incidence_pct == null ? '' : m.incidence_pct <= 15 ? 'text-emerald-600' : m.incidence_pct <= 25 ? 'text-amber-600' : 'text-red-600'} />
              <Stat label="Conv" value={m.conv_pct != null ? m.conv_pct + '%' : '—'} />
              <Stat label="Pos media" value={m.avg_position != null ? m.avg_position.toFixed(1) : '—'} />
              <Stat label="Markup" value={m.nominal_markup_pct != null ? m.nominal_markup_pct + '%' : '—'} />
            </div>
          </div>

          {/* B · PROBLEMA */}
          <div className={`border rounded p-3 ${sevColor.bg} ${sevColor.border}`}>
            <div className={`text-[10px] font-bold tracking-wider mb-2 ${sevColor.accent}`}>B · PROBLEMA</div>
            <div className={`text-sm leading-relaxed ${sevColor.text}`}>
              {m.problem_summary || 'Regola in salute, monitorare'}
            </div>
          </div>

          {/* C · PROPOSTA */}
          <ProposalBlock />

          {/* D · ATTESO */}
          {(ei.cost_delta_eur != null || ei.revenue_delta_eur != null) ? (
            <div className="bg-teal-50 border border-teal-200 rounded p-3">
              <div className="text-[10px] font-bold tracking-wider text-teal-700 mb-2">D · RISULTATO ATTESO (entro {verificationDays}gg)</div>
              <div className="grid grid-cols-2 gap-2 text-xs text-teal-900">
                {ei.cost_delta_eur != null && <div><span className="opacity-70">Δ costo TP:</span> <b className={ei.cost_delta_eur < 0 ? 'text-emerald-700' : 'text-red-700'}>{ei.cost_delta_eur < 0 ? '−' : '+'}{fmtEur(Math.abs(ei.cost_delta_eur))}</b></div>}
                {ei.revenue_delta_eur != null && <div><span className="opacity-70">Δ revenue:</span> <b className={ei.revenue_delta_eur >= 0 ? 'text-emerald-700' : 'text-red-700'}>{ei.revenue_delta_eur >= 0 ? '+' : '−'}{fmtEur(Math.abs(ei.revenue_delta_eur))}</b></div>}
                {ei.incidence_delta_pct != null && <div><span className="opacity-70">Δ incidenza:</span> <b>{ei.incidence_delta_pct >= 0 ? '+' : ''}{ei.incidence_delta_pct}pp</b></div>}
                {pc.net_pnl_eur != null && <div><span className="opacity-70">Net PnL:</span> <b className={pc.net_pnl_eur > 0 ? 'text-emerald-700' : 'text-red-700'}>{pc.net_pnl_eur > 0 ? '+' : '−'}{fmtEur(Math.abs(pc.net_pnl_eur))}</b></div>}
              </div>
              <div className="text-[10px] text-teal-700 mt-2 opacity-80">Il sistema verifica automaticamente l'andamento dopo l'applicazione.</div>
            </div>
          ) : (
            <div className="bg-gray-50 border border-gray-200 rounded p-3 text-xs text-gray-500">
              <div className="text-[10px] font-bold tracking-wider text-gray-500 mb-1">D · RISULTATO ATTESO</div>
              Nessuna stima quantitativa disponibile
            </div>
          )}
        </div>

        {/* E · RISULTATO EFFETTIVO (solo applied + verificato) */}
        {r.status === 'applied' && r.verification_status && r.actual_impact && (() => {
          const ai = r.actual_impact || {};
          const v = r.verification_status;
          const isFailed = v === 'failed';
          const isDeviating = v === 'deviating';
          const isOk = v === 'success' || v === 'on_track';
          const isPending = v === 'pending';
          const bg = isFailed ? 'bg-red-50 border-red-300 text-red-900'
            : isDeviating ? 'bg-amber-50 border-amber-300 text-amber-900'
            : isOk ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
            : 'bg-gray-50 border-gray-200 text-gray-700';
          const accent = isFailed ? 'text-red-700' : isDeviating ? 'text-amber-700' : isOk ? 'text-emerald-700' : 'text-gray-500';
          return (
            <div className={`mx-5 mb-5 border rounded p-3 ${bg}`}>
              <div className={`text-[10px] font-bold tracking-wider mb-2 ${accent}`}>E · RISULTATO EFFETTIVO ({ai.window_days || '—'}gg post-apply)</div>
              <div className="text-sm font-semibold mb-2">
                {isFailed && '✗ FALLITO — correttivo proposto'}
                {isDeviating && '⚠ In deviazione dalle attese — osservare'}
                {isOk && '✓ In linea con le attese'}
                {isPending && '⏳ Verifica in corso (servono almeno 3gg)'}
              </div>
              {!isPending && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mb-2">
                    <div><span className="opacity-70">Δ costo reale:</span> <b>{ai.cost_delta_eur != null ? (ai.cost_delta_eur >= 0 ? '+' : '') + ai.cost_delta_eur.toFixed(0) + '€' : '—'}</b>{ei.cost_delta_eur != null && <span className="opacity-60 text-[10px] block">atteso {ei.cost_delta_eur >= 0 ? '+' : ''}{ei.cost_delta_eur.toFixed(0)}€</span>}</div>
                    <div><span className="opacity-70">Δ revenue reale:</span> <b>{ai.revenue_delta_eur != null ? (ai.revenue_delta_eur >= 0 ? '+' : '') + ai.revenue_delta_eur.toFixed(0) + '€' : '—'}</b>{ei.revenue_delta_eur != null && <span className="opacity-60 text-[10px] block">atteso {ei.revenue_delta_eur >= 0 ? '+' : ''}{ei.revenue_delta_eur.toFixed(0)}€</span>}</div>
                    <div><span className="opacity-70">Δ click:</span> <b>{ai.clicks_delta_pct != null ? (ai.clicks_delta_pct >= 0 ? '+' : '') + ai.clicks_delta_pct + '%' : '—'}</b></div>
                    <div><span className="opacity-70">Δ ordini:</span> <b>{ai.orders_delta_pct != null ? (ai.orders_delta_pct >= 0 ? '+' : '') + ai.orders_delta_pct + '%' : '—'}</b></div>
                    <div className="col-span-2"><span className="opacity-70">Incidenza pre → post:</span> <b>{ai.incidence_pre_pct != null ? ai.incidence_pre_pct + '%' : '—'} → {ai.incidence_post_pct != null ? ai.incidence_post_pct + '%' : '—'}</b></div>
                    <div className="col-span-2"><span className="opacity-70">Periodo:</span> <span className="text-[10px]">{ai.pre?.from} → {ai.pre?.to} vs {ai.post?.from} → {ai.post?.to}</span></div>
                  </div>
                  {r.correction_proposed && (
                    <div className={`mt-2 p-2 rounded ${isFailed ? 'bg-red-100' : isDeviating ? 'bg-amber-100' : 'bg-white/40'}`}>
                      <b>{isFailed ? '🔧 Azione correttiva:' : isDeviating ? '👁 Note:' : 'ℹ️'}</b> {r.correction_proposed}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {/* Modifiche già applicate (storico) */}
        {Array.isArray(m.prior_actions) && m.prior_actions.length > 0 && r.status !== 'applied' && (
          <div className="mx-5 mb-3 px-3 py-2 bg-emerald-50 border border-emerald-100 rounded text-[11px] text-emerald-900">
            ✓ <b>Modifiche già applicate su questa regola:</b>{' '}
            {m.prior_actions.map((a, i) => (
              <span key={i}>{i > 0 && ' · '}<span className="font-medium">{a.summary}</span> <span className="text-emerald-700">({a.date})</span></span>
            ))}
          </div>
        )}

        {/* Dettaglio espanso (testo lungo originale) */}
        {isExp && (
          <div className="mx-5 mb-5 p-3 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
            <div className="text-[10px] font-bold tracking-wider text-gray-500 mb-2">DETTAGLIO COMPLETO (testo analisi)</div>
            {r.recommendation}
          </div>
        )}
      </div>
    );
  }

  // Renderer accordion sezione
  function Section({ id, title, count, sub, color, items, defaultOpen, showActions }) {
    const [open, setOpen] = useState(defaultOpen !== false);
    const filtered = items.filter(passSev);
    if (items.length === 0) return null;
    return (
      <div className={`rounded-xl border ${color.border} overflow-hidden`}>
        <button onClick={() => setOpen(o => !o)} className={`w-full px-5 py-3 ${color.bg} flex items-center justify-between gap-3`}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`text-lg font-bold ${color.text}`}>{title}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full bg-white/60 ${color.text} font-semibold`}>{count}</span>
            {sub && <span className={`text-xs ${color.text} opacity-80`}>{sub}</span>}
          </div>
          <span className={`text-xs ${color.text}`}>{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <div className="p-3 space-y-3 bg-gray-50/30">
            {filtered.length === 0
              ? <div className="text-center text-gray-400 text-xs py-4">Nessun elemento con il filtro severity attivo</div>
              : filtered.map(r => renderRecCard(r, { showActions }))}
          </div>
        )}
      </div>
    );
  }

  function SectionedList({ buckets }) {
    return (
      <div className="space-y-3">
        <Section id="critical" title="🚨 Da rivedere subito" count={buckets.critical.length}
          sub="Applicate ma fallite — proposto correttivo"
          color={{ bg: 'bg-red-100', text: 'text-red-900', border: 'border-red-300' }}
          items={buckets.critical} defaultOpen={true} showActions={false} />
        <Section id="deviating" title="⚠ In deviazione" count={buckets.deviating.length}
          sub="Applicate, andamento non in linea con le attese — osservare 7gg"
          color={{ bg: 'bg-amber-100', text: 'text-amber-900', border: 'border-amber-300' }}
          items={buckets.deviating} defaultOpen={true} showActions={false} />
        <Section id="actionable" title="🎯 Proposte da decidere" count={buckets.actionable.length}
          sub="Proposte con azione concreta da applicare o ignorare"
          color={{ bg: 'bg-sky-100', text: 'text-sky-900', border: 'border-sky-300' }}
          items={buckets.actionable} defaultOpen={true} showActions={true} />
        <Section id="success" title="✓ Funzionano" count={buckets.success.length}
          sub="Applicate e in linea con le attese — nessuna azione"
          color={{ bg: 'bg-emerald-100', text: 'text-emerald-900', border: 'border-emerald-300' }}
          items={buckets.success} defaultOpen={false} showActions={false} />
        <Section id="monitor" title="👁 Solo info" count={buckets.monitor.length}
          sub="Regole in salute o senza azioni concrete — nessun bottone Applica"
          color={{ bg: 'bg-gray-100', text: 'text-gray-700', border: 'border-gray-300' }}
          items={buckets.monitor} defaultOpen={false} showActions={false} />
        <Section id="dismissed" title="🗑 Ignorate" count={buckets.dismissed.length}
          sub="Proposte scartate manualmente"
          color={{ bg: 'bg-gray-100', text: 'text-gray-500', border: 'border-gray-200' }}
          items={buckets.dismissed} defaultOpen={false} showActions={false} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Rule Optimizer</h1>
          <p className="text-sm text-gray-500 mt-1">
            Analisi settimanale delle regole prezzo Farmabooster · Tenant: <b>{selectedTenant?.name}</b>
            <br />
            Solo analisi: l'applicazione delle modifiche resta manuale dal pannello Farmabooster.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={runNow}
            disabled={running}
            className="px-3 py-1.5 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50">
            {running ? 'Analisi in corso...' : 'Analizza ora'}
          </button>
          {isSuperadmin && (
            <button
              onClick={runAll}
              disabled={running}
              className="px-3 py-1.5 text-sm font-medium bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
              Analizza TUTTI
            </button>
          )}
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded">Errore: {error}</div>}

      {/* Legenda obiettivi strategici */}
      <div className="bg-gradient-to-r from-teal-50 to-cyan-50 border border-teal-200 rounded-lg p-3 text-xs">
        <span className="font-semibold text-gray-700 mr-2">Obiettivi strategici:</span>
        {Object.entries(OBJECTIVES).map(([k, o]) => (
          <span key={k} className="inline-flex items-center gap-1 mr-3">
            <ObjectiveBadge obj={k} />
            <span className="text-gray-600">{o.tip}</span>
          </span>
        ))}
      </div>

      {/* ALERT STORE (banner store-wide: trend MOL e/o esposizione TP allargata) */}
      {(() => {
        const sample = recs.find(r => r.metrics?.mol_drop_alert);
        if (!sample) return null;
        const m = sample.metrics;
        return (
          <div className="bg-red-50 border border-red-300 rounded-lg p-4 text-sm text-red-900 leading-relaxed">
            <div className="font-semibold mb-1">🚨 Alert store</div>
            <div className="mb-2 space-y-1">
              {m.mol_trend_alert && (
                <div>📉 <b>Trend MOL in calo</b>: {m.store_mol_prev30d_pct}% (30-60gg fa) → <b>{m.store_mol_pct}%</b> (ultimi 30gg) = <b>{m.store_mol_trend_pp >= 0 ? '+' : ''}{m.store_mol_trend_pp}pp</b></div>
              )}
              {m.tp_exposure_alert && (
                <div>📦 <b>Esposizione TP allargata</b>: P10 costo SKU civetta = <b>€{m.tp_min_cost_p10_eur}</b> (min €{m.tp_min_cost_abs_eur}, {m.n_civetta_skus} SKU). Sotto €6 il margine assoluto e' eroso dalla spedizione.</div>
              )}
            </div>
            <div className="text-xs">
              <b>Verifica PRIMA il contesto business</b>: 1) Filtro costo minimo TP cambiato? (€10 restrittivo, €6 bilanciato, €3 aggressivo); 2) cambio sourcing automatico Diretto→Grossista; 3) promozioni/sconti recenti; 4) aumento costi grossisti.
              {' '}<i>Le proposte di cut markup sono BLOCCATE finche' la causa non e' identificata.</i>
            </div>
          </div>
        );
      })()}

      {/* Counters operativi (5 fasce by bucket) */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Counter label="🚨 Da rivedere" value={buckets.critical.length} accent="text-red-700" />
        <Counter label="⚠ In deviazione" value={buckets.deviating.length} accent="text-amber-700" />
        <Counter label="🎯 Da decidere" value={buckets.actionable.length} accent="text-sky-700" />
        <Counter label="✓ Funzionano" value={buckets.success.length} accent="text-emerald-700" />
        <Counter label="👁 Solo info" value={buckets.monitor.length} accent="text-gray-500" />
      </div>

      {/* Filtro severity (vale solo per actionable+monitor) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500 uppercase">Severity:</span>
        {[['all', 'Tutte'], ['red', '🔴 red'], ['yellow', '🟡 yellow'], ['green', '🟢 green']].map(([k, l]) => (
          <button key={k} onClick={() => setSevFilter(k)}
            className={`px-2.5 py-1 text-xs rounded-full ${sevFilter === k ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600'}`}>{l}</button>
        ))}
        <span className="ml-auto text-xs text-gray-400">{recs.length} totali</span>
      </div>

      {/* Lista per sezione operativa */}
      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-teal-500" /></div>
      ) : recs.length === 0 ? (
        <div className="text-center text-gray-400 py-12 bg-white rounded-lg border border-gray-200">
          Nessuna raccomandazione · esegui "Analizza ora" per partire
        </div>
      ) : (
        <SectionedList
          buckets={buckets}
          passSev={passSev}
          renderRow={(r) => renderRecCard(r)}
        />
      )}


      {/* Storico run */}
      {runs.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Storico esecuzioni</h2>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs">
              <tr>
                <th className="px-3 py-2 text-left">Data</th>
                <th className="px-3 py-2 text-right">Regole</th>
                <th className="px-3 py-2 text-right">Racc.</th>
                <th className="px-3 py-2 text-right">🔴</th>
                <th className="px-3 py-2 text-right">🟡</th>
                <th className="px-3 py-2 text-right">🟢</th>
                <th className="px-3 py-2 text-right">Durata</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">{new Date(r.run_date).toLocaleDateString('it-IT')} <span className="text-xs text-gray-400">{new Date(r.started_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span></td>
                  <td className="px-3 py-2 text-right">{r.rules_analyzed}</td>
                  <td className="px-3 py-2 text-right font-medium">{r.recommendations_count}</td>
                  <td className="px-3 py-2 text-right text-red-600">{r.red_count}</td>
                  <td className="px-3 py-2 text-right text-amber-600">{r.yellow_count}</td>
                  <td className="px-3 py-2 text-right text-emerald-600">{r.green_count}</td>
                  <td className="px-3 py-2 text-right text-gray-400">{r.duration_ms}ms</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Counter({ label, value, accent, onClick }) {
  return (
    <button onClick={onClick} className="bg-white border border-gray-200 rounded-lg p-3 text-left hover:border-teal-300 transition">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent || 'text-gray-900'}`}>{value}</div>
    </button>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
      <div className={`text-sm font-semibold ${accent || 'text-gray-900'}`}>{value}</div>
    </div>
  );
}
