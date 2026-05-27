/**
 * AI Daily Explainer
 *
 * Per ogni tenant con toggle `claude_optimizer_enabled='true'`:
 *  1. Raccoglie KPI di ieri / 7gg / 30gg
 *  2. Identifica top 3 anomalie operative (burner, sotto MOL, incidence drift)
 *  3. Chiama Claude Sonnet con context strutturato
 *  4. Salva nota in agent_daily_notes
 *  5. Manda su Telegram (se token/chat_id configurati)
 *
 * Idempotente: 1 nota al giorno per tenant (UNIQUE constraint).
 * Cost guard: max_tokens 800, modello sonnet (€~0.003 per nota).
 */

const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 800;
const DEFAULT_CPC = 0.2773;

const SYSTEM_PROMPT = `Sei un analista senior di e-commerce farmacie italiane.
Stai osservando i KPI giornalieri di UN tenant (UNA farmacia). Scrivi una nota giornaliera
in italiano per il responsabile operativo, breve e utile.

REGOLE:
- 4-6 frasi totali, max 80 parole.
- Tono colloquiale ma preciso, italiano.
- Apri con 1 frase di stato generale ("Giornata regolare", "Calo del 23%", "Spesa fuori controllo su X").
- Cita massimo 2 numeri concreti (es. "incidenza 6.91%", "MOL 13.6%").
- Chiudi con 1 suggerimento azionabile concreto (un SKU, una regola, una soglia da cambiare).
- NON ripetere i dati grezzi, NON fare elenchi puntati, NON usare emoji, NON aprire con saluti.
- Se i dati sono sospetti (es. feed appena ripristinato, budget esaurito), segnalalo prima di consigliare azioni.`;

async function readGlobalConfig(key) {
  const { rows: [row] } = await pool.query(
    `SELECT config_value FROM global_config WHERE config_key=$1`, [key]
  );
  if (!row) return null;
  try { return decrypt(row.config_value); } catch { return row.config_value; }
}

async function readTenantConfig(tenantId, key) {
  const { rows: [row] } = await pool.query(
    `SELECT config_value FROM tenant_configs WHERE tenant_id=$1 AND config_key=$2`,
    [tenantId, key]
  );
  if (!row) return null;
  try { return decrypt(row.config_value); } catch { return row.config_value; }
}

async function getCpc(tenantId) {
  const { rows: [r] } = await pool.query(
    `SELECT avg_tp_cpc FROM health_config WHERE tenant_id=$1`, [tenantId]
  ).catch(() => ({ rows: [] }));
  const v = parseFloat(r?.avg_tp_cpc);
  return isFinite(v) && v > 0 && v < 5 ? v : DEFAULT_CPC;
}

async function getClaudeClient() {
  const apiKey = await readGlobalConfig('claude_api_key');
  if (!apiKey) throw new Error('claude_api_key non configurata in global_config');
  return new Anthropic({ apiKey });
}

async function isTenantEnabled(tenantId) {
  const v = await readTenantConfig(tenantId, 'claude_optimizer_enabled');
  return v === 'true';
}

async function getEnabledTenants() {
  const { rows } = await pool.query(
    `SELECT t.id, t.name FROM tenants t
     JOIN tenant_configs tc ON tc.tenant_id = t.id
     WHERE t.status='active'
       AND tc.config_key='claude_optimizer_enabled'
       AND tc.config_value='true'
     ORDER BY t.name`
  );
  return rows;
}

