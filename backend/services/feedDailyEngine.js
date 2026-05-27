/**
 * Feed Daily Engine v3
 *
 * Logica giornaliera basata su dati reali:
 * 1. Ogni giorno a mezzanotte scarica click di ieri
 * 2. Per ogni prodotto cliccato: click × CPC vs margine ordini
 * 3. Accumula "conto corrente" giorno per giorno
 * 4. Decisioni basate su budget globale + classificazione prodotto
 *
 * Fasi:
 * FASE 1: Fotografia globale (budget, revenue, incidenza)
 * FASE 2: Tracking giornaliero (conto corrente per prodotto)
 * FASE 3: Killer detection (cross-seller, 0 domanda globale)
 * FASE 4: Triage prodotti (via subito, sotto osservazione, price cut, keep)
 * FASE 5: Ribilanciamento (budget risparmiato → pepite)
 */

const { pool } = require('../db/pool');
const { calculateCompetitivePriceCut } = require('./feedPriceOptimizer');

const DEFAULT_CPC = 0.27; // EUR per click (netto, IVA esclusa)

// Calculate price cut respecting margin brackets:
// <€10 → min 18% ricarico, €10-30 → min 14%, >€30 → min 12%
function calculatePriceCut(sellPrice, erpCost, bestPrice) {
  if (!sellPrice || !erpCost || sellPrice <= erpCost) return null;
  if (!bestPrice || bestPrice <= 0 || sellPrice <= bestPrice) return null;

  const minMarkup = sellPrice < 10 ? 0.18 : sellPrice < 30 ? 0.14 : 0.12;
  const floor = erpCost * (1 + minMarkup);
  // Target: match best price - 1%, but not below floor
  const target = Math.max(bestPrice * 0.99, floor);
  if (target >= sellPrice) return null; // Can't cut enough
  if (sellPrice - target < 0.10) return null; // Cut too small

  const newMarginPct = ((target - erpCost) / target) * 100;
  const cutPct = ((sellPrice - target) / sellPrice) * 100;
  return {
    targetPrice: Math.round(target * 100) / 100,
    newMarginPct: Math.round(newMarginPct * 10) / 10,
    cutPct: Math.round(cutPct * 10) / 10,
  };
}

// ─── CONFIG ────────────────────────────────────────────

