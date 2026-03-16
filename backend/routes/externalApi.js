/**
 * External API for Farmabooster
 *
 * Endpoints consumed by Farmabooster to get feed decisions:
 * - /feed/civetta — list of SKUs to include in TP feed
 * - /feed/prices — price overrides
 * - /feed/action-plan — full action plan
 * - /feed/acknowledge — confirm actions applied
 *
 * Auth: X-API-Key header (per-tenant key from tenant_configs)
 */

const express = require('express');
const { pool } = require('../db/pool');

const router = express.Router();

/**
 * API Key authentication middleware
 */
async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-API-Key header required' });

  const { rows } = await pool.query(
    `SELECT tc.tenant_id FROM tenant_configs tc
     JOIN tenants t ON t.id = tc.tenant_id AND t.status = 'active'
     WHERE tc.config_key = 'xhumanpro_api_key' AND tc.config_value = $1`,
    [apiKey]
  );

  if (rows.length === 0) return res.status(403).json({ error: 'Invalid API key' });
  req.tenantId = rows[0].tenant_id;
  next();
}

router.use(apiKeyAuth);

/**
 * Log dispatch for tracking
 */
async function logDispatch(tenantId, endpoint, productsServed, req) {
  await pool.query(
    `INSERT INTO feed_dispatch_log (tenant_id, endpoint, products_served, request_ip)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, endpoint, productsServed, req.ip]
  );
}

// GET /api/external/v1/feed/civetta
// Returns all SKUs that should be civetta=1
router.get('/feed/civetta', async (req, res) => {
  try {
    // Start from current civetta=1 products, then apply engine decisions
    const { rows: keepProducts } = await pool.query(`
      SELECT p.sku
      FROM products p
      LEFT JOIN feed_actions fa ON fa.tenant_id = p.tenant_id AND fa.sku = p.sku
      WHERE p.tenant_id = $1
        AND (
          -- Currently civetta AND not marked for REMOVE
          (p.is_civetta = true AND (fa.action IS NULL OR fa.action != 'REMOVE'))
          OR
          -- Not civetta but marked for ADD
          (fa.action = 'ADD')
        )
        AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
    `, [req.tenantId]);

    const products = keepProducts.map(p => ({ sku: p.sku, civetta: '1' }));

    // Get removals for info
    const { rows: removals } = await pool.query(`
      SELECT fa.sku, fa.action_reason
      FROM feed_actions fa
      JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      WHERE fa.tenant_id = $1 AND fa.action = 'REMOVE' AND p.is_civetta = true
    `, [req.tenantId]);

    // Get latest computation time
    const { rows: [latest] } = await pool.query(
      `SELECT MAX(computed_at) as computed_at FROM feed_actions WHERE tenant_id = $1`,
      [req.tenantId]
    );

    await logDispatch(req.tenantId, 'civetta', products.length, req);

    // Mark served actions as dispatched
    await pool.query(
      `UPDATE feed_actions SET status = 'dispatched', dispatched_at = NOW()
       WHERE tenant_id = $1 AND status = 'pending'`,
      [req.tenantId]
    );

    res.json({
      tenant_id: req.tenantId,
      computed_at: latest?.computed_at || null,
      total: products.length,
      products,
      removals: removals.map(r => ({ sku: r.sku, reason: r.action_reason })),
    });
  } catch (err) {
    console.error('[ExternalAPI] Civetta error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/external/v1/feed/civetta
// Query specific SKUs
router.post('/feed/civetta', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !Array.isArray(codes)) {
      return res.status(400).json({ error: 'codes array required' });
    }

    const { rows } = await pool.query(`
      SELECT p.sku,
        CASE
          WHEN fa.action = 'REMOVE' THEN '0'
          WHEN fa.action = 'ADD' THEN '1'
          WHEN p.is_civetta = true AND (fa.action IS NULL OR fa.action != 'REMOVE') THEN '1'
          ELSE '0'
        END as civetta
      FROM products p
      LEFT JOIN feed_actions fa ON fa.tenant_id = p.tenant_id AND fa.sku = p.sku
      WHERE p.tenant_id = $1 AND p.sku = ANY($2)
    `, [req.tenantId, codes]);

    await logDispatch(req.tenantId, 'civetta_query', rows.length, req);

    res.json({
      products: rows.map(r => ({ code: r.sku, civetta: r.civetta })),
    });
  } catch (err) {
    console.error('[ExternalAPI] Civetta query error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/external/v1/feed/prices
// Returns all active price overrides
router.get('/feed/prices', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT fa.sku, fa.recommended_price, fa.current_price,
             fa.price_cut_pct, fa.new_margin_pct, fa.action_reason
      FROM feed_actions fa
      WHERE fa.tenant_id = $1
        AND fa.action = 'PRICE_CUT'
        AND fa.recommended_price IS NOT NULL
    `, [req.tenantId]);

    const { rows: [latest] } = await pool.query(
      `SELECT MAX(computed_at) as computed_at FROM feed_actions WHERE tenant_id = $1`,
      [req.tenantId]
    );

    await logDispatch(req.tenantId, 'prices', rows.length, req);

    res.json({
      tenant_id: req.tenantId,
      computed_at: latest?.computed_at || null,
      total: rows.length,
      prices: rows.map(r => ({
        code: r.sku,
        newprice: r.recommended_price.toString(),
        current_price: parseFloat(r.current_price),
        cut_pct: parseFloat(r.price_cut_pct),
        margin_pct: parseFloat(r.new_margin_pct),
        reason: r.action_reason,
      })),
    });
  } catch (err) {
    console.error('[ExternalAPI] Prices error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/external/v1/feed/prices
// Query specific SKU prices
router.post('/feed/prices', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !Array.isArray(codes)) {
      return res.status(400).json({ error: 'codes array required' });
    }

    const { rows } = await pool.query(`
      SELECT fa.sku, fa.recommended_price
      FROM feed_actions fa
      WHERE fa.tenant_id = $1 AND fa.sku = ANY($2)
        AND fa.action = 'PRICE_CUT' AND fa.recommended_price IS NOT NULL
    `, [req.tenantId, codes]);

    res.json({
      products: rows.map(r => ({ code: r.sku, newprice: r.recommended_price.toString() })),
    });
  } catch (err) {
    console.error('[ExternalAPI] Prices query error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/external/v1/feed/action-plan
// Full action plan with summary
router.get('/feed/action-plan', async (req, res) => {
  try {
    const { rows: actions } = await pool.query(`
      SELECT fa.sku, fa.action, fa.action_reason, fa.recommended_price,
             fa.current_price, fa.price_cut_pct, fa.clicks_consumed,
             fa.cost_consumed, fa.has_conversions, fa.direct_revenue,
             fa.competitive_viable, fa.tp_position,
             p.product_name, p.brand
      FROM feed_actions fa
      LEFT JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      WHERE fa.tenant_id = $1
      ORDER BY fa.action, fa.cost_consumed DESC
    `, [req.tenantId]);

    const grouped = { REMOVE: [], ADD: [], PRICE_CUT: [], KEEP: [], MONITOR: [] };
    for (const a of actions) {
      if (grouped[a.action]) grouped[a.action].push(a);
    }

    const totalSavings = grouped.REMOVE.reduce((s, a) => s + (parseFloat(a.cost_consumed) || 0), 0);

    await logDispatch(req.tenantId, 'action-plan', actions.length, req);

    res.json({
      tenant_id: req.tenantId,
      computed_at: actions[0]?.computed_at || null,
      summary: {
        total_products: actions.length,
        feed_active: grouped.KEEP.length + grouped.PRICE_CUT.length,
        to_remove: grouped.REMOVE.length,
        to_add: grouped.ADD.length,
        to_price_cut: grouped.PRICE_CUT.length,
        monitoring: grouped.MONITOR.length,
        estimated_monthly_savings: +totalSavings.toFixed(2),
      },
      actions: grouped,
    });
  } catch (err) {
    console.error('[ExternalAPI] Action plan error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/external/v1/feed/acknowledge
// Farmabooster confirms actions were applied
router.post('/feed/acknowledge', async (req, res) => {
  try {
    const { skus } = req.body;

    let updated;
    if (skus && Array.isArray(skus)) {
      const result = await pool.query(
        `UPDATE feed_actions SET status = 'applied', applied_at = NOW()
         WHERE tenant_id = $1 AND sku = ANY($2) AND status = 'dispatched'`,
        [req.tenantId, skus]
      );
      updated = result.rowCount;
    } else {
      const result = await pool.query(
        `UPDATE feed_actions SET status = 'applied', applied_at = NOW()
         WHERE tenant_id = $1 AND status = 'dispatched'`,
        [req.tenantId]
      );
      updated = result.rowCount;
    }

    // Mark prediction export time
    await pool.query(
      `UPDATE feed_predictions SET export_dispatched_at = NOW()
       WHERE tenant_id = $1 AND status = 'active' AND export_dispatched_at IS NULL`,
      [req.tenantId]
    );

    res.json({ ok: true, acknowledged: updated });
  } catch (err) {
    console.error('[ExternalAPI] Acknowledge error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
