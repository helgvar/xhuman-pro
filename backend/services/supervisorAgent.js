/**
 * Supervisor Agent — Slow path LLM-driven con Sonnet 4.6.
 *
 * Quando: triggerato dal fast path (supervisorChecks.runFastPath) se almeno
 * un signal e' red o yellow.
 *
 * Cosa fa: chiama Claude Sonnet 4.6 con i signal del fast path + tool per
 * approfondire. Claude raccoglie evidenza addizionale via tool, classifica
 * i problemi, scrive findings con severity / category / recommended_action.
 *
 * Output: writes su supervisor_runs + supervisor_findings (anti-rumore via
 * fingerprint).
 */

const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_TURNS = 8;

// Pricing (USD per 1M tokens) — Sonnet 4.6
const PRICE_INPUT = 3.0;
const PRICE_CACHED = 0.30;
const PRICE_OUTPUT = 15.0;

async function getClient(_tenantId) {
  const { getGlobal } = require('./globalConfig');
  const apiKey = await getGlobal('claude_api_key');
  if (!apiKey) throw new Error('Claude API key non configurata (global_config.claude_api_key)');
  return new Anthropic({ apiKey });
}

// ─── TOOLS for the supervisor ─────────────────────────────

const TOOLS = [
  {
    name: 'get_kpi_trend',
    description: 'Ottieni la serie giornaliera di click, costo TP, ordini, fatturato e incidenza per un periodo. Utile per capire se un KPI anomalo e\' un trend o un evento isolato.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Quanti giorni indietro (max 60)' },
      },
      required: ['days'],
    },
  },
  {
    name: 'get_recent_actions',
    description: 'Ottieni le azioni recenti del feedEngine (REMOVE, PRICE_CUT, ADD, MONITOR) raggruppate per giorno. Utile per capire se il loop sta lavorando.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Quanti giorni indietro (max 14)' },
      },
      required: ['days'],
    },
  },
  {
    name: 'get_action_followups',
    description: 'Ottieni l\'esito a 7gg delle azioni REMOVE / PRICE_CUT (effective / noop / reverted). Utile per capire se le decisioni sono state azzeccate.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Quanti giorni indietro (max 30)' },
      },
      required: ['days'],
    },
  },
  {
    name: 'get_top_burners',
    description: 'Lista dei prodotti che hanno bruciato piu\' budget senza generare ordini negli ultimi N giorni. Utile per investigare picchi di spesa anomali.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number' },
        limit: { type: 'number', description: 'Default 10' },
      },
      required: ['days'],
    },
  },
  {
    name: 'get_data_health_detail',
    description: 'Dettaglio della qualita\' dei dati: prodotti con prezzo/margine/civetta non popolati, freshness GA4, ultimo zombie run, errori di sync.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'flag_finding',
    description: 'Registra un finding nel database. Usa per OGNI problema rilevato. Il fingerprint deve essere stabile (stesso problema → stesso fingerprint) per evitare duplicati.',
    input_schema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: 'ID stabile (es. cron_zombie_stale, kpi_revenue_drop_2026_04_28). Usato per dedup.' },
        severity: { type: 'string', enum: ['red', 'yellow', 'green'], description: 'red=blocco/intervento urgente, yellow=da osservare, green=ok confermato' },
        category: { type: 'string', enum: ['cron_loop', 'kpi_anomaly', 'data_health', 'action_followup', 'budget_pacing', 'business'] },
        title: { type: 'string', description: 'Titolo conciso (max 80 char)' },
        description: { type: 'string', description: 'Spiegazione del problema, max 500 char' },
        evidence: { type: 'object', description: 'Dati strutturati a supporto (numeri, ratio, esempi SKU)' },
        recommended_action: { type: 'string', description: 'Azione concreta consigliata, max 300 char' },
        auto_remediable: { type: 'boolean', description: 'true se l\'azione puo\' essere eseguita automaticamente senza approvazione umana' },
      },
      required: ['fingerprint', 'severity', 'category', 'title'],
    },
  },
];

