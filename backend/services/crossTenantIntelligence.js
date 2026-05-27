/**
 * Cross-Tenant Intelligence
 *
 * Weekly analysis that identifies cross-tenant product patterns:
 *
 * Verdicts:
 *   universal_star   — star/cash_cow in 60%+ tenant, ordini in 2+ tenant → proteggere
 *   universal_burner — burner in ALL tenants, 0 ordini ovunque, click significativi (>10) → segnalare
 *   cross_quarantine — 1-2 click per tenant in 2+ tenant, 0 ordini ovunque, 0 vendite store,
 *                      <5 domanda globale → quarantena cross-tenant (il feed engine da solo
 *                      non può decidere perché per-tenant i dati sono insufficienti)
 *   mixed            — classificazione diversa tra tenant
 *   insufficient_data— dati insufficienti
 *
 * Rivalutazione: se un qualsiasi tenant genera un ordine per un prodotto in cross_quarantine,
 * il verdetto viene rivalutato al prossimo ciclo e il prodotto esce dalla quarantena cross-tenant.
 *
 * Runs weekly (Sunday night) via healthCron.
 */

const { pool } = require('../db/pool');

const DEFAULT_CPC = 0.27;

/**
 * Compute cross-tenant product intelligence
 * Analyzes all products across all tenants to find universal patterns
 */
