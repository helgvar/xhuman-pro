/**
 * Shopping Optimizer — Google Shopping / Merchant Center optimization service.
 *
 * Fonti dati (no Google Ads API qui — manca il dev token):
 *  - merchant_center_products: snapshot per SKU (clicks_14d, impressions, ctr,
 *    conversions, conv_value, click_potential, approval_status, issues).
 *  - merchant_center_daily: storico giornaliero per delta vs periodo precedente.
 *  - products: dati store (sales_30d, margine, stock).
 *  - product_health_scores: score aggregati e raccomandazioni xHumanPro.
 *
 * Quattro viste:
 *  1. Overview — KPI tenant 14g + delta vs 14g precedenti
 *  2. Burner Detector — SKU con click/impressions ma 0 conv = budget bruciato
 *  3. Opportunities — SKU con click_potential alto ma 0 click reali = sotto-esposti
 *  4. Feed Health — approval status, issues, "disapproved con vendite reali"
 */

const { pool } = require('../db/pool');

// ─── 1. OVERVIEW ──────────────────────────────────────

async function getOverview(tenantId) {
  // Aggregato corrente (14g — snapshot mcp)
  const { rows: [curr] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE approval_status='approved') AS sku_approved,
      COUNT(*) FILTER (WHERE approval_status='disapproved') AS sku_disapproved,
      COUNT(*) FILTER (WHERE approval_status='pending') AS sku_pending,
      COUNT(*) AS sku_total,
      COALESCE(SUM(impressions_14d), 0) AS impressions,
      COALESCE(SUM(clicks_14d), 0) AS clicks,
      COALESCE(SUM(conversions_14d), 0) AS conversions,
      COALESCE(SUM(conversion_value_14d), 0) AS conversion_value,
      CASE WHEN SUM(impressions_14d) > 0
        THEN ROUND((SUM(clicks_14d)::numeric / SUM(impressions_14d)) * 100, 2)
        ELSE 0 END AS ctr_pct,
      CASE WHEN SUM(clicks_14d) > 0
        THEN ROUND((SUM(conversions_14d)::numeric / SUM(clicks_14d)) * 100, 2)
        ELSE 0 END AS cvr_pct,
      CASE WHEN SUM(conversions_14d) > 0
        THEN ROUND(SUM(conversion_value_14d) / SUM(conversions_14d), 2)
        ELSE 0 END AS aov_eur
    FROM merchant_center_products
    WHERE tenant_id = $1
  `, [tenantId]);

  // Delta vs 14g precedenti via merchant_center_daily (28→15 gg fa vs 14→0)
  const { rows: [delta] } = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN report_date >= CURRENT_DATE - INTERVAL '14 days' THEN clicks ELSE 0 END), 0) AS clicks_curr,
      COALESCE(SUM(CASE WHEN report_date >= CURRENT_DATE - INTERVAL '28 days' AND report_date < CURRENT_DATE - INTERVAL '14 days' THEN clicks ELSE 0 END), 0) AS clicks_prev,
      COALESCE(SUM(CASE WHEN report_date >= CURRENT_DATE - INTERVAL '14 days' THEN impressions ELSE 0 END), 0) AS imp_curr,
      COALESCE(SUM(CASE WHEN report_date >= CURRENT_DATE - INTERVAL '28 days' AND report_date < CURRENT_DATE - INTERVAL '14 days' THEN impressions ELSE 0 END), 0) AS imp_prev,
      COALESCE(SUM(CASE WHEN report_date >= CURRENT_DATE - INTERVAL '14 days' THEN conversions ELSE 0 END), 0) AS conv_curr,
      COALESCE(SUM(CASE WHEN report_date >= CURRENT_DATE - INTERVAL '28 days' AND report_date < CURRENT_DATE - INTERVAL '14 days' THEN conversions ELSE 0 END), 0) AS conv_prev,
      COALESCE(SUM(CASE WHEN report_date >= CURRENT_DATE - INTERVAL '14 days' THEN conversion_value ELSE 0 END), 0) AS rev_curr,
      COALESCE(SUM(CASE WHEN report_date >= CURRENT_DATE - INTERVAL '28 days' AND report_date < CURRENT_DATE - INTERVAL '14 days' THEN conversion_value ELSE 0 END), 0) AS rev_prev
    FROM merchant_center_daily
    WHERE tenant_id = $1
      AND report_date >= CURRENT_DATE - INTERVAL '28 days'
  `, [tenantId]);

  const pctDelta = (a, b) => b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : (a > 0 ? null : 0);

  return {
    window: '14d',
    skus: {
      total: Number(curr.sku_total),
      approved: Number(curr.sku_approved),
      disapproved: Number(curr.sku_disapproved),
      pending: Number(curr.sku_pending),
    },
    traffic: {
      impressions: Number(curr.impressions),
      clicks: Number(curr.clicks),
      ctr_pct: Number(curr.ctr_pct),
      conversions: Number(curr.conversions),
      conversion_value: Number(curr.conversion_value),
      cvr_pct: Number(curr.cvr_pct),
      aov_eur: Number(curr.aov_eur),
    },
    trend_vs_prev_14d: {
      clicks_delta_pct: pctDelta(Number(delta.clicks_curr), Number(delta.clicks_prev)),
      impressions_delta_pct: pctDelta(Number(delta.imp_curr), Number(delta.imp_prev)),
      conversions_delta_pct: pctDelta(Number(delta.conv_curr), Number(delta.conv_prev)),
      revenue_delta_pct: pctDelta(Number(delta.rev_curr), Number(delta.rev_prev)),
    },
  };
}

