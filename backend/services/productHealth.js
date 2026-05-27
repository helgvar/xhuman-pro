/**
 * Product Health Scoring & P&L Engine
 *
 * Combines all data sources (products, zombie clicks, scraper competitors,
 * Merchant Center, orders) into a unified per-product health score.
 *
 * Runs every 4 hours via healthCron.js.
 */

const { pool } = require('../db/pool');

// Default scoring weights
const DEFAULT_WEIGHTS = {
  revenue: 0.30,
  efficiency: 0.25,
  competitive: 0.15,
  growth: 0.10,
  seasonal: 0.10,
  indirect: 0.10,
};

const DEFAULT_CPC = 0.27; // EUR per Trovaprezzi click (netto, IVA esclusa)

// Pharmacy seasonal categories (month ranges)
const PHARMACY_SEASONS = {
  'solari|protezione solare|doposole|solare': [5, 6, 7, 8, 9],
  'antizanzare|repellent|zanzar': [5, 6, 7, 8, 9],
  'influenza|raffreddore|tosse|mal di gola': [10, 11, 12, 1, 2],
  'allergia|antistaminic|allergic': [3, 4, 5],
  'dimagrante|drenante|dieta|snellente': [3, 4, 5, 6],
  'integratore estate|idratazione|sali minerali': [6, 7, 8],
};

/**
 * Load tenant-specific config from health_config table
 */
async function loadConfig(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1`,
    [tenantId]
  );

  const config = {};
  for (const r of rows) {
    config[r.config_key] = r.config_value;
  }

  return {
    weights: {
      revenue: parseFloat(config.weight_revenue || DEFAULT_WEIGHTS.revenue),
      efficiency: parseFloat(config.weight_efficiency || DEFAULT_WEIGHTS.efficiency),
      competitive: parseFloat(config.weight_competitive || DEFAULT_WEIGHTS.competitive),
      growth: parseFloat(config.weight_growth || DEFAULT_WEIGHTS.growth),
      seasonal: parseFloat(config.weight_seasonal || DEFAULT_WEIGHTS.seasonal),
      indirect: parseFloat(config.weight_indirect || DEFAULT_WEIGHTS.indirect),
    },
    avgCpc: parseFloat(config.avg_tp_cpc || DEFAULT_CPC),
    targetIncidenceMin: parseFloat(config.tp_target_incidence_min || 3),
    targetIncidenceMax: parseFloat(config.tp_target_incidence_max || 5),
  };
}

/**
 * Get the tenant's seller name from trovaprezzi config (for scraper matching)
 */
async function getSellerName(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM tenant_configs
     WHERE tenant_id = $1 AND config_key IN ('scraper_merchant_name', 'trovaprezzi_seller_name')`,
    [tenantId]
  );
  if (rows.length === 0) return null;
  const { decrypt } = require('./crypto');
  // Prefer scraper_merchant_name (exact merchant name in scraper) over trovaprezzi_seller_name
  const merchantRow = rows.find(r => r.config_key === 'scraper_merchant_name') || rows[0];
  try {
    return decrypt(merchantRow.config_value);
  } catch {
    return merchantRow.config_value;
  }
}

/**
 * Assemble all product data via a massive SQL join
 */
async function assembleProductData(tenantId, sellerName) {
  const sellerPattern = sellerName ? `%${sellerName}%` : '%__NOMATCH__%';

  // CRITICAL: Align order date range with click date range
  // Orders must be compared ONLY for the period where we have click data
  const { rows: [clickRange] } = await pool.query(
    `SELECT MIN(fetch_date) as first_click, MAX(fetch_date) as last_click, COUNT(DISTINCT fetch_date) as days
     FROM zombie_clicks WHERE tenant_id = $1`,
    [tenantId]
  );
  const clickFirstDate = clickRange?.first_click || new Date(Date.now() - 30 * 86400000);
  const clickDays = parseInt(clickRange?.days) || 0;
  console.log(`[Health] Date alignment: clicks ${clickRange?.first_click || 'none'} → ${clickRange?.last_click || 'none'} (${clickDays} days), orders aligned to same range`);

  const { rows } = await pool.query(`
    SELECT
      p.sku,
      p.product_name,
      p.category,
      p.sell_price,
      p.erp_cost,
      p.margin,
      p.margin_pct,
      p.sales_30d_seller,
      p.sales_30d_aggregated,
      p.erp_stock,
      p.supplier_stock,
      p.is_civetta,
      p.is_topsearch,
      p.brand,
      p.manufacturer,
      p.updated_at as product_updated_at,

      -- Zombie clicks (last 30 days aggregated)
      COALESCE(zc.total_clicks_30d, 0)::int as tp_clicks_30d,
      COALESCE(zc.avg_daily_clicks, 0) as tp_avg_daily_clicks,
      zc.latest_category as tp_category,

      -- Scraper competitors
      sc.competitor_count,
      sc.best_price as scraper_best_price,
      sc.my_position as scraper_position,
      sc.avg_competitor_price,

      -- Merchant Center
      mc.benchmark_price as mc_benchmark_price,
      mc.suggested_price as mc_suggested_price,
      mc.click_potential as mc_click_potential,
      mc.click_potential_rank as mc_click_potential_rank,
      mc.clicks_14d as mc_clicks_14d,
      mc.impressions_14d as mc_impressions_14d,
      mc.ctr_14d as mc_ctr_14d,
      mc.predicted_clicks_change as mc_predicted_clicks_change,
      mc.predicted_impressions_change as mc_predicted_impressions_change,

      -- Order attribution proxy (last 30d, civetta products with clicks)
      COALESCE(oa.tp_orders, 0)::int as tp_orders,
      COALESCE(oa.tp_revenue, 0) as tp_revenue,
      COALESCE(oa.tp_cogs, 0) as tp_cogs,
      COALESCE(oa.avg_items_per_order, 1) as avg_items_per_order

    FROM products p

    -- Zombie clicks aggregation (aligned to click date range)
    LEFT JOIN LATERAL (
      SELECT
        SUM(clicks) as total_clicks_30d,
        AVG(clicks) as avg_daily_clicks,
        (SELECT trovaprezzi_category FROM zombie_clicks
         WHERE tenant_id = $1 AND product_code = p.sku
         ORDER BY fetch_date DESC LIMIT 1) as latest_category
      FROM zombie_clicks
      WHERE tenant_id = $1
        AND product_code = p.sku
        AND fetch_date >= $3::date
    ) zc ON true

    -- Scraper data (latest 48h)
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as competitor_count,
        MIN(base_price) as best_price,
        AVG(base_price) as avg_competitor_price,
        MIN(CASE WHEN merchant ILIKE $2 THEN position END) as my_position
      FROM scraper_competitors
      WHERE product_code = p.sku
        AND updated_at > NOW() - INTERVAL '48 hours'
    ) sc ON true

    -- Merchant Center data
    LEFT JOIN merchant_center_products mc
      ON mc.tenant_id = $1 AND mc.offer_id = p.sku

    -- Order attribution (ALIGNED to click date range — same period as clicks)
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT oi.order_id) as tp_orders,
        SUM(oi.row_total) as tp_revenue,
        -- COGS realistico: erp_cost reale o fallback imputato (migration 024)
        SUM(oi.qty_ordered * COALESCE(NULLIF(p.erp_cost, 0), p.erp_cost_imputed, 0)) as tp_cogs,
        AVG(order_item_count) as avg_items_per_order
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id AND o.tenant_id = $1
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::numeric as order_item_count
        FROM order_items oi2 WHERE oi2.order_id = o.id
      ) oic ON true
      WHERE oi.tenant_id = $1
        AND oi.sku = p.sku
        AND o.order_date >= $3::date
        AND o.order_status IN ('complete', 'processing')
    ) oa ON true

    WHERE p.tenant_id = $1
  `, [tenantId, sellerPattern, clickFirstDate]);

  return rows;
}

