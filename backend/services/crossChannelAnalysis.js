/**
 * Cross-channel analysis: incrocia Merchant Center (Google Shopping organico),
 * GA4 attribution, vendite reali (order_items + margini imputati) e click TP.
 *
 * Per-SKU su finestra (default 30g), classifica anomalie sfruttabili.
 *
 * Anomalie:
 *   - 'wasted_serving'    MC approved + impressioni > 0 + 0 paid_clicks GA4 (servire senza ottenere traffico)
 *   - 'feed_blocked'      MC disapproved/pending ma traffico organico/diretto presente sul SKU
 *   - 'loss_leader'       paid revenue alto ma MOL < floor 15% (vendiamo a perdere su canale paid)
 *   - 'dead_stock_mc'    MC approved da 30g + 0 sales 30g (candidato pause)
 *   - 'high_ctr_low_cvr'  CTR MC > 5% ma conv_rate < 0.5% (problema landing/prezzo)
 *
 * Note GA4: i dati ga4_tp_* in product_health_scores rappresentano l'attribuzione
 * TP via session_source. Per Google Shopping (Ads) servirà google_ads_products_daily
 * (FASE 3, in attesa developer token).
 */

const { pool } = require('../db/pool');

const FLOOR_MOL_PCT = 15;

async function getCrossChannelData(tenantId, days = 30) {
  const q = `
    WITH mc_window AS (
      SELECT
        offer_id,
        SUM(clicks)::int AS mc_clicks,
        SUM(impressions)::int AS mc_impressions,
        SUM(conversions)::numeric AS mc_conversions,
        SUM(conversion_value)::numeric AS mc_conv_value,
        CASE WHEN SUM(impressions) > 0
             THEN ROUND((SUM(clicks)::numeric / NULLIF(SUM(impressions),0)) * 100, 2)
             ELSE 0 END AS mc_ctr_pct
      FROM merchant_center_daily
      WHERE tenant_id = $1
        AND report_date >= CURRENT_DATE - ($2::int || ' days')::interval
      GROUP BY offer_id
    ),
    sales_window AS (
      SELECT
        oi.sku,
        COUNT(DISTINCT oi.order_id)::int AS orders_count,
        SUM(oi.qty_ordered)::int AS qty_sold,
        SUM(COALESCE(oi.row_total_incl_tax, oi.row_total * 1.10))::numeric AS revenue,
        SUM(oi.qty_ordered * COALESCE(NULLIF(p.erp_cost,0), p.erp_cost_imputed, 0))::numeric AS cogs
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
      LEFT JOIN products p ON p.tenant_id = oi.tenant_id AND p.sku = oi.sku
      WHERE oi.tenant_id = $1
        AND o.order_date >= CURRENT_DATE - ($2::int || ' days')::interval
        AND o.order_status IN ('complete','processing','pending','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
      GROUP BY oi.sku
    ),
    tp_window AS (
      SELECT
        product_code AS offer_id,
        SUM(clicks)::int AS tp_clicks
      FROM zombie_clicks
      WHERE tenant_id = $1
        AND fetch_date >= CURRENT_DATE - ($2::int || ' days')::interval
      GROUP BY product_code
    )
    SELECT
      p.sku,
      p.product_name,
      p.sell_price::numeric AS price,
      COALESCE(NULLIF(p.erp_cost,0), p.erp_cost_imputed, 0)::numeric AS erp_cost,
      mcp.approval_status,
      mcp.offer_id,
      COALESCE(mw.mc_clicks, 0) AS mc_clicks,
      COALESCE(mw.mc_impressions, 0) AS mc_impressions,
      COALESCE(mw.mc_ctr_pct, 0) AS mc_ctr_pct,
      COALESCE(mw.mc_conversions, 0) AS mc_conversions,
      COALESCE(mw.mc_conv_value, 0) AS mc_conv_value,
      COALESCE(sw.orders_count, 0) AS orders_count,
      COALESCE(sw.qty_sold, 0) AS qty_sold,
      COALESCE(sw.revenue, 0) AS revenue,
      COALESCE(sw.cogs, 0) AS cogs,
      CASE WHEN COALESCE(sw.revenue,0) > 0
           THEN ROUND(((sw.revenue - sw.cogs) / sw.revenue) * 100, 2)
           ELSE NULL END AS mol_pct,
      COALESCE(tw.tp_clicks, 0) AS tp_clicks,
      phs.ga4_tp_purchases,
      phs.ga4_tp_revenue
    FROM merchant_center_products mcp
    LEFT JOIN products p ON p.tenant_id = mcp.tenant_id AND p.sku = mcp.offer_id
    LEFT JOIN mc_window mw ON mw.offer_id = mcp.offer_id
    LEFT JOIN sales_window sw ON sw.sku = mcp.offer_id
    LEFT JOIN tp_window tw ON tw.offer_id = mcp.offer_id
    LEFT JOIN product_health_scores phs
      ON phs.tenant_id = mcp.tenant_id AND phs.sku = mcp.offer_id
    WHERE mcp.tenant_id = $1
    ORDER BY COALESCE(sw.revenue,0) DESC NULLS LAST
  `;

  const { rows } = await pool.query(q, [tenantId, days]);
  return rows.map(r => ({ ...r, anomalies: detectAnomalies(r, days) }));
}