async function collectKPI(tenantId) {
  const cpc = await getCpc(tenantId);

  const { rows: [k] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM orders WHERE tenant_id=$1 AND order_date::date = CURRENT_DATE - 1
        AND order_status IN ('complete','processing','pending','Ritirato','ritiro_farmacia','ritiro_sede_tmp')) AS ord_yest,
      (SELECT SUM(COALESCE(grand_total, grand_total_products)) FROM orders WHERE tenant_id=$1 AND order_date::date = CURRENT_DATE - 1
        AND order_status IN ('complete','processing','pending','Ritirato','ritiro_farmacia','ritiro_sede_tmp')) AS rev_yest,
      (SELECT SUM(COALESCE(grand_total, grand_total_products)) FROM orders WHERE tenant_id=$1 AND order_date > NOW() - INTERVAL '7 days'
        AND order_status IN ('complete','processing','pending','Ritirato','ritiro_farmacia','ritiro_sede_tmp')) AS rev_7d,
      (SELECT SUM(COALESCE(grand_total, grand_total_products)) FROM orders WHERE tenant_id=$1 AND order_date > NOW() - INTERVAL '30 days'
        AND order_status IN ('complete','processing','pending','Ritirato','ritiro_farmacia','ritiro_sede_tmp')) AS rev_30d,
      (SELECT SUM(clicks) FROM zombie_clicks WHERE tenant_id=$1 AND fetch_date = CURRENT_DATE - 1) AS tp_yest,
      (SELECT SUM(clicks) FROM zombie_clicks WHERE tenant_id=$1 AND fetch_date > CURRENT_DATE - 7) AS tp_7d,
      (SELECT SUM(clicks) FROM zombie_clicks WHERE tenant_id=$1 AND fetch_date > CURRENT_DATE - 30) AS tp_30d
  `, [tenantId]);

  const { rows: [m] } = await pool.query(`
    SELECT
      SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.10))::numeric AS rev,
      SUM(oi.qty_ordered * COALESCE(NULLIF(p.erp_cost,0), p.erp_cost_imputed, 0))::numeric AS cogs
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    LEFT JOIN products p ON p.tenant_id=oi.tenant_id AND p.sku=oi.sku
    WHERE oi.tenant_id=$1
      AND o.order_date > NOW() - INTERVAL '7 days'
      AND o.order_status IN ('complete','processing','pending','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
  `, [tenantId]);

  const { rows: burners } = await pool.query(`
    WITH tp AS (
      SELECT product_code, SUM(clicks) clk
      FROM zombie_clicks WHERE tenant_id=$1 AND fetch_date > CURRENT_DATE - 7
      GROUP BY product_code HAVING SUM(clicks) >= 5
    ),
    ord AS (
      SELECT oi.sku, COUNT(DISTINCT oi.order_id) n
      FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE oi.tenant_id=$1 AND o.order_date > NOW() - INTERVAL '7 days'
      GROUP BY oi.sku
    )
    SELECT tp.product_code AS sku, tp.clk,
      COALESCE(LEFT(p.product_name, 35), '?') AS name
    FROM tp LEFT JOIN ord ON ord.sku=tp.product_code
    LEFT JOIN products p ON p.tenant_id=$1 AND p.sku=tp.product_code
    WHERE COALESCE(ord.n, 0)=0
    ORDER BY tp.clk DESC LIMIT 3
  `, [tenantId]);

  const { rows: underFloor } = await pool.query(`
    SELECT oi.sku, LEFT(oi.product_name, 35) name,
      ROUND(SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.10))::numeric, 0) rev,
      ROUND( ((SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.10)) - SUM(oi.qty_ordered * COALESCE(NULLIF(p.erp_cost,0), p.erp_cost_imputed, 0))) / NULLIF(SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.10)),0) * 100)::numeric, 1) mol_pct
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    LEFT JOIN products p ON p.tenant_id=oi.tenant_id AND p.sku=oi.sku
    WHERE oi.tenant_id=$1 AND o.order_date > NOW() - INTERVAL '7 days'
      AND o.order_status IN ('complete','processing','pending','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
    GROUP BY oi.sku, oi.product_name
    HAVING SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.10)) > 150
    ORDER BY mol_pct ASC NULLS LAST LIMIT 3
  `, [tenantId]);

  const tpCost7d = (+k.tp_7d || 0) * cpc;
  const rev7d = parseFloat(k.rev_7d) || 0;
  const incidPct = rev7d > 0 ? (tpCost7d / rev7d) * 100 : null;
  const molRev = parseFloat(m?.rev) || 0;
  const molCogs = parseFloat(m?.cogs) || 0;
  const molPct = molRev > 0 ? ((molRev - molCogs) / molRev) * 100 : null;

  return {
    cpc,
    ord_yest: +k.ord_yest || 0,
    rev_yest: +parseFloat(k.rev_yest || 0).toFixed(0),
    rev_7d: +rev7d.toFixed(0),
    rev_30d: +parseFloat(k.rev_30d || 0).toFixed(0),
    tp_clicks_yest: +k.tp_yest || 0,
    tp_clicks_7d: +k.tp_7d || 0,
    tp_clicks_30d: +k.tp_30d || 0,
    tp_cost_7d: +tpCost7d.toFixed(2),
    incidence_pct_7d: incidPct == null ? null : +incidPct.toFixed(2),
    mol_pct_7d: molPct == null ? null : +molPct.toFixed(1),
    burners_7d: burners,
    under_floor_7d: underFloor,
  };
}

function buildUserPrompt(tenantName, kpi) {
  const lines = [
    `Tenant: ${tenantName}`,
    `Data riferimento: ieri (${new Date(Date.now()-86400000).toISOString().slice(0,10)})`,
    ``,
    `KPI:`,
    `- Ordini ieri: ${kpi.ord_yest}`,
    `- Revenue ieri: €${kpi.rev_yest}`,
    `- Revenue 7gg: €${kpi.rev_7d}, 30gg: €${kpi.rev_30d}`,
    `- TP click ieri: ${kpi.tp_clicks_yest}, 7gg: ${kpi.tp_clicks_7d}, 30gg: ${kpi.tp_clicks_30d}`,
    `- Costo TP stimato 7gg: €${kpi.tp_cost_7d}`,
    `- Incidenza 7gg: ${kpi.incidence_pct_7d ?? 'n/d'}% (target massimo 5%)`,
    `- MOL 7gg: ${kpi.mol_pct_7d ?? 'n/d'}% (floor 15%, standard 20%)`,
    ``,
  ];
  if (kpi.burners_7d.length) {
    lines.push(`Top burner 7gg (click ma 0 ordini):`);
    kpi.burners_7d.forEach(b => lines.push(`  - ${b.sku} ${b.name} -> ${b.clk} click sprecati`));
    lines.push('');
  }
  if (kpi.under_floor_7d.length) {
    lines.push(`Top SKU sotto floor MOL 15% (con revenue):`);
    kpi.under_floor_7d.forEach(u => lines.push(`  - ${u.sku} ${u.name} -> €${u.rev} rev, MOL ${u.mol_pct}%`));
    lines.push('');
  }
  lines.push(`Scrivi la nota del giorno per questo tenant.`);
  return lines.join('\n');
}

const PRICE_IN = 3 / 1_000_000;
const PRICE_OUT = 15 / 1_000_000;

async function generateNote(tenantId, tenantName) {
  const client = await getClaudeClient();
  const kpi = await collectKPI(tenantId);
  const userPrompt = buildUserPrompt(tenantName, kpi);

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const noteText = msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  const cost = (msg.usage.input_tokens * PRICE_IN) + (msg.usage.output_tokens * PRICE_OUT);
  return {
    noteText,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cost,
    kpi,
  };
}

async function trySendTelegram(tenantId, tenantName, noteText, costInfo) {
  // Prima cerca config per-tenant, poi global come fallback
  const botToken =
    (await readTenantConfig(tenantId, 'telegram_bot_token')) ||
    (await readGlobalConfig('telegram_bot_token'));
  const chatId =
    (await readTenantConfig(tenantId, 'telegram_chat_id')) ||
    (await readGlobalConfig('telegram_chat_id'));
  if (!botToken || !chatId) return false;

  const escaped = noteText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = `<b>${tenantName}</b> — nota AI del giorno\n\n${escaped}\n\n<i>$${costInfo.cost.toFixed(4)} • ${costInfo.inputTokens}→${costInfo.outputTokens} tok</i>`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Telegram ${res.status}: ${errBody.slice(0, 200)}`);
  }
  return true;
}

