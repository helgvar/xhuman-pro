/**
 * Feed Decision Engine v2
 *
 * Logica basata su dati reali giornalieri:
 * 1. Prende click giornalieri (zombie_clicks) ultimi 14gg
 * 2. Li incrocia con ordini GA4 per quegli SKU
 * 3. Decide: REMOVE (click senza conversioni), KEEP (converte), PRICE_CUT (converte poco, migliorabile), ADD (pepite), MONITOR
 *
 * La prediction è GLOBALE: "oggi spendi X e incassi Y → con queste azioni arrivi a Z/W"
 */

const { pool } = require('../db/pool');
const { resolveStockAndCost, calculatePriceCut } = require('./feedPriceOptimizer');

const DEFAULT_CPC = 0.3294;

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

  const bigPlayerSet = new Set(config.bigPlayerMerchants.map(n => n.toLowerCase()));

  // === STEP 3: Evaluate each product with clicks ===
  const actions = [];
  const stats = { REMOVE: 0, ADD: 0, PRICE_CUT: 0, KEEP: 0, MONITOR: 0 };
  let totalCurrentCost = 0;
  let totalCurrentRevenue = 0;
  let savingsFromRemovals = 0;

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
    const hasConversions = directPurchases > 0 || assistedSales > 0;

    totalCurrentCost += costSpent;
    totalCurrentRevenue += directRevenue + assistedRevenue;

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
      action = 'REMOVE';
      reason = `STOCK ZERO: ${clicks} click in 14gg, €${costSpent.toFixed(2)} sprecati`;
      await quarantineSku(tenantId, p.sku, 'zero_stock', config.quarantineDaysStock);
      savingsFromRemovals += costSpent;
      stats.REMOVE++;
      actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
      continue;
    }

    // === GATE 2: Seasonality ===
    if (p.is_seasonal && parseFloat(p.seasonal_score) < 40 && isCivetta) {
      action = 'REMOVE';
      reason = `FUORI STAGIONE: ${clicks} click, €${costSpent.toFixed(2)} sprecati`;
      await quarantineSku(tenantId, p.sku, 'off_season', 14);
      savingsFromRemovals += costSpent;
      stats.REMOVE++;
      actions.push(buildAction(p, action, reason, clicks, costSpent, maxBudget, budgetPct, hasConversions, directRevenue, assistedRevenue, position, competitors.length, aboveBigPlayers, recommendedPrice, priceCutPct));
      continue;
    }

    // === VALUTAZIONE 1: Budget vs Conversioni ===
    if (isCivetta && !hasConversions && clicks > 3) {
      // No conversions at all — evaluate budget
      if (budgetPct >= 100) {
        // Budget fully burned
        action = 'REMOVE';
        reason = `BUDGET BRUCIATO: ${clicks} click (${Math.round(budgetPct)}% budget), €${costSpent.toFixed(2)} spesi, ZERO conversioni. Margine €${margin.toFixed(2)}, max ${Math.round(maxBudget / config.cpc)} click`;
        await quarantineSku(tenantId, p.sku, 'budget_burned', config.quarantineDaysBudget);
        savingsFromRemovals += costSpent;
        stats.REMOVE++;
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

      if (incidence <= 0.05) {
        // Star: ottimo ROI
        action = 'KEEP';
        reason = `STAR: ${clicks} click, ${directPurchases} vendite, €${directRevenue.toFixed(2)} rev, incidenza ${(incidence * 100).toFixed(1)}%`;
        stats.KEEP++;
      } else if (incidence <= 0.12) {
        // Ok ma potrebbe migliorare con price cut
        if (position && position > 5) {
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
      // Check if price cut needed to be competitive
      let recommendedPrice = null;
      let priceCutPct = 0;
      const cutResult = calculatePriceCut(p, config, { above_big_players: 0 });
      if (cutResult && cutResult.feasible) {
        recommendedPrice = cutResult.newPrice;
        priceCutPct = cutResult.cutPct;
        reasons.push(`taglio a €${cutResult.newPrice}`);
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

  // === STEP 5: Persist ===
  await persistActions(tenantId, actions);

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

async function quarantineSku(tenantId, sku, reason, days) {
  const end = new Date();
  end.setDate(end.getDate() + days);
  await pool.query(`
    INSERT INTO feed_quarantine (tenant_id, sku, reason, quarantine_end)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, sku) DO UPDATE SET
      reason = $3, quarantine_end = $4, reactivated = false, quarantine_start = NOW()
  `, [tenantId, sku, reason, end.toISOString()]);
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
 * Check quarantined products for reactivation
 */
async function checkReactivations(tenantId) {
  const config = await loadFeedConfig(tenantId);

  const { rows: candidates } = await pool.query(`
    SELECT fq.sku, fq.reason,
           p.erp_stock, p.supplier_stock, p.sales_30d_seller, p.sales_30d_aggregated, p.margin,
           ph.ga4_assisted_revenue, ph.ga4_assisted_sales, ph.seasonal_score,
           ph.scraper_competitor_count, ph.mc_click_potential, ph.health_score
    FROM feed_quarantine fq
    JOIN products p ON p.tenant_id = fq.tenant_id AND p.sku = fq.sku
    LEFT JOIN product_health_scores ph ON ph.tenant_id = fq.tenant_id AND ph.sku = fq.sku
    WHERE fq.tenant_id = $1 AND fq.reactivated = false
      AND (fq.quarantine_end <= NOW()
           OR fq.reactivation_check_at IS NULL
           OR fq.reactivation_check_at < NOW() - INTERVAL '${config.reactivationIntervalDays} days')
  `, [tenantId]);

  let reactivated = 0;
  for (const c of candidates) {
    let score = 0;
    const reasons = [];

    if (c.reason === 'zero_stock' && (parseInt(c.erp_stock) || 0) > 0) { score += 3; reasons.push('stock ERP'); }
    if (c.reason === 'off_season' && parseFloat(c.seasonal_score) >= 50) { score += 3; reasons.push('in stagione'); }
    if ((parseInt(c.sales_30d_seller) || 0) > 0) { score += 2; reasons.push('vendite locali'); }
    if ((parseFloat(c.ga4_assisted_revenue) || 0) > 0) { score += 1; reasons.push('assist GA4'); }
    if ((parseInt(c.sales_30d_aggregated) || 0) > 5) { score += 1; reasons.push(`s30g=${c.sales_30d_aggregated}`); }
    if (c.mc_click_potential === 'HIGH') { score += 1; reasons.push('MC HIGH'); }

    await pool.query(
      `UPDATE feed_quarantine SET reactivation_check_at = NOW(), reactivation_score = $3 WHERE tenant_id = $1 AND sku = $2`,
      [tenantId, c.sku, score]
    );

    if (score >= config.reactivationMinDemandScore) {
      await pool.query(
        `UPDATE feed_quarantine SET reactivated = true, reactivated_at = NOW() WHERE tenant_id = $1 AND sku = $2`,
        [tenantId, c.sku]
      );
      reactivated++;
    }
  }

  if (reactivated > 0) console.log(`[FeedEngine] Reactivated ${reactivated} products`);
  return { checked: candidates.length, reactivated };
}

module.exports = { computeFeedActions, checkReactivations, loadFeedConfig };
