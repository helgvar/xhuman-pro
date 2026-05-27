/**
 * Claude Agent — Braccio operativo AI per ottimizzazione feed
 *
 * - Claude Opus come modello
 * - Tools per leggere dati e eseguire azioni SUBITO
 * - Regole invalicabili hardcoded
 * - Safety levels: safe/risky/critical/blocked
 * - Sessioni salvate 90gg
 */

const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');
const { checkAction, verifyAdminPassword } = require('./agentSafety');
const { recalculateStableCache } = require('../routes/externalApi');

const MODELS = {
  fast: 'claude-haiku-4-5-20251001',    // Chat, domande semplici, conversazione
  standard: 'claude-sonnet-4-20250514',  // Analisi dati, azioni, ricerche prodotti
  deep: 'claude-opus-4-20250514',        // Analisi complesse multi-step, strategie
};
const MAX_TOKENS = { fast: 1024, standard: 2048, deep: 4096 };
const MAX_HISTORY_MESSAGES = 20;

// Auto-select model based on message content
function selectModel(message) {
  const msg = message.toLowerCase();

  // Deep: strategia, analisi complessa, piano d'azione, ottimizzazione globale
  const deepPatterns = /strateg|piano.*azione|ottimiz.*globale|analisi.*complet|analizza.*tutt|ricalcol.*feed|confronta.*competitor|valuta.*portafoglio/;
  if (deepPatterns.test(msg)) return 'deep';

  // Standard: azioni, ricerche, analisi prodotti, regole
  const standardPatterns = /rimuov|aggiung|togli|metti|taglia|prezzo|price|prodott|sku|brand|regol|feed|click|incidenz|costo|revenue|vendit|margine|competitor|cerca|trova|mostr|elenc|quant|anal/;
  if (standardPatterns.test(msg)) return 'standard';

  // Fast: tutto il resto (ciao, grazie, domande generiche)
  return 'fast';
}

// ─── TOOLS DEFINITION ──────────────────────────────────

