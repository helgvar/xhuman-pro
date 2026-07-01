/**
 * Pepite Monitor
 *
 * Cerca "pepite" nel Salva Bilancio di ciascun tenant:
 * SKU che vendono in store, hanno stock, sono attualmente in posizione TP oltre
 * il target competitivo (definito dalle regole prezzo importate da Farmabooster),
 * e che potrebbero essere portati in top competitiva mantenendo un ricarico
 * minimo accettabile.
 *
 * Cron: ogni 4 ore (00:15, 04:15, 08:15, 12:15, 16:15, 20:15 UTC).
 * Salva risultati in pepite_candidates e manda Telegram sintetico.
 *
 * Regola operativa (memory feedback_posizioni_target_da_regole_prezzo):
 * - posizioni target NON hardcoded ma lette dalle price_rules attive di tipo
 *   'ricarico' per ciascun tenant (rule_data.scraper_position).
 * - ricarico minimo di attivazione = MAX(recharge_pct) delle regole ricarico
 *   applicabili alla fascia prezzo dello SKU.
 *
 * Deps: db/pool, telegramNotifier.
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

// Fallback se nessuna regola ricarico → tipico target top 10
const DEFAULT_TARGET_POS = 10;
// Fallback ricarico minimo assoluto (mantra MOL 15%)
const DEFAULT_MIN_RICARICO = 15;

/**
 * Legge le regole prezzo attive di tipo 'ricarico' per il tenant e
 * calcola il target posizione + ricarico minimo per fascia di costo.
 */
async function getTenantRuleTargets(tenantId) {
  const { rows } = await pool.query(
    `SELECT rule_name,
            (rule_data->>'from_cost')::numeric AS from_cost,
            (rule_data->>'to_cost')::numeric AS to_cost,
            (rule_data->>'scraper_position')::int AS to_pos,
            (rule_data->>'scraper_from_position')::int AS from_pos,
            (rule_data->>'recharge_pct')::numeric AS ricarico_pct,
            (rule_data->>'brand_id') AS brand_id
     FROM price_rules
     WHERE tenant_id = $1 AND is_active = true AND rule_type = 'ricarico'
       AND (rule_data->>'scraper_position')::int > 0`,
    [tenantId]
  );
  return rows;
}

/**
 * Dato un array di regole e un costo, restituisce max target_pos e max ricarico
 * (ovvero la regola più stringente applicabile).
 */
function pickMatchingRule(rules, cost) {
  const applicable = rules.filter(r =>
    cost >= (r.from_cost || 0) && cost <= (r.to_cost || 999999)
  );
  if (applicable.length === 0) {
    return { targetPos: DEFAULT_TARGET_POS, minRicarico: DEFAULT_MIN_RICARICO, ruleName: null };
  }
  // Usa MAX posizione (per pescare il maggior numero di pepite candidate) e
  // MAX ricarico (soglia più restrittiva per la promozione).
  const targetPos = Math.max(...applicable.map(r => r.to_pos || DEFAULT_TARGET_POS));
  const minRicarico = Math.max(...applicable.map(r => r.ricarico_pct || DEFAULT_MIN_RICARICO));
  const ruleWithMaxPos = applicable.find(r => r.to_pos === targetPos);
  return { targetPos, minRicarico, ruleName: ruleWithMaxPos?.rule_name };
}

