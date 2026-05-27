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
 *
 * Stable cache: always serves the last valid complete result.
 * Persisted in tenant_configs (stable_feed_codes, stable_price_cuts).
 * Updated by healthCron after each feed engine run.
 */

const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db/pool');

const router = express.Router();

// ─── API KEY AUTH (SHA256 hashed) ───────────────────────

async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-API-Key header required' });

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  // Check tenant_api_keys table (primary)
  const { rows } = await pool.query(
    `SELECT ak.id as key_id, ak.name as key_name, ak.tenant_id, t.name as tenant_name
     FROM tenant_api_keys ak
     JOIN tenants t ON t.id = ak.tenant_id AND t.status = 'active'
     WHERE ak.key_hash = $1 AND ak.active = true`,
    [keyHash]
  );

  if (rows.length === 0) {
    // Fallback: check tenant_configs (backward compat)
    const { rows: legacyRows } = await pool.query(
      `SELECT tc.tenant_id, t.name as tenant_name FROM tenant_configs tc
       JOIN tenants t ON t.id = tc.tenant_id AND t.status = 'active'
       WHERE tc.config_key = 'xhumanpro_api_key' AND (tc.config_value = $1 OR tc.config_value = $2)`,
      [apiKey, keyHash]
    );
    if (legacyRows.length === 0) return res.status(403).json({ error: 'Invalid API key' });
    req.tenantId = legacyRows[0].tenant_id;
    req.tenantName = legacyRows[0].tenant_name;
    req.apiKeyId = null;
    req.apiKeyName = 'legacy';
  } else {
    req.tenantId = rows[0].tenant_id;
    req.tenantName = rows[0].tenant_name;
    req.apiKeyId = rows[0].key_id;
    req.apiKeyName = rows[0].key_name;
    // Update last_used_at
    pool.query('UPDATE tenant_api_keys SET last_used_at = NOW() WHERE id = $1', [rows[0].key_id]).catch(() => {});
  }
  next();
}

router.use(apiKeyAuth);

// ─── STABLE CACHE ───────────────────────────────────────
// Always serves last valid complete result. Updated by healthCron.

const stableCache = new Map(); // tenantId → { feedCodes, priceCuts, updatedAt }

async function loadStableCache(tenantId) {
  if (stableCache.has(tenantId)) return stableCache.get(tenantId);
  try {
    const { rows } = await pool.query(
      `SELECT config_key, config_value FROM tenant_configs
       WHERE tenant_id = $1 AND config_key IN ('stable_feed_codes', 'stable_price_cuts', 'stable_civetta_response', 'stable_prices_response')`,
      [tenantId]
    );
    const entry = { feedCodes: null, removeCodes: null, priceCuts: null, updatedAt: null };
    for (const row of rows) {
      try {
        const val = JSON.parse(row.config_value);
        if (row.config_key === 'stable_feed_codes') {
          entry.feedCodes = val.codes;
          entry.removeCodes = val.removeCodes || null;
          entry.updatedAt = val.updatedAt;
        } else if (row.config_key === 'stable_price_cuts') {
          entry.priceCuts = val.products;
        }
      } catch { /* corrupt */ }
    }
    stableCache.set(tenantId, entry);
    if (entry.feedCodes) {
      console.log(`[FeedStable][T:${tenantId.slice(0, 8)}] Loaded: ${entry.feedCodes.length} civetta, ${(entry.priceCuts || []).length} price cuts`);
    }
    return entry;
  } catch (e) {
    console.warn(`[FeedStable][T:${tenantId.slice(0, 8)}] DB load failed:`, e.message);
    const empty = { feedCodes: null, priceCuts: null, updatedAt: null };
    stableCache.set(tenantId, empty);
    return empty;
  }
}

