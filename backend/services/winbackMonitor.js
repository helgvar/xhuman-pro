/**
 * Winback Monitor (direttiva utente 3/7/2026)
 *
 * "I prodotti rimossi dal CSV vanno monitorati: se iniziano a vendere su
 *  altri canali vanno abilitati e spinti. Ti potresti trovare prodotti
 *  venduti senza click evidenti nei file di Trovaprezzi."
 *
 * Cron giornaliero 05:45 UTC (prima del refresh TP 08:00 italia):
 * cerca SKU con is_civetta=false che hanno ORDINI STORE reali negli ultimi
 * 7 giorni (vendite organiche/altri canali, senza bisogno di click TP).
 * Se hanno stock, ricarico e un atterraggio TP vendibile:
 *   - landing <= 10 col prezzo attuale -> riattiva civetta (visibile subito)
 *   - landing > 10 ma PC possibile sopra floor di fascia -> riattiva + PC
 *   - altrimenti -> solo report (non si butta dentro chi non puo' competere)
 * Ogni riattivazione e' tracciata in activation_cohorts (winback_YYYYMMDD).
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

async function runWinback() {
  const cohortName = 'winback_' + new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // Candidati: fuori dal CSV ma vendono in store (canali non-TP)
  const { rows: candidates } = await pool.query(`
    WITH vendite_7d AS (
      SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord_7d
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_date >= NOW() - INTERVAL '7 days'
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY o.tenant_id, oi.sku
    )
    SELECT t.name AS tenant_name, p.tenant_id, p.sku, p.product_name,
      ROUND(p.sell_price::numeric, 2) AS sell_price,
      ROUND(p.erp_cost::numeric, 2) AS erp_cost,
      ROUND(((p.sell_price - p.erp_cost) / p.erp_cost * 100)::numeric, 2) AS ricarico,
      p.erp_stock, v.ord_7d,
      (SELECT COUNT(*) + 1 FROM scraper_competitors sc
        WHERE sc.product_code = p.sku AND sc.total_price > 0
          AND sc.total_price < p.sell_price) AS landing,
      (SELECT sc.total_price FROM scraper_competitors sc
        WHERE sc.product_code = p.sku AND sc.total_price > 0
        ORDER BY sc.total_price ASC OFFSET 9 LIMIT 1) AS decimo_prezzo
    FROM vendite_7d v
    JOIN products p ON p.tenant_id = v.tenant_id AND p.sku = v.sku
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN feed_killers fk ON fk.sku = p.sku AND fk.tenant_id = p.tenant_id AND fk.is_active = true
    LEFT JOIN feed_quarantine fq ON fq.sku = p.sku AND fq.tenant_id = p.tenant_id AND fq.reactivated = false
    WHERE t.status = 'active'
      AND (p.is_civetta = false OR p.is_civetta IS NULL)
      AND p.saleable = true
      AND p.erp_stock >= 2
      AND p.sell_price >= 5 AND p.erp_cost > 0
      AND (p.sell_price - p.erp_cost) / p.erp_cost * 100 >= 15
      AND fk.id IS NULL AND fq.id IS NULL
      AND NOT EXISTS (SELECT 1 FROM cross_tenant_oblio ob WHERE ob.sku = p.sku AND ob.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM price_rules pr
        WHERE pr.rule_id = p.price_rule_id AND pr.tenant_id = p.tenant_id AND pr.rule_type = 'sconto')
    ORDER BY v.ord_7d DESC
    LIMIT 300
  `);

  let direct = 0, withPc = 0, skipped = 0;
  const activated = [];

  for (const c of candidates) {
    const landing = parseInt(c.landing);
    const floorMul = parseFloat(c.sell_price) < 10 ? 1.18 : 1.15;
    const floorPrice = parseFloat(c.erp_cost) * floorMul;

    if (landing <= 10) {
      // Vendibile col prezzo attuale: dentro subito
      await pool.query(
        `UPDATE products SET is_civetta = true, updated_at = NOW()
         WHERE tenant_id = $1 AND sku = $2`, [c.tenant_id, c.sku]);
      await pool.query(`
        INSERT INTO activation_cohorts (cohort_name, tenant_id, sku, sell_price, ricarico_pct, scraper_position, erp_stock, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [cohortName, c.tenant_id, c.sku, c.sell_price, c.ricarico, landing, c.erp_stock,
         `winback: ${c.ord_7d} ord/7g altri canali, landing ${landing}`]);
      direct++;
      activated.push(`${c.tenant_name} ${c.sku} (${c.ord_7d} ord, landing ${landing})`);
    } else if (c.decimo_prezzo && (parseFloat(c.decimo_prezzo) - 0.01) >= floorPrice
               && (parseFloat(c.decimo_prezzo) - 0.01) < parseFloat(c.sell_price) - 0.05) {
      // Serve un PC per entrare in top10 e il floor regge
      const newPrice = Math.round((parseFloat(c.decimo_prezzo) - 0.01) * 100) / 100;
      await pool.query(
        `UPDATE products SET is_civetta = true, updated_at = NOW()
         WHERE tenant_id = $1 AND sku = $2`, [c.tenant_id, c.sku]);
      await pool.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
          current_price, recommended_price, price_cut_pct, erp_cost, new_margin, new_margin_pct,
          status, expires_at, computed_at)
        VALUES ($1, $2, 'PRICE_CUT', $3, 'manual_pepita', $4, $5,
          ROUND((($4 - $5) / $4 * 100)::numeric, 2), $6,
          ROUND(($5 - $6)::numeric, 2), ROUND((($5 - $6) / $5 * 100)::numeric, 2),
          'pending', NOW() + INTERVAL '21 days', NOW())
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          action = 'PRICE_CUT', action_source = 'manual_pepita',
          action_reason = EXCLUDED.action_reason, recommended_price = EXCLUDED.recommended_price,
          current_price = EXCLUDED.current_price, status = 'pending',
          expires_at = EXCLUDED.expires_at, computed_at = NOW()`,
        [c.tenant_id, c.sku,
         `Winback+PC: ${c.ord_7d} ord/7g altri canali, da pos ~${landing} a top10 con €${newPrice}`,
         c.sell_price, newPrice, c.erp_cost]);
      await pool.query(`
        INSERT INTO activation_cohorts (cohort_name, tenant_id, sku, sell_price, ricarico_pct, scraper_position, erp_stock, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [cohortName, c.tenant_id, c.sku, c.sell_price, c.ricarico, landing, c.erp_stock,
         `winback+PC a €${newPrice}: ${c.ord_7d} ord/7g, landing pre ${landing}`]);
      withPc++;
      activated.push(`${c.tenant_name} ${c.sku} (${c.ord_7d} ord, PC €${newPrice})`);
    } else {
      skipped++;
    }
  }

  if (direct + withPc > 0) {
    let msg = `🔄 <b>Winback Monitor</b>\n`;
    msg += `${direct + withPc} SKU riattivati (vendono su altri canali):\n`;
    msg += `• ${direct} già competitivi (landing top10)\n`;
    msg += `• ${withPc} con PC per rientrare in top10\n`;
    msg += `• ${skipped} scartati (non competitivi senza sfondare floor)\n\n`;
    for (const a of activated.slice(0, 10)) msg += `  ${a}\n`;
    if (activated.length > 10) msg += `  … +${activated.length - 10} altri\n`;
    try { await sendTelegram(msg, { key: 'winback_monitor', parseMode: 'HTML', throttleMs: 20 * 3600 * 1000 }); } catch {}
  }
  console.log(`[WinbackMonitor] direct=${direct} withPc=${withPc} skipped=${skipped}`);
  return { direct, withPc, skipped, cohortName };
}

let cronStarted = false;

function startWinbackMonitor() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 45, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try { await runWinback(); } catch (e) { console.error('[WinbackMonitor] err:', e.message); }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[WinbackMonitor] Cron started — giornaliero 05:45 UTC (07:45 italia)');
}

module.exports = { runWinback, startWinbackMonitor };
