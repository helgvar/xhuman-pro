/**
 * Feed Decision Engine v3 — UNICO DECISORE
 *
 * Unico motore che scrive feed_actions. Logica:
 * 1. Prende click giornalieri (zombie_clicks) ultimi 14gg
 * 2. Li incrocia con ordini GA4 + Magento per quegli SKU
 * 3. CONVERSION SAFETY GATE: prima di ogni REMOVE, verifica tp_attributed_orders
 * 4. Decide: REMOVE, KEEP, PRICE_CUT, ADD, MONITOR
 * 5. Integra: cross-tenant intelligence, topsearch recovery, killer list, daily tracking
 *
 * REGOLA FONDAMENTALE: un prodotto con ordini TP attribuiti e incidenza < 15%
 * NON viene MAI rimosso. Al massimo PRICE_CUT o MONITOR.
 */

const { pool } = require('../db/pool');
const { resolveStockAndCost, calculatePriceCut, calculateCompetitivePriceCut, calculateRecoveryPriceCut } = require('./feedPriceOptimizer');
const { loadCrossTenantPriceMap, marginFloor } = require('./crossTenantPricing');

const DEFAULT_CPC = 0.27; // EUR per click (netto, IVA esclusa)

/**
 * Conversion Safety Gate
 * Returns: { removable, action }
 *   removable=true  → can be removed (no conversions, or incidence > 30%)
 *   removable=false, action='protect' → converts well (incidence < 15%), NEVER remove
 *   removable=false, action='price_cut' → converts but expensive (15-30%), try price cut not remove
 */
function canRemoveProduct(tpOrders, tpRevenue, tpIncidence) {
  if (!tpOrders || tpOrders === 0) return { removable: true, action: 'remove' };
  if (tpIncidence < 0.15) return { removable: false, action: 'protect' };     // converts well → NEVER remove
  if (tpIncidence < 0.30) return { removable: false, action: 'price_cut' };   // converts but costly → try price cut
  return { removable: true, action: 'remove' };                                // incidence > 30% even with orders → removable
}

/**
 * Load feed config for tenant
 */