async function runDailyExplainerForTenant(tenantId, tenantName) {
  const { rows: [existing] } = await pool.query(
    `SELECT id FROM agent_daily_notes WHERE tenant_id=$1 AND note_date=CURRENT_DATE`,
    [tenantId]
  );
  if (existing) {
    console.log(`[AIDailyExplainer] [${tenantName}] gia generato per oggi, skip`);
    return { skipped: true };
  }

  console.log(`[AIDailyExplainer] [${tenantName}] generating note...`);
  const { noteText, inputTokens, outputTokens, cost, kpi } = await generateNote(tenantId, tenantName);

  await pool.query(
    `INSERT INTO agent_daily_notes
       (tenant_id, note_date, model, input_tokens, output_tokens, cost_usd_estimated, kpi_snapshot, note_text)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, note_date) DO UPDATE SET
       note_text = EXCLUDED.note_text,
       kpi_snapshot = EXCLUDED.kpi_snapshot,
       input_tokens = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens,
       cost_usd_estimated = EXCLUDED.cost_usd_estimated`,
    [tenantId, MODEL, inputTokens, outputTokens, cost.toFixed(4), JSON.stringify(kpi), noteText]
  );

  let telegramSent = false;
  try {
    telegramSent = await trySendTelegram(tenantId, tenantName, noteText, { cost, inputTokens, outputTokens });
    if (telegramSent) {
      await pool.query(
        `UPDATE agent_daily_notes SET telegram_sent=true WHERE tenant_id=$1 AND note_date=CURRENT_DATE`,
        [tenantId]
      );
    }
  } catch (tgErr) {
    console.error(`[AIDailyExplainer] [${tenantName}] Telegram error:`, tgErr.message);
  }

  console.log(`[AIDailyExplainer] [${tenantName}] OK $${cost.toFixed(4)}, ${inputTokens}→${outputTokens} tok, tg=${telegramSent}`);
  return { noteText, cost, inputTokens, outputTokens, telegramSent };
}

async function runDailyExplainerAllTenants() {
  const tenants = await getEnabledTenants();
  console.log(`[AIDailyExplainer] Running for ${tenants.length} enabled tenant(s): ${tenants.map(t => t.name).join(', ') || '(none)'}`);
  const results = [];
  for (const t of tenants) {
    try {
      const r = await runDailyExplainerForTenant(t.id, t.name);
      results.push({ tenant: t.name, ...r });
    } catch (err) {
      console.error(`[AIDailyExplainer] [${t.name}] error:`, err.message);
      results.push({ tenant: t.name, error: err.message });
    }
  }
  return results;
}

module.exports = {
  isTenantEnabled,
  getEnabledTenants,
  runDailyExplainerForTenant,
  runDailyExplainerAllTenants,
  collectKPI,
};