async function loadConfig(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM health_config WHERE tenant_id = $1`,
    [tenantId]
  );
  const c = {};
  rows.forEach(r => c[r.config_key] = r.config_value);
  return {
    cpc: parseFloat(c.avg_tp_cpc || DEFAULT_CPC),
    targetIncidenceMax: parseFloat(c.tp_target_incidence_max || 5),
    monthlyBudget: parseFloat(c.feed_monthly_budget || 2600),
    observationDays: parseInt(c.feed_observation_days || 3),
    // Quarantine escalation
    q1Days: parseInt(c.feed_q1_days || 7),
    q2Days: parseInt(c.feed_q2_days || 15),
    q3Days: parseInt(c.feed_q3_days || 30),
  };
}

// ─── FASE 1: FOTOGRAFIA GLOBALE ────────────────────────

async function buildGlobalSnapshot(tenantId, config) {
  // Range date dei zombie clicks (= periodo TP attivo)
  const { rows: [dateRange] } = await pool.query(`
    SELECT MIN(fetch_date) as first_day, MAX(fetch_date) as last_day,
           COUNT(DISTINCT fetch_date) as days_active,
           SUM(clicks) as total_clicks
    FROM zombie_clicks WHERE tenant_id = $1
  `, [tenantId]);

  if (!dateRange.first_day) return null;

  const firstDay = dateRange.first_day.toISOString().slice(0, 10);
  const lastDay = dateRange.last_day.toISOString().slice(0, 10);
  const totalClicks = parseInt(dateRange.total_clicks) || 0;
  const totalCost = totalClicks * config.cpc;

  // Revenue source: 'ga4' (solo sessioni TP) o 'magento' (tutti ordini store)
  const { rows: [revSrcRow] } = await pool.query(
    "SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'revenue_source'",
    [tenantId]
  );
  const revenueSource = revSrcRow?.config_value || 'magento';

  let totalRevenue, totalOrders;

  if (revenueSource === 'ga4') {
    // GA4: solo revenue attribuita a sessioni trovaprezzi
    const ga4Rev = parseFloat((await pool.query(
      "SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'ga4_tp_revenue_30d'", [tenantId]
    )).rows[0]?.config_value) || 0;
    const ga4Tx = parseInt((await pool.query(
      "SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'ga4_tp_transactions_30d'", [tenantId]
    )).rows[0]?.config_value) || 0;
    // Apply tracking correction if configured (e.g. 1.53 = +53% undertracking)
    const trackingCorrection = parseFloat((await pool.query(
      "SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'ga4_tracking_correction'", [tenantId]
    )).rows[0]?.config_value) || 1.0;
    totalRevenue = ga4Rev * trackingCorrection;
    totalOrders = Math.round(ga4Tx * trackingCorrection);
    if (trackingCorrection !== 1.0) {
      console.log(`[FeedDaily] GA4 tracking correction: x${trackingCorrection} → revenue €${ga4Rev.toFixed(2)} → €${totalRevenue.toFixed(2)}`);
    }
  } else {
    // Magento: tutti ordini store nel periodo TP attivo
    const { rows: [orderData] } = await pool.query(`
      SELECT COUNT(DISTINCT o.id) as order_count,
             COALESCE(SUM(oi.row_total), 0) as revenue
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1
        AND o.order_date >= $2::date
        AND o.order_date < ($3::date + INTERVAL '1 day')
    `, [tenantId, firstDay, lastDay]);
    totalRevenue = parseFloat(orderData.revenue) || 0;
    totalOrders = parseInt(orderData.order_count) || 0;
  }

  const incidence = totalRevenue > 0 ? (totalCost / totalRevenue * 100) : 999;

  return {
    firstDay, lastDay,
    daysActive: parseInt(dateRange.days_active),
    totalClicks, totalCost,
    totalOrders, totalRevenue,
    incidence,
    dailyAvgCost: totalCost / parseInt(dateRange.days_active),
    budgetRemaining: config.monthlyBudget - totalCost,
    overTarget: incidence > config.targetIncidenceMax,
  };
}

// ─── FASE 2: TRACKING GIORNALIERO ─────────────────────

async function updateDailyTracking(tenantId, config) {
  // Get all dates with zombie data
  const { rows: dates } = await pool.query(`
    SELECT DISTINCT fetch_date FROM zombie_clicks
    WHERE tenant_id = $1 ORDER BY fetch_date
  `, [tenantId]);

  let processed = 0;

  for (const { fetch_date } of dates) {
    const dateStr = fetch_date.toISOString().slice(0, 10);

    // Check if already tracked
    const { rows: existing } = await pool.query(
      `SELECT id FROM feed_daily_tracking WHERE tenant_id = $1 AND track_date = $2 LIMIT 1`,
      [tenantId, dateStr]
    );
    if (existing.length > 0) continue;

    // Get clicks for this date
    const { rows: clicks } = await pool.query(`
      SELECT zc.product_code as sku, zc.clicks,
             p.margin, p.margin_pct, p.erp_stock, p.supplier_stock,
             p.sales_30d_aggregated, p.is_civetta,
             phs.scraper_position, phs.scraper_competitor_count
      FROM zombie_clicks zc
      JOIN products p ON p.sku = zc.product_code AND p.tenant_id = zc.tenant_id
      LEFT JOIN product_health_scores phs ON phs.sku = zc.product_code AND phs.tenant_id = zc.tenant_id
      WHERE zc.tenant_id = $1 AND zc.fetch_date = $2
    `, [tenantId, dateStr]);

    // Get orders for this date (margin from product catalog, not order_items)
    const { rows: orders } = await pool.query(`
      SELECT oi.sku, COUNT(DISTINCT o.id) as order_count,
             SUM(oi.row_total) as revenue,
             SUM(COALESCE(p2.margin, 0) * oi.qty_ordered) as margin_earned
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p2 ON p2.sku = oi.sku AND p2.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1
        AND o.order_date >= $2::date
        AND o.order_date < ($2::date + INTERVAL '1 day')
      GROUP BY oi.sku
    `, [tenantId, dateStr]);

    const orderMap = new Map(orders.map(o => [o.sku, o]));

    // Get previous cumulative balances
    const { rows: prevBalances } = await pool.query(`
      SELECT sku, cumulative_balance
      FROM feed_daily_tracking
      WHERE tenant_id = $1 AND track_date = (
        SELECT MAX(track_date) FROM feed_daily_tracking
        WHERE tenant_id = $1 AND track_date < $2
      )
    `, [tenantId, dateStr]);
    const prevBalanceMap = new Map(prevBalances.map(r => [r.sku, parseFloat(r.cumulative_balance)]));

    // Build daily tracking records
    const values = [];
    const params = [];
    let idx = 1;

    for (const c of clicks) {
      const clickCost = c.clicks * config.cpc;
      const order = orderMap.get(c.sku);
      const orderCount = order ? parseInt(order.order_count) : 0;
      const revenue = order ? parseFloat(order.revenue) : 0;
      const marginEarned = order ? parseFloat(order.margin_earned) : 0;
      const dailyBalance = marginEarned - clickCost;
      const prevBal = prevBalanceMap.get(c.sku) || 0;
      const cumulativeBalance = prevBal + dailyBalance;

      const stockSource = (parseFloat(c.erp_stock) || 0) > 0
        ? ((parseFloat(c.supplier_stock) || 0) > 0 ? 'both' : 'erp')
        : ((parseFloat(c.supplier_stock) || 0) > 0 ? 'supplier' : 'none');

      values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9},$${idx+10},$${idx+11},$${idx+12},$${idx+13},$${idx+14})`);
      params.push(
        tenantId, c.sku, dateStr,
        c.clicks, clickCost,
        orderCount, revenue, marginEarned,
        dailyBalance, cumulativeBalance,
        stockSource, parseFloat(c.margin_pct) || 0,
        c.scraper_position, c.scraper_competitor_count,
        parseFloat(c.sales_30d_aggregated) || 0
      );
      idx += 15;

      // Batch insert every 200
      if (values.length >= 200) {
        await pool.query(`
          INSERT INTO feed_daily_tracking
            (tenant_id, sku, track_date, clicks, click_cost, orders, revenue, margin_earned,
             daily_balance, cumulative_balance, stock_source, margin_pct,
             scraper_position, competitor_count, sales_30d_aggregated)
          VALUES ${values.join(',')}
          ON CONFLICT (tenant_id, sku, track_date) DO UPDATE SET
            clicks = EXCLUDED.clicks, click_cost = EXCLUDED.click_cost,
            orders = EXCLUDED.orders, revenue = EXCLUDED.revenue,
            margin_earned = EXCLUDED.margin_earned,
            daily_balance = EXCLUDED.daily_balance,
            cumulative_balance = EXCLUDED.cumulative_balance
        `, params);
        values.length = 0;
        params.length = 0;
        idx = 1;
      }
    }

    // Flush remaining
    if (values.length > 0) {
      await pool.query(`
        INSERT INTO feed_daily_tracking
          (tenant_id, sku, track_date, clicks, click_cost, orders, revenue, margin_earned,
           daily_balance, cumulative_balance, stock_source, margin_pct,
           scraper_position, competitor_count, sales_30d_aggregated)
        VALUES ${values.join(',')}
        ON CONFLICT (tenant_id, sku, track_date) DO UPDATE SET
          clicks = EXCLUDED.clicks, click_cost = EXCLUDED.click_cost,
          orders = EXCLUDED.orders, revenue = EXCLUDED.revenue,
          margin_earned = EXCLUDED.margin_earned,
          daily_balance = EXCLUDED.daily_balance,
          cumulative_balance = EXCLUDED.cumulative_balance
      `, params);
    }

    processed += clicks.length;
  }

  return { processed };
}

