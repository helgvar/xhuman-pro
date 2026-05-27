/**
 * Basket Analysis — per ogni SKU calcola le metriche del carrello in cui appare:
 *   - n_orders, total_revenue
 *   - avg_cart_value (valore medio del carrello completo, non del singolo SKU)
 *   - pct_in_large_carts (% di carrelli >= soglia config "large_cart_threshold_eur", default €90)
 *   - avg_margin_co_purchased (margine medio degli ALTRI SKU nei carrelli)
 *   - top_co_purchased_skus
 *   - traino_score (0-100) e traino_role
 *
 * Window: ultimi 90gg di ordini complete/processing.
 *
 * Output: salva in product_basket_metrics. Il rule optimizer usa questi dati per
 * non penalizzare gli SKU "traino" anche se il loro margine singolo e' basso.
 */

const { pool } = require('../db/pool');

const DEFAULT_WINDOW = 90;

async function computeBasketMetrics(tenantId, opts = {}) {
  const window = opts.windowDays || DEFAULT_WINDOW;

  // Carica soglie config per il tenant
  const { rows: cfg } = await pool.query(
    `SELECT config_key, config_value FROM health_config
     WHERE tenant_id = $1 AND config_key IN ('large_cart_threshold_eur', 'free_shipping_threshold_eur')`,
    [tenantId]
  );
  const c = {};
  for (const r of cfg) c[r.config_key] = parseFloat(r.config_value);
  const largeCartThreshold = c.large_cart_threshold_eur || 90;
  const freeShippingThreshold = c.free_shipping_threshold_eur || 59.90;

  console.log(`[BasketAnalysis] tenant ${tenantId.slice(0, 8)}: window ${window}gg, large >= €${largeCartThreshold}, free shipping >= €${freeShippingThreshold}`);

  // Big query: per ogni SKU acquistato negli ultimi 90gg, aggrega le metriche del carrello
  // in cui appare. Calcola medie del cart, pct in large cart, e info sui co-purchased.
  const startedAt = Date.now();
  const { rows } = await pool.query(`
    WITH recent_orders AS (
      SELECT o.id AS order_id, o.grand_total_products AS cart_value
      FROM orders o
      WHERE o.tenant_id = $1
        AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND o.order_date >= NOW() - ($2::int || ' days')::interval
    ),
    cart_items AS (
      SELECT oi.order_id, oi.sku, oi.row_total, oi.qty_ordered, ro.cart_value
      FROM order_items oi
      JOIN recent_orders ro ON ro.order_id = oi.order_id
    ),
    sku_basket AS (
      SELECT
        ci.sku,
        COUNT(DISTINCT ci.order_id) AS n_orders,
        SUM(ci.row_total) AS total_revenue,
        AVG(ci.cart_value) AS avg_cart_value,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ci.cart_value) AS median_cart_value,
        COUNT(DISTINCT ci.order_id) FILTER (WHERE ci.cart_value >= $3::numeric) AS n_in_large
      FROM cart_items ci
      GROUP BY ci.sku
      HAVING COUNT(DISTINCT ci.order_id) >= 2
    ),
    co_purchase AS (
      SELECT
        ci.sku AS source_sku,
        ci2.sku AS co_sku,
        COUNT(DISTINCT ci.order_id) AS n_together
      FROM cart_items ci
      JOIN cart_items ci2 ON ci2.order_id = ci.order_id AND ci2.sku != ci.sku
      GROUP BY ci.sku, ci2.sku
    ),
    co_aggregate AS (
      SELECT
        cp.source_sku AS sku,
        AVG(p.margin_pct) FILTER (WHERE p.margin_pct > 0) AS avg_margin_co,
        AVG(cnt.n_together_per_order) AS avg_co_count
      FROM co_purchase cp
      LEFT JOIN products p ON p.tenant_id = $1 AND p.sku = cp.co_sku
      LEFT JOIN (
        SELECT ci.sku, COUNT(DISTINCT ci2.sku)::numeric AS n_together_per_order
        FROM cart_items ci
        JOIN cart_items ci2 ON ci2.order_id = ci.order_id AND ci2.sku != ci.sku
        GROUP BY ci.sku, ci.order_id
      ) cnt ON cnt.sku = cp.source_sku
      GROUP BY cp.source_sku
    ),
    top_co AS (
      SELECT
        cp.source_sku AS sku,
        jsonb_agg(jsonb_build_object('sku', cp.co_sku, 'n', cp.n_together)
                  ORDER BY cp.n_together DESC) FILTER (WHERE cp.n_together > 0) AS top_skus
      FROM (
        SELECT source_sku, co_sku, n_together,
               ROW_NUMBER() OVER (PARTITION BY source_sku ORDER BY n_together DESC) rn
        FROM co_purchase
      ) cp
      WHERE rn <= 5
      GROUP BY cp.source_sku
    )
    SELECT
      sb.sku,
      sb.n_orders,
      ROUND(sb.total_revenue::numeric, 2) AS total_revenue,
      ROUND(sb.avg_cart_value::numeric, 2) AS avg_cart_value,
      ROUND(sb.median_cart_value::numeric, 2) AS median_cart_value,
      ROUND((sb.n_in_large::numeric / sb.n_orders * 100), 2) AS pct_in_large_carts,
      ROUND(ca.avg_margin_co::numeric, 2) AS avg_margin_co_purchased,
      ROUND(ca.avg_co_count::numeric, 1) AS avg_co_purchased_count,
      tc.top_skus AS top_co_purchased_skus
    FROM sku_basket sb
    LEFT JOIN co_aggregate ca USING(sku)
    LEFT JOIN top_co tc USING(sku)
  `, [tenantId, window, largeCartThreshold]);

  console.log(`[BasketAnalysis] tenant ${tenantId.slice(0, 8)}: ${rows.length} SKU analizzati in ${Date.now() - startedAt}ms`);

  // Calcola traino_score e role
  for (const r of rows) {
    const pctLarge = parseFloat(r.pct_in_large_carts) || 0;
    const avgCart = parseFloat(r.avg_cart_value) || 0;
    const avgMarginCo = parseFloat(r.avg_margin_co_purchased) || 0;
    const nOrders = parseInt(r.n_orders) || 0;

    // Score: combinazione di pct_in_large, avg_cart_value, avg_margin_co_purchased
    // 0-100. Sopra 70 = traino forte. Sotto 30 = standalone.
    let score = 0;
    if (avgCart >= largeCartThreshold) score += 40;
    else if (avgCart >= freeShippingThreshold) score += 20;
    score += Math.min(pctLarge * 0.3, 30); // max 30
    if (avgMarginCo >= 18) score += 20;
    else if (avgMarginCo >= 12) score += 10;
    if (nOrders >= 20) score += 10;
    score = Math.min(score, 100);

    let role;
    if (score >= 70) role = 'carrello_grande';
    else if (avgCart >= freeShippingThreshold && pctLarge >= 30) role = 'cross_sell';
    else if (nOrders < 5) role = 'occasional';
    else role = 'standalone';

    r.traino_score = score.toFixed(1);
    r.traino_role = role;
  }

  // Bulk upsert
  if (rows.length > 0) {
    const values = rows.map(r =>
      `('${tenantId}', '${r.sku.replace(/'/g, "''")}', ${window}, ${r.n_orders}, ${r.total_revenue || 0}, ${r.avg_cart_value || 'NULL'}, ${r.median_cart_value || 'NULL'}, ${r.pct_in_large_carts || 0}, ${r.avg_margin_co_purchased || 'NULL'}, ${r.avg_co_purchased_count || 'NULL'}, ${r.top_co_purchased_skus ? `'${JSON.stringify(r.top_co_purchased_skus).replace(/'/g, "''")}'::jsonb` : 'NULL'}, ${r.traino_score}, '${r.traino_role}', NOW())`
    ).join(',');

    await pool.query(`
      INSERT INTO product_basket_metrics
        (tenant_id, sku, window_days, n_orders, total_revenue, avg_cart_value, median_cart_value, pct_in_large_carts, avg_margin_co_purchased, avg_co_purchased_count, top_co_purchased_skus, traino_score, traino_role, computed_at)
      VALUES ${values}
      ON CONFLICT (tenant_id, sku, window_days) DO UPDATE SET
        n_orders = EXCLUDED.n_orders,
        total_revenue = EXCLUDED.total_revenue,
        avg_cart_value = EXCLUDED.avg_cart_value,
        median_cart_value = EXCLUDED.median_cart_value,
        pct_in_large_carts = EXCLUDED.pct_in_large_carts,
        avg_margin_co_purchased = EXCLUDED.avg_margin_co_purchased,
        avg_co_purchased_count = EXCLUDED.avg_co_purchased_count,
        top_co_purchased_skus = EXCLUDED.top_co_purchased_skus,
        traino_score = EXCLUDED.traino_score,
        traino_role = EXCLUDED.traino_role,
        computed_at = NOW()
    `);
  }

  return {
    tenantId,
    windowDays: window,
    skusAnalyzed: rows.length,
    durationMs: Date.now() - startedAt,
    largeCartThreshold,
    freeShippingThreshold,
  };
}

async function computeForAllTenants(opts = {}) {
  const { rows: tenants } = await pool.query(
    "SELECT id, name FROM tenants WHERE status = 'active' ORDER BY name"
  );
  const results = [];
  for (const t of tenants) {
    try {
      const r = await computeBasketMetrics(t.id, opts);
      results.push({ tenant: t.name, ...r });
    } catch (e) {
      console.error(`[BasketAnalysis] [${t.name}] FAILED:`, e.message);
      results.push({ tenant: t.name, error: e.message });
    }
  }
  return results;
}

module.exports = { computeBasketMetrics, computeForAllTenants };
