/**
 * Farmabooster Products & Price Rules Import Service
 *
 * Imports:
 * 1. Products catalog with all fields (prices, costs, margins, stock, sales30global)
 * 2. Price rules (extracted from product markup data)
 *
 * Sales data:
 * - sales30global: pieces sold in last 30 days across ALL tenants (from product API directly)
 *
 * All with tenant isolation (tenant_id + sku unique)
 */

const { pool } = require('../db/pool');
const { getFarmaboosterConfig, fetchAllPages } = require('./farmaboosterClient');
const { withJobLock } = require('./requestQueue');

const DELAY_BETWEEN_SAVES_MS = 30; // 30ms between DB saves

/**
 * Save a single product to DB (upsert)
 */
async function saveProduct(tenantId, product, topsearchRuleIds = new Set()) {
  const sku = product.product_code;
  if (!sku) return false;

  // sell_price: usa product_price (calcolato da regola prezzo) come primario;
  // fallback a product_exported_price (prezzo effettivamente esportato a TP) per
  // i prodotti senza regola prezzo applicata. Senza fallback, ~25% del catalogo
  // di alcuni tenant (es. Mandanici) finiva in DB con sell_price=0 ma andava
  // comunque a TP con un prezzo valido.
  // ATTENZIONE: l'API restituisce "0" come stringa quando il prezzo manca, e "0" e' truthy
  // in JS. Il `||` non scatterebbe sul fallback. Per questo facciamo prima parseFloat e poi
  // controlliamo > 0 numericamente. (Bug osservato Mandanici 29/4/2026, ~13k SKU persi.)
  const _priceMain = parseFloat(product.product_price) || 0;
  const _priceExported = parseFloat(product.product_exported_price) || 0;
  const price = _priceMain > 0 ? _priceMain : _priceExported;
  const erpCost = parseFloat(product.product_erp_min_cost || 0);
  const supplierCost = parseFloat(product.product_supplier_min_cost || 0);
  // Use min_cost (best cost from any source: ERP or Supplier) for margin calculation
  const cost = parseFloat(product.product_min_cost || 0) || erpCost || supplierCost;
  const margin = price > 0 && cost > 0 ? Math.round((price - cost) * 100) / 100 : 0;
  const marginPct = price > 0 && cost > 0 ? Math.round(((price - cost) / price) * 10000) / 100 : 0;

  // sales30 = pieces sold 30d by THIS seller, sales30global = across ALL tenants
  const sales30seller = parseInt(product.sales30 || 0);
  const sales30global = parseFloat(product.sales30global || 0);

  // TopSearch: use direct API field (S/N), fallback to price rule check
  const isTopSearch = product.topsearch === 'S' || product.topsearch === '1' || topsearchRuleIds.has(product.product_price_rule_id);

  const { rows } = await pool.query(
    `INSERT INTO products (tenant_id, sku, product_name, category, reference_price,
       erp_cost, sell_price, markup, margin, margin_pct,
       sales_30d_seller, sales_30d_aggregated,
       erp_stock, supplier_stock, unmanage_stock, saleable, export_status,
       is_civetta, is_topsearch, is_topkey,
       brand, manufacturer, ean, scraper_position, price_rule_id, raw_data, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW())
     ON CONFLICT (tenant_id, sku) DO UPDATE SET
       product_name = EXCLUDED.product_name,
       category = EXCLUDED.category,
       reference_price = EXCLUDED.reference_price,
       erp_cost = EXCLUDED.erp_cost,
       sell_price = EXCLUDED.sell_price,
       markup = EXCLUDED.markup,
       margin = EXCLUDED.margin,
       margin_pct = EXCLUDED.margin_pct,
       sales_30d_seller = EXCLUDED.sales_30d_seller,
       sales_30d_aggregated = EXCLUDED.sales_30d_aggregated,
       erp_stock = EXCLUDED.erp_stock,
       supplier_stock = EXCLUDED.supplier_stock,
       unmanage_stock = EXCLUDED.unmanage_stock,
       saleable = EXCLUDED.saleable,
       export_status = EXCLUDED.export_status,
       is_civetta = EXCLUDED.is_civetta,
       is_topsearch = EXCLUDED.is_topsearch,
       is_topkey = EXCLUDED.is_topkey,
       brand = EXCLUDED.brand,
       manufacturer = EXCLUDED.manufacturer,
       ean = EXCLUDED.ean,
       scraper_position = EXCLUDED.scraper_position,
       price_rule_id = EXCLUDED.price_rule_id,
       raw_data = EXCLUDED.raw_data,
       updated_at = NOW()
     RETURNING (xmax = 0) AS is_new`,
    [
      tenantId,
      sku,
      product.product_name || '',
      product.product_farmadati_category_descriptions || '',
      parseFloat(product.product_reference_price || 0),
      cost,       // erp_cost field stores the best available cost (min_cost)
      price,
      parseFloat(product.product_price_rule_final_markup || 0),
      margin,
      marginPct,
      sales30seller,   // sales_30d_seller = vendite 30gg singolo seller
      sales30global,   // sales_30d_aggregated = vendite 30gg globale tutti i tenant
      parseInt(product.product_erp_stock || 0),
      parseInt(product.product_supplier_stock || 0),
      product.product_unmanage_stock === '1',
      product.product_saleable === '1' || product.product_saleable === 1,
      product.product_export_status || '',
      product.product_civetta === '1' || product.product_civetta === 1,
      isTopSearch,     // is_topsearch: from API field or price rule
      false, // is_topkey - will be calculated separately
      product.product_farmadati_brand || '',
      product.product_farmadati_ditta || '',
      product.product_ean || '',
      parseInt(product.product_price_rule_scraper_position || 0) || null,
      product.product_price_rule_id || null,
      JSON.stringify({
        export_status: product.product_export_status,
        erp_cost: erpCost,
        supplier_cost: supplierCost,
        min_cost: cost,
        min_cost_source: product.product_min_cost_source || '',
        exported_price: parseFloat(product.product_exported_price || 0),
        price_rule_markup: product.product_price_rule_final_markup,
        scraper_position: product.product_price_rule_scraper_position,
        sales30seller,
        sales30global,
        topsearch: product.topsearch || '',
        civettaai: product.product_civettaai === '1' || product.product_civettaai === 1,
      }),
    ]
  );

  return rows[0].is_new;
}

