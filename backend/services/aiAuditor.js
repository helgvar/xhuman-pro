/**
 * AI Audit (mode: audit only — non agisce).
 *
 * Dopo ogni run del feedDailyEngine, raccoglie KPI + stats + top anomalie e
 * chiama Claude per ottenere suggerimenti strutturati. Salva tutto in
 * ai_audit_suggestions (status='pending'). L'utente revisiona da UI.
 *
 * Design choices:
 *  - Fire-and-forget: errori AI NON bloccano l'engine.
 *  - Throttle: max 1 audit ogni 30 min per tenant (evita spam dopo rerun
 *    multipli durante il debug).
 *  - Skippa se claude_api_key non e' valorizzata.
 *  - Token budget: prompt e' compatto (~3-4KB) per restare basso costo.
 */

const { pool } = require('../db/pool');

let _anthropic = null;
let _lastAuditByTenant = new Map();       // tenantId -> ts ultimo audit
const AUDIT_THROTTLE_MS = 30 * 60 * 1000; // 30 min

async function getClient() {
  if (_anthropic !== null) return _anthropic;
  try {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    const { getGlobal } = require('./globalConfig');
    const key = await getGlobal('claude_api_key');
    if (!key) {
      _anthropic = false;
      return false;
    }
    _anthropic = new Anthropic({ apiKey: key });
    return _anthropic;
  } catch (e) {
    console.warn('[aiAuditor] Anthropic SDK init failed:', e.message);
    _anthropic = false;
    return false;
  }
}

