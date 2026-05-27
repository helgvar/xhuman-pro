/**
 * Optimization Log — traccia ogni modifica al feed con snapshot KPI
 */

const { pool } = require('../db/pool');

/**
 * Log an optimization action with current KPI snapshot
 */
async function logAction(tenantId, actionType, description, productsAffected = 0, skusAffected = [], metadata = {}) {
  // Snapshot KPI correnti
  const { rows: [kpi] } = await pool.query(`
    SELECT
      COALESCE(SUM(ph.tp_clicks_30d), 0) as clicks,
      ROUND(COALESCE(SUM(ph.tp_click_cost_30d), 0)::numeric, 2) as click_cost,
      ROUND(COALESCE(SUM(ph.tp_attributed_revenue), 0)::numeric, 2) as revenue,
      COALESCE(SUM(ph.tp_attributed_orders), 0) as orders
    FROM product_health_scores ph
    WHERE ph.tenant_id = $1
  `, [tenantId]);

  const { rows: [feed] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE action = 'REMOVE') as removed,
      COUNT(*) FILTER (WHERE action = 'PRICE_CUT') as price_cuts,
      COUNT(*) as total
    FROM feed_actions WHERE tenant_id = $1
  `, [tenantId]);

  const { rows: [feedSize] } = await pool.query(`
    SELECT jsonb_array_length(config_value::jsonb->'codes') as n
    FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'stable_feed_codes'
  `, [tenantId]).catch(() => ({ rows: [{ n: 0 }] }));

  const clicks = parseInt(kpi.clicks) || 0;
  const clickCost = parseFloat(kpi.click_cost) || 0;
  const revenue = parseFloat(kpi.revenue) || 0;
  const orders = parseInt(kpi.orders) || 0;
  const incidence = revenue > 0 ? +(clickCost / revenue * 100).toFixed(2) : null;

  // Calcolo costo medio giornaliero (basato sui giorni con click)
  const { rows: [days] } = await pool.query(
    `SELECT COUNT(DISTINCT fetch_date) as d FROM zombie_clicks WHERE tenant_id = $1`,
    [tenantId]
  );
  const avgDailyCost = parseInt(days.d) > 0 ? +(clickCost / parseInt(days.d)).toFixed(2) : 0;

  await pool.query(`
    INSERT INTO optimization_log (
      tenant_id, action_type, description,
      snapshot_clicks, snapshot_click_cost, snapshot_revenue, snapshot_orders,
      snapshot_incidence, snapshot_avg_daily_cost,
      snapshot_products_in_feed, snapshot_products_removed, snapshot_price_cuts,
      products_affected, skus_affected, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  `, [
    tenantId, actionType, description,
    clicks, clickCost, revenue, orders,
    incidence, avgDailyCost,
    parseInt(feedSize.n) || 0, parseInt(feed.removed) || 0, parseInt(feed.price_cuts) || 0,
    productsAffected, skusAffected, JSON.stringify(metadata),
  ]);

  console.log(`[OptLog] ${actionType}: ${description} | KPI: incid=${incidence}%, rev=${revenue}, cost=${clickCost}`);
}

module.exports = { logAction };