/**
 * Recalculate stable cache from feed_actions + products.
 * Called by healthCron after each feed engine run.
 *
 * CIVETTA=1 criteria (strict):
 * - civetta=1 in Magento AND NOT in quarantine AND NOT REMOVE
 * - OR explicitly ADD by feed engine (pepite)
 *
 * CIVETTA=0 (removeCodes): quarantined + REMOVE actions
 * Passed to Farmabooster every time so it can deactivate them.
 */
async function recalculateStableCache(tenantId) {
  // Build civetta=1 list (keep in feed)
  const { rows: keepProducts } = await pool.query(`
    SELECT p.sku
    FROM products p
    LEFT JOIN feed_actions fa ON fa.tenant_id = p.tenant_id AND fa.sku = p.sku
    LEFT JOIN feed_quarantine fq ON fq.tenant_id = p.tenant_id AND fq.sku = p.sku AND fq.reactivated = false
    WHERE p.tenant_id = $1
      AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
      AND COALESCE(p.sell_price, 0) > 0   -- Skip SKU senza prezzo (sync sporco): non sprecare click TP
      AND (
        (p.is_civetta = true AND (fa.action IS NULL OR fa.action NOT IN ('REMOVE')) AND fq.id IS NULL)
        OR
        (fa.action = 'ADD' AND fq.id IS NULL)
      )
  `, [tenantId]);

  let feedCodes = keepProducts.map(p => p.sku);

  // Module 2: Feed Cap — limit max products with priority sorting
  const { rows: capCfg } = await pool.query(
    `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1 AND config_key IN ('feed_cap_enabled', 'feed_cap_max')`,
    [tenantId]
  );
  const capConfig = {};
  for (const r of capCfg) capConfig[r.config_key] = r.config_value;
  const feedCapEnabled = capConfig.feed_cap_enabled === 'true';
  const feedCapMax = parseInt(capConfig.feed_cap_max || 25000);

  let cappedProducts = [];
  if (feedCapEnabled && feedCodes.length > feedCapMax) {
    // Sort by priority: orders * 10 + revenue * 0.01 + health_score
    const { rows: priorityRows } = await pool.query(`
      SELECT ph.sku,
        (COALESCE(ph.tp_attributed_orders, 0) * 10 +
         COALESCE(ph.tp_attributed_revenue, 0) * 0.01 +
         COALESCE(ph.health_score, 0)) AS priority_score
      FROM product_health_scores ph
      WHERE ph.tenant_id = $1 AND ph.sku = ANY($2)
    `, [tenantId, feedCodes]);

    const priorityMap = new Map(priorityRows.map(r => [r.sku, parseFloat(r.priority_score) || 0]));
    feedCodes.sort((a, b) => (priorityMap.get(b) || 0) - (priorityMap.get(a) || 0));

    cappedProducts = feedCodes.splice(feedCapMax);
    console.log(`[FeedCap][T:${tenantId.slice(0, 8)}] Cap ${feedCapMax}: ${cappedProducts.length} products below threshold`);
  }

  // Build civetta=0 list (quarantine + explicit REMOVE — ALWAYS included in response)
  const { rows: removeRows } = await pool.query(`
    SELECT DISTINCT sku FROM (
      SELECT fq.sku FROM feed_quarantine fq
      WHERE fq.tenant_id = $1 AND fq.reactivated = false
      UNION
      SELECT fa.sku FROM feed_actions fa
      WHERE fa.tenant_id = $1 AND fa.action = 'REMOVE'
    ) sub
  `, [tenantId]);

  const removeCodes = removeRows.map(r => r.sku);

  // Add capped products to remove list (Module 2)
  if (cappedProducts.length > 0) {
    const removeSet = new Set(removeCodes);
    for (const sku of cappedProducts) {
      if (!removeSet.has(sku)) removeCodes.push(sku);
    }
  }

  // Build price cuts list
  const { rows: priceCutRows } = await pool.query(`
    SELECT fa.sku as code, fa.recommended_price as newprice
    FROM feed_actions fa
    WHERE fa.tenant_id = $1 AND fa.action = 'PRICE_CUT' AND fa.recommended_price IS NOT NULL
  `, [tenantId]);

  const priceCuts = priceCutRows.map(r => ({ code: r.code, newprice: String(Math.round(parseFloat(r.newprice) * 100) / 100) }));

  const updatedAt = new Date().toISOString();
  const entry = { feedCodes, removeCodes, priceCuts, updatedAt };
  stableCache.set(tenantId, entry);

  // Persist to DB
  await pool.query(
    `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
     VALUES ($1, 'stable_feed_codes', $2)
     ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2`,
    [tenantId, JSON.stringify({ codes: feedCodes, removeCodes, updatedAt })]
  );
  await pool.query(
    `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
     VALUES ($1, 'stable_price_cuts', $2)
     ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2`,
    [tenantId, JSON.stringify({ products: priceCuts })]
  );

  console.log(`[FeedStable][T:${tenantId.slice(0, 8)}] Saved: ${feedCodes.length} civetta=1, ${removeCodes.length} civetta=0, ${priceCuts.length} price cuts`);
  return entry;
}