/**
 * Calculate percentile rank for a value within an array
 */
function percentileRank(value, sortedValues) {
  if (sortedValues.length === 0) return 50;
  let below = 0;
  for (const v of sortedValues) {
    if (v < value) below++;
    else break;
  }
  return (below / sortedValues.length) * 100;
}

/**
 * Calculate Revenue Score (0-100)
 */
function calcRevenueScore(product, catalogMarginValues) {
  const marginContribution = product.sales_30d_seller * product.margin;

  if (marginContribution <= 0 && product.margin > 0) return 5;
  if (product.margin <= 0) return 0;

  return Math.min(100, percentileRank(marginContribution, catalogMarginValues));
}

/**
 * Calculate Efficiency Score (0-100)
 * Core burner detector
 */
function calcEfficiencyScore(product) {
  const clicks = product.tp_clicks_30d;
  const orders = product.tp_orders;

  if (clicks === 0) {
    return product.is_civetta ? 0 : 50; // not in feed = neutral
  }

  if (clicks > 0 && orders === 0) {
    // Pure burner: more clicks = worse score
    return Math.max(0, 10 - Math.floor(clicks / 10));
  }

  // Has conversions
  const conversionRate = orders / clicks;
  // Pharmacy TP typical CR: 1-3%. Score 100 at >= 5%, 50 at ~2%
  return Math.min(100, (conversionRate / 0.05) * 100);
}

/**
 * Calculate Competitive Score (0-100)
 * 40% position + 30% benchmark ratio + 30% competitor density
 */
function calcCompetitiveScore(product) {
  // Position component (40%)
  let positionScore = 50;
  const pos = product.scraper_position;
  if (pos != null) {
    if (pos === 1) positionScore = 100;
    else if (pos <= 3) positionScore = 80;
    else if (pos <= 5) positionScore = 60;
    else if (pos <= 10) positionScore = 30;
    else positionScore = 10;
  }

  // Benchmark component (30%)
  let benchmarkScore = 50;
  const benchmark = parseFloat(product.mc_benchmark_price);
  const sellPrice = parseFloat(product.sell_price);
  if (benchmark > 0 && sellPrice > 0) {
    const ratio = sellPrice / benchmark;
    if (ratio <= 0.95) benchmarkScore = 100;
    else if (ratio <= 1.0) benchmarkScore = 80;
    else if (ratio <= 1.05) benchmarkScore = 60;
    else if (ratio <= 1.15) benchmarkScore = 30;
    else benchmarkScore = 10;
  }

  // Competition density (30%)
  let densityScore = 50;
  const count = product.competitor_count;
  if (count != null) {
    if (count <= 3) densityScore = 90;
    else if (count <= 8) densityScore = 60;
    else if (count <= 15) densityScore = 40;
    else densityScore = 20;
  }

  return 0.40 * positionScore + 0.30 * benchmarkScore + 0.30 * densityScore;
}

/**
 * Calculate Growth Score (0-100)
 * 60% MC click potential + 40% predicted clicks change
 */
function calcGrowthScore(product) {
  const potentialMap = { HIGH: 100, MEDIUM: 60, LOW: 30 };
  const potentialScore = potentialMap[product.mc_click_potential] || 40;

  let impactScore = 50;
  const predicted = parseFloat(product.mc_predicted_clicks_change);
  if (!isNaN(predicted)) {
    if (predicted > 0.20) impactScore = 100;
    else if (predicted > 0.10) impactScore = 80;
    else if (predicted > 0) impactScore = 60;
    else if (predicted > -0.10) impactScore = 40;
    else impactScore = 20;
  }

  return 0.60 * potentialScore + 0.40 * impactScore;
}