async function loadFeedConfig(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1`,
    [tenantId]
  );
  const c = {};
  for (const r of rows) c[r.config_key] = r.config_value;

  return {
    cpc: parseFloat(c.avg_tp_cpc || DEFAULT_CPC),
    monthlyBudget: parseFloat(c.feed_monthly_budget || 3500),
    marginBrackets: JSON.parse(c.feed_margin_brackets || '[]'),
    bigPlayerMerchants: JSON.parse(c.feed_big_player_merchants || '[]'),
    feed_min_margin_pct: parseFloat(c.feed_min_margin_pct || 8),
    feed_min_margin_eur: parseFloat(c.feed_min_margin_eur || 0.50),
    quarantineDaysBudget: parseInt(c.feed_quarantine_days_budget || 30),
    quarantineDaysStock: parseInt(c.feed_quarantine_days_stock || 7),
    reactivationIntervalDays: parseInt(c.feed_reactivation_interval_days || 3),
    reactivationMinDemandScore: parseFloat(c.feed_reactivation_min_demand_score || 3),
    quarantineQ1Days: parseInt(c.quarantine_q1_days || 7),
    quarantineQ2Days: parseInt(c.quarantine_q2_days || 15),
    quarantineQ3Days: parseInt(c.quarantine_q3_days || 30),
    quarantineObservationDays: parseInt(c.quarantine_observation_days || 3),
    // Rate limit: max % del catalogo TP attivo che si puo' quarantinare in un singolo run.
    // Sopra la soglia gli SKU candidati restano MONITOR e si rivedono al prossimo run.
    // Difesa contro il "breadth penalty" di Trovaprezzi quando si rimuovono troppi prodotti
    // in un colpo solo (osservato su Farmacri 15/4/2026: 4227 quarantinati in un run →
    // posizione media TP da 4.2 a 7.1, fatturato store -65% strutturale).
    maxRemovePctPerRun: parseFloat(c.feed_max_remove_pct_per_run || 5),
    maxRemoveAbsoluteFloor: parseInt(c.feed_max_remove_absolute_floor || 50), // sempre minimo 50 SKU/run
    // Module 1: Category Rules
    categoryRulesEnabled: c.feed_category_rules_enabled === 'true',
    categoryRules: JSON.parse(c.feed_category_rules || '{}'),
    // Module 5: Competitor Gap Analysis
    competitorAnalysisEnabled: c.feed_competitor_analysis_enabled === 'true',
    // Module 8: Position Analysis
    positionAnalysisEnabled: c.feed_position_analysis_enabled === 'true',
  };
}

/**
 * Calculate max click budget for a product
 */
function calculateMaxClickBudget(margin, brackets, cpc) {
  if (!brackets || brackets.length === 0) return cpc;
  const bracket = brackets.find(b => margin >= b.min && margin < b.max);
  if (!bracket) return cpc;
  return bracket.maxClicks * cpc;
}

/**
 * Main: compute feed actions based on real daily click data vs conversions
 */
async function computeFeedActions(tenantId) {
  const startTime = Date.now();
  console.log(`[FeedEngine] Starting for tenant ${tenantId.slice(0, 8)}...`);

  const config = await loadFeedConfig(tenantId);

  // === STEP 0: Load cross-tenant intelligence ===
  // Products flagged as cross_quarantine (1-2 click in all tenants, 0 orders everywhere, 0 demand signals)
  const crossQuarantineSet = new Set();
  // Products flagged as universal_star (convert well across tenants → protect from removal)
  const universalStarSet = new Set();
  try {
    const { rows: crossData } = await pool.query(
      `SELECT sku, verdict FROM cross_tenant_products WHERE verdict IN ('cross_quarantine', 'universal_star')`
    );
    for (const r of crossData) {
      if (r.verdict === 'cross_quarantine') crossQuarantineSet.add(r.sku);
      else if (r.verdict === 'universal_star') universalStarSet.add(r.sku);
    }
    if (crossQuarantineSet.size > 0 || universalStarSet.size > 0) {
      console.log(`[FeedEngine] Cross-tenant: ${crossQuarantineSet.size} cross_quarantine, ${universalStarSet.size} universal_star`);
    }
  } catch (crossErr) {
    // Cross-tenant table may not exist yet or be empty — not critical
  }

  // Data maturity: how many days of click data in the last 14 days
  const { rows: [clickDays] } = await pool.query(
    `SELECT COUNT(DISTINCT fetch_date) as days FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 14`,
    [tenantId]
  );
  const dataMaturityDays = parseInt(clickDays?.days) || 0;
  const canQuarantine = true; // Always enabled — quarantine uses fresh data from last 14 days

  // === STEP 0c: Load TP categories for category rules (Module 1) ===
  const tpCategoryMap = {};
  if (config.categoryRulesEnabled) {
    const { rows: catRows } = await pool.query(`
      SELECT DISTINCT ON (product_code) product_code, trovaprezzi_category
      FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 14 AND trovaprezzi_category != ''
      ORDER BY product_code, fetch_date DESC
    `, [tenantId]);
    for (const r of catRows) tpCategoryMap[r.product_code] = r.trovaprezzi_category;
    console.log(`[FeedEngine] Module 1: ${Object.keys(config.categoryRules).length} category rules, ${catRows.length} products mapped`);
  }

  // === STEP 0d: Load competitor gap data (Module 5) ===
  const competitorGapMap = {};
  if (config.competitorAnalysisEnabled) {
    try {
      const { rows: gapRows } = await pool.query(`
        SELECT cs_today.product_code,
          cs_today.merchant_count as current_merchants,
          cs_prev.merchant_count as prev_merchants,
          cs_prev.merchant_count - cs_today.merchant_count as merchants_lost,
          cs_today.best_price, cs_today.our_position
        FROM competitor_snapshots cs_today
        LEFT JOIN competitor_snapshots cs_prev
          ON cs_prev.tenant_id = cs_today.tenant_id
          AND cs_prev.product_code = cs_today.product_code
          AND cs_prev.snapshot_date = cs_today.snapshot_date - 7
        WHERE cs_today.tenant_id = $1
          AND cs_today.snapshot_date = CURRENT_DATE
          AND cs_prev.merchant_count IS NOT NULL
          AND cs_prev.merchant_count - cs_today.merchant_count >= 2
      `, [tenantId]);
      for (const g of gapRows) competitorGapMap[g.product_code] = g;
      if (gapRows.length > 0) console.log(`[FeedEngine] Module 5: ${gapRows.length} products with competitor gaps`);
    } catch (e) { /* table may not exist yet */ }
  }

  // === STEP 0e: Load optimal position data (Module 8) ===
  const positionMap = {};
  if (config.positionAnalysisEnabled) {
    try {
      const { rows: posRows } = await pool.query(`
        SELECT product_code, optimal_position, recommended_price, current_position, potential_savings
        FROM position_performance
        WHERE tenant_id = $1 AND analysis_date = CURRENT_DATE AND optimal_position IS NOT NULL
      `, [tenantId]);
      for (const p of posRows) positionMap[p.product_code] = p;
      if (posRows.length > 0) console.log(`[FeedEngine] Module 8: ${posRows.length} products with position recommendations`);
    } catch (e) { /* table may not exist yet */ }
  }

  // === STEP 1: Get products with clicks in last 14 days (the real data) ===
  const { rows: clickProducts } = await pool.query(`
    SELECT
      zc.product_code as sku,
      SUM(zc.clicks) as clicks_14d,
      COUNT(DISTINCT zc.fetch_date) as days_active,
      p.product_name, p.sell_price, p.erp_cost, p.margin, p.margin_pct,
      p.erp_stock, p.supplier_stock, p.is_civetta, p.brand, p.category,
      p.sales_30d_seller, p.sales_30d_aggregated,
      ph.ga4_tp_purchases, ph.ga4_tp_revenue, ph.ga4_assisted_sales, ph.ga4_assisted_revenue,
      ph.ga4_total_tp_value, ph.health_score, ph.data_confidence, ph.classification,
      ph.tp_attributed_orders, ph.tp_attributed_revenue, ph.tp_cost_incidence,
      ph.scraper_position, ph.scraper_competitor_count, ph.scraper_best_price,
      ph.mc_benchmark_price, ph.mc_suggested_price, ph.mc_click_potential,
      ph.mc_predicted_clicks_change, ph.seasonal_score, ph.is_seasonal,
      ph.efficiency_score, ph.competitive_score, ph.growth_score
    FROM zombie_clicks zc
    JOIN products p ON p.sku = zc.product_code AND p.tenant_id = zc.tenant_id
    LEFT JOIN product_health_scores ph ON ph.sku = zc.product_code AND ph.tenant_id = zc.tenant_id
    WHERE zc.tenant_id = $1
      AND zc.fetch_date >= CURRENT_DATE - 14
    GROUP BY zc.product_code, p.product_name, p.sell_price, p.erp_cost, p.margin, p.margin_pct,
             p.erp_stock, p.supplier_stock, p.is_civetta, p.brand, p.category,
             p.sales_30d_seller, p.sales_30d_aggregated,
             ph.ga4_tp_purchases, ph.ga4_tp_revenue, ph.ga4_assisted_sales, ph.ga4_assisted_revenue,
             ph.ga4_total_tp_value, ph.health_score, ph.data_confidence, ph.classification,
             ph.tp_attributed_orders, ph.tp_attributed_revenue, ph.tp_cost_incidence,
             ph.scraper_position, ph.scraper_competitor_count, ph.scraper_best_price,
             ph.mc_benchmark_price, ph.mc_suggested_price, ph.mc_click_potential,
             ph.mc_predicted_clicks_change, ph.seasonal_score, ph.is_seasonal,
             ph.efficiency_score, ph.competitive_score, ph.growth_score
    ORDER BY SUM(zc.clicks) DESC
  `, [tenantId]);

  console.log(`[FeedEngine] ${clickProducts.length} products with clicks in 14d`);

  // === STEP 2: Load competitor data for products with clicks ===
  const skusWithClicks = clickProducts.map(p => p.sku);
  const competitorMap = {};
  if (skusWithClicks.length > 0) {
    const { rows: comps } = await pool.query(`
      SELECT product_code, merchant, position, base_price, shipping_cost, total_price, reviews
      FROM scraper_competitors
      WHERE product_code = ANY($1) AND updated_at > NOW() - INTERVAL '48 hours'
      ORDER BY product_code, position ASC
    `, [skusWithClicks]);
    for (const c of comps) {
      if (!competitorMap[c.product_code]) competitorMap[c.product_code] = [];
      competitorMap[c.product_code].push(c);
    }
  }

  // Load quarantine
  const { rows: quarantined } = await pool.query(
    `SELECT sku FROM feed_quarantine WHERE tenant_id = $1 AND reactivated = false`,
    [tenantId]
  );
  const quarantineSet = new Set(quarantined.map(q => q.sku));

  // Load killer list (from feedDailyEngine's detectKillers)
  const { rows: killerRows } = await pool.query(
    `SELECT sku FROM feed_killers WHERE tenant_id = $1 AND is_active = true`,
    [tenantId]
  );
  const killerSet = new Set(killerRows.map(k => k.sku));

  const bigPlayerSet = new Set(config.bigPlayerMerchants.map(n => n.toLowerCase()));

  // === STEP 2b: Load cross-tenant pricing map for PRICE_CUT refinement ===
  // Per ogni SKU, sappiamo i prezzi negli altri tenant. Usato per allineare i price_cut
  // al miglior prezzo praticato internamente, sempre rispettando il margin floor.
  // Carichiamo anche i seller_name dei nostri tenant per evitare guerra interna:
  // se il min cross-tenant e' gia' sotto il min external scraper, NON tagliamo.
  let crossTenantPriceMap = new Map();
  let ourSellerNames = new Set();
  try {
    crossTenantPriceMap = await loadCrossTenantPriceMap();
    console.log(`[FeedEngine] Cross-tenant pricing: ${crossTenantPriceMap.size} SKU con almeno 2 tenant`);
    const { rows: sellers } = await pool.query(
      `SELECT config_value FROM tenant_configs tc
       JOIN tenants t ON t.id = tc.tenant_id
       WHERE tc.config_key = 'trovaprezzi_seller_name' AND t.status = 'active'`
    );
    for (const r of sellers) {
      try {
        // seller name e' criptato → decifra
        const { decrypt } = require('./crypto');
        const name = decrypt(r.config_value);
        if (name) ourSellerNames.add(name.toLowerCase().trim());
      } catch {
        // se non decriptabile, prova come testo plain
        if (r.config_value) ourSellerNames.add(String(r.config_value).toLowerCase().trim());
      }
    }
    console.log(`[FeedEngine] Network sellers (per anti-internal-war): ${ourSellerNames.size}`);
  } catch (xtErr) {
    console.warn('[FeedEngine] Cross-tenant pricing load failed (continuing senza):', xtErr.message);
  }

  // Helper: rifinisce un cutResult considerando il min cross-tenant, il min external
  // (= competitor TP fuori dalla nostra rete) e il margin floor cliente.
  //
  // SAFETY ANTI-INTERNAL-WAR:
  // - Se il min cross-tenant e' GIA' sotto il min external (= un nostro tenant e' piu'
  //   aggressivo del mercato), NON tagliamo: cannibalizzeremmo il nostro network.
  // - Recommended price = max(crossTenantMin, externalMin), entro il floor di margine.
  function refineCutWithCrossTenant(p, cutResult) {
    if (!cutResult || !cutResult.feasible) return cutResult;
    const xt = crossTenantPriceMap.get(p.sku);
    if (!xt) return cutResult;
    const otherEntries = xt.entries.filter(e => e.tenant_id !== tenantId);
    if (otherEntries.length === 0) return cutResult;
    const otherMin = Math.min(...otherEntries.map(e => e.sell_price));
    const currentNew = parseFloat(cutResult.newPrice);
    const currentSell = parseFloat(p.sell_price) || 0;
    const erpCost = parseFloat(p.erp_cost) || 0;
    const floor = marginFloor(currentSell, erpCost);

    // Calcola min external (competitor TP esterno alla nostra rete)
    const competitors = competitorMap[p.sku] || [];
    const externalCompetitors = competitors.filter(c => {
      const m = (c.merchant || '').toLowerCase().trim();
      return m && !ourSellerNames.has(m);
    });
    const externalMin = externalCompetitors.length > 0
      ? Math.min(...externalCompetitors.map(c => parseFloat(c.total_price) || parseFloat(c.base_price) || Infinity).filter(v => v > 0 && v < Infinity))
      : null;

    // SAFETY: se il min cross-tenant e' SOTTO il min external, e' una guerra interna
    if (externalMin != null && otherMin < externalMin) {
      return {
        ...cutResult,
        crossTenantMin: otherMin,
        externalMin,
        crossTenantOthers: otherEntries.length,
        crossTenantNote: 'avoided_internal_war',
      };
    }

    // Floor competitivo = max(crossTenantMin, externalMin) — non scendere sotto il prezzo
    // del competitor esterno (= no senso) ma allinea al cross-tenant se piu' alto
    const competitiveFloor = externalMin != null ? Math.max(otherMin, externalMin) : otherMin;
    if (competitiveFloor >= currentNew) {
      return { ...cutResult, crossTenantMin: otherMin, externalMin, crossTenantOthers: otherEntries.length };
    }

    // Applica margin floor
    let target = competitiveFloor;
    let limitedByFloor = false;
    if (floor != null && target < floor) {
      target = floor;
      limitedByFloor = true;
    }
    target = +target.toFixed(2);
    if (target >= currentNew) return { ...cutResult, crossTenantMin: otherMin, externalMin, crossTenantOthers: otherEntries.length, crossTenantNote: 'floor_blocked' };
    if (target >= currentSell) return cutResult;
    const newCutPct = +(((currentSell - target) / currentSell) * 100).toFixed(1);
    return {
      feasible: true,
      newPrice: target,
      cutPct: newCutPct,
      newMarkupPct: erpCost > 0 ? +(((target - erpCost) / target) * 100).toFixed(2) : null,
      reason: externalMin != null
        ? `Cross-tenant €${otherMin.toFixed(2)} + external €${externalMin.toFixed(2)} = target €${target.toFixed(2)}${limitedByFloor ? ' (floor)' : ''}`
        : `Cross-tenant €${otherMin.toFixed(2)} (no external data)${limitedByFloor ? ' (floor)' : ''}`,
      crossTenantMin: otherMin,
      externalMin,
      crossTenantOthers: otherEntries.length,
      crossTenantApplied: true,
      cutLimitedByFloor: limitedByFloor,
    };
  }

  // === STEP 3: Evaluate each product with clicks ===
  const actions = [];
  const stats = { REMOVE: 0, ADD: 0, PRICE_CUT: 0, KEEP: 0, MONITOR: 0, RATE_LIMITED: 0, CROSS_TENANT_REFINED: 0,
    STAR_PROTECTED: 0, MARGIN_QUARANTINED: 0 };
  let totalCurrentCost = 0;
  let totalCurrentRevenue = 0;
  let savingsFromRemovals = 0;

  // === SKU margins overlay ===
  // Star SKUs (margine netto positivo confermato vs baseline pre-xHumanPro) → protetti dai REMOVE.
  // Loser/Burner SKUs (margine netto negativo o click 0-orders) → candidati a quarantena ausiliaria
  // con reason="negative_margin" SE non già in quarantena per altri motivi.
  //
  // KILL-SWITCH per tenant: se tenant_configs.skumargins_overlay_disabled='true', l'overlay
  // viene saltato. Usato quando l'overlay è troppo aggressivo e si vuole tornare al solo
  // feedEngine standard (es. tenant in mode "vendere a tutti i costi", no over-pruning).
  const starSet = new Set();
  const marginCandidates = []; // { sku, verdict, net30d }
  const { rows: overlayCfg } = await pool.query(
    `SELECT config_value FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'skumargins_overlay_disabled'`,
    [tenantId]
  );
  const overlayDisabled = overlayCfg[0]?.config_value === 'true';
  if (overlayDisabled) {
    console.log(`[FeedEngine] SkuMargins overlay DISABLED for tenant ${tenantId} (kill-switch)`);
  } else {
    try {
      const { classifySkus } = require('./skuMargins');
      const cls = await classifySkus(tenantId);
      for (const s of cls.skus) {
        if (s.verdict === 'star') starSet.add(s.sku);
        else if ((s.verdict === 'loser' || s.verdict === 'burner') && !quarantineSet.has(s.sku)) {
          marginCandidates.push({ sku: s.sku, verdict: s.verdict, net30d: s.windows?.d30?.net ?? null });
        }
      }
      console.log(`[FeedEngine] SkuMargins overlay: ${starSet.size} star (protected), ${marginCandidates.length} margin candidates`);
    } catch (smErr) {
      console.error('[FeedEngine] SkuMargins overlay error (continuing):', smErr.message);
    }
  }

  // Rate limit REMOVE per run: max N% del catalogo attivo, con floor assoluto.
  const maxRemoveAllowed = Math.max(
    config.maxRemoveAbsoluteFloor,
    Math.floor(clickProducts.length * config.maxRemovePctPerRun / 100)
  );
  const canRemoveSku = () => stats.REMOVE < maxRemoveAllowed;
  console.log(`[FeedEngine] Rate limit: max ${maxRemoveAllowed} REMOVE per run (${config.maxRemovePctPerRun}% di ${clickProducts.length} prodotti attivi, floor ${config.maxRemoveAbsoluteFloor})`);

  // === PRE-STEP: Release quarantined products that now have TP orders ===
  // These were quarantined before the conversion safety gate existed
  let quarantineReleased = 0;
  for (const p of clickProducts) {
    if (!quarantineSet.has(p.sku)) continue;
    const tpOrd = parseInt(p.tp_attributed_orders) || 0;
    if (tpOrd > 0) {
      // Product has orders — release from quarantine
      await pool.query(`
        UPDATE feed_quarantine SET reactivated = true, reactivated_at = NOW()
        WHERE tenant_id = $1 AND sku = $2 AND reactivated = false
      `, [tenantId, p.sku]);
      quarantineSet.delete(p.sku);
      quarantineReleased++;
    }
  }
  if (quarantineReleased > 0) {
    console.log(`[FeedEngine] Released ${quarantineReleased} quarantined products with TP orders`);
  }

  for (const p of clickProducts) {
    if (quarantineSet.has(p.sku)) continue;

    const clicks = parseInt(p.clicks_14d) || 0;
    const margin = parseFloat(p.margin) || 0;
    const sellPrice = parseFloat(p.sell_price) || 0;
    const erpStock = parseInt(p.erp_stock) || 0;
    const supplierStock = parseInt(p.supplier_stock) || 0;
    const isCivetta = p.is_civetta;
    const costSpent = clicks * config.cpc;
    const maxBudget = calculateMaxClickBudget(margin, config.marginBrackets, config.cpc);
    const budgetPct = maxBudget > 0 ? (costSpent / maxBudget) * 100 : 9999;

    // GA4 conversions for this product
    const directPurchases = parseInt(p.ga4_tp_purchases) || 0;
    const directRevenue = parseFloat(p.ga4_tp_revenue) || 0;
    const assistedSales = parseInt(p.ga4_assisted_sales) || 0;
    const assistedRevenue = parseFloat(p.ga4_assisted_revenue) || 0;

    // TP-attributed conversions from health scores (30-day Magento orders)
    const tpOrders = parseInt(p.tp_attributed_orders) || 0;
    const tpRevenue = parseFloat(p.tp_attributed_revenue) || 0;
    const tpIncidence = parseFloat(p.tp_cost_incidence) || 0;

    // Unified conversion check: GA4 OR Magento attribution
    const hasConversions = directPurchases > 0 || assistedSales > 0 || tpOrders > 0;
    // Safety gate: can this product be removed?
    const safetyGate = canRemoveProduct(tpOrders, tpRevenue, tpIncidence);
    let removable = safetyGate.removable;
    // Star SKU protection: even if borderline on click safety, never remove proven margin generators.
    if (starSet.has(p.sku) && removable) {
      removable = false;
      safetyGate.reason = 'STAR_PROTECTED: margine netto positivo confermato vs baseline pre-xHumanPro';
      stats.STAR_PROTECTED++;
    }
    const isKiller = killerSet.has(p.sku);

    totalCurrentCost += costSpent;
    // Revenue: use best available source — TP-attributed (Magento) or GA4
    totalCurrentRevenue += Math.max(tpRevenue, directRevenue + assistedRevenue);

    // Competitor analysis
    const competitors = competitorMap[p.sku] || [];
    const position = parseInt(p.scraper_position) || null;
    let aboveBigPlayers = 0;
    for (const comp of competitors) {
      if (comp.position < (position || 999)) {
        if (bigPlayerSet.has((comp.merchant || '').toLowerCase()) || (parseInt(comp.reviews) || 0) >= 500) {
          aboveBigPlayers++;
        }
      }
    }

    let action, reason, recommendedPrice = null, priceCutPct = 0;

    // === GATE 1: Stock ===
    if (erpStock === 0 && supplierStock === 0 && isCivetta) {
      if (removable && canRemoveSku()) {
        action = 'REMOVE';
        reason = `STOCK ZERO: ${clicks} click in 14gg, €${costSpent.toFixed(2)} sprecati`;
        await quarantineSku(tenantId, p.sku, 'zero_stock', config.quarantineDaysStock);
        savingsFromRemovals += costSpent;
        stats.REMOVE++;
      } else if (removable) {
        action = 'MONITOR';
        reason = `RATE LIMIT (${stats.REMOVE}/${maxRemoveAllowed}): STOCK ZERO ma cap REMOVE raggiunto, rinviato`;
        stats.MONITOR++;
        stats.RATE_LIMITED++;
      } else {
        action = 'MONITOR';
        reason = `STOCK ZERO ma ${tpOrders} ordini TP (€${tpRevenue.toFixed(2)} rev, incid. ${(tpIncidence*100).toFixed(1)}%) — verificare stock`;
        stats.MONITOR++;
      }
      actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
      continue;
    }

    // === GATE 2: Seasonality ===
    if (p.is_seasonal && parseFloat(p.seasonal_score) < 40 && isCivetta) {
      if (!removable) {
        // Converts despite off-season → keep monitoring
        action = 'MONITOR';
        reason = `FUORI STAGIONE ma ${tpOrders} ordini TP, incid. ${(tpIncidence*100).toFixed(1)}% — domanda anomala, monitorare`;
        stats.MONITOR++;
        actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
        continue;
      }
      if (canRemoveSku()) {
        action = 'REMOVE';
        reason = `FUORI STAGIONE: ${clicks} click, €${costSpent.toFixed(2)} sprecati`;
        await quarantineSku(tenantId, p.sku, 'off_season', 14);
        savingsFromRemovals += costSpent;
        stats.REMOVE++;
      } else {
        action = 'MONITOR';
        reason = `RATE LIMIT (${stats.REMOVE}/${maxRemoveAllowed}): FUORI STAGIONE ma cap REMOVE raggiunto, rinviato`;
        stats.MONITOR++;
        stats.RATE_LIMITED++;
      }
      actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
      continue;
    }

    // === GATE CAT: Category Rules (Module 1) ===
    if (config.categoryRulesEnabled) {
      const tpCat = tpCategoryMap[p.sku];
      if (tpCat && config.categoryRules[tpCat]) {
        const catRule = config.categoryRules[tpCat];
        // Check indirect value: GA4 assisted sales protect from removal
        const hasIndirectValue = (parseInt(p.ga4_assisted_sales) || 0) > 0;

        // Category disabled entirely
        if (catRule.enabled === false) {
          if (removable && !hasIndirectValue && canRemoveSku()) {
            action = 'REMOVE';
            reason = `CATEGORIA ESCLUSA: "${tpCat}"`;
            await quarantineSku(tenantId, p.sku, 'category_excluded', config.quarantineQ1Days);
            savingsFromRemovals += costSpent;
            stats.REMOVE++;
            actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
            continue;
          } else if (removable && !hasIndirectValue) {
            action = 'MONITOR';
            reason = `RATE LIMIT (${stats.REMOVE}/${maxRemoveAllowed}): CATEGORIA ESCLUSA "${tpCat}" rinviata`;
            stats.MONITOR++;
            stats.RATE_LIMITED++;
            actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
            continue;
          } else if (hasIndirectValue) {
            action = 'MONITOR';
            reason = `CATEGORIA ESCLUSA ma ${p.ga4_assisted_sales} vendite indirette — monitorare`;
            stats.MONITOR++;
            actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
            continue;
          }
        }
        // Category incidence limit — skip if product has indirect value
        if (catRule.max_incidence && tpIncidence > 0 && (tpIncidence * 100) > catRule.max_incidence && removable && !hasIndirectValue) {
          if (canRemoveSku()) {
            action = 'REMOVE';
            reason = `INCIDENZA CATEGORIA: ${(tpIncidence*100).toFixed(1)}% > max ${catRule.max_incidence}% per "${tpCat}"`;
            await quarantineSku(tenantId, p.sku, 'category_incidence', config.quarantineQ1Days);
            savingsFromRemovals += costSpent;
            stats.REMOVE++;
          } else {
            action = 'MONITOR';
            reason = `RATE LIMIT (${stats.REMOVE}/${maxRemoveAllowed}): INCIDENZA CATEGORIA "${tpCat}" rinviata`;
            stats.MONITOR++;
            stats.RATE_LIMITED++;
          }
          actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
          continue;
        }
        // Category min margin
        if (catRule.min_margin && parseFloat(p.margin_pct || 0) < catRule.min_margin && removable) {
          if (canRemoveSku()) {
            action = 'REMOVE';
            reason = `MARGINE CATEGORIA: ${p.margin_pct || 0}% < min ${catRule.min_margin}% per "${tpCat}"`;
            await quarantineSku(tenantId, p.sku, 'category_margin', config.quarantineQ1Days);
            savingsFromRemovals += costSpent;
            stats.REMOVE++;
          } else {
            action = 'MONITOR';
            reason = `RATE LIMIT (${stats.REMOVE}/${maxRemoveAllowed}): MARGINE CATEGORIA "${tpCat}" rinviato`;
            stats.MONITOR++;
            stats.RATE_LIMITED++;
          }
          actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
          continue;
        }
      }
    }

    // === GATE Q1: Low-click quarantine (1-2 click/14d, 0 vendite, pos>4, 0 domanda) ===
    // Note: applies to ALL products with clicks (not just civetta=1 in DB, since DB may be stale)
    //
    // Cross-tenant boost: if this product is flagged cross_quarantine (1-2 click in ALL tenants,
    // zero orders everywhere, zero demand signals), skip the position/seasonal/MC checks and
    // go straight to quarantine. The cross-tenant evidence is sufficient.
    const isCrossQuarantine = crossQuarantineSet.has(p.sku);
    const isUniversalStar = universalStarSet.has(p.sku);

    if (!hasConversions && clicks <= 2 && clicks >= 1 && !isUniversalStar && canQuarantine) {
      const noStoreSales = (parseInt(p.sales_30d_seller) || 0) === 0;
      const noGlobalDemand = (parseInt(p.sales_30d_aggregated) || 0) <= 1;
      const badPosition = !position || position > 4;
      const noSeasonalInterest = !(p.is_seasonal && parseFloat(p.seasonal_score) >= 60);
      const noMCPotential = p.mc_click_potential !== 'HIGH';

      // Standard Q1: all per-tenant conditions must be true
      const standardQ1 = noStoreSales && noGlobalDemand && badPosition && noSeasonalInterest && noMCPotential;
      // Cross-tenant Q1: only need zero local signals + cross-tenant evidence
      const crossQ1 = isCrossQuarantine && noStoreSales && noGlobalDemand;

      if (standardQ1 || crossQ1) {
        if (canRemoveSku()) {
          action = 'REMOVE';
          const quarantineReason = crossQ1 && !standardQ1 ? 'cross_tenant_quarantine' : 'low_click_no_conversion';
          const level = await quarantineSku(tenantId, p.sku, quarantineReason, config.quarantineQ1Days);
          reason = crossQ1 && !standardQ1
            ? `QUARANTENA CROSS-TENANT Q${level}: ${clicks} click qui, 0 ordini in TUTTI i tenant, 0 segnali domanda`
            : `QUARANTENA Q${level}: ${clicks} click, 0 vendite (seller/TP/globale), pos ${position || '?'}. No interesse stagionale, no domanda`;
          savingsFromRemovals += costSpent;
          stats.REMOVE++;
        } else {
          action = 'MONITOR';
          reason = `RATE LIMIT (${stats.REMOVE}/${maxRemoveAllowed}): QUARANTENA Q1 (${clicks} click, 0 vendite) rinviata al prossimo run`;
          stats.MONITOR++;
          stats.RATE_LIMITED++;
        }
        actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
        continue;
      }
    }

    // === GATE KILLER: Products flagged as killer by feedDailyEngine ===
    if (isKiller && isCivetta && canQuarantine) {
      if (removable && canRemoveSku()) {
        action = 'REMOVE';
        reason = `KILLER: ${removable && tpOrders > 0 ? `${tpOrders} ordini ma incidenza ${(tpIncidence*100).toFixed(0)}% troppo alta` : '0 vendite globali'}, click a vuoto`;
        await quarantineSku(tenantId, p.sku, 'killer', 30);
        savingsFromRemovals += costSpent;
        stats.REMOVE++;
      } else if (removable) {
        action = 'MONITOR';
        reason = `RATE LIMIT (${stats.REMOVE}/${maxRemoveAllowed}): KILLER rinviato al prossimo run`;
        stats.MONITOR++;
        stats.RATE_LIMITED++;
      } else if (safetyGate.action === 'price_cut') {
        // Has orders but incidence 15-30% → try price cut
        const cutResult = refineCutWithCrossTenant(p, calculateCompetitivePriceCut(p)); if (cutResult?.crossTenantApplied) stats.CROSS_TENANT_REFINED++;
        if (cutResult && cutResult.feasible) {
          action = 'PRICE_CUT';
          recommendedPrice = cutResult.newPrice;
          priceCutPct = cutResult.cutPct;
          reason = `KILLER con ${tpOrders} ordini TP, incidenza ${(tpIncidence*100).toFixed(0)}%. ${cutResult.reason}`;
          stats.PRICE_CUT++;
        } else {
          action = 'MONITOR';
          reason = `KILLER con ${tpOrders} ordini TP, incidenza ${(tpIncidence*100).toFixed(0)}% — price cut non fattibile, monitorare`;
          stats.MONITOR++;
        }
      } else {
        // Protected: incidence < 15%, keep
        action = 'KEEP';
        reason = `KILLER ma ${tpOrders} ordini TP (€${tpRevenue.toFixed(2)} rev, incid. ${(tpIncidence*100).toFixed(1)}%) — protetto`;
        stats.KEEP++;
      }
      actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
      continue;
    }

    // === VALUTAZIONE 1: Budget vs Conversioni ===
    // Note: applies to all products with clicks (if they get clicks, they're in the feed regardless of DB flag)
    // Universal stars get protection: PRICE_CUT instead of REMOVE when budget is burned
    // Quarantine threshold: 170% del budget per-prodotto (= 1.7x margine_eur), per dare margine di test
    // prima di rimuovere. Il check parte da clicks >= 1 per non far sfuggire prodotti a basso margine.
    if (!hasConversions && clicks >= 1 && canQuarantine) {
      // No conversions at all — evaluate budget
      if (budgetPct >= 170) {
        if (isUniversalStar) {
          // Universal star: don't remove, try price cut — it converts in other tenants
          const cutResult = refineCutWithCrossTenant(p, calculateCompetitivePriceCut(p)); if (cutResult?.crossTenantApplied) stats.CROSS_TENANT_REFINED++;
          if (cutResult && cutResult.feasible) {
            action = 'PRICE_CUT';
            recommendedPrice = cutResult.newPrice;
            priceCutPct = cutResult.cutPct;
            reason = `UNIVERSAL STAR protetto: budget ${Math.round(budgetPct)}% ma converte in altri tenant. ${cutResult.reason}`;
            stats.PRICE_CUT++;
          } else {
            action = 'MONITOR';
            reason = `UNIVERSAL STAR protetto: budget ${Math.round(budgetPct)}%, 0 conversioni qui ma converte in altri tenant. Price cut non fattibile`;
            stats.MONITOR++;
          }
        } else if (canRemoveSku()) {
          // Budget bruciato oltre il 170% del margine — rimuove
          action = 'REMOVE';
          reason = `BUDGET BRUCIATO: ${clicks} click (${Math.round(budgetPct)}% budget, soglia 170%), €${costSpent.toFixed(2)} spesi, ZERO conversioni. Margine €${margin.toFixed(2)}, max ${Math.round(maxBudget / config.cpc)} click`;
          await quarantineSku(tenantId, p.sku, 'budget_burned', config.quarantineDaysBudget);
          savingsFromRemovals += costSpent;
          stats.REMOVE++;
        } else {
          action = 'MONITOR';
          reason = `RATE LIMIT (${stats.REMOVE}/${maxRemoveAllowed}): BUDGET BRUCIATO ${Math.round(budgetPct)}% rinviato al prossimo run`;
          stats.MONITOR++;
          stats.RATE_LIMITED++;
        }
      } else if (budgetPct >= 100) {
        action = 'MONITOR';
        reason = `IN TOLLERANZA: ${clicks} click (${Math.round(budgetPct)}% budget, sotto soglia 170%), €${costSpent.toFixed(2)} spesi, 0 conversioni — ultima finestra di test`;
        stats.MONITOR++;
      } else if (budgetPct >= 70) {
        action = 'MONITOR';
        reason = `ATTENZIONE: ${clicks} click (${Math.round(budgetPct)}% budget), €${costSpent.toFixed(2)} spesi, 0 conversioni`;
        stats.MONITOR++;
      } else {
        action = 'MONITOR';
        reason = `${clicks} click (${Math.round(budgetPct)}% budget), 0 conversioni — in osservazione`;
        stats.MONITOR++;
      }
      actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
      continue;
    }

    // === VALUTAZIONE 2: Prodotti che convertono — ottimizzare posizione ===
    if (isCivetta && hasConversions) {
      const incidence = directRevenue > 0 ? costSpent / directRevenue : 999;

      // Module 8: Check optimal position before deciding
      const optimalPos = config.positionAnalysisEnabled ? positionMap[p.sku] : null;

      if (incidence <= 0.05) {
        // Star: ottimo ROI
        if (optimalPos && position && position < optimalPos.optimal_position) {
          // Already above optimal position — could relax price and save margin
          action = 'KEEP';
          reason = `STAR: pos ${position} (ottimale: ${optimalPos.optimal_position}). ${clicks} click, ${directPurchases} vendite, incid. ${(incidence * 100).toFixed(1)}%. Margine recuperabile`;
        } else {
          action = 'KEEP';
          reason = `STAR: ${clicks} click, ${directPurchases} vendite, €${directRevenue.toFixed(2)} rev, incidenza ${(incidence * 100).toFixed(1)}%`;
        }
        stats.KEEP++;
      } else if (incidence <= 0.12) {
        // Ok ma potrebbe migliorare con price cut
        if (optimalPos && position && position <= optimalPos.optimal_position) {
          // Already at or better than optimal — don't cut further
          action = 'KEEP';
          reason = `POSIZIONE OTTIMALE: pos ${position} <= ottimale ${optimalPos.optimal_position}, incid. ${(incidence * 100).toFixed(1)}%`;
          stats.KEEP++;
        } else if (position && position > 5) {
          const cutResult = calculatePriceCut(p, config, { above_big_players: aboveBigPlayers });
          if (cutResult && cutResult.feasible) {
            action = 'PRICE_CUT';
            recommendedPrice = cutResult.newPrice;
            priceCutPct = cutResult.cutPct;
            reason = `OTTIMIZZA: pos ${position}, incid. ${(incidence * 100).toFixed(1)}%. Taglio a €${cutResult.newPrice} per migliorare posizione`;
            stats.PRICE_CUT++;
          } else {
            action = 'KEEP';
            reason = `OK: ${clicks} click, ${directPurchases} vendite, incidenza ${(incidence * 100).toFixed(1)}%`;
            stats.KEEP++;
          }
        } else {
          action = 'KEEP';
          reason = `OK: pos ${position || '?'}, ${directPurchases} vendite, incidenza ${(incidence * 100).toFixed(1)}%`;
          stats.KEEP++;
        }
      } else {
        // Alta incidenza — converte ma costa troppo
        const cutResult = calculatePriceCut(p, config, { above_big_players: aboveBigPlayers });
        if (cutResult && cutResult.feasible) {
          action = 'PRICE_CUT';
          recommendedPrice = cutResult.newPrice;
          priceCutPct = cutResult.cutPct;
          reason = `INCIDENZA ALTA ${(incidence * 100).toFixed(1)}%: ${clicks} click per ${directPurchases} vendite. Taglio a €${cutResult.newPrice}`;
          stats.PRICE_CUT++;
        } else {
          action = 'MONITOR';
          reason = `INCIDENZA ALTA ${(incidence * 100).toFixed(1)}%: ${clicks} click per solo ${directPurchases} vendite`;
          stats.MONITOR++;
        }
      }
      actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
      continue;
    }

    // === Prodotto civetta con pochi click (<=3), nessuna conversione ===
    if (isCivetta && !hasConversions && clicks <= 3) {
      action = 'KEEP';
      reason = `${clicks} click in 14gg — troppo presto per decidere`;
      stats.KEEP++;
      actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
      continue;
    }

    // === Prodotto NON civetta con click (strano, non dovrebbe avere click) ===
    action = 'MONITOR';
    reason = `Non civetta ma ha ${clicks} click — verificare`;
    stats.MONITOR++;
    actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
  }

  // === STEP 4: Find pepite ===
  // Opportunità vere:
  //   A) Salva Bilancio (civetta=0): prodotti esclusi dal feed ma potenzialmente competitivi con taglio prezzo
  //   B) Ricarico con posizione > 4: prodotti nel feed ma mal posizionati, migliorabili con taglio prezzo
  //   C) Non-civetta con domanda reale (vendite, GA4, MC HIGH) — ma ESCLUDI regola Sconto (prezzo imposto)
  //
  // NOTA: prodotti con regola Sconto (rule_type = 'sconto') hanno prezzo imposto → non toccare

  // Load price rule types
  const { rows: ruleRows } = await pool.query(
    `SELECT rule_id, rule_type, rule_name FROM price_rules WHERE tenant_id = $1`,
    [tenantId]
  );
  const ruleTypeMap = {};
  for (const r of ruleRows) ruleTypeMap[r.rule_id] = r.rule_type;

  // A) Salva Bilancio candidates
  const { rows: salvaBilancio } = await pool.query(`
    SELECT p.sku, p.product_name, p.sell_price, p.erp_cost, p.margin, p.brand,
           p.erp_stock, p.supplier_stock, p.sales_30d_seller, p.sales_30d_aggregated,
           p.price_rule_id,
           ph.mc_click_potential, ph.health_score, ph.scraper_position,
           ph.ga4_assisted_sales, ph.ga4_assisted_revenue, ph.scraper_competitor_count
    FROM products p
    LEFT JOIN product_health_scores ph ON ph.sku = p.sku AND ph.tenant_id = p.tenant_id
    JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id AND pr.rule_type = 'salva_bilancio'
    WHERE p.tenant_id = $1
      AND p.is_civetta = false
      AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
      AND COALESCE(p.margin, 0) > 0.5
    ORDER BY ph.health_score DESC NULLS LAST
    LIMIT 200
  `, [tenantId]);

  // B) Non-civetta with demand (exclude Sconto)
  const { rows: demandCandidates } = await pool.query(`
    SELECT p.sku, p.product_name, p.sell_price, p.erp_cost, p.margin, p.brand,
           p.erp_stock, p.supplier_stock, p.sales_30d_seller, p.sales_30d_aggregated,
           p.price_rule_id,
           ph.mc_click_potential, ph.health_score, ph.scraper_position,
           ph.ga4_assisted_sales, ph.ga4_assisted_revenue, ph.scraper_competitor_count
    FROM products p
    LEFT JOIN product_health_scores ph ON ph.sku = p.sku AND ph.tenant_id = p.tenant_id
    LEFT JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = $1
      AND p.is_civetta = false
      AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
      AND COALESCE(p.margin, 0) > 1
      AND COALESCE(pr.rule_type, 'diretto') != 'sconto'
      AND (
        COALESCE(p.sales_30d_aggregated, 0) >= 5
        OR ph.mc_click_potential = 'HIGH'
        OR (COALESCE(p.sales_30d_seller, 0) > 0 AND COALESCE(ph.health_score, 0) >= 50)
      )
    ORDER BY ph.health_score DESC NULLS LAST
    LIMIT 200
  `, [tenantId]);

  // Merge and deduplicate
  const pepiteSeen = new Set(actions.map(a => a.sku));
  const allPepite = [...salvaBilancio, ...demandCandidates];

  for (const p of allPepite) {
    if (pepiteSeen.has(p.sku) || quarantineSet.has(p.sku)) continue;
    pepiteSeen.add(p.sku);

    const ruleType = ruleTypeMap[p.price_rule_id] || 'diretto';

    // Skip Sconto (double check)
    if (ruleType === 'sconto') continue;

    let demandScore = 0;
    const reasons = [];

    // Salva Bilancio bonus: these are specifically excluded by FB, high opportunity
    if (ruleType === 'salva_bilancio') { demandScore += 1.5; reasons.push('Salva Bilancio'); }

    if ((parseInt(p.sales_30d_seller) || 0) > 0) { demandScore += 2; reasons.push(`${p.sales_30d_seller} vendite locali`); }
    if ((parseInt(p.ga4_assisted_sales) || 0) > 0) { demandScore += 1; reasons.push('vendite assistite'); }
    if (p.mc_click_potential === 'HIGH') { demandScore += 1.5; reasons.push('MC HIGH'); }
    if ((parseInt(p.sales_30d_aggregated) || 0) >= 5) { demandScore += 1; reasons.push(`s30g=${p.sales_30d_aggregated}`); }
    if ((parseInt(p.scraper_position) || 99) <= 5) { demandScore += 1; reasons.push(`pos ${p.scraper_position}`); }

    if (demandScore >= 3) {
      // Check if price cut needed to be competitive (uses tier-based min markup)
      let recommendedPrice = null;
      let priceCutPct = 0;
      const _baseCut = calculateCompetitivePriceCut(p) || calculatePriceCut(p, config, { above_big_players: 0 });
      const cutResult = refineCutWithCrossTenant(p, _baseCut);
      if (cutResult?.crossTenantApplied) stats.CROSS_TENANT_REFINED++;
      if (cutResult && cutResult.feasible) {
        recommendedPrice = cutResult.newPrice;
        priceCutPct = cutResult.cutPct;
        reasons.push(`taglio a €${cutResult.newPrice} (${cutResult.reason})`);
      }

      actions.push({
        sku: p.sku,
        action: 'ADD',
        action_reason: `PEPITE [${ruleType}]: score ${demandScore.toFixed(1)} (${reasons.join(', ')})`,
        action_source: 'engine',
        clicks_consumed: 0, cost_consumed: 0, max_click_budget: 0, budget_pct_used: 0,
        has_conversions: false, direct_revenue: 0, indirect_revenue: 0,
        tp_position: parseInt(p.scraper_position) || null,
        competitor_count: parseInt(p.scraper_competitor_count) || 0,
        above_big_players: 0, above_small: 0, shipping_impact: 0, review_count: 0,
        competitive_viable: true,
        current_price: parseFloat(p.sell_price) || 0,
        recommended_price: recommendedPrice, price_cut_pct: priceCutPct,
        erp_cost: parseFloat(p.erp_cost) || 0, cost_source: 'erp',
        new_margin: recommendedPrice ? +(recommendedPrice - (parseFloat(p.erp_cost) || 0)).toFixed(2) : null,
        new_margin_pct: null,
        erp_stock: parseInt(p.erp_stock) || 0,
        supplier_stock: parseInt(p.supplier_stock) || 0,
        is_seasonal: false, season_active: true,
      });
      stats.ADD++;
    }
  }

  // === STEP 4b: Civetta=1 zero click con domanda — proponi taglio prezzo per attivarli ===
  const { rows: zeroClickDemand } = await pool.query(`
    SELECT p.sku, p.product_name, p.sell_price, p.erp_cost, p.margin, p.brand,
           p.erp_stock, p.supplier_stock, p.sales_30d_seller, p.sales_30d_aggregated,
           p.price_rule_id,
           ph.scraper_position, ph.scraper_competitor_count, ph.scraper_best_price,
           ph.mc_click_potential, ph.mc_impressions_14d, ph.health_score
    FROM products p
    LEFT JOIN product_health_scores ph ON ph.sku = p.sku AND ph.tenant_id = p.tenant_id
    LEFT JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = $1
      AND p.is_civetta = true
      AND COALESCE(p.erp_cost, 0) > 0
      AND COALESCE(ph.tp_clicks_30d, 0) = 0
      AND COALESCE(pr.rule_type, 'diretto') != 'sconto'
      AND (
        COALESCE(p.sales_30d_aggregated, 0) >= 5
        OR COALESCE(p.sales_30d_seller, 0) >= 2
        OR COALESCE(ph.mc_impressions_14d, 0) >= 50
      )
    ORDER BY ph.health_score DESC NULLS LAST
    LIMIT 500
  `, [tenantId]);

  let priceCutCount = 0;
  for (const p of zeroClickDemand) {
    if (pepiteSeen.has(p.sku) || quarantineSet.has(p.sku)) continue;
    pepiteSeen.add(p.sku);

    const cutResult = refineCutWithCrossTenant(p, calculateCompetitivePriceCut(p)); if (cutResult?.crossTenantApplied) stats.CROSS_TENANT_REFINED++;
    if (cutResult && cutResult.feasible) {
      actions.push({
        sku: p.sku,
        action: 'PRICE_CUT',
        action_reason: `ZERO CLICK: s_agg=${p.sales_30d_aggregated}, s_sell=${p.sales_30d_seller}. ${cutResult.reason}`,
        action_source: 'engine',
        clicks_consumed: 0, cost_consumed: 0, max_click_budget: 0, budget_pct_used: 0,
        has_conversions: false, direct_revenue: 0, indirect_revenue: 0,
        tp_position: parseInt(p.scraper_position) || null,
        competitor_count: parseInt(p.scraper_competitor_count) || 0,
        above_big_players: 0, above_small: 0, shipping_impact: 0, review_count: 0,
        competitive_viable: true,
        current_price: parseFloat(p.sell_price) || 0,
        recommended_price: cutResult.newPrice, price_cut_pct: cutResult.cutPct,
        erp_cost: parseFloat(p.erp_cost) || 0, cost_source: 'erp',
        new_margin: +(cutResult.newPrice - (parseFloat(p.erp_cost) || 0)).toFixed(2),
        new_margin_pct: cutResult.newMarkupPct || null,
        erp_stock: parseInt(p.erp_stock) || 0,
        supplier_stock: parseInt(p.supplier_stock) || 0,
        is_seasonal: false, season_active: true,
      });
      stats.PRICE_CUT++;
      priceCutCount++;
    }
  }
  if (priceCutCount > 0) console.log(`[FeedEngine] ${priceCutCount} price cuts for zero-click products with demand`);

  // === STEP 4c: Topsearch Recovery ===
  // Products that are star/cash_cow/opportunity, have conversions or high demand,
  // but are priced above competition. These need aggressive price cuts to maintain
  // visibility, especially after losing topsearch premium positioning.
  // EXCLUDES: regola Sconto and Muro (prezzo imposto)
  const { rows: recoveryProducts } = await pool.query(`
    SELECT p.sku, p.product_name, p.sell_price, p.erp_cost, p.margin, p.brand,
           p.erp_stock, p.supplier_stock, p.sales_30d_seller, p.sales_30d_aggregated,
           p.price_rule_id,
           ph.classification, ph.health_score, ph.tp_attributed_orders,
           ph.tp_attributed_revenue, ph.tp_clicks_30d,
           ph.scraper_position, ph.scraper_competitor_count, ph.scraper_best_price,
           ph.mc_click_potential, ph.mc_predicted_clicks_change,
           ph.ga4_assisted_sales, ph.ga4_assisted_revenue
    FROM products p
    JOIN product_health_scores ph ON ph.sku = p.sku AND ph.tenant_id = p.tenant_id
    LEFT JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = $1
      AND ph.classification IN ('star', 'cash_cow', 'opportunity')
      AND COALESCE(p.erp_cost, 0) > 0
      AND ph.scraper_best_price IS NOT NULL
      AND p.sell_price > ph.scraper_best_price
      AND COALESCE(pr.rule_type, 'diretto') NOT IN ('sconto', 'muro')
      AND (
        COALESCE(ph.tp_attributed_orders, 0) > 0
        OR COALESCE(p.sales_30d_aggregated, 0) >= 5
        OR COALESCE(ph.tp_clicks_30d, 0) >= 10
        OR ph.mc_click_potential = 'HIGH'
      )
    ORDER BY ph.health_score DESC NULLS LAST
  `, [tenantId]);

  let recoveryCount = 0;
  for (const p of recoveryProducts) {
    if (pepiteSeen.has(p.sku) || quarantineSet.has(p.sku)) continue;
    pepiteSeen.add(p.sku);

    const cutResult = calculateRecoveryPriceCut(p);
    if (cutResult && cutResult.feasible) {
      actions.push({
        sku: p.sku,
        action: 'PRICE_CUT',
        action_reason: `RECOVERY [${p.classification}]: ordini=${p.tp_attributed_orders || 0}, click=${p.tp_clicks_30d || 0}, s_agg=${p.sales_30d_aggregated || 0}. ${cutResult.reason}`,
        action_source: 'engine_topsearch_recovery',
        clicks_consumed: parseInt(p.tp_clicks_30d) || 0,
        cost_consumed: +((parseInt(p.tp_clicks_30d) || 0) * config.cpc).toFixed(2),
        max_click_budget: 0, budget_pct_used: 0,
        has_conversions: (parseInt(p.tp_attributed_orders) || 0) > 0,
        direct_revenue: parseFloat(p.tp_attributed_revenue) || 0,
        indirect_revenue: parseFloat(p.ga4_assisted_revenue) || 0,
        tp_position: parseInt(p.scraper_position) || null,
        competitor_count: parseInt(p.scraper_competitor_count) || 0,
        above_big_players: 0, above_small: 0, shipping_impact: 0, review_count: 0,
        competitive_viable: true,
        current_price: parseFloat(p.sell_price) || 0,
        recommended_price: cutResult.newPrice, price_cut_pct: cutResult.cutPct,
        erp_cost: parseFloat(p.erp_cost) || 0, cost_source: 'erp',
        new_margin: +(cutResult.newPrice - (parseFloat(p.erp_cost) || 0)).toFixed(2),
        new_margin_pct: cutResult.newMarkupPct || null,
        erp_stock: parseInt(p.erp_stock) || 0,
        supplier_stock: parseInt(p.supplier_stock) || 0,
        is_seasonal: false, season_active: true,
      });
      stats.PRICE_CUT++;
      recoveryCount++;
    }
  }
  if (recoveryCount > 0) console.log(`[FeedEngine] ${recoveryCount} topsearch recovery price cuts`);

  // === STEP 4e: Include quarantined products as REMOVE (Farmabooster needs to know) ===
  const { rows: allQuarantined } = await pool.query(`
    SELECT fq.sku, fq.quarantine_level, fq.reason
    FROM feed_quarantine fq
    WHERE fq.tenant_id = $1 AND fq.reactivated = false
  `, [tenantId]);
  const actionSkus = new Set(actions.map(a => a.sku));
  for (const q of allQuarantined) {
    if (actionSkus.has(q.sku)) continue;
    actions.push({
      sku: q.sku, action: 'REMOVE',
      action_reason: `In quarantena Q${q.quarantine_level}: ${q.reason}`,
      action_source: 'engine',
      clicks_consumed: 0, cost_consumed: 0, max_click_budget: 0, budget_pct_used: 0,
      has_conversions: false, direct_revenue: 0, indirect_revenue: 0,
      tp_position: null, competitor_count: 0, above_big_players: 0, above_small: 0,
      shipping_impact: 0, review_count: 0, competitive_viable: false,
      current_price: 0, recommended_price: null, price_cut_pct: 0,
      erp_cost: 0, cost_source: 'quarantine', new_margin: null, new_margin_pct: null,
      erp_stock: 0, supplier_stock: 0, is_seasonal: false, season_active: true,
    });
    stats.REMOVE++;
  }

  // === STEP 4b: Margin-based quarantine overlay ===
  // SKU classificati loser/burner dal modello skuMargins MA non ancora in quarantena.
  // Li mettiamo in quarantena progressiva (livello 1, 7gg) con reason="negative_margin"
  // affinché vengano riconsiderati alla riattivazione. NON tocchiamo le quarantene esistenti.
  // Rate-limited al 5% del catalogo civetta per non sovraccaricare in un solo run.
  if (marginCandidates.length > 0) {
    const cap = Math.min(marginCandidates.length, Math.max(50, Math.floor(clickProducts.length * 0.05)));
    const picks = marginCandidates
      .filter(c => !starSet.has(c.sku))
      .sort((a, b) => (a.net30d ?? 0) - (b.net30d ?? 0)) // i più negativi prima
      .slice(0, cap);
    for (const c of picks) {
      try {
        await quarantineSku(tenantId, c.sku,
          `negative_margin (${c.verdict}, net 30g €${c.net30d ?? '?'})`, 7);
        stats.MARGIN_QUARANTINED++;
      } catch (qErr) { /* skip on conflict */ }
    }
    console.log(`[FeedEngine] Margin overlay: ${stats.MARGIN_QUARANTINED} SKU added to quarantine (cap ${cap}/${marginCandidates.length})`);
  }

  // === STEP 5: Persist ===
  await persistActions(tenantId, actions);

  // === STEP 5b: Log action to optimization_log ===
  try {
    const { logAction } = require('./optimizationLog');
    await logAction(tenantId, 'feed_engine',
      `Ciclo automatico: ${stats.REMOVE} REMOVE, ${stats.PRICE_CUT} PRICE_CUT, ${stats.KEEP} KEEP, ${stats.ADD} ADD, ${stats.MONITOR} MONITOR`,
      actions.length, [], { stats, savingsFromRemovals });
  } catch (logErr) {
    // Log table may not exist yet
  }

  // === STEP 6: Global prediction ===
  const projectedCost = totalCurrentCost - savingsFromRemovals;
  const projectedRevenue = totalCurrentRevenue; // conservative: same revenue without burners

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[FeedEngine] Completed in ${elapsed}s: ${JSON.stringify(stats)}`);
  console.log(`[FeedEngine] Current: €${totalCurrentCost.toFixed(2)} cost, €${totalCurrentRevenue.toFixed(2)} rev`);
  console.log(`[FeedEngine] Projected: €${projectedCost.toFixed(2)} cost (-€${savingsFromRemovals.toFixed(2)} savings)`);

  // Save global prediction to health_config
  await saveGlobalPrediction(tenantId, {
    currentCost: totalCurrentCost,
    currentRevenue: totalCurrentRevenue,
    projectedCost,
    projectedRevenue,
    savingsFromRemovals,
    removals: stats.REMOVE,
    priceCuts: stats.PRICE_CUT,
    additions: stats.ADD,
  });

  return { stats, totalCurrentCost, totalCurrentRevenue, savingsFromRemovals, totalActions: actions.length };
}

function buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, compCount, aboveBig, recommendedPrice, priceCutPct) {
  return {
    sku: p.sku,
    action,
    action_reason: reason,
    action_source: 'engine',
    clicks_consumed: clicks,
    cost_consumed: +costSpent.toFixed(2),
    max_click_budget: +maxBudget.toFixed(2),
    budget_pct_used: +Math.min(9999, budgetPct).toFixed(1),
    has_conversions: hasConversions,
    direct_revenue: +directRevenue.toFixed(2),
    indirect_revenue: +assistedRevenue.toFixed(2),
    tp_position: position,
    competitor_count: compCount,
    above_big_players: aboveBig,
    above_small: 0,
    shipping_impact: 0,
    review_count: 0,
    competitive_viable: true,
    current_price: parseFloat(p.sell_price) || 0,
    recommended_price: recommendedPrice,
    price_cut_pct: priceCutPct,
    erp_cost: parseFloat(p.erp_cost) || 0,
    cost_source: 'erp',
    new_margin: recommendedPrice ? +(recommendedPrice - (parseFloat(p.erp_cost) || 0)).toFixed(2) : null,
    new_margin_pct: recommendedPrice && parseFloat(p.erp_cost) > 0
      ? +(((recommendedPrice - parseFloat(p.erp_cost)) / recommendedPrice) * 100).toFixed(1)
      : null,
    erp_stock: parseInt(p.erp_stock) || 0,
    supplier_stock: parseInt(p.supplier_stock) || 0,
    is_seasonal: p.is_seasonal || false,
    season_active: parseFloat(p.seasonal_score) >= 50,
  };
}