// ─── FASE 3: KILLER DETECTION ──────────────────────────

async function detectKillers(tenantId) {
  // Killer = prodotti con molti seller su TP, tutti prendono click,
  // ma venduto globale = 0 → nessuno li compra online
  const { rows: killers } = await pool.query(`
    SELECT p.sku, p.product_name,
      phs.scraper_competitor_count as sellers,
      COALESCE(p.sales_30d_aggregated, 0) as global_demand,
      phs.scraper_position as our_position,
      SUM(zc.clicks) as our_clicks,
      ROUND(SUM(zc.clicks) * $2::numeric, 2) as our_cost
    FROM products p
    JOIN product_health_scores phs ON phs.sku = p.sku AND phs.tenant_id = p.tenant_id
    JOIN zombie_clicks zc ON zc.product_code = p.sku AND zc.tenant_id = p.tenant_id
    LEFT JOIN feed_killers fk ON fk.sku = p.sku AND fk.tenant_id = p.tenant_id AND fk.is_active = true
    WHERE p.tenant_id = $1
      AND p.is_civetta = true
      AND phs.scraper_competitor_count >= 8
      AND COALESCE(p.sales_30d_aggregated, 0) <= 1
      AND COALESCE(p.sales_30d_seller, 0) = 0
      AND fk.id IS NULL
    GROUP BY p.sku, p.product_name, phs.scraper_competitor_count,
             p.sales_30d_aggregated, phs.scraper_position
    HAVING SUM(zc.clicks) >= 2
    ORDER BY SUM(zc.clicks) DESC
  `, [tenantId, DEFAULT_CPC]);

  let inserted = 0;
  for (const k of killers) {
    await pool.query(`
      INSERT INTO feed_killers (tenant_id, sku, total_sellers, global_demand, avg_position, reason, quarantine_until)
      VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '30 days')
      ON CONFLICT (tenant_id, sku) DO UPDATE SET
        total_sellers = $3, global_demand = $4, reason = $6,
        quarantine_until = NOW() + INTERVAL '30 days', is_active = true, detected_at = NOW()
    `, [
      tenantId, k.sku, k.sellers, k.global_demand, k.our_position,
      `Killer: ${k.sellers} seller su TP, 0 vendite globali, ${k.our_clicks} click nostri (€${k.our_cost} sprecati)`
    ]);
    inserted++;
  }

  console.log(`[FeedDaily] Killers detected: ${inserted} new (${killers.length} total candidates)`);
  return { detected: inserted, candidates: killers.length };
}

// ─── FASE 4: TRIAGE PRODOTTI ───────────────────────────