/**
 * Import price rules from Farmabooster API endpoint /pricerules
 * Returns the real tenant-specific price rules with all configuration
 */
async function savePriceRules(tenantId, config) {
  const { apiCall } = require('./farmaboosterClient');

  // Fetch price rules from dedicated API endpoint
  const rulesResponse = await apiCall(tenantId, config, 'pricerules', { page: 1 });
  const rulesData = rulesResponse.data || [];

  console.log(`[Products] Fetched ${rulesData.length} price rules from Farmabooster`);

  let saved = 0;
  for (const r of rulesData) {
    const ruleId = r.price_rule_id;
    if (!ruleId) continue;

    // Map rule type Farmabooster: 1=Ricarico, 2=Sconto, 3=Salva Bilancio, 4=Muro
    // NB: il "Diretto/Grossista" e' un'altra dimensione (sourcing), derivata da erp_ids/supplier_ids.
    const ruleTypes = { '1': 'ricarico', '2': 'sconto', '3': 'salva_bilancio', '4': 'muro' };

    await pool.query(
      `INSERT INTO price_rules (tenant_id, rule_id, rule_name, rule_type, rule_data, is_active, priority, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (tenant_id, rule_id) DO UPDATE SET
         rule_name = EXCLUDED.rule_name,
         rule_type = EXCLUDED.rule_type,
         rule_data = EXCLUDED.rule_data,
         is_active = EXCLUDED.is_active,
         priority = EXCLUDED.priority,
         updated_at = NOW()`,
      [
        tenantId,
        ruleId,
        r.price_rule_name || `Regola #${ruleId}`,
        ruleTypes[r.price_rule_type] || r.price_rule_type,
        JSON.stringify({
          type: r.price_rule_type,
          from_cost: parseFloat(r.price_rule_from_cost || 0),
          to_cost: parseFloat(r.price_rule_to_cost || 0),
          recharge_pct: parseFloat(r.price_rule_recharge || 0),
          recharge_type: r.price_rule_recharge_type,
          discount_pct: parseFloat(r.price_rule_discount || 0),
          discount_type: r.price_rule_discount_type,
          scraper_position: parseInt(r.price_rule_scraper_position || 0),
          scraper_from_position: parseInt(r.price_rule_scraper_from_position || 0),
          only_topsearch: r.price_rule_only_topsearch === '1',
          no_erp_stock: r.price_rule_no_erp_stock === '1',
          max_saleable_qty: parseInt(r.price_rule_max_saleable_qty || 0),
          brand_id: r.price_rule_brand_id || null,
          category_id: r.price_rule_category_id || null,
          erp_ids: r.price_rule_erp_ids || '',
          supplier_ids: r.price_rule_supplier_ids || '',
          wall_position: parseInt(r.price_rule_wall_position || 0),
          position_dynamic_price: r.price_rule_position_dynamic_price === '1',
          budgetsave_threshold: parseFloat(r.price_rule_budgetsave_theshold || 0),
        }),
        r.price_rule_active === '1',
        parseInt(r.price_rule_priority || 0),
      ]
    );
    saved++;
  }

  // Return set of topsearch rule IDs for product matching
  const topsearchRuleIds = new Set();
  for (const r of rulesData) {
    if (r.price_rule_only_topsearch === '1') {
      topsearchRuleIds.add(r.price_rule_id);
    }
  }

  return { saved, topsearchRuleIds };
}