function detectAnomalies(r, days) {
  const out = [];
  const impressions = +r.mc_impressions || 0;
  const mcClicks = +r.mc_clicks || 0;
  const mcCtr = +r.mc_ctr_pct || 0;
  const conversions = +r.mc_conversions || 0;
  const orders = +r.orders_count || 0;
  const revenue = +r.revenue || 0;
  const mol = r.mol_pct == null ? null : +r.mol_pct;
  const approval = (r.approval_status || '').toLowerCase();

  if (approval === 'approved' && impressions > 500 && mcClicks === 0) {
    out.push({ code: 'wasted_serving', severity: 'medium', detail: `${impressions} imp, 0 click MC` });
  }

  if ((approval === 'disapproved' || approval === 'pending') && (orders > 0 || revenue > 0)) {
    out.push({ code: 'feed_blocked', severity: 'high', detail: `${approval}, ${orders} ordini persi su Shopping` });
  }

  if (mcClicks > 20 && revenue > 100 && mol != null && mol < FLOOR_MOL_PCT) {
    out.push({ code: 'loss_leader', severity: 'high', detail: `MOL ${mol}% sotto floor ${FLOOR_MOL_PCT}% su €${revenue.toFixed(0)} revenue` });
  }

  if (approval === 'approved' && orders === 0 && impressions > 100 && days >= 30) {
    out.push({ code: 'dead_stock_mc', severity: 'low', detail: `${days}g serving senza vendite` });
  }

  if (mcCtr > 5 && conversions === 0 && mcClicks > 30) {
    out.push({ code: 'high_ctr_low_cvr', severity: 'medium', detail: `CTR ${mcCtr}% ma 0 conversioni MC` });
  }

  return out;
}

async function getSummary(tenantId, days = 30) {
  const rows = await getCrossChannelData(tenantId, days);

  const byCode = {};
  let totalRevenue = 0;
  let totalRevenueWithAnomaly = 0;
  let approvedCount = 0;
  let disapprovedCount = 0;
  let pendingCount = 0;

  for (const r of rows) {
    totalRevenue += +r.revenue || 0;
    if (r.anomalies.length > 0) totalRevenueWithAnomaly += +r.revenue || 0;
    const a = (r.approval_status || '').toLowerCase();
    if (a === 'approved') approvedCount++;
    else if (a === 'disapproved') disapprovedCount++;
    else if (a === 'pending') pendingCount++;
    for (const an of r.anomalies) {
      byCode[an.code] = (byCode[an.code] || 0) + 1;
    }
  }

  return {
    days,
    sku_total: rows.length,
    mc_approved: approvedCount,
    mc_disapproved: disapprovedCount,
    mc_pending: pendingCount,
    revenue_total: +totalRevenue.toFixed(2),
    revenue_with_anomaly: +totalRevenueWithAnomaly.toFixed(2),
    anomalies_by_code: byCode,
    top_anomalies: rows
      .filter(r => r.anomalies.length > 0)
      .sort((a, b) => (+b.revenue || 0) - (+a.revenue || 0))
      .slice(0, 20),
  };
}

module.exports = { getCrossChannelData, getSummary, detectAnomalies };