async function triageProducts(tenantId, config, snapshot, ruleSet = null) {
  if (!snapshot) return { actions: {}, stats: {} };

  // Get product "conto corrente" aggregato su tutto il periodo TP attivo
  const { rows: products } = await pool.query(`
    WITH product_totals AS (
      SELECT sku,
        SUM(clicks) as total_clicks,
        SUM(click_cost) as total_cost,
        SUM(orders) as total_orders,
        SUM(revenue) as total_revenue,
        SUM(margin_earned) as total_margin,
        SUM(daily_balance) as total_balance,
        COUNT(DISTINCT track_date) as days_with_clicks,
        MIN(track_date) as first_click_date,
        MAX(track_date) as last_click_date,
        -- Last known context
        (array_agg(stock_source ORDER BY track_date DESC))[1] as stock_source,
        (array_agg(margin_pct ORDER BY track_date DESC))[1] as margin_pct,
        (array_agg(scraper_position ORDER BY track_date DESC))[1] as position,
        (array_agg(competitor_count ORDER BY track_date DESC))[1] as competitors,
        (array_agg(sales_30d_aggregated ORDER BY track_date DESC))[1] as demand
      FROM feed_daily_tracking
      WHERE tenant_id = $1
      GROUP BY sku
    )
    SELECT pt.*,
      p.product_name, p.is_civetta, p.erp_stock, p.supplier_stock,
      p.sell_price, p.erp_cost, p.margin as margin_eur,
      p.sales_30d_seller, p.price_rule_id,
      phs.ga4_tp_purchases, phs.ga4_assisted_sales,
      phs.mc_click_potential, phs.classification,
      phs.scraper_best_price,
      fk.id as is_killer,
      fq.id as is_quarantined, fq.quarantine_level
    FROM product_totals pt
    JOIN products p ON p.sku = pt.sku AND p.tenant_id = $1
    LEFT JOIN product_health_scores phs ON phs.sku = pt.sku AND phs.tenant_id = $1
    LEFT JOIN feed_killers fk ON fk.sku = pt.sku AND fk.tenant_id = $1 AND fk.is_active = true
    LEFT JOIN feed_quarantine fq ON fq.sku = pt.sku AND fq.tenant_id = $1 AND fq.reactivated = false
    LEFT JOIN price_rules pr ON pr.rule_id = p.price_rule_id AND pr.tenant_id = $1
    ORDER BY pt.total_cost DESC
  `, [tenantId]);

  const actions = { remove: [], keep: [], priceCut: [], monitor: [], add: [] };
  // Products with rule_type 'sconto' cannot have price cuts (prezzo imposto)
  // Extended by tenant rules via ruleSet
  const isSconto = (p) => p.rule_type === 'sconto';
  const canCutPrice = (p) => !isSconto(p) && (!ruleSet || ruleSet.canPriceCut(p));
  const canRemoveProduct = (p) => !ruleSet || ruleSet.canRemove(p);
  const stats = { totalProducts: products.length, killers: 0, bruciatori: 0, potenziali: 0, convertitori: 0, fantasmi: 0 };

  const daysActive = snapshot.daysActive;

  for (const p of products) {
    const totalCost = parseFloat(p.total_cost) || 0;
    const totalRevenue = parseFloat(p.total_revenue) || 0;
    const totalOrders = parseInt(p.total_orders) || 0;
    const totalClicks = parseInt(p.total_clicks) || 0;
    const daysClicked = parseInt(p.days_with_clicks) || 0;
    const demand = parseFloat(p.demand) || 0;
    const position = p.position;
    const stockSource = p.stock_source || 'supplier';
    const marginPct = parseFloat(p.margin_pct) || 0;
    const hasSalesStore = (parseFloat(p.sales_30d_seller) || 0) > 0;
    const hasGA4Orders = (parseInt(p.ga4_tp_purchases) || 0) > 0;
    const hasAssistedSales = (parseInt(p.ga4_assisted_sales) || 0) > 0;

    // Already quarantined → still emit as REMOVE (Farmabooster needs to know)
    if (p.is_quarantined) {
      actions.remove.push({
        sku: p.sku, name: p.product_name, action: 'REMOVE',
        reason: `In quarantena Q${p.quarantine_level}`,
        category: 'quarantined', cost: totalCost, clicks: totalClicks,
      });
      continue;
    }

    // A) KILLER — via subito
    if (p.is_killer) {
      actions.remove.push({
        sku: p.sku, name: p.product_name, action: 'REMOVE',
        reason: `KILLER: ${p.competitors} seller, 0 vendite globali, ${totalClicks} click, €${totalCost.toFixed(2)} sprecati`,
        category: 'killer', cost: totalCost, clicks: totalClicks,
        quarantineDays: 30,
      });
      stats.killers++;
      continue;
    }

    // D) CONVERTITORE — ha ordini nel periodo
    if (totalOrders > 0 || hasGA4Orders || hasAssistedSales) {
      const productIncidence = totalRevenue > 0 ? (totalCost / totalRevenue * 100) : 0;

      if (productIncidence > 10 && position > 3 && canCutPrice(p)) {
        // Converte ma con incidenza alta → valuta price cut (skip regola Sconto + tenant rules)
        const sellPrice = parseFloat(p.sell_price) || 0;
        const erpCost = parseFloat(p.erp_cost) || 0;
        const bestPrice = parseFloat(p.scraper_best_price) || 0;
        const pc = calculatePriceCut(sellPrice, erpCost, bestPrice);
        actions.priceCut.push({
          sku: p.sku, name: p.product_name, action: 'PRICE_CUT',
          reason: `Converte (${totalOrders} ordini) ma incidenza ${productIncidence.toFixed(0)}%, pos ${position}`,
          category: 'convertitore_costoso', cost: totalCost, revenue: totalRevenue,
          clicks: totalClicks, orders: totalOrders, position,
          currentPrice: pc ? sellPrice : null,
          recommendedPrice: pc ? pc.targetPrice : null,
          priceCutPct: pc ? pc.cutPct : null,
          newMarginPct: pc ? pc.newMarginPct : null,
        });
      } else {
        actions.keep.push({
          sku: p.sku, name: p.product_name, action: 'KEEP',
          reason: `Convertitore: ${totalOrders} ordini, €${totalRevenue.toFixed(2)} rev, incidenza ${productIncidence.toFixed(0)}%`,
          category: 'convertitore', cost: totalCost, revenue: totalRevenue,
        });
      }
      stats.convertitori++;
      continue;
    }

    // Prodotti con click ma 0 ordini — valuta dopo periodo di osservazione
    if (daysClicked < config.observationDays) {
      actions.monitor.push({
        sku: p.sku, name: p.product_name, action: 'MONITOR',
        reason: `In osservazione (${daysClicked}/${config.observationDays} giorni), ${totalClicks} click, €${totalCost.toFixed(2)}`,
        category: 'osservazione', cost: totalCost, clicks: totalClicks, daysClicked,
      });
      continue;
    }

    // Dopo il periodo di osservazione: calcola score "diritto a restare"
    let stayScore = 0;
    const stayReasons = [];

    if (demand >= 5) { stayScore += 2; stayReasons.push(`domanda globale ${demand}`); }
    else if (demand >= 2) { stayScore += 1; stayReasons.push(`domanda ${demand}`); }

    if (stockSource === 'erp' || stockSource === 'both') { stayScore += 1; stayReasons.push('stock ERP'); }
    // Supplier-only penalty: margine più basso, soglia più stretta
    if (stockSource === 'supplier' && marginPct < 16) { stayScore -= 1; stayReasons.push('supplier basso margine'); }

    if (position && position <= 3) { stayScore += 2; stayReasons.push(`pos ${position}`); }
    else if (position && position <= 7) { stayScore += 1; stayReasons.push(`pos ${position}`); }

    if (hasSalesStore) { stayScore += 2; stayReasons.push('vende in store'); }

    if (p.mc_click_potential === 'HIGH') { stayScore += 1; stayReasons.push('MC HIGH'); }

    // B) BRUCIATORE PURO — score basso, via
    if (stayScore <= 1) {
      actions.remove.push({
        sku: p.sku, name: p.product_name, action: 'REMOVE',
        reason: `Bruciatore: ${totalClicks} click in ${daysClicked}gg, 0 ordini, score=${stayScore}. €${totalCost.toFixed(2)} sprecati`,
        category: 'bruciatore', cost: totalCost, clicks: totalClicks,
        stayScore, quarantineDays: config.q1Days,
      });
      stats.bruciatori++;
      continue;
    }

    // C) POTENZIALE NON SFRUTTATO — score medio-alto, valuta intervento
    if (stayScore >= 4) {
      // Ha buoni segnali, teniamolo ancora
      actions.keep.push({
        sku: p.sku, name: p.product_name, action: 'KEEP',
        reason: `Potenziale alto (score=${stayScore}): ${stayReasons.join(', ')}. ${totalClicks} click, da monitorare`,
        category: 'potenziale_alto', cost: totalCost, clicks: totalClicks, stayScore,
      });
      stats.potenziali++;
    } else if (position && position > 3 && position <= 7 && canCutPrice(p)) {
      // Score 2-3, posizione media → price cut per salire (skip regola Sconto + tenant rules)
      const sellPrice = parseFloat(p.sell_price) || 0;
      const erpCost = parseFloat(p.erp_cost) || 0;
      const bestPrice = parseFloat(p.scraper_best_price) || 0;
      const pc = calculatePriceCut(sellPrice, erpCost, bestPrice);
      actions.priceCut.push({
        sku: p.sku, name: p.product_name, action: 'PRICE_CUT',
        reason: `Potenziale (score=${stayScore}): ${stayReasons.join(', ')}. Pos ${position}, taglio prezzo per migliorare`,
        category: 'potenziale_price_cut', cost: totalCost, clicks: totalClicks,
        stayScore, position,
        currentPrice: pc ? sellPrice : null,
        recommendedPrice: pc ? pc.targetPrice : null,
        priceCutPct: pc ? pc.cutPct : null,
        newMarginPct: pc ? pc.newMarginPct : null,
      });
      stats.potenziali++;
    } else if (snapshot.overTarget) {
      // Score 2-3 ma incidenza globale sopra target → rimuovi
      actions.remove.push({
        sku: p.sku, name: p.product_name, action: 'REMOVE',
        reason: `Incidenza globale ${snapshot.incidence.toFixed(1)}% > target ${config.targetIncidenceMax}%. Score=${stayScore}, non sufficiente`,
        category: 'budget_cut', cost: totalCost, clicks: totalClicks,
        stayScore, quarantineDays: config.q1Days,
      });
      stats.bruciatori++;
    } else {
      // Score 2-3, incidenza ok → monitor
      actions.monitor.push({
        sku: p.sku, name: p.product_name, action: 'MONITOR',
        reason: `Score=${stayScore} (${stayReasons.join(', ')}), ${totalClicks} click. Incidenza ok, monitorare`,
        category: 'potenziale_monitor', cost: totalCost, clicks: totalClicks, stayScore,
      });
      stats.potenziali++;
    }
  }

  return { actions, stats };
}

