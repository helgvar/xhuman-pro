const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { importProducts } = require('../services/farmaboosterProducts');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// GET /api/products - List products with pagination, search, filters
router.get('/', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = req.query.search;
    const category = req.query.category;
    const civetta = req.query.civetta;
    const topsearch = req.query.topsearch;
    const stock = req.query.stock; // 'instock', 'outofstock'
    const sortBy = req.query.sortBy || 'updated_at';
    const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';

    let where = 'WHERE p.tenant_id = $1';
    const params = [tenantId];
    let idx = 2;

    if (search) {
      where += ` AND (p.sku ILIKE $${idx} OR p.product_name ILIKE $${idx} OR p.ean ILIKE $${idx} OR p.brand ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    if (category) {
      where += ` AND p.category ILIKE $${idx}`;
      params.push(`%${category}%`);
      idx++;
    }

    if (civetta === 'true') {
      where += ' AND p.is_civetta = TRUE';
    }

    if (topsearch === 'true') {
      where += ' AND p.is_topsearch = TRUE';
    }

    if (stock === 'instock') {
      where += ' AND (p.erp_stock > 0 OR p.supplier_stock > 0)';
    } else if (stock === 'outofstock') {
      where += ' AND p.erp_stock <= 0 AND p.supplier_stock <= 0';
    }

    const exportStatus = req.query.export_status;
    if (exportStatus && ['1', '2', '3', '4', '5'].includes(exportStatus)) {
      where += ` AND p.export_status = $${idx++}`;
      params.push(exportStatus);
    }

    const priceRuleId = req.query.price_rule_id;
    if (priceRuleId) {
      where += ` AND p.price_rule_id = $${idx++}`;
      params.push(priceRuleId);
    }

    const brand = req.query.brand;
    if (brand) {
      where += ` AND p.brand ILIKE $${idx}`;
      params.push(`%${brand}%`);
      idx++;
    }

    const saleable = req.query.saleable;
    if (saleable === 'true') {
      where += ' AND p.saleable = TRUE';
    } else if (saleable === 'false') {
      where += ' AND p.saleable = FALSE';
    }

    const marginMin = parseFloat(req.query.margin_min);
    if (!isNaN(marginMin)) {
      where += ` AND p.margin_pct >= $${idx++}`;
      params.push(marginMin);
    }
    const marginMax = parseFloat(req.query.margin_max);
    if (!isNaN(marginMax)) {
      where += ` AND p.margin_pct <= $${idx++}`;
      params.push(marginMax);
    }

    // Whitelist sortBy
    const allowedSort = ['sku', 'product_name', 'sell_price', 'erp_cost', 'margin_pct', 'sales_30d_seller', 'erp_stock', 'updated_at', 'brand'];
    const safeSort = allowedSort.includes(sortBy) ? 'p.' + sortBy : 'p.updated_at';

    // Count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM products p ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    // Products with joined price rule name + scraper competitor count/best price
    const { rows: products } = await pool.query(
      `SELECT p.id, p.sku, p.product_name, p.category, p.reference_price, p.erp_cost, p.sell_price,
              p.markup, p.margin, p.margin_pct, p.sales_30d_seller, p.sales_30d_aggregated,
              p.erp_stock, p.supplier_stock, p.unmanage_stock, p.saleable, p.export_status,
              p.is_civetta, p.is_topsearch, p.is_topkey, p.brand, p.manufacturer, p.ean,
              p.scraper_position, p.price_rule_id, p.updated_at,
              pr.rule_name as price_rule_name,
              sc.competitor_count, sc.best_price as scraper_best_price
       FROM products p
       LEFT JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
       LEFT JOIN (
         SELECT product_code, COUNT(*) as competitor_count, MIN(base_price) as best_price
         FROM scraper_competitors
         WHERE updated_at > NOW() - INTERVAL '48 hours'
         GROUP BY product_code
       ) sc ON sc.product_code = p.sku
       ${where}
       ORDER BY ${safeSort} ${sortDir}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );

    res.json({
      data: products,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[Products] List error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/stats - Product stats/KPIs
router.get('/stats', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    const { rows } = await pool.query(
      `SELECT
         COUNT(*) as total_products,
         COUNT(CASE WHEN is_civetta THEN 1 END) as civetta_count,
         COUNT(CASE WHEN is_topsearch THEN 1 END) as topsearch_count,
         COUNT(CASE WHEN erp_stock > 0 OR supplier_stock > 0 THEN 1 END) as in_stock,
         COUNT(CASE WHEN erp_stock <= 0 AND supplier_stock <= 0 THEN 1 END) as out_of_stock,
         COUNT(CASE WHEN saleable THEN 1 END) as saleable_count,
         COUNT(CASE WHEN export_status = '3' THEN 1 END) as exported_count,
         COUNT(CASE WHEN export_status != '3' THEN 1 END) as not_exported_count,
         COALESCE(AVG(margin_pct), 0) as avg_margin_pct,
         COALESCE(SUM(sales_30d_seller), 0) as total_sales_30d,
         (SELECT completed_at FROM import_jobs
          WHERE tenant_id = $1 AND job_type IN ('products_import', 'products_sync')
            AND status = 'completed' ORDER BY completed_at DESC LIMIT 1) as last_import_at
       FROM products WHERE tenant_id = $1`,
      [tenantId]
    );

    res.json({ stats: rows[0] });
  } catch (err) {
    console.error('[Products] Stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/categories - Unique categories for filter dropdown
router.get('/categories', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT category FROM products WHERE tenant_id = $1 AND category IS NOT NULL AND category != '' ORDER BY category`,
      [req.tenantId]
    );
    res.json({ categories: rows.map(r => r.category) });
  } catch (err) {
    console.error('[Products] Categories error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/brands - Unique brands for filter dropdown
router.get('/brands', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT brand FROM products WHERE tenant_id = $1 AND brand IS NOT NULL AND brand != '' ORDER BY brand LIMIT 500`,
      [req.tenantId]
    );
    res.json({ brands: rows.map(r => r.brand) });
  } catch (err) {
    console.error('[Products] Brands error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/rules - Price rules
router.get('/rules', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.id, pr.rule_id, pr.rule_name, pr.rule_type, pr.rule_data, pr.is_active, pr.priority, pr.updated_at,
              COALESCE(pc.product_count, 0) as product_count
       FROM price_rules pr
       LEFT JOIN (
         SELECT price_rule_id, COUNT(*) as product_count
         FROM products WHERE tenant_id = $1
         GROUP BY price_rule_id
       ) pc ON pc.price_rule_id = pr.rule_id
       WHERE pr.tenant_id = $1
       ORDER BY pr.priority DESC`,
      [req.tenantId]
    );
    res.json({ rules: rows });
  } catch (err) {
    console.error('[Products] Rules error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/:id - Product detail with competitors
router.get('/:id', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, pr.rule_name as price_rule_name
       FROM products p
       LEFT JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
       WHERE p.id = $1 AND p.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = rows[0];

    // Fetch scraper competitors for this product (ordered by total_price ASC)
    const { rows: competitors } = await pool.query(
      `SELECT merchant, position, base_price, shipping_cost, total_price, reviews, source, scraped_at
       FROM scraper_competitors
       WHERE product_code = $1 AND updated_at > NOW() - INTERVAL '48 hours'
       ORDER BY base_price ASC`,
      [product.sku]
    );

    res.json({ product, competitors });
  } catch (err) {
    console.error('[Products] Detail error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/products/import - Trigger manual products import
router.post('/import', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Check running import
    const { rows: running } = await pool.query(
      `SELECT id FROM import_jobs
       WHERE tenant_id = $1 AND job_type = 'products_import' AND status IN ('pending', 'running')`,
      [tenantId]
    );

    if (running.length > 0) {
      return res.status(409).json({ error: 'Importazione prodotti già in corso' });
    }

    // Create job
    const { rows } = await pool.query(
      `INSERT INTO import_jobs (tenant_id, job_type, status, metadata)
       VALUES ($1, 'products_import', 'pending', $2) RETURNING id`,
      [tenantId, JSON.stringify({ triggeredBy: req.user.email })]
    );
    const jobId = rows[0].id;

    // Run in background
    importProducts(tenantId, jobId).catch(err => {
      console.error('[Products] Background import error:', err.message);
    });

    res.json({ jobId, message: 'Import prodotti avviato' });
  } catch (err) {
    console.error('[Products] Import trigger error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/import/status - Last import jobs for products
router.get('/import/status', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, started_at, completed_at, records_processed,
              records_imported, records_updated, error_message, metadata, created_at
       FROM import_jobs
       WHERE tenant_id = $1 AND job_type IN ('products_import', 'products_sync')
       ORDER BY created_at DESC LIMIT 10`,
      [req.tenantId]
    );
    res.json({ jobs: rows });
  } catch (err) {
    console.error('[Products] Import status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