async function computeCrossTenantIntelligence() {
  const startTime = Date.now();
  console.log('[CrossTenant] Starting cross-tenant intelligence analysis...');

  // Load CPC config (use first tenant's config as baseline)
  const { rows: cpcRows } = await pool.query(
    `SELECT config_value FROM health_config WHERE config_key = 'avg_tp_cpc' LIMIT 1`
  );
  const cpc = cpcRows.length > 0 ? parseFloat(cpcRows[0].config_value) : DEFAULT_CPC;

  // Step 1: Gather per-tenant data for all products with health scores
  const { rows: productData } = await pool.query(`
    SELECT
      p.sku,
      p.product_name,
      p.category,
      p.brand,
      p.sell_price,
      p.margin_pct,
      p.is_civetta,
      COALESCE(p.sales_30d_seller, 0) as sales_30d_seller,
      COALESCE(p.sales_30d_aggregated, 0) as sales_30d_aggregated,
      t.id as tenant_id,
      t.name as tenant_name,
      ph.classification,
      COALESCE(ph.tp_clicks_30d, 0) as clicks_30d,
      COALESCE(ph.tp_attributed_orders, 0) as orders_30d,
      COALESCE(ph.tp_attributed_revenue, 0) as revenue_30d,
      COALESCE(ph.tp_click_cost_30d, 0) as click_cost_30d,
      COALESCE(ph.tp_cost_incidence, 0) as cost_incidence,
      ph.scraper_position,
      ph.scraper_best_price
    FROM products p
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN product_health_scores ph ON ph.sku = p.sku AND ph.tenant_id = p.tenant_id
    WHERE ph.classification IS NOT NULL
    ORDER BY p.sku
  `);

  console.log(`[CrossTenant] Loaded ${productData.length} product-tenant records`);

  // Step 2: Group by SKU
  const skuMap = {};
  for (const row of productData) {
    if (!skuMap[row.sku]) {
      skuMap[row.sku] = {
        sku: row.sku,
        product_name: row.product_name,
        category: row.category,
        brand: row.brand,
        tenants: [],
      };
    }
    skuMap[row.sku].tenants.push(row);
  }

  const skus = Object.values(skuMap);
  console.log(`[CrossTenant] ${skus.length} unique SKUs across tenants`);

  // Step 3: Compute cross-tenant metrics
  const crossProducts = [];
  const crossDetails = [];

  for (const sku of skus) {
    const tenantCount = sku.tenants.length;
    if (tenantCount < 2) continue; // Need at least 2 tenants for cross-tenant analysis

    let starCount = 0, cashCowCount = 0, burnerCount = 0, zombieCount = 0, opportunityCount = 0;
    let tenantsWithClicks = 0, tenantsWithOrders = 0;
    let totalClicks = 0, totalOrders = 0, totalRevenue = 0, totalCost = 0;
    let incidenceSum = 0, incidenceCount = 0;
    let marginSum = 0, marginCount = 0;
    let bestSellPrice = null, worstSellPrice = null;
    let bestScraperPrice = null;
    const positions = [];
    let maxClicksPerTenant = 0;        // highest click count in any single tenant
    let tenantsWithStoreSales = 0;     // tenants where it sells in store
    let tenantsWithGlobalDemand = 0;   // tenants where sales_30d_aggregated >= 5

    for (const t of sku.tenants) {
      // Classification counts
      switch (t.classification) {
        case 'star': starCount++; break;
        case 'cash_cow': cashCowCount++; break;
        case 'burner': burnerCount++; break;
        case 'zombie': zombieCount++; break;
        case 'opportunity': opportunityCount++; break;
      }

      // Click/order counts
      if (t.clicks_30d > 0) tenantsWithClicks++;
      if (t.orders_30d > 0) tenantsWithOrders++;
      if (t.clicks_30d > maxClicksPerTenant) maxClicksPerTenant = t.clicks_30d;
      if ((parseInt(t.sales_30d_seller) || 0) > 0) tenantsWithStoreSales++;
      if ((parseInt(t.sales_30d_aggregated) || 0) >= 5) tenantsWithGlobalDemand++;

      totalClicks += t.clicks_30d;
      totalOrders += t.orders_30d;
      totalRevenue += parseFloat(t.revenue_30d) || 0;
      totalCost += parseFloat(t.click_cost_30d) || 0;

      if (t.orders_30d > 0 && t.cost_incidence > 0) {
        incidenceSum += parseFloat(t.cost_incidence);
        incidenceCount++;
      }

      const mp = parseFloat(t.margin_pct);
      if (mp > 0) { marginSum += mp; marginCount++; }

      const sp = parseFloat(t.sell_price);
      if (sp > 0) {
        if (bestSellPrice === null || sp < bestSellPrice) bestSellPrice = sp;
        if (worstSellPrice === null || sp > worstSellPrice) worstSellPrice = sp;
      }

      const bsp = parseFloat(t.scraper_best_price);
      if (bsp > 0 && (bestScraperPrice === null || bsp < bestScraperPrice)) {
        bestScraperPrice = bsp;
      }

      const pos = parseInt(t.scraper_position);
      if (pos > 0) positions.push(pos);

      // Detail record
      crossDetails.push({
        sku: sku.sku,
        tenant_id: t.tenant_id,
        tenant_name: t.tenant_name,
        classification: t.classification,
        clicks_30d: t.clicks_30d,
        orders_30d: t.orders_30d,
        revenue_30d: parseFloat(t.revenue_30d) || 0,
        click_cost_30d: parseFloat(t.click_cost_30d) || 0,
        cost_incidence: parseFloat(t.cost_incidence) || 0,
        sell_price: parseFloat(t.sell_price) || 0,
        margin_pct: parseFloat(t.margin_pct) || 0,
        scraper_position: parseInt(t.scraper_position) || null,
        is_civetta: t.is_civetta,
      });
    }

    // Determine verdict
    const positiveCount = starCount + cashCowCount;
    let verdict = 'insufficient_data';

    if (tenantCount >= 2) {
      // Universal Star: star/cash_cow in 60%+ tenant, ordini in 2+ tenant
      if (positiveCount >= Math.ceil(tenantCount * 0.6) && tenantsWithOrders >= 2) {
        verdict = 'universal_star';

      // Universal Burner (strict): burner in ALL tenants, 0 ordini ovunque, click significativi
      } else if (burnerCount === tenantCount && tenantsWithOrders === 0 && totalClicks >= 10) {
        verdict = 'universal_burner';

      // Cross Quarantine: low-click noise across all tenants
      //   - 1-2 click max per tenant (nessuno ha abbastanza dati per decidere da solo)
      //   - click in 2+ tenant (pattern confermato cross-tenant)
      //   - zero ordini TP ovunque
      //   - zero vendite in store ovunque
      //   - domanda globale <5 ovunque (nessun segnale di mercato)
      } else if (
        maxClicksPerTenant <= 2
        && tenantsWithClicks >= 2
        && tenantsWithOrders === 0
        && tenantsWithStoreSales === 0
        && tenantsWithGlobalDemand === 0
      ) {
        verdict = 'cross_quarantine';

      } else if (positiveCount > 0 || burnerCount > 0 || totalClicks > 0) {
        verdict = 'mixed';
      }
    }

    crossProducts.push({
      sku: sku.sku,
      product_name: sku.product_name,
      category: sku.category,
      brand: sku.brand,
      tenant_count: tenantCount,
      tenants_with_clicks: tenantsWithClicks,
      tenants_with_orders: tenantsWithOrders,
      star_count: starCount,
      cash_cow_count: cashCowCount,
      burner_count: burnerCount,
      zombie_count: zombieCount,
      opportunity_count: opportunityCount,
      verdict,
      total_clicks_30d: totalClicks,
      total_orders_30d: totalOrders,
      total_revenue_30d: +totalRevenue.toFixed(2),
      total_click_cost_30d: +totalCost.toFixed(2),
      avg_cost_incidence: incidenceCount > 0 ? +(incidenceSum / incidenceCount).toFixed(2) : null,
      avg_margin_pct: marginCount > 0 ? +(marginSum / marginCount).toFixed(1) : null,
      best_sell_price: bestSellPrice,
      worst_sell_price: worstSellPrice,
      scraper_best_price: bestScraperPrice,
      avg_scraper_position: positions.length > 0
        ? +(positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1)
        : null,
    });
  }

  // Step 4: Persist — clear and rewrite
  await pool.query('DELETE FROM cross_tenant_product_details');
  await pool.query('DELETE FROM cross_tenant_products');

  // Insert cross-tenant products in batches
  const BATCH = 50;
  for (let i = 0; i < crossProducts.length; i += BATCH) {
    const batch = crossProducts.slice(i, i + BATCH);
    const values = [];
    const placeholders = [];

    for (let j = 0; j < batch.length; j++) {
      const p = batch[j];
      const base = j * 22;
      const ph = [];
      for (let c = 1; c <= 22; c++) ph.push(`$${base + c}`);
      placeholders.push(`(${ph.join(',')})`);

      values.push(
        p.sku, p.product_name, p.category, p.brand,
        p.tenant_count, p.tenants_with_clicks, p.tenants_with_orders,
        p.star_count, p.cash_cow_count, p.burner_count, p.zombie_count, p.opportunity_count,
        p.verdict,
        p.total_clicks_30d, p.total_orders_30d, p.total_revenue_30d, p.total_click_cost_30d,
        p.avg_cost_incidence, p.avg_margin_pct,
        p.best_sell_price, p.worst_sell_price, p.scraper_best_price
      );
    }

    await pool.query(`
      INSERT INTO cross_tenant_products (
        sku, product_name, category, brand,
        tenant_count, tenants_with_clicks, tenants_with_orders,
        star_count, cash_cow_count, burner_count, zombie_count, opportunity_count,
        verdict,
        total_clicks_30d, total_orders_30d, total_revenue_30d, total_click_cost_30d,
        avg_cost_incidence, avg_margin_pct,
        best_sell_price, worst_sell_price, scraper_best_price
      ) VALUES ${placeholders.join(',')}
      ON CONFLICT (sku) DO UPDATE SET
        product_name = EXCLUDED.product_name, category = EXCLUDED.category, brand = EXCLUDED.brand,
        tenant_count = EXCLUDED.tenant_count, tenants_with_clicks = EXCLUDED.tenants_with_clicks,
        tenants_with_orders = EXCLUDED.tenants_with_orders,
        star_count = EXCLUDED.star_count, cash_cow_count = EXCLUDED.cash_cow_count,
        burner_count = EXCLUDED.burner_count, zombie_count = EXCLUDED.zombie_count,
        opportunity_count = EXCLUDED.opportunity_count, verdict = EXCLUDED.verdict,
        total_clicks_30d = EXCLUDED.total_clicks_30d, total_orders_30d = EXCLUDED.total_orders_30d,
        total_revenue_30d = EXCLUDED.total_revenue_30d, total_click_cost_30d = EXCLUDED.total_click_cost_30d,
        avg_cost_incidence = EXCLUDED.avg_cost_incidence, avg_margin_pct = EXCLUDED.avg_margin_pct,
        best_sell_price = EXCLUDED.best_sell_price, worst_sell_price = EXCLUDED.worst_sell_price,
        scraper_best_price = EXCLUDED.scraper_best_price, computed_at = NOW()
    `, values);
  }

  // Insert details in batches
  for (let i = 0; i < crossDetails.length; i += BATCH) {
    const batch = crossDetails.slice(i, i + BATCH);
    const values = [];
    const placeholders = [];

    for (let j = 0; j < batch.length; j++) {
      const d = batch[j];
      const base = j * 14;
      const ph = [];
      for (let c = 1; c <= 14; c++) ph.push(`$${base + c}`);
      placeholders.push(`(${ph.join(',')})`);

      values.push(
        d.sku, d.tenant_id, d.tenant_name, d.classification,
        d.clicks_30d, d.orders_30d, d.revenue_30d, d.click_cost_30d,
        d.cost_incidence, d.sell_price, d.margin_pct,
        d.scraper_position, d.is_civetta, new Date()
      );
    }

    await pool.query(`
      INSERT INTO cross_tenant_product_details (
        sku, tenant_id, tenant_name, classification,
        clicks_30d, orders_30d, revenue_30d, click_cost_30d,
        cost_incidence, sell_price, margin_pct,
        scraper_position, is_civetta, computed_at
      ) VALUES ${placeholders.join(',')}
      ON CONFLICT (sku, tenant_id) DO UPDATE SET
        tenant_name = EXCLUDED.tenant_name, classification = EXCLUDED.classification,
        clicks_30d = EXCLUDED.clicks_30d, orders_30d = EXCLUDED.orders_30d,
        revenue_30d = EXCLUDED.revenue_30d, click_cost_30d = EXCLUDED.click_cost_30d,
        cost_incidence = EXCLUDED.cost_incidence, sell_price = EXCLUDED.sell_price,
        margin_pct = EXCLUDED.margin_pct, scraper_position = EXCLUDED.scraper_position,
        is_civetta = EXCLUDED.is_civetta, computed_at = NOW()
    `, values);
  }

  // Step 5: Summary
  const verdictCounts = {};
  for (const p of crossProducts) {
    verdictCounts[p.verdict] = (verdictCounts[p.verdict] || 0) + 1;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[CrossTenant] Completed in ${elapsed}s: ${crossProducts.length} cross-tenant products`);
  console.log(`[CrossTenant] Verdicts: ${JSON.stringify(verdictCounts)}`);

  // Log top results per verdict
  const uStars = crossProducts.filter(p => p.verdict === 'universal_star').sort((a, b) => b.total_revenue_30d - a.total_revenue_30d);
  const uBurners = crossProducts.filter(p => p.verdict === 'universal_burner').sort((a, b) => b.total_clicks_30d - a.total_clicks_30d);
  const cQuarantine = crossProducts.filter(p => p.verdict === 'cross_quarantine');

  if (uStars.length > 0) {
    console.log(`[CrossTenant] Universal Stars (${uStars.length}):`);
    uStars.slice(0, 5).forEach(s => {
      console.log(`  STAR ${s.sku} ${(s.product_name || '').substring(0, 40)} — ${s.tenants_with_orders}/${s.tenant_count} tenant, ${s.total_orders_30d} ordini, EUR${s.total_revenue_30d}`);
    });
  }

  if (uBurners.length > 0) {
    console.log(`[CrossTenant] Universal Burners (${uBurners.length}):`);
    uBurners.slice(0, 5).forEach(b => {
      console.log(`  BURN ${b.sku} ${(b.product_name || '').substring(0, 40)} — ${b.tenants_with_clicks}/${b.tenant_count} tenant, ${b.total_clicks_30d} click, EUR${b.total_click_cost_30d} bruciati`);
    });
  }

  const cqClicks = cQuarantine.reduce((s, p) => s + p.total_clicks_30d, 0);
  console.log(`[CrossTenant] Cross Quarantine: ${cQuarantine.length} prodotti, ${cqClicks} click (EUR${(cqClicks * cpc).toFixed(2)} stimati)`);

  return {
    totalProducts: crossProducts.length,
    verdicts: verdictCounts,
    universalStars: uStars.length,
    universalBurners: uBurners.length,
    crossQuarantine: cQuarantine.length,
  };
}

/**
 * Re-evaluate cross_quarantine products: if ANY tenant got an order,
 * release the product from cross_quarantine and reactivate quarantined SKUs.
 *
 * This runs every cycle (hourly) as part of the feed engine pipeline,
 * not just weekly like the full intelligence computation.
 */
async function reevaluateCrossQuarantine() {
  // Find cross_quarantine products that now have orders in at least one tenant
  const { rows: recovered } = await pool.query(`
    SELECT ctp.sku
    FROM cross_tenant_products ctp
    JOIN product_health_scores ph ON ph.sku = ctp.sku
    WHERE ctp.verdict = 'cross_quarantine'
      AND ph.tp_attributed_orders > 0
    GROUP BY ctp.sku
  `);

  if (recovered.length === 0) return { recovered: 0, reactivated: 0 };

  const recoveredSkus = recovered.map(r => r.sku);

  // Update verdict to 'mixed' (no longer qualifies for cross_quarantine)
  await pool.query(`
    UPDATE cross_tenant_products
    SET verdict = 'mixed', computed_at = NOW()
    WHERE sku = ANY($1) AND verdict = 'cross_quarantine'
  `, [recoveredSkus]);

  // Reactivate quarantined SKUs across ALL tenants for these products
  const { rowCount: reactivated } = await pool.query(`
    UPDATE feed_quarantine
    SET reactivated = true, reactivated_at = NOW(),
        observation_start = NOW(), observation_end = NOW() + INTERVAL '3 days'
    WHERE sku = ANY($1)
      AND reason = 'cross_tenant_quarantine'
      AND reactivated = false
  `, [recoveredSkus]);

  if (recovered.length > 0) {
    console.log(`[CrossTenant] Recovered ${recovered.length} products from cross_quarantine (${reactivated} quarantines released):`);
    recoveredSkus.slice(0, 5).forEach(sku => console.log(`  RECOVERED ${sku}`));
  }

  return { recovered: recovered.length, reactivated };
}

module.exports = { computeCrossTenantIntelligence, reevaluateCrossQuarantine };