/**
 * Calculate Seasonal Score (0-100)
 */
function calcSeasonalScore(product) {
  const currentMonth = new Date().getMonth() + 1;
  const category = (product.tp_category || product.category || '').toLowerCase();

  for (const [pattern, months] of Object.entries(PHARMACY_SEASONS)) {
    const patterns = pattern.split('|');
    const matches = patterns.some(p => category.includes(p));
    if (matches) {
      if (months.includes(currentMonth)) {
        return 95; // in season
      }
      // Check adjacent month (pre/post season)
      const adjacent = months.some(m =>
        Math.abs(m - currentMonth) === 1 ||
        (m === 1 && currentMonth === 12) ||
        (m === 12 && currentMonth === 1)
      );
      if (adjacent) return 60;
      return 20; // off season
    }
  }

  return 70; // evergreen default
}

/**
 * Calculate Indirect Value Score (0-100)
 * Phase 1: proxy based on multi-item orders. Phase 5 will use GA4 data.
 */
function calcIndirectScore(product) {
  const clicks = product.tp_clicks_30d;
  const avgItems = parseFloat(product.avg_items_per_order) || 1;

  if (clicks > 0 && avgItems > 1.5) {
    return Math.min(100, clicks * 2);
  }
  if (product.sales_30d_seller > 0 && avgItems > 2) {
    return 60;
  }
  return 30;
}

/**
 * Calculate Data Confidence (0.0 - 1.0)
 */
function calcDataConfidence(product) {
  let confidence = 0;

  if (parseFloat(product.erp_cost) > 0) confidence += 0.20;
  if (parseFloat(product.sales_30d_seller) > 0) confidence += 0.15;
  if (product.tp_clicks_30d > 0) confidence += 0.20;
  if (product.mc_benchmark_price != null) confidence += 0.15;
  if (product.competitor_count != null && product.competitor_count > 0) confidence += 0.15;
  if (product.tp_orders > 0) confidence += 0.15;

  return Math.min(1.0, confidence);
}

/**
 * Classify product based on scores and metrics
 */
function classifyProduct(product, scores) {
  const { healthScore, dataConfidence } = scores;
  const isCivetta = product.is_civetta;
  const clicks = product.tp_clicks_30d;
  const revenue = parseFloat(product.tp_revenue) || 0;
  const incidence = revenue > 0 ? (product.tp_click_cost_30d / revenue) : (clicks > 0 ? 999 : 0);
  const sales = parseFloat(product.sales_30d_seller) || 0;

  // Low confidence = insufficient data
  if (dataConfidence < 0.40) return 'question_mark';

  // Not in feed
  if (!isCivetta) {
    if (healthScore >= 50 && sales > 0) return 'opportunity';
    return 'question_mark';
  }

  // In feed: classify by performance
  if (revenue > 0 && incidence <= 0.05 && healthScore >= 60) return 'star';
  if (revenue > 0 && incidence <= 0.08 && healthScore >= 40) return 'cash_cow';
  if (clicks > 5 && (revenue === 0 || incidence > 0.15)) return 'burner';
  if (clicks > 0 && revenue > 0 && incidence <= 0.12) return 'cash_cow';

  return 'question_mark';
}

/**
 * Generate recommendation for a product
 */