async function gatherContext(tenantId) {
  // 1. Tenant + briglie attive
  const { rows: [tenant] } = await pool.query(
    `SELECT id, name FROM tenants WHERE id=$1`, [tenantId]
  );

  const { rows: briglie } = await pool.query(
    `SELECT config_key, config_value, expires_at, expired_revert_to
     FROM health_config WHERE tenant_id=$1
       AND (expires_at IS NULL OR expires_at > NOW())
       AND config_key IN (
         'tp_target_incidence_max','promote_store_seller_min_sales',
         'prefer_erp_stock_only','killer_skip_min_store_sales',
         'store_sales_safety_net','quarantine_release_min_store_sales',
         'mol_floor_pct','salva_bilancio_min_margin_eur',
         'pepite_golden_position_max','pepite_silver_position_max',
         'pepite_silver_sales_min'
       )
     ORDER BY config_key`,
    [tenantId]
  );

  // 2. KPI ultimi 7 giorni
  const { rows: kpi } = await pool.query(
    `WITH o AS (
       SELECT order_date::date AS d, COUNT(*) AS ord, SUM(grand_total_products) AS rev
       FROM orders WHERE tenant_id=$1 AND order_status NOT IN ('canceled','closed','pending_payment')
         AND order_date::date >= CURRENT_DATE-7 GROUP BY 1),
     z AS (
       SELECT fetch_date AS d, SUM(clicks) AS clk FROM zombie_clicks
       WHERE tenant_id=$1 AND fetch_date >= CURRENT_DATE-7 GROUP BY 1)
     SELECT COALESCE(o.d,z.d) AS d,
       COALESCE(o.ord,0) AS ord,
       COALESCE(ROUND(o.rev::numeric,0),0) AS rev,
       COALESCE(z.clk,0) AS clk,
       COALESCE(ROUND(z.clk*0.27,0),0) AS spesa,
       CASE WHEN o.rev>0 THEN ROUND(z.clk*0.27/o.rev*100,2) END AS inc_pct
     FROM o FULL OUTER JOIN z ON o.d=z.d ORDER BY d DESC`,
    [tenantId]
  );

  // 3. Feed corrente
  const { rows: feed } = await pool.query(
    `SELECT action, COUNT(*)::int AS n FROM feed_actions WHERE tenant_id=$1 GROUP BY action`,
    [tenantId]
  );

  // 4. Top 5 killer freschi (click 5gg + 0 sales store)
  const { rows: killers } = await pool.query(
    `SELECT z.product_code AS sku, p.product_name,
       SUM(z.clicks)::int AS clk_5g,
       ROUND(SUM(z.clicks*0.27)::numeric,2) AS spesa_5g,
       p.sales_30d_aggregated AS sales_agg, p.margin_pct,
       fa.action AS feed_action
     FROM zombie_clicks z
     JOIN products p ON p.tenant_id=z.tenant_id AND p.sku=z.product_code
     LEFT JOIN feed_actions fa ON fa.tenant_id=z.tenant_id AND fa.sku=z.product_code
     WHERE z.tenant_id=$1 AND z.fetch_date >= CURRENT_DATE-5
       AND COALESCE(p.sales_30d_seller,0) = 0
     GROUP BY z.product_code, p.product_name, p.sales_30d_aggregated, p.margin_pct, fa.action
     HAVING SUM(z.clicks) >= 10 ORDER BY clk_5g DESC LIMIT 5`,
    [tenantId]
  );

  // 5. Stock dormente (erp_stock>0, non in feed, mol>=15%)
  const { rows: [stock] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE erp_stock>0 AND COALESCE(is_civetta,false)=false) AS erp_stock_off_feed,
       COUNT(*) FILTER (WHERE erp_stock>0 AND COALESCE(is_civetta,false)=false AND margin_pct>=15) AS erp_stock_qualita,
       COUNT(*) FILTER (WHERE is_civetta=true) AS in_feed
     FROM products WHERE tenant_id=$1 AND saleable=true`,
    [tenantId]
  );

  return { tenant, briglie, kpi, feed, killers, stock };
}

// SYSTEM PROMPT STATICO (mandato + regole + schema output).
// Estratto dal user prompt per abilitare prompt caching Anthropic (~2000 token cacheable).
// Mantenerlo stabile: ogni modifica invalida la cache (5 min TTL ephemeral).
const SYSTEM_PROMPT_STATIC = `Sei un consulente di ottimizzazione per xHumanPro, sistema di gestione campagne Trovaprezzi multi-tenant per farmacie.

═══════════════════════════════════════════════════════════════════
MANDATO PRIMARIO (NON NEGOZIABILE):
   AUMENTARE IL FATTURATO MANTENENDO I COSTI SOTTO CONTROLLO.
═══════════════════════════════════════════════════════════════════

Questo significa, CONCRETAMENTE:
  1. Le tue azioni devono AUMENTARE i candidati ADD nel feed (non ridurli).
  2. La spesa TP NON deve esplodere: l'incidenza recente deve restare sotto cap.
  3. Il MOL non scende mai sotto 15% (MANTRA).
  4. Se vedi spesa che cresce SENZA fatturato corrispondente → quarantena killer SKU specifici.
  5. Se vedi fatturato che cala → ALLARGA i filtri di ammissione (NON restringere).

❌ AZIONI VIETATE (riducono il potenziale fatturato senza ragione strategica):
  - Attivare prefer_erp_stock_only=1 su tenant dove era 0 (esclude supplier_stock = -1000+ ADD potenziali)
  - Alzare promote_store_seller_min_sales da 0 a 1+ (restringe l'ammissione)
  - Restringere pepite_silver_position_max o pepite_golden_position_max
  - Alzare salva_bilancio_min_margin_eur (riduce PRICE_CUT competitivi)
  Queste azioni sono ammesse SOLO se l'incidenza recente reale (non snapshot 30g)
  ha superato il cap config per ≥3 giorni consecutivi.

✅ AZIONI CONSIGLIATE (allineate al MANDATO):
  - Quarantena SKU killer specifici (click senza conversion + 0 sales locali)
  - Abbassare promote_store_seller_min_sales (ammettere più SKU)
  - Allargare pepite_silver_position_max / pepite_golden_position_max
  - Abbassare salva_bilancio_min_margin_eur (più cut competitivi)
  - Disattivare prefer_erp_stock_only=0 dove possibile (apre supplier_stock)
  - Alzare cap incidenza SE la spesa cala ma il fatturato non cresce
  - Estendere scadenza briglie permanenti senza modificarle

CONFIG NOTE:
- tp_target_incidence_max: cap incidenza (€spesa / €rev) sotto cui l'engine accetta promote. Sopra = overTarget blocca promozione.
- prefer_erp_stock_only=1: promuovi solo magazzino farmacia (esclude grossista)
- promote_store_seller_min_sales=N: SKU promovibili devono vendere ≥N volte in store
- store_sales_safety_net=1: protegge SKU che vendono cross-tenant
- salva_bilancio_min_margin_eur: PRICE_CUT accettato se margine_assoluto >= X eur (anche se margine% basso)
- pepite_silver_position_max: range posizioni TP per pepite

ANALIZZA il contesto tenant nel messaggio utente e proponi suggerimenti SOLO se ci sono anomalie chiare. Rispondi SOLO con JSON valido in questo formato (senza markdown, senza testo extra):

{
  "suggestions": [
    {
      "severity": "low|medium|high",
      "category": "spesa|fatturato|conversion|killer|magazzino|briglie",
      "title": "breve titolo (max 80 caratteri)",
      "description": "spiegazione concreta del problema (max 300 caratteri)",
      "suggested_actions": [
        {
          "type": "config_change|quarantine_sku|adjust_briglia|alert",
          "target": "config_key oppure SKU",
          "params": { "from": "...", "to": "..." },
          "reasoning": "perche' questa azione (max 200 caratteri)"
        }
      ]
    }
  ]
}

Se non ci sono anomalie, rispondi: {"suggestions": []}

Limiti: massimo 5 suggerimenti. NON proporre azioni che potrebbero violare il MANTRA (es. abbassare MOL sotto 15%).`;

function buildPrompt(ctx) {
  // User prompt = SOLO parte dinamica (contesto tenant). Il mandato + regole + schema
  // sono in SYSTEM_PROMPT_STATIC (cached via cache_control ephemeral).
  const briglieStr = ctx.briglie.length === 0
    ? '(nessuna briglia override)'
    : ctx.briglie.map(b => `  - ${b.config_key} = ${b.config_value}${b.expires_at ? ' (scade ' + new Date(b.expires_at).toISOString().slice(0,10) + ')' : ' [PERMANENTE]'}`).join('\n');

  const kpiStr = ctx.kpi.length === 0
    ? '(nessun KPI ultimi 7gg)'
    : ctx.kpi.map(k => `  ${k.d}: ${k.ord}ord €${k.rev}rev ${k.clk}clk €${k.spesa}spesa inc=${k.inc_pct || 'n/d'}%`).join('\n');

  const feedStr = ctx.feed.map(f => `${f.action}=${f.n}`).join(', ') || '(vuoto)';

  const killersStr = ctx.killers.length === 0
    ? '(nessun killer fresh ≥10click)'
    : ctx.killers.map(k => `  - ${k.sku} ${k.product_name}: ${k.clk_5g}clk €${k.spesa_5g} | sales_agg=${k.sales_agg} margin=${k.margin_pct}% feed=${k.feed_action || 'NONE'}`).join('\n');

  return `TENANT: ${ctx.tenant.name}

BRIGLIE ATTUALMENTE ATTIVE:
${briglieStr}

KPI ULTIMI 7 GIORNI (giorno: ordini, revenue, click TP, spesa, incidenza%):
${kpiStr}

FEED CORRENTE: ${feedStr}

STOCK MAGAZZINO:
  - In feed civetta: ${ctx.stock.in_feed}
  - Erp_stock fuori feed (potenziale dormente): ${ctx.stock.erp_stock_off_feed} (di cui ${ctx.stock.erp_stock_qualita} con MOL≥15%)

TOP KILLER FRESCHI (≥10 click 5gg, 0 ordini store):
${killersStr}`;
}

async function persistSuggestions(tenantId, suggestions, contextSnapshot, ai_model, tokens_in, tokens_out) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return 0;
  let inserted = 0;
  for (const s of suggestions) {
    try {
      await pool.query(
        `INSERT INTO ai_audit_suggestions
           (tenant_id, severity, category, title, description, suggested_actions, context_snapshot, ai_model, ai_tokens_in, ai_tokens_out)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          tenantId,
          s.severity || 'low',
          s.category || 'briglie',
          (s.title || '').slice(0, 200),
          (s.description || '').slice(0, 1000),
          JSON.stringify(s.suggested_actions || []),
          JSON.stringify(contextSnapshot).slice(0, 5000),
          ai_model,
          tokens_in,
          tokens_out,
        ]
      );
      inserted++;
    } catch (e) {
      console.warn('[aiAuditor] persist err:', e.message);
    }
  }
  return inserted;
}

