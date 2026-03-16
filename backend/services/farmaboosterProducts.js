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

  const price = parseFloat(product.product_price || 0);
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

    // Map rule type: 1=Diretto, 2=Sconto, 3=Salva Bilancio, 4=Muro
    const ruleTypes = { '1': 'diretto', '2': 'sconto', '3': 'salva_bilancio', '4': 'muro' };

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

      const productsData = await fetchAllPages(tenantId, config, 'products', 100, (done, total) => {
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

      // Complete
      if (jobId) {
        await pool.query(
          `UPDATE import_jobs SET status = 'completed', completed_at = NOW(),
           records_processed = $1, records_imported = $2, records_updated = $3,
           metadata = $4 WHERE id = $5`,
          [productsData.length, totalImported, totalUpdated,
           JSON.stringify({ phase: 'done', phase_label: 'Completato', pct: 100, total_products: productsData.length, rules_saved: rulesSaved }),
           jobId]
        );
      }

      console.log(`[Products] Import complete: ${totalImported} new, ${totalUpdated} updated, ${rulesSaved} rules`);
      return { totalProcessed: productsData.length, totalImported, totalUpdated, rulesSaved };

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

module.exports = { importProducts };
