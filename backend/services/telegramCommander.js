/**
 * 📱 TELEGRAM COMMANDER (richiesta capo 11/7/2026)
 *
 * "Mi piacerebbe poter continuare il lavoro anche da cellulare: un'app per
 *  inviarti le info da cell e leggere le tue risposte."
 *
 * Canale mobile bidirezionale: lo stesso bot delle sirene ora ASCOLTA.
 * Il capo scrive in chat → agente AI (Fable 5, fallback Opus) con accesso
 * SQL IN SOLA LETTURA al DB di produzione → risposta in chat.
 *
 * Sicurezza:
 *  - risponde SOLO alla chat_id configurata (telegram_chat_id)
 *  - SQL eseguito in transazione READ ONLY (Postgres blocca ogni scrittura)
 *  - nessuna azione di scrittura da mobile in v1: l'agente propone, il
 *    desktop dispone
 */

const { pool } = require('../db/pool');
const { getGlobals, getGlobal } = require('./globalConfig');

const MODEL = 'claude-fable-5';
const MODEL_FALLBACK = 'claude-opus-4-8';
const MAX_TURNS = 8;
const HISTORY_MAX = 16; // messaggi di contesto tenuti in RAM (reset al riavvio)

let history = []; // [{role, content}] della conversazione col capo

const SYSTEM_PROMPT = `Sei il canale MOBILE di xHumanPro: il sistema che ottimizza i feed Trovaprezzi (TP) di 10 farmacie italiane (SubitoFarma, San Vito, MPF, Papa, Procaccini, Farmacri, Farmainsieme, Mandanici, Ospedale, Farmastelia). Parli col CAPO (Stefano) dal suo telefono: risposte in italiano, CONCISE (schermo piccolo), numeri concreti, niente markdown pesante — testo semplice, al massimo elenchi brevi.

MISSIONE (mantra): Fatturato SU + MOL ~20% (mai sotto 15%) + Costo TP GIÙ.

MAPPA DATI (Postgres, sola lettura):
- products(tenant_id, sku, product_name, brand, is_civetta[tag FB], sell_price[prezzo regola FB], exported_price, applied_price[Magento live], erp_cost[min fornitore], erp_purchase_cost[costo vero farmacia], erp_stock, supplier_stock, margin_pct, sales_30d_seller, sales_30d_aggregated, saleable, price_rule_id, updated_at)
- tenants(id, name, status) — orders(id, tenant_id, order_date, order_status, total_amount) + order_items(order_id, sku, qty, price) — ordini VALIDI: status NOT IN ('canceled','closed')
- zombie_clicks(tenant_id, product_code, clicks, fetch_date) — click TP reali; incidenza = click × CPC(~0,27+22%) / fatturato store
- scraper_competitors(product_code, merchant, position, base_price, total_price, scraped_at[ORA ITALIANA]) — ⛔ AL MOMENTO NON DA PRENDERE IN CONSIDERAZIONE (ordine capo 11/7): scraper FB guasto dal 9/7, dump decimato. Se il capo chiede posizioni/competitor: rispondi che il dato scraper è INAFFIDABILE fino al ripristino FB, e proponi metriche alternative (ordini, click zombie, margini)
- scraper_listing_map(product_code, last_seen) — listing visitati dallo scraper
- tenant_configs: config_key='stable_feed_codes' = CSV feed (jsonb ->'codes')
- feed_actions(action: ADD/REMOVE/PRICE_CUT, action_source, recommended_price) — feed_killers(is_active) — feed_quarantine(reactivated) — cross_tenant_oblio(status='active')
- activation_cohorts(cohort_name, tenant_id, sku, activated_at) — coorti attivazione 14g
- health_config(tenant_id, config_key, config_value) — global_config(config_key, config_value)
- feed_movements(tenant_id, sku, direction IN/OUT, reason, moved_at)
- price_rules(tenant_id, rule_id, rule_name, rule_data jsonb: scraper_position=pos target)

CONTESTO OPERATIVO (11/7/2026):
- PAUSA SCRAPER attiva (global_config.scraper_optimization_paused='1'): niente blocchi/prezzi da posizioni finché il capo non riattiva (scraper FB era fermo dal 9/7, dump decimato 104k→7,7k MINSAN/import, dev FB deve ripristinare)
- Sblocco capo: coorte 'gap_sblocco_capo_20260711' — civetta FB senza evidenza liberati su tutta la rete
- is_civetta = tag FB diretto dal 11/7 (Magento non sovrascrive più)
- Floor ricarico: 15% standard (SubitoFarma 11% per scelta cliente). REGOLA AUREA: mai prezzi AI su regole MURO, veto rialzi, solo cut Salva Bilancio.
- Confronti orari: order_date è Europe/Rome, NOW() è UTC → usa AT TIME ZONE 'Europe/Rome' su entrambi.

REGOLE DI RISPOSTA:
1. Usa lo strumento sql_query per OGNI dato: mai inventare numeri ("i numeri sono numeri, non puoi inventarteli").
2. Sei in SOLA LETTURA: se il capo chiede un'azione (sbloccare, prezzare, killare), prepara la proposta con i numeri e di' chiaramente "da eseguire dal desktop" — mai fingere di averla eseguita.
3. Valuta sempre col MARGINE (la bibbia): margine assoluto > percentuali.
4. Risposte da telefono: brevi, il dato chiave subito, dettaglio solo se richiesto.
5. FRESCHEZZA (regola del capo: "i dati cambiano veloci"): controlla SEMPRE a quanto risale l'ultimo update dei dati che usi (MAX(updated_at)/order_date) e DICHIARALO in coda alla risposta (es. "dati prodotti di 40 min fa"). Se il dato è più vecchio del suo ciclo (prodotti >2h, ordini >1h), dillo esplicitamente PRIMA del numero. Lo scraper NON si usa affatto finché non riparte (vedi sopra).`;