/**
 * Configurazioni modello:
 *  - default: Opus 4.8 (audit post-engine standard). Upgrade da Sonnet 4-5 (2/7/2026)
 *    per massimo ragionamento sui suggerimenti. Prompt caching riduce il costo input.
 *  - deep: Opus 4.8 + extended thinking (loop 6h, ragionamento profondo)
 */
const MODEL_PROFILES = {
  default: {
    model: 'claude-opus-4-8',
    max_tokens: 4000,
  },
  // loop giornaliero (3 slot/gg): Sonnet 4.5 + thinking medium. ~1/6 del costo
  // di Opus-high, resa sufficiente per l'audit ricorrente (ordine capo 29/7).
  loop: {
    model: 'claude-sonnet-4-5',
    max_tokens: 6000,
    thinking: { type: 'enabled', budget_tokens: 2000 },
  },
  deep: {
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    // Opus 4.8 usa adaptive thinking + output_config.effort (NON enabled+budget_tokens).
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  },
};

/**
 * Entry point: analizza il run appena concluso di un tenant.
 * Fire-and-forget: non lancia mai eccezioni (i caller possono ignorare il return).
 *
 * @param {Object} options
 *  - profile: 'default' (Opus 4.8) | 'deep' (Opus 4.8 + adaptive thinking, effort high)
 *  - bypassThrottle: salta il throttle 30 min (per loop ottimizzazione forzato)
 */
