/**
 * Feed Price Optimizer
 *
 * Calculates optimal price cuts for products based on:
 * - Price tier (max cut % varies by price range)
 * - Performance multiplier (growth potential, current health)
 * - Benchmark targeting (MC benchmark, scraper best price)
 * - Safety checks (min margin %, min margin EUR)
 */

const PRICE_CUT_TIERS = [
  { minPrice: 0,   maxPrice: 10,  maxCutPct: 3,  minMarginKeep: 0.85 },
  { minPrice: 10,  maxPrice: 25,  maxCutPct: 5,  minMarginKeep: 0.70, minMarginEur: 2.00 },
  { minPrice: 25,  maxPrice: 50,  maxCutPct: 8,  minMarginKeep: 0.60, minMarginEur: 2.50 },
  { minPrice: 50,  maxPrice: 100, maxCutPct: 10, minMarginKeep: 0.50, minMarginEur: 3.00 },
  { minPrice: 100, maxPrice: 9999, maxCutPct: 12, minMarginKeep: 0.50, minMarginEur: 3.00 },
];

/**
 * Resolve best cost and stock source for a product
 */
function resolveStockAndCost(product) {
  const erpStock = parseInt(product.erp_stock) || 0;
  const supplierStock = parseInt(product.supplier_stock) || 0;
  const erpCost = parseFloat(product.erp_cost) || 0;

  if (erpStock > 0 && erpCost > 0) {
    return { source: 'erp', cost: erpCost, stock: erpStock };
  }
  if (supplierStock > 0 && erpCost > 0) {
    // Supplier stock but using erp_cost (which is min_cost from Farmabooster)
    return { source: 'supplier', cost: erpCost, stock: supplierStock };
  }
  if (erpStock > 0) {
    return { source: 'erp', cost: erpCost, stock: erpStock };
  }
  return { source: 'none', cost: erpCost, stock: 0 };
}

/**
 * Calculate performance multiplier based on product health data
 * Range: 0.3 (conservative) to 1.5 (aggressive)
 */
function calcPerformanceMultiplier(product) {
  let m = 0.5; // base

  // Growth potential from MC
  if (product.mc_click_potential === 'HIGH') m += 0.4;
  else if (product.mc_click_potential === 'MEDIUM') m += 0.2;

  // Predicted improvement from MC
  const predictedChange = parseFloat(product.mc_predicted_clicks_change);
  if (!isNaN(predictedChange) && predictedChange > 0.10) m += 0.2;

  // Already performing well → be conservative
  const healthScore = parseFloat(product.health_score) || 0;
  if (healthScore > 60) m -= 0.2;

  // Has sales evidence → more confident in cut
  if ((parseInt(product.sales_30d_seller) || 0) > 0) m += 0.15;
  if ((parseInt(product.sales_30d_aggregated) || 0) > 5) m += 0.15;

  // GA4 assisted sales → product drives value
  if ((parseInt(product.ga4_assisted_sales) || 0) > 0) m += 0.1;

  return Math.max(0.3, Math.min(1.5, m));
}

/**
 * Calculate price cut for a product
 *
 * @param {Object} product - Product data with health scores
 * @param {Object} config - Feed config (min_margin_pct, min_margin_eur)
 * @param {Object} [competitiveData] - Optional competitor data
 * @returns {Object|null} { feasible, newPrice, cutPct, newMargin, newMarginPct, reason }
 */