async function findPepiteForTenant(tenantId, tenantName) {
  const rules = await getTenantRuleTargets(tenantId);

  const globalMaxTargetPos = rules.length > 0
    ? Math.max(...rules.map(r => r.to_pos || DEFAULT_TARGET_POS))
    : DEFAULT_TARGET_POS;

  // Candidati grezzi: SKU sotto pos target + vendite + stock
  const { rows: candidates } = await pool.query(`
    SELECT p.sku, p.product_name, p.brand,
      p.sales_30d_seller,
      COALESCE(p.sales_30d_aggregated, 0) AS sales_30d_aggregated,
      p.erp_stock,
      phs.scraper_position,
      p.sell_price, p.erp_cost,
      phs.scraper_best_price,
      ROUND(((p.sell_price - p.erp_cost) / NULLIF(p.erp_cost,0) * 100)::numeric, 2) AS ricarico_ora
    FROM products p
    JOIN product_health_scores phs ON phs.sku = p.sku AND phs.tenant_id = p.tenant_id
    WHERE p.tenant_id = $1
      AND p.is_civetta = true
      AND p.sales_30d_seller > 0
      AND p.erp_stock > 0
      AND p.erp_cost > 0
      AND phs.scraper_position > $2
      AND phs.scraper_best_price > 0
  `, [tenantId, globalMaxTargetPos]);

  // Filtra per ricarico post-cut ≥ min richiesto per la fascia
  const pepite = [];
  for (const c of candidates) {
    const cost = parseFloat(c.erp_cost);
    const { targetPos, minRicarico, ruleName } = pickMatchingRule(rules, cost);
    // Cut: -0.01 sotto best top10 competitor
    const suggestedCut = parseFloat(c.scraper_best_price) - 0.01;
    if (suggestedCut <= cost) continue; // impossibile senza vendere sotto costo
    const ricaricoPostCut = ((suggestedCut - cost) / cost) * 100;
    if (ricaricoPostCut < minRicarico) continue; // sotto minimo di fascia
    if (parseInt(c.scraper_position) <= targetPos) continue; // già in target

    pepite.push({
      sku: c.sku,
      product_name: c.product_name,
      brand: c.brand,
      sales_30d_seller: parseInt(c.sales_30d_seller),
      sales_30d_aggregated: parseInt(c.sales_30d_aggregated),
      erp_stock: parseInt(c.erp_stock),
      scraper_position: parseInt(c.scraper_position),
      target_position: targetPos,
      sell_price: parseFloat(c.sell_price),
      erp_cost: cost,
      ricarico_ora: parseFloat(c.ricarico_ora),
      scraper_best_price: parseFloat(c.scraper_best_price),
      suggested_cut_price: +suggestedCut.toFixed(2),
      ricarico_post_cut: +ricaricoPostCut.toFixed(2),
      ricarico_min_richiesto: minRicarico,
      matched_rule_name: ruleName,
    });
  }

  // Upsert in DB. Prima: marca come 'stale' le pepite active precedenti che
  // non compaiono nel nuovo set; poi upsert delle nuove/riconfermate.
  const activeSkus = pepite.map(p => p.sku);
  if (activeSkus.length > 0) {
    await pool.query(
      `UPDATE pepite_candidates SET status='stale', last_seen_at=NOW()
       WHERE tenant_id=$1 AND status='active' AND sku NOT IN (SELECT unnest($2::text[]))`,
      [tenantId, activeSkus]
    );
  } else {
    await pool.query(
      `UPDATE pepite_candidates SET status='stale', last_seen_at=NOW()
       WHERE tenant_id=$1 AND status='active'`,
      [tenantId]
    );
  }

  for (const p of pepite) {
    await pool.query(`
      INSERT INTO pepite_candidates (
        tenant_id, sku, product_name, brand, sales_30d_seller, sales_30d_aggregated,
        erp_stock, scraper_position, target_position, sell_price, erp_cost, ricarico_ora,
        scraper_best_price, suggested_cut_price, ricarico_post_cut, ricarico_min_richiesto,
        matched_rule_name, status, last_seen_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active',NOW())
      ON CONFLICT (tenant_id, sku) WHERE status='active'
      DO UPDATE SET
        sales_30d_seller=EXCLUDED.sales_30d_seller,
        sales_30d_aggregated=EXCLUDED.sales_30d_aggregated,
        erp_stock=EXCLUDED.erp_stock,
        scraper_position=EXCLUDED.scraper_position,
        target_position=EXCLUDED.target_position,
        sell_price=EXCLUDED.sell_price,
        erp_cost=EXCLUDED.erp_cost,
        ricarico_ora=EXCLUDED.ricarico_ora,
        scraper_best_price=EXCLUDED.scraper_best_price,
        suggested_cut_price=EXCLUDED.suggested_cut_price,
        ricarico_post_cut=EXCLUDED.ricarico_post_cut,
        ricarico_min_richiesto=EXCLUDED.ricarico_min_richiesto,
        matched_rule_name=EXCLUDED.matched_rule_name,
        last_seen_at=NOW()
    `, [
      tenantId, p.sku, p.product_name, p.brand, p.sales_30d_seller, p.sales_30d_aggregated,
      p.erp_stock, p.scraper_position, p.target_position, p.sell_price, p.erp_cost, p.ricarico_ora,
      p.scraper_best_price, p.suggested_cut_price, p.ricarico_post_cut, p.ricarico_min_richiesto,
      p.matched_rule_name
    ]);
  }

  return { tenantName, found: pepite.length, targetPos: globalMaxTargetPos, pepite };
}

