const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { googleApiService } = require('../services/googleApi');
const { getGA4Attribution, persistGA4Attribution } = require('../services/ga4Analytics');
const { encrypt } = require('../services/crypto');

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

// GET /api/ga4/status - Check GA4 configuration status
router.get('/status', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const hasCredentials = await googleApiService.hasGA4Credentials(req.tenantId);

    // Get last run
    const { rows: [lastRun] } = await pool.query(
      `SELECT * FROM ga4_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [req.tenantId]
    );

    // Get stored GA4 KPIs from health_config
    const { rows: configRows } = await pool.query(
      `SELECT config_key, config_value FROM health_config
       WHERE tenant_id = $1 AND config_key LIKE 'ga4_%'`,
      [req.tenantId]
    );
    const ga4Config = {};
    for (const r of configRows) ga4Config[r.config_key] = r.config_value;

    res.json({
      configured: hasCredentials,
      lastRun: lastRun || null,
      trovaprezzi: {
        revenue: parseFloat(ga4Config.ga4_tp_revenue_30d) || 0,
        transactions: parseInt(ga4Config.ga4_tp_transactions_30d) || 0,
        sessions: parseInt(ga4Config.ga4_tp_sessions_30d) || 0,
        avgBasket: parseFloat(ga4Config.ga4_tp_avg_basket) || 0,
        convRate: parseFloat(ga4Config.ga4_tp_conv_rate) || 0,
      },
      lastUpdate: ga4Config.ga4_last_update || null,
    });
  } catch (err) {
    console.error('[GA4] Status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ga4/test-connection - Test GA4 connectivity
router.get('/test-connection', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    googleApiService.clearTenant(req.tenantId);
    const result = await googleApiService.testGA4Connection(req.tenantId);
    res.json(result);
  } catch (err) {
    console.error('[GA4] Test connection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ga4/credentials - Save GA4 credentials
router.post('/credentials', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { ga4PropertyId, serviceAccountJson } = req.body;

    if (!ga4PropertyId && !serviceAccountJson) {
      return res.status(400).json({ error: 'Fornire ga4PropertyId e/o serviceAccountJson' });
    }

    const updates = {};
    if (ga4PropertyId) updates.ga4_property_id = ga4PropertyId;
    if (serviceAccountJson) {
      // Validate JSON
      const parsed = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
      if (!parsed.client_email || !parsed.private_key) {
        return res.status(400).json({ error: 'Service account JSON non valido: mancano client_email o private_key' });
      }
      updates.google_service_account_json = typeof serviceAccountJson === 'string'
        ? serviceAccountJson
        : JSON.stringify(serviceAccountJson);
    }

    for (const [key, value] of Object.entries(updates)) {
      const encrypted = encrypt(value);
      await pool.query(`
        INSERT INTO tenant_configs (tenant_id, config_key, config_value)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $3
      `, [req.tenantId, key, encrypted]);
    }

    googleApiService.clearTenant(req.tenantId);
    res.json({ ok: true, saved: Object.keys(updates) });
  } catch (err) {
    console.error('[GA4] Credentials save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ga4/import - Run GA4 attribution import
router.post('/import', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    // Create run record
    const { rows: [run] } = await pool.query(
      `INSERT INTO ga4_runs (tenant_id) VALUES ($1) RETURNING id`,
      [req.tenantId]
    );

    // Run in background
    const tenantId = req.tenantId;
    (async () => {
      try {
        const result = await persistGA4Attribution(tenantId);

        // Save daily channel snapshot
        const ga4Data = await getGA4Attribution(tenantId);
        if (ga4Data?.channelKpis) {
          const today = new Date().toISOString().slice(0, 10);
          for (const [channel, kpi] of Object.entries(ga4Data.channelKpis)) {
            await pool.query(`
              INSERT INTO ga4_channel_daily (tenant_id, snapshot_date, channel, sessions, transactions, revenue, avg_basket, conv_rate)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (tenant_id, snapshot_date, channel) DO UPDATE SET
                sessions = $4, transactions = $5, revenue = $6, avg_basket = $7, conv_rate = $8
            `, [tenantId, today, channel, kpi.sessions, kpi.transactions, kpi.revenue, kpi.avgBasket, kpi.convRate]);
          }
        }

        // Save source/medium snapshot
        if (ga4Data?.sourceMedium) {
          const today = new Date().toISOString().slice(0, 10);
          for (const sm of ga4Data.sourceMedium) {
            await pool.query(`
              INSERT INTO ga4_source_daily (tenant_id, snapshot_date, source, medium, sessions, transactions, revenue)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (tenant_id, snapshot_date, source, medium) DO UPDATE SET
                sessions = $5, transactions = $6, revenue = $7
            `, [tenantId, today, sm.source, sm.medium, sm.sessions, sm.transactions, sm.revenue]);
          }
        }

        const tpKpi = ga4Data?.channelKpis?.['Trovaprezzi'] || {};
        await pool.query(`
          UPDATE ga4_runs SET
            completed_at = NOW(), status = 'completed',
            products_attributed = $2, tp_revenue = $3, tp_transactions = $4
          WHERE id = $1
        `, [run.id, result.updated, tpKpi.revenue || 0, tpKpi.transactions || 0]);

        console.log(`[GA4] Import completed: ${result.updated} products attributed`);
      } catch (err) {
        console.error('[GA4] Import error:', err.message);
        await pool.query(
          `UPDATE ga4_runs SET completed_at = NOW(), status = 'error', error = $2 WHERE id = $1`,
          [run.id, err.message]
        );
      }
    })();

    res.json({ message: 'Import GA4 avviato', runId: run.id });
  } catch (err) {
    console.error('[GA4] Import trigger error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ga4/channels - Channel KPIs (from last import)
router.get('/channels', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const ga4Data = await getGA4Attribution(req.tenantId);
    if (!ga4Data) {
      return res.json({ channels: {}, configured: false });
    }
    res.json({ channels: ga4Data.channelKpis || {}, configured: true });
  } catch (err) {
    console.error('[GA4] Channels error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ga4/sources - Source/Medium breakdown
router.get('/sources', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const ga4Data = await getGA4Attribution(req.tenantId);
    if (!ga4Data) {
      return res.json({ sources: [], configured: false });
    }
    res.json({ sources: ga4Data.sourceMedium || [], configured: true });
  } catch (err) {
    console.error('[GA4] Sources error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ga4/attribution - Per-product TP attribution
router.get('/attribution', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    // Summary totals (all products, not limited)
    const { rows: [summary] } = await pool.query(`
      SELECT
        SUM(tp_clicks_30d) as total_clicks,
        SUM(tp_click_cost_30d) as total_click_cost,
        SUM(ga4_tp_revenue) as total_tp_revenue,
        SUM(ga4_tp_purchases) as total_tp_purchases,
        SUM(ga4_assisted_sales) as total_assisted_sales,
        SUM(ga4_assisted_revenue) as total_assisted_revenue,
        SUM(COALESCE(ga4_tp_revenue, 0) + COALESCE(ga4_assisted_revenue, 0)) as total_tp_value
      FROM product_health_scores
      WHERE tenant_id = $1
    `, [req.tenantId]);

    // Product list (top 200)
    const { rows } = await pool.query(`
      SELECT
        ph.sku,
        p.product_name, p.brand, p.sell_price,
        ph.tp_clicks_30d, ph.tp_click_cost_30d,
        ph.ga4_tp_purchases, ph.ga4_tp_revenue,
        ph.ga4_assisted_sales, ph.ga4_assisted_revenue,
        ph.ga4_total_tp_value,
        ph.classification, ph.health_score,
        p.is_civetta
      FROM product_health_scores ph
      LEFT JOIN products p ON p.tenant_id = ph.tenant_id AND p.sku = ph.sku
      WHERE ph.tenant_id = $1
        AND (ph.ga4_tp_purchases > 0 OR ph.ga4_assisted_sales > 0 OR ph.tp_clicks_30d > 0)
      ORDER BY ph.ga4_total_tp_value DESC NULLS LAST
      LIMIT 200
    `, [req.tenantId]);

    // GA4 config for period info
    const { rows: cfgRows } = await pool.query(
      `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'ga4_last_update'`,
      [req.tenantId]
    );

    res.json({
      products: rows,
      summary: {
        totalClicks: parseInt(summary.total_clicks) || 0,
        totalClickCost: parseFloat(summary.total_click_cost) || 0,
        totalTpRevenue: parseFloat(summary.total_tp_revenue) || 0,
        totalTpPurchases: parseInt(summary.total_tp_purchases) || 0,
        totalAssistedSales: parseInt(summary.total_assisted_sales) || 0,
        totalAssistedRevenue: parseFloat(summary.total_assisted_revenue) || 0,
        totalTpValue: parseFloat(summary.total_tp_value) || 0,
      },
      period: {
        clicks: 'Ultimi 30 giorni (zombie)',
        ga4Attribution: 'Ultimi 30 giorni (GA4)',
        lastUpdate: cfgRows[0]?.config_value || null,
      },
    });
  } catch (err) {
    console.error('[GA4] Attribution error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ga4/runs - Execution history
router.get('/runs', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ga4_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [req.tenantId]
    );
    res.json({ runs: rows });
  } catch (err) {
    console.error('[GA4] Runs error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