// ─── FASE 4b: PRICE CUT PER CIVETTA=1 ZERO CLICK CON DOMANDA ────

async function findPriceCutCandidates(tenantId, config, snapshot) {
  if (!snapshot) return [];

  // Prodotti civetta=1 che non ricevono click ma hanno domanda
  // Il prezzo è troppo alto → taglio per renderli competitivi
  const { rows: candidates } = await pool.query(`
    SELECT p.sku, p.product_name,
      ROUND(p.sell_price::numeric, 2) as sell_price,
      ROUND(p.erp_cost::numeric, 2) as erp_cost,
      ROUND(p.margin_pct::numeric, 1) as margin_pct,
      p.sales_30d_seller, p.sales_30d_aggregated,
      p.erp_stock, p.supplier_stock,
      phs.scraper_position, phs.scraper_competitor_count,
      ROUND(phs.scraper_best_price::numeric, 2) as best_price,
      phs.mc_click_potential, phs.mc_impressions_14d,
      p.price_rule_id, pr.rule_type
    FROM products p
    JOIN product_health_scores phs ON phs.sku = p.sku AND phs.tenant_id = p.tenant_id
    LEFT JOIN feed_killers fk ON fk.sku = p.sku AND fk.tenant_id = p.tenant_id AND fk.is_active = true
    LEFT JOIN price_rules pr ON pr.rule_id = p.price_rule_id AND pr.tenant_id = p.tenant_id
    WHERE p.tenant_id = $1
      AND p.is_civetta = true
      AND p.saleable = true
      AND COALESCE(p.margin_pct, 0) >= 8
      AND phs.tp_clicks_30d = 0
      AND fk.id IS NULL
      AND phs.scraper_best_price IS NOT NULL
      AND phs.scraper_best_price > 0
      AND p.sell_price > phs.scraper_best_price * 1.05
      AND (pr.rule_type IS NULL OR pr.rule_type != 'sconto')
      AND (
        COALESCE(p.sales_30d_aggregated, 0) >= 5
        OR COALESCE(p.sales_30d_seller, 0) >= 2
        OR COALESCE(phs.mc_impressions_14d, 0) >= 50
      )
    ORDER BY p.sales_30d_aggregated DESC
    LIMIT 300
  `, [tenantId]);

  const priceCuts = [];

  for (const c of candidates) {
    const sellPrice = parseFloat(c.sell_price);
    const erpCost = parseFloat(c.erp_cost) || 0;
    const bestPrice = parseFloat(c.best_price);
    if (!bestPrice || bestPrice <= 0 || erpCost <= 0) continue;

    // Margine minimo per fascia (regola utente)
    // <10€ → 18%, 10-30€ → 14%, >30€ → 12%
    let minMarginPct;
    if (sellPrice < 10) minMarginPct = 18;
    else if (sellPrice <= 30) minMarginPct = 14;
    else minMarginPct = 12;

    const floorPrice = erpCost * (1 + minMarginPct / 100);
    // Target: match best price -1% (ma non sotto floor)
    const targetPrice = Math.max(bestPrice * 0.99, floorPrice);

    // Solo se il taglio è significativo (> 0.50€) e il target è sotto il prezzo attuale
    if (targetPrice >= sellPrice - 0.50) continue;
    // E il gap col best non è troppo alto (max 25% sotto il nostro prezzo)
    if (targetPrice < sellPrice * 0.75) continue;

    const newMarginPct = erpCost > 0 ? ((targetPrice - erpCost) / targetPrice * 100) : 0;
    if (newMarginPct < minMarginPct) continue;

    priceCuts.push({
      sku: c.sku, name: c.product_name, action: 'PRICE_CUT',
      reason: `Zero click, domanda ${c.sales_30d_aggregated}, pos ${c.scraper_position}/${c.scraper_competitor_count}. Prezzo ${sellPrice} vs best ${bestPrice}. Taglio a ${targetPrice.toFixed(2)} (margine ${newMarginPct.toFixed(0)}%)`,
      category: 'zero_click_demand',
      currentPrice: sellPrice,
      recommendedPrice: Math.round(targetPrice * 100) / 100,
      priceCutPct: ((sellPrice - targetPrice) / sellPrice * 100),
      newMarginPct,
      position: c.scraper_position,
      demand: parseFloat(c.sales_30d_aggregated),
    });
  }

  console.log(`[FeedDaily] Price cuts for zero-click with demand: ${priceCuts.length} candidates`);
  return priceCuts;
}