async function persistActions(tenantId, actions) {
  if (actions.length === 0) return;

  // Archive non-KEEP actions to history
  await pool.query(`
    INSERT INTO feed_action_history (tenant_id, sku, action, action_reason, action_source, recommended_price, health_score, classification)
    SELECT tenant_id, sku, action, action_reason, action_source, recommended_price,
           (SELECT health_score FROM product_health_scores WHERE tenant_id = fa.tenant_id AND sku = fa.sku),
           (SELECT classification FROM product_health_scores WHERE tenant_id = fa.tenant_id AND sku = fa.sku)
    FROM feed_actions fa
    WHERE fa.tenant_id = $1 AND fa.action IN ('REMOVE', 'ADD', 'PRICE_CUT')
  `, [tenantId]);

  // Clear and rewrite
  await pool.query('DELETE FROM feed_actions WHERE tenant_id = $1', [tenantId]);

  const BATCH = 100;
  const COLS = 30;
  for (let i = 0; i < actions.length; i += BATCH) {
    const batch = actions.slice(i, i + BATCH);
    const values = [];
    const placeholders = [];

    for (let j = 0; j < batch.length; j++) {
      const a = batch[j];
      const base = j * COLS;
      const ph = [];
      for (let c = 1; c <= COLS; c++) ph.push(`$${base + c}`);
      placeholders.push(`(${ph.join(',')})`);

      values.push(
        tenantId, a.sku, a.action, a.action_reason, a.action_source,
        a.max_click_budget, a.clicks_consumed, a.cost_consumed, a.budget_pct_used,
        a.has_conversions, a.direct_revenue, a.indirect_revenue,
        a.tp_position, a.competitor_count, a.above_big_players, a.above_small,
        a.shipping_impact, a.review_count, a.competitive_viable,
        a.current_price, a.recommended_price, a.price_cut_pct,
        a.erp_cost, a.cost_source, a.new_margin, a.new_margin_pct,
        a.erp_stock, a.supplier_stock, a.is_seasonal, a.season_active
      );
    }

    await pool.query(`
      INSERT INTO feed_actions (
        tenant_id, sku, action, action_reason, action_source,
        max_click_budget, clicks_consumed, cost_consumed, budget_pct_used,
        has_conversions, direct_revenue, indirect_revenue,
        tp_position, competitor_count, above_big_players, above_small,
        shipping_impact, review_count, competitive_viable,
        current_price, recommended_price, price_cut_pct,
        erp_cost, cost_source, new_margin, new_margin_pct,
        erp_stock, supplier_stock, is_seasonal, season_active
      ) VALUES ${placeholders.join(',')}
      ON CONFLICT (tenant_id, sku) DO UPDATE SET
        action = EXCLUDED.action, action_reason = EXCLUDED.action_reason,
        action_source = EXCLUDED.action_source, computed_at = NOW()
    `, values);
  }
}

