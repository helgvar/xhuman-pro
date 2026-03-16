const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { importMerchantCenter } = require('../services/merchantCenter');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// POST /api/merchant-center/import - Trigger MC data import
router.post('/import', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Check running
    const { rows: running } = await pool.query(
      `SELECT id FROM merchant_center_runs WHERE tenant_id = $1 AND status = 'running'`,
      [tenantId]
    );
    if (running.length > 0) {
      return res.status(409).json({ error: 'Import Merchant Center già in corso' });
    }

    // Run in background
    importMerchantCenter(tenantId).catch(err => {
      console.error('[MerchantCenter] Background import error:', err.message);
    });

    res.json({ message: 'Import Merchant Center avviato' });
  } catch (err) {
    console.error('[MerchantCenter] Import trigger error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/merchant-center/runs - Import run history
router.get('/runs', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM merchant_center_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [req.tenantId]
    );
    res.json({ runs: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/merchant-center/stats - Overview stats
router.get('/stats', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const { rows: [stats] } = await pool.query(
      `SELECT
         COUNT(*) as total_products,
         COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as approved_count,
         COUNT(CASE WHEN approval_status = 'disapproved' THEN 1 END) as disapproved_count,
         COUNT(CASE WHEN benchmark_price IS NOT NULL THEN 1 END) as with_benchmark,
         COUNT(CASE WHEN suggested_price IS NOT NULL THEN 1 END) as with_insights,
         COUNT(CASE WHEN mc_sale_price < benchmark_price THEN 1 END) as below_benchmark,
         COUNT(CASE WHEN mc_sale_price > benchmark_price THEN 1 END) as above_benchmark,
         COUNT(CASE WHEN clicks_14d > 0 THEN 1 END) as with_clicks,
         COALESCE(SUM(clicks_14d), 0) as total_clicks_14d,
         COALESCE(SUM(impressions_14d), 0) as total_impressions_14d,
         COALESCE(AVG(CASE WHEN ctr_14d > 0 THEN ctr_14d END), 0) as avg_ctr,
         MAX(updated_at) as last_update
       FROM merchant_center_products WHERE tenant_id = $1`,
      [tenantId]
    );

    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/merchant-center/overview - Full overview for Statistiche page
router.get('/overview', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // MC stats
    const { rows: [mcStats] } = await pool.query(
      `SELECT
         COUNT(*) as mc_total,
         COUNT(CASE WHEN approval_status = 'approved' THEN 1 END) as mc_approved,
         COUNT(CASE WHEN approval_status = 'disapproved' THEN 1 END) as mc_disapproved,
         COUNT(CASE WHEN approval_status NOT IN ('approved','disapproved') OR approval_status IS NULL OR approval_status = '' THEN 1 END) as mc_pending,
         COUNT(CASE WHEN benchmark_price IS NOT NULL THEN 1 END) as with_benchmark,
         COUNT(CASE WHEN suggested_price IS NOT NULL THEN 1 END) as with_insights,
         COUNT(CASE WHEN mc_sale_price > 0 AND benchmark_price > 0 AND mc_sale_price < benchmark_price THEN 1 END) as below_benchmark,
         COUNT(CASE WHEN mc_sale_price > 0 AND benchmark_price > 0 AND mc_sale_price > benchmark_price THEN 1 END) as above_benchmark,
         COUNT(CASE WHEN mc_sale_price > 0 AND benchmark_price > 0 AND mc_sale_price = benchmark_price THEN 1 END) as at_benchmark,
         COUNT(CASE WHEN clicks_14d > 0 THEN 1 END) as with_clicks,
         COALESCE(SUM(clicks_14d), 0) as total_clicks_14d,
         COALESCE(SUM(impressions_14d), 0) as total_impressions_14d,
         COALESCE(AVG(CASE WHEN ctr_14d > 0 THEN ctr_14d END), 0) as avg_ctr,
         COUNT(CASE WHEN click_potential = 'HIGH' THEN 1 END) as high_potential,
         COUNT(CASE WHEN click_potential = 'MEDIUM' THEN 1 END) as medium_potential,
         COUNT(CASE WHEN click_potential = 'LOW' THEN 1 END) as low_potential,
         MAX(updated_at) as mc_last_update
       FROM merchant_center_products WHERE tenant_id = $1`,
      [tenantId]
    );

    // Top products by clicks (MC)
    const { rows: topClicksMC } = await pool.query(
      `SELECT mc.offer_id, mc.mc_title, mc.mc_brand, mc.mc_sale_price, mc.benchmark_price,
              mc.suggested_price, mc.clicks_14d, mc.impressions_14d, mc.ctr_14d,
              mc.click_potential, mc.approval_status,
              p.margin_pct, p.erp_cost, p.sell_price, p.is_civetta, p.is_topsearch
       FROM merchant_center_products mc
       LEFT JOIN products p ON p.sku = mc.offer_id AND p.tenant_id = $1
       WHERE mc.tenant_id = $1 AND mc.clicks_14d > 0
       ORDER BY mc.clicks_14d DESC LIMIT 20`,
      [tenantId]
    );

    // Products with biggest price opportunity (suggested < current)
    const { rows: priceOpportunities } = await pool.query(
      `SELECT mc.offer_id, mc.mc_title, mc.mc_brand, mc.mc_sale_price, mc.suggested_price,
              mc.benchmark_price, mc.predicted_clicks_change, mc.predicted_impressions_change,
              mc.clicks_14d, mc.impressions_14d,
              p.margin_pct, p.erp_cost, p.sell_price
       FROM merchant_center_products mc
       LEFT JOIN products p ON p.sku = mc.offer_id AND p.tenant_id = $1
       WHERE mc.tenant_id = $1 AND mc.suggested_price IS NOT NULL AND mc.suggested_price > 0
         AND mc.mc_sale_price > 0 AND mc.suggested_price < mc.mc_sale_price
       ORDER BY mc.predicted_clicks_change DESC LIMIT 20`,
      [tenantId]
    );

    // Products above benchmark (overpriced)
    const { rows: overpriced } = await pool.query(
      `SELECT mc.offer_id, mc.mc_title, mc.mc_brand, mc.mc_sale_price, mc.benchmark_price,
              ROUND(((mc.mc_sale_price - mc.benchmark_price) / mc.benchmark_price * 100)::numeric, 1) as pct_above,
              mc.clicks_14d, mc.impressions_14d,
              p.margin_pct, p.erp_cost
       FROM merchant_center_products mc
       LEFT JOIN products p ON p.sku = mc.offer_id AND p.tenant_id = $1
       WHERE mc.tenant_id = $1 AND mc.benchmark_price > 0 AND mc.mc_sale_price > mc.benchmark_price
       ORDER BY (mc.mc_sale_price - mc.benchmark_price) DESC LIMIT 20`,
      [tenantId]
    );

    // Daily Google Shopping trend (last 30d aggregate)
    const { rows: gsTrend } = await pool.query(
      `SELECT report_date, SUM(clicks) as clicks, SUM(impressions) as impressions,
              CASE WHEN SUM(impressions) > 0 THEN ROUND((SUM(clicks)::numeric / SUM(impressions))::numeric, 6) ELSE 0 END as ctr
       FROM merchant_center_daily
       WHERE tenant_id = $1
       GROUP BY report_date
       ORDER BY report_date ASC`,
      [tenantId]
    );

    // Click potential distribution
    const { rows: clickPotDist } = await pool.query(
      `SELECT click_potential, COUNT(*) as count
       FROM merchant_center_products
       WHERE tenant_id = $1 AND click_potential != ''
       GROUP BY click_potential
       ORDER BY CASE click_potential WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END`,
      [tenantId]
    );

    // Trovaprezzi vs Google Shopping cross-analysis
    const { rows: crossAnalysis } = await pool.query(
      `SELECT
         COUNT(CASE WHEN mc.offer_id IS NOT NULL AND zc.product_code IS NOT NULL THEN 1 END) as on_both,
         COUNT(CASE WHEN mc.offer_id IS NOT NULL AND zc.product_code IS NULL THEN 1 END) as gs_only,
         COUNT(CASE WHEN mc.offer_id IS NULL AND zc.product_code IS NOT NULL THEN 1 END) as tp_only,
         COALESCE(SUM(CASE WHEN mc.offer_id IS NOT NULL AND zc.product_code IS NOT NULL THEN mc.clicks_14d END), 0) as gs_clicks_both,
         COALESCE(SUM(CASE WHEN mc.offer_id IS NOT NULL AND zc.product_code IS NOT NULL THEN zc.clicks END), 0) as tp_clicks_both
       FROM merchant_center_products mc
       FULL OUTER JOIN (
         SELECT DISTINCT product_code, clicks FROM zombie_clicks
         WHERE tenant_id = $1 AND fetch_date = (SELECT MAX(fetch_date) FROM zombie_clicks WHERE tenant_id = $1)
       ) zc ON zc.product_code = mc.offer_id
       WHERE mc.tenant_id = $1 OR zc.product_code IS NOT NULL`,
      [tenantId]
    );

    res.json({
      mcStats,
      topClicksMC,
      priceOpportunities,
      overpriced,
      gsTrend,
      clickPotDist,
      crossAnalysis: crossAnalysis[0] || null,
    });
  } catch (err) {
    console.error('[MerchantCenter] Overview error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