// ─── FASE 5: RIBILANCIAMENTO (PEPITE) ─────────────────

async function findPepite(tenantId, config, snapshot, removedCost) {
  if (!snapshot || snapshot.overTarget) return []; // Non aggiungere se siamo sopra target

  const availableBudget = removedCost * 0.5; // Usa il 50% del risparmio
  if (availableBudget < 5) return [];

  const { rows: pepite } = await pool.query(`
    SELECT p.sku, p.product_name,
      ROUND(p.sell_price::numeric, 2) as sell_price,
      ROUND(p.margin_pct::numeric, 1) as margin_pct,
      p.sales_30d_seller, p.sales_30d_aggregated,
      p.erp_stock, p.supplier_stock,
      phs.scraper_position, phs.scraper_competitor_count,
      ROUND(phs.scraper_best_price::numeric, 2) as best_price,
      phs.mc_click_potential, phs.health_score,
      p.price_rule_id
    FROM products p
    JOIN product_health_scores phs ON phs.sku = p.sku AND phs.tenant_id = p.tenant_id
    LEFT JOIN feed_killers fk ON fk.sku = p.sku AND fk.tenant_id = p.tenant_id AND fk.is_active = true
    LEFT JOIN feed_quarantine fq ON fq.sku = p.sku AND fq.tenant_id = p.tenant_id AND fq.reactivated = false
    WHERE p.tenant_id = $1
      AND (p.is_civetta = false OR p.is_civetta IS NULL)
      AND p.saleable = true
      AND COALESCE(p.margin_pct, 0) >= 8
      AND (COALESCE(p.erp_stock,0) + COALESCE(p.supplier_stock,0)) > 0
      AND COALESCE(p.sales_30d_aggregated, 0) >= 3
      AND fk.id IS NULL
      AND fq.id IS NULL
      AND phs.scraper_position BETWEEN 1 AND 5
    ORDER BY p.sales_30d_aggregated DESC, phs.health_score DESC
    LIMIT 50
  `, [tenantId]);

  return pepite.map(p => ({
    sku: p.sku, name: p.product_name, action: 'ADD',
    reason: `Pepita: venduto globale ${p.sales_30d_aggregated}, pos ${p.scraper_position}/${p.scraper_competitor_count}, margine ${p.margin_pct}%`,
    category: 'pepita',
    sellPrice: parseFloat(p.sell_price),
    marginPct: parseFloat(p.margin_pct),
    demand: parseFloat(p.sales_30d_aggregated),
    position: p.scraper_position,
  }));
}

// ─── FASE 6: SAVE DAILY SUMMARY ───────────────────────

async function saveDailySummary(tenantId, snapshot, actions, killerCount) {
  if (!snapshot) return;

  const today = new Date().toISOString().slice(0, 10);
  const removedCost = actions.remove.reduce((s, a) => s + (a.cost || 0), 0);

  await pool.query(`
    INSERT INTO feed_daily_summary
      (tenant_id, summary_date, total_clicks, total_cost, cumulative_cost, budget_remaining,
       total_orders, total_revenue, cumulative_revenue,
       daily_incidence, cumulative_incidence,
       products_with_clicks, products_with_orders,
       killers_detected, removed_count, added_count, price_cuts_count)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    ON CONFLICT (tenant_id, summary_date) DO UPDATE SET
      total_clicks = EXCLUDED.total_clicks, total_cost = EXCLUDED.total_cost,
      cumulative_cost = EXCLUDED.cumulative_cost, budget_remaining = EXCLUDED.budget_remaining,
      total_orders = EXCLUDED.total_orders, total_revenue = EXCLUDED.total_revenue,
      cumulative_revenue = EXCLUDED.cumulative_revenue,
      daily_incidence = EXCLUDED.daily_incidence, cumulative_incidence = EXCLUDED.cumulative_incidence,
      products_with_clicks = EXCLUDED.products_with_clicks, products_with_orders = EXCLUDED.products_with_orders,
      killers_detected = EXCLUDED.killers_detected,
      removed_count = EXCLUDED.removed_count, added_count = EXCLUDED.added_count, price_cuts_count = EXCLUDED.price_cuts_count
  `, [
    tenantId, today,
    snapshot.totalClicks, snapshot.totalCost, snapshot.totalCost, snapshot.budgetRemaining,
    snapshot.totalOrders, snapshot.totalRevenue, snapshot.totalRevenue,
    snapshot.incidence, snapshot.incidence,
    actions.remove.length + actions.keep.length + actions.priceCut.length + actions.monitor.length,
    actions.keep.filter(a => a.category === 'convertitore').length,
    killerCount,
    actions.remove.length, actions.add ? actions.add.length : 0, actions.priceCut.length,
  ]);
}

