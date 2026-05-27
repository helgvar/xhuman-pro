/**
 * Supervisor Weekly Deep Review — Opus 4.7 narrativo.
 *
 * Esecuzione: ogni lunedi mattina (08:00) per ogni tenant.
 * Output: report narrativo settimanale con stato del feed, andamento KPI,
 * azioni piu' impattanti, raccomandazioni strategiche per la settimana corrente.
 *
 * Salvato in supervisor_runs (run_type = 'weekly') e visibile dalla dashboard.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 6000;

// Pricing Opus 4.7 USD per 1M tokens
const PRICE_INPUT = 15.0;
const PRICE_CACHED = 1.50;
const PRICE_OUTPUT = 75.0;

async function getClient(_tenantId) {
  const { getGlobal } = require('./globalConfig');
  const apiKey = await getGlobal('claude_api_key');
  if (!apiKey) throw new Error('Claude API key non configurata (global_config.claude_api_key)');
  return new Anthropic({ apiKey });
}

const SYSTEM_PROMPT = `Sei l'analyst settimanale di xHumanPro. Scrivi un report di review settimanale per il responsabile del tenant (responsabile e-commerce farmacia online).

Tono: professionale ma diretto, senza fluff. In italiano.
Struttura il report in 5 sezioni con titoli chiari:

1. **Sintesi della settimana** (3-4 righe). Cosa e' successo: spesa TP, fatturato store, incidenza, eventi di rilievo.
2. **Cosa ha funzionato** (3-5 bullet point). Decisioni del feedEngine che hanno prodotto risultati misurabili.
3. **Cosa NON ha funzionato** (3-5 bullet point). Azioni che non hanno avuto effetto, KPI in calo, errori sistemici.
4. **3 raccomandazioni concrete per la settimana entrante** (ordinati per impatto atteso). Ogni raccomandazione deve avere: cosa, come, impatto stimato.
5. **Allarmi attivi** (lista, se presenti). Findings red/yellow non risolti.

Vincoli:
- Mai parlare di "TP-attributed revenue" come metrica di performance: usa fatturato store.
- Sii preciso sui numeri (cita cifre specifiche, non "circa", "buono", "discreto").
- Se i dati non bastano per una conclusione, dillo apertamente.
- Niente finte certezze. Niente complimenti gratuiti.
- Lunghezza target: 600-900 parole.`;

async function gatherWeeklyData(tenantId) {
  const { rows: [tenant] } = await pool.query(`SELECT name, slug FROM tenants WHERE id = $1`, [tenantId]);

  // KPI ultime 4 settimane (giornaliero)
  const { rows: kpi } = await pool.query(`
    WITH active AS (
      SELECT fetch_date d, SUM(clicks) clicks
      FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 28
      GROUP BY 1
    ),
    store AS (
      SELECT order_date::date d, COUNT(*) ords, SUM(grand_total_products) rev
      FROM orders
      WHERE tenant_id = $1 AND order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp') AND order_date::date >= CURRENT_DATE - 28
      GROUP BY 1
    ),
    cfg AS (SELECT COALESCE(MAX(config_value)::numeric, 0.27) cpc FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc')
    SELECT a.d::text date, a.clicks,
      ROUND((a.clicks * (SELECT cpc FROM cfg))::numeric, 2) cost,
      COALESCE(s.ords, 0) ords,
      ROUND(COALESCE(s.rev, 0)::numeric, 2) rev,
      CASE WHEN COALESCE(s.rev, 0) > 0
           THEN ROUND((a.clicks * (SELECT cpc FROM cfg) / s.rev * 100)::numeric, 2)
           ELSE NULL END incid_pct
    FROM active a LEFT JOIN store s USING(d) ORDER BY a.d
  `, [tenantId]);

  // Azioni feedEngine ultime 7gg
  const { rows: actions } = await pool.query(`
    SELECT action_date::date d, action_type, COUNT(*) n,
           SUM(snapshot_click_cost) cost_at_action,
           SUM(snapshot_revenue) rev_at_action
    FROM optimization_log
    WHERE tenant_id = $1 AND action_date >= NOW() - INTERVAL '7 days'
    GROUP BY 1, 2 ORDER BY 1 DESC, 2
  `, [tenantId]);

  // Esiti azioni 14gg
  const { rows: outcomes } = await pool.query(`
    SELECT action_type, outcome, COUNT(*) n,
           ROUND(AVG(followup_revenue_7d - baseline_revenue_7d)::numeric, 2) avg_delta_rev
    FROM supervisor_action_followups
    WHERE tenant_id = $1 AND evaluated_at >= NOW() - INTERVAL '14 days'
    GROUP BY 1, 2
  `, [tenantId]);

  // Findings aperti
  const { rows: findings } = await pool.query(`
    SELECT severity, category, title, description, evidence, recommended_action,
           occurrence_count, first_seen_at, last_seen_at
    FROM supervisor_findings
    WHERE tenant_id = $1 AND resolved_at IS NULL AND severity IN ('red', 'yellow')
    ORDER BY CASE severity WHEN 'red' THEN 1 ELSE 2 END, last_seen_at DESC
    LIMIT 15
  `, [tenantId]);

  // Top burner ultima settimana
  const { rows: burners } = await pool.query(`
    WITH zc AS (
      SELECT product_code sku, SUM(clicks) clicks
      FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 7
      GROUP BY 1
    ),
    ord AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) ords FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.tenant_id=$1 AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp') AND o.order_date::date >= CURRENT_DATE - 7
      GROUP BY 1
    ),
    cfg AS (SELECT COALESCE(MAX(config_value)::numeric, 0.27) cpc FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc')
    SELECT zc.sku, zc.clicks, ROUND((zc.clicks * (SELECT cpc FROM cfg))::numeric, 2) cost,
           p.is_civetta, p.margin_pct, p.sell_price
    FROM zc LEFT JOIN ord USING(sku) LEFT JOIN products p ON p.sku=zc.sku AND p.tenant_id=$1
    WHERE COALESCE(ord.ords, 0) = 0
    ORDER BY zc.clicks DESC LIMIT 10
  `, [tenantId]);

  return { tenant, kpi, actions, outcomes, findings, burners };
}

async function runWeeklyReview(tenantId) {
  const startedAt = Date.now();
  const data = await gatherWeeklyData(tenantId);

  const { rows: [run] } = await pool.query(`
    INSERT INTO supervisor_runs (tenant_id, run_type, model_used, trigger_reason, status)
    VALUES ($1, 'weekly', $2, 'weekly_scheduled', 'running')
    RETURNING id
  `, [tenantId, MODEL]);
  const runId = run.id;

  const userMessage = [
    `# Weekly review per ${data.tenant.name}`,
    `Settimana terminata: ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `## KPI giornaliero ultime 4 settimane`,
    JSON.stringify(data.kpi, null, 2),
    ``,
    `## Azioni feedEngine ultimi 7gg`,
    JSON.stringify(data.actions, null, 2),
    ``,
    `## Esiti azioni ultimi 14gg`,
    JSON.stringify(data.outcomes, null, 2),
    ``,
    `## Top burner ultimi 7gg (no ordini)`,
    JSON.stringify(data.burners, null, 2),
    ``,
    `## Allarmi (findings) attivi`,
    JSON.stringify(data.findings, null, 2),
    ``,
    `Scrivi il report seguendo la struttura definita nel system prompt.`,
  ].join('\n');

  const client = await getClient(tenantId);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const tIn = response.usage.input_tokens || 0;
  const tCached = response.usage.cache_read_input_tokens || 0;
  const tOut = response.usage.output_tokens || 0;
  const cost = (tIn * PRICE_INPUT + tCached * PRICE_CACHED + tOut * PRICE_OUTPUT) / 1_000_000;

  await pool.query(`
    UPDATE supervisor_runs SET
      llm_summary = $2, tokens_input = $3, tokens_cached = $4, tokens_output = $5,
      cost_usd = $6, duration_ms = $7, status = 'completed', completed_at = NOW()
    WHERE id = $1
  `, [runId, text, tIn, tCached, tOut, cost.toFixed(5), Date.now() - startedAt]);

  return { runId, report: text, cost: cost.toFixed(4) };
}

module.exports = { runWeeklyReview };