/**
 * Progressive quarantine: escalates Q1→Q2→Q3→Q4 based on history
 */
async function quarantineSku(tenantId, sku, reason, fallbackDays) {
  const config = await loadFeedConfig(tenantId);
  const levelDays = {
    1: parseInt(config.quarantineQ1Days || 7),
    2: parseInt(config.quarantineQ2Days || 15),
    3: parseInt(config.quarantineQ3Days || 30),
    4: 3650, // ~10 years = permanent
  };

  // Check quarantine history to determine next level
  const { rows: history } = await pool.query(
    `SELECT quarantine_level FROM feed_quarantine_history
     WHERE tenant_id = $1 AND sku = $2 AND recidivism_detected = true
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, sku]
  );

  // Also check current/previous quarantine record
  const { rows: current } = await pool.query(
    `SELECT quarantine_level, reactivated FROM feed_quarantine
     WHERE tenant_id = $1 AND sku = $2`,
    [tenantId, sku]
  );

  let nextLevel = 1;
  if (history.length > 0) {
    nextLevel = Math.min(history[0].quarantine_level + 1, 4);
  } else if (current.length > 0 && current[0].reactivated) {
    nextLevel = Math.min(current[0].quarantine_level + 1, 4);
  }

  const days = levelDays[nextLevel] || fallbackDays;
  const isPermanent = nextLevel >= 4;

  // Archive current record to history before overwriting
  if (current.length > 0) {
    await pool.query(`
      INSERT INTO feed_quarantine_history
        (tenant_id, sku, quarantine_level, reason, quarantine_start, quarantine_end,
         reactivated_at, observation_start, observation_end, observation_clicks, observation_orders, recidivism_detected)
      SELECT tenant_id, sku, quarantine_level, reason, quarantine_start, quarantine_end,
             reactivated_at, observation_start, observation_end, observation_clicks, observation_orders,
             CASE WHEN reactivated THEN true ELSE false END
      FROM feed_quarantine WHERE tenant_id = $1 AND sku = $2
    `, [tenantId, sku]);
  }

  const end = new Date();
  end.setDate(end.getDate() + days);

  await pool.query(`
    INSERT INTO feed_quarantine (tenant_id, sku, reason, quarantine_level, quarantine_end, is_permanent,
      reactivated, observation_start, observation_end, observation_clicks, observation_orders)
    VALUES ($1, $2, $3, $4, $5, $6, false, NULL, NULL, 0, 0)
    ON CONFLICT (tenant_id, sku) DO UPDATE SET
      reason = $3, quarantine_level = $4, quarantine_end = $5, is_permanent = $6,
      reactivated = false, reactivated_at = NULL, quarantine_start = NOW(),
      observation_start = NULL, observation_end = NULL, observation_clicks = 0, observation_orders = 0,
      manual_override = false
  `, [tenantId, sku, reason, nextLevel, end.toISOString(), isPermanent]);

  return nextLevel;
}

async function saveGlobalPrediction(tenantId, data) {
  const entries = [
    ['feed_current_cost_14d', data.currentCost.toFixed(2)],
    ['feed_current_revenue_14d', data.currentRevenue.toFixed(2)],
    ['feed_projected_cost_14d', data.projectedCost.toFixed(2)],
    ['feed_projected_revenue_14d', data.projectedRevenue.toFixed(2)],
    ['feed_savings_from_removals', data.savingsFromRemovals.toFixed(2)],
    ['feed_action_removals', String(data.removals)],
    ['feed_action_price_cuts', String(data.priceCuts)],
    ['feed_action_additions', String(data.additions)],
    ['feed_last_run', new Date().toISOString()],
  ];
  for (const [key, value] of entries) {
    await pool.query(`
      INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $3, updated_at = NOW()
    `, [tenantId, key, value]);
  }
}

/**
 * Check quarantined products for reactivation (expired quarantine → observation window)
 */
async function checkReactivations(tenantId) {
  const config = await loadFeedConfig(tenantId);
  const observationDays = config.quarantineObservationDays || 3;

  // Phase 1: Expired quarantines (non-permanent) → start observation window
  const { rows: expired } = await pool.query(`
    SELECT fq.id, fq.sku, fq.reason, fq.quarantine_level, fq.is_permanent,
           p.erp_stock, p.supplier_stock, p.sales_30d_seller, p.sales_30d_aggregated,
           ph.ga4_assisted_revenue, ph.ga4_assisted_sales, ph.seasonal_score,
           ph.mc_click_potential, ph.health_score
    FROM feed_quarantine fq
    JOIN products p ON p.tenant_id = fq.tenant_id AND p.sku = fq.sku
    LEFT JOIN product_health_scores ph ON ph.tenant_id = fq.tenant_id AND ph.sku = fq.sku
    WHERE fq.tenant_id = $1
      AND fq.reactivated = false
      AND fq.is_permanent = false
      AND fq.quarantine_end <= NOW()
      AND fq.observation_start IS NULL
  `, [tenantId]);

  let reactivated = 0;
  for (const c of expired) {
    // For stock/season quarantines, check if condition resolved
    if (c.reason === 'zero_stock' && (parseInt(c.erp_stock) || 0) === 0) continue;
    if (c.reason === 'off_season' && parseFloat(c.seasonal_score) < 50) continue;

    // Start observation window
    const obsEnd = new Date();
    obsEnd.setDate(obsEnd.getDate() + observationDays);
    await pool.query(`
      UPDATE feed_quarantine SET
        reactivated = true, reactivated_at = NOW(),
        observation_start = NOW(), observation_end = $3,
        observation_clicks = 0, observation_orders = 0
      WHERE tenant_id = $1 AND sku = $2
    `, [tenantId, c.sku, obsEnd.toISOString()]);
    reactivated++;
  }

  if (reactivated > 0) console.log(`[FeedEngine] Reactivated ${reactivated} products (observation window: ${observationDays}d)`);
  return { checked: expired.length, reactivated };
}

/**
 * Monitor observation windows — detect recidivism or success
 */
async function checkObservationWindows(tenantId) {
  const config = await loadFeedConfig(tenantId);

  // Products in observation that have expired
  const { rows: observed } = await pool.query(`
    SELECT fq.id, fq.sku, fq.quarantine_level, fq.reason,
           fq.observation_start, fq.observation_end
    FROM feed_quarantine fq
    WHERE fq.tenant_id = $1
      AND fq.reactivated = true
      AND fq.observation_end IS NOT NULL
      AND fq.observation_end <= NOW()
  `, [tenantId]);

  let recidivists = 0, successes = 0;

  for (const obs of observed) {
    // Count clicks during observation window
    const { rows: [clickData] } = await pool.query(`
      SELECT COALESCE(SUM(clicks), 0) as clicks
      FROM zombie_clicks
      WHERE tenant_id = $1 AND product_code = $2
        AND fetch_date >= $3::date AND fetch_date <= $4::date
    `, [tenantId, obs.sku, obs.observation_start, obs.observation_end]);

    // Count orders during observation (from GA4 or magento)
    const { rows: [orderData] } = await pool.query(`
      SELECT COUNT(DISTINCT oi.order_id) as orders
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id AND o.tenant_id = $1
      WHERE oi.sku = $2 AND o.order_date >= $3 AND o.order_date <= $4
    `, [tenantId, obs.sku, obs.observation_start, obs.observation_end]);

    const obsClicks = parseInt(clickData.clicks) || 0;
    const obsOrders = parseInt(orderData.orders) || 0;

    // Update observation data
    await pool.query(`
      UPDATE feed_quarantine SET observation_clicks = $3, observation_orders = $4
      WHERE tenant_id = $1 AND sku = $2
    `, [tenantId, obs.sku, obsClicks, obsOrders]);

    if (obsClicks > 0 && obsOrders === 0) {
      // RECIDIVIST: clicks but no orders during observation → escalate
      console.log(`[Quarantine] Recidivist: ${obs.sku} (Q${obs.quarantine_level}) — ${obsClicks} clicks, 0 orders in observation`);
      await quarantineSku(tenantId, obs.sku, obs.reason, config.quarantineQ1Days);
      recidivists++;
    } else {
      // SUCCESS: either no clicks (no cost) or has orders → clear quarantine
      await pool.query(`
        INSERT INTO feed_quarantine_history
          (tenant_id, sku, quarantine_level, reason, quarantine_start, quarantine_end,
           reactivated_at, observation_start, observation_end, observation_clicks, observation_orders, recidivism_detected)
        SELECT tenant_id, sku, quarantine_level, reason, quarantine_start, quarantine_end,
               reactivated_at, observation_start, observation_end, $3, $4, false
        FROM feed_quarantine WHERE tenant_id = $1 AND sku = $2
      `, [tenantId, obs.sku, obsClicks, obsOrders]);

      await pool.query(
        `DELETE FROM feed_quarantine WHERE tenant_id = $1 AND sku = $2`,
        [tenantId, obs.sku]
      );
      successes++;
    }
  }

  if (recidivists > 0 || successes > 0) {
    console.log(`[Quarantine] Observation results: ${successes} cleared, ${recidivists} escalated`);
  }
  return { observed: observed.length, recidivists, successes };
}

module.exports = { computeFeedActions, checkReactivations, checkObservationWindows, loadFeedConfig };