// ─── TOOL IMPLEMENTATIONS ────────────────────────────────

async function toolGetKpiTrend(tenantId, days) {
  const d = Math.min(parseInt(days) || 14, 60);
  const { rows } = await pool.query(`
    WITH active AS (
      SELECT fetch_date d, SUM(clicks) clicks
      FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - $2::int
      GROUP BY 1
    ),
    store AS (
      SELECT order_date::date d, COUNT(*) ords, SUM(grand_total_products) rev
      FROM orders
      WHERE tenant_id = $1 AND order_status IN ('complete','processing') AND order_date::date >= CURRENT_DATE - $2::int
      GROUP BY 1
    ),
    cfg AS (SELECT COALESCE(MAX(config_value)::numeric, 0.27) cpc FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc')
    SELECT a.d, a.clicks,
           ROUND((a.clicks * (SELECT cpc FROM cfg))::numeric, 2) cost,
           COALESCE(s.ords, 0) ords,
           ROUND(COALESCE(s.rev, 0)::numeric, 2) rev,
           CASE WHEN COALESCE(s.rev, 0) > 0
                THEN ROUND((a.clicks * (SELECT cpc FROM cfg) / s.rev * 100)::numeric, 2)
                ELSE NULL END incid_pct
    FROM active a LEFT JOIN store s USING(d)
    ORDER BY a.d
  `, [tenantId, d]);
  return rows;
}

async function toolGetRecentActions(tenantId, days) {
  const d = Math.min(parseInt(days) || 7, 14);
  const { rows } = await pool.query(`
    SELECT action_date::date d, action_type, COUNT(*) n, SUM(products_affected) prods
    FROM optimization_log
    WHERE tenant_id = $1 AND action_date >= NOW() - ($2::int || ' days')::interval
    GROUP BY 1, 2 ORDER BY 1 DESC, 2
  `, [tenantId, d]);
  return rows;
}

async function toolGetActionFollowups(tenantId, days) {
  const d = Math.min(parseInt(days) || 14, 30);
  const { rows } = await pool.query(`
    SELECT action_type, outcome, COUNT(*) n,
           ROUND(AVG(EXTRACT(EPOCH FROM (evaluated_at - action_taken_at)) / 86400)::numeric, 1) avg_days_to_eval
    FROM supervisor_action_followups
    WHERE tenant_id = $1 AND action_taken_at >= NOW() - ($2::int || ' days')::interval
    GROUP BY 1, 2 ORDER BY 1, 2
  `, [tenantId, d]);
  return rows;
}

async function toolGetTopBurners(tenantId, days, limit) {
  const d = Math.min(parseInt(days) || 7, 14);
  const lim = Math.min(parseInt(limit) || 10, 30);
  const { rows } = await pool.query(`
    WITH zc AS (
      SELECT product_code sku, SUM(clicks) clicks
      FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - $2::int
      GROUP BY 1
    ),
    ord AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) ords
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status IN ('complete','processing')
        AND o.order_date::date >= CURRENT_DATE - $2::int
      GROUP BY 1
    ),
    cfg AS (SELECT COALESCE(MAX(config_value)::numeric, 0.27) cpc FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc')
    SELECT zc.sku, zc.clicks, ROUND((zc.clicks * (SELECT cpc FROM cfg))::numeric, 2) cost,
           COALESCE(ord.ords, 0) ords, p.is_civetta, p.margin_pct, p.sell_price
    FROM zc LEFT JOIN ord USING(sku)
    LEFT JOIN products p ON p.sku = zc.sku AND p.tenant_id = $1
    WHERE COALESCE(ord.ords, 0) = 0
    ORDER BY zc.clicks DESC LIMIT $3
  `, [tenantId, d, lim]);
  return rows;
}

