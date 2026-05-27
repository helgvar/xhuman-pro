/**
 * Pareto Rule analysis — quale 20% di prodotti genera l'80% del fatturato?
 *
 * Aggrega gli ordini di TUTTI i tenant (cross-tenant), per status complete/processing
 * (solo revenue incassata, esclude pending/canceled per la regola del cliente).
 *
 * Output: lista degli SKU che compongono il top X% di revenue cumulata, con
 * prezzo min/max/medio across i tenant che vendono lo stesso SKU.
 */

const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { requireRole } = require('../middleware/acl');

const router = express.Router();
router.use(authMiddleware);

// GET /api/pareto/products?days=90&cumulative_pct=80
// query params:
//   - days: finestra in giorni (default 90)
//   - cumulative_pct: soglia di revenue cumulato (default 80)
router.get('/products', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || 90), 365);
    const cumulativePct = Math.min(Math.max(parseFloat(req.query.cumulative_pct || 80), 1), 100);

    const { rows: aggregate } = await pool.query(`
      WITH revenue_per_sku AS (
        SELECT oi.sku,
               SUM(oi.row_total) AS total_revenue,
               SUM(oi.qty_ordered) AS total_qty,
               COUNT(DISTINCT o.tenant_id) AS n_tenants,
               COUNT(DISTINCT o.id) AS n_orders
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.order_status IN ('complete','processing')
          AND o.order_date >= NOW() - ($1::int || ' days')::interval
        GROUP BY oi.sku
        HAVING SUM(oi.row_total) > 0
      ),
      ranked AS (
        SELECT sku, total_revenue, total_qty, n_tenants, n_orders,
               SUM(total_revenue) OVER (ORDER BY total_revenue DESC, sku ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_revenue,
               SUM(total_revenue) OVER () AS grand_total,
               ROW_NUMBER() OVER (ORDER BY total_revenue DESC, sku ASC) AS rn,
               COUNT(*) OVER () AS total_skus
        FROM revenue_per_sku
      ),
      pareto AS (
        SELECT *, ROUND((cum_revenue / NULLIF(grand_total, 0) * 100)::numeric, 2) AS cum_pct
        FROM ranked
        WHERE (cum_revenue / NULLIF(grand_total, 0) * 100) <= $2
      ),
      tenant_prices AS (
        SELECT p.sku, p.tenant_id, t.name AS tenant_name, p.sell_price
        FROM products p
        JOIN tenants t ON t.id = p.tenant_id
        WHERE p.sku IN (SELECT sku FROM pareto) AND p.sell_price > 0 AND t.status = 'active'
      ),
      prices AS (
        SELECT tp.sku,
               MIN(tp.sell_price) AS price_min,
               MAX(tp.sell_price) AS price_max,
               ROUND(AVG(tp.sell_price)::numeric, 2) AS price_avg,
               (array_agg(tp.tenant_name ORDER BY tp.sell_price ASC, tp.tenant_name ASC))[1] AS tenant_min,
               (array_agg(tp.tenant_name ORDER BY tp.sell_price DESC, tp.tenant_name ASC))[1] AS tenant_max,
               COUNT(*) AS n_tenant_prices,
               jsonb_agg(jsonb_build_object('tenant', tp.tenant_name, 'price', tp.sell_price) ORDER BY tp.sell_price ASC) AS tenant_prices
        FROM tenant_prices tp
        GROUP BY tp.sku
      ),
      product_meta AS (
        SELECT p.sku,
               (array_agg(DISTINCT p.product_name) FILTER (WHERE p.product_name IS NOT NULL AND p.product_name != ''))[1] AS product_name,
               (array_agg(DISTINCT p.brand) FILTER (WHERE p.brand IS NOT NULL AND p.brand != ''))[1] AS brand
        FROM products p
        WHERE p.sku IN (SELECT sku FROM pareto)
        GROUP BY p.sku
      )
      SELECT par.sku,
             pm.product_name,
             pm.brand,
             ROUND(par.total_revenue::numeric, 2) AS total_revenue,
             par.total_qty,
             par.n_tenants,
             par.n_orders,
             pri.price_min,
             pri.price_max,
             pri.price_avg,
             pri.tenant_min,
             pri.tenant_max,
             pri.tenant_prices,
             ROUND(((pri.price_max - pri.price_min) / NULLIF(pri.price_min, 0) * 100)::numeric, 1) AS spread_pct,
             par.cum_pct,
             par.rn,
             par.total_skus
      FROM pareto par
      LEFT JOIN prices pri USING (sku)
      LEFT JOIN product_meta pm USING (sku)
      ORDER BY par.rn
    `, [days, cumulativePct]);

    // Tenant leaderboard: chi vende piu' prodotti che sono nei top N della Pareto
    const topN = Math.min(Math.max(parseInt(req.query.top_n || 50), 1), 500);
    const topSkus = aggregate.slice(0, topN).map(r => r.sku);
    let tenantLeaderboard = [];
    if (topSkus.length > 0) {
      const { rows: leaderboard } = await pool.query(`
        SELECT t.id AS tenant_id, t.name AS tenant_name,
               COUNT(DISTINCT oi.sku) AS skus_in_top,
               COALESCE(SUM(oi.qty_ordered), 0) AS qty_in_top,
               ROUND(COALESCE(SUM(oi.row_total), 0)::numeric, 2) AS revenue_in_top
        FROM tenants t
        LEFT JOIN orders o ON o.tenant_id = t.id
          AND o.order_status IN ('complete','processing')
          AND o.order_date >= NOW() - ($1::int || ' days')::interval
        LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.sku = ANY($2)
        WHERE t.status = 'active'
        GROUP BY t.id, t.name
        ORDER BY skus_in_top DESC, revenue_in_top DESC
      `, [days, topSkus]);
      tenantLeaderboard = leaderboard.map(r => ({
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name,
        skus_in_top: parseInt(r.skus_in_top) || 0,
        qty_in_top: parseInt(r.qty_in_top) || 0,
        revenue_in_top: parseFloat(r.revenue_in_top) || 0,
        coverage_pct: topN > 0 ? +((parseInt(r.skus_in_top) / topN) * 100).toFixed(1) : 0,
      }));
    }

    // Stats globali
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(DISTINCT oi.sku) AS unique_skus,
        ROUND(SUM(oi.row_total)::numeric, 2) AS grand_total_revenue,
        SUM(oi.qty_ordered) AS total_qty,
        COUNT(DISTINCT o.id) AS total_orders,
        COUNT(DISTINCT o.tenant_id) AS active_tenants
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_status IN ('complete','processing')
        AND o.order_date >= NOW() - ($1::int || ' days')::interval
    `, [days]);

    const totalSkus = parseInt(stats.unique_skus) || 0;
    const paretoSkus = aggregate.length;
    const paretoRevenue = aggregate.reduce((s, r) => s + parseFloat(r.total_revenue || 0), 0);
    const paretoPctSkus = totalSkus > 0 ? (paretoSkus / totalSkus) * 100 : 0;
    const paretoPctRevenue = stats.grand_total_revenue > 0
      ? (paretoRevenue / parseFloat(stats.grand_total_revenue)) * 100
      : 0;

    res.json({
      window_days: days,
      cumulative_pct_target: cumulativePct,
      stats: {
        total_unique_skus: totalSkus,
        total_revenue: parseFloat(stats.grand_total_revenue || 0),
        total_qty: parseInt(stats.total_qty || 0),
        total_orders: parseInt(stats.total_orders || 0),
        active_tenants: parseInt(stats.active_tenants || 0),
      },
      pareto: {
        skus_in_pareto: paretoSkus,
        skus_pct_of_total: +paretoPctSkus.toFixed(2),
        revenue_in_pareto: +paretoRevenue.toFixed(2),
        revenue_pct_of_total: +paretoPctRevenue.toFixed(2),
        ratio: paretoPctSkus > 0 ? +(paretoPctRevenue / paretoPctSkus).toFixed(2) : 0,
      },
      tenant_leaderboard: tenantLeaderboard,
      tenant_leaderboard_top_n: topN,
      products: aggregate,
    });
  } catch (err) {
    console.error('[Pareto] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pareto/sku/:sku/cross-tenant-prices — prezzi per uno SKU su tutti i tenant
router.get('/sku/:sku/cross-tenant-prices', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.name AS tenant_name, p.sell_price, p.erp_cost, p.margin_pct, p.is_civetta
      FROM products p
      JOIN tenants t ON t.id = p.tenant_id
      WHERE p.sku = $1 AND p.sell_price > 0 AND t.status = 'active'
      ORDER BY p.sell_price ASC, t.name ASC
    `, [req.params.sku]);
    if (rows.length === 0) return res.json({ sku: req.params.sku, prices: [], stats: null });
    const prices = rows.map(r => parseFloat(r.sell_price));
    const stats = {
      n_tenants: rows.length,
      price_min: Math.min(...prices),
      price_max: Math.max(...prices),
      price_avg: +(prices.reduce((s, p) => s + p, 0) / prices.length).toFixed(2),
      spread_pct: +(((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100).toFixed(1),
    };
    res.json({ sku: req.params.sku, prices: rows, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