// ─── 2. BURNER DETECTOR ───────────────────────────────

/**
 * SKU che bruciano budget Shopping: tante impressions/click MA 0 conversioni.
 * Filtriamo solo approved (per i disapproved il problema è il feed, non il SKU).
 */
async function getBurners(tenantId, { limit = 50, minClicks = 5 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      mcp.offer_id AS sku,
      COALESCE(p.product_name, mcp.mc_title) AS name,
      mcp.mc_brand AS brand,
      mcp.impressions_14d,
      mcp.clicks_14d,
      ROUND(mcp.ctr_14d * 100, 2) AS ctr_pct,
      mcp.conversions_14d,
      mcp.click_potential,
      COALESCE(p.sales_30d_seller, 0) AS store_sales_30d,
      COALESCE(p.margin_pct, 0) AS margin_pct,
      mcp.benchmark_price,
      mcp.mc_price AS current_price,
      mcp.mc_sale_price
    FROM merchant_center_products mcp
    LEFT JOIN products p ON p.tenant_id = mcp.tenant_id AND p.sku = mcp.offer_id
    WHERE mcp.tenant_id = $1
      AND mcp.approval_status = 'approved'
      AND mcp.clicks_14d >= $3
      AND mcp.conversions_14d = 0
    ORDER BY mcp.clicks_14d DESC, mcp.impressions_14d DESC
    LIMIT $2
  `, [tenantId, limit, minClicks]);

  return rows.map(r => {
    let recommendation = 'monitor';
    let reason = '';
    const clicks = Number(r.clicks_14d);
    const storeSales = Number(r.store_sales_30d);
    const margin = Number(r.margin_pct);

    if (clicks >= 20 && storeSales === 0) {
      recommendation = 'exclude_from_feed';
      reason = `${clicks} click in 14g + 0 vendite store = burner totale`;
    } else if (clicks >= 10 && storeSales <= 1) {
      recommendation = 'lower_bid';
      reason = `${clicks} click, traffico non profittevole, abbassare bid o CPC max`;
    } else if (margin > 0 && margin < 8) {
      recommendation = 'price_cut_blocked_low_margin';
      reason = `Margine ${margin.toFixed(1)}% troppo basso per giustificare promozione`;
    } else if (storeSales > 2) {
      recommendation = 'check_landing';
      reason = `${storeSales} vendite store ma 0 conv Shopping: problema landing/prezzo?`;
    } else {
      recommendation = 'monitor';
      reason = `${clicks} click, da monitorare prima di intervenire`;
    }

    return { ...r, recommendation, reason };
  });
}

// ─── 3. OPPORTUNITIES (PEPITE SHOPPING) ───────────────

/**
 * SKU con click_potential = HIGH ma clicks_14d = 0 (sotto-esposti).
 * Stiamo lasciando soldi sul tavolo. Probabilmente bid troppo basso o
 * esclusi per qualche label.
 */
async function getOpportunities(tenantId, { limit = 50 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      mcp.offer_id AS sku,
      COALESCE(p.product_name, mcp.mc_title) AS name,
      mcp.mc_brand AS brand,
      mcp.click_potential,
      mcp.click_potential_rank,
      mcp.impressions_14d,
      mcp.clicks_14d,
      mcp.mc_price AS current_price,
      mcp.benchmark_price,
      mcp.suggested_price,
      COALESCE(p.sales_30d_seller, 0) AS store_sales_30d,
      COALESCE(p.sales_30d_aggregated, 0) AS global_sales_30d,
      COALESCE(p.margin_pct, 0) AS margin_pct,
      COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0) AS stock,
      mcp.predicted_clicks_change,
      mcp.predicted_impressions_change
    FROM merchant_center_products mcp
    LEFT JOIN products p ON p.tenant_id = mcp.tenant_id AND p.sku = mcp.offer_id
    WHERE mcp.tenant_id = $1
      AND mcp.approval_status = 'approved'
      AND mcp.click_potential IN ('HIGH', 'MEDIUM')
      AND COALESCE(mcp.clicks_14d, 0) <= 2
      AND COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0) > 0
      AND COALESCE(p.margin_pct, 0) >= 10
    ORDER BY
      CASE mcp.click_potential WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
      mcp.click_potential_rank ASC NULLS LAST,
      p.sales_30d_aggregated DESC NULLS LAST
    LIMIT $2
  `, [tenantId, limit]);

  return rows.map(r => {
    let recommendation = 'boost_bid';
    let reason = '';
    const benchmark = Number(r.benchmark_price);
    const current = Number(r.current_price);
    if (benchmark > 0 && current > 0 && current > benchmark * 1.05) {
      recommendation = 'price_align_to_benchmark';
      reason = `Prezzo ${current.toFixed(2)}€ vs benchmark Google ${benchmark.toFixed(2)}€ (+${((current/benchmark - 1) * 100).toFixed(0)}%). Allineare per sbloccare impressions.`;
    } else if (Number(r.global_sales_30d) >= 5) {
      recommendation = 'boost_bid';
      reason = `Domanda globale ${r.global_sales_30d}, click_potential ${r.click_potential}, zero impressioni nostre. Aumentare bid.`;
    } else {
      recommendation = 'review_label';
      reason = `Potenziale ${r.click_potential} ma 0 esposizione: verificare custom_label/esclusioni campagna.`;
    }
    return { ...r, recommendation, reason };
  });
}