/**
 * Main import function
 * Fetches products from Farmabooster, saves to DB
 *
 * Rate limits:
 * - Max 3 concurrent requests per batch
 * - 1s delay between batches
 * - 30 req/min rate limit per tenant
 * - Sequential DB saves with 30ms delay
 */
async function importProducts(tenantId, jobId = null) {
  return withJobLock(tenantId, 'products_import', async () => {
    const config = await getFarmaboosterConfig(tenantId);

    console.log(`[Products] Starting import for tenant ${tenantId}`);

    if (jobId) {
      await pool.query(
        "UPDATE import_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
        [jobId]
      );
    }

    // Helper to update job progress in DB
    const updateProgress = (meta) => {
      if (!jobId) return;
      pool.query(
        `UPDATE import_jobs SET metadata = $1, records_processed = $2, records_imported = $3, records_updated = $4 WHERE id = $5`,
        [JSON.stringify(meta), meta.records_processed || 0, meta.records_imported || 0, meta.records_updated || 0, jobId]
      ).catch(() => {});
    };

    try {
      // Step 1: Import price rules first (we need topsearch rule IDs for products)
      console.log('[Products] Importing price rules from Farmabooster...');
      updateProgress({ phase: 'rules', phase_label: 'Import regole prezzo...', pct: 0 });
      const { saved: rulesSaved, topsearchRuleIds } = await savePriceRules(tenantId, config);
      console.log(`[Products] ${rulesSaved} price rules imported, ${topsearchRuleIds.size} TopSearch rules: [${[...topsearchRuleIds].join(', ')}]`);

      // Step 2: Fetch all products
      console.log('[Products] Fetching products from Farmabooster...');
      updateProgress({ phase: 'fetch_products', phase_label: 'Download catalogo prodotti...', pages_done: 0, pages_total: 0, pct: 5 });

      // maxPages 500 = fino a 500k SKU. Papa aveva >100k e veniva troncato silenziosamente,
      // perdendo prodotti come 951870310 mai importati.
      const productsData = await fetchAllPages(tenantId, config, 'products', 500, (done, total) => {
        const pct = 5 + Math.round((done / total) * 35); // 5-40%
        updateProgress({
          phase: 'fetch_products', phase_label: `Download catalogo: ${done}/${total} pagine`,
          pages_done: done, pages_total: total, pct,
          records_processed: 0, records_imported: 0, records_updated: 0,
        });
      });

      console.log(`[Products] ${productsData.length} products fetched`);

      updateProgress({
        phase: 'saving', phase_label: `Salvataggio 0/${productsData.length} prodotti...`,
        pct: 40, total_products: productsData.length,
        records_processed: 0, records_imported: 0, records_updated: 0,
      });

      // Step 3: Save products to DB (sequential with delay)
      let totalImported = 0;
      let totalUpdated = 0;

      for (let i = 0; i < productsData.length; i++) {
        const isNew = await saveProduct(tenantId, productsData[i], topsearchRuleIds);
        if (isNew) totalImported++;
        else totalUpdated++;

        // Small delay every 20 products
        if (i % 20 === 0 && DELAY_BETWEEN_SAVES_MS > 0) {
          await new Promise(r => setTimeout(r, DELAY_BETWEEN_SAVES_MS));
        }

        // Update progress every 200 products
        if (jobId && i % 200 === 0) {
          const pct = 40 + Math.round(((i + 1) / productsData.length) * 55); // 40-95%
          updateProgress({
            phase: 'saving', phase_label: `Salvataggio ${i + 1}/${productsData.length} prodotti...`,
            pct, total_products: productsData.length,
            records_processed: i + 1, records_imported: totalImported, records_updated: totalUpdated,
          });
        }
      }

      // Step 4: Sync civetta flag from Magento (source of truth)
      console.log('[Products] Syncing civetta flag from Magento...');
      updateProgress({ phase: 'civetta_sync', phase_label: 'Sync civetta da Magento...', pct: 96 });
      let civettaSynced = 0;
      try {
        civettaSynced = await syncCivettaFromMagento(tenantId);
        console.log(`[Products] Civetta synced: ${civettaSynced} products set to civetta=1`);
      } catch (civErr) {
        console.error('[Products] Civetta sync error:', civErr.message);
      }

      // Complete
      if (jobId) {
        await pool.query(
          `UPDATE import_jobs SET status = 'completed', completed_at = NOW(),
           records_processed = $1, records_imported = $2, records_updated = $3,
           metadata = $4 WHERE id = $5`,
          [productsData.length, totalImported, totalUpdated,
           JSON.stringify({ phase: 'done', phase_label: 'Completato', pct: 100, total_products: productsData.length, rules_saved: rulesSaved, civetta_synced: civettaSynced }),
           jobId]
        );
      }

      console.log(`[Products] Import complete: ${totalImported} new, ${totalUpdated} updated, ${rulesSaved} rules, ${civettaSynced} civetta synced`);
      return { totalProcessed: productsData.length, totalImported, totalUpdated, rulesSaved, civettaSynced };

    } catch (err) {
      console.error(`[Products] Import error:`, err.message);
      if (jobId) {
        await pool.query(
          `UPDATE import_jobs SET status = 'failed', completed_at = NOW(), error_message = $1 WHERE id = $2`,
          [err.message, jobId]
        );
      }
      throw err;
    }
  });
}

