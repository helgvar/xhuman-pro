/**
 * SB Visible Sweep (direttiva utente 5/7/2026)
 *
 * "questa logica sui salvabilancio in e out la devi fare più volte al giorno"
 *
 * Ogni 4h, per ogni tenant attivo: prodotti sotto regole Salva Bilancio che
 * risultano in posizione VISIBILE (scraper_position <= 10) ma fuori dal CSV,
 * con stock, ricarico >= floor (grossista per-tenant via config, default 15%)
 * e senza lock (killer/quarantena/oblio) vengono ATTIVATI (coorte + civetta).
 * L'OUT è già gestito da strict filter + isteresi 72h + killer dinamico.
 * Cap 200/tenant/run per drenaggio graduale e misurabile.
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const CAP_PER_TENANT = 200;

async function runSbSweep() {
  // ⛔ PAUSA scraper (ordine capo 11/7): lo sweep attiva SB in base alle
  // POSIZIONI scraper — con dati monchi salta il giro (e non forza is_civetta)
  if (await require('./scraperPause').isScraperOptimizationPaused()) {
    console.log('[SbSweep] PAUSA scraper-optimization — skip');
    return;
  }
  const cohortName = 'sb_sweep_' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { rows } = await pool.query(`
    WITH csv AS (
      SELECT tc.tenant_id, jsonb_array_elements_text(tc.config_value::jsonb->'codes') AS sku
      FROM tenant_configs tc WHERE tc.config_key = 'stable_feed_codes'
    ),
    cand AS (
      SELECT p.tenant_id, t.name AS tname, p.sku, p.sell_price, p.erp_cost, p.erp_stock,
        ROUND(phs.scraper_position) AS pos,
        ROUND(((p.sell_price - p.erp_cost) / p.erp_cost * 100)::numeric, 1) AS ricarico,
        ROW_NUMBER() OVER (PARTITION BY p.tenant_id ORDER BY (p.sell_price - p.erp_cost) DESC) AS rk
      FROM products p
      JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
      JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
      JOIN product_health_scores phs ON phs.tenant_id = p.tenant_id AND phs.sku = p.sku
      LEFT JOIN csv c ON c.tenant_id = p.tenant_id AND c.sku = p.sku
      LEFT JOIN health_config hcf ON hcf.tenant_id = p.tenant_id
        AND hcf.config_key = 'ricarico_floor_grossista'
      LEFT JOIN floor_overrides fo ON fo.tenant_id = p.tenant_id AND fo.sku = p.sku
      WHERE (pr.rule_type = 'salva_bilancio' OR pr.rule_name ~* 'salva')
        AND phs.scraper_position <= 10
        AND c.sku IS NULL
        AND p.saleable = true AND (p.erp_stock + COALESCE(p.supplier_stock, 0)) > 0
        AND COALESCE(p.sell_price, 0) > 0 AND p.erp_cost > 0
        -- floor: regole grossista usano il floor per-tenant (SubitoFarma 11), altrimenti 15
        AND (p.sell_price - p.erp_cost) / p.erp_cost * 100 >=
            CASE WHEN pr.rule_name ~* 'grossist' AND p.erp_stock = 0
                 THEN COALESCE(fo.floor_pct, 15) ELSE 15 END
        AND NOT EXISTS (SELECT 1 FROM feed_killers fk WHERE fk.tenant_id = p.tenant_id AND fk.sku = p.sku AND fk.is_active)
        AND NOT EXISTS (SELECT 1 FROM feed_quarantine fq WHERE fq.tenant_id = p.tenant_id AND fq.sku = p.sku AND fq.reactivated = false)
        AND NOT EXISTS (SELECT 1 FROM cross_tenant_oblio ob WHERE ob.sku = p.sku AND ob.status = 'active')
        -- idempotenza: non ri-coortare chi è già stato attivato di recente
        AND NOT EXISTS (SELECT 1 FROM activation_cohorts ac WHERE ac.tenant_id = p.tenant_id AND ac.sku = p.sku
                        AND ac.activated_at >= NOW() - INTERVAL '14 days')
    ),
    scelti AS (SELECT * FROM cand WHERE rk <= ${CAP_PER_TENANT}),
    ins_c AS (
      INSERT INTO activation_cohorts (cohort_name, tenant_id, sku, sell_price, ricarico_pct, scraper_position, erp_stock, note)
      SELECT $1, tenant_id, sku, sell_price, ricarico, pos, erp_stock,
        'sb_sweep: pos ' || pos || ', ricarico ' || ricarico || '%'
      FROM scelti RETURNING tenant_id, sku
    ),
    upd AS (
      UPDATE products p SET is_civetta = true, updated_at = NOW()
      FROM scelti s WHERE p.tenant_id = s.tenant_id AND p.sku = s.sku
      RETURNING p.sku
    )
    SELECT s.tname, COUNT(*) AS n, ROUND(AVG(s.ricarico), 1) AS ric
    FROM scelti s GROUP BY s.tname ORDER BY n DESC
  `, [cohortName]);

  const tot = rows.reduce((a, r) => a + parseInt(r.n), 0);
  if (tot > 0) {
    const detail = rows.map(r => `${r.tname}: +${r.n} (ric ${r.ric}%)`).join(' | ');
    console.log(`[SbSweep] ${tot} SB visibili attivati — ${detail}`);
    try {
      await sendTelegram(`💎 <b>SB Sweep</b>: +${tot} pepite visibili nel feed\n${detail}`,
        { key: 'sb_sweep', parseMode: 'HTML', throttleMs: 3 * 3600 * 1000 });
    } catch {}
  } else {
    console.log('[SbSweep] nessun nuovo SB visibile da attivare');
  }
  return { tot, rows };
}

let cronStarted = false;

function startSbSweep() {
  if (cronStarted) return;
  cronStarted = true;
  setTimeout(() => {
    runSbSweep().catch(e => console.error('[SbSweep] err:', e.message));
    setInterval(() => {
      runSbSweep().catch(e => console.error('[SbSweep] err:', e.message));
    }, 4 * 60 * 60 * 1000);
  }, 15 * 60 * 1000);
  console.log('[SbSweep] Cron started — ogni 4h, primo run tra 15 min');
}

module.exports = { runSbSweep, startSbSweep };