function calculatePriceCut(product, config, competitiveData) {
  const sellPrice = parseFloat(product.sell_price) || 0;
  if (sellPrice <= 0) return null;

  const { cost, source } = resolveStockAndCost(product);
  if (cost <= 0) return null;

  const currentMargin = sellPrice - cost;
  if (currentMargin <= 0) return null;

  // Minimum markup by price tier: <10€→18%, 10-30€→14%, >30€→12%
  const minMarkupPct = sellPrice < 5 ? 25 : (sellPrice < 10 ? 18 : 14);
  // Floor price = cost * (1 + minMarkup%)
  const floorPrice = +(cost * (1 + minMarkupPct / 100)).toFixed(2);
  const minMarginPct = minMarkupPct;
  const minMarginEur = parseFloat(config.feed_min_margin_eur || 0.50);

  // 1. Find tier
  const tier = PRICE_CUT_TIERS.find(t => sellPrice >= t.minPrice && sellPrice < t.maxPrice);
  if (!tier) return null;

  // 2. Performance multiplier
  const multiplier = calcPerformanceMultiplier(product);
  const maxCutPct = tier.maxCutPct * multiplier;

  // 3. Calculate max cut amount
  const maxCutAmount = sellPrice * (maxCutPct / 100);

  // 4. Target price: try to beat benchmark or competitor
  let targetPrice = sellPrice - maxCutAmount;
  let reason = `Taglio ${maxCutPct.toFixed(1)}% (tier ${tier.minPrice}-${tier.maxPrice}, mult ${multiplier.toFixed(2)})`;

  const benchmark = parseFloat(product.mc_benchmark_price) || 0;
  const bestCompPrice = parseFloat(product.scraper_best_price) || 0;

  // Try to beat benchmark by 1-2%
  if (benchmark > 0 && benchmark < sellPrice) {
    const beatBenchmark = +(benchmark * 0.98).toFixed(2);
    if (beatBenchmark > cost * (1 + minMarginPct / 100) && beatBenchmark < sellPrice) {
      targetPrice = Math.min(targetPrice, beatBenchmark);
      reason = `Target benchmark MC ${benchmark.toFixed(2)} -2%`;
    }
  }

  // Try to beat best competitor
  if (bestCompPrice > 0 && bestCompPrice < sellPrice && competitiveData) {
    const beatComp = +(bestCompPrice - 0.01).toFixed(2);
    if (beatComp > cost * (1 + minMarginPct / 100) && beatComp < sellPrice) {
      // Only if it's worth it (not a big player we can't compete with)
      if ((competitiveData.above_big_players || 0) < 3) {
        targetPrice = Math.min(targetPrice, beatComp);
        reason = `Sotto miglior competitor ${bestCompPrice.toFixed(2)}`;
      }
    }
  }

  // Don't cut by less than 10 cents
  if (sellPrice - targetPrice < 0.10) return null;

  // 5. Safety checks — enforce floor price (cost * (1 + minMarkup%))
  const newPrice = +Math.max(targetPrice, floorPrice).toFixed(2);
  const newMargin = newPrice - cost;
  const newMarginPct = (newMargin / newPrice) * 100;
  const newMarkupPct = cost > 0 ? ((newPrice - cost) / cost) * 100 : 0;

  // Minimum markup check (cost-based, not price-based)
  if (newMarkupPct < minMarkupPct) return null;
  if (newMargin < minMarginEur) return null;

  // Tier-specific margin preservation
  if (tier.minMarginKeep && newMargin < currentMargin * tier.minMarginKeep) return null;
  if (tier.minMarginEur && newMargin < tier.minMarginEur) return null;

  // No meaningful change
  if (Math.abs(newPrice - sellPrice) < 0.05) return null;

  const cutPct = +((sellPrice - newPrice) / sellPrice * 100).toFixed(2);

  return {
    feasible: true,
    newPrice,
    cutPct,
    newMargin: +newMargin.toFixed(2),
    newMarginPct: +newMarginPct.toFixed(1),
    costSource: source,
    reason,
  };
}

/**
 * P&L price cut: flat 5% for products with global demand but no local orders
 */
function calculatePnlPriceCut(product, config) {
  const sellPrice = parseFloat(product.sell_price) || 0;
  const { cost, source } = resolveStockAndCost(product);
  if (cost <= 0 || sellPrice <= 0) return null;

  // Only ERP stock for P&L cuts
  if (source !== 'erp') return null;

  // Must have global demand
  if ((parseInt(product.sales_30d_aggregated) || 0) < 5) return null;

  // Must have 0 local orders
  if ((parseInt(product.sales_30d_seller) || 0) > 0) return null;

  const newPrice = +(sellPrice * 0.95).toFixed(2);
  const newMargin = newPrice - cost;
  const newMarginPct = (newMargin / newPrice) * 100;

  const minMarkupPct = newPrice < 5 ? 25 : (newPrice < 10 ? 18 : 14);
  const newMarkupPct = cost > 0 ? ((newPrice - cost) / cost) * 100 : 0;
  const minMarginEur = parseFloat(config.feed_min_margin_eur || 0.50);

  if (newMarkupPct < minMarkupPct || newMargin < minMarginEur) return null;

  return {
    feasible: true,
    newPrice,
    cutPct: 5,
    newMargin: +newMargin.toFixed(2),
    newMarginPct: +newMarginPct.toFixed(1),
    costSource: source,
    reason: `P&L: s30g=${product.sales_30d_aggregated}, 0 ordini locali, ERP stock. Taglio 5%`,
  };
}

/**
 * Calculate competitive price cut to match/beat best competitor price.
 * Respects minimum markup by price tier: <10€→18%, 10-30€→14%, >30€→12%
 *
 * @param {Object} product - Product with sell_price, erp_cost, scraper_best_price, sales_30d_aggregated
 * @returns {Object|null} { feasible, newPrice, cutPct, newMarkupPct, reason }
 */