// ─── APPLY ACTIONS TO FEED ────────────────────────────

async function applyActions(tenantId, actions, config) {
  // Clear old feed_actions
  await pool.query(`DELETE FROM feed_actions WHERE tenant_id = $1`, [tenantId]);

  const allActions = [
    ...actions.remove.map(a => ({ ...a, action: 'REMOVE' })),
    ...actions.keep.map(a => ({ ...a, action: 'KEEP' })),
    ...actions.priceCut.map(a => ({ ...a, action: 'PRICE_CUT' })),
    ...actions.monitor.map(a => ({ ...a, action: 'MONITOR' })),
    ...(actions.add || []).map(a => ({ ...a, action: 'ADD' })),
  ];

  // Batch insert
  const BATCH = 200;
  for (let i = 0; i < allActions.length; i += BATCH) {
    const batch = allActions.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let idx = 1;

    for (const a of batch) {
      values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9},$${idx+10},$${idx+11},$${idx+12})`);
      params.push(
        tenantId, a.sku, a.action,
        (a.reason || '').substring(0, 500),
        (a.category || '').substring(0, 30),
        a.clicks || 0, a.cost || 0, a.position || 0, a.revenue || 0,
        a.action === 'REMOVE' ? false : ((a.orders || 0) > 0),
        a.currentPrice || null, a.recommendedPrice || null,
        a.priceCutPct || null
      );
      idx += 13;
    }

    if (values.length > 0) {
      await pool.query(`
        INSERT INTO feed_actions
          (tenant_id, sku, action, action_reason, action_source,
           clicks_consumed, cost_consumed, tp_position, direct_revenue,
           has_conversions, current_price, recommended_price, price_cut_pct)
        VALUES ${values.join(',')}
      `, params);
    }
  }

  // Apply quarantines for NEW REMOVE only (not already quarantined)
  for (const a of actions.remove) {
    if (a.category === 'quarantined') continue; // Already in quarantine
    const days = a.quarantineDays || config.q1Days;

    // Check existing quarantine level
    const { rows: prevQ } = await pool.query(
      `SELECT quarantine_level FROM feed_quarantine WHERE tenant_id = $1 AND sku = $2 ORDER BY quarantine_start DESC LIMIT 1`,
      [tenantId, a.sku]
    );
    const prevLevel = prevQ.length > 0 ? parseInt(prevQ[0].quarantine_level) : 0;
    const newLevel = Math.min(prevLevel + 1, 4);
    const qDays = newLevel === 1 ? config.q1Days : newLevel === 2 ? config.q2Days : newLevel === 3 ? config.q3Days : 365;

    await pool.query(`
      INSERT INTO feed_quarantine (tenant_id, sku, quarantine_level, reason, quarantine_start, quarantine_end)
      VALUES ($1, $2, $3, $4, NOW(), NOW() + ($5 || ' days')::interval)
      ON CONFLICT (tenant_id, sku) WHERE reactivated = false
      DO UPDATE SET quarantine_level = $3, reason = $4, quarantine_start = NOW(),
                    quarantine_end = NOW() + ($5 || ' days')::interval
    `, [tenantId, a.sku, newLevel, a.reason, qDays]);
  }

  return { total: allActions.length };
}

// ─── MAIN: RUN DAILY ENGINE ───────────────────────────

// Load tenant-specific rules from agent_tenant_rules
async function loadTenantRules(tenantId) {
  try {
    const { rows } = await pool.query(
      "SELECT rule_type, rule_config FROM agent_tenant_rules WHERE tenant_id = $1 AND is_active = true AND (expires_at IS NULL OR expires_at > NOW())",
      [tenantId]
    );
    return rows;
  } catch {
    return []; // Table might not exist yet
  }
}

function buildRuleSet(rules, priceRulesMap) {
  const excludedPriceRuleTypes = new Set();
  const excludedBrands = new Set();
  const protectedSkus = new Set();
  const excludedSkus = new Set();

  for (const rule of rules) {
    const cfg = typeof rule.rule_config === 'string' ? JSON.parse(rule.rule_config) : rule.rule_config;
    if (rule.rule_type === 'exclude_price_rule' && cfg.price_rule_type) {
      excludedPriceRuleTypes.add(cfg.price_rule_type);
    }
    if (rule.rule_type === 'exclude_brand' && cfg.brand) {
      excludedBrands.add(cfg.brand.toLowerCase());
    }
    if (rule.rule_type === 'protect_sku' && cfg.skus) {
      cfg.skus.forEach(s => protectedSkus.add(s));
    }
    if (rule.rule_type === 'exclude_sku' && cfg.skus) {
      cfg.skus.forEach(s => excludedSkus.add(s));
    }
  }

  return {
    canPriceCut(p) {
      if (p.rule_type && excludedPriceRuleTypes.has(p.rule_type)) return false;
      if (p.brand && excludedBrands.has(p.brand.toLowerCase())) return false;
      return true;
    },
    canRemove(p) {
      if (protectedSkus.has(p.sku)) return false;
      return true;
    },
    mustRemove(p) {
      return excludedSkus.has(p.sku);
    },
    isProtected(p) {
      return protectedSkus.has(p.sku);
    },
    summary() {
      return {
        excludedPriceRuleTypes: [...excludedPriceRuleTypes],
        excludedBrands: [...excludedBrands],
        protectedSkus: protectedSkus.size,
        excludedSkus: excludedSkus.size,
      };
    },
  };
}

async function runDailyFeedEngine(tenantId) {
  console.log(`[FeedDaily] Starting for tenant ${tenantId.slice(0, 8)}...`);

  const config = await loadConfig(tenantId);

  // Load tenant-specific rules
  const tenantRules = await loadTenantRules(tenantId);
  const ruleSet = buildRuleSet(tenantRules);
  if (tenantRules.length > 0) {
    console.log(`[FeedDaily] Tenant rules: ${tenantRules.length} active (${JSON.stringify(ruleSet.summary())})`);
  }

  // FASE 1: Fotografia globale
  const snapshot = await buildGlobalSnapshot(tenantId, config);
  if (!snapshot) {
    console.log(`[FeedDaily] No zombie data, skipping`);
    return { error: 'no_data' };
  }
  console.log(`[FeedDaily] Periodo ${snapshot.firstDay} → ${snapshot.lastDay} (${snapshot.daysActive}gg)`);
  console.log(`[FeedDaily] Click: ${snapshot.totalClicks}, Costo: €${snapshot.totalCost.toFixed(2)}, Revenue: €${snapshot.totalRevenue.toFixed(2)}, Incidenza: ${snapshot.incidence.toFixed(1)}%`);

  // FASE 2: Tracking giornaliero
  const tracking = await updateDailyTracking(tenantId, config);
  console.log(`[FeedDaily] Tracking: ${tracking.processed} records processati`);

  // FASE 3: Killer detection
  const killers = await detectKillers(tenantId);

  // FASE 4: Triage (with tenant rules)
  const { actions, stats } = await triageProducts(tenantId, config, snapshot, ruleSet);
  console.log(`[FeedDaily] Triage: ${stats.killers} killer, ${stats.bruciatori} bruciatori, ${stats.convertitori} convertitori, ${stats.potenziali} potenziali`);

  // FASE 4a: Include ALL active quarantined products as REMOVE
  const { rows: quarantined } = await pool.query(`
    SELECT fq.sku, fq.quarantine_level, fq.reason, p.product_name
    FROM feed_quarantine fq
    JOIN products p ON p.sku = fq.sku AND p.tenant_id = fq.tenant_id
    WHERE fq.tenant_id = $1 AND fq.reactivated = false
  `, [tenantId]);
  const triageSKUs = new Set(actions.remove.map(a => a.sku));
  for (const q of quarantined) {
    if (triageSKUs.has(q.sku)) continue; // Already in remove from triage
    actions.remove.push({
      sku: q.sku, name: q.product_name, action: 'REMOVE',
      reason: `In quarantena Q${q.quarantine_level}: ${q.reason}`,
      category: 'quarantined', cost: 0, clicks: 0,
    });
  }
  // Also include active killers not yet quarantined
  const { rows: activeKillers } = await pool.query(`
    SELECT fk.sku, p.product_name, fk.reason
    FROM feed_killers fk
    JOIN products p ON p.sku = fk.sku AND p.tenant_id = fk.tenant_id
    WHERE fk.tenant_id = $1 AND fk.is_active = true
  `, [tenantId]);
  const allRemoveSKUs = new Set(actions.remove.map(a => a.sku));
  for (const k of activeKillers) {
    if (allRemoveSKUs.has(k.sku)) continue;
    actions.remove.push({
      sku: k.sku, name: k.product_name, action: 'REMOVE',
      reason: k.reason, category: 'killer', cost: 0, clicks: 0,
      quarantineDays: 30,
    });
  }
  console.log(`[FeedDaily] Total REMOVE: ${actions.remove.length} (triage: ${stats.killers + stats.bruciatori}, quarantined: ${quarantined.length}, killers: ${activeKillers.length})`);

  // FASE 4b: Price cut per civetta=1 zero click con domanda
  const zeroPriceCuts = await findPriceCutCandidates(tenantId, config, snapshot);
  actions.priceCut.push(...zeroPriceCuts);
  console.log(`[FeedDaily] Price cuts (zero-click + triage): ${actions.priceCut.length}`);

  // FASE 5: Pepite
  const removedCost = actions.remove.reduce((s, a) => s + (a.cost || 0), 0);
  const pepite = await findPepite(tenantId, config, snapshot, removedCost);
  actions.add = pepite;
  console.log(`[FeedDaily] Pepite: ${pepite.length} candidate`);

  // Apply
  const applied = await applyActions(tenantId, actions, config);
  console.log(`[FeedDaily] Applied: ${actions.remove.length} REMOVE, ${actions.keep.length} KEEP, ${actions.priceCut.length} PRICE_CUT, ${actions.monitor.length} MONITOR, ${pepite.length} ADD`);

  // FASE 6: Summary
  await saveDailySummary(tenantId, snapshot, actions, killers.detected);

  const result = {
    snapshot,
    stats: {
      REMOVE: actions.remove.length,
      KEEP: actions.keep.length,
      PRICE_CUT: actions.priceCut.length,
      MONITOR: actions.monitor.length,
      ADD: pepite.length,
    },
    killers: killers.detected,
    savedCost: removedCost,
  };

  console.log(`[FeedDaily] Risparmio stimato: €${removedCost.toFixed(2)} da ${actions.remove.length} rimozioni`);
  return result;
}

module.exports = { runDailyFeedEngine, buildGlobalSnapshot, detectKillers };
