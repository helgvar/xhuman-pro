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

    // 1. Feed overview (include quarantined as active removals)
    const { rows: [feedOverview] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE action = 'KEEP') as feed_active,
        COUNT(*) FILTER (WHERE action = 'REMOVE') as to_remove,
        COUNT(*) FILTER (WHERE action = 'ADD') as pepite,
        COUNT(*) FILTER (WHERE action = 'PRICE_CUT') as price_cuts
      FROM feed_actions WHERE tenant_id = $1
    `, [tenantId]);

    // Quarantined = effectively removed products
    const { rows: [quarantineCount] } = await pool.query(
      `SELECT COUNT(*) as count FROM feed_quarantine WHERE tenant_id = $1 AND reactivated = false`,
      [tenantId]
    );
    const totalRemoved = (parseInt(feedOverview.to_remove) || 0) + (parseInt(quarantineCount.count) || 0);

    // 2. Top selling products (by GA4 TP revenue)
    const { rows: topSellers } = await pool.query(`
      SELECT ph.sku, p.product_name, p.brand, p.sell_price,
             ph.ga4_tp_purchases, ph.ga4_tp_revenue, ph.ga4_assisted_sales,
             ph.tp_clicks_30d, ph.health_score, ph.classification
      FROM product_health_scores ph
      JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1 AND ph.ga4_tp_revenue > 0
      ORDER BY ph.ga4_tp_revenue DESC
      LIMIT 10
    `, [tenantId]);

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

    // 6. Global KPIs from health_config
    const { rows: cfgRows } = await pool.query(
      `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1
       AND config_key IN ('ga4_tp_revenue_30d','ga4_tp_transactions_30d','ga4_tp_sessions_30d',
                          'ga4_tp_conv_rate','feed_current_cost_14d','feed_current_revenue_14d',
                          'feed_projected_cost_14d','feed_savings_from_removals',
                          'feed_action_removals','feed_action_price_cuts','feed_action_additions',
                          'feed_last_run')`,
      [tenantId]
    );
    const cfg = {};
    for (const r of cfgRows) cfg[r.config_key] = r.config_value;

    // 7. Incidence (from getGlobalPnl data)
    const tpRevenue = parseFloat(cfg.ga4_tp_revenue_30d) || 0;
    const { rows: [clickCostRow] } = await pool.query(
      `SELECT SUM(tp_click_cost_30d) as total FROM product_health_scores WHERE tenant_id = $1`,
      [tenantId]
    );
    const totalClickCost = parseFloat(clickCostRow?.total) || 0;
    const incidence = tpRevenue > 0 ? (totalClickCost / tpRevenue) * 100 : 0;

    res.json({
      kpis: {
        incidence: +incidence.toFixed(1),
        tpRevenue: +tpRevenue.toFixed(2),
        tpTransactions: parseInt(cfg.ga4_tp_transactions_30d) || 0,
        tpSessions: parseInt(cfg.ga4_tp_sessions_30d) || 0,
        convRate: parseFloat(cfg.ga4_tp_conv_rate) || 0,
        clickCost: +totalClickCost.toFixed(2),
        feedActive: parseInt(feedOverview.feed_active) || 0,
        toRemove: totalRemoved,
        quarantined: parseInt(quarantineCount.count) || 0,
        pepite: parseInt(feedOverview.pepite) || 0,
        savings: parseFloat(cfg.feed_savings_from_removals) || 0,
        priceCuts: parseInt(cfg.feed_action_price_cuts) || parseInt(feedOverview.price_cuts) || 0,
        additions: parseInt(cfg.feed_action_additions) || parseInt(feedOverview.pepite) || 0,
        currentCost14d: parseFloat(cfg.feed_current_cost_14d) || 0,
        currentRevenue14d: parseFloat(cfg.feed_current_revenue_14d) || 0,
        projectedCost14d: parseFloat(cfg.feed_projected_cost_14d) || 0,
        feedLastRun: cfg.feed_last_run || null,
      },
      topSellers,
      highMargin,
      highRotation,
      seasonal,
    });
  } catch (err) {
    console.error('[Optimization] Dashboard error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === FEED ENGINE ENDPOINTS ===

// GET /api/optimization/feed-actions - Summary + paginated actions
router.get('/feed-actions', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const actionFilter = req.query.action;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;

    // Summary
    const { rows: summary } = await pool.query(`
      SELECT action, COUNT(*) as count,
             SUM(cost_consumed)::numeric(12,2) as total_cost,
             SUM(direct_revenue)::numeric(12,2) as total_revenue
      FROM feed_actions WHERE tenant_id = $1
      GROUP BY action ORDER BY count DESC
    `, [req.tenantId]);

    // Paginated list
    let where = 'WHERE fa.tenant_id = $1';
    const params = [req.tenantId];
    let idx = 2;
    if (actionFilter) {
      where += ` AND fa.action = $${idx++}`;
      params.push(actionFilter);
    }

    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) FROM feed_actions fa ${where}`, params
    );

    const { rows: actions } = await pool.query(`
      SELECT fa.*, p.product_name, p.brand, p.sell_price as p_sell_price
      FROM feed_actions fa
      LEFT JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
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

module.exports = router;