function calculateCompetitivePriceCut(product) {
  const sellPrice = parseFloat(product.sell_price) || 0;
  const bestPrice = parseFloat(product.scraper_best_price || product.best_price) || 0;
  const { cost } = resolveStockAndCost(product);

  if (sellPrice <= 0 || cost <= 0 || bestPrice <= 0) return null;
  if (sellPrice <= bestPrice * 1.02) return null; // already competitive

  const minMarkupPct = sellPrice < 5 ? 25 : (sellPrice < 10 ? 18 : 14);
  const floorPrice = +(cost * (1 + minMarkupPct / 100)).toFixed(2);

  // Target: match best price or go 1% below
  let targetPrice = +(bestPrice * 0.99).toFixed(2);

  // Can we reach the target?
  if (targetPrice >= floorPrice) {
    const cutPct = +((sellPrice - targetPrice) / sellPrice * 100).toFixed(1);
    const newMarkupPct = +((targetPrice - cost) / cost * 100).toFixed(1);
    return {
      feasible: true,
      newPrice: targetPrice,
      cutPct,
      newMarkupPct,
      reason: `Match best ${bestPrice} (-1%), markup ${newMarkupPct}% (min ${minMarkupPct}%)`,
    };
  }

  // Can't match, but can get closer (floor is within 10% of best)?
  if (floorPrice <= bestPrice * 1.10 && floorPrice < sellPrice) {
    const cutPct = +((sellPrice - floorPrice) / sellPrice * 100).toFixed(1);
    const newMarkupPct = +((floorPrice - cost) / cost * 100).toFixed(1);
    return {
      feasible: true,
      newPrice: floorPrice,
      cutPct,
      newMarkupPct,
      reason: `Floor price (${minMarkupPct}% markup), gap ${((floorPrice/bestPrice - 1)*100).toFixed(0)}% da best ${bestPrice}`,
    };
  }

  return null; // gap too large
}

/**
 * Calculate topsearch recovery price cut for products that convert
 * but are priced above competition.
 *
 * More aggressive than standard competitive cut: targets best_price - 0.01
 * or floor price, whichever is higher. Applies to star/cash_cow/opportunity
 * products that need to maintain position after losing topsearch visibility.
 *
 * Uses minimum markup by price tier: <10€→18%, 10-30€→14%, >30€→12%
 *
 * @param {Object} product - Product with sell_price, erp_cost, scraper_best_price, classification
 * @returns {Object|null} { feasible, newPrice, cutPct, newMarkupPct, reason }
 */
function calculateRecoveryPriceCut(product) {
  const sellPrice = parseFloat(product.sell_price) || 0;
  const bestPrice = parseFloat(product.scraper_best_price || product.best_price) || 0;
  const { cost } = resolveStockAndCost(product);

  if (sellPrice <= 0 || cost <= 0 || bestPrice <= 0) return null;
  if (sellPrice <= bestPrice) return null; // already at or below best

  const minMarkupPct = sellPrice < 5 ? 25 : (sellPrice < 10 ? 18 : 14);
  const floorPrice = +(cost / (1 - minMarkupPct / 100)).toFixed(2);

  // Target: beat best price by 1 cent, but never below floor
  const targetPrice = +Math.max(bestPrice - 0.01, floorPrice).toFixed(2);

  // Must actually cut something meaningful
  if (targetPrice >= sellPrice || (sellPrice - targetPrice) < 0.05) return null;

  const cutPct = +((sellPrice - targetPrice) / sellPrice * 100).toFixed(1);
  const newMarkupPct = +((targetPrice - cost) / cost * 100).toFixed(1);

  // Final safety: markup must meet minimum
  if (newMarkupPct < minMarkupPct) return null;

  const hitsTarget = targetPrice <= bestPrice;
  const reason = hitsTarget
    ? `Recovery: sotto best ${bestPrice} a €${targetPrice} (markup ${newMarkupPct}%, min ${minMarkupPct}%)`
    : `Recovery: floor €${targetPrice} (gap ${((targetPrice/bestPrice - 1)*100).toFixed(0)}% da best ${bestPrice}, markup ${newMarkupPct}%)`;

  return {
    feasible: true,
    newPrice: targetPrice,
    cutPct,
    newMarkupPct,
    reason,
  };
}

module.exports = {
  resolveStockAndCost,
  calculatePriceCut,
  calculatePnlPriceCut,
  calculateCompetitivePriceCut,
  calculateRecoveryPriceCut,
  PRICE_CUT_TIERS,
};