const TOOLS = [
  {
    name: 'sql_query',
    description: 'Esegui una query SQL in SOLA LETTURA sul DB di produzione xHumanPro (Postgres). Ritorna al massimo 50 righe: usa LIMIT e aggregazioni.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'La query SELECT/WITH da eseguire' } },
      required: ['query'],
    },
  },
];

async function runReadOnlySql(query) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    // statement_timeout: una query pesante non deve bloccare il canale
    await client.query("SET LOCAL statement_timeout = '20s'");
    const { rows } = await client.query(query);
    await client.query('COMMIT');
    const limited = rows.slice(0, 50);
    return JSON.stringify({ rows: limited, count: rows.length, truncated: rows.length > 50 });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return JSON.stringify({ error: e.message });
  } finally {
    client.release();
  }
}

let giornoFallback = null;
let usaFallback = false;

async function askAgent(userText) {
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  const key = await getGlobal('claude_api_key');
  if (!key) return 'Configurazione mancante (claude_api_key)';
  const { getAiClient } = require('./aiClient');
  const client = await getAiClient('commander', key);
  if (!client) return 'Nessun provider AI disponibile';

  const oggi = new Date().toISOString().slice(0, 10);
  if (giornoFallback !== oggi) { usaFallback = false; giornoFallback = oggi; }

  history.push({ role: 'user', content: userText });
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);

  const messages = [...history];
  let finalText = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: usaFallback ? MODEL_FALLBACK : MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    } catch (e) {
      if (!usaFallback && /model|not_found|permission|rate.?limit|429|overloaded|529|quota|credit|insufficient|exceeded/i.test(e.message)) {
        console.log(`[Commander] ${MODEL} ko (${e.message.slice(0, 60)}) → fallback ${MODEL_FALLBACK}`);
        usaFallback = true;
        turn--;
        continue;
      }
      return `Errore AI: ${e.message.slice(0, 120)}`;
    }

    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    const textBlocks = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (textBlocks) finalText = textBlocks;

    if (toolUses.length === 0 || resp.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of toolUses) {
      const out = tu.name === 'sql_query'
        ? await runReadOnlySql(tu.input.query)
        : JSON.stringify({ error: 'tool sconosciuto' });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.slice(0, 30000) });
    }
    messages.push({ role: 'user', content: results });
  }

  history.push({ role: 'assistant', content: finalText || '(nessuna risposta)' });
  return finalText || 'Non sono riuscito a formulare una risposta.';
}

async function tgApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendChunked(token, chatId, text) {
  for (let i = 0; i < text.length; i += 3900) {
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: text.slice(i, i + 3900) });
  }
}

let running = false;

async function pollLoop() {
  const g = await getGlobals(['telegram_bot_token', 'telegram_chat_id']);
  if (!g.telegram_bot_token || !g.telegram_chat_id) {
    console.log('[Commander] telegram non configurato, riprovo tra 10 min');
    setTimeout(pollLoop, 10 * 60 * 1000);
    return;
  }
  const token = g.telegram_bot_token;
  const chatId = String(g.telegram_chat_id);
  let offset = 0;

  console.log('[Commander] 📱 canale mobile ATTIVO (long-polling)');

  while (true) {
    try {
      const upd = await tgApi(token, 'getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      if (!upd.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
      for (const u of upd.result || []) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg || !msg.text) continue;
        // SICUREZZA: solo la chat del capo
        if (String(msg.chat.id) !== chatId) {
          console.log(`[Commander] messaggio da chat non autorizzata ${msg.chat.id}, ignorato`);
          continue;
        }
        console.log(`[Commander] 📩 "${msg.text.slice(0, 80)}"`);
        try {
          await tgApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
          const answer = await askAgent(msg.text.slice(0, 4000));
          await sendChunked(token, chatId, answer);
        } catch (e) {
          console.error('[Commander] err risposta:', e.message);
          try { await sendChunked(token, chatId, `Errore: ${e.message.slice(0, 150)}`); } catch {}
        }
      }
    } catch (e) {
      console.error('[Commander] poll err:', e.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

function startTelegramCommander() {
  if (running) return;
  running = true;
  setTimeout(() => {
    pollLoop().catch(e => console.error('[Commander] fatal:', e.message));
  }, 20 * 1000);
  console.log('[Commander] 📱 Telegram Commander in avvio (canale mobile del capo)');
}

module.exports = { startTelegramCommander };
