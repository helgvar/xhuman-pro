/**
 * Magento Sync — Push diretto su Magento REST API
 *
 * Modello operativo per tenant:
 *  - `observation`: Farmabooster controlla via attributo Magento `civetta` (Elastic).
 *    xHumanPro NON deve toccare Magento. execute() ritorna early.
 *  - `operational`: xHumanPro controlla via attributo `civettaai` (select int).
 *    Option IDs per "0"/"1" sono auto-increment per installazione Magento, quindi
 *    vengono letti runtime e cachati per tenant (24h).
 *
 * Due fasi:
 *  1. Civetta updates → PUT attribute_code='civettaai', value=<option_id>
 *  2. Price cuts → PUT attribute_code='special_price', value=<float>
 *
 * Safety validations obbligatorie prima di ogni push.
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

const OPTION_ID_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const civettaaiOptionsCache = new Map();

/**
 * Legge il mode operativo del tenant da tenant_configs.
 * Default: 'observation' (safe — non scriviamo niente).
 */
async function getCivettaMode(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_value FROM tenant_configs
     WHERE tenant_id = $1 AND config_key = 'xhumanpro_magento_mode'`,
    [tenantId]
  );
  if (rows.length === 0) return 'observation';
  return rows[0].config_value === 'operational' ? 'operational' : 'observation';
}

/**
 * Resolve civettaai select option_ids on the target Magento, cached per tenant.
 * Option IDs are auto-increment per installation (es. Papa on=49739/off=49624,
 * Procaccini on=26458/off=26353), quindi vanno letti runtime e mai hardcoded.
 */
async function getCivettaaiOptionIds(tenantId, { baseUrl, token }) {
  const cached = civettaaiOptionsCache.get(tenantId);
  if (cached && Date.now() - cached.ts < OPTION_ID_CACHE_TTL_MS) {
    return { on: cached.on, off: cached.off };
  }
  const resp = await fetch(`${baseUrl}/rest/V1/products/attributes/civettaai/options`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Cannot read civettaai options: ${resp.status}`);
  const opts = await resp.json();
  let on = null, off = null;
  for (const o of opts) {
    if (String(o.label).trim() === '1') on = o.value;
    else if (String(o.label).trim() === '0') off = o.value;
  }
  if (!on || !off) {
    throw new Error(`civettaai options incomplete: ${JSON.stringify(opts)}`);
  }
  civettaaiOptionsCache.set(tenantId, { on, off, ts: Date.now() });
  return { on, off };
}

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
        civettaai: attrs.civettaai != null ? String(attrs.civettaai) : null,
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
 * Preview — mostra cosa farebbe (osservazione/simulazione).
 * Funziona per qualunque tenant a prescindere dal mode: serve a "ragionare e
 * suggerire" anche per i tenant in osservazione.
 */