function generateRecommendation(product, classification, scores) {
  const rec = {
    civetta: product.is_civetta,
    priceAction: 'none',
    price: null,
    priority: 'low',
    reasoning: '',
  };

  const sellPrice = parseFloat(product.sell_price) || 0;
  const erpCost = parseFloat(product.erp_cost) || 0;
  const incidencePct = product.tp_cost_incidence > 0
    ? (product.tp_cost_incidence * 100).toFixed(1)
    : '0.0';

  switch (classification) {
    case 'star':
      rec.civetta = true;
      rec.priority = 'high';
      // Check if we can increase price (position 1 with margin room)
      if (product.scraper_position === 1 && product.scraper_best_price) {
        // We ARE the best price. Can we edge up?
        // Need at least 2 competitors to find next price
        if (product.competitor_count > 1 && product.avg_competitor_price > sellPrice) {
          const room = (parseFloat(product.avg_competitor_price) - sellPrice).toFixed(2);
          rec.reasoning = `Star: posizione 1, margine di aumento €${room}. Revenue €${parseFloat(product.tp_revenue).toFixed(2)}, incidenza ${incidencePct}%.`;
        } else {
          rec.reasoning = `Star: posizione ${product.scraper_position || '?'}, revenue €${parseFloat(product.tp_revenue || 0).toFixed(2)}, incidenza ${incidencePct}%.`;
        }
      } else {
        rec.reasoning = `Star: revenue €${parseFloat(product.tp_revenue || 0).toFixed(2)}, incidenza ${incidencePct}%. Proteggere posizione.`;
      }
      break;

    case 'cash_cow':
      rec.civetta = true;
      rec.priority = 'medium';
      if (product.tp_cost_incidence > 0.06) {
        rec.reasoning = `Cash cow: incidenza in salita (${incidencePct}%). Monitorare click vs conversioni.`;
      } else {
        rec.reasoning = `Cash cow: revenue €${parseFloat(product.tp_revenue || 0).toFixed(2)}, incidenza ${incidencePct}%.`;
      }
      break;

    case 'burner':
      rec.civetta = false;
      rec.priority = 'high';
      const waste = product.tp_click_cost_30d.toFixed(2);
      if (parseFloat(product.tp_revenue) === 0) {
        rec.reasoning = `BURNER: ${product.tp_clicks_30d} click in 30gg, ZERO vendite. Spreco stimato €${waste}. Rimuovere dal feed.`;
      } else {
        rec.reasoning = `BURNER: incidenza ${incidencePct}% (target max 5%). ${product.tp_clicks_30d} click, solo €${parseFloat(product.tp_revenue).toFixed(2)} revenue. Rimuovere o tagliare prezzo.`;
      }
      // Check if price cut from MC could save it
      const suggested = parseFloat(product.mc_suggested_price);
      if (suggested > 0 && suggested < sellPrice && erpCost > 0) {
        const newMargin = suggested - erpCost;
        if (newMargin > 0) {
          rec.priceAction = 'decrease';
          rec.price = suggested;
          rec.reasoning += ` Possibile taglio a €${suggested.toFixed(2)} (MC suggested, margine €${newMargin.toFixed(2)}).`;
        }
      }
      break;

    case 'opportunity':
      rec.civetta = false; // keep out, flag for review
      rec.priority = 'medium';
      if (product.mc_click_potential === 'HIGH') {
        rec.reasoning = `OPPORTUNITÀ: non in feed ma MC click potential HIGH. Score ${scores.healthScore.toFixed(0)}.`;
        const benchmark = parseFloat(product.mc_benchmark_price);
        if (benchmark > 0 && sellPrice > benchmark * 1.10 && erpCost > 0) {
          const targetPrice = +(benchmark * 0.98).toFixed(2);
          const newMargin = targetPrice - erpCost;
          if (newMargin > 0 && (newMargin / targetPrice) > 0.10) {
            rec.priceAction = 'match_benchmark';
            rec.price = targetPrice;
            rec.reasoning += ` Taglio a €${targetPrice} consentirebbe inclusione con margine ${((newMargin / targetPrice) * 100).toFixed(1)}%.`;
          }
        }
      } else {
        rec.reasoning = `Opportunità: ${product.sales_30d_seller} vendite/30gg ma non nel feed TP. Score ${scores.healthScore.toFixed(0)}.`;
      }
      break;

    case 'question_mark':
    default:
      rec.civetta = product.is_civetta;
      rec.priority = 'low';
      const confPct = (scores.dataConfidence * 100).toFixed(0);
      rec.reasoning = `Dati insufficienti (confidenza ${confPct}%). `;
      if (product.is_civetta) {
        rec.reasoning += 'Nel feed: attendere 14 giorni per dati.';
      } else {
        rec.reasoning += 'Non nel feed: considerare A/B test se margine ok.';
      }
      break;
  }

  // Override: stock = 0 → always civetta = false
  if ((parseInt(product.erp_stock) || 0) === 0 && (parseInt(product.supplier_stock) || 0) === 0) {
    if (rec.civetta) {
      rec.civetta = false;
      rec.priority = 'high';
      rec.reasoning = `STOCK ESAURITO. ${rec.reasoning}`;
    }
  }

  return rec;
}

/**
 * Main computation function: compute health scores for all products of a tenant
 */
