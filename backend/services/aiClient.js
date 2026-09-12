/**
 * Client AI unico: parla Anthropic in ingresso e in uscita, ma sotto puo' avere
 * Anthropic o DeepSeek (ordine capo 12/8: "deepseek costa meno, proviamo se
 * gestisce le azioni alla stessa maniera").
 *
 * Perche' uno shim e non 9 riscritture: i servizi che chiamano l'AI parlano gia'
 * il dialetto Anthropic (system separato, content a blocchi, tool_use /
 * tool_result). Tradurre qui dentro significa che `claudeAgent.js` col suo loop
 * di tool resta IDENTICO — e quindi il confronto fra i due provider e' a codice
 * pari: stesso prompt, stessi tool, stessa logica. Cambia solo chi risponde.
 *
 * Uso:
 *   const { getAiClient } = require('./aiClient');
 *   const client = await getAiClient('agent');       // nome del servizio
 *   const resp = await client.messages.create({ ... });  // corpo Anthropic
 *
 * Config in `global_config`:
 *   ai_provider            'anthropic' (default) | 'deepseek'
 *   ai_provider_overrides  JSON per servizio, es. {"agent":"deepseek"}
 *   deepseek_api_key       chiave cifrata, come tutte le altre
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getGlobal } = require('./globalConfig');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// deepseek-chat = V3 (uso generale, 8K output max).
// deepseek-reasoner = R1, tiene il ragionamento in `reasoning_content`: lo si
// sceglie dove Anthropic chiedeva extended thinking.
const MAPPA_MODELLI = {
  reasoner: 'deepseek-reasoner',
  chat: 'deepseek-chat',
};
const MAX_OUTPUT_DEEPSEEK = { 'deepseek-chat': 8192, 'deepseek-reasoner': 65536 };

async function provider(servizio) {
  const base = (await getGlobal('ai_provider')) || 'anthropic';
  const raw = await getGlobal('ai_provider_overrides');
  if (!raw) return base;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o[servizio] || base;
  } catch {
    // Override illeggibile: si resta sul provider di default invece di
    // spegnere l'AI. Un JSON storto non deve fermare il motore.
    console.warn('[aiClient] ai_provider_overrides non e\' JSON valido, ignorato');
    return base;
  }
}

// ─── TRADUZIONE RICHIESTA: Anthropic → OpenAI/DeepSeek ─────────────────

function testoDaContenuto(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function systemInTesto(system) {
  if (!system) return null;
  if (typeof system === 'string') return system;
  // Array di blocchi con cache_control: DeepSeek fa il caching da solo sul
  // prefisso comune, quindi i marcatori si buttano e il testo si concatena.
  return system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
}

function toolsVersoOpenai(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * Un messaggio Anthropic puo' portare piu' tool_result in un colpo solo; in
 * OpenAI ogni risultato e' un messaggio `role: tool` a se'. Da qui il fan-out.
 */
function messaggiVersoOpenai(messages, system) {
  const out = [];
  const sys = systemInTesto(system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const m of messages) {
    const blocchi = Array.isArray(m.content) ? m.content : null;

    if (!blocchi) {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === 'assistant') {
      const toolUse = blocchi.filter(b => b.type === 'tool_use');
      const msg = { role: 'assistant', content: testoDaContenuto(blocchi) || null };
      if (toolUse.length) {
        msg.tool_calls = toolUse.map(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    // role user: i tool_result diventano messaggi `tool`, il testo resta user
    const risultati = blocchi.filter(b => b.type === 'tool_result');
    for (const r of risultati) {
      out.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
      });
    }
    const testo = testoDaContenuto(blocchi);
    if (testo) out.push({ role: 'user', content: testo });
  }
  return out;
}

// ─── TRADUZIONE RISPOSTA: OpenAI/DeepSeek → Anthropic ──────────────────

function rispostaVersoAnthropic(json, modello) {
  const scelta = json.choices?.[0] || {};
  const msg = scelta.message || {};
  const content = [];

  if (msg.content) content.push({ type: 'text', text: msg.content });

  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      // Argomenti non parsabili: si passa la stringa grezza al tool, che
      // fallira' con un errore leggibile invece di eseguire un'azione a caso.
      // Su un motore che scrive feed_actions, indovinare e' peggio che fallire.
      input = { _raw: tc.function?.arguments };
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }

  const u = json.usage || {};
  return {
    id: json.id,
    model: modello,
    content,
    stop_reason: scelta.finish_reason === 'tool_calls' ? 'tool_use'
               : scelta.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      // DeepSeek fa cache automatica su disco: il conto degli hit arriva qui,
      // cosi' i log di costo restano confrontabili con quelli Anthropic.
      cache_read_input_tokens: u.prompt_cache_hit_tokens || 0,
      cache_creation_input_tokens: 0,
    },
    _provider: 'deepseek',
    _reasoning: msg.reasoning_content || null,
  };
}