const TOOLS = [
  {
    name: 'get_feed_summary',
    description: 'Ottieni il riepilogo KPI del feed: incidenza, costo click, revenue, prodotti nel feed, azioni attive (remove/keep/price_cut/monitor)',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_products',
    description: 'Cerca prodotti per nome, SKU, brand, categoria TP, regola prezzo. Restituisce max 20 risultati.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare nel nome prodotto, SKU o brand' },
        rule_type: { type: 'string', description: 'Filtra per tipo regola: diretto, sconto, salva_bilancio, muro' },
        has_clicks: { type: 'boolean', description: 'Solo prodotti con click TP' },
        civetta: { type: 'boolean', description: 'Filtra per civetta (true=nel feed, false=fuori)' },
        limit: { type: 'number', description: 'Max risultati (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_product_details',
    description: 'Ottieni dettagli completi di uno o piu prodotti: prezzo, costo, margine, click, vendite, posizione, competitor, regola prezzo, health score',
    input_schema: {
      type: 'object',
      properties: {
        skus: { type: 'array', items: { type: 'string' }, description: 'Lista di SKU da cercare' },
      },
      required: ['skus'],
    },
  },
  {
    name: 'get_competitors',
    description: 'Ottieni la classifica competitor per un prodotto specifico su Trovaprezzi',
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string' } },
      required: ['sku'],
    },
  },
  {
    name: 'get_tenant_rules',
    description: 'Ottieni le regole personalizzate attive per questo tenant',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'execute_action',
    description: 'Esegui un\'azione sul feed SUBITO. Tipi: remove (rimuovi dal feed), add (aggiungi al feed), price_cut (taglio prezzo). Le azioni safe vengono eseguite immediatamente, quelle rischiose richiedono conferma, quelle critiche richiedono password.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['remove', 'add', 'price_cut'], description: 'Tipo azione' },
        skus: { type: 'array', items: { type: 'string' }, description: 'SKU dei prodotti' },
        products: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              newPrice: { type: 'number', description: 'Nuovo prezzo (solo per price_cut)' },
            },
          },
          description: 'Dettagli prodotti (per price_cut con nuovo prezzo)',
        },
        reason: { type: 'string', description: 'Motivo dell\'azione' },
      },
      required: ['action', 'reason'],
    },
  },
  {
    name: 'add_rule',
    description: 'Aggiungi una regola permanente per questo tenant. Le regole vengono rispettate dal feed engine ad ogni ciclo.',
    input_schema: {
      type: 'object',
      properties: {
        rule_type: {
          type: 'string',
          enum: ['exclude_price_rule', 'exclude_brand', 'protect_sku', 'exclude_sku', 'max_price_cut_pct', 'exclude_category', 'custom'],
          description: 'Tipo di regola',
        },
        rule_config: { type: 'object', description: 'Configurazione regola (es. {price_rule_type: "sconto"} o {brand: "LDF"})' },
        reason: { type: 'string', description: 'Motivo della regola' },
      },
      required: ['rule_type', 'rule_config', 'reason'],
    },
  },
  {
    name: 'remove_rule',
    description: 'Rimuovi una regola per questo tenant',
    input_schema: {
      type: 'object',
      properties: { rule_id: { type: 'number', description: 'ID della regola da rimuovere' } },
      required: ['rule_id'],
    },
  },
  {
    name: 'recalculate_feed',
    description: 'Ricalcola il feed engine per questo tenant. Utile dopo aver aggiunto regole o eseguito azioni.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// ─── SYSTEM PROMPT ─────────────────────────────────────

function buildSystemPrompt(tenantName, rules) {
  const rulesText = rules.length > 0
    ? rules.map(r => `- ${r.rule_type}: ${r.reason || JSON.stringify(r.rule_config)}`).join('\n')
    : 'Nessuna';

  return `Sei l'assistente AI per il feed Trovaprezzi di ${tenantName}. Rispondi in italiano, sii conciso.

Hai dei tool per leggere dati e eseguire azioni. Usali SOLO quando l'utente te lo chiede. Non chiamare tool automaticamente.

Limiti: max 30% feed rimovibile per azione, prezzo mai sotto costo, taglio max 25%, margini minimi per fascia, max 500 azioni/sessione.
Regole tenant: ${rulesText}`;
}

// ─── TOOL EXECUTION ────────────────────────────────────

async function executeTool(toolName, toolInput, tenantId, sessionId, userId) {
  switch (toolName) {
    case 'get_feed_summary':
      return await toolGetFeedSummary(tenantId);
    case 'search_products':
      return await toolSearchProducts(tenantId, toolInput);
    case 'get_product_details':
      return await toolGetProductDetails(tenantId, toolInput.skus);
    case 'get_competitors':
      return await toolGetCompetitors(toolInput.sku);
    case 'get_tenant_rules':
      return await toolGetTenantRules(tenantId);
    case 'execute_action':
      return await toolExecuteAction(tenantId, sessionId, userId, toolInput);
    case 'add_rule':
      return await toolAddRule(tenantId, sessionId, userId, toolInput);
    case 'remove_rule':
      return await toolRemoveRule(tenantId, toolInput.rule_id);
    case 'recalculate_feed':
      return await toolRecalculateFeed(tenantId);
    default:
      return { error: `Tool sconosciuto: ${toolName}` };
  }
}

async function toolGetFeedSummary(tenantId) {
  const { rows: [ds] } = await pool.query(
    "SELECT * FROM feed_daily_summary WHERE tenant_id = $1 ORDER BY summary_date DESC LIMIT 1", [tenantId]
  );
  const { rows: actions } = await pool.query(
    "SELECT action, COUNT(*) as cnt FROM feed_actions WHERE tenant_id = $1 GROUP BY action", [tenantId]
  );
  const { rows: [feed] } = await pool.query(
    "SELECT COUNT(*) as cnt FROM products WHERE tenant_id = $1 AND is_civetta = true AND (COALESCE(erp_stock,0)+COALESCE(supplier_stock,0))>0", [tenantId]
  );
  const { rows: [q] } = await pool.query(
    "SELECT COUNT(*) as cnt FROM feed_quarantine WHERE tenant_id = $1 AND reactivated = false", [tenantId]
  );

  const actMap = {};
  actions.forEach(a => actMap[a.action] = parseInt(a.cnt));

  return {
    periodo: ds ? `${ds.summary_date?.toISOString?.()?.slice(0,10) || 'N/A'}` : 'N/A',
    giorniAttivi: ds?.total_clicks > 0 ? 'attivo' : 'nessun click',
    click: ds?.total_clicks || 0,
    costo: `EUR ${parseFloat(ds?.total_cost || 0).toFixed(2)}`,
    revenue: `EUR ${parseFloat(ds?.total_revenue || 0).toFixed(2)}`,
    incidenza: ds ? `${parseFloat(ds.cumulative_incidence).toFixed(1)}%` : 'N/A',
    prodottiFeed: parseInt(feed.cnt),
    quarantena: parseInt(q.cnt),
    azioni: actMap,
  };
}

async function toolSearchProducts(tenantId, input) {
  const limit = Math.min(input.limit || 20, 50);
  let where = ['p.tenant_id = $1'];
  const params = [tenantId];
  let idx = 2;

  if (input.query) {
    where.push(`(p.product_name ILIKE $${idx} OR p.sku ILIKE $${idx} OR p.brand ILIKE $${idx})`);
    params.push(`%${input.query}%`);
    idx++;
  }
  if (input.rule_type) {
    where.push(`pr.rule_type = $${idx}`);
    params.push(input.rule_type);
    idx++;
  }
  if (input.has_clicks === true) {
    where.push('phs.tp_clicks_30d > 0');
  }
  if (input.civetta === true) where.push('p.is_civetta = true');
  if (input.civetta === false) where.push('(p.is_civetta = false OR p.is_civetta IS NULL)');

  const { rows } = await pool.query(`
    SELECT p.sku, p.product_name, p.brand, p.sell_price, p.erp_cost, p.margin_pct,
           p.is_civetta, p.sales_30d_seller, p.sales_30d_aggregated,
           p.erp_stock, p.supplier_stock, pr.rule_type, pr.rule_name,
           phs.tp_clicks_30d, phs.health_score, phs.classification,
           phs.scraper_position, phs.scraper_best_price
    FROM products p
    LEFT JOIN product_health_scores phs ON phs.sku = p.sku AND phs.tenant_id = p.tenant_id
    LEFT JOIN price_rules pr ON pr.rule_id = p.price_rule_id AND pr.tenant_id = p.tenant_id
    WHERE ${where.join(' AND ')}
    ORDER BY phs.tp_clicks_30d DESC NULLS LAST, p.sales_30d_seller DESC NULLS LAST
    LIMIT ${limit}
  `, params);

  return { count: rows.length, products: rows };
}

async function toolGetProductDetails(tenantId, skus) {
  if (!skus || skus.length === 0) return { error: 'Nessun SKU fornito' };
  const { rows } = await pool.query(`
    SELECT p.sku, p.product_name, p.brand, p.category, p.sell_price, p.erp_cost,
           p.margin, p.margin_pct, p.is_civetta, p.sales_30d_seller, p.sales_30d_aggregated,
           p.erp_stock, p.supplier_stock, p.price_rule_id, pr.rule_type, pr.rule_name,
           phs.tp_clicks_30d, phs.tp_click_cost_30d, phs.health_score, phs.classification,
           phs.scraper_position, phs.scraper_competitor_count, phs.scraper_best_price,
           phs.mc_click_potential, phs.mc_benchmark_price, phs.mc_suggested_price,
           phs.ga4_tp_purchases, phs.ga4_tp_revenue, phs.ga4_assisted_sales,
           fa.action as feed_action, fa.action_reason as feed_reason
    FROM products p
    LEFT JOIN product_health_scores phs ON phs.sku = p.sku AND phs.tenant_id = p.tenant_id
    LEFT JOIN price_rules pr ON pr.rule_id = p.price_rule_id AND pr.tenant_id = p.tenant_id
    LEFT JOIN feed_actions fa ON fa.sku = p.sku AND fa.tenant_id = p.tenant_id
    WHERE p.tenant_id = $1 AND p.sku = ANY($2)
  `, [tenantId, skus]);

  return { count: rows.length, products: rows };
}

async function toolGetCompetitors(sku) {
  const { rows } = await pool.query(`
    SELECT merchant, position, base_price, shipping_cost, total_price, reviews
    FROM scraper_competitors
    WHERE product_code = $1
    ORDER BY position
    LIMIT 20
  `, [sku]);
  return { sku, competitors: rows };
}

async function toolGetTenantRules(tenantId) {
  const { rows } = await pool.query(
    "SELECT id, rule_type, rule_config, reason, created_at FROM agent_tenant_rules WHERE tenant_id = $1 AND is_active = true ORDER BY created_at",
    [tenantId]
  );
  return { count: rows.length, rules: rows };
}

async function toolExecuteAction(tenantId, sessionId, userId, input) {
  // Build action object with product details for safety check
  let action = { type: input.action, reason: input.reason };

  if (input.action === 'remove' || input.action === 'add') {
    action.skus = input.skus || [];
  }

  if (input.action === 'price_cut') {
    // Enrich with product data for safety checks
    const skus = (input.products || []).map(p => p.sku);
    const { rows: products } = await pool.query(`
      SELECT p.sku, p.sell_price, p.erp_cost, pr.rule_type, p.brand
      FROM products p
      LEFT JOIN price_rules pr ON pr.rule_id = p.price_rule_id AND pr.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.sku = ANY($2)
    `, [tenantId, skus]);

    action.products = (input.products || []).map(ip => {
      const dbProduct = products.find(p => p.sku === ip.sku) || {};
      return {
        sku: ip.sku,
        newPrice: ip.newPrice,
        currentPrice: parseFloat(dbProduct.sell_price) || 0,
        cost: parseFloat(dbProduct.erp_cost) || 0,
        ruleType: dbProduct.rule_type,
        brand: dbProduct.brand,
      };
    });
  }

  // Safety check
  const safety = await checkAction(action, tenantId, sessionId);

  if (!safety.allowed) {
    // Log blocked action
    await pool.query(
      "INSERT INTO agent_actions_log (tenant_id, session_id, user_id, action_type, action_data, safety_level, status) VALUES ($1,$2,$3,$4,$5,'blocked','rejected')",
      [tenantId, sessionId, userId, input.action, JSON.stringify(input)]
    );
    return { executed: false, blocked: true, reason: safety.reason, safetyLevel: 'blocked' };
  }

  if (safety.requiresConfirmation) {
    // Save as pending, return to Claude
    const { rows: [pending] } = await pool.query(
      "INSERT INTO agent_pending_actions (tenant_id, session_id, action_type, action_data, safety_level, reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [tenantId, sessionId, input.action, JSON.stringify(input), 'risky', input.reason]
    );
    return {
      executed: false, pendingConfirmation: true, pendingId: pending.id,
      safetyLevel: 'risky',
      message: `Azione rischiosa (${action.skus?.length || action.products?.length || 0} prodotti). Conferma per procedere.`,
    };
  }

  if (safety.requiresPassword) {
    const { rows: [pending] } = await pool.query(
      "INSERT INTO agent_pending_actions (tenant_id, session_id, action_type, action_data, safety_level, reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [tenantId, sessionId, input.action, JSON.stringify(input), 'critical', input.reason]
    );
    return {
      executed: false, requiresPassword: true, pendingId: pending.id,
      safetyLevel: 'critical',
      message: `Azione critica. Inserisci la password admin per procedere.`,
    };
  }

  // SAFE — execute immediately
  return await executeActionNow(tenantId, sessionId, userId, input);
}

async function executeActionNow(tenantId, sessionId, userId, input) {
  const results = [];

  if (input.action === 'remove') {
    for (const sku of (input.skus || [])) {
      await pool.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source, computed_at)
        VALUES ($1, $2, 'REMOVE', $3, 'agent', NOW())
        ON CONFLICT (tenant_id, sku) DO UPDATE SET action = 'REMOVE', action_reason = $3, action_source = 'agent', computed_at = NOW()
      `, [tenantId, sku, `Agent: ${input.reason}`]);

      await pool.query(`
        INSERT INTO feed_quarantine (tenant_id, sku, reason, quarantine_level, quarantine_start, quarantine_end)
        VALUES ($1, $2, $3, 1, NOW(), NOW() + INTERVAL '30 days')
        ON CONFLICT (tenant_id, sku) DO UPDATE SET reason = $3, quarantine_start = NOW(), quarantine_end = NOW() + INTERVAL '30 days', reactivated = false
      `, [tenantId, sku, `agent:${input.reason}`]);

      results.push({ sku, action: 'REMOVE', success: true });
    }
  }

  if (input.action === 'add') {
    for (const sku of (input.skus || [])) {
      await pool.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source, computed_at)
        VALUES ($1, $2, 'ADD', $3, 'agent', NOW())
        ON CONFLICT (tenant_id, sku) DO UPDATE SET action = 'ADD', action_reason = $3, action_source = 'agent', computed_at = NOW()
      `, [tenantId, sku, `Agent: ${input.reason}`]);

      // Remove from quarantine if exists
      await pool.query(
        "UPDATE feed_quarantine SET reactivated = true, reactivated_at = NOW() WHERE tenant_id = $1 AND sku = $2 AND reactivated = false",
        [tenantId, sku]
      );

      results.push({ sku, action: 'ADD', success: true });
    }
  }

  if (input.action === 'price_cut') {
    for (const p of (input.products || [])) {
      await pool.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source, current_price, recommended_price, price_cut_pct, computed_at)
        VALUES ($1, $2, 'PRICE_CUT', $3, 'agent', $4, $5, $6, NOW())
        ON CONFLICT (tenant_id, sku) DO UPDATE SET action = 'PRICE_CUT', action_reason = $3, action_source = 'agent',
          current_price = $4, recommended_price = $5, price_cut_pct = $6, computed_at = NOW()
      `, [tenantId, p.sku, `Agent: ${input.reason}`, p.currentPrice || 0, p.newPrice, p.currentPrice ? ((p.currentPrice - p.newPrice) / p.currentPrice * 100) : 0]);

      results.push({ sku: p.sku, action: 'PRICE_CUT', newPrice: p.newPrice, success: true });
    }
  }

  // Update stable cache
  try { await recalculateStableCache(tenantId); } catch {}

  // Log action
  await pool.query(
    "INSERT INTO agent_actions_log (tenant_id, session_id, user_id, action_type, action_data, safety_level, status, result, executed_at) VALUES ($1,$2,$3,$4,$5,'safe','executed',$6,NOW())",
    [tenantId, sessionId, userId, input.action, JSON.stringify(input), JSON.stringify(results)]
  );

  return { executed: true, safetyLevel: 'safe', results, count: results.length };
}

async function toolAddRule(tenantId, sessionId, userId, input) {
  const { rows: [rule] } = await pool.query(
    "INSERT INTO agent_tenant_rules (tenant_id, rule_type, rule_config, reason, created_by, session_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, rule_type, rule_config, reason",
    [tenantId, input.rule_type, JSON.stringify(input.rule_config), input.reason, userId, sessionId]
  );

  await pool.query(
    "INSERT INTO agent_actions_log (tenant_id, session_id, user_id, action_type, action_data, safety_level, status, executed_at) VALUES ($1,$2,$3,'add_rule',$4,'safe','executed',NOW())",
    [tenantId, sessionId, userId, JSON.stringify(rule)]
  );

  return { success: true, rule, message: `Regola #${rule.id} creata: ${input.rule_type} - ${input.reason}` };
}