async function preview(tenantId) {
  const mode = await getCivettaMode(tenantId);
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
    mode,
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
 * Phase 1: Civetta updates → attribute `civettaai` (operational only)
 * Phase 2: Price cuts → attribute `special_price`
 *
 * In modalità `observation` ritorna early senza scrivere niente: per quei tenant
 * il feed civetta è ancora controllato da Farmabooster via attributo `civetta`.
 */
async function execute(tenantId, { dryRun = false, confirm = false } = {}) {
  if (!confirm && !dryRun) {
    throw new Error('Richiesto confirm:true per eseguire. Usa preview() prima.');
  }

  const mode = await getCivettaMode(tenantId);
  if (mode !== 'operational' && !dryRun) {
    return {
      executed: false,
      mode,
      message: 'Tenant in osservazione: xHumanPro non scrive su Magento. Farmabooster controlla via attributo civetta. Settare xhumanpro_magento_mode=operational quando si vuole passare il controllo a xHumanPro (civettaai).',
    };
  }

  const magentoConfig = await getMagentoConfig(tenantId);
  const { baseUrl, token } = magentoConfig;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const optionIds = await getCivettaaiOptionIds(tenantId, magentoConfig);

  const previewResult = await preview(tenantId);

  if (dryRun) {
    return { ...previewResult, mode, optionIds, dryRun: true };
  }

  const results = {
    mode,
    phase1_civetta: { success: 0, failed: 0, errors: [] },
    phase2_prices: { success: 0, failed: 0, blocked: previewResult.priceCuts.blocked.length, errors: [] },
  };

  const appliedCivettaSKUs = [];
  const appliedPriceSKUs = [];

    // === PHASE 1: Civetta updates → civettaai = optionId ===
    console.log(`[MagentoSync] Phase 1 [${mode}]: ${previewResult.summary.civettaRemove} REMOVE, ${previewResult.summary.civettaAdd} ADD (option_ids on=${optionIds.on} off=${optionIds.off})`);

    const civettaOps = [
      ...previewResult.civetta.remove.map(r => ({ sku: r.sku, target: optionIds.off, isAdd: false })),
      ...previewResult.civetta.add.map(a => ({ sku: a.sku, target: optionIds.on, isAdd: true })),
    ];

    // --- Delta fetch: leggi civettaai corrente per tutti i candidati e fai PUT
    // solo dove diverge dal target. Su Papa abbiamo visto che ~97% sono già
    // coerenti (civettaai già a 0 perché Farmabooster aveva fatto il suo run o
    // mai stati civetta), quindi questo riduce 10k PUT a ~100-300.
    console.log(`[MagentoSync] Delta fetch: reading civettaai for ${civettaOps.length} candidates...`);
    const tDelta0 = Date.now();
    const currentState = await batchFetchProducts(magentoConfig, civettaOps.map(o => o.sku));
    console.log(`[MagentoSync] Delta fetch done in ${((Date.now()-tDelta0)/1000).toFixed(1)}s (${currentState.size}/${civettaOps.length} found)`);

    const civettaToWrite = [];
    let alreadyCoherent = 0;
    let unknownOnMagento = 0;
    for (const op of civettaOps) {
      const cur = currentState.get(op.sku);
      if (!cur) {
        unknownOnMagento++;
        results.phase1_civetta.failed++;
        if (results.phase1_civetta.errors.length < 10) {
          results.phase1_civetta.errors.push({ sku: op.sku, error: 'not found on Magento' });
        }
        continue;
      }
      // Skip SOLO se civettaai è gia' esattamente al target option_id.
      // civettaai = null NON e' equivalente a "off": significa che xHumanPro non
      // ha espresso opinione e Magento applica fallback su `civetta` (Farmabooster).
      // Per avere PRIORITA' su Farmabooster (cosi' una pepita viene inclusa anche
      // se FB l'ha esclusa, e un burner escluso anche se FB l'ha incluso) bisogna
      // sempre settare l'option_id esplicito.
      const curValue = cur.civettaai;
      if (curValue === String(op.target)) {
        alreadyCoherent++;
        results.phase1_civetta.success++;
        appliedCivettaSKUs.push(op.sku);
      } else {
        civettaToWrite.push(op);
      }
    }
    console.log(`[MagentoSync] Delta result: already-coherent=${alreadyCoherent}, need-PUT=${civettaToWrite.length}, unknown=${unknownOnMagento}`);

  try {
    const civettaFns = civettaToWrite.map(op => async () => {
      try {
        const resp = await magentoQueue.enqueue(async () => {
          return fetch(`${baseUrl}/rest/V1/products/${encodeURIComponent(op.sku)}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              product: {
                sku: op.sku,
                custom_attributes: [
                  { attribute_code: 'civettaai', value: String(op.target) },
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
        appliedCivettaSKUs.push(op.sku);
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
        appliedPriceSKUs.push(pc.sku);
      } catch (e) {
        results.phase2_prices.failed++;
        if (results.phase2_prices.errors.length < 10) {
          results.phase2_prices.errors.push({ sku: pc.sku, error: e.message });
        }
      }
    });

    await throttledBatchFetch(priceFns, WRITE_CONCURRENCY, WRITE_DELAY);
  } finally {
    // Persistiamo SEMPRE quello che è andato a buon fine, anche se il run è stato
    // troncato (uncaught exception, container restart, ecc). Il PID 250 del 28/5
    // è morto prima di questo finale e ha lasciato 10k feed_actions in 'dispatched'.
    const appliedSKUs = [...appliedCivettaSKUs, ...appliedPriceSKUs];
    if (appliedSKUs.length > 0) {
      try {
        await pool.query(
          `INSERT INTO feed_dispatch_log (tenant_id, endpoint, products_served, request_ip)
           VALUES ($1, 'magento-sync', $2, NULL)`,
          [tenantId, appliedSKUs.length]
        );
        await pool.query(
          `UPDATE feed_actions SET status = 'applied', applied_at = NOW()
           WHERE tenant_id = $1 AND sku = ANY($2) AND status IN ('pending', 'dispatched')`,
          [tenantId, appliedSKUs]
        );
      } catch (persistErr) {
        console.error(`[MagentoSync] Failed to persist applied state:`, persistErr.message);
      }
    }
    console.log(`[MagentoSync] Done: civetta ${results.phase1_civetta.success}/${results.phase1_civetta.success + results.phase1_civetta.failed}, prices ${results.phase2_prices.success}/${results.phase2_prices.success + results.phase2_prices.failed}`);
  }

  return {
    executed: true,
    ...results,
    summary: previewResult.summary,
  };
}

module.exports = { preview, execute, validatePriceSafety, batchFetchProducts, getCivettaMode, getCivettaaiOptionIds };
