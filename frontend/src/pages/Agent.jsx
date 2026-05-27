import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authFetch } from '../utils/tokenManager';

async function api(path, opts = {}) {
  const resp = await authFetch(`/api${path}`, opts);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export default function Agent() {
  const { effectiveTenantId: tenantId } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState([]);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const [initialized, setInitialized] = useState(false);

  // ─── Load sessions when tenantId is ready ────────────
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;

    (async () => {
      try {
        const [sessData, rulesData] = await Promise.all([
          api('/agent/sessions'),
          api('/agent/rules'),
        ]);
        if (cancelled) return;

        const list = sessData.sessions || [];
        setSessions(list);
        setRules(rulesData.rules || []);

        // Auto-open saved session or latest
        const savedId = sessionStorage.getItem('agent_session_id');
        const target = (savedId && list.find(s => s.id === savedId)) ? savedId : list[0]?.id;
        if (target) {
          const detail = await api(`/agent/sessions/${target}`);
          if (!cancelled) {
            setActiveSessionId(target);
            setMessages(detail.messages || []);
            sessionStorage.setItem('agent_session_id', target);
          }
        }
      } catch (e) {
        console.error('Agent init error:', e);
      }
      if (!cancelled) setInitialized(true);
    })();

    return () => { cancelled = true; };
  }, [tenantId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── Open a session ──────────────────────────────────
  const openSession = async (id) => {
    try {
      const data = await api(`/agent/sessions/${id}`);
      setActiveSessionId(id);
      setMessages(data.messages || []);
      sessionStorage.setItem('agent_session_id', id);
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (e) {
      console.error('Open session error:', e);
    }
  };

  // ─── Create new session ──────────────────────────────
  const createSession = async () => {
    try {
      const session = await api('/agent/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setSessions(prev => [session, ...prev]);
      setActiveSessionId(session.id);
      setMessages([]);
      sessionStorage.setItem('agent_session_id', session.id);
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (e) {
      console.error('Create session error:', e);
    }
  };

  // ─── Send message ────────────────────────────────────
  const sendMessage = async () => {
    if (!input.trim() || loading || !activeSessionId) return;
    const msg = input.trim();
    setInput('');
    setLoading(true);

    // Optimistic: add user message
    const userMsg = { role: 'user', content: msg, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);

    try {
      const data = await api(`/agent/sessions/${activeSessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.message,
        actions_taken: data.actions,
        tokens_used: data.tokensUsed,
        model: data.model,
        tier: data.tier,
        created_at: new Date().toISOString(),
      }]);

      // Refresh sessions list (title may have changed)
      api('/agent/sessions').then(d => setSessions(d.sessions || [])).catch(() => {});
      api('/agent/rules').then(d => setRules(d.rules || [])).catch(() => {});
    } catch (e) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Errore: ${e.message}`,
        created_at: new Date().toISOString(),
      }]);
    }
    setLoading(false);
  };

  const deleteRule = async (id) => {
    if (!confirm('Rimuovere questa regola?')) return;
    try {
      await api(`/agent/rules/${id}`, { method: 'DELETE' });
      setRules(prev => prev.filter(r => r.id !== id));
    } catch {}
  };

  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'ora';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'min fa';
    if (diff < 86400000 && d.getDate() === now.getDate()) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  };

  const tierLabel = (tier) => {
    if (tier === 'fast') return { text: 'Haiku', color: 'text-green-600' };
    if (tier === 'standard') return { text: 'Sonnet', color: 'text-blue-600' };
    if (tier === 'deep') return { text: 'Opus', color: 'text-orange-600' };
    return { text: '', color: '' };
  };

  if (!initialized) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-400">Caricamento agent...</div></div>;
  }

  return (
    <div className="flex -m-6" style={{ height: 'calc(100vh - 64px)' }}>
      {/* ─── LEFT SIDEBAR: Sessions ─── */}
      <div className="w-72 bg-white border-r flex flex-col shrink-0">
        <div className="p-3 border-b">
          <button
            onClick={createSession}
            className="w-full px-3 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <span className="text-lg">+</span> Nuova chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessions.map(s => (
            <div
              key={s.id}
              onClick={() => openSession(s.id)}
              className={`px-4 py-3 cursor-pointer border-b border-gray-100 transition-colors ${
                activeSessionId === s.id
                  ? 'bg-teal-50 border-l-2 border-l-teal-500'
                  : 'hover:bg-gray-50'
              }`}
            >
              <div className="text-sm font-medium truncate text-gray-800">{s.title || 'Nuova chat'}</div>
              <div className="text-[10px] text-gray-400 mt-1 flex justify-between">
                <span>{fmtTime(s.last_message_at || s.created_at)}</span>
                {s.actions_executed > 0 && (
                  <span className="text-teal-600">{s.actions_executed} azioni</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Rules at bottom */}
        {rules.length > 0 && (
          <div className="border-t p-3 bg-gray-50">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Regole ({rules.length})</div>
            {rules.slice(0, 5).map(r => (
              <div key={r.id} className="text-xs text-gray-600 mb-1 flex justify-between items-start">
                <span className="truncate mr-1">{r.reason || r.rule_type}</span>
                <button onClick={() => deleteRule(r.id)} className="text-gray-400 hover:text-red-500 shrink-0">&times;</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── MAIN CHAT AREA ─── */}
      <div className="flex-1 flex flex-col bg-white">
        {activeSessionId ? (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto py-6 px-4 space-y-4">
                {messages.length === 0 && (
                  <div className="text-center py-20">
                    <div className="text-5xl mb-4">🤖</div>
                    <h2 className="text-xl font-semibold text-gray-700">Agent xHUMANPRO</h2>
                    <p className="text-gray-400 mt-2 text-sm max-w-md mx-auto">
                      Chiedimi qualsiasi cosa sul feed. Posso analizzare prodotti, eseguire azioni, aggiungere regole.
                    </p>
                    <div className="mt-6 flex flex-wrap gap-2 justify-center">
                      {['Stato del feed', 'Prodotti che sprecano click', 'Rimuovi i killer dal feed', 'Aggiungi regola per brand X'].map(s => (
                        <button key={s} onClick={() => { setInput(s); }} className="px-3 py-1.5 bg-gray-100 rounded-full text-xs text-gray-600 hover:bg-gray-200">
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] ${m.role === 'user' ? '' : ''}`}>
                      {m.role === 'user' ? (
                        <div className="bg-teal-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                          {m.content}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <div className="bg-gray-50 rounded-2xl rounded-bl-sm px-4 py-3 text-sm border">
                            <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: fmtMd(m.content) }} />
                          </div>
                          {/* Actions badge */}
                          {m.actions_taken && m.actions_taken.length > 0 && (
                            <div className="flex gap-1 ml-1">
                              {m.actions_taken.map((a, j) => (
                                <span key={j} className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-[10px] px-2 py-0.5 rounded-full">
                                  Eseguito: {a.input?.action} ({a.result?.count || 0})
                                </span>
                              ))}
                            </div>
                          )}
                          {/* Model tier badge */}
                          {m.tier && (
                            <div className={`text-[10px] ml-1 ${tierLabel(m.tier).color}`}>
                              {tierLabel(m.tier).text} &middot; {m.tokens_used} tok
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {loading && (
                  <div className="flex justify-start">
                    <div className="bg-gray-50 rounded-2xl rounded-bl-sm px-4 py-3 text-sm border text-gray-400 animate-pulse">
                      Sto pensando...
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input bar */}
            <div className="border-t bg-white px-4 py-3">
              <div className="max-w-3xl mx-auto flex gap-2">
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                  placeholder="Scrivi un messaggio..."
                  className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
                  disabled={loading}
                />
                <button
                  onClick={sendMessage}
                  disabled={loading || !input.trim()}
                  className={`px-5 py-2.5 rounded-xl text-sm font-medium text-white transition-colors ${
                    loading || !input.trim() ? 'bg-gray-300' : 'bg-teal-600 hover:bg-teal-700'
                  }`}
                >
                  {loading ? '...' : 'Invia'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-6xl mb-4">🤖</div>
              <h2 className="text-xl font-semibold text-gray-600">Agent xHUMANPRO</h2>
              <p className="text-gray-400 mt-2 text-sm">Crea una nuova chat per iniziare</p>
              <button onClick={createSession} className="mt-4 px-6 py-2.5 bg-teal-600 text-white rounded-xl hover:bg-teal-700 text-sm">
                Nuova chat
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtMd(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code class="bg-gray-200 px-1 rounded text-xs font-mono">$1</code>')
    .replace(/^### (.*)/gm, '<h4 class="font-semibold mt-3 mb-1">$1</h4>')
    .replace(/^## (.*)/gm, '<h3 class="font-semibold text-base mt-3 mb-1">$1</h3>')
    .replace(/^# (.*)/gm, '<h2 class="font-bold text-lg mt-3 mb-1">$1</h2>')
    .replace(/^- (.*)/gm, '<div class="ml-3 flex gap-1"><span class="text-gray-400">•</span><span>$1</span></div>')
    .replace(/^\d+\. (.*)/gm, '<div class="ml-3">$&</div>')
    .replace(/\n/g, '<br/>');
}