async function auditTenantRun(tenantId, snapshot = null, stats = null, options = {}) {
  const profileName = options.profile || 'default';
  const profile = MODEL_PROFILES[profileName] || MODEL_PROFILES.default;
  try {
    // Throttle (skippato per loop deep)
    if (!options.bypassThrottle) {
      const last = _lastAuditByTenant.get(tenantId) || 0;
      if (Date.now() - last < AUDIT_THROTTLE_MS) {
        return { skipped: true, reason: 'throttle' };
      }
    }

    const client = await getClient();
    if (!client) return { skipped: true, reason: 'no_api_key' };

    const ctx = await gatherContext(tenantId);
    if (!ctx.tenant) return { skipped: true, reason: 'tenant_not_found' };

    if (snapshot) ctx.engineSnapshot = snapshot;
    if (stats) ctx.engineStats = stats;

    const prompt = buildPrompt(ctx);
    const MODEL = profile.model;

    // System prompt statico con cache_control ephemeral (Anthropic prompt caching):
    // ~2000 token cached → 90% risparmio input dopo la prima chiamata (TTL 5 min).
    const reqBody = {
      model: MODEL,
      max_tokens: profile.max_tokens,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT_STATIC,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: prompt }],
    };
    if (profile.thinking) reqBody.thinking = profile.thinking;
    if (profile.output_config) reqBody.output_config = profile.output_config;

    const resp = await client.messages.create(reqBody);

    const tokens_in = resp.usage?.input_tokens || 0;
    const tokens_out = resp.usage?.output_tokens || 0;
    const cache_read = resp.usage?.cache_read_input_tokens || 0;
    const cache_write = resp.usage?.cache_creation_input_tokens || 0;
    // Con extended thinking il content e' un array di blocchi (thinking + text).
    // Cerco il primo blocco di tipo 'text' (= output finale).
    const textBlock = (resp.content || []).find(b => b.type === 'text');
    const text = textBlock?.text || resp.content?.[0]?.text || '';

    let parsed;
    try {
      // Anthropic a volte wrappa in ```json...```: pulisco
      const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn(`[aiAuditor][${ctx.tenant.name}] JSON parse fail:`, e.message, 'raw:', text.slice(0,200));
      return { skipped: true, reason: 'parse_error', tokens_in, tokens_out };
    }

    const inserted = await persistSuggestions(
      tenantId, parsed.suggestions || [], ctx,
      MODEL, tokens_in, tokens_out
    );

    _lastAuditByTenant.set(tenantId, Date.now());
    console.log(`[aiAuditor][${ctx.tenant.name}] model=${MODEL} profile=${profileName} ${inserted} suggerimenti salvati (in=${tokens_in} out=${tokens_out} cache_read=${cache_read} cache_write=${cache_write})`);
    return { ok: true, suggestions: inserted, tokens_in, tokens_out, cache_read, cache_write, model: MODEL };
  } catch (e) {
    console.warn(`[aiAuditor] audit failed:`, e.message);
    return { skipped: true, reason: 'error', error: e.message };
  }
}

module.exports = { auditTenantRun };