// ─── HELPERS ────────────────────────────────────────────

async function logDispatch(tenantId, endpoint, productsServed, req, responseBody) {
  const summary = {};
  if (responseBody) {
    if (responseBody.stats) summary.stats = responseBody.stats;
    if (responseBody.summary) summary.summary = responseBody.summary;
    if (responseBody.products && Array.isArray(responseBody.products)) {
      summary.productCount = responseBody.products.length;
      // Sample first 5 products for quick inspection
      summary.sample = responseBody.products.slice(0, 5);
    }
  }
  await pool.query(
    `INSERT INTO feed_dispatch_log (tenant_id, endpoint, products_served, request_ip, response_summary, api_key_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [tenantId, endpoint, productsServed, req.ip, JSON.stringify(summary), req.apiKeyName || null]
  ).catch(e => {
    // If column doesn't exist, fallback to basic log
    pool.query(
      `INSERT INTO feed_dispatch_log (tenant_id, endpoint, products_served, request_ip)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, endpoint, productsServed, req.ip]
    ).catch(() => {});
  });
}

// ─── ENDPOINTS ──────────────────────────────────────────

// GET /api/external/v1/feed/civetta
// civetta=1: feed COMPLETO — tutti i prodotti da pubblicare (FB svuota e ricarica)
// civetta=0: DIFF — solo i code rimossi rispetto al dispatch precedente (informativo)
router.get('/feed/civetta', async (req, res) => {
  try {
    let cached = await loadStableCache(req.tenantId);
    if (!cached.feedCodes) {
      cached = await recalculateStableCache(req.tenantId);
    }

    const currentFeed = new Set(cached.feedCodes);

    // Load previous dispatch feed to calculate DIFF
    const { rows: [prevDispatch] } = await pool.query(
      "SELECT config_value FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'last_dispatched_feed'",
      [req.tenantId]
    );
    let removed = [];
    if (prevDispatch?.config_value) {
      try {
        const prevCodes = JSON.parse(prevDispatch.config_value).codes || [];
        // Removed = was in previous feed but NOT in current feed
        removed = prevCodes.filter(code => !currentFeed.has(code));
      } catch {}
    }

    // Build response: civetta=1 (full feed) + civetta=0 (removed since last dispatch)
    const products = [
      ...cached.feedCodes.map(code => ({ code, civetta: '1' })),
      ...removed.map(code => ({ code, civetta: '0' })),
    ];

    // Save current feed as "last dispatched" for next diff calculation
    await pool.query(
      `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
       VALUES ($1, 'last_dispatched_feed', $2)
       ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $2`,
      [req.tenantId, JSON.stringify({ codes: cached.feedCodes, dispatchedAt: new Date().toISOString() })]
    );

    // Mark actions as dispatched
    await pool.query(
      `UPDATE feed_actions SET status = 'dispatched', dispatched_at = NOW()
       WHERE tenant_id = $1 AND status = 'pending'`,
      [req.tenantId]
    ).catch(() => {});

    const response = {
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      stats: {
        totalCivetta1: cached.feedCodes.length,
        totalCivetta0: removed.length,
        totalProducts: products.length,
      },
      note: 'civetta=1 e il feed COMPLETO da pubblicare. civetta=0 sono i code rimossi rispetto al dispatch precedente (informativo).',
      products,
    };

    console.log(`[FeedCivetta][T:${req.tenantId.slice(0, 8)}] Feed: ${cached.feedCodes.length} civetta=1, ${removed.length} rimossi vs precedente → ${req.apiKeyName}`);
    await logDispatch(req.tenantId, 'GET /feed/civetta', products.length, req, response);
    res.json(response);
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
    if (codes.length > 50000) {
      return res.status(400).json({ error: 'Too many codes (max 50000)' });
    }

    let cached = await loadStableCache(req.tenantId);
    if (!cached.feedCodes) {
      cached = await recalculateStableCache(req.tenantId);
    }

    const feedSet = new Set(cached.feedCodes);
    const removeSet = new Set(cached.removeCodes || []);
    const products = codes.map(c => {
      const code = String(c).trim();
      // Explicit remove takes priority, then check feed set
      if (removeSet.has(code)) return { code, civetta: '0' };
      return { code, civetta: feedSet.has(code) ? '1' : '0' };
    });

    await logDispatch(req.tenantId, 'POST /feed/civetta', products.length, req, { products: products.slice(0, 5) });

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      products,
    });
  } catch (err) {
    console.error('[ExternalAPI] Civetta query error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/external/v1/feed/prices
// Returns all active price overrides (from stable cache)
router.get('/feed/prices', async (req, res) => {
  try {
    let cached = await loadStableCache(req.tenantId);
    if (!cached.priceCuts) {
      cached = await recalculateStableCache(req.tenantId);
    }

    await logDispatch(req.tenantId, 'prices', (cached.priceCuts || []).length, req);

    console.log(`[FeedPrices][T:${req.tenantId.slice(0, 8)}] Serving ${(cached.priceCuts || []).length} price cuts (${cached.updatedAt})`);

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      products: cached.priceCuts || [],
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
    if (codes.length > 5000) {
      return res.status(400).json({ error: 'Too many codes (max 5000)' });
    }

    let cached = await loadStableCache(req.tenantId);
    if (!cached.priceCuts) {
      cached = await recalculateStableCache(req.tenantId);
    }

    const priceMap = new Map((cached.priceCuts || []).map(p => [p.code, p.newprice]));
    const products = codes.map(c => {
      const code = String(c).trim();
      const newprice = priceMap.get(code);
      return newprice ? { code, newprice } : { code, newprice: null };
    }).filter(p => p.newprice !== null);

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      products,
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
             fa.competitive_viable, fa.tp_position, fa.competitor_count,
             p.product_name, p.brand
      FROM feed_actions fa
      LEFT JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      WHERE fa.tenant_id = $1
      ORDER BY fa.action, fa.cost_consumed DESC
    `, [req.tenantId]);

    const grouped = { REMOVE: [], ADD: [], PRICE_CUT: [], KEEP: [], MONITOR: [] };
    for (const a of actions) {
      if (grouped[a.action]) grouped[a.action].push({
        code: a.sku,
        name: a.product_name,
        brand: a.brand,
        action: a.action,
        reason: a.action_reason,
        position: a.tp_position,
        competitors: a.competitor_count,
        clicks: a.clicks_consumed,
        cost: parseFloat(a.cost_consumed) || 0,
        revenue: parseFloat(a.direct_revenue) || 0,
        hasConversions: a.has_conversions,
        currentPrice: parseFloat(a.current_price) || null,
        suggestedPrice: parseFloat(a.recommended_price) || null,
        priceCutPct: parseFloat(a.price_cut_pct) || null,
      });
    }

    const totalSavings = grouped.REMOVE.reduce((s, a) => s + a.cost, 0);

    // Get price cuts from stable cache for strategyOverrides
    let cached = await loadStableCache(req.tenantId);
    if (!cached.feedCodes) cached = await recalculateStableCache(req.tenantId);

    await logDispatch(req.tenantId, 'action-plan', actions.length, req);

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      summary: {
        totalProducts: actions.length,
        feedActive: grouped.KEEP.length + grouped.PRICE_CUT.length,
        toRemove: grouped.REMOVE.length,
        toAdd: grouped.ADD.length,
        toPriceCut: grouped.PRICE_CUT.length,
        monitoring: grouped.MONITOR.length,
        estimatedMonthlySavings: +totalSavings.toFixed(2),
      },
      actions: grouped,
      strategyOverrides: {
        priceChanges: (cached.priceCuts || []),
        feedActions: [
          ...grouped.REMOVE.map(a => ({ code: a.code, action: 'REMOVE', reason: a.reason })),
          ...grouped.ADD.map(a => ({ code: a.code, action: 'ADD', reason: a.reason })),
        ],
        preparedAt: cached.updatedAt,
      },
    });
  } catch (err) {
    console.error('[ExternalAPI] Action plan error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/external/v1/feed/action-plan
// Query specific codes
router.post('/feed/action-plan', async (req, res) => {
  try {
    const { minsan, codes } = req.body;
    const skuList = minsan || codes;
    if (!skuList || !Array.isArray(skuList)) {
      return res.status(400).json({ error: '"minsan" or "codes" array required' });
    }
    if (skuList.length > 500) {
      return res.status(400).json({ error: 'Max 500 codes per request' });
    }

    let cached = await loadStableCache(req.tenantId);
    if (!cached.feedCodes) cached = await recalculateStableCache(req.tenantId);
    const feedSet = new Set(cached.feedCodes || []);
    const priceMap = new Map((cached.priceCuts || []).map(p => [p.code, p.newprice]));

    const { rows } = await pool.query(`
      SELECT fa.sku, fa.action, fa.action_reason, fa.recommended_price, fa.current_price,
             fa.clicks_consumed, fa.cost_consumed, fa.has_conversions, fa.direct_revenue,
             p.sell_price, p.margin, p.erp_stock
      FROM feed_actions fa
      JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      WHERE fa.tenant_id = $1 AND fa.sku = ANY($2)
    `, [req.tenantId, skuList]);

    const actionMap = new Map(rows.map(r => [r.sku, r]));

    const products = skuList.map(code => {
      code = String(code).trim();
      const fa = actionMap.get(code);
      const priceOverride = priceMap.get(code);
      return {
        code,
        civettaRecommendation: feedSet.has(code) ? 'KEEP' : (fa?.action === 'ADD' ? 'ADD' : 'REMOVE'),
        priceOverrideActive: !!priceOverride,
        suggestedPrice: priceOverride ? parseFloat(priceOverride) : null,
        currentPrice: fa ? parseFloat(fa.current_price || fa.sell_price) : null,
        action: fa?.action || 'UNKNOWN',
        reason: fa?.action_reason || null,
        cost: fa ? parseFloat(fa.cost_consumed) : 0,
        margin: fa ? parseFloat(fa.margin) : null,
        stock: fa ? parseInt(fa.erp_stock) : null,
        civetta: feedSet.has(code) ? '1' : '0',
      };
    });

    res.json({
      tenant: { id: req.tenantId, name: req.tenantName },
      generatedAt: cached.updatedAt,
      products,
    });
  } catch (err) {
    console.error('[ExternalAPI] Action plan query error:', err.message);
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

    res.json({ ok: true, acknowledged: updated });
  } catch (err) {
    console.error('[ExternalAPI] Acknowledge error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports.recalculateStableCache = recalculateStableCache;