async function toolRemoveRule(tenantId, ruleId) {
  await pool.query("UPDATE agent_tenant_rules SET is_active = false WHERE id = $1 AND tenant_id = $2", [ruleId, tenantId]);
  return { success: true, message: `Regola #${ruleId} disattivata` };
}

async function toolRecalculateFeed(tenantId) {
  const { runDailyFeedEngine } = require('./feedDailyEngine');
  const result = await runDailyFeedEngine(tenantId);
  await recalculateStableCache(tenantId);
  return {
    success: true,
    incidenza: result.snapshot.incidence.toFixed(1) + '%',
    stats: result.stats,
    message: 'Feed ricalcolato e cache aggiornata',
  };
}

// ─── MAIN CHAT FUNCTION ────────────────────────────────

async function chat(tenantId, sessionId, userId, userMessage) {
  // 1. Get API key
  const { rows: [apiKeyCfg] } = await pool.query(
    "SELECT config_value FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'claude_api_key'",
    [tenantId]
  );
  if (!apiKeyCfg) {
    // Try global key from another tenant
    const { rows: [globalKey] } = await pool.query(
      "SELECT config_value FROM tenant_configs WHERE config_key = 'claude_api_key' LIMIT 1"
    );
    if (!globalKey) throw new Error('Claude API key non configurata');
    apiKeyCfg = globalKey;
  }
  const apiKey = decrypt(apiKeyCfg.config_value);

  // 2. Get tenant context (minimal — KPIs loaded lazily via tools)
  const tenant = (await pool.query("SELECT name FROM tenants WHERE id = $1", [tenantId])).rows[0];
  const { rows: rules } = await pool.query(
    "SELECT * FROM agent_tenant_rules WHERE tenant_id = $1 AND is_active = true", [tenantId]
  );

  // 3. Load conversation history
  const { rows: history } = await pool.query(
    "SELECT role, content FROM agent_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2",
    [sessionId, MAX_HISTORY_MESSAGES]
  );
  const messages = history.reverse().map(m => ({ role: m.role, content: m.content }));

  // Add current user message
  messages.push({ role: 'user', content: userMessage });

  // 4. Save user message
  await pool.query(
    "INSERT INTO agent_messages (session_id, tenant_id, role, content) VALUES ($1,$2,'user',$3)",
    [sessionId, tenantId, userMessage]
  );
  await pool.query(
    "UPDATE agent_sessions SET messages_count = messages_count + 1, last_message_at = NOW() WHERE id = $1",
    [sessionId]
  );

  // 5. Call Claude — auto-select model
  const client = new Anthropic({ apiKey });
  let response;
  const allActions = [];
  const tier = selectModel(userMessage);
  const model = MODELS[tier];
  const maxTokens = MAX_TOKENS[tier];
  console.log(`[Agent][T:${tenantId.slice(0,8)}] Model: ${tier} (${model.split('-').slice(0,2).join('-')})`);

  // Tool use loop
  let currentMessages = [...messages];
  let iterations = 0;
  const MAX_ITERATIONS = tier === 'fast' ? 3 : tier === 'standard' ? 6 : 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: buildSystemPrompt(tenant?.name || 'Tenant', rules),
      tools: TOOLS,
      messages: currentMessages,
    });

    // If no tool use, we're done
    if (response.stop_reason !== 'tool_use') break;

    // Process tool calls
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const toolBlock of toolUseBlocks) {
      console.log(`[Agent][T:${tenantId.slice(0,8)}] Tool: ${toolBlock.name}(${JSON.stringify(toolBlock.input).substring(0, 100)})`);

      let result;
      try {
        result = await executeTool(toolBlock.name, toolBlock.input, tenantId, sessionId, userId);
        if (result.executed) allActions.push({ tool: toolBlock.name, input: toolBlock.input, result });
      } catch (err) {
        result = { error: err.message };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: JSON.stringify(result),
      });
    }

    // Add assistant message + tool results for next iteration
    currentMessages.push({ role: 'assistant', content: response.content });
    currentMessages.push({ role: 'user', content: toolResults });
  }

  // 6. Extract final text response
  const textBlocks = response.content.filter(b => b.type === 'text');
  const assistantText = textBlocks.map(b => b.text).join('\n');

  // 7. Save assistant message
  await pool.query(
    "INSERT INTO agent_messages (session_id, tenant_id, role, content, actions_taken, tokens_used, model) VALUES ($1,$2,'assistant',$3,$4,$5,$6)",
    [sessionId, tenantId, assistantText, JSON.stringify(allActions), response.usage?.output_tokens || 0, model]
  );
  await pool.query(
    "UPDATE agent_sessions SET messages_count = messages_count + 1, actions_executed = actions_executed + $1, last_message_at = NOW() WHERE id = $2",
    [allActions.length, sessionId]
  );

  // 8. Auto-generate session title from first message
  if (history.length === 0) {
    const title = userMessage.substring(0, 100);
    await pool.query("UPDATE agent_sessions SET title = $1 WHERE id = $2", [title, sessionId]);
  }

  return {
    message: assistantText,
    actions: allActions,
    tokensUsed: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    model,
    tier,
  };
}

// ─── CONFIRM / EXECUTE PENDING ─────────────────────────

async function confirmPendingAction(pendingId, tenantId, userId) {
  const { rows: [pending] } = await pool.query(
    "SELECT * FROM agent_pending_actions WHERE id = $1 AND tenant_id = $2 AND status = 'pending'",
    [pendingId, tenantId]
  );
  if (!pending) return { error: 'Azione pendente non trovata o scaduta' };

  await pool.query("UPDATE agent_pending_actions SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1", [pendingId]);
  const result = await executeActionNow(tenantId, pending.session_id, userId, pending.action_data);
  return result;
}

async function executeCriticalAction(pendingId, tenantId, userId, password) {
  // Verify password
  const valid = await verifyAdminPassword(userId, password);
  if (!valid) return { error: 'Password errata' };

  return await confirmPendingAction(pendingId, tenantId, userId);
}

module.exports = {
  chat,
  confirmPendingAction,
  executeCriticalAction,
  executeTool,
};