// ─── CLIENT DEEPSEEK CON FACCIA ANTHROPIC ──────────────────────────────

function clientDeepseek(apiKey, servizio) {
  return {
    messages: {
      async create(body) {
        // Anthropic sceglie il thinking col budget, DeepSeek no: o usi il
        // reasoner o non ragiona. Qui la richiesta di thinking diventa la
        // scelta del modello, e lo si dice nel log invece di ignorarla in
        // silenzio (un downgrade muto e' un downgrade che nessuno verifica).
        const vuoleThinking = !!(body.thinking || body.output_config?.effort);
        const modello = MAPPA_MODELLI[vuoleThinking ? 'reasoner' : 'chat'];
        const tetto = MAX_OUTPUT_DEEPSEEK[modello];
        const maxTokens = Math.min(body.max_tokens || 4096, tetto);
        if (body.max_tokens > tetto) {
          console.warn(`[aiClient][${servizio}] max_tokens ${body.max_tokens} > tetto ${modello} (${tetto}), tagliato`);
        }

        const payload = {
          model: modello,
          messages: messaggiVersoOpenai(body.messages || [], body.system),
          max_tokens: maxTokens,
        };
        const tools = toolsVersoOpenai(body.tools);
        if (tools) payload.tools = tools;
        if (typeof body.temperature === 'number') payload.temperature = body.temperature;

        const t0 = Date.now();
        const resp = await fetch(DEEPSEEK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) {
          const dettaglio = await resp.text().catch(() => '');
          throw new Error(`DeepSeek ${resp.status}: ${dettaglio.slice(0, 300)}`);
        }
        const json = await resp.json();
        const out = rispostaVersoAnthropic(json, modello);
        console.log(`[aiClient][${servizio}] deepseek ${modello} ${Math.round((Date.now() - t0) / 1000)}s `
          + `in=${out.usage.input_tokens} (cache ${out.usage.cache_read_input_tokens}) out=${out.usage.output_tokens} `
          + `stop=${out.stop_reason}`);
        return out;
      },
    },
  };
}

/**
 * @param {string} servizio  nome breve del chiamante ('agent', 'auditor',
 *                           'mantra', ...): serve per l'override per servizio
 *                           e per capire nei log chi ha speso cosa.
 * @param {string} [apiKeyAnthropic] chiave gia' decifrata, se il chiamante ne
 *                           ha una sua (es. la `claude_api_key` del tenant).
 * @returns client con `.messages.create(corpoAnthropic)`, o null senza chiave.
 */
async function getAiClient(servizio, apiKeyAnthropic = null) {
  const p = await provider(servizio);

  if (p === 'deepseek') {
    const key = await getGlobal('deepseek_api_key');
    if (!key) {
      console.error(`[aiClient][${servizio}] provider deepseek ma deepseek_api_key manca: torno su anthropic`);
    } else {
      return clientDeepseek(key, servizio);
    }
  }

  const key = apiKeyAnthropic || (await getGlobal('anthropic_api_key')) || (await getGlobal('claude_api_key'));
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

module.exports = {
  getAiClient,
  // esportati per il banco di prova e per i test
  messaggiVersoOpenai,
  toolsVersoOpenai,
  rispostaVersoAnthropic,
};