// ─── 4. FEED HEALTH ───────────────────────────────────

async function getFeedHealth(tenantId) {
  // Distribution by approval_status + issues
  const { rows: dist } = await pool.query(`
    SELECT approval_status, COUNT(*) AS n,
      COALESCE(SUM(item_issues_count), 0) AS total_issues
    FROM merchant_center_products
    WHERE tenant_id = $1
    GROUP BY approval_status
    ORDER BY n DESC
  `, [tenantId]);

  // SKU disapproved con vendite store reali (= bug feed con soldi persi)
  const { rows: lostSales } = await pool.query(`
    SELECT
      mcp.offer_id AS sku,
      COALESCE(p.product_name, mcp.mc_title) AS name,
      mcp.mc_brand AS brand,
      mcp.approval_status,
      mcp.item_issues_count,
      COALESCE(p.sales_30d_seller, 0) AS store_sales_30d,
      COALESCE(p.margin_pct, 0) AS margin_pct,
      ROUND((COALESCE(p.sales_30d_seller, 0) * COALESCE(p.sell_price, 0))::numeric, 2) AS store_revenue_30d
    FROM merchant_center_products mcp
    LEFT JOIN products p ON p.tenant_id = mcp.tenant_id AND p.sku = mcp.offer_id
    WHERE mcp.tenant_id = $1
      AND mcp.approval_status IN ('disapproved', 'pending')
      AND COALESCE(p.sales_30d_seller, 0) > 0
    ORDER BY store_revenue_30d DESC NULLS LAST
    LIMIT 50
  `, [tenantId]);

  // Top SKU "inerti": approved + impressions > 0 + 0 click in 14g
  const { rows: deadStock } = await pool.query(`
    SELECT
      mcp.offer_id AS sku,
      COALESCE(p.product_name, mcp.mc_title) AS name,
      mcp.impressions_14d,
      mcp.clicks_14d,
      ROUND(mcp.ctr_14d * 100, 4) AS ctr_pct,
      mcp.click_potential
    FROM merchant_center_products mcp
    LEFT JOIN products p ON p.tenant_id = mcp.tenant_id AND p.sku = mcp.offer_id
    WHERE mcp.tenant_id = $1
      AND mcp.approval_status = 'approved'
      AND mcp.impressions_14d >= 50
      AND mcp.clicks_14d = 0
    ORDER BY mcp.impressions_14d DESC
    LIMIT 50
  `, [tenantId]);

  const totalSku = dist.reduce((s, d) => s + Number(d.n), 0);
  return {
    distribution: dist.map(d => ({
      status: d.approval_status || 'unknown',
      count: Number(d.n),
      pct: totalSku > 0 ? Math.round((Number(d.n) / totalSku) * 1000) / 10 : 0,
      total_issues: Number(d.total_issues),
    })),
    lost_sales: lostSales,
    dead_listings: deadStock,
  };
}

module.exports = { getOverview, getBurners, getOpportunities, getFeedHealth };
