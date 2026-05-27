/**
 * Magento Sync — Push diretto su Magento REST API
 *
 * Due fasi:
 * 1. Civetta updates (api_civettaai attribute)
 * 2. Price cuts (special_price + taglio_prezzo flag)
 *
 * Safety validations obbligatorie prima di ogni push.
 * Rate limited: batch read 5 concurrent, write 2 concurrent.
 *
 * Pattern identico a dashboard_fb/magentoSync.js
 */

const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');
const { throttledBatchFetch, magentoQueue } = require('./apiQueue');

// Rate limits
const READ_BATCH_SIZE = 20;
const READ_CONCURRENCY = 5;
const WRITE_CONCURRENCY = 2;
const READ_DELAY = 300;
const WRITE_DELAY = 500;

/**
 * Get Magento credentials for a tenant
 */
async function getMagentoConfig(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM tenant_configs
     WHERE tenant_id = $1 AND config_key IN ('magento_base_url', 'magento_api_token')`,
    [tenantId]
  );
  const cfg = {};
  for (const r of rows) {
    try { cfg[r.config_key] = decrypt(r.config_value); }
    catch { cfg[r.config_key] = r.config_value; }
  }
  if (!cfg.magento_base_url || !cfg.magento_api_token) {
    throw new Error('Magento credentials not configured');
  }
  return {
    baseUrl: cfg.magento_base_url.replace(/\/$/, ''),
    token: cfg.magento_api_token,
  };
}

/**
 * Batch fetch products from Magento to get current state
 * Returns Map<sku, { price, specialPrice, cost, civettaai }>
 */
async function batchFetchProducts(magentoConfig, skus) {
  const { baseUrl, token } = magentoConfig;
  const headers = { 'Authorization': `Bearer ${token}` };
  const result = new Map();

  const batches = [];
  for (let i = 0; i < skus.length; i += READ_BATCH_SIZE) {
    batches.push(skus.slice(i, i + READ_BATCH_SIZE));
  }

  const fetchFns = batches.map(batch => async () => {
    const filters = batch.map((sku, idx) =>
      `searchCriteria[filterGroups][0][filters][${idx}][field]=sku&searchCriteria[filterGroups][0][filters][${idx}][value]=${encodeURIComponent(sku)}&searchCriteria[filterGroups][0][filters][${idx}][conditionType]=eq`
    ).join('&');
    const url = `${baseUrl}/rest/V1/products?${filters}&fields=items[sku,price,custom_attributes]&searchCriteria[pageSize]=${batch.length}`;
    return magentoQueue.enqueue(async () => {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error(`Magento GET ${resp.status}`);
      return resp.json();
    }, `magento:batch-read:${batch[0]}`);
  });

  const results = await throttledBatchFetch(fetchFns, READ_CONCURRENCY, READ_DELAY);

  for (const data of results) {
    if (!data || !data.items) continue;
    for (const item of data.items) {
      const attrs = {};
      for (const ca of (item.custom_attributes || [])) {
        attrs[ca.attribute_code] = ca.value;
      }
      result.set(item.sku, {
        price: parseFloat(item.price) || 0,
        specialPrice: parseFloat(attrs.special_price) || null,
        cost: parseFloat(attrs.cost) || 0,
        civettaai: attrs.api_civettaai || null,
        civetta: attrs.civetta || null,
      });
    }
  }

  return result;
}

/**
 * Safety validation for price cuts — OBBLIGATORIA
 * Returns { safe: true } or { safe: false, reason: string }
 */
function validatePriceSafety(sku, newPrice, magentoProduct) {
  if (!magentoProduct) {
    return { safe: false, reason: `Prodotto ${sku} non trovato su Magento` };
  }

  // Check 1: costo disponibile
  if (!magentoProduct.cost || magentoProduct.cost <= 0) {
    return { safe: false, reason: `Costo non disponibile su Magento per ${sku}` };
  }

  // Check 2: newPrice > cost
  if (newPrice <= magentoProduct.cost) {
    return { safe: false, reason: `Prezzo proposto ${newPrice} <= costo Magento ${magentoProduct.cost} per ${sku}` };
  }

  // Check 3: se usiamo special_price, deve essere < price
  if (magentoProduct.price && newPrice >= magentoProduct.price) {
    return { safe: false, reason: `Special price ${newPrice} >= price Magento ${magentoProduct.price} per ${sku}` };
  }

  // Check 4: margine minimo per fascia (regole utente)
  const marginPct = ((newPrice - magentoProduct.cost) / magentoProduct.cost) * 100;
  let minMargin;
  if (newPrice < 10) minMargin = 18;
  else if (newPrice < 30) minMargin = 14;
  else minMargin = 12;

  if (marginPct < minMargin) {
    return { safe: false, reason: `Margine ${marginPct.toFixed(1)}% < minimo ${minMargin}% per fascia prezzo ${sku}` };
  }

  return { safe: true };
}

/**
 * Preview — mostra cosa farebbe senza applicare
 */
async function preview(tenantId) {
  const magentoConfig = await getMagentoConfig(tenantId);

  // Get feed actions
  const { rows: actions } = await pool.query(`
    SELECT fa.sku, fa.action, fa.recommended_price, fa.current_price, fa.action_reason
    FROM feed_actions fa
    WHERE fa.tenant_id = $1 AND fa.action IN ('REMOVE', 'ADD', 'PRICE_CUT')
    ORDER BY fa.action, fa.cost_consumed DESC
  `, [tenantId]);

  // Separate by type
  const civettaUpdates = actions.filter(a => a.action === 'REMOVE' || a.action === 'ADD');
  const priceUpdates = actions.filter(a => a.action === 'PRICE_CUT' && a.recommended_price);

  // Fetch current state from Magento for price cuts (safety check)
  const priceSKUs = priceUpdates.map(a => a.sku);
  let magentoProducts = new Map();
  if (priceSKUs.length > 0) {
    magentoProducts = await batchFetchProducts(magentoConfig, priceSKUs);
  }

  // Validate each price cut
  const safePriceCuts = [];
  const blockedPriceCuts = [];
  for (const pc of priceUpdates) {
    const newPrice = parseFloat(pc.recommended_price);
    const mgProduct = magentoProducts.get(pc.sku);
    const check = validatePriceSafety(pc.sku, newPrice, mgProduct);
    if (check.safe) {
      safePriceCuts.push({
        sku: pc.sku,
        currentPrice: mgProduct?.price || parseFloat(pc.current_price),
        newPrice,
        costMagento: mgProduct?.cost || 0,
        marginAfter: mgProduct ? ((newPrice - mgProduct.cost) / mgProduct.cost * 100).toFixed(1) + '%' : 'N/A',
        reason: pc.action_reason,
      });
    } else {
      blockedPriceCuts.push({
        sku: pc.sku,
        newPrice,
        blockReason: check.reason,
      });
    }
  }

  return {
    preview: true,
    civetta: {
      remove: civettaUpdates.filter(a => a.action === 'REMOVE').map(a => ({ sku: a.sku, reason: a.action_reason })),
      add: civettaUpdates.filter(a => a.action === 'ADD').map(a => ({ sku: a.sku, reason: a.action_reason })),
    },
    priceCuts: {
      safe: safePriceCuts,
      blocked: blockedPriceCuts,
    },
    summary: {
      civettaRemove: civettaUpdates.filter(a => a.action === 'REMOVE').length,
      civettaAdd: civettaUpdates.filter(a => a.action === 'ADD').length,
      priceCutsSafe: safePriceCuts.length,
      priceCutsBlocked: blockedPriceCuts.length,
    },
  };
}

/**
 * Execute — push to Magento (requires confirm: true)
 * Phase 1: Civetta updates (api_civettaai attribute)
 * Phase 2: Price cuts (special_price + taglio_prezzo)
 */
async function execute(tenantId, { dryRun = false, confirm = false } = {}) {
  if (!confirm && !dryRun) {
    throw new Error('Richiesto confirm:true per eseguire. Usa preview() prima.');
  }

  const magentoConfig = await getMagentoConfig(tenantId);
  const { baseUrl, token } = magentoConfig;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Get preview first
  const previewResult = await preview(tenantId);

  if (dryRun) {
    return { ...previewResult, dryRun: true };
  }

  const results = {
    phase1_civetta: { success: 0, failed: 0, errors: [] },
    phase2_prices: { success: 0, failed: 0, blocked: previewResult.priceCuts.blocked.length, errors: [] },
  };

  // === PHASE 1: Civetta updates ===
  console.log(`[MagentoSync] Phase 1: ${previewResult.summary.civettaRemove} REMOVE, ${previewResult.summary.civettaAdd} ADD`);

  const civettaOps = [
    ...previewResult.civetta.remove.map(r => ({ sku: r.sku, civettaValue: '0' })),
    ...previewResult.civetta.add.map(a => ({ sku: a.sku, civettaValue: '1' })),
  ];

  const civettaFns = civettaOps.map(op => async () => {
    try {
      const resp = await magentoQueue.enqueue(async () => {
        return fetch(`${baseUrl}/rest/V1/products/${encodeURIComponent(op.sku)}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            product: {
              sku: op.sku,
              custom_attributes: [
                { attribute_code: 'api_civettaai', value: op.civettaValue === '1' ? '1' : '0' },
              ],
            },
          }),
          signal: AbortSignal.timeout(30000),
        });
      }, `magento:civetta:${op.sku}`);
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`PUT ${resp.status}: ${err.substring(0, 100)}`);
      }
      results.phase1_civetta.success++;
    } catch (e) {
      results.phase1_civetta.failed++;
      if (results.phase1_civetta.errors.length < 10) {
        results.phase1_civetta.errors.push({ sku: op.sku, error: e.message });
      }
    }
  });

  await throttledBatchFetch(civettaFns, WRITE_CONCURRENCY, WRITE_DELAY);

  // === PHASE 2: Price cuts (only safe ones) ===
  console.log(`[MagentoSync] Phase 2: ${previewResult.priceCuts.safe.length} safe cuts, ${previewResult.priceCuts.blocked.length} blocked`);

  const priceFns = previewResult.priceCuts.safe.map(pc => async () => {
    try {
      const resp = await magentoQueue.enqueue(async () => {
        return fetch(`${baseUrl}/rest/V1/products/${encodeURIComponent(pc.sku)}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            product: {
              sku: pc.sku,
              custom_attributes: [
                { attribute_code: 'special_price', value: String(pc.newPrice) },
                { attribute_code: 'taglio_prezzo', value: '1' },
              ],
            },
          }),
          signal: AbortSignal.timeout(30000),
        });
      }, `magento:price:${pc.sku}`);
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`PUT ${resp.status}: ${err.substring(0, 100)}`);
      }
      results.phase2_prices.success++;
    } catch (e) {
      results.phase2_prices.failed++;
      if (results.phase2_prices.errors.length < 10) {
        results.phase2_prices.errors.push({ sku: pc.sku, error: e.message });
      }
    }
  });

  await throttledBatchFetch(priceFns, WRITE_CONCURRENCY, WRITE_DELAY);

  // Log dispatch
  await pool.query(
    `INSERT INTO feed_dispatch_log (tenant_id, endpoint, products_served, request_ip)
     VALUES ($1, 'magento-sync', $2, 'internal')`,
    [tenantId, results.phase1_civetta.success + results.phase2_prices.success]
  );

  // Mark actions as applied
  const appliedSKUs = [
    ...previewResult.civetta.remove.map(r => r.sku),
    ...previewResult.civetta.add.map(a => a.sku),
    ...previewResult.priceCuts.safe.map(p => p.sku),
  ];
  if (appliedSKUs.length > 0) {
    await pool.query(
      `UPDATE feed_actions SET status = 'applied', applied_at = NOW()
       WHERE tenant_id = $1 AND sku = ANY($2) AND status IN ('pending', 'dispatched')`,
      [tenantId, appliedSKUs]
    );
  }

  console.log(`[MagentoSync] Done: civetta ${results.phase1_civetta.success}/${civettaOps.length}, prices ${results.phase2_prices.success}/${previewResult.priceCuts.safe.length}`);

  return {
    executed: true,
    ...results,
    summary: previewResult.summary,
  };
}

module.exports = { preview, execute, validatePriceSafety, batchFetchProducts };