async function toolGetDataHealthDetail(tenantId) {
  // I numeri di "products" sono SEMPRE in scope "sellable + exported" (stock>0 AND export_status!=0).
  // Mai usare il catalogo totale come scope: include SKU fuori catalogo / non esportati che sono
  // legittimamente senza prezzo. Allineato col fast path checkDataHealth (supervisorChecks.js).
  const { rows: [p] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE (COALESCE(erp_stock,0)>0 OR COALESCE(supplier_stock,0)>0)
                       AND COALESCE(raw_data->>'export_status','')!='0') AS sellable_exp_total,
      COUNT(*) FILTER (WHERE (COALESCE(erp_stock,0)>0 OR COALESCE(supplier_stock,0)>0)
                       AND COALESCE(raw_data->>'export_status','')!='0'
                       AND (sell_price=0 OR sell_price IS NULL)) AS sellable_exp_no_price,
      COUNT(*) FILTER (WHERE (COALESCE(erp_stock,0)>0 OR COALESCE(supplier_stock,0)>0)
                       AND COALESCE(raw_data->>'export_status','')!='0'
                       AND (margin_pct=0 OR margin_pct IS NULL)) AS sellable_exp_no_margin,
      COUNT(*) AS catalog_total,
      MAX(updated_at) AS last_sync
    FROM products WHERE tenant_id = $1
  `, [tenantId]);
  const sellableExpTotal = parseInt(p.sellable_exp_total) || 0;
  const noPrice = parseInt(p.sellable_exp_no_price) || 0;
  const noMargin = parseInt(p.sellable_exp_no_margin) || 0;
  const products = {
    scope: 'sellable_exported_only (stock>0 AND export_status!=0)',
    sellable_exp_total: sellableExpTotal,
    no_price: noPrice,
    no_price_pct: sellableExpTotal > 0 ? +((noPrice / sellableExpTotal) * 100).toFixed(2) : 0,
    no_margin: noMargin,
    no_margin_pct: sellableExpTotal > 0 ? +((noMargin / sellableExpTotal) * 100).toFixed(2) : 0,
    catalog_total_for_reference_only: parseInt(p.catalog_total) || 0,
    last_sync: p.last_sync,
  };
  const { rows: [g] } = await pool.query(`
    SELECT MAX(updated_at) last_calc, COUNT(*) total FROM product_health_scores WHERE tenant_id = $1
  `, [tenantId]);
  const { rows: [z] } = await pool.query(`
    SELECT MAX(fetch_date) last_fetch FROM zombie_clicks WHERE tenant_id = $1
  `, [tenantId]);
  const { rows: [zr] } = await pool.query(`
    SELECT MAX(completed_at) last_run, (array_agg(status ORDER BY completed_at DESC NULLS LAST))[1] last_status FROM zombie_runs WHERE tenant_id = $1
  `, [tenantId]);
  return { products, ga4: g, zombie: { last_fetch: z.last_fetch, last_run: zr.last_run, last_status: zr.last_status } };
}

async function flagFinding(tenantId, runId, input) {
  const fingerprint = input.fingerprint;
  const result = await pool.query(`
    INSERT INTO supervisor_findings (tenant_id, run_id, fingerprint, severity, category, title, description, evidence, recommended_action, auto_remediable)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (tenant_id, fingerprint) WHERE resolved_at IS NULL
    DO UPDATE SET
      severity = EXCLUDED.severity,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      evidence = EXCLUDED.evidence,
      recommended_action = EXCLUDED.recommended_action,
      auto_remediable = EXCLUDED.auto_remediable,
      run_id = EXCLUDED.run_id,
      last_seen_at = NOW(),
      occurrence_count = supervisor_findings.occurrence_count + 1
    RETURNING id, occurrence_count
  `, [
    tenantId, runId, fingerprint,
    input.severity, input.category, input.title,
    input.description || null, input.evidence || {},
    input.recommended_action || null, input.auto_remediable === true,
  ]);
  return { id: result.rows[0].id, occurrence: result.rows[0].occurrence_count };
}

async function executeTool(toolName, toolInput, tenantId, runId) {
  try {
    switch (toolName) {
      case 'get_kpi_trend': return await toolGetKpiTrend(tenantId, toolInput.days);
      case 'get_recent_actions': return await toolGetRecentActions(tenantId, toolInput.days);
      case 'get_action_followups': return await toolGetActionFollowups(tenantId, toolInput.days);
      case 'get_top_burners': return await toolGetTopBurners(tenantId, toolInput.days, toolInput.limit);
      case 'get_data_health_detail': return await toolGetDataHealthDetail(tenantId);
      case 'flag_finding': return await flagFinding(tenantId, runId, toolInput);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ─── PROMPT ────────────────────────────────────────────

const SYSTEM_PROMPT = `Sei il Supervisor Agent di xHumanPro, una piattaforma di ottimizzazione feed Trovaprezzi per farmacie online italiane.

Il tuo lavoro: per ogni tenant, periodicamente, valuti se i loop automatizzati (cron orders, zombie clicks, feedEngine, GA4 attribution) e i KPI di business (incidenza, spesa TP, fatturato store) sono in salute. Quando trovi un'anomalia o un blocco, registri un FINDING con il tool flag_finding.

Principi guida:
1. **Nord star = fatturato store**, non TP-attribuito (la TP-attribuita scende quando tagli burner ma il fatturato store regge — non e' un problema). Mai flaggare cali di "TP-attributed revenue" senza guardare il fatturato store totale.
2. **Incidenza target 4-5%** ma e' un guard rail, non un obiettivo: se il taglio del feed riduce incidenza ma anche il fatturato store cala, e' un FAIL — non un successo.
3. **PRIMA REGOLA SU CALI KPI: contesto business**. Cali di click/fatturato di un tenant NON sono automaticamente bug del sistema. Tipici cause commerciali:
   - **Aumento volontario dei margini** (prezzi meno competitivi → meno conversioni)
   - **Pause stagionali / chiusure fisiche** del negozio (ferie, magazzino, fornitori)
   - **Cambio strategia commerciale** (focus brand premium, dismissione categorie)
   - **Riduzione volontaria budget pubblicitario**
   Quando vedi un drop strutturale di KPI, **NON costruire teorie tecniche** del tipo "breadth penalty TP" o "regressione del feed". Flagga il drop come yellow con titolo "verificare contesto business: pricing/pause/strategia" e nota nella description: "il sistema ha rilevato un calo di X% dal giorno Y, ma prima di indagare cause tecniche conviene verificare con il responsabile del tenant se ci sono state decisioni commerciali (margini, pause, cambi prezzi)". Solo dopo aver escluso il fattore commerciale, escalate a red e proponi indagine tecnica.
4. **Anti-rumore**: ogni finding ha un fingerprint stabile. Se hai gia' flaggato lo stesso problema in run precedenti (te lo dira' il sistema), NON fare un duplicato. Se il problema persiste, semplicemente conferma severity + aggiorna evidence se cambiata.
5. **Severity discipline**:
   - 'red' = bloccante o intervento urgente entro 24h (cron fermo da >12h, dato sporco oltre soglia, errore sistemico evidente). **NON usare red per cali KPI senza prima verifica contesto business**.
   - 'yellow' = anomalia da monitorare o da chiarire con verifica umana, non urgente
   - 'green' = NON usare flag_finding per i 'green'. I green sono solo per indicare positivo nel summary.
6. **Recommended action concreta**: non "investigare", ma "verificare ZombieCron sul server xhumanpro-backend, log /var/log/...". Niente fluff. Per i finding di KPI drop: "chiedere al responsabile del tenant: cambi recenti su margini, prezzi, pause? Solo dopo escalare a indagine tecnica".
7. **Sii sintetico**: 1-3 finding al massimo per ogni run. Se vedi 10 problemi, scegli i 3 piu' importanti.
8. **Fast path signals = punto di partenza, non conclusione**. Usa i tool per approfondire prima di flaggare.
9. **Scope dati products = SEMPRE sellable+exported, mai catalogo totale**. Quando guardi get_data_health_detail, usa SOLO i campi products.sellable_exp_total, no_price, no_price_pct, no_margin, no_margin_pct. Il campo catalog_total_for_reference_only esiste solo per debug e include SKU fuori catalogo / non esportati (stock=0, export_status=0) che sono legittimamente senza prezzo. Se flaggi "X% del catalogo senza prezzo" usando il totale catalogo, produci un finding sbagliato (errore concreto fatto su Farmacri 28/4: 64% riportato vs 1.18% vero).
10. **SKU che generano click ma NON sono nel feed esportato**: e' un fenomeno residuo di TP indexing (ritardo nel de-rankizzare SKU rimossi), NON un bug del nostro filtro. Non flaggare come "SKU price=0 attivi nel feed" — sono "ancora indicizzati su TP da feed precedenti, lag di TP". Verificare via tenant_configs.stable_feed_codes se davvero sono nel feed o solo residui TP.
13. **REGOLA D'ORO: ZERO FALSI ALLARMI**. Ogni RED che produci costa tempo all'utente. Asimmetria del costo: un falso negativo costa zero (lo vedremo al run successivo o lo segnalera' la dashboard). Un falso positivo costa **tempo umano di verifica** + erosione della fiducia nel Supervisor. Quindi:
    - Soglia altissima per RED: serve almeno DUE evidenze indipendenti che confermino lo stesso problema. Se solo una metrica devia, max YELLOW.
    - Linguaggio incerto = niente flag. Mai usare "probabilmente", "potrebbe", "sembra" su un RED. Se non sei sicuro, non flaggare.
    - Anti-rumore: se lo stesso problema e' gia' aperto da meno di 48h con stessa severity, NON ri-flaggare. Solo aggiorna evidence se ci sono novita'.
    - **Preferire il falso negativo al falso positivo**. In dubbio, taci.

12. **Confronti giorno-su-giorno: normalizza per ore coperte**. Le tabelle come optimization_log, feed_action_history, agent_messages accumulano rows nel corso della giornata. Il feedEngine gira circa ogni ora — un giorno completo ha ~24 run, mentre il giorno corrente alle 10 AM ne ha solo ~10. NON flaggare "crollo X% del feedEngine" basandoti su un confronto di rows giornalieri se uno dei due giorni e' parziale (= il giorno di oggi prima delle 23:59). Per confronti validi: usa SOLO giorni completi, oppure normalizza dividendo per ore coperte. Esempio: 18k rows oggi alle 10 AM = 18k/10h × 24 = 43k stimati a fine giornata, non un crollo.

11. **Tenant non gestiti da xHumanPro**: alcuni tenant non usano il feed gestito (vedi flag feed_managed nel context). Per loro le decisioni del nostro feedEngine NON arrivano al feed reale Trovaprezzi. NON flaggare come anomalia: "feedEngine collapse", "azioni feedEngine ridotte", "quarantine non smaltita", "budget overpacing/underpacing", "follow-up azioni vuoti". Quei segnali misurano cosa il nostro sistema CONSIGLIA, non cosa effettivamente accade lato cliente. Per tenant non gestiti, monitora SOLO: salute dati (sync orders, products, GA4 attribution, scraper freshness), KPI di business store (fatturato, ordini), dati corrotti. Se vedi un drop KPI, etichetta esplicitamente "tenant non gestito — drop fuori dal nostro controllo, segnalare al cliente per verifica feed legacy / pricing".

Usa i tool per investigare. Quando hai abbastanza evidenza, chiama flag_finding per ogni problema reale (max 3 per run). Termina con un breve summary in testo (1-2 frasi) di cosa hai trovato.`;

// ─── MAIN ENTRY ────────────────────────────────────────

async function runSlowPath(tenantId, fastPathResult) {
  const startedAt = Date.now();

  // Crea il run
  const { rows: [run] } = await pool.query(`
    INSERT INTO supervisor_runs (tenant_id, run_type, model_used, trigger_reason, fast_path_signals, status)
    VALUES ($1, 'slow', $2, $3, $4, 'running')
    RETURNING id
  `, [
    tenantId, MODEL,
    `fast_path: ${fastPathResult.summary.red} red, ${fastPathResult.summary.yellow} yellow`,
    JSON.stringify(fastPathResult.signals),
  ]);
  const runId = run.id;

  // Carica findings aperti per anti-rumore
  const { rows: openFindings } = await pool.query(`
    SELECT fingerprint, severity, title, occurrence_count, last_seen_at
    FROM supervisor_findings
    WHERE tenant_id = $1 AND resolved_at IS NULL
      AND (silenced_until IS NULL OR silenced_until < NOW())
    ORDER BY last_seen_at DESC LIMIT 30
  `, [tenantId]);

  // Tenant info
  const { rows: [tenant] } = await pool.query(`SELECT name, slug FROM tenants WHERE id = $1`, [tenantId]);

  const userMessage = [
    `# Supervisor run per tenant: ${tenant.name} (${tenant.slug})`,
    `Data/ora: ${new Date().toISOString()}`,
    `Feed gestito da xHumanPro: ${fastPathResult.feedManaged === false ? 'NO — non flaggare anomalie su feedEngine/quarantine/budget (vedi regola 11)' : 'sì'}`,
    ``,
    `## Fast path signals`,
    JSON.stringify(fastPathResult.signals, null, 2),
    ``,
    `## Findings gia' aperti per questo tenant (anti-rumore: NON duplicare)`,
    openFindings.length > 0 ? JSON.stringify(openFindings, null, 2) : 'Nessuno',
    ``,
    `Investiga con i tool, poi flagga i 1-3 problemi piu' rilevanti con flag_finding. Termina con un summary di 1-2 frasi.`,
  ].join('\n');

  const client = await getClient(tenantId);
  let messages = [{ role: 'user', content: userMessage }];
  let totalIn = 0, totalCached = 0, totalOut = 0;
  let summary = '';
  let findingsFlagged = 0;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    });
    totalIn += response.usage.input_tokens || 0;
    totalCached += response.usage.cache_read_input_tokens || 0;
    totalOut += response.usage.output_tokens || 0;

    // Estrai testo + tool_use
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length > 0) summary = textBlocks.map(b => b.text).join('\n');

    if (response.stop_reason === 'end_turn' || toolUses.length === 0) break;

    // Esegui i tool
    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const tu of toolUses) {
      const result = await executeTool(tu.name, tu.input, tenantId, runId);
      if (tu.name === 'flag_finding' && !result.error) findingsFlagged++;
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 8000) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Costo
  const cost = (totalIn * PRICE_INPUT + totalCached * PRICE_CACHED + totalOut * PRICE_OUTPUT) / 1_000_000;

  // Conta findings
  const { rows: [counts] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE severity = 'red') AS red,
      COUNT(*) FILTER (WHERE severity = 'yellow') AS yellow,
      COUNT(*) AS total
    FROM supervisor_findings WHERE run_id = $1
  `, [runId]);

  await pool.query(`
    UPDATE supervisor_runs SET
      llm_summary = $2, findings_count = $3, red_count = $4, yellow_count = $5,
      tokens_input = $6, tokens_cached = $7, tokens_output = $8,
      cost_usd = $9, duration_ms = $10, status = 'completed', completed_at = NOW()
    WHERE id = $1
  `, [
    runId, summary, parseInt(counts.total) || 0,
    parseInt(counts.red) || 0, parseInt(counts.yellow) || 0,
    totalIn, totalCached, totalOut,
    cost.toFixed(5), Date.now() - startedAt,
  ]);

  return { runId, summary, findingsFlagged, cost: cost.toFixed(4), durationMs: Date.now() - startedAt };
}

module.exports = { runSlowPath };
