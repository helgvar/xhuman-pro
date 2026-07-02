const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { computeHealthScores, getGlobalPnl, getWeeklyBreakdown } = require('../services/productHealth');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// GET /api/optimization/health - Global health summary
router.get('/health', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const summary = await getGlobalPnl(req.tenantId);
    res.json(summary);
  } catch (err) {
    console.error('[Optimization] Health summary error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/kpi-range - KPI for a specific date range with optional comparison
router.get('/kpi-range', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { from, to, compare_from, compare_to } = req.query;

    if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });

    async function getKpiForRange(dateFrom, dateTo) {
      // Click TP
      const { rows: [clicks] } = await pool.query(`
        SELECT COALESCE(SUM(clicks), 0) as click, COUNT(DISTINCT fetch_date) as days_with_clicks,
          MIN(fetch_date)::text as first_click, MAX(fetch_date)::text as last_click
        FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= $2::date AND fetch_date <= $3::date
      `, [tenantId, dateFrom, dateTo]);

      // Ordini Magento (stesso periodo dei click)
      const { rows: [orders] } = await pool.query(`
        SELECT COUNT(DISTINCT o.id) as ordini, ROUND(COALESCE(SUM(oi.row_total), 0)::numeric, 2) as revenue
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.tenant_id = $1 AND o.order_date::date >= $2::date AND o.order_date::date <= $3::date
          AND o.order_status NOT IN ('canceled','closed','pending_payment')
      `, [tenantId, dateFrom, dateTo]);

      // Ordini solo da prodotti civetta (attribuibili a TP)
      const { rows: [civettaOrders] } = await pool.query(`
        SELECT COUNT(DISTINCT o.id) as ordini, ROUND(COALESCE(SUM(oi.row_total), 0)::numeric, 2) as revenue
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        JOIN products p ON p.sku = oi.sku AND p.tenant_id = o.tenant_id AND p.is_civetta = true
        WHERE o.tenant_id = $1 AND o.order_date::date >= $2::date AND o.order_date::date <= $3::date
          AND o.order_status NOT IN ('canceled','closed','pending_payment')
      `, [tenantId, dateFrom, dateTo]);

      const clickCount = parseInt(clicks.click) || 0;
      const clickCost = +(clickCount * 0.27).toFixed(2);
      const storeRevenue = parseFloat(orders.revenue) || 0;
      const civettaRevenue = parseFloat(civettaOrders.revenue) || 0;

      return {
        dateFrom, dateTo,
        daysWithClicks: parseInt(clicks.days_with_clicks) || 0,
        firstClick: clicks.first_click, lastClick: clicks.last_click,
        clicks: clickCount,
        clickCost,
        storeOrders: parseInt(orders.ordini) || 0,
        storeRevenue,
        civettaOrders: parseInt(civettaOrders.ordini) || 0,
        civettaRevenue,
        incidenceStore: storeRevenue > 0 ? +(clickCost / storeRevenue * 100).toFixed(2) : null,
        incidenceCivetta: civettaRevenue > 0 ? +(clickCost / civettaRevenue * 100).toFixed(2) : null,
        convRate: clickCount > 0 ? +(parseInt(orders.ordini) / clickCount * 100).toFixed(2) : null,
        avgOrderValue: parseInt(orders.ordini) > 0 ? +(storeRevenue / parseInt(orders.ordini)).toFixed(2) : null,
      };
    }

    const current = await getKpiForRange(from, to);
    let comparison = null;
    if (compare_from && compare_to) {
      comparison = await getKpiForRange(compare_from, compare_to);
    }

    // Data availability info
    const { rows: [dataRange] } = await pool.query(`
      SELECT MIN(fetch_date)::text as first_date, MAX(fetch_date)::text as last_date,
        COUNT(DISTINCT fetch_date) as total_days
      FROM zombie_clicks WHERE tenant_id = $1
    `, [tenantId]);

    res.json({
      current,
      comparison,
      dataAvailable: {
        firstDate: dataRange.first_date,
        lastDate: dataRange.last_date,
        totalDays: parseInt(dataRange.total_days) || 0,
      },
    });
  } catch (err) {
    console.error('[Optimization] KPI range error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/optimization/weekly - Weekly breakdown (4 rolling weeks)
router.get('/weekly', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const weeks = await getWeeklyBreakdown(req.tenantId);
    res.json({ weeks });
  } catch (err) {
    console.error('[Optimization] Weekly breakdown error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/health/products - Paginated product health list
router.get('/health/products', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = req.query.search;
    const classification = req.query.classification;
    const priority = req.query.priority;
    const sortBy = req.query.sortBy || 'health_score';
    const sortDir = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';

    let where = 'WHERE ph.tenant_id = $1';
    const params = [tenantId];
    let idx = 2;

    if (classification) {
      where += ` AND ph.classification = $${idx++}`;
      params.push(classification);
    }
    if (priority) {
      where += ` AND ph.rec_priority = $${idx++}`;
      params.push(priority);
    }
    if (search) {
      where += ` AND (ph.sku ILIKE $${idx} OR p.product_name ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const allowedSort = [
      'health_score', 'tp_clicks_30d', 'tp_click_cost_30d', 'tp_attributed_revenue',
      'tp_cost_incidence', 'classification', 'rec_priority', 'efficiency_score',
      'revenue_score', 'competitive_score', 'data_confidence',
    ];
    const safeSort = allowedSort.includes(sortBy) ? `ph.${sortBy}` : 'ph.health_score';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM product_health_scores ph
       LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
       ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(`
      SELECT
        ph.*,
        p.product_name, p.brand, p.sell_price, p.erp_cost, p.margin_pct,
        p.erp_stock, p.supplier_stock, p.is_civetta, p.sales_30d_seller,
        p.category
      FROM product_health_scores ph
      LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      ${where}
      ORDER BY ${safeSort} ${sortDir}
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limit, offset]);

    res.json({
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[Optimization] Health products error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/health/:sku - Single product deep analysis
router.get('/health/:sku', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ph.*,
        p.product_name, p.brand, p.manufacturer, p.sell_price, p.erp_cost,
        p.margin, p.margin_pct, p.erp_stock, p.supplier_stock,
        p.is_civetta, p.is_topsearch, p.sales_30d_seller, p.sales_30d_aggregated,
        p.category, p.ean
      FROM product_health_scores ph
      LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1 AND ph.sku = $2
    `, [req.tenantId, req.params.sku]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Get history trend (last 30 days)
    const { rows: history } = await pool.query(`
      SELECT snapshot_date, health_score, classification, tp_cost_incidence, tp_attributed_revenue
      FROM product_health_history
      WHERE tenant_id = $1 AND sku = $2
      ORDER BY snapshot_date DESC LIMIT 30
    `, [req.tenantId, req.params.sku]);

    // Get competitor data
    const { rows: competitors } = await pool.query(`
      SELECT merchant, position, base_price, shipping_cost, total_price, reviews
      FROM scraper_competitors
      WHERE product_code = $1 AND updated_at > NOW() - INTERVAL '48 hours'
      ORDER BY position ASC
    `, [req.params.sku]);

    // Get recent click data
    const { rows: clickHistory } = await pool.query(`
      SELECT fetch_date, clicks
      FROM zombie_clicks
      WHERE tenant_id = $1 AND product_code = $2
      ORDER BY fetch_date DESC LIMIT 30
    `, [req.tenantId, req.params.sku]);

    res.json({
      product: rows[0],
      history,
      competitors,
      clickHistory,
    });
  } catch (err) {
    console.error('[Optimization] Product detail error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/pnl - Global P&L
router.get('/pnl', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const summary = await getGlobalPnl(req.tenantId);
    res.json(summary);
  } catch (err) {
    console.error('[Optimization] PnL error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/pnl/categories - P&L by Trovaprezzi category
router.get('/pnl/categories', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(zc.latest_cat, 'N/D') as category,
        COUNT(*) as products,
        SUM(ph.tp_clicks_30d) as total_clicks,
        SUM(ph.tp_click_cost_30d) as total_click_cost,
        SUM(ph.tp_attributed_revenue) as total_revenue,
        SUM(ph.tp_attributed_orders) as total_orders,
        CASE WHEN SUM(ph.tp_attributed_revenue) > 0
          THEN SUM(ph.tp_click_cost_30d) / SUM(ph.tp_attributed_revenue)
          ELSE 0
        END as category_incidence,
        AVG(ph.health_score) as avg_health_score,
        COUNT(*) FILTER (WHERE ph.classification = 'burner') as burners
      FROM product_health_scores ph
      LEFT JOIN LATERAL (
        SELECT trovaprezzi_category as latest_cat
        FROM zombie_clicks
        WHERE tenant_id = $1 AND product_code = ph.sku
        ORDER BY fetch_date DESC LIMIT 1
      ) zc ON true
      WHERE ph.tenant_id = $1
      GROUP BY COALESCE(zc.latest_cat, 'N/D')
      ORDER BY total_click_cost DESC NULLS LAST
    `, [req.tenantId]);

    res.json({ categories: rows });
  } catch (err) {
    console.error('[Optimization] PnL categories error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/burners - Top burner products
router.get('/burners', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 50);

    const { rows } = await pool.query(`
      SELECT
        ph.sku, ph.tp_clicks_30d, ph.tp_click_cost_30d, ph.tp_attributed_revenue,
        ph.tp_attributed_orders, ph.tp_cost_incidence, ph.health_score,
        ph.efficiency_score, ph.rec_reasoning,
        ph.mc_suggested_price, ph.mc_click_potential,
        p.product_name, p.brand, p.sell_price, p.erp_cost, p.margin_pct,
        p.is_civetta, p.sales_30d_seller
      FROM product_health_scores ph
      LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1 AND ph.classification = 'burner'
      ORDER BY ph.tp_click_cost_30d DESC
      LIMIT $2
    `, [req.tenantId, limit]);

    // Summary
    const { rows: [summary] } = await pool.query(`
      SELECT
        COUNT(*) as total_burners,
        SUM(tp_click_cost_30d) as total_waste,
        SUM(tp_clicks_30d) as total_wasted_clicks
      FROM product_health_scores
      WHERE tenant_id = $1 AND classification = 'burner'
    `, [req.tenantId]);

    res.json({ burners: rows, summary });
  } catch (err) {
    console.error('[Optimization] Burners error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/opportunities - Top reactivation opportunities
router.get('/opportunities', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 50);

    const { rows } = await pool.query(`
      SELECT
        ph.sku, ph.health_score, ph.mc_click_potential, ph.mc_benchmark_price,
        ph.mc_suggested_price, ph.rec_price_action, ph.rec_price, ph.rec_reasoning,
        ph.scraper_competitor_count, ph.scraper_best_price, ph.scraper_position,
        ph.growth_score, ph.competitive_score,
        p.product_name, p.brand, p.sell_price, p.erp_cost, p.margin_pct,
        p.is_civetta, p.sales_30d_seller, p.price_rule_id
      FROM product_health_scores ph
      LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1 AND ph.classification = 'opportunity'
      ORDER BY ph.health_score DESC
      LIMIT $2
    `, [req.tenantId, limit]);

    // Exclude Sconto rule products and add rule_type info
    const { rows: rules } = await pool.query(
      `SELECT rule_id, rule_type, rule_name FROM price_rules WHERE tenant_id = $1`,
      [req.tenantId]
    );
    const ruleMap = {};
    for (const r of rules) ruleMap[r.rule_id] = r;

    const filtered = rows
      .map(r => ({
        ...r,
        rule_type: ruleMap[r.price_rule_id]?.rule_type || 'diretto',
        rule_name: ruleMap[r.price_rule_id]?.rule_name || '',
      }))
      .filter(r => r.rule_type !== 'sconto');

    res.json({ opportunities: filtered });
  } catch (err) {
    console.error('[Optimization] Opportunities error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/recommendations - Current feed recommendations
router.get('/recommendations', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    // Products where recommendation differs from current state
    const { rows: civettaChanges } = await pool.query(`
      SELECT
        ph.sku, ph.classification, ph.health_score, ph.rec_civetta, ph.rec_reasoning,
        ph.tp_clicks_30d, ph.tp_click_cost_30d, ph.tp_attributed_revenue,
        p.product_name, p.brand, p.sell_price, p.is_civetta as current_civetta
      FROM product_health_scores ph
      JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1
        AND ph.rec_civetta IS NOT NULL
        AND ph.rec_civetta != p.is_civetta
      ORDER BY ph.tp_click_cost_30d DESC
    `, [req.tenantId]);

    // Products with price change recommendations
    const { rows: priceChanges } = await pool.query(`
      SELECT
        ph.sku, ph.classification, ph.health_score,
        ph.rec_price_action, ph.rec_price, ph.rec_reasoning,
        ph.mc_suggested_price, ph.mc_benchmark_price,
        p.product_name, p.brand, p.sell_price, p.erp_cost, p.margin_pct
      FROM product_health_scores ph
      JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1
        AND ph.rec_price_action != 'none'
        AND ph.rec_price IS NOT NULL
      ORDER BY ph.health_score DESC
    `, [req.tenantId]);

    res.json({
      civettaChanges,
      priceChanges,
      summary: {
        totalCivettaChanges: civettaChanges.length,
        toDeactivate: civettaChanges.filter(r => !r.rec_civetta).length,
        toActivate: civettaChanges.filter(r => r.rec_civetta).length,
        totalPriceChanges: priceChanges.length,
        estimatedSavings: civettaChanges
          .filter(r => !r.rec_civetta)
          .reduce((sum, r) => sum + parseFloat(r.tp_click_cost_30d || 0), 0),
      },
    });
  } catch (err) {
    console.error('[Optimization] Recommendations error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/optimization/enrich - Trigger manual enrichment
router.post('/enrich', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    // Run in background
    computeHealthScores(req.tenantId).catch(err => {
      console.error('[Optimization] Manual enrichment error:', err.message);
    });

    res.json({ message: 'Arricchimento avviato. I risultati saranno disponibili tra pochi minuti.' });
  } catch (err) {
    console.error('[Optimization] Enrich trigger error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/config - Get health scoring config
router.get('/config', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT config_key, config_value, updated_at FROM health_config WHERE tenant_id = $1 ORDER BY config_key`,
      [req.tenantId]
    );
    res.json({ config: rows });
  } catch (err) {
    console.error('[Optimization] Config error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/optimization/config - Update health scoring config
router.put('/config', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { config } = req.body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Config object required' });
    }

    const allowedKeys = [
      'weight_revenue', 'weight_efficiency', 'weight_competitive',
      'weight_growth', 'weight_seasonal', 'weight_indirect',
      'avg_tp_cpc', 'tp_target_incidence_min', 'tp_target_incidence_max',
    ];

    for (const [key, value] of Object.entries(config)) {
      if (!allowedKeys.includes(key)) continue;
      await pool.query(`
        INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (tenant_id, config_key) DO UPDATE SET
          config_value = $3, updated_at = NOW()
      `, [req.tenantId, key, String(value)]);
    }

    res.json({ message: 'Configurazione aggiornata' });
  } catch (err) {
    console.error('[Optimization] Config update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/dashboard - Aggregated KPIs for home dashboard
router.get('/dashboard', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // 1. Real feed count (civetta=1 products WITH stock = what's actually in feed)
    const { rows: [realFeed] } = await pool.query(
      `SELECT COUNT(*) as feed_total FROM products WHERE tenant_id = $1 AND is_civetta = true AND (COALESCE(erp_stock, 0) + COALESCE(supplier_stock, 0)) > 0`,
      [tenantId]
    );

    // Feed actions breakdown
    const { rows: [feedOverview] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE action = 'KEEP') as converters,
        COUNT(*) FILTER (WHERE action = 'REMOVE') as to_remove,
        COUNT(*) FILTER (WHERE action = 'ADD') as pepite,
        COUNT(*) FILTER (WHERE action = 'PRICE_CUT') as price_cuts,
        COUNT(*) FILTER (WHERE action = 'MONITOR') as monitor
      FROM feed_actions WHERE tenant_id = $1
    `, [tenantId]);

    // Quarantined = effectively removed products
    const { rows: [quarantineCount] } = await pool.query(
      `SELECT COUNT(*) as count FROM feed_quarantine WHERE tenant_id = $1 AND reactivated = false`,
      [tenantId]
    );
    const totalRemoved = (parseInt(feedOverview.to_remove) || 0) + (parseInt(quarantineCount.count) || 0);

    // 2. Top selling products (by GA4 TP revenue OR zombie clicks with orders)
    let topSellers = [];
    // Try GA4 first
    const { rows: ga4Sellers } = await pool.query(`
      SELECT ph.sku, p.product_name, p.brand, p.sell_price,
             ph.ga4_tp_purchases, ph.ga4_tp_revenue, ph.ga4_assisted_sales,
             ph.tp_clicks_30d, ph.health_score, ph.classification
      FROM product_health_scores ph
      JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1 AND ph.ga4_tp_revenue > 0
      ORDER BY ph.ga4_tp_revenue DESC
      LIMIT 10
    `, [tenantId]);
    if (ga4Sellers.length > 0) {
      topSellers = ga4Sellers;
    } else {
      // Fallback: products with most TP clicks that also have store sales
      const { rows: clickSellers } = await pool.query(`
        WITH click_totals AS (
          SELECT product_code as sku, SUM(clicks) as tp_clicks
          FROM zombie_clicks WHERE tenant_id = $1
          GROUP BY product_code
        )
        SELECT ct.sku, p.product_name, p.brand, p.sell_price,
               p.sales_30d_seller as ga4_tp_purchases,
               (p.sales_30d_seller * p.sell_price) as ga4_tp_revenue,
               0 as ga4_assisted_sales,
               ct.tp_clicks as tp_clicks_30d,
               ph.health_score, ph.classification
        FROM click_totals ct
        JOIN products p ON p.sku = ct.sku AND p.tenant_id = $1
        LEFT JOIN product_health_scores ph ON ph.sku = ct.sku AND ph.tenant_id = $1
        WHERE p.sales_30d_seller > 0
        ORDER BY p.sales_30d_seller DESC, ct.tp_clicks DESC
        LIMIT 10
      `, [tenantId]);
      topSellers = clickSellers;
    }

    // 3. High margin products (best margin % with sales)
    const { rows: highMargin } = await pool.query(`
      SELECT p.sku, p.product_name, p.brand, p.sell_price, p.erp_cost,
             p.margin, p.margin_pct, p.sales_30d_seller,
             ph.ga4_tp_revenue, ph.ga4_tp_purchases, ph.health_score
      FROM products p
      JOIN product_health_scores ph ON ph.tenant_id = p.tenant_id AND ph.sku = p.sku
      WHERE p.tenant_id = $1
        AND p.margin_pct > 15
        AND (ph.ga4_tp_purchases > 0 OR p.sales_30d_seller > 0)
      ORDER BY p.margin_pct DESC, ph.ga4_tp_revenue DESC NULLS LAST
      LIMIT 10
    `, [tenantId]);

    // 4. High rotation products (most sales in 30d)
    const { rows: highRotation } = await pool.query(`
      SELECT p.sku, p.product_name, p.brand, p.sell_price,
             p.sales_30d_seller, p.sales_30d_aggregated,
             ph.ga4_tp_purchases, ph.ga4_tp_revenue, ph.health_score, ph.classification,
             p.is_civetta
      FROM products p
      LEFT JOIN product_health_scores ph ON ph.tenant_id = p.tenant_id AND ph.sku = p.sku
      WHERE p.tenant_id = $1 AND p.sales_30d_seller > 0
      ORDER BY p.sales_30d_seller DESC
      LIMIT 10
    `, [tenantId]);

    // 5. Seasonal performers (in season + good health score)
    const currentMonth = new Date().getMonth() + 1;
    const { rows: seasonal } = await pool.query(`
      SELECT ph.sku, p.product_name, p.brand, p.sell_price,
             ph.seasonal_score, ph.health_score, ph.classification,
             ph.ga4_tp_revenue, ph.ga4_tp_purchases, ph.tp_clicks_30d,
             p.sales_30d_seller
      FROM product_health_scores ph
      JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1
        AND ph.is_seasonal = true
        AND ph.seasonal_score >= 60
        AND (ph.ga4_tp_purchases > 0 OR p.sales_30d_seller > 0)
      ORDER BY ph.health_score DESC
      LIMIT 10
    `, [tenantId]);

    // 6. Real KPIs — STANDARD: ultimi 30 giorni, incidenza calcolata SOLO sui giorni TP attivi.
    // Incidenza = costo_TP / (TP-attribuita_diretta + TP-attribuita_indiretta)
    // TP diretta: ga4_tp_revenue_30d (last-click)
    // TP indiretta: ga4_cross_session_revenue_30d (TP first-session, conv in altra session)
    // (NON usare fatturato store totale: include ordini che non c'entrano col TP)
    const { rows: cfgRows } = await pool.query(
      `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1
       AND config_key IN ('avg_tp_cpc','revenue_source','feed_last_run',
                          'ga4_tp_revenue_30d','ga4_tp_transactions_30d','ga4_tp_sessions_30d',
                          'ga4_cross_session_revenue_30d','ga4_cross_session_transactions_30d',
                          'ga4_data_start_date')`,
      [tenantId]
    );
    const cfg = {};
    for (const r of cfgRows) cfg[r.config_key] = r.config_value;
    const cpc = parseFloat(cfg.avg_tp_cpc) || 0.27;
    const tpDirectRevenue = parseFloat(cfg.ga4_tp_revenue_30d) || 0;
    const tpIndirectRevenue = parseFloat(cfg.ga4_cross_session_revenue_30d) || 0;
    const tpAttributedTotal = +(tpDirectRevenue + tpIndirectRevenue).toFixed(2);
    const tpAttributedTransactions = (parseInt(cfg.ga4_tp_transactions_30d) || 0) + (parseInt(cfg.ga4_cross_session_transactions_30d) || 0);
    // Per tenant onboardati da poco con GA4: limita la finestra al periodo in cui GA4 ha dati validi.
    // Esempio: Sanvito ha GA4 attivo dal 28/4/2026, prima il dato non esiste.
    // La window effettiva diventa max(CURRENT_DATE-30, ga4_data_start_date).
    const ga4StartDate = cfg.ga4_data_start_date || null;

    // Effective window: max(CURRENT_DATE-30, ga4_data_start_date) → CURRENT_DATE-1
    // Se ga4_data_start_date e' settato, la finestra viene ridotta per allineare numerator e denominator.
    const { rows: [k30] } = await pool.query(`
      WITH effective_start AS (
        SELECT GREATEST(
          CURRENT_DATE - INTERVAL '30 days',
          COALESCE($2::date, CURRENT_DATE - INTERVAL '30 days')
        )::date AS d
      ),
      active_days AS (
        SELECT DISTINCT fetch_date AS d
        FROM zombie_clicks
        WHERE tenant_id = $1
          AND fetch_date >= (SELECT d FROM effective_start)
          AND fetch_date < CURRENT_DATE
      ),
      clicks30 AS (
        SELECT COALESCE(SUM(zc.clicks), 0) AS total_clicks,
               COUNT(DISTINCT zc.fetch_date) AS active_days
        FROM zombie_clicks zc
        JOIN active_days a ON a.d = zc.fetch_date
        WHERE zc.tenant_id = $1
      ),
      orders30 AS (
        SELECT COUNT(DISTINCT o.id) AS total_orders,
               COALESCE(SUM(o.grand_total_products), 0) AS total_revenue
        FROM orders o
        JOIN active_days a ON a.d = o.order_date::date
        WHERE o.tenant_id = $1 AND o.order_status NOT IN ('canceled','closed','pending_payment')
      )
      SELECT clicks30.total_clicks,
             clicks30.active_days,
             orders30.total_orders,
             orders30.total_revenue,
             (SELECT d FROM effective_start) AS effective_start_date
      FROM clicks30, orders30
    `, [tenantId, ga4StartDate]);

    const totalClicks = parseInt(k30.total_clicks) || 0;
    const activeDays = parseInt(k30.active_days) || 0;
    const totalOrders = parseInt(k30.total_orders) || 0;       // ordini store totali sui gg attivi
    const totalRevenue = parseFloat(k30.total_revenue) || 0;   // fatturato store totale sui gg attivi (per riferimento)
    const totalClickCost = +(totalClicks * cpc).toFixed(2);
    // Incidenza: usa il fatturato TP-attribuito (direct + indirect). Fallback al fatturato store
    // solo se GA4 non ha ancora dati popolati (= primo run) per evitare divisioni per 0.
    const incidenceDenominator = tpAttributedTotal > 0 ? tpAttributedTotal : totalRevenue;
    const incidence = incidenceDenominator > 0
      ? +((totalClickCost / incidenceDenominator) * 100).toFixed(2)
      : 0;
    const incidenceBasis = tpAttributedTotal > 0 ? 'tp_attributed' : 'store_fallback';
    // Conv rate sul TP: transazioni TP / click TP
    const convRate = totalClicks > 0
      ? +((tpAttributedTransactions || totalOrders) / totalClicks * 100).toFixed(2)
      : 0;
    const revenueSource = cfg.revenue_source || 'magento';
    const totalValueTP = tpAttributedTotal;

    // Feed counts dalla source-of-truth: stable_feed_codes (cio' che davvero esce a TP).
    // Il JSON e' { codes: [...], removeCodes: [...], updatedAt }, non un array piatto.
    let feedTotalSize = 0;
    let priceCutsSize = 0;
    let removedSize = 0;
    try {
      const { rows: stableRows } = await pool.query(
        `SELECT config_key, config_value FROM tenant_configs
         WHERE tenant_id = $1 AND config_key IN ('stable_feed_codes','stable_price_cuts')`,
        [tenantId]
      );
      for (const r of stableRows) {
        try {
          const val = JSON.parse(r.config_value);
          if (r.config_key === 'stable_feed_codes') {
            if (Array.isArray(val)) feedTotalSize = val.length;
            else if (val && Array.isArray(val.codes)) feedTotalSize = val.codes.length;
          }
          if (r.config_key === 'stable_price_cuts') {
            if (Array.isArray(val)) priceCutsSize = val.length;
            else if (val && Array.isArray(val.products)) priceCutsSize = val.products.length;
          }
        } catch {}
      }
    } catch {}
    // toRemove dalla feed_quarantine attiva (= cio' che il sistema sta tenendo fuori dal feed ora)
    try {
      const { rows: [qc] } = await pool.query(
        `SELECT COUNT(*)::int n FROM feed_quarantine WHERE tenant_id=$1 AND reactivated=false`,
        [tenantId]
      );
      removedSize = parseInt(qc.n) || 0;
    } catch {}

    res.json({
      kpis: {
        // KPI principali — sempre ultimi 30gg, solo giorni TP attivi per incidenza
        windowDays: 30,
        activeDays,
        effectiveStartDate: k30.effective_start_date,  // data di inizio reale della window (per GA4 onboardati di recente)
        incidence,
        incidenceBasis,                              // 'tp_attributed' | 'store_fallback'
        convRate,
        // Fatturato TP attribuito (direct + indirect)
        tpRevenueDirect: tpDirectRevenue,
        tpRevenueIndirect: tpIndirectRevenue,
        tpRevenueTotal: tpAttributedTotal,
        tpTransactions: tpAttributedTransactions,
        // Fatturato store (per riferimento)
        storeRevenue: +totalRevenue.toFixed(2),
        storeOrders: totalOrders,
        revenueSource,
        totalClicks,
        totalOrders,
        clickCost: totalClickCost,
        // Feed feedo source-of-truth (stable_feed_codes) — cio' che davvero arriva a TP
        feedTotal: feedTotalSize,
        toRemove: removedSize,
        priceCuts: priceCutsSize,
        feedConverters: parseInt(feedOverview.converters) || 0,
        feedMonitor: parseInt(feedOverview.monitor) || 0,
        quarantined: parseInt(quarantineCount.count) || 0,
        pepite: parseInt(feedOverview.pepite) || 0,
        feedLastRun: cfg.feed_last_run || null,
      },
      topSellers,
      highMargin,
      highRotation,
      seasonal,
      dailyTrend: await getDailyTrend(tenantId, 30, ga4StartDate),
      channelDistribution: await getChannelDistribution(tenantId),
      openFindings: await getOpenFindings(tenantId),
    });
  } catch (err) {
    console.error('[Optimization] Dashboard error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/segments — counts dei segmenti prodotti del feed (per pie chart)
router.get('/segments', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { rows: actionRows } = await pool.query(`
      SELECT action, COUNT(*)::int n,
             COALESCE(SUM(cost_consumed), 0)::float cost,
             COALESCE(SUM(direct_revenue + indirect_revenue), 0)::float revenue,
             COALESCE(SUM(clicks_consumed), 0)::int clicks
      FROM feed_actions
      WHERE tenant_id = $1
      GROUP BY action
    `, [tenantId]);
    const { rows: [qc] } = await pool.query(
      `SELECT COUNT(*)::int n FROM feed_quarantine WHERE tenant_id=$1 AND reactivated=false`,
      [tenantId]
    );
    // Burner = SKU con click ma 0 ordini negli ultimi 30gg (= candidati REMOVE non ancora processati)
    const { rows: [burnerRow] } = await pool.query(`
      WITH zc AS (
        SELECT product_code AS sku, SUM(clicks) AS clicks
        FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 30
        GROUP BY 1
      ),
      ord AS (
        SELECT oi.sku, COUNT(DISTINCT o.id) AS ords
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.tenant_id = $1 AND o.order_status NOT IN ('canceled','closed','pending_payment')
          AND o.order_date::date >= CURRENT_DATE - 30
        GROUP BY 1
      ),
      cfg AS (SELECT COALESCE(MAX(config_value)::numeric, 0.27) cpc FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc')
      SELECT COUNT(*)::int n,
             COALESCE(SUM(zc.clicks), 0)::int clicks,
             ROUND((COALESCE(SUM(zc.clicks), 0) * (SELECT cpc FROM cfg))::numeric, 2)::float cost
      FROM zc LEFT JOIN ord USING(sku)
      WHERE COALESCE(ord.ords, 0) = 0 AND zc.clicks >= 2
    `, [tenantId]);
    // Feed total (verità: stable_feed_codes)
    let feedTotal = 0;
    try {
      const { rows: stableRows } = await pool.query(
        `SELECT config_value FROM tenant_configs WHERE tenant_id=$1 AND config_key='stable_feed_codes'`,
        [tenantId]
      );
      if (stableRows[0]) {
        const val = JSON.parse(stableRows[0].config_value);
        if (Array.isArray(val)) feedTotal = val.length;
        else if (val && Array.isArray(val.codes)) feedTotal = val.codes.length;
      }
    } catch {}

    // INERTI: SKU civetta=true (= nel feed) ma senza click 30gg.
    // Sub-segmentazione:
    // - HIGH_POTENTIAL: vendono altrove (sales_30d_aggregated >= 3) E margine >= 12% → pepite nascoste
    // - LOW_POTENTIAL: niente vendite altrove o margine basso → candidati per cleanup
    const { rows: [inerti] } = await pool.query(`
      WITH zc AS (
        SELECT product_code AS sku FROM zombie_clicks
        WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 30 GROUP BY 1
      )
      SELECT
        COUNT(*) FILTER (WHERE p.is_civetta = true AND zc.sku IS NULL
                         AND (p.erp_stock > 0 OR p.supplier_stock > 0)
                         AND p.sell_price > 0
                         AND COALESCE(p.sales_30d_aggregated, 0) >= 3
                         AND p.margin_pct >= 12)::int AS high_potential,
        COUNT(*) FILTER (WHERE p.is_civetta = true AND zc.sku IS NULL
                         AND (p.erp_stock > 0 OR p.supplier_stock > 0)
                         AND p.sell_price > 0
                         AND (COALESCE(p.sales_30d_aggregated, 0) < 3 OR p.margin_pct < 12))::int AS low_potential,
        COUNT(*) FILTER (WHERE p.is_civetta = true AND zc.sku IS NULL)::int AS total_inerti
      FROM products p
      LEFT JOIN zc USING(sku)
      WHERE p.tenant_id = $1
    `, [tenantId]);

    res.json({
      action_counts: actionRows,
      quarantine_count: qc.n,
      burner_30d: burnerRow,
      feed_total: feedTotal,
      inerti: {
        high_potential: parseInt(inerti.high_potential) || 0,
        low_potential: parseInt(inerti.low_potential) || 0,
        total: parseInt(inerti.total_inerti) || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/optimization/segments/:type — top SKU di un segmento (per drill-down on click)
router.get('/segments/:type', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const type = req.params.type.toUpperCase();
    let rows = [];
    if (type === 'BURNER') {
      // SKU con click ultimi 30gg, 0 ordini, ordinati per spesa
      const r = await pool.query(`
        WITH zc AS (
          SELECT product_code AS sku, SUM(clicks) AS clicks
          FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 30
          GROUP BY 1
        ),
        ord AS (
          SELECT oi.sku, COUNT(DISTINCT o.id) AS ords
          FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE o.tenant_id = $1 AND o.order_status NOT IN ('canceled','closed','pending_payment')
            AND o.order_date::date >= CURRENT_DATE - 30
          GROUP BY 1
        ),
        cfg AS (SELECT COALESCE(MAX(config_value)::numeric, 0.27) cpc FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc')
        SELECT zc.sku, zc.clicks::int,
               ROUND((zc.clicks * (SELECT cpc FROM cfg))::numeric, 2)::float cost,
               p.sell_price::float, p.margin_pct::float, p.is_civetta,
               LEFT(p.product_name, 60) AS product_name, p.brand
        FROM zc
        LEFT JOIN ord USING(sku)
        LEFT JOIN products p ON p.tenant_id = $1 AND p.sku = zc.sku
        WHERE COALESCE(ord.ords, 0) = 0 AND zc.clicks >= 2
        ORDER BY zc.clicks DESC LIMIT 50
      `, [tenantId]);
      rows = r.rows;
    } else if (type === 'INERTI_HIGH' || type === 'INERTI_HIGH_POTENTIAL') {
      // Inerti high-potential: civetta=true, 0 click 30gg, vendite altrove >=3, margine >=12%
      const r = await pool.query(`
        WITH zc AS (
          SELECT product_code AS sku FROM zombie_clicks
          WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 30 GROUP BY 1
        )
        SELECT p.sku, LEFT(p.product_name, 60) AS product_name, p.brand,
               p.sell_price::float, p.erp_cost::float, p.margin_pct::float,
               p.sales_30d_aggregated::float AS sales_g, p.sales_30d_seller::float AS sales_seller,
               p.scraper_position
        FROM products p
        LEFT JOIN zc USING(sku)
        WHERE p.tenant_id = $1 AND p.is_civetta = true AND zc.sku IS NULL
          AND (p.erp_stock > 0 OR p.supplier_stock > 0) AND p.sell_price > 0
          AND COALESCE(p.sales_30d_aggregated, 0) >= 3 AND p.margin_pct >= 12
        ORDER BY p.sales_30d_aggregated DESC, p.margin_pct DESC LIMIT 50
      `, [tenantId]);
      rows = r.rows;
    } else if (type === 'INERTI_LOW' || type === 'INERTI_LOW_POTENTIAL') {
      const r = await pool.query(`
        WITH zc AS (
          SELECT product_code AS sku FROM zombie_clicks
          WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 30 GROUP BY 1
        )
        SELECT p.sku, LEFT(p.product_name, 60) AS product_name, p.brand,
               p.sell_price::float, p.margin_pct::float,
               p.sales_30d_aggregated::float AS sales_g
        FROM products p
        LEFT JOIN zc USING(sku)
        WHERE p.tenant_id = $1 AND p.is_civetta = true AND zc.sku IS NULL
          AND (p.erp_stock > 0 OR p.supplier_stock > 0) AND p.sell_price > 0
          AND (COALESCE(p.sales_30d_aggregated, 0) < 3 OR p.margin_pct < 12)
        ORDER BY p.margin_pct DESC NULLS LAST LIMIT 50
      `, [tenantId]);
      rows = r.rows;
    } else if (type === 'QUARANTINE' || type === 'QUARANTENA') {
      const r = await pool.query(`
        SELECT fq.sku, fq.reason, fq.quarantine_level, fq.quarantine_start::date::text AS start_date,
               LEFT(p.product_name, 60) AS product_name, p.sell_price::float, p.margin_pct::float, p.brand
        FROM feed_quarantine fq
        LEFT JOIN products p ON p.tenant_id = fq.tenant_id AND p.sku = fq.sku
        WHERE fq.tenant_id = $1 AND fq.reactivated = false
        ORDER BY fq.quarantine_start DESC LIMIT 50
      `, [tenantId]);
      rows = r.rows;
    } else {
      // Generico: feed_actions filtrati per action
      const r = await pool.query(`
        SELECT fa.sku, fa.action, fa.action_reason, fa.clicks_consumed::int, fa.cost_consumed::float,
               fa.direct_revenue::float, fa.indirect_revenue::float, fa.has_conversions,
               fa.tp_position, fa.recommended_price::float, fa.price_cut_pct,
               LEFT(p.product_name, 60) AS product_name, p.sell_price::float, p.margin_pct::float, p.brand
        FROM feed_actions fa
        LEFT JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
        WHERE fa.tenant_id = $1 AND UPPER(fa.action) = $2
        ORDER BY fa.cost_consumed DESC NULLS LAST LIMIT 50
      `, [tenantId, type]);
      rows = r.rows;
    }
    res.json({ type, count: rows.length, items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/optimization/messages — timeline supervisor + feedEngine
router.get('/messages', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const limit = Math.min(parseInt(req.query.limit || 30), 100);
    const { rows: supervisor } = await pool.query(`
      SELECT id, run_type, model_used, llm_summary AS summary, findings_count, red_count, yellow_count,
             cost_usd::float, started_at, completed_at, status
      FROM supervisor_runs
      WHERE tenant_id = $1 AND llm_summary IS NOT NULL AND llm_summary != ''
      ORDER BY started_at DESC LIMIT $2
    `, [tenantId, limit]);
    const { rows: optimizer } = await pool.query(`
      SELECT id, action_type, description, products_affected, action_date,
             snapshot_incidence::float AS incidence, snapshot_revenue::float AS revenue,
             snapshot_click_cost::float AS cost, created_by
      FROM optimization_log
      WHERE tenant_id = $1
      ORDER BY action_date DESC LIMIT $2
    `, [tenantId, limit]);
    res.json({ supervisor, optimizer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard helpers (charts + alerts) ──────────────────────
async function getDailyTrend(tenantId, days, ga4StartDate) {
  // Daily breakdown ultimi N giorni: click, cost, store_orders, store_revenue
  // Rispetta ga4_data_start_date per allineare alla finestra dati GA4 disponibili.
  const { rows } = await pool.query(`
    WITH effective_start AS (
      SELECT GREATEST(
        CURRENT_DATE - ($2::int || ' days')::interval,
        COALESCE($3::date, CURRENT_DATE - ($2::int || ' days')::interval)
      )::date AS d
    ),
    days AS (
      SELECT generate_series((SELECT d FROM effective_start), CURRENT_DATE - 1, '1 day'::interval)::date AS d
    ),
    clicks AS (
      SELECT fetch_date::date d, SUM(clicks) c
      FROM zombie_clicks WHERE tenant_id = $1 GROUP BY 1
    ),
    orders_d AS (
      SELECT order_date::date d, COUNT(*) o, SUM(grand_total_products) r
      FROM orders
      WHERE tenant_id = $1 AND order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY 1
    ),
    cfg AS (SELECT COALESCE(MAX(config_value)::numeric, 0.27) cpc FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc')
    SELECT d.d::text AS date,
           COALESCE(clicks.c, 0)::int AS clicks,
           ROUND((COALESCE(clicks.c, 0) * (SELECT cpc FROM cfg))::numeric, 2)::float AS cost,
           COALESCE(orders_d.o, 0)::int AS orders,
           ROUND(COALESCE(orders_d.r, 0)::numeric, 2)::float AS revenue
    FROM days d
    LEFT JOIN clicks USING (d)
    LEFT JOIN orders_d USING (d)
    ORDER BY d.d
  `, [tenantId, days, ga4StartDate]);
  return rows;
}

async function getChannelDistribution(tenantId) {
  // Estrai distribuzione canali GA4 dal config raw (se persistito) o ritorna shape
  // base con TP-direct + TP-indirect dai config noti.
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM health_config WHERE tenant_id=$1
     AND config_key IN ('ga4_tp_revenue_30d','ga4_cross_session_revenue_30d',
                        'ga4_tp_transactions_30d','ga4_cross_session_transactions_30d',
                        'ga4_tp_sessions_30d')`,
    [tenantId]
  );
  const c = {};
  for (const r of rows) c[r.config_key] = parseFloat(r.config_value) || 0;
  // Shape minimo: TP direct + indirect (i canali full breakdown sono in ga4Analytics ma non persistiti per canale)
  const out = [];
  if (c.ga4_tp_revenue_30d > 0) {
    out.push({ channel: 'Trovaprezzi (last-click)', revenue: c.ga4_tp_revenue_30d, transactions: c.ga4_tp_transactions_30d || 0, sessions: c.ga4_tp_sessions_30d || 0 });
  }
  if (c.ga4_cross_session_revenue_30d > 0) {
    out.push({ channel: 'Trovaprezzi (cross-session)', revenue: c.ga4_cross_session_revenue_30d, transactions: c.ga4_cross_session_transactions_30d || 0, sessions: 0 });
  }
  return out;
}

async function getOpenFindings(tenantId) {
  try {
    const { rows } = await pool.query(`
      SELECT id, severity, category, title, description, recommended_action, last_seen_at
      FROM supervisor_findings
      WHERE tenant_id = $1 AND resolved_at IS NULL
        AND severity IN ('red','yellow')
        AND (silenced_until IS NULL OR silenced_until < NOW())
      ORDER BY CASE severity WHEN 'red' THEN 1 ELSE 2 END, last_seen_at DESC
      LIMIT 5
    `, [tenantId]);
    return rows;
  } catch { return []; }
}

// === FEED ENGINE ENDPOINTS ===

// GET /api/optimization/feed-actions - Summary + paginated actions
router.get('/feed-actions', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const actionFilter = req.query.action;
    // available=1 filtra solo SKU con erp_stock > 0 (prodotti realmente disponibili)
    const availableOnly = req.query.available === '1' || req.query.available === 'true';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;

    // Summary (rispetta filtro available se attivo)
    const summaryWhere = availableOnly
      ? `WHERE fa.tenant_id = $1 AND EXISTS (SELECT 1 FROM products p2 WHERE p2.tenant_id = fa.tenant_id AND p2.sku = fa.sku AND COALESCE(p2.erp_stock, 0) > 0)`
      : 'WHERE fa.tenant_id = $1';
    const { rows: summary } = await pool.query(`
      SELECT fa.action, COUNT(*) as count,
             SUM(fa.cost_consumed)::numeric(12,2) as total_cost,
             SUM(fa.direct_revenue)::numeric(12,2) as total_revenue
      FROM feed_actions fa ${summaryWhere}
      GROUP BY fa.action ORDER BY count DESC
    `, [req.tenantId]);

    // Paginated list
    let where = 'WHERE fa.tenant_id = $1';
    const params = [req.tenantId];
    let idx = 2;
    if (actionFilter) {
      where += ` AND fa.action = $${idx++}`;
      params.push(actionFilter);
    }
    if (availableOnly) {
      where += ` AND COALESCE(p.erp_stock, 0) > 0`;
    }

    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) FROM feed_actions fa
       LEFT JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
       ${where}`, params
    );

    const { rows: actions } = await pool.query(`
      SELECT fa.*, p.product_name, p.brand,
        p.sell_price as p_sell_price, p.erp_stock, p.erp_cost as p_erp_cost,
        p.margin_pct as p_margin_pct,
        -- current_price effettivo: valorizza sempre col sell_price dei products se
        -- feed_actions non lo ha (comune sui REMOVE dove non serve al calcolo cut).
        COALESCE(NULLIF(fa.current_price, 0), p.sell_price) AS display_price,
        -- pos TP effettiva: fa.tp_position è spesso 0. Fallback su phs.scraper_position.
        COALESCE(NULLIF(fa.tp_position, 0), phs.scraper_position) AS display_tp_position,
        -- budget_pct_used calcolato: se DB ha 0, ratio cost_consumed / (margine per click
        -- accettabile, cioè margin_eur assoluto per SKU). Rappresenta quanto stiamo
        -- bruciando rispetto al break-even.
        CASE
          WHEN fa.budget_pct_used > 0 THEN fa.budget_pct_used
          WHEN p.erp_cost > 0 AND p.sell_price > 0
            THEN ROUND(LEAST(100, fa.cost_consumed / NULLIF(p.sell_price - p.erp_cost, 0) * 100)::numeric, 1)
          ELSE NULL
        END AS display_budget_pct
      FROM feed_actions fa
      LEFT JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      LEFT JOIN product_health_scores phs ON phs.tenant_id = fa.tenant_id AND phs.sku = fa.sku
      ${where}
      ORDER BY
        CASE fa.action
          WHEN 'REMOVE' THEN 1 WHEN 'ADD' THEN 2 WHEN 'PRICE_CUT' THEN 3
          WHEN 'MONITOR' THEN 4 ELSE 5
        END,
        fa.cost_consumed DESC NULLS LAST
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limit, offset]);

    res.json({
      summary,
      actions,
      pagination: { page, limit, total: parseInt(countRow.count), totalPages: Math.ceil(parseInt(countRow.count) / limit) },
    });
  } catch (err) {
    console.error('[Optimization] Feed actions error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/predictions - Active predictions with status
router.get('/predictions', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows: summary } = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM feed_predictions WHERE tenant_id = $1
      GROUP BY status ORDER BY count DESC
    `, [req.tenantId]);

    const { rows: predictions } = await pool.query(`
      SELECT fp.*, p.product_name, p.brand
      FROM feed_predictions fp
      LEFT JOIN products p ON p.tenant_id = fp.tenant_id AND p.sku = fp.sku
      WHERE fp.tenant_id = $1
      ORDER BY
        CASE fp.status
          WHEN 'underperforming' THEN 1 WHEN 'corrected' THEN 2
          WHEN 'active' THEN 3 WHEN 'on_track' THEN 4 ELSE 5
        END,
        fp.deviation_pct ASC
      LIMIT 100
    `, [req.tenantId]);

    res.json({ summary, predictions });
  } catch (err) {
    console.error('[Optimization] Predictions error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/optimization/quarantine - Quarantined products
router.get('/quarantine', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT fq.*, p.product_name, p.brand, p.erp_stock, p.supplier_stock
      FROM feed_quarantine fq
      LEFT JOIN products p ON p.tenant_id = fq.tenant_id AND p.sku = fq.sku
      WHERE fq.tenant_id = $1 AND fq.reactivated = false
      ORDER BY fq.quarantine_end ASC
      LIMIT 200
    `, [req.tenantId]);

    res.json({ quarantined: rows });
  } catch (err) {
    console.error('[Optimization] Quarantine error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === MAGENTO SYNC ENDPOINTS ===

// POST /api/optimization/magento-sync/preview
// Shows what would happen without applying
router.post('/magento-sync/preview', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const magentoSync = require('../services/magentoSync');
    const result = await magentoSync.preview(req.tenantId);
    res.json(result);
  } catch (err) {
    console.error('[MagentoSync] Preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/optimization/magento-sync/execute
// Push changes to Magento (requires { confirm: true })
router.post('/magento-sync/execute', requireRole('superadmin'), async (req, res) => {
  try {
    const { confirm, dryRun } = req.body;
    const magentoSync = require('../services/magentoSync');
    const result = await magentoSync.execute(req.tenantId, { confirm, dryRun });
    res.json(result);
  } catch (err) {
    console.error('[MagentoSync] Execute error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DISPATCH LOG ────────────────────────────────────────

router.get('/dispatch-log', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT dl.id, dl.endpoint, dl.products_served, dl.request_ip,
             dl.api_key_name, dl.response_summary,
             COALESCE(dl.created_at, dl.dispatched_at) as created_at
      FROM feed_dispatch_log dl
      WHERE dl.tenant_id = $1
      ORDER BY COALESCE(dl.created_at, dl.dispatched_at) DESC
      LIMIT 100
    `, [req.tenantId]);
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── QUEUE STATUS ────────────────────────────────────────

router.get('/queue-status', async (req, res) => {
  try {
    const { getQueueStatus } = require('../services/apiQueue');
    res.json(getQueueStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DAILY SUMMARY ───────────────────────────────────────

router.get('/daily-summary', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM feed_daily_summary
      WHERE tenant_id = $1
      ORDER BY summary_date DESC
      LIMIT 30
    `, [req.tenantId]);
    res.json({ summaries: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── KILLERS ─────────────────────────────────────────────

router.get('/killers', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT fk.sku, p.product_name, fk.total_sellers, fk.global_demand,
             fk.avg_position, fk.reason, fk.detected_at, fk.quarantine_until
      FROM feed_killers fk
      LEFT JOIN products p ON p.sku = fk.sku AND p.tenant_id = fk.tenant_id
      WHERE fk.tenant_id = $1 AND fk.is_active = true
      ORDER BY fk.detected_at DESC
      LIMIT 200
    `, [req.tenantId]);
    res.json({ killers: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/optimization/cross-tenant - Cross-tenant product intelligence
router.get('/cross-tenant', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { verdict, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (verdict) {
      conditions.push(`verdict = $${paramIdx++}`);
      params.push(verdict);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: products } = await pool.query(`
      SELECT * FROM cross_tenant_products
      ${where}
      ORDER BY total_clicks_30d DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `, [...params, parseInt(limit), parseInt(offset)]);

    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) as total FROM cross_tenant_products ${where}`, params
    );

    // Summary
    const { rows: summary } = await pool.query(`
      SELECT verdict, COUNT(*) as count,
        SUM(total_clicks_30d) as total_clicks,
        SUM(total_orders_30d) as total_orders,
        ROUND(SUM(total_revenue_30d), 2) as total_revenue,
        ROUND(SUM(total_click_cost_30d), 2) as total_cost
      FROM cross_tenant_products
      GROUP BY verdict ORDER BY total_clicks DESC
    `);

    res.json({
      products,
      total: parseInt(countRow.total),
      summary,
      computed_at: products.length > 0 ? products[0].computed_at : null,
    });
  } catch (err) {
    console.error('[Optimization] Cross-tenant error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/optimization/cross-tenant/:sku - Cross-tenant detail for a product
router.get('/cross-tenant/:sku', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows: [product] } = await pool.query(
      `SELECT * FROM cross_tenant_products WHERE sku = $1`, [req.params.sku]
    );
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const { rows: details } = await pool.query(
      `SELECT * FROM cross_tenant_product_details WHERE sku = $1 ORDER BY revenue_30d DESC`,
      [req.params.sku]
    );

    res.json({ product, details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/optimization/price-rules - Price rules × Trovaprezzi click analysis
router.get('/price-rules', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    // Summary per rule: products, clicks, orders, revenue, incidence
    const { rows: rules } = await pool.query(`
      SELECT
        pr.rule_id, pr.rule_type, pr.rule_name,
        COUNT(DISTINCT p.sku) as products,
        COUNT(DISTINCT p.sku) FILTER (WHERE p.is_civetta = true) as civetta,
        COUNT(DISTINCT p.sku) FILTER (WHERE ph.tp_clicks_30d > 0) as with_clicks,
        COALESCE(SUM(ph.tp_clicks_30d), 0) as clicks_30d,
        ROUND(COALESCE(SUM(ph.tp_click_cost_30d), 0)::numeric, 2) as click_cost_30d,
        COALESCE(SUM(ph.tp_attributed_orders), 0) as orders_30d,
        ROUND(COALESCE(SUM(ph.tp_attributed_revenue), 0)::numeric, 2) as revenue_30d,
        CASE WHEN SUM(ph.tp_attributed_revenue) > 0
          THEN ROUND((SUM(ph.tp_click_cost_30d) / SUM(ph.tp_attributed_revenue) * 100)::numeric, 1)
          ELSE NULL END as incidence_pct,
        ROUND(AVG(CASE WHEN ph.tp_clicks_30d > 0 THEN ph.tp_clicks_30d END)::numeric, 1) as avg_clicks_per_product,
        ROUND(AVG(p.margin_pct)::numeric, 1) as avg_margin_pct,
        COUNT(DISTINCT p.sku) FILTER (WHERE ph.classification = 'star') as stars,
        COUNT(DISTINCT p.sku) FILTER (WHERE ph.classification = 'cash_cow') as cash_cows,
        COUNT(DISTINCT p.sku) FILTER (WHERE ph.classification = 'burner') as burners,
        COUNT(DISTINCT p.sku) FILTER (WHERE ph.classification = 'opportunity') as opportunities,
        COUNT(DISTINCT p.sku) FILTER (WHERE fa.action = 'REMOVE') as removed,
        COUNT(DISTINCT p.sku) FILTER (WHERE fa.action = 'PRICE_CUT') as price_cuts
      FROM price_rules pr
      LEFT JOIN products p ON p.price_rule_id = pr.rule_id AND p.tenant_id = pr.tenant_id
      LEFT JOIN product_health_scores ph ON ph.sku = p.sku AND ph.tenant_id = p.tenant_id
      LEFT JOIN feed_actions fa ON fa.sku = p.sku AND fa.tenant_id = p.tenant_id
      WHERE pr.tenant_id = $1
      GROUP BY pr.rule_id, pr.rule_type, pr.rule_name
      ORDER BY COALESCE(SUM(ph.tp_clicks_30d), 0) DESC
    `, [req.tenantId]);

    // Top clicked products per rule (top 5 per rule)
    const { rows: topProducts } = await pool.query(`
      WITH ranked AS (
        SELECT
          p.price_rule_id as rule_id,
          p.sku, p.product_name, p.sell_price, p.margin_pct, p.is_civetta,
          ph.tp_clicks_30d as clicks, ph.tp_attributed_orders as orders,
          ph.tp_attributed_revenue as revenue, ph.classification,
          ph.scraper_position, ph.scraper_best_price,
          fa.action as feed_action,
          ROW_NUMBER() OVER (PARTITION BY p.price_rule_id ORDER BY ph.tp_clicks_30d DESC) as rn
        FROM products p
        JOIN product_health_scores ph ON ph.sku = p.sku AND ph.tenant_id = p.tenant_id
        LEFT JOIN feed_actions fa ON fa.sku = p.sku AND fa.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND ph.tp_clicks_30d > 0
      )
      SELECT * FROM ranked WHERE rn <= 5
      ORDER BY rule_id, clicks DESC
    `, [req.tenantId]);

    // Group top products by rule_id
    const topByRule = {};
    for (const p of topProducts) {
      if (!topByRule[p.rule_id]) topByRule[p.rule_id] = [];
      topByRule[p.rule_id].push(p);
    }

    // Summary totals
    const totals = {
      totalProducts: rules.reduce((s, r) => s + parseInt(r.products), 0),
      totalClicks: rules.reduce((s, r) => s + parseInt(r.clicks_30d), 0),
      totalOrders: rules.reduce((s, r) => s + parseInt(r.orders_30d), 0),
      totalRevenue: rules.reduce((s, r) => s + parseFloat(r.revenue_30d), 0),
      totalCost: rules.reduce((s, r) => s + parseFloat(r.click_cost_30d), 0),
    };
    totals.incidence = totals.totalRevenue > 0 ? +(totals.totalCost / totals.totalRevenue * 100).toFixed(1) : null;

    res.json({ rules, topByRule, totals });
  } catch (err) {
    console.error('[Optimization] Price rules error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── OPTIMIZATION LOG ─────────────────────────────────────

router.get('/log', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const { rows: logs } = await pool.query(`
      SELECT id, action_date, action_type, description,
        snapshot_clicks, snapshot_click_cost, snapshot_revenue, snapshot_orders,
        snapshot_incidence, snapshot_avg_daily_cost,
        snapshot_products_in_feed, snapshot_products_removed, snapshot_price_cuts,
        products_affected, created_by
      FROM optimization_log
      WHERE tenant_id = $1
      ORDER BY action_date DESC
      LIMIT $2
    `, [req.tenantId, limit]);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MODULE ENDPOINTS ────────────────────────────────────

// GET /api/optimization/modules - Module status for current tenant
router.get('/modules', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1 AND config_key LIKE 'feed_%_enabled'`,
      [req.tenantId]
    );
    const modules = {};
    for (const r of rows) modules[r.config_key] = r.config_value === 'true';
    res.json({ modules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/optimization/modules/:key - Toggle a module
router.put('/modules/:key', requireRole('superadmin', 'admin'), async (req, res) => {
  const allowed = ['feed_category_rules_enabled', 'feed_cap_enabled', 'feed_competitor_analysis_enabled', 'feed_position_analysis_enabled'];
  const key = req.params.key;
  if (!allowed.includes(key)) return res.status(400).json({ error: 'Invalid module key' });
  const value = req.body.enabled ? 'true' : 'false';
  await pool.query(
    `INSERT INTO health_config (tenant_id, config_key, config_value, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $3, updated_at = NOW()`,
    [req.tenantId, key, value]
  );
  res.json({ key, enabled: req.body.enabled });
});

// ─── MODULE 1: Category Rules ─────────────────────────

router.get('/category-rules', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    // Current rules
    const { rows: [cfg] } = await pool.query(
      `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'feed_category_rules'`,
      [req.tenantId]
    );
    const rules = JSON.parse(cfg?.config_value || '{}');
    const { rows: [enabledCfg] } = await pool.query(
      `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'feed_category_rules_enabled'`,
      [req.tenantId]
    );
    const enabled = enabledCfg?.config_value === 'true';

    // Stats per category
    const { rows: categories } = await pool.query(`
      SELECT zc.trovaprezzi_category as category,
        COUNT(DISTINCT zc.product_code) as products,
        SUM(zc.clicks) as clicks,
        ROUND(SUM(zc.clicks) * 0.27, 2) as cost,
        COUNT(DISTINCT zc.product_code) FILTER (WHERE ph.tp_attributed_orders > 0) as with_orders,
        COALESCE(SUM(ph.tp_attributed_orders), 0) as orders,
        ROUND(COALESCE(SUM(ph.tp_attributed_revenue), 0)::numeric, 2) as revenue,
        CASE WHEN SUM(ph.tp_attributed_revenue) > 0
          THEN ROUND((SUM(zc.clicks) * 0.27 / SUM(ph.tp_attributed_revenue) * 100)::numeric, 1)
          ELSE NULL END as incidence,
        ROUND(AVG(p.margin_pct)::numeric, 1) as avg_margin
      FROM zombie_clicks zc
      JOIN products p ON p.sku = zc.product_code AND p.tenant_id = zc.tenant_id
      LEFT JOIN product_health_scores ph ON ph.sku = zc.product_code AND ph.tenant_id = zc.tenant_id
      WHERE zc.tenant_id = $1 AND zc.fetch_date >= CURRENT_DATE - 14
        AND zc.trovaprezzi_category != ''
      GROUP BY zc.trovaprezzi_category
      HAVING SUM(zc.clicks) >= 5
      ORDER BY SUM(zc.clicks) DESC
    `, [req.tenantId]);

    // Merge rules with stats
    const merged = categories.map(c => ({
      ...c,
      rule: rules[c.category] || null,
    }));

    res.json({ enabled, rules, categories: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/category-rules', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { enabled, rules } = req.body;
    if (enabled !== undefined) {
      await pool.query(
        `INSERT INTO health_config (tenant_id, config_key, config_value, updated_at) VALUES ($1, 'feed_category_rules_enabled', $2, NOW())
         ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2, updated_at = NOW()`,
        [req.tenantId, String(enabled)]
      );
    }
    if (rules) {
      await pool.query(
        `INSERT INTO health_config (tenant_id, config_key, config_value, updated_at) VALUES ($1, 'feed_category_rules', $2, NOW())
         ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2, updated_at = NOW()`,
        [req.tenantId, JSON.stringify(rules)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MODULE 2: Feed Cap ───────────────────────────────

router.get('/feed-cap', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1 AND config_key IN ('feed_cap_enabled', 'feed_cap_max')`,
      [req.tenantId]
    );
    const cfg = {};
    for (const r of rows) cfg[r.config_key] = r.config_value;

    const { rows: [feedCount] } = await pool.query(
      `SELECT jsonb_array_length(config_value::jsonb->'codes') as count FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'stable_feed_codes'`,
      [req.tenantId]
    );

    res.json({
      enabled: cfg.feed_cap_enabled === 'true',
      capMax: parseInt(cfg.feed_cap_max || 25000),
      currentFeedCount: parseInt(feedCount?.count || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/feed-cap', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { enabled, capMax } = req.body;
    if (enabled !== undefined) {
      await pool.query(
        `INSERT INTO health_config (tenant_id, config_key, config_value, updated_at) VALUES ($1, 'feed_cap_enabled', $2, NOW())
         ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2, updated_at = NOW()`,
        [req.tenantId, String(enabled)]
      );
    }
    if (capMax) {
      await pool.query(
        `INSERT INTO health_config (tenant_id, config_key, config_value, updated_at) VALUES ($1, 'feed_cap_max', $2, NOW())
         ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2, updated_at = NOW()`,
        [req.tenantId, String(parseInt(capMax))]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MODULE 5: Competitor Gap Analysis ────────────────

router.get('/competitor-gaps', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows: gaps } = await pool.query(`
      SELECT cs_today.product_code as sku, p.product_name,
        cs_today.merchant_count as merchants_now,
        cs_prev.merchant_count as merchants_7d_ago,
        cs_prev.merchant_count - cs_today.merchant_count as merchants_lost,
        cs_today.best_price, cs_today.our_position, cs_today.our_price,
        ph.tp_clicks_30d as clicks, ph.tp_attributed_orders as orders,
        ROUND(ph.tp_attributed_revenue::numeric, 2) as revenue,
        ph.classification,
        COALESCE(fa.action, 'in feed') as feed_action
      FROM competitor_snapshots cs_today
      LEFT JOIN competitor_snapshots cs_prev
        ON cs_prev.tenant_id = cs_today.tenant_id AND cs_prev.product_code = cs_today.product_code
        AND cs_prev.snapshot_date = (SELECT MAX(snapshot_date) FROM competitor_snapshots WHERE tenant_id = $1 AND snapshot_date < cs_today.snapshot_date - 3)
      JOIN products p ON p.sku = cs_today.product_code AND p.tenant_id = $1
      LEFT JOIN product_health_scores ph ON ph.sku = cs_today.product_code AND ph.tenant_id = $1
      LEFT JOIN feed_actions fa ON fa.sku = cs_today.product_code AND fa.tenant_id = $1
      WHERE cs_today.tenant_id = $1
        AND cs_today.snapshot_date = (SELECT MAX(snapshot_date) FROM competitor_snapshots WHERE tenant_id = $1)
        AND cs_prev.merchant_count IS NOT NULL
        AND cs_prev.merchant_count - cs_today.merchant_count >= 2
      ORDER BY cs_prev.merchant_count - cs_today.merchant_count DESC
      LIMIT 100
    `, [req.tenantId]);

    res.json({ gaps, snapshotDate: gaps[0]?.snapshot_date || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MODULE 8: Position Analysis ──────────────────────

router.get('/position-analysis', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows: products } = await pool.query(`
      SELECT pp.product_code as sku, p.product_name,
        pp.current_position, pp.optimal_position,
        pp.current_price, pp.recommended_price,
        ROUND(pp.potential_savings::numeric, 2) as potential_savings,
        pp.optimal_reason,
        pp.pos1_clicks, pp.pos2_clicks, pp.pos3_clicks, pp.pos4_clicks, pp.pos5_clicks,
        pp.total_orders, ROUND(pp.total_revenue::numeric, 2) as total_revenue,
        ph.classification
      FROM position_performance pp
      JOIN products p ON p.sku = pp.product_code AND p.tenant_id = $1
      LEFT JOIN product_health_scores ph ON ph.sku = pp.product_code AND ph.tenant_id = $1
      WHERE pp.tenant_id = $1
        AND pp.analysis_date = (SELECT MAX(analysis_date) FROM position_performance WHERE tenant_id = $1)
        AND pp.optimal_position IS NOT NULL
      ORDER BY pp.potential_savings DESC NULLS LAST
      LIMIT 100
    `, [req.tenantId]);

    res.json({ products, analysisDate: products[0]?.analysis_date || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/optimization/export/:type - Download Excel export
router.get('/export/:type', requireRole('superadmin', 'admin'), async (req, res) => {
  const ExcelJS = require('exceljs');
  const type = req.params.type;
  const tenantId = req.tenantId;

  try {
    const workbook = new ExcelJS.Workbook();
    let sheet;

    if (type === 'burners') {
      const { rows } = await pool.query(`
        SELECT ph.sku as "Minsan", p.product_name as "Prodotto", p.brand as "Brand",
          ph.classification as "Classe", ph.health_score as "Score",
          ph.tp_clicks_30d as "Click 30gg", ROUND(ph.tp_click_cost_30d::numeric, 2) as "Costo Click",
          ph.tp_attributed_orders as "Ordini TP", ROUND(ph.tp_attributed_revenue::numeric, 2) as "Revenue TP",
          ROUND((ph.tp_cost_incidence * 100)::numeric, 1) as "Incidenza %",
          ROUND(p.sell_price::numeric, 2) as "Prezzo", ROUND(p.erp_cost::numeric, 2) as "Costo ERP",
          ROUND(p.margin_pct::numeric, 1) as "Margine %",
          p.is_civetta as "Civetta", p.erp_stock as "Stock ERP", p.supplier_stock as "Stock Fornitore",
          ph.rec_reasoning as "Note"
        FROM product_health_scores ph
        LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
        WHERE ph.tenant_id = $1 AND ph.classification = 'burner'
        ORDER BY ph.tp_click_cost_30d DESC
      `, [tenantId]);
      sheet = workbook.addWorksheet('Burner');
      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: k === 'Prodotto' ? 40 : k === 'Note' ? 50 : 15 }));
        sheet.addRows(rows);
      }

    } else if (type === 'products') {
      const classification = req.query.classification || null;
      let where = 'WHERE ph.tenant_id = $1';
      const params = [tenantId];
      if (classification) { where += ' AND ph.classification = $2'; params.push(classification); }
      const { rows } = await pool.query(`
        SELECT ph.sku as "Minsan", p.product_name as "Prodotto", p.brand as "Brand",
          ph.classification as "Classe", ph.health_score as "Score",
          ph.tp_clicks_30d as "Click 30gg", ROUND(ph.tp_click_cost_30d::numeric, 2) as "Costo Click",
          ph.tp_attributed_orders as "Ordini TP", ROUND(ph.tp_attributed_revenue::numeric, 2) as "Revenue TP",
          ROUND((ph.tp_cost_incidence * 100)::numeric, 1) as "Incidenza %",
          ph.scraper_position as "Posizione TP", ph.scraper_competitor_count as "Competitor",
          ROUND(ph.scraper_best_price::numeric, 2) as "Best Price",
          ROUND(p.sell_price::numeric, 2) as "Prezzo", ROUND(p.erp_cost::numeric, 2) as "Costo ERP",
          ROUND(p.margin_pct::numeric, 1) as "Margine %",
          p.is_civetta as "Civetta", p.erp_stock as "Stock ERP", p.supplier_stock as "Stock Fornitore",
          p.sales_30d_seller as "Vendite Store 30gg", p.sales_30d_aggregated as "Vendite Globali 30gg",
          ph.rec_price_action as "Azione Prezzo", ROUND(ph.rec_price::numeric, 2) as "Prezzo Raccomandato",
          ph.rec_priority as "Priorita", ph.rec_reasoning as "Note"
        FROM product_health_scores ph
        LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
        ${where}
        ORDER BY ph.tp_click_cost_30d DESC
      `, params);
      sheet = workbook.addWorksheet('Prodotti');
      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: k === 'Prodotto' ? 40 : k === 'Note' ? 50 : 15 }));
        sheet.addRows(rows);
      }

    } else if (type === 'feed-actions') {
      const { rows } = await pool.query(`
        SELECT fa.sku as "Minsan", p.product_name as "Prodotto", p.brand as "Brand",
          fa.action as "Azione", fa.action_reason as "Motivo",
          fa.clicks_consumed as "Click", ROUND(fa.cost_consumed::numeric, 2) as "Costo",
          ROUND(fa.direct_revenue::numeric, 2) as "Revenue",
          fa.has_conversions as "Converte",
          ROUND(fa.current_price::numeric, 2) as "Prezzo Attuale",
          ROUND(fa.recommended_price::numeric, 2) as "Prezzo Raccomandato",
          ROUND(fa.price_cut_pct::numeric, 1) as "Taglio %",
          fa.tp_position as "Posizione", fa.competitor_count as "Competitor",
          fa.erp_stock as "Stock ERP", fa.supplier_stock as "Stock Fornitore"
        FROM feed_actions fa
        LEFT JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
        WHERE fa.tenant_id = $1
        ORDER BY CASE fa.action WHEN 'REMOVE' THEN 1 WHEN 'PRICE_CUT' THEN 2 WHEN 'ADD' THEN 3 WHEN 'KEEP' THEN 4 ELSE 5 END,
          fa.cost_consumed DESC NULLS LAST
      `, [tenantId]);
      sheet = workbook.addWorksheet('Feed Actions');
      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: k === 'Prodotto' ? 40 : k === 'Motivo' ? 60 : 15 }));
        sheet.addRows(rows);
      }

    } else if (type === 'opportunities') {
      const { rows } = await pool.query(`
        SELECT ph.sku as "Minsan", p.product_name as "Prodotto", p.brand as "Brand",
          ph.classification as "Classe", ph.health_score as "Score",
          ph.tp_clicks_30d as "Click 30gg", ROUND(ph.tp_click_cost_30d::numeric, 2) as "Costo Click",
          ph.tp_attributed_orders as "Ordini TP", ROUND(ph.tp_attributed_revenue::numeric, 2) as "Revenue TP",
          ROUND(p.sell_price::numeric, 2) as "Prezzo", ROUND(p.margin_pct::numeric, 1) as "Margine %",
          p.sales_30d_seller as "Vendite Store", p.sales_30d_aggregated as "Vendite Globali",
          ph.scraper_position as "Posizione", ph.mc_click_potential as "Potenziale MC",
          p.erp_stock as "Stock ERP", p.supplier_stock as "Stock Fornitore"
        FROM product_health_scores ph
        LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
        WHERE ph.tenant_id = $1 AND ph.classification = 'opportunity'
        ORDER BY ph.health_score DESC
      `, [tenantId]);
      sheet = workbook.addWorksheet('Opportunita');
      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: k === 'Prodotto' ? 40 : 15 }));
        sheet.addRows(rows);
      }

    } else if (type === 'cross-tenant') {
      const { rows } = await pool.query(`
        SELECT sku as "Minsan", product_name as "Prodotto", brand as "Brand",
          verdict as "Verdetto", tenant_count as "N Tenant",
          tenants_with_clicks as "Tenant con Click", tenants_with_orders as "Tenant con Ordini",
          star_count as "Star", cash_cow_count as "Cash Cow", burner_count as "Burner",
          total_clicks_30d as "Click Totali", total_orders_30d as "Ordini Totali",
          ROUND(total_revenue_30d::numeric, 2) as "Revenue Totale",
          ROUND(total_click_cost_30d::numeric, 2) as "Costo Click",
          ROUND(avg_cost_incidence::numeric, 1) as "Incidenza Media %",
          ROUND(best_sell_price::numeric, 2) as "Miglior Prezzo",
          ROUND(scraper_best_price::numeric, 2) as "Best Competitor"
        FROM cross_tenant_products
        WHERE verdict IN ('cross_quarantine', 'universal_star', 'universal_burner')
        ORDER BY total_clicks_30d DESC
      `);
      sheet = workbook.addWorksheet('Cross-Tenant');
      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: k === 'Prodotto' ? 40 : 15 }));
        sheet.addRows(rows);
      }

    } else if (type === 'price-rules') {
      const { rows } = await pool.query(`
        SELECT pr.rule_name as "Regola", pr.rule_type as "Tipo",
          COUNT(DISTINCT p.sku) as "Prodotti",
          COUNT(DISTINCT p.sku) FILTER (WHERE p.is_civetta = true) as "Civetta",
          COUNT(DISTINCT p.sku) FILTER (WHERE ph.tp_clicks_30d > 0) as "Con Click",
          COALESCE(SUM(ph.tp_clicks_30d), 0) as "Click 30gg",
          ROUND(COALESCE(SUM(ph.tp_click_cost_30d), 0)::numeric, 2) as "Costo Click",
          COALESCE(SUM(ph.tp_attributed_orders), 0) as "Ordini",
          ROUND(COALESCE(SUM(ph.tp_attributed_revenue), 0)::numeric, 2) as "Revenue",
          CASE WHEN SUM(ph.tp_attributed_revenue) > 0
            THEN ROUND((SUM(ph.tp_click_cost_30d) / SUM(ph.tp_attributed_revenue) * 100)::numeric, 1)
            ELSE NULL END as "Incidenza %",
          ROUND(AVG(p.margin_pct)::numeric, 1) as "Margine Medio %",
          COUNT(DISTINCT p.sku) FILTER (WHERE ph.classification = 'star') as "Star",
          COUNT(DISTINCT p.sku) FILTER (WHERE ph.classification = 'burner') as "Burner",
          COUNT(DISTINCT p.sku) FILTER (WHERE fa.action = 'REMOVE') as "Rimossi"
        FROM price_rules pr
        LEFT JOIN products p ON p.price_rule_id = pr.rule_id AND p.tenant_id = pr.tenant_id
        LEFT JOIN product_health_scores ph ON ph.sku = p.sku AND ph.tenant_id = p.tenant_id
        LEFT JOIN feed_actions fa ON fa.sku = p.sku AND fa.tenant_id = p.tenant_id
        WHERE pr.tenant_id = $1
        GROUP BY pr.rule_id, pr.rule_type, pr.rule_name
        ORDER BY COALESCE(SUM(ph.tp_clicks_30d), 0) DESC
      `, [tenantId]);
      sheet = workbook.addWorksheet('Regole Prezzo');
      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: k === 'Regola' ? 35 : 15 }));
        sheet.addRows(rows);
      }

    } else {
      return res.status(400).json({ error: `Tipo export non valido: ${type}. Usa: burners, products, feed-actions, opportunities, cross-tenant, price-rules` });
    }

    // Style header row
    if (sheet && sheet.rowCount > 0) {
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    }

    const filename = `xhumanpro-${type}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[Optimization] Export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