async function computeHealthScores(tenantId) {
  const startTime = Date.now();
  console.log(`[Health] Starting enrichment for tenant ${tenantId.slice(0, 8)}...`);

  // Load config and seller name
  const config = await loadConfig(tenantId);
  const sellerName = await getSellerName(tenantId);

  // Assemble all data
  const products = await assembleProductData(tenantId, sellerName);
  console.log(`[Health] Assembled ${products.length} products`);

  if (products.length === 0) {
    console.log(`[Health] No products found for tenant ${tenantId.slice(0, 8)}`);
    return { total: 0, byClassification: {} };
  }

  // Debug: check order attribution in assembled data
  const withOrders = products.filter(p => (parseInt(p.tp_orders) || 0) > 0);
  const totalTpRevenue = products.reduce((s, p) => s + (parseFloat(p.tp_revenue) || 0), 0);
  console.log(`[Health] Order attribution: ${withOrders.length} products with orders, €${totalTpRevenue.toFixed(2)} total revenue`);

  // Pre-compute catalog-level stats for percentile ranking
  const marginContributions = products
    .map(p => (parseFloat(p.sales_30d_seller) || 0) * (parseFloat(p.margin) || 0))
    .filter(v => v > 0)
    .sort((a, b) => a - b);

  // Process each product
  const results = [];
  const byClassification = { star: 0, cash_cow: 0, burner: 0, opportunity: 0, question_mark: 0 };

  for (const product of products) {
    const avgCpc = config.avgCpc;

    // P&L calculations
    const tpClickCost = product.tp_clicks_30d * avgCpc;
    const tpRevenue = parseFloat(product.tp_revenue) || 0;
    const tpCogs = parseFloat(product.tp_cogs) || 0;
    const tpGrossMargin = tpRevenue - tpCogs - tpClickCost;
    const tpIncidence = tpRevenue > 0 ? tpClickCost / tpRevenue : 0;

    product.tp_click_cost_30d = tpClickCost;
    product.tp_cost_incidence = tpIncidence;

    // Calculate 6 component scores
    const revenueScore = calcRevenueScore(product, marginContributions);
    const efficiencyScore = calcEfficiencyScore(product);
    const competitiveScore = calcCompetitiveScore(product);
    const growthScore = calcGrowthScore(product);
    const seasonalScore = calcSeasonalScore(product);
    const indirectScore = calcIndirectScore(product);
    const dataConfidence = calcDataConfidence(product);

    // Composite health score
    const w = config.weights;
    const healthScore = Math.min(100, Math.max(0,
      revenueScore * w.revenue +
      efficiencyScore * w.efficiency +
      competitiveScore * w.competitive +
      growthScore * w.growth +
      seasonalScore * w.seasonal +
      indirectScore * w.indirect
    ));

    const scores = { healthScore, dataConfidence };

    // Classify
    let classification = classifyProduct(product, scores);

    // Override: burner with high indirect value → cash_cow
    if (classification === 'burner' && indirectScore > 70) {
      classification = 'cash_cow';
    }

    // Generate recommendation
    const rec = generateRecommendation(product, classification, scores);

    byClassification[classification] = (byClassification[classification] || 0) + 1;

    // Check seasonality
    const isSeasonal = calcSeasonalScore(product) !== 70; // 70 = evergreen default
    const seasonId = isSeasonal
      ? Object.keys(PHARMACY_SEASONS).find(pattern =>
          pattern.split('|').some(p => (product.tp_category || product.category || '').toLowerCase().includes(p))
        ) || ''
      : '';

    results.push({
      tenantId,
      sku: product.sku,
      // P&L
      tp_clicks_30d: product.tp_clicks_30d,
      tp_click_cost_30d: tpClickCost,
      tp_attributed_revenue: tpRevenue,
      tp_attributed_orders: product.tp_orders,
      tp_cogs: tpCogs,
      tp_gross_margin: tpGrossMargin,
      tp_cost_incidence: tpIncidence,
      // MC snapshot
      mc_benchmark_price: product.mc_benchmark_price,
      mc_suggested_price: product.mc_suggested_price,
      mc_click_potential: product.mc_click_potential || '',
      mc_click_potential_rank: product.mc_click_potential_rank,
      mc_clicks_14d: product.mc_clicks_14d || 0,
      mc_impressions_14d: product.mc_impressions_14d || 0,
      mc_ctr_14d: product.mc_ctr_14d || 0,
      mc_predicted_clicks_change: product.mc_predicted_clicks_change,
      mc_predicted_impressions_change: product.mc_predicted_impressions_change,
      // Scraper snapshot
      scraper_position: product.scraper_position,
      scraper_competitor_count: product.competitor_count || 0,
      scraper_best_price: product.scraper_best_price,
      scraper_price_gap_pct: product.scraper_best_price && parseFloat(product.sell_price) > 0
        ? ((parseFloat(product.sell_price) - parseFloat(product.scraper_best_price)) / parseFloat(product.scraper_best_price) * 100)
        : 0,
      // Scores
      revenue_score: revenueScore,
      efficiency_score: efficiencyScore,
      competitive_score: competitiveScore,
      growth_score: growthScore,
      seasonal_score: seasonalScore,
      indirect_score: indirectScore,
      health_score: healthScore,
      data_confidence: dataConfidence,
      // Classification
      classification,
      // Recommendation
      rec_civetta: rec.civetta,
      rec_price_action: rec.priceAction,
      rec_price: rec.price,
      rec_priority: rec.priority,
      rec_reasoning: rec.reasoning,
      // Seasonality
      is_seasonal: isSeasonal,
      season_id: seasonId,
    });
  }

  // Batch upsert to product_health_scores (batches of 50)
  const BATCH_SIZE = 50;
  let upserted = 0;

  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, i + BATCH_SIZE);
    await upsertHealthBatch(batch);
    upserted += batch.length;
  }

  // Verify: how many results have revenue > 0?
  const resultsWithRevenue = results.filter(r => r.tp_attributed_revenue > 0).length;
  console.log(`[Health] Upserted ${upserted} products. Revenue in results: ${resultsWithRevenue} products with rev > 0`);

  // Save daily snapshot
  await saveSnapshot(tenantId, results);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Health] Completed for tenant ${tenantId.slice(0, 8)}: ${upserted} products scored in ${elapsed}s`);
  console.log(`[Health] Distribution:`, byClassification);

  return {
    total: results.length,
    byClassification,
    elapsed: parseFloat(elapsed),
  };
}

/**
 * Batch upsert health scores
 */
async function upsertHealthBatch(batch) {
  if (batch.length === 0) return;

  const COLS = 37; // number of columns per row
  const values = [];
  const placeholders = [];

  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    const base = i * COLS;
    const ph = [];
    for (let c = 1; c <= COLS; c++) ph.push(`$${base + c}`);
    placeholders.push(`(${ph.join(',')})`);

    values.push(
      r.tenantId, r.sku,
      r.tp_clicks_30d, r.tp_click_cost_30d, r.tp_attributed_revenue, r.tp_attributed_orders,
      r.tp_cogs, r.tp_gross_margin, r.tp_cost_incidence,
      r.mc_benchmark_price, r.mc_suggested_price, r.mc_click_potential, r.mc_click_potential_rank,
      r.mc_clicks_14d, r.mc_impressions_14d, r.mc_ctr_14d,
      r.mc_predicted_clicks_change, r.mc_predicted_impressions_change,
      r.scraper_position, r.scraper_competitor_count, r.scraper_best_price, r.scraper_price_gap_pct,
      r.revenue_score, r.efficiency_score, r.competitive_score, r.growth_score,
      r.seasonal_score, r.indirect_score, r.health_score, r.data_confidence,
      r.classification,
      r.rec_civetta, r.rec_price_action, r.rec_price, r.rec_priority, r.rec_reasoning,
      r.is_seasonal
    );
  }

  await pool.query(`
    INSERT INTO product_health_scores (
      tenant_id, sku,
      tp_clicks_30d, tp_click_cost_30d, tp_attributed_revenue, tp_attributed_orders,
      tp_cogs, tp_gross_margin, tp_cost_incidence,
      mc_benchmark_price, mc_suggested_price, mc_click_potential, mc_click_potential_rank,
      mc_clicks_14d, mc_impressions_14d, mc_ctr_14d,
      mc_predicted_clicks_change, mc_predicted_impressions_change,
      scraper_position, scraper_competitor_count, scraper_best_price, scraper_price_gap_pct,
      revenue_score, efficiency_score, competitive_score, growth_score,
      seasonal_score, indirect_score, health_score, data_confidence,
      classification,
      rec_civetta, rec_price_action, rec_price, rec_priority, rec_reasoning,
      is_seasonal
    ) VALUES ${placeholders.join(',')}
    ON CONFLICT (tenant_id, sku) DO UPDATE SET
      tp_clicks_30d = EXCLUDED.tp_clicks_30d,
      tp_click_cost_30d = EXCLUDED.tp_click_cost_30d,
      tp_attributed_revenue = EXCLUDED.tp_attributed_revenue,
      tp_attributed_orders = EXCLUDED.tp_attributed_orders,
      tp_cogs = EXCLUDED.tp_cogs,
      tp_gross_margin = EXCLUDED.tp_gross_margin,
      tp_cost_incidence = EXCLUDED.tp_cost_incidence,
      mc_benchmark_price = EXCLUDED.mc_benchmark_price,
      mc_suggested_price = EXCLUDED.mc_suggested_price,
      mc_click_potential = EXCLUDED.mc_click_potential,
      mc_click_potential_rank = EXCLUDED.mc_click_potential_rank,
      mc_clicks_14d = EXCLUDED.mc_clicks_14d,
      mc_impressions_14d = EXCLUDED.mc_impressions_14d,
      mc_ctr_14d = EXCLUDED.mc_ctr_14d,
      mc_predicted_clicks_change = EXCLUDED.mc_predicted_clicks_change,
      mc_predicted_impressions_change = EXCLUDED.mc_predicted_impressions_change,
      scraper_position = EXCLUDED.scraper_position,
      scraper_competitor_count = EXCLUDED.scraper_competitor_count,
      scraper_best_price = EXCLUDED.scraper_best_price,
      scraper_price_gap_pct = EXCLUDED.scraper_price_gap_pct,
      revenue_score = EXCLUDED.revenue_score,
      efficiency_score = EXCLUDED.efficiency_score,
      competitive_score = EXCLUDED.competitive_score,
      growth_score = EXCLUDED.growth_score,
      seasonal_score = EXCLUDED.seasonal_score,
      indirect_score = EXCLUDED.indirect_score,
      health_score = EXCLUDED.health_score,
      data_confidence = EXCLUDED.data_confidence,
      classification = EXCLUDED.classification,
      rec_civetta = EXCLUDED.rec_civetta,
      rec_price_action = EXCLUDED.rec_price_action,
      rec_price = EXCLUDED.rec_price,
      rec_priority = EXCLUDED.rec_priority,
      rec_reasoning = EXCLUDED.rec_reasoning,
      is_seasonal = EXCLUDED.is_seasonal,
      computed_at = NOW()
  `, values);
}

/**
 * Save daily snapshot for trend analysis (once per day per product)
 */
async function saveSnapshot(tenantId, results) {
  const today = new Date().toISOString().slice(0, 10);
  const BATCH = 100;

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    const values = [];
    const placeholders = [];
    const COLS = 7;

    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      const base = j * COLS;
      const ph = [];
      for (let c = 1; c <= COLS; c++) ph.push(`$${base + c}`);
      placeholders.push(`(${ph.join(',')})`);
      values.push(
        tenantId, r.sku, today,
        r.health_score, r.classification, r.tp_cost_incidence, r.tp_attributed_revenue
      );
    }

    await pool.query(`
      INSERT INTO product_health_history (tenant_id, sku, snapshot_date, health_score, classification, tp_cost_incidence, tp_attributed_revenue)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (tenant_id, sku, snapshot_date) DO UPDATE SET
        health_score = EXCLUDED.health_score,
        classification = EXCLUDED.classification,
        tp_cost_incidence = EXCLUDED.tp_cost_incidence,
        tp_attributed_revenue = EXCLUDED.tp_attributed_revenue
    `, values);
  }
}

/**
 * Get global P&L summary for a tenant
 * Incidence = total TP click cost / total store revenue (not per-product attribution)
 */
async function getGlobalPnl(tenantId) {
  // Health scores aggregation
  const { rows: [healthSummary] } = await pool.query(`
    SELECT
      COUNT(*) as total_products,
      COUNT(*) FILTER (WHERE rec_civetta = true) as feed_products,
      SUM(tp_clicks_30d) as total_clicks,
      SUM(tp_click_cost_30d) as total_click_cost,
      COUNT(*) FILTER (WHERE classification = 'star') as stars,
      COUNT(*) FILTER (WHERE classification = 'cash_cow') as cash_cows,
      COUNT(*) FILTER (WHERE classification = 'burner') as burners,
      COUNT(*) FILTER (WHERE classification = 'opportunity') as opportunities,
      COUNT(*) FILTER (WHERE classification = 'question_mark') as question_marks,
      SUM(tp_click_cost_30d) FILTER (WHERE classification = 'burner') as burner_waste,
      AVG(health_score) as avg_health_score
    FROM product_health_scores
    WHERE tenant_id = $1
  `, [tenantId]);

  // Real store revenue from orders (last 30 days) — grand_total = lordo IVA + spedizioni (come report Magento)
  const { rows: [storeSummary] } = await pool.query(`
    SELECT
      COUNT(*) as store_orders,
      COALESCE(SUM(grand_total), 0) as store_revenue
    FROM orders
    WHERE tenant_id = $1
      AND order_status IN ('complete', 'processing')
      AND order_date >= NOW() - INTERVAL '30 days'
  `, [tenantId]);

  // GA4 channel KPIs (from last GA4 import)
  const { rows: ga4Rows } = await pool.query(
    `SELECT config_key, config_value FROM health_config
     WHERE tenant_id = $1 AND (config_key LIKE 'ga4_%' OR config_key LIKE 'feed_%')`,
    [tenantId]
  );
  const ga4 = {};
  for (const r of ga4Rows) ga4[r.config_key] = r.config_value;

  // Calcola click + costo allineati alla finestra GA4 (30gg o ga4_data_start_date)
  // per evitare incidenza inflata da costi cumulativi storici vs revenue 30gg.
  try {
    const cpcVal = parseFloat(ga4.avg_tp_cpc) || 0.27;
    const { rows: [aligned] } = await pool.query(`
      WITH effective_start AS (
        SELECT GREATEST(
          CURRENT_DATE - INTERVAL '30 days',
          COALESCE($2::date, CURRENT_DATE - INTERVAL '30 days')
        )::date AS d
      )
      SELECT COALESCE(SUM(clicks), 0)::int AS clicks_30d
      FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date >= (SELECT d FROM effective_start) AND fetch_date < CURRENT_DATE
    `, [tenantId, ga4.ga4_data_start_date || null]);
    ga4.clicks_30d_aligned = parseInt(aligned.clicks_30d) || 0;
    ga4.click_cost_30d_aligned = +(ga4.clicks_30d_aligned * cpcVal).toFixed(2);
  } catch (e) {
    ga4.clicks_30d_aligned = 0;
    ga4.click_cost_30d_aligned = 0;
  }

  const ga4TpRevenue = parseFloat(ga4.ga4_tp_revenue_30d) || 0;
  const ga4TpTransactions = parseInt(ga4.ga4_tp_transactions_30d) || 0;
  const ga4TpSessions = parseInt(ga4.ga4_tp_sessions_30d) || 0;
  const ga4TpAvgBasket = parseFloat(ga4.ga4_tp_avg_basket) || 0;
  const ga4TpConvRate = parseFloat(ga4.ga4_tp_conv_rate) || 0;

  // Also get total store revenue from GA4 channels if available
  // IMPORTANT: exclude the manually-added "Trovaprezzi" key because
  // its revenue is already counted inside the "Referral" channel grouping
  let ga4StoreRevenue = 0;
  try {
    const { getGA4Attribution } = require('./ga4Analytics');
    const ga4Data = await getGA4Attribution(tenantId);
    if (ga4Data?.channelKpis) {
      for (const [channel, kpi] of Object.entries(ga4Data.channelKpis)) {
        if (channel === 'Trovaprezzi') continue; // already in Referral
        ga4StoreRevenue += kpi.revenue || 0;
      }
    }
  } catch { /* GA4 not available */ }

  const storeOrders = parseInt(storeSummary.store_orders) || 0;

  // Use feed_daily_summary as source of truth for incidence (real data from zombie clicks period)
  const { rows: [dailySummary] } = await pool.query(
    `SELECT total_cost, total_revenue, cumulative_incidence, total_clicks, total_orders
     FROM feed_daily_summary WHERE tenant_id = $1 ORDER BY summary_date DESC LIMIT 1`,
    [tenantId]
  );
  const revenueSource = ga4.revenue_source || 'magento';
  const realClickCost = parseFloat(dailySummary?.total_cost) || parseFloat(healthSummary.total_click_cost) || 0;
  const realRevenue = parseFloat(dailySummary?.total_revenue) || (revenueSource === 'ga4' ? ga4TpRevenue : parseFloat(storeSummary.store_revenue) || 0);
  const totalClickCost = realClickCost;
  const tpIncidence = realRevenue > 0 ? totalClickCost / realRevenue : 0;

  return {
    ...healthSummary,
    store_orders: storeOrders,
    store_revenue: parseFloat(storeSummary.store_revenue) || 0,
    revenue_source: revenueSource,
    // Incidence from real data (feed_daily_summary)
    global_incidence: tpIncidence,
    real_click_cost: realClickCost,
    real_revenue: realRevenue,
    real_clicks: parseInt(dailySummary?.total_clicks) || parseInt(healthSummary.total_clicks) || 0,
    real_orders: parseInt(dailySummary?.total_orders) || storeOrders,
    // GA4 TP channel data
    ga4_tp_revenue: ga4TpRevenue,
    ga4_tp_transactions: ga4TpTransactions,
    ga4_tp_sessions: ga4TpSessions,
    ga4_tp_avg_basket: ga4TpAvgBasket,
    ga4_tp_conv_rate: ga4TpConvRate,
    ga4_last_update: ga4.ga4_last_update || null,
    ga4_data_start_date: ga4.ga4_data_start_date || null,
    // Costo click ultimi 30gg (allineato con la finestra GA4 del denominatore TP-attribuito).
    // Rispetta ga4_data_start_date per tenant onboardati di recente (es. Sanvito dal 28/4).
    click_cost_30d: parseFloat(ga4.click_cost_30d_aligned) || 0,
    clicks_30d: parseInt(ga4.clicks_30d_aligned) || 0,
    // First-touch attribution (users acquired via TP)
    ga4_ft_revenue: parseFloat(ga4.ga4_ft_revenue_30d) || 0,
    ga4_ft_transactions: parseInt(ga4.ga4_ft_transactions_30d) || 0,
    // Cross-session value (TP-acquired users converting from other sources)
    ga4_cross_session_revenue: parseFloat(ga4.ga4_cross_session_revenue_30d) || 0,
    ga4_cross_session_transactions: parseInt(ga4.ga4_cross_session_transactions_30d) || 0,
    // In-session cross-sell
    ga4_assisted_sales: parseInt(ga4.ga4_assisted_sales_90d) || 0,
    ga4_assisted_revenue: parseFloat(ga4.ga4_assisted_revenue_90d) || 0,
    // Feed engine data (from last run)
    feed_current_cost_14d: ga4.feed_current_cost_14d || '0',
    feed_current_revenue_14d: ga4.feed_current_revenue_14d || '0',
    feed_projected_cost_14d: ga4.feed_projected_cost_14d || '0',
    feed_projected_revenue_14d: ga4.feed_projected_revenue_14d || '0',
    feed_savings_from_removals: ga4.feed_savings_from_removals || '0',
    feed_action_removals: ga4.feed_action_removals || '0',
    feed_action_price_cuts: ga4.feed_action_price_cuts || '0',
    feed_action_additions: ga4.feed_action_additions || '0',
    feed_last_run: ga4.feed_last_run || null,
  };
}

/**
 * Get weekly breakdown (4 rolling weeks)
 */
async function getWeeklyBreakdown(tenantId) {
  const { rows } = await pool.query(`
    WITH weeks AS (
      SELECT generate_series(
        date_trunc('week', CURRENT_DATE - INTERVAL '3 weeks'),
        date_trunc('week', CURRENT_DATE),
        '1 week'::interval
      )::date as week_start
    ),
    weekly_clicks AS (
      SELECT
        date_trunc('week', fetch_date)::date as week_start,
        SUM(clicks) as total_clicks
      FROM zombie_clicks
      WHERE tenant_id = $1
        AND fetch_date >= CURRENT_DATE - INTERVAL '4 weeks'
      GROUP BY date_trunc('week', fetch_date)
    ),
    weekly_revenue AS (
      SELECT
        date_trunc('week', o.order_date)::date as week_start,
        COUNT(DISTINCT o.id) as orders,
        SUM(oi.row_total) as revenue
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1
        AND o.order_status IN ('complete', 'processing')
        AND o.order_date >= CURRENT_DATE - INTERVAL '4 weeks'
      GROUP BY date_trunc('week', o.order_date)
    )
    SELECT
      w.week_start,
      (w.week_start + 6)::date as week_end,
      COALESCE(wc.total_clicks, 0)::int as clicks,
      COALESCE(wr.orders, 0)::int as orders,
      COALESCE(wr.revenue, 0)::numeric as revenue
    FROM weeks w
    LEFT JOIN weekly_clicks wc ON wc.week_start = w.week_start
    LEFT JOIN weekly_revenue wr ON wr.week_start = w.week_start
    ORDER BY w.week_start DESC
  `, [tenantId]);

  // Load CPC from config
  const config = await loadConfig(tenantId);
  const cpc = config.avgCpc;

  // Query GA4 for weekly TP revenue (purchaseRevenue - shippingAmount per week)
  let ga4WeeklyTp = {};
  let ga4WeeklyStore = {};
  try {
    const { googleApiService } = require('./googleApi');
    const hasGA4 = await googleApiService.hasGA4Credentials(tenantId);
    if (hasGA4) {
      const client = await googleApiService.getGA4Client(tenantId);
      const propertyId = await googleApiService.getGA4PropertyId(tenantId);

      // TP revenue per week (trovaprezzi sessions)
      const [tpWeekly] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'isoYearIsoWeek' }],
        metrics: [
          { name: 'purchaseRevenue' },
          { name: 'transactions' },
          { name: 'shippingAmount' },
        ],
        dimensionFilter: {
          filter: {
            fieldName: 'sessionSource',
            stringFilter: { matchType: 'CONTAINS', value: 'trovaprezzi', caseSensitive: false },
          },
        },
      });

      for (const row of (tpWeekly.rows || [])) {
        const yw = row.dimensionValues[0].value; // e.g. "202611"
        const grossRev = parseFloat(row.metricValues[0].value) || 0;
        const shipping = parseFloat(row.metricValues[2]?.value) || 0;
        ga4WeeklyTp[yw] = {
          revenue: Math.max(0, grossRev - shipping),
          transactions: parseInt(row.metricValues[1].value) || 0,
        };
      }

      // Total store revenue per week (all channels)
      const [storeWeekly] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'isoYearIsoWeek' }],
        metrics: [
          { name: 'purchaseRevenue' },
          { name: 'transactions' },
          { name: 'shippingAmount' },
        ],
      });

      for (const row of (storeWeekly.rows || [])) {
        const yw = row.dimensionValues[0].value;
        const grossRev = parseFloat(row.metricValues[0].value) || 0;
        const shipping = parseFloat(row.metricValues[2]?.value) || 0;
        ga4WeeklyStore[yw] = {
          revenue: Math.max(0, grossRev - shipping),
          transactions: parseInt(row.metricValues[1].value) || 0,
        };
      }
    }
  } catch (err) {
    console.error('[Health] GA4 weekly query error:', err.message);
  }

  // Helper: convert week_start date to isoYearIsoWeek format (e.g. "202611")
  function toIsoYearWeek(dateStr) {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const weekNo = Math.round(((d - yearStart) / 86400000 + 1) / 7) + 1;
    return `${d.getUTCFullYear()}${String(weekNo).padStart(2, '0')}`;
  }

  return rows.map(w => {
    const clickCost = w.clicks * cpc;
    const storeRevenue = parseFloat(w.revenue) || 0;
    const yw = toIsoYearWeek(w.week_start);
    const tpData = ga4WeeklyTp[yw] || { revenue: 0, transactions: 0 };
    const storeGA4 = ga4WeeklyStore[yw] || null;
    const tpRevenue = tpData.revenue;
    // Incidenza = costo click / fatturato TP
    const incidence = tpRevenue > 0 ? clickCost / tpRevenue : 0;

    return {
      week_start: w.week_start,
      week_end: w.week_end,
      clicks: w.clicks,
      click_cost: +clickCost.toFixed(2),
      orders: w.orders,
      store_revenue: storeGA4 ? +storeGA4.revenue.toFixed(2) : +storeRevenue.toFixed(2),
      tp_revenue: +tpRevenue.toFixed(2),
      tp_transactions: tpData.transactions,
      incidence: +incidence.toFixed(4),
      store_source: storeGA4 ? 'ga4' : 'orders',
    };
  });
}

module.exports = {
  computeHealthScores,
  getGlobalPnl,
  getWeeklyBreakdown,
  loadConfig,
};