async function runMonitor() {
  const startedAt = Date.now();
  const { rows: tenants } = await pool.query(
    `SELECT id, name FROM tenants WHERE status='active' ORDER BY name`
  );
  const results = [];
  for (const t of tenants) {
    try {
      const r = await findPepiteForTenant(t.id, t.name);
      results.push(r);
      console.log(`[PepiteMonitor] ${t.name}: ${r.found} pepite (target pos ${r.targetPos})`);
    } catch (e) {
      console.error(`[PepiteMonitor] ${t.name} ERR: ${e.message}`);
    }
  }

  const totalFound = results.reduce((s, r) => s + r.found, 0);
  const topTenants = results
    .filter(r => r.found > 0)
    .sort((a, b) => b.found - a.found)
    .slice(0, 5);

  let msg = `💎 <b>Pepite Monitor</b>\n`;
  msg += `${totalFound} pepite candidate su ${tenants.length} tenant (${Math.round((Date.now()-startedAt)/1000)}s)\n\n`;
  if (topTenants.length > 0) {
    for (const t of topTenants) {
      msg += `• ${t.tenantName}: <b>${t.found}</b> (target pos ${t.targetPos})\n`;
      // Top 3 pepite del tenant
      const top3 = [...t.pepite].sort((a, b) => b.sales_30d_seller - a.sales_30d_seller).slice(0, 3);
      for (const p of top3) {
        msg += `   ├ ${p.sku} ${p.product_name?.slice(0,25)} — ${p.sales_30d_seller}vend, cut €${p.suggested_cut_price} (mrg ${p.ricarico_post_cut}%)\n`;
      }
    }
  } else {
    msg += `Nessuna pepita attivabile trovata questo giro.`;
  }

  try {
    await sendTelegram(msg, { key: 'pepite_monitor', parseMode: 'HTML', throttleMs: 3.5 * 3600 * 1000 });
  } catch (e) {
    console.error('[PepiteMonitor] telegram err:', e.message);
  }

  return { totalFound, tenants: results };
}

let cronStarted = false;

function startPepiteCron() {
  if (cronStarted) return;
  cronStarted = true;

  // Ogni 4h a :15 (00:15, 04:15, 08:15, 12:15, 16:15, 20:15 UTC)
  scheduleEveryHours(4, 15, async () => {
    try { await runMonitor(); }
    catch (e) { console.error('[PepiteMonitor] cron err:', e.message); }
  });

  console.log('[PepiteMonitor] Cron started: ogni 4h (:15) — pepite check tutti i tenant');
}

function scheduleEveryHours(hours, minuteOffset, fn) {
  const intervalMs = hours * 3600 * 1000;
  const now = new Date();
  const currentMs = now.getUTCHours() * 3600000 + now.getUTCMinutes() * 60000 + now.getUTCSeconds() * 1000;
  const slotAlignMs = (Math.floor(currentMs / intervalMs) + 1) * intervalMs + minuteOffset * 60000;
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const firstFire = dayStartMs + slotAlignMs;
  setTimeout(() => {
    fn();
    setInterval(fn, intervalMs);
  }, firstFire - now.getTime());
}

module.exports = {
  runMonitor,
  findPepiteForTenant,
  getTenantRuleTargets,
  startPepiteCron,
};