/**
 * Sync civetta flag from Magento (source of truth).
 * Farmabooster API may have stale civetta values — Magento's attribute is the real flag.
 */
async function syncCivettaFromMagento(tenantId) {
  const { decrypt } = require('./crypto');
  const { rows: creds } = await pool.query(
    `SELECT config_key, config_value FROM tenant_configs
     WHERE tenant_id = $1 AND config_key IN ('magento_base_url', 'magento_api_token')`,
    [tenantId]
  );
  const cfg = {};
  for (const c of creds) {
    try { cfg[c.config_key] = decrypt(c.config_value); } catch { cfg[c.config_key] = c.config_value; }
  }
  if (!cfg.magento_base_url || !cfg.magento_api_token) {
    console.log('[Products] Magento not configured, skipping civetta sync');
    return 0;
  }
  if (!cfg.magento_base_url.startsWith('http')) {
    console.log('[Products] Magento URL decryption failed (bad ENCRYPTION_KEY?), skipping civetta sync');
    return 0;
  }

  const baseUrl = cfg.magento_base_url.replace(/\/$/, '');
  const token = cfg.magento_api_token;
  const headers = { Authorization: `Bearer ${token}` };

  const { magentoQueue } = require('./apiQueue');

  // Detect civetta attribute option values (they vary per Magento instance)
  // Some stores use label "1", others "Elastic si", "Si", "Yes", etc.
  let civettaOptionFor1 = null;
  try {
    const attrResp = await magentoQueue.enqueue(
      () => fetch(`${baseUrl}/rest/V1/products/attributes/civetta`, { headers }),
      `magento:civetta-attr:${tenantId}`
    );
    if (attrResp.ok) {
      const attr = await attrResp.json();
      // Normalize: lowercase + strip spaces, hyphens, underscores. Cosi' "elastic si",
      // "elastic-si", "elastic_si" matchano tutti contro lo stesso label canonical.
      const normalize = s => (s || '').toLowerCase().trim().replace(/[-_\s]+/g, '');
      const positiveLabels = ['1', 'si', 'yes', 'elasticsi', 'true', 'attivo'];
      const opt1 = (attr.options || []).find(o => positiveLabels.includes(normalize(o.label)));
      if (opt1) {
        civettaOptionFor1 = opt1.value;
        console.log(`[Products] Civetta attribute: label="${opt1.label}" value=${opt1.value}`);
      } else {
        console.log(`[Products] Civetta attribute options: ${JSON.stringify((attr.options || []).map(o => o.label))}`);
      }
    }
  } catch {}

  if (!civettaOptionFor1) {
    console.log('[Products] Could not detect civetta attribute options, skipping sync');
    return 0;
  }

  // Fetch all SKUs with civetta=1 from Magento — paginazione parallelizzata.
  // PageSize 1000 (vs 300) -> 70% meno pagine. Batch 3 paralleli con pause 500ms
  // per non saturare Magento (alcuni hanno 1-2 worker).
  const PAGE_SIZE = 1000;
  const PARALLEL_BATCH = 3;
  const BATCH_PAUSE_MS = 500;
  const civetta1Set = new Set();
  const baseUrlFilter = `${baseUrl}/rest/V1/products?searchCriteria[filterGroups][0][filters][0][field]=civetta&searchCriteria[filterGroups][0][filters][0][value]=${civettaOptionFor1}&searchCriteria[pageSize]=${PAGE_SIZE}&fields=items[sku],total_count`;

  // 1. Prima chiamata per total_count + items page 1
  const firstResp = await magentoQueue.enqueue(
    () => fetch(`${baseUrlFilter}&searchCriteria[currentPage]=1`, { headers }),
    `magento:civetta-list:${tenantId}:1`
  );
  if (!firstResp.ok) {
    console.log(`[Products] Civetta first page failed: ${firstResp.status}`);
    return 0;
  }
  const firstData = await firstResp.json();
  const totalCount = firstData.total_count || 0;
  (firstData.items || []).forEach(i => civetta1Set.add(i.sku));
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  console.log(`[Products] Civetta sync: ${totalCount} SKU su ${totalPages} pagine (pageSize=${PAGE_SIZE}, ${PARALLEL_BATCH} parallel)`);

  // 2. Pagine 2..N in parallelo a batch di PARALLEL_BATCH
  for (let p = 2; p <= totalPages; p += PARALLEL_BATCH) {
    const batchEnd = Math.min(p + PARALLEL_BATCH - 1, totalPages);
    const promises = [];
    for (let pg = p; pg <= batchEnd; pg++) {
      promises.push(
        magentoQueue.enqueue(
          () => fetch(`${baseUrlFilter}&searchCriteria[currentPage]=${pg}`, { headers }),
          `magento:civetta-list:${tenantId}:${pg}`
        )
      );
    }
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value.ok) continue;
      try {
        const d = await r.value.json();
        (d.items || []).forEach(i => civetta1Set.add(i.sku));
      } catch { /* skip page on parse error */ }
    }
    if (batchEnd < totalPages) {
      await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }
  }

  if (civetta1Set.size === 0) {
    console.log('[Products] No civetta=1 products found in Magento');
    return 0;
  }

  // Reset all to false, then set true for Magento civetta=1
  await pool.query('UPDATE products SET is_civetta = false WHERE tenant_id = $1 AND is_civetta = true', [tenantId]);
  const skuArray = Array.from(civetta1Set);
  let updated = 0;
  for (let i = 0; i < skuArray.length; i += 500) {
    const batch = skuArray.slice(i, i + 500);
    const { rowCount } = await pool.query(
      'UPDATE products SET is_civetta = true WHERE tenant_id = $1 AND sku = ANY($2)',
      [tenantId, batch]
    );
    updated += rowCount;
  }

  return updated;
}

module.exports = { importProducts, syncCivettaFromMagento };
