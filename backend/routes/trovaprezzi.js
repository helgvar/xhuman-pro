const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const zombieService = require('../services/zombieService');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// GET /api/trovaprezzi/overview - Dashboard overview: scraper stats + click stats + runs
router.get('/overview', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Scraper stats (global)
    const { rows: [scraperStats] } = await pool.query(
      `SELECT
         COUNT(DISTINCT product_code) as scraper_products,
         COUNT(*) as scraper_entries,
         COUNT(DISTINCT merchant) as scraper_merchants,
         MAX(updated_at) as scraper_last_update
       FROM scraper_competitors
       WHERE updated_at > NOW() - INTERVAL '48 hours'`
    );

    // Click stats for latest available date
    const { rows: [clickStats] } = await pool.query(
      `SELECT
         zc.fetch_date,
         COUNT(*) as products_with_clicks,
         SUM(clicks) as total_clicks,
         AVG(clicks) as avg_clicks,
         MAX(clicks) as max_clicks
       FROM zombie_clicks zc
       WHERE zc.tenant_id = $1
         AND zc.fetch_date = (SELECT MAX(fetch_date) FROM zombie_clicks WHERE tenant_id = $1)
       GROUP BY zc.fetch_date`,
      [tenantId]
    );

    // Click trend (last 30 days)
    const { rows: clickTrend } = await pool.query(
      `SELECT fetch_date, COUNT(*) as products, SUM(clicks) as total_clicks
       FROM zombie_clicks
       WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY fetch_date
       ORDER BY fetch_date ASC`,
      [tenantId]
    );

    // Last 5 runs
    const { rows: lastRuns } = await pool.query(
      `SELECT id, run_date, status, products_count, total_clicks, ftp_uploaded,
              error_message, started_at, completed_at
       FROM zombie_runs
       WHERE tenant_id = $1
       ORDER BY started_at DESC LIMIT 5`,
      [tenantId]
    );

    // Top 10 most clicked products (all days aggregated)
    const { rows: topClicked } = await pool.query(
      `SELECT zc.product_code,
              (array_agg(zc.product_name ORDER BY zc.fetch_date DESC))[1] as product_name,
              (array_agg(zc.trovaprezzi_category ORDER BY zc.fetch_date DESC))[1] as trovaprezzi_category,
              SUM(zc.clicks) as clicks,
              p.sell_price, p.erp_cost, p.margin_pct, p.erp_stock, p.supplier_stock
       FROM zombie_clicks zc
       LEFT JOIN products p ON p.sku = zc.product_code AND p.tenant_id = $1
       WHERE zc.tenant_id = $1
       GROUP BY zc.product_code, p.sell_price, p.erp_cost, p.margin_pct, p.erp_stock, p.supplier_stock
       ORDER BY SUM(zc.clicks) DESC
       LIMIT 10`,
      [tenantId]
    );

    // Top merchants (from scraper)
    const { rows: topMerchants } = await pool.query(
      `SELECT merchant, COUNT(DISTINCT product_code) as product_count,
              ROUND(AVG(position)::numeric, 1) as avg_position,
              ROUND(AVG(base_price)::numeric, 2) as avg_price
       FROM scraper_competitors
       WHERE updated_at > NOW() - INTERVAL '48 hours'
       GROUP BY merchant
       ORDER BY product_count DESC
       LIMIT 20`
    );

    // Your position distribution (find tenant's seller name)
    const { rows: sellerRows } = await pool.query(
      `SELECT config_value FROM tenant_configs
       WHERE tenant_id = $1 AND config_key = 'trovaprezzi_seller_name'`,
      [tenantId]
    );
    let sellerName = null;
    let positionDistribution = [];
    if (sellerRows.length > 0) {
      try { sellerName = require('../services/crypto').decrypt(sellerRows[0].config_value); }
      catch { sellerName = sellerRows[0].config_value; }

      const { rows: posDist } = await pool.query(
        `SELECT
           CASE
             WHEN position = 1 THEN '1'
             WHEN position BETWEEN 2 AND 3 THEN '2-3'
             WHEN position BETWEEN 4 AND 5 THEN '4-5'
             WHEN position BETWEEN 6 AND 10 THEN '6-10'
             ELSE '11+'
           END as position_range,
           COUNT(*) as count
         FROM scraper_competitors
         WHERE merchant ILIKE $1 AND updated_at > NOW() - INTERVAL '48 hours'
         GROUP BY position_range
         ORDER BY MIN(position)`,
        [`%${sellerName}%`]
      );
      positionDistribution = posDist;
    }

    res.json({
      scraperStats,
      clickStats: clickStats || null,
      clickTrend,
      lastRuns,
      topClicked,
      topMerchants,
      sellerName,
      positionDistribution,
    });
  } catch (err) {
    console.error('[Trovaprezzi] Overview error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/trovaprezzi/rivals - Direct rivals: merchants competing on the same products
router.get('/rivals', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Get tenant's seller name
    const { rows: sellerRows } = await pool.query(
      `SELECT config_value FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'trovaprezzi_seller_name'`,
      [tenantId]
    );
    if (sellerRows.length === 0) return res.json({ rivals: [], sellerName: null });

    let sellerName;
    try { sellerName = require('../services/crypto').decrypt(sellerRows[0].config_value); }
    catch { sellerName = sellerRows[0].config_value; }

    // Find all products where this seller appears
    // Then find all OTHER sellers on those same products
    // Count battles, wins (our position < their position), losses
    // Use exact match for better index performance on large tables
    const { rows: rivals } = await pool.query(`
      WITH my_products AS (
        SELECT product_code, position as my_position, base_price as my_price
        FROM scraper_competitors
        WHERE merchant = $1
      ),
      battles AS (
        SELECT
          sc.merchant as rival,
          COUNT(*) as battles,
          COUNT(*) FILTER (WHERE mp.my_position < sc.position) as i_win,
          COUNT(*) FILTER (WHERE mp.my_position > sc.position) as they_win,
          COUNT(*) FILTER (WHERE mp.my_position = sc.position) as tie,
          ROUND(AVG(sc.base_price)::numeric, 2) as rival_avg_price,
          ROUND(AVG(mp.my_price)::numeric, 2) as my_avg_price,
          ROUND(AVG(sc.position)::numeric, 1) as rival_avg_position,
          ROUND(AVG(mp.my_position)::numeric, 1) as my_avg_position,
          COUNT(DISTINCT sc.product_code) as shared_products
        FROM my_products mp
        JOIN scraper_competitors sc ON sc.product_code = mp.product_code
          AND sc.merchant != $1
        GROUP BY sc.merchant
      )
      SELECT rival, battles, i_win, they_win, tie, shared_products,
             rival_avg_price, my_avg_price,
             rival_avg_position, my_avg_position,
             ROUND((i_win::numeric / NULLIF(battles, 0) * 100), 1) as win_rate,
             ROUND(((my_avg_price - rival_avg_price) / NULLIF(rival_avg_price, 0) * 100)::numeric, 1) as price_gap_pct
      FROM battles
      WHERE battles >= 10
      ORDER BY battles DESC
      LIMIT 30
    `, [sellerName]);

    res.json({ sellerName, rivals, totalProducts: rivals.length > 0 ? rivals[0].shared_products : 0 });
  } catch (err) {
    console.error('[Trovaprezzi] Rivals error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/trovaprezzi/clicks - Click data with pagination and search
router.get('/clicks', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = req.query.search;
    const date = req.query.date; // YYYY-MM-DD
    const category = req.query.category;
    const sortBy = req.query.sortBy || 'clicks';
    const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';

    let where = 'WHERE zc.tenant_id = $1';
    const params = [tenantId];
    let idx = 2;

    if (date) {
      where += ` AND zc.fetch_date = $${idx++}`;
      params.push(date);
    } else {
      where += ` AND zc.fetch_date = (SELECT MAX(fetch_date) FROM zombie_clicks WHERE tenant_id = $1)`;
    }

    if (search) {
      where += ` AND (zc.product_code ILIKE $${idx} OR zc.product_name ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    if (category) {
      where += ` AND zc.trovaprezzi_category ILIKE $${idx}`;
      params.push(`%${category}%`);
      idx++;
    }

    const allowedSort = ['clicks', 'product_code', 'product_name', 'trovaprezzi_category'];
    const safeSort = allowedSort.includes(sortBy) ? 'zc.' + sortBy : 'zc.clicks';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM zombie_clicks zc ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT zc.product_code, zc.product_name, zc.trovaprezzi_category, zc.clicks, zc.fetch_date,
              p.sell_price, p.erp_cost, p.margin_pct, p.erp_stock, p.supplier_stock,
              p.is_civetta, p.is_topsearch, p.sales_30d_seller, p.sales_30d_aggregated,
              sc.competitor_count, sc.best_price as scraper_best_price, sc.my_position
       FROM zombie_clicks zc
       LEFT JOIN products p ON p.sku = zc.product_code AND p.tenant_id = $1
       LEFT JOIN (
         SELECT product_code, COUNT(*) as competitor_count, MIN(base_price) as best_price,
                MIN(CASE WHEN merchant ILIKE '%farmacri%' THEN position END) as my_position
         FROM scraper_competitors
         WHERE updated_at > NOW() - INTERVAL '48 hours'
         GROUP BY product_code
       ) sc ON sc.product_code = zc.product_code
       ${where}
       ORDER BY ${safeSort} ${sortDir}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );

    res.json({
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[Trovaprezzi] Clicks error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/trovaprezzi/clicks/dates - Available dates for click data
router.get('/clicks/dates', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT fetch_date, COUNT(*) as products, SUM(clicks) as total_clicks
       FROM zombie_clicks
       WHERE tenant_id = $1
       GROUP BY fetch_date
       ORDER BY fetch_date DESC
       LIMIT 60`,
      [req.tenantId]
    );
    res.json({ dates: rows });
  } catch (err) {
    console.error('[Trovaprezzi] Click dates error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/trovaprezzi/clicks/categories - Categories for filter
router.get('/clicks/categories', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT trovaprezzi_category FROM zombie_clicks
       WHERE tenant_id = $1 AND trovaprezzi_category IS NOT NULL AND trovaprezzi_category != ''
         AND fetch_date = (SELECT MAX(fetch_date) FROM zombie_clicks WHERE tenant_id = $1)
       ORDER BY trovaprezzi_category`,
      [req.tenantId]
    );
    res.json({ categories: rows.map(r => r.trovaprezzi_category) });
  } catch (err) {
    console.error('[Trovaprezzi] Click categories error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/trovaprezzi/zombie/run - Trigger manual zombie run
router.post('/zombie/run', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Check if configured
    const configured = await zombieService.isConfigured(tenantId);
    if (!configured) {
      return res.status(400).json({ error: 'Trovaprezzi non configurato per questo tenant' });
    }

    // Check running
    const { rows: running } = await pool.query(
      `SELECT id FROM zombie_runs
       WHERE tenant_id = $1 AND status = 'running'`,
      [tenantId]
    );
    if (running.length > 0) {
      return res.status(409).json({ error: 'Download già in corso' });
    }

    // Run in background
    zombieService.runForTenant(tenantId).catch(err => {
      console.error('[Trovaprezzi] Background zombie error:', err.message);
    });

    res.json({ message: 'Download click Trovaprezzi avviato' });
  } catch (err) {
    console.error('[Trovaprezzi] Zombie run error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/trovaprezzi/zombie/runs - Zombie run history
router.get('/zombie/runs', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, run_date, status, products_count, total_clicks, ftp_uploaded,
              error_message, started_at, completed_at
       FROM zombie_runs
       WHERE tenant_id = $1
       ORDER BY started_at DESC LIMIT 30`,
      [req.tenantId]
    );
    res.json({ runs: rows });
  } catch (err) {
    console.error('[Trovaprezzi] Zombie runs error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
