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

  // MANTRA: HARD FLOOR MOL 15% (cfr. feedback_mantra_operativo).
  // Floor = costo / (1 - 0.15) → margine_pct esattamente 15% sul target.
  const MOL_FLOOR = 0.15;
  const priceFloorByMol = erpCost / (1 - MOL_FLOOR);
  // Vecchio floor per ricarico minimo (compatibilità storica)
  const minMarkup = sellPrice < 10 ? 0.18 : sellPrice < 30 ? 0.14 : 0.12;
  const priceFloorByMarkup = erpCost * (1 + minMarkup);
  // Floor = il più alto fra i due (più conservativo)
  const floor = Math.max(priceFloorByMol, priceFloorByMarkup);

  // Target: match best price - 1%, but not below floor
  const target = Math.max(bestPrice * 0.99, floor);
  if (target >= sellPrice) return null; // Can't cut enough
  if (sellPrice - target < 0.10) return null; // Cut too small

  const newMarginPct = ((target - erpCost) / target) * 100;
  // HARD STOP: se per qualche ragione di arrotondamento siamo sotto 15%, reject
  if (newMarginPct < 15) return null;

  const cutPct = ((sellPrice - target) / sellPrice) * 100;
  return {
    targetPrice: Math.round(target * 100) / 100,
    newMarginPct: Math.round(newMarginPct * 10) / 10,
    cutPct: Math.round(cutPct * 10) / 10,
  };
}

// ─── CONFIG ────────────────────────────────────────────

async function loadConfig(tenantId) {
  // Briglie con scadenza:
  //   expires_at IS NULL OR expires_at > NOW()    → usa config_value
  //   expires_at scaduta AND expired_revert_to    → usa expired_revert_to
  //   expires_at scaduta AND nessun revert        → riga ignorata (default codice)
  const { rows } = await pool.query(
    `SELECT config_key,
       CASE
         WHEN expires_at IS NULL OR expires_at > NOW() THEN config_value
         WHEN expired_revert_to IS NOT NULL THEN expired_revert_to
         ELSE NULL
       END AS config_value
     FROM health_config
     WHERE tenant_id = $1
       AND (expires_at IS NULL OR expires_at > NOW() OR expired_revert_to IS NOT NULL)`,
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
    // Safety-net: se un SKU vende N+ volte nello store negli ultimi 30g,
    // NON viene rimosso anche se figura come burner sul feed TP. Default 0
    // (disabilitato, manteniamo il comportamento storico). Settabile per
    // tenant via health_config.store_sales_safety_net per essere meno
    // aggressivi su tenant dove il calo TP coincide con calo ordini store.
    storeSalesSafetyNet: parseInt(c.store_sales_safety_net || 0),
    // Stock safety net: SKU con magazzino fisico (erp+supplier) >= soglia E
    // margin_pct >= margine soglia => MAI killer / quarantena / REMOVE.
    // Logica: investimento gia' fatto sul magazzino, brand premium / consumabili.
    // L'engine fara' solo MONITOR/KEEP. Default disattivato (0 = off).
    // Settare es. 5 per attivare con stock_min=5+MOL>=18.
    stockSafetyNetMinUnits: parseInt(c.stock_safety_net_min_units || 0),
    stockSafetyNetMinMolPct: parseFloat(c.stock_safety_net_min_mol_pct || 18),
    // Bypass safety net se l'incidenza reale dello SKU ultimi 30g supera la
    // soglia (default 30%). Logica: anche se vende store, se TP brucia il
    // doppio di quanto rende, non vale la pena proteggerlo. Esempio storico:
    // IRILENS Papa 30g: €46 spesa per €25 revenue (inc 180%) era safety_net=true.
    safetyNetMaxIncidencePct: parseFloat(c.safety_net_max_incidence_pct || 30),
    // Numero minimo di click per considerare l'incidenza significativa
    // (evita falsi positivi su SKU con pochi click).
    safetyNetMinClicksForCheck: parseInt(c.safety_net_min_clicks_for_check || 30),
    // Briglie più larghe: se SKU quarantenato/killer ha sales_30d_seller >=
    // soglia, NON viene rimosso ma marcato MONITOR. Default 0 = disabilitato.
    // Filosofia: meglio spendere un po' più su SKU che venderanno comunque
    // che tagliare il feed e perdere il fatturato store associato.
    quarantineReleaseMinStoreSales: parseInt(c.quarantine_release_min_store_sales || 0),
    killerSkipMinStoreSales: parseInt(c.killer_skip_min_store_sales || 0),
    // Promozione attiva: SKU non in feed civetta MA che vendono nello store
    // sopra soglia → emettiamo ADD (intrinseco all'ottimizzazione). Filtri di
    // qualità: pos TP 1-7 (zona click) + margine rispetto fascia prezzo
    // (<10€→18%, 10-30€→14%, >30€→12%). Default 3 = abilitato.
    promoteStoreSellerMinSales: parseInt(c.promote_store_seller_min_sales || 3),
    // Cap massimo SKU nuovi promossi per ciclo.
    // Default 2000 = DICTAT fatturare con incidenza bassa (cfr.
    // feedback_dictat_fatturare_incidenza_bassa). Self-throttle:
    // se snapshot.overTarget=true la promote viene saltata; se l'incidenza
    // recente sale, l'engine riduce candidati naturalmente.
    // I filtri di qualita' (sales_30d_aggregated >= 1, posizione TP <= silver_pos_max,
    // margine OK, no killer/quarantena) restringono comunque la lista.
    promoteMaxSkusPerRun: parseInt(c.promote_max_skus_per_run || 2000),
    // Soglia minima vendite cross-tenant per ammettere uno SKU come ADD.
    // Default 1 = prova minima di domanda. Per tenant con conversion debole sui
    // candidati appena ammessi, alzare a 3-5 per filtrare SKU mediocri.
    promoteSalesAggMin: parseInt(c.promote_sales_agg_min || 1),
    // Soglie domanda per accettare un SKU candidato PRICE_CUT (FASE 4b).
    // Default conservativi: agg>=5, seller>=2, mc_impr>=50. Da rilasciare
    // su tenant con scarso volume PRICE_CUT (es. MPF: 20 PRICE_CUT su 35k
    // pool teorico = filtro troppo stretto). Setting suggested rilasciato:
    //   price_cut_demand_agg_min=1, ..._seller_min=1, ..._mc_impr_min=20
    //   price_cut_position_override_max=7 (accetta anche top7 senza vendite)
    //   price_cut_limit=1000
    priceCutDemandAggMin: parseInt(c.price_cut_demand_agg_min || 5),
    priceCutDemandSellerMin: parseInt(c.price_cut_demand_seller_min || 2),
    priceCutDemandMcImprMin: parseInt(c.price_cut_demand_mc_impr_min || 50),
    priceCutPositionOverrideMax: parseInt(c.price_cut_position_override_max || 0),
    priceCutLimit: parseInt(c.price_cut_limit || 300),
    // Filtri qualita' posizione TP (cfr. feedback_dictat_fatturare_incidenza_bassa):
    //  - ADD puro: posizione <= goldenPositionMaxForAdd (default 7 = top 7,
    //    visibilita' reale con click qualificati).
    //  - PRICE_CUT competitivo (Salva Bilancio): posizione fra goldenPos e
    //    silverPositionMaxForCut. Tagliamo il prezzo per scalare la classifica.
    goldenPositionMaxForAdd: parseInt(c.pepite_golden_position_max || 7),
    silverPositionMaxForCut: parseInt(c.pepite_silver_position_max || 15),
    // Quando attivo (=1), findStoreSellerPromotions richiede erp_stock > 0
    // (magazzino farmacia) invece di accettare anche supplier_stock (grossista).
    // Usato per spingere il magazzino interno senza sporcare con prodotti
    // disponibili solo via terzista.
    preferErpStockOnly: parseInt(c.prefer_erp_stock_only || 0) === 1,
    // Salva Bilancio: criterio fallback per accettare cut anche se margin_pct
    // sotto fascia, purchè margine ASSOLUTO EUR sia significativo. SKU costosi
    // possono vendere bene con 5-6€ di margine anche se in % sono al 8-9%.
    // Default €3 = abilitato (cfr. feedback_salva_bilancio_pepite_vere).
    salvaBilancioMinEur: parseFloat(c.salva_bilancio_min_margin_eur || 3),
    // PRICE_CUT competitivo: SKU in feed civetta con sell_price > best_price
    // competitor → tagliamo a best - 0.01 per finire top, se margine fascia OR
    // Salva Bilancio rispettato. Limit alto (3000) perchè con catalogo da 100k
    // SKU il giacimento reale è 2-4k SKU per tenant: limit basso = perdere
    // soldi sul tavolo. magentoSyncCron ha gia' suo throttling lato Magento.
    competitivePriceCutLimit: parseInt(c.competitive_price_cut_limit || 3000),
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
             p.margin, p.margin_pct, p.brand, p.manufacturer, p.erp_stock, p.supplier_stock,
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
  // Killer DINAMICO basato su RAPPORTO VENDITE/COSTO (cfr. utente 25/6/2026):
  //
  // Bilancio TP 30g = (ordini_TP * margine_eur) - costo_click_30g
  // Killer SE bilancio < 0 di una quota significativa del costo.
  //
  // Formula: killer se costo_click - (ord * margin) > 50% del costo_click
  //          ovvero (ord * margin) < costo_click * 0.5
  //
  // Esempio MPF 949645295: 90 click / €25 cost / 2 ord / margin €1.11
  //   = profitto = 2 * 1.11 - 25 = -22.78 (perdita totale)
  //   = orders*margin (€2.22) < cost*0.5 (€12.5) → KILLER
  //
  // Esempio Aspirina: 5 click / €1.35 cost / 0 ord / margin €2
  //   = orders*margin (€0) < cost*0.5 (€0.68) → KILLER
  //
  // Esempio Tachipirina: 100 click / €27 cost / 30 ord / margin €1.5
  //   = orders*margin (€45) > cost*0.5 (€13.5) → NON KILLER
  //
  // Ordini considerati: GREATEST tra tp_attributed_orders e actual orders 30g
  // (per coprire i casi GA4 KO).
  const { rows: killers } = await pool.query(`
    WITH actual_orders_30d AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) as ord_30d
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
        AND o.order_date >= NOW() - INTERVAL '30 days'
      GROUP BY oi.sku
    )
    SELECT p.sku, p.product_name,
      phs.scraper_competitor_count as sellers,
      COALESCE(p.sales_30d_aggregated, 0) as global_demand,
      phs.scraper_position as our_position,
      COALESCE(p.margin, p.sell_price - p.erp_cost) as margin_eur,
      COALESCE(phs.tp_click_cost_30d, 0) as cost_30d,
      COALESCE(phs.tp_clicks_30d, 0) as clicks_30d,
      GREATEST(COALESCE(phs.tp_attributed_orders, 0), COALESCE(ao.ord_30d, 0)) as orders_30d,
      COALESCE(p.margin, p.sell_price - p.erp_cost) *
        GREATEST(COALESCE(phs.tp_attributed_orders, 0), COALESCE(ao.ord_30d, 0)) as revenue_margine_30d
    FROM products p
    JOIN product_health_scores phs ON phs.sku = p.sku AND phs.tenant_id = p.tenant_id
    LEFT JOIN feed_killers fk ON fk.sku = p.sku AND fk.tenant_id = p.tenant_id AND fk.is_active = true
    LEFT JOIN actual_orders_30d ao ON ao.sku = p.sku
    WHERE p.tenant_id = $1
      AND p.is_civetta = true
      AND fk.id IS NULL
      -- Costo significativo (almeno 3 click)
      AND COALESCE(phs.tp_clicks_30d, 0) >= 3
      AND COALESCE(phs.tp_click_cost_30d, 0) > 0
      AND COALESCE(p.margin, p.sell_price - p.erp_cost) > 0
      -- Burner: il margine generato copre < 50% del costo click
      -- ovvero (ordini * margin) < cost * 0.5
      AND COALESCE(p.margin, p.sell_price - p.erp_cost)
          * GREATEST(COALESCE(phs.tp_attributed_orders, 0), COALESCE(ao.ord_30d, 0))
          < COALESCE(phs.tp_click_cost_30d, 0) * 0.5
    ORDER BY phs.tp_click_cost_30d DESC
  `, [tenantId]);

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
      `Killer dinamico: bilancio TP 30g €${(parseFloat(k.revenue_margine_30d) - parseFloat(k.cost_30d)).toFixed(2)} (${k.clicks_30d} click €${parseFloat(k.cost_30d).toFixed(2)} - ${k.orders_30d} ord × €${parseFloat(k.margin_eur).toFixed(2)} margin = €${parseFloat(k.revenue_margine_30d).toFixed(2)} ricavo) - rapporto vendite/costo insufficiente`
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
    ),
    -- Revenue reale 30g dagli ordini importati (NON da GA4: tracking GA4 KO
    -- su alcuni tenant rendeva l'incidenza calcolata 9999% e tutti i SKU
    -- diventavano "burner alta incidenza" anche se in realta' convertono.
    -- Usiamo il revenue dei veri ordini Magento per il calcolo bypass safety net.
    actual_rev_30d AS (
      SELECT oi.sku,
        SUM(oi.row_total) as rev_30d,
        COUNT(DISTINCT o.id) as ord_30d
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
        AND o.order_date >= NOW() - INTERVAL '30 days'
      GROUP BY oi.sku
    )
    SELECT pt.*,
      p.product_name, p.is_civetta, p.brand, p.manufacturer, p.erp_stock, p.supplier_stock,
      p.sell_price, p.erp_cost, p.margin as margin_eur,
      p.sales_30d_seller, p.price_rule_id,
      phs.ga4_tp_purchases, phs.ga4_assisted_sales,
      phs.mc_click_potential, phs.classification,
      phs.scraper_best_price,
      -- KPI 30g consolidati per check bypass safety net (cfr. caso IRILENS).
      phs.tp_clicks_30d, phs.tp_click_cost_30d, phs.ga4_tp_revenue,
      -- Revenue/ordini REALI 30g dai veri orders Magento (fallback se GA4 KO)
      COALESCE(ar.rev_30d, 0) as actual_rev_30d,
      COALESCE(ar.ord_30d, 0) as actual_ord_30d,
      fk.id as is_killer,
      fq.id as is_quarantined, fq.quarantine_level
    FROM product_totals pt
    JOIN products p ON p.sku = pt.sku AND p.tenant_id = $1
    LEFT JOIN product_health_scores phs ON phs.sku = pt.sku AND phs.tenant_id = $1
    LEFT JOIN actual_rev_30d ar ON ar.sku = pt.sku
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
    // Fonte ordini: prima i veri orders dal Magento (actual_ord_30d),
    // poi fallback GA4 per coerenza dashboard.
    const actualOrders30d = parseInt(p.actual_ord_30d) || 0;
    const hasGA4Orders = (parseInt(p.ga4_tp_purchases) || 0) > 0 || actualOrders30d > 0;
    const hasAssistedSales = (parseInt(p.ga4_assisted_sales) || 0) > 0;

    const storeSales30dRaw = parseFloat(p.sales_30d_seller) || 0;

    // Calcolo bypass safety net SU REVENUE REALE 30g (orders.grand_total
    // aggregato per SKU dai veri ordini Magento). GA4 tracking è KO su
    // diversi tenant (ga4_tp_revenue=0) e ci faceva calcolare incidenza
    // 9999% facendo killer/quarantena automatica anche su convertitori veri.
    // Cfr. caso IRILENS Papa 23/6/2026 (€46 cost 30g / €25 rev = inc 180%).
    const phs30dClicks = parseFloat(p.tp_clicks_30d) || 0;
    const phs30dCost = parseFloat(p.tp_click_cost_30d) || 0;
    const actualRev30d = parseFloat(p.actual_rev_30d) || 0;
    // Fallback: revenue reale, poi GA4, poi 0
    const phs30dRev = actualRev30d > 0 ? actualRev30d : (parseFloat(p.ga4_tp_revenue) || 0);
    const skuBurnIncidence = (phs30dRev > 0)
      ? (phs30dCost / phs30dRev * 100)
      : (phs30dClicks >= config.safetyNetMinClicksForCheck ? 9999 : 0);
    const exceedsBurnThreshold =
      phs30dClicks >= config.safetyNetMinClicksForCheck &&
      skuBurnIncidence > config.safetyNetMaxIncidencePct;

    // STOCK SAFETY NET — protezione massima per SKU con magazzino fisico
    // (erp+supplier) e MOL adeguato. Logica: investimento gia' fatto sul
    // magazzino, brand premium / consumabili / linee in linea con la farmacia.
    // L'engine NON puo' REMOVE/killer/quarantena questi SKU.
    // Eccezione: bypass se incidenza reale ultimi 30g supera la soglia
    // (config.safetyNetMaxIncidencePct, default 30%).
    // Cfr. feedback_stock_safety_net_brand_premium.
    if (config.stockSafetyNetMinUnits > 0 && !exceedsBurnThreshold) {
      const totalStock = (parseFloat(p.erp_stock) || 0) + (parseFloat(p.supplier_stock) || 0);
      if (totalStock >= config.stockSafetyNetMinUnits && marginPct >= config.stockSafetyNetMinMolPct) {
        // Se vende store >=1, lo classifichiamo KEEP (convertitore reale).
        // Altrimenti MONITOR (in feed sotto osservazione, ma protetto).
        if (storeSales30dRaw >= 1) {
          actions.keep.push({
            sku: p.sku, name: p.product_name, action: 'KEEP',
            reason: `Stock safety: ${totalStock}u stock + MOL ${marginPct.toFixed(1)}% + vende ${storeSales30dRaw}/30g store. Protetto.`,
            category: 'stock_safety_net', cost: totalCost, clicks: totalClicks, orders: totalOrders,
          });
        } else {
          actions.monitor.push({
            sku: p.sku, name: p.product_name, action: 'MONITOR',
            reason: `Stock safety: ${totalStock}u stock + MOL ${marginPct.toFixed(1)}%. Mai REMOVE anche se 0 ord store.`,
            category: 'stock_safety_net', cost: totalCost, clicks: totalClicks, orders: totalOrders,
          });
        }
        stats.stock_safety_net = (stats.stock_safety_net || 0) + 1;
        continue;
      }
    }

    // Already quarantined → di norma REMOVE. Briglie larghe: se vende nello
    // store sopra soglia, sposta in MONITOR invece di REMOVE (il sistema NON
    // tocca la quarantena DB, solo la decisione di feed).
    if (p.is_quarantined) {
      if (config.quarantineReleaseMinStoreSales > 0 && storeSales30dRaw >= config.quarantineReleaseMinStoreSales) {
        actions.monitor.push({
          sku: p.sku, name: p.product_name, action: 'MONITOR',
          reason: `Briglie larghe: quarantenato Q${p.quarantine_level} MA vende ${storeSales30dRaw}/30g in store (>= ${config.quarantineReleaseMinStoreSales}). Lascio in feed.`,
          category: 'quarantine_release', cost: totalCost, clicks: totalClicks,
        });
        stats.quarantine_release = (stats.quarantine_release || 0) + 1;
        continue;
      }
      actions.remove.push({
        sku: p.sku, name: p.product_name, action: 'REMOVE',
        reason: `In quarantena Q${p.quarantine_level}`,
        category: 'quarantined', cost: totalCost, clicks: totalClicks,
      });
      continue;
    }

    // A) KILLER — di norma via subito. Briglie larghe + protezione convertitori.
    if (p.is_killer) {
      // Protezione: se ord (TP attribuiti O store sales O reali 30g) sono >= 2
      // E il margine generato copre almeno il 50% del costo click → SKU profittevole,
      // il flag killer è obsoleto (lo cleanup-eremo). Manteniamo in feed.
      const ordsForCheck = Math.max(
        parseInt(p.tp_attributed_orders) || 0,
        parseInt(p.actual_ord_30d) || 0,
        storeSales30dRaw
      );
      const marginEur = parseFloat(p.margin_eur) || (parseFloat(p.sell_price) - parseFloat(p.erp_cost)) || 0;
      const profitGuard = ordsForCheck >= 2 && marginEur > 0
        && (ordsForCheck * marginEur) >= (phs30dCost * 0.5);
      if (profitGuard) {
        actions.keep.push({
          sku: p.sku, name: p.product_name, action: 'KEEP',
          reason: `Killer obsoleto: ${ordsForCheck} ord × €${marginEur.toFixed(2)} = €${(ordsForCheck * marginEur).toFixed(2)} vs cost €${phs30dCost.toFixed(2)} → profitevole, mantengo`,
          category: 'killer_obsoleto', cost: totalCost, clicks: totalClicks, orders: ordsForCheck,
        });
        stats.killer_release = (stats.killer_release || 0) + 1;
        continue;
      }
      if (config.killerSkipMinStoreSales > 0 && storeSales30dRaw >= config.killerSkipMinStoreSales) {
        actions.monitor.push({
          sku: p.sku, name: p.product_name, action: 'MONITOR',
          reason: `Briglie larghe: killer (${p.competitors} seller, 0 globali) MA vende ${storeSales30dRaw}/30g in store. Lascio in feed.`,
          category: 'killer_release', cost: totalCost, clicks: totalClicks,
        });
        stats.killer_release = (stats.killer_release || 0) + 1;
        continue;
      }
      actions.remove.push({
        sku: p.sku, name: p.product_name, action: 'REMOVE',
        reason: `KILLER: ${p.competitors} seller, 0 vendite globali, ${totalClicks} click, €${totalCost.toFixed(2)} sprecati`,
        category: 'killer', cost: totalCost, clicks: totalClicks,
        quarantineDays: 30,
      });
      stats.killers++;
      continue;
    }

    // SAFETY NET — SKU che vendono nello store >= soglia → protetti dal REMOVE.
    // Si applica solo se config.storeSalesSafetyNet > 0 (per tenant specifico).
    // Skippa killer/quarantined (gestiti sopra) e SKU senza vendite reali.
    // Bypass: se incidenza reale 30g supera safetyNetMaxIncidencePct, lo SKU
    // brucia troppo budget per essere protetto (cfr. caso IRILENS Papa).
    const storeSales30d = parseFloat(p.sales_30d_seller) || 0;
    if (config.storeSalesSafetyNet > 0 && storeSales30d >= config.storeSalesSafetyNet && !exceedsBurnThreshold) {
      actions.monitor.push({
        sku: p.sku, name: p.product_name, action: 'MONITOR',
        reason: `Safety net: ${storeSales30d} vendite store/30g (>= soglia ${config.storeSalesSafetyNet}). Non rimosso anche se burner TP.`,
        category: 'store_safety_net', cost: totalCost, clicks: totalClicks, orders: totalOrders,
      });
      stats.safety_net = (stats.safety_net || 0) + 1;
      continue;
    }

    // D) CONVERTITORE — ha ordini nel periodo
    if (totalOrders > 0 || hasGA4Orders || hasAssistedSales) {
      // Se brucia troppo budget rispetto alla revenue 30g, valutiamo REMOVE
      // anche se ha qualche ordine. Caso IRILENS Papa: 166 click/€46 cost 30g
      // per €25 rev = inc 180%, "convertitore" ma in perdita netta.
      if (exceedsBurnThreshold && canRemoveProduct(p)) {
        actions.remove.push({
          sku: p.sku, name: p.product_name, action: 'REMOVE',
          reason: `Burner ad alta incidenza 30g: ${skuBurnIncidence.toFixed(0)}% (${phs30dClicks}clk/€${phs30dCost.toFixed(2)}cost / €${phs30dRev.toFixed(2)}rev). Soglia max ${config.safetyNetMaxIncidencePct}%.`,
          category: 'burner_high_incidence', cost: totalCost, clicks: totalClicks, orders: totalOrders,
          quarantineDays: 15,
        });
        stats.bruciatori++;
        continue;
      }
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
    // MC eliminato: poco affidabile, segnale ridondante con scraper_position.

    // B0) NESSUNA POSIZIONE SCRAPER — se l'SKU prende click ma non sappiamo
    // dove sta nella SERP TP, non possiamo decidere se è competitivo. Lo
    // togliamo dal feed per non sprecare budget alla cieca. Eccezione:
    // se ha 0 click (es. SKU appena entrato) lo lasciamo girare.
    if (!position && totalClicks >= 3) {
      actions.remove.push({
        sku: p.sku, name: p.product_name, action: 'REMOVE',
        reason: `Nessuna posizione scraper, ${totalClicks} click in ${daysClicked}gg → blocchiamo per evitare spreco`,
        category: 'no_scraper_position', cost: totalCost, clicks: totalClicks,
        quarantineDays: 7,
      });
      stats.no_scraper = (stats.no_scraper || 0) + 1;
      continue;
    }

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

  // Soglie domanda parametrizzabili (default conservativi):
  //   priceCutDemandAggMin (default 5)        - sales globali 30g
  //   priceCutDemandSellerMin (default 2)     - sales locali 30g
  //   priceCutDemandMcImprMin (default 50)    - impressions Merchant Center 14g
  //   priceCutPositionOverrideMax (default 0) - se >0, accetta SKU pos<=val anche senza altri segnali
  //   priceCutLimit (default 300)             - max candidati ritornati
  const aggMin = config.priceCutDemandAggMin ?? 5;
  const sellerMin = config.priceCutDemandSellerMin ?? 2;
  const mcMin = config.priceCutDemandMcImprMin ?? 50;
  const posOverride = config.priceCutPositionOverrideMax ?? 0;
  const limit = config.priceCutLimit ?? 300;

  // MC eliminato dai criteri di domanda: poco affidabile.
  const demandClause = posOverride > 0
    ? `(
        COALESCE(p.sales_30d_aggregated, 0) >= ${aggMin}
        OR COALESCE(p.sales_30d_seller, 0) >= ${sellerMin}
        OR (phs.scraper_position IS NOT NULL AND phs.scraper_position <= ${posOverride}
            AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) >= 5)
      )`
    : `(
        COALESCE(p.sales_30d_aggregated, 0) >= ${aggMin}
        OR COALESCE(p.sales_30d_seller, 0) >= ${sellerMin}
      )`;

  // Prodotti civetta=1 che non ricevono click ma hanno domanda
  // Il prezzo è troppo alto → taglio per renderli competitivi
  const { rows: candidates } = await pool.query(`
    SELECT p.sku, p.product_name,
      ROUND(p.sell_price::numeric, 2) as sell_price,
      ROUND(p.erp_cost::numeric, 2) as erp_cost,
      ROUND(p.margin_pct::numeric, 1) as margin_pct,
      p.sales_30d_seller, p.sales_30d_aggregated,
      p.brand, p.manufacturer, p.erp_stock, p.supplier_stock,
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
      -- Rimosso filtro tp_clicks_30d = 0 (escludeva SKU in top7 ma overpriced).
      -- Ora accettiamo:
      --  - zero-click + domanda (logica originale)
      --  - OR ha click MA il margine generato NON copre il costo
      --    (= bilancio negativo = SKU che andrebbe killato; tagliando il prezzo
      --     puo' convertire di piu')
      AND (
        phs.tp_clicks_30d = 0
        OR (
          COALESCE(p.margin, p.sell_price - p.erp_cost) > 0
          AND COALESCE(phs.tp_click_cost_30d, 0) > 0
          AND COALESCE(p.margin, p.sell_price - p.erp_cost)
              * COALESCE(phs.tp_attributed_orders, 0)
              < COALESCE(phs.tp_click_cost_30d, 0) * 1.0
        )
      )
      AND fk.id IS NULL
      AND phs.scraper_best_price IS NOT NULL
      AND phs.scraper_best_price > 0
      AND p.sell_price > phs.scraper_best_price * 1.05
      AND (pr.rule_type IS NULL OR pr.rule_type != 'sconto')
      AND ${demandClause}
    ORDER BY phs.tp_click_cost_30d DESC NULLS LAST, p.sales_30d_aggregated DESC
    LIMIT ${limit}
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
    const newMarginEur = targetPrice - erpCost;
    // Accetta se MOL% per fascia OK, oppure (Salva Bilancio) se margine EUR
    // assoluto >= soglia: SKU costosi possono vendere con poco % ma molti EUR.
    const salvaBilancioMin = config.salvaBilancioMinEur || 3;
    if (newMarginPct < minMarginPct && newMarginEur < salvaBilancioMin) continue;

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

// Default rules: usati se global_config.pepite_rules non e' valorizzato.
// Override via UPSERT su global_config (config_key='pepite_rules') con JSON.
const PEPITE_DEFAULT_RULES = {
  golden: { position_max: 5, margin_min: 8, sales_min: 3, limit: 50 },
  silver: { enabled: true, position_min: 6, position_max: 10, margin_min: 12, sales_min: 5, limit: 50 },
  budget_split_pct: 50,
  min_budget_eur: 5,
};

async function loadPepiteRules(tenantId) {
  let rules;
  try {
    const { getGlobal } = require('./globalConfig');
    const raw = await getGlobal('pepite_rules');
    if (!raw) {
      rules = PEPITE_DEFAULT_RULES;
    } else {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      rules = {
        ...PEPITE_DEFAULT_RULES,
        ...parsed,
        golden: { ...PEPITE_DEFAULT_RULES.golden, ...(parsed.golden || {}) },
        silver: { ...PEPITE_DEFAULT_RULES.silver, ...(parsed.silver || {}) },
      };
    }
  } catch (e) {
    console.warn(`[FeedDaily] pepite_rules invalid, usando default: ${e.message}`);
    rules = PEPITE_DEFAULT_RULES;
  }

  if (!tenantId) return rules;

  // Override per tenant via health_config (rispetta expires_at): permette di
  // spingere parametri pepite solo per tenant del treatment, con rollback
  // automatico al timestamp.
  try {
    const { rows } = await pool.query(
      `SELECT config_key,
         CASE
           WHEN expires_at IS NULL OR expires_at > NOW() THEN config_value
           WHEN expired_revert_to IS NOT NULL THEN expired_revert_to
           ELSE NULL
         END AS config_value
       FROM health_config
       WHERE tenant_id=$1
         AND (expires_at IS NULL OR expires_at > NOW() OR expired_revert_to IS NOT NULL)
         AND config_key IN ('pepite_golden_position_max','pepite_golden_margin_min',
                            'pepite_golden_sales_min','pepite_silver_position_min',
                            'pepite_silver_position_max','pepite_silver_margin_min',
                            'pepite_silver_sales_min','pepite_silver_enabled')`,
      [tenantId]
    );
    if (rows.length === 0) return rules;
    const cloned = JSON.parse(JSON.stringify(rules));
    for (const r of rows) {
      const v = r.config_value;
      switch (r.config_key) {
        case 'pepite_golden_position_max': cloned.golden.position_max = parseInt(v); break;
        case 'pepite_golden_margin_min':   cloned.golden.margin_min   = parseInt(v); break;
        case 'pepite_golden_sales_min':    cloned.golden.sales_min    = parseInt(v); break;
        case 'pepite_silver_position_min': cloned.silver.position_min = parseInt(v); break;
        case 'pepite_silver_position_max': cloned.silver.position_max = parseInt(v); break;
        case 'pepite_silver_margin_min':   cloned.silver.margin_min   = parseInt(v); break;
        case 'pepite_silver_sales_min':    cloned.silver.sales_min    = parseInt(v); break;
        case 'pepite_silver_enabled':      cloned.silver.enabled      = (v === 'true' || v === '1'); break;
      }
    }
    console.log(`[FeedDaily] pepite override per tenant ${tenantId.slice(0,8)}: ${rows.length} chiavi attive`);
    return cloned;
  } catch (e) {
    console.warn(`[FeedDaily] pepite tenant-override failed: ${e.message}`);
    return rules;
  }
}

async function queryPepiteTier(tenantId, posMin, posMax, marginMin, salesMin, limit) {
  // Esclude regole Sconto (mai toccare prezzi su SKU "sconto") +
  // priorità stagionale (in-season/entrante prima).
  const { rows } = await pool.query(`
    SELECT p.sku, p.product_name,
      ROUND(p.sell_price::numeric, 2) as sell_price,
      ROUND(p.margin_pct::numeric, 1) as margin_pct,
      p.sales_30d_seller, p.sales_30d_aggregated,
      p.brand, p.manufacturer, p.erp_stock, p.supplier_stock,
      phs.scraper_position, phs.scraper_competitor_count,
      ROUND(phs.scraper_best_price::numeric, 2) as best_price,
      phs.mc_click_potential, phs.health_score, phs.seasonal_score,
      p.price_rule_id
    FROM products p
    JOIN product_health_scores phs ON phs.sku = p.sku AND phs.tenant_id = p.tenant_id
    LEFT JOIN feed_killers fk ON fk.sku = p.sku AND fk.tenant_id = p.tenant_id AND fk.is_active = true
    LEFT JOIN feed_quarantine fq ON fq.sku = p.sku AND fq.tenant_id = p.tenant_id AND fq.reactivated = false
    LEFT JOIN price_rules pr ON pr.rule_id = p.price_rule_id AND pr.tenant_id = p.tenant_id
    WHERE p.tenant_id = $1
      AND (p.is_civetta = false OR p.is_civetta IS NULL)
      AND p.saleable = true
      AND COALESCE(p.margin_pct, 0) >= $2
      AND (COALESCE(p.erp_stock,0) + COALESCE(p.supplier_stock,0)) > 0
      AND COALESCE(p.sales_30d_aggregated, 0) >= $3
      AND fk.id IS NULL
      AND fq.id IS NULL
      AND phs.scraper_position BETWEEN $4 AND $5
      AND (pr.rule_type IS NULL OR pr.rule_type != 'sconto')
    ORDER BY
      COALESCE(phs.seasonal_score, 70) DESC,
      p.sales_30d_aggregated DESC,
      phs.health_score DESC
    LIMIT $6
  `, [tenantId, marginMin, salesMin, posMin, posMax, limit]);
  return rows;
}

async function findPepite(tenantId, config, snapshot, removedCost) {
  if (!snapshot || snapshot.overTarget) return [];

  const rules = await loadPepiteRules(tenantId);
  const availableBudget = removedCost * (rules.budget_split_pct / 100);
  if (availableBudget < rules.min_budget_eur) return [];

  const goldenRows = await queryPepiteTier(
    tenantId, 1, rules.golden.position_max,
    rules.golden.margin_min, rules.golden.sales_min, rules.golden.limit
  );

  let silverRows = [];
  if (rules.silver.enabled) {
    silverRows = await queryPepiteTier(
      tenantId, rules.silver.position_min, rules.silver.position_max,
      rules.silver.margin_min, rules.silver.sales_min, rules.silver.limit
    );
    // Dedup: se per qualche motivo un SKU compare in entrambi (es. range che si
    // sovrappone in config custom), tieni solo Golden.
    const goldenSkus = new Set(goldenRows.map(r => r.sku));
    silverRows = silverRows.filter(r => !goldenSkus.has(r.sku));
  }

  const toAction = (p, tier) => ({
    sku: p.sku, name: p.product_name, action: 'ADD',
    reason: `Pepita ${tier.toUpperCase()}: venduto globale ${p.sales_30d_aggregated}, pos ${p.scraper_position}/${p.scraper_competitor_count}, margine ${p.margin_pct}%`,
    category: `pepita_${tier}`,
    sellPrice: parseFloat(p.sell_price),
    marginPct: parseFloat(p.margin_pct),
    demand: parseFloat(p.sales_30d_aggregated),
    position: p.scraper_position,
  });

  return [
    ...goldenRows.map(p => toAction(p, 'golden')),
    ...silverRows.map(p => toAction(p, 'silver')),
  ];
}

// ─── FASE 5b: PROMOZIONE ATTIVA STORE SELLERS ─────────
// Trova SKU che vendono nel nostro store sopra soglia, MA non sono nel feed
// civetta (gestiti da Farmabooster come "non sponsorizzati"). Filtri di
// qualità: margine rispetto fascia prezzo (giusta marginalità). Saltiamo
// killer e quarantenati (decisioni esplicite passate).
//
// NB: NON filtriamo per scraper_position perché lo scraper TP visita solo
// gli SKU già civetta. Quindi i candidati promotion hanno position NULL
// quasi sempre. La posizione effettiva viene rilevata al ciclo successivo
// dopo che li abbiamo aggiunti al feed.
//
// Margine per fascia (cfr. feedback_price_cut_margins):
//   sell_price < 10€   → margin_pct ≥ 18
//   10€ ≤ p < 30€      → margin_pct ≥ 14
//   sell_price ≥ 30€   → margin_pct ≥ 12
// Helper: regola di accettazione cut. MANTRA: Fatturato UP, MOL ~20%, Costo TP DOWN.
// HARD FLOOR MOL 15% (mai accettato sotto, cfr. feedback_mol_3_fasce). Sopra
// 15% accettiamo tutti — l'ORDER BY del chiamante priorizza SKU con margin_eur
// post-cut piu' alto, quindi i piu' redditizi entrano per primi nel LIMIT.
// Salva Bilancio EUR e' un AND (no fallback %): per fascia >= 30€ richiediamo
// ANCHE che il margine assoluto sia >= soglia (default €3): non promuoviamo
// SKU costosi con €1 di margine assoluto perche' anche con MOL 15% sarebbe
// strategicamente debole.
function isCutAcceptable(newPrice, erpCost, salvaBilancioMinEur) {
  if (newPrice <= erpCost) return { ok: false };
  const marginEur = newPrice - erpCost;
  const marginPct = (marginEur / newPrice) * 100;

  // HARD FLOOR MOL 15% — mantra, mai sotto
  if (marginPct < 15) return { ok: false, marginEur, marginPct, reason: 'sotto MOL hard floor 15%' };

  // Fascia >= 30€: HARD FLOOR 15% + Salva Bilancio (margine assoluto minimo)
  if (newPrice >= 30 && marginEur < salvaBilancioMinEur) {
    return { ok: false, marginEur, marginPct, reason: `margin_eur ${marginEur.toFixed(2)} < SB ${salvaBilancioMinEur} (fascia ≥30€)` };
  }

  // OK: sopra floor 15% (e per fascia ≥30€ anche Salva Bilancio EUR ok)
  return { ok: true, marginEur, marginPct, tier: 15, okBy: marginPct >= 20 ? 'target_20+' : 'floor_15' };
}

async function findStoreSellerPromotions(tenantId, config, snapshot, excludeSkus = new Set()) {
  if (!snapshot || snapshot.overTarget) return [];

  const minSales = config.promoteStoreSellerMinSales;
  // Paginazione: leggiamo la lista candidati a batch di 600 (per non saturare il
  // query planner), iterando finche' ci sono righe. Hard cap 10000 per safety.
  // NOTA: il 600 NON e' un cap di promozioni totali, e' solo la dimensione del
  // batch — l'engine valuta TUTTI i candidati che escono dal filtro.
  const PAGE_SIZE = 600;
  // HARD_CAP = limite SQL di sicurezza. Il vero cap operativo e' promoteMaxSkusPerRun
  // (default 600), che limita il NUMERO finale di ADD passati al feed. Cfr.
  // feedback_gradualita_promote_no_botto.
  const HARD_CAP = Math.max(config.promoteMaxSkusPerRun * 2, 1200);
  const rows = [];
  let offset = 0;
  while (offset < HARD_CAP) {
    const { rows: batch } = await pool.query(`
      SELECT p.sku, p.product_name,
        ROUND(p.sell_price::numeric, 2) AS sell_price,
        ROUND(COALESCE(p.erp_cost, p.erp_cost_imputed, 0)::numeric, 4) AS erp_cost,
        ROUND(p.margin_pct::numeric, 1) AS margin_pct,
        p.sales_30d_seller,
        phs.mc_click_potential,
        phs.scraper_position,
        phs.scraper_competitor_count,
        phs.seasonal_score,
        ROUND(phs.scraper_best_price::numeric, 2) AS best_price
      FROM products p
      LEFT JOIN product_health_scores phs ON phs.tenant_id=p.tenant_id AND phs.sku=p.sku
      LEFT JOIN feed_killers fk ON fk.tenant_id=p.tenant_id AND fk.sku=p.sku AND fk.is_active=true
      LEFT JOIN feed_quarantine fq ON fq.tenant_id=p.tenant_id AND fq.sku=p.sku AND fq.reactivated=false
      LEFT JOIN price_rules pr ON pr.rule_id = p.price_rule_id AND pr.tenant_id = $1
      WHERE p.tenant_id = $1
        AND COALESCE(p.is_civetta, false) = false
        AND p.saleable = true
        AND ${config.preferErpStockOnly
          ? 'COALESCE(p.erp_stock,0) > 0'
          : '(COALESCE(p.erp_stock,0) + COALESCE(p.supplier_stock,0)) > 0'}
        AND fk.id IS NULL AND fq.id IS NULL
        AND (pr.rule_type IS NULL OR pr.rule_type != 'sconto')
        AND (
          COALESCE(p.sales_30d_seller, 0) >= $2
          OR (phs.scraper_best_price > 0 AND p.sell_price > phs.scraper_best_price + 0.01)
        )
        -- DICTAT (cfr. feedback_dictat_fatturare_incidenza_bassa):
        -- 1) Vende cross-tenant (domanda dimostrata).
        -- 2) Scraper ha tracciato il prodotto (best_price > 0 = visibile su TP).
        -- 3) Posizione TP gestibile:
        --    - top goldenPos (default 7): puo' essere ADD puro.
        --    - top silverPos (default 15) E sell_price > best: puo' essere
        --      PRICE_CUT Salva Bilancio (scalando classifica).
        AND (
          -- Bypass cross-tenant: se vende almeno 1 volta in store, ha domanda
          -- locale dimostrata, non serve passare il check sales_agg.
          COALESCE(p.sales_30d_seller, 0) >= 1
          OR COALESCE(p.sales_30d_aggregated, 0) >= $6
          -- Bypass ord_tp_storici: SKU che vendeva via TP ma ora NON in civetta FB.
          -- Spesso FB esclude SKU che invece convertono. Usiamo ord_tp >= 1 come
          -- segnale forte di domanda specifica.
          OR COALESCE(phs.tp_attributed_orders, 0) >= 1
        )
        AND phs.scraper_best_price > 0
        AND (
          -- (a) Gia' nel top goldenPos (default 7): ADD puro.
          phs.scraper_position <= $5::int
          OR (
            -- (b) Posizione qualunque MA possiamo tagliarci a best-0.01.
            p.sell_price > phs.scraper_best_price + 0.01
          )
          OR (
            -- (c) Posizione NULL MA siamo gia' competitivi (sotto o uguale best).
            -- Lo scraper potrebbe non averlo tracciato ma il prezzo regge.
            phs.scraper_position IS NULL
            AND p.sell_price <= phs.scraper_best_price + 0.01
          )
        )
      ORDER BY
        COALESCE(phs.seasonal_score, 70) DESC,
        COALESCE(p.sales_30d_aggregated, 0) DESC,
        COALESCE(p.sales_30d_seller, 0) DESC,
        p.sku
      LIMIT $3 OFFSET $4
    `, [tenantId, minSales, PAGE_SIZE, offset,
        config.goldenPositionMaxForAdd || 7,
        config.promoteSalesAggMin || 1]);
    if (batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const out = [];
  for (const r of rows) {
    if (excludeSkus.has(r.sku)) continue;
    const sellPrice = parseFloat(r.sell_price);
    const erpCost = parseFloat(r.erp_cost) || 0;
    const bestPrice = parseFloat(r.best_price) || 0;
    const sales = parseFloat(r.sales_30d_seller) || 0;

    // Caso 1: sopra best_price → suggeriamo cut. Verifica Salva Bilancio.
    if (bestPrice > 0 && sellPrice > bestPrice + 0.01) {
      const newPrice = +(bestPrice - 0.01).toFixed(2);
      const acc = isCutAcceptable(newPrice, erpCost, config.salvaBilancioMinEur);
      if (acc.ok) {
        out.push({
          sku: r.sku, name: r.product_name, action: 'ADD',
          reason: `Pepita Salva Bilancio: vende ${sales}/30g in store, attuale €${sellPrice} > best €${bestPrice}. Cut a €${newPrice} → margine €${acc.marginEur.toFixed(2)} (${acc.marginPct.toFixed(1)}%, ${acc.okBy === 'eur' ? 'OK Salva Bilancio' : 'OK fascia ' + acc.tier + '%'})`,
          category: 'promotion_salva_bilancio',
          sellPrice, currentPrice: sellPrice,
          recommendedPrice: newPrice,
          priceCutPct: +(((sellPrice - newPrice) / sellPrice) * 100).toFixed(1),
          newMarginPct: +acc.marginPct.toFixed(1),
          newMarginEur: +acc.marginEur.toFixed(2),
          marginPct: parseFloat(r.margin_pct),
          demand: sales,
          position: r.scraper_position,
        });
        continue;
      }
    }

    // Caso 2: sotto/uguale best_price o no best → ADD puro se sells store + fascia margine OK
    if (sales < minSales) continue;
    const mp = parseFloat(r.margin_pct) || 0;
    const tierFascia = sellPrice < 10 ? 18 : sellPrice < 30 ? 14 : 12;
    if (mp < tierFascia) continue;
    out.push({
      sku: r.sku, name: r.product_name, action: 'ADD',
      reason: `Promozione store: vende ${sales}/30g in store, margine ${mp}% (fascia ${sellPrice < 10 ? '<10€' : sellPrice < 30 ? '10-30€' : '≥30€'})${r.mc_click_potential ? ', MC ' + r.mc_click_potential : ''}`,
      category: 'promotion_store_seller',
      sellPrice, marginPct: mp, demand: sales, position: r.scraper_position,
    });
  }
  // Cap finale sul numero totale di ADD per ciclo (anti picco spesa).
  // I candidati arrivano gia' ordinati per scoring, quindi tagliamo i meno
  // qualificati. Default 600, override via promote_max_skus_per_run.
  const cap = config.promoteMaxSkusPerRun;
  if (out.length > cap) {
    console.log(`[FeedDaily] Promote cap: ${out.length} candidati → ${cap} (promote_max_skus_per_run)`);
    return out.slice(0, cap);
  }
  return out;
}

// FASE 5c: PRICE_CUT competitivo per SKU IN feed civetta dove siamo sopra il
// best_price (paghiamo i click ma perdiamo i confronti). Cut a best - 0.01,
// verifica Salva Bilancio + margine fascia come fallback.
async function findCompetitivePriceCuts(tenantId, config, snapshot, excludeSkus = new Set()) {
  if (!snapshot || snapshot.overTarget) return [];
  // Esclude regole Sconto (prezzo imposto, non si tocca).
  // Priorità ordering: 1) stagionalità (in-season/entrante prima), 2) margine
  // assoluto post-cut DESC (massimo guadagno per pezzo), 3) vendite store.
  const { rows } = await pool.query(`
    SELECT p.sku, p.product_name,
      ROUND(p.sell_price::numeric, 2) AS sell_price,
      ROUND(COALESCE(p.erp_cost, p.erp_cost_imputed, 0)::numeric, 4) AS erp_cost,
      ROUND(p.margin_pct::numeric, 1) AS margin_pct,
      p.sales_30d_seller,
      phs.scraper_position, phs.scraper_competitor_count, phs.seasonal_score,
      ROUND(phs.scraper_best_price::numeric, 2) AS best_price
    FROM products p
    JOIN product_health_scores phs ON phs.tenant_id=p.tenant_id AND phs.sku=p.sku
    LEFT JOIN feed_killers fk ON fk.tenant_id=p.tenant_id AND fk.sku=p.sku AND fk.is_active=true
    LEFT JOIN feed_quarantine fq ON fq.tenant_id=p.tenant_id AND fq.sku=p.sku AND fq.reactivated=false
    LEFT JOIN price_rules pr ON pr.rule_id = p.price_rule_id AND pr.tenant_id = $1
    WHERE p.tenant_id=$1
      AND COALESCE(p.is_civetta, false)=true
      AND p.saleable=true
      AND (COALESCE(p.erp_stock,0)+COALESCE(p.supplier_stock,0))>0
      AND phs.scraper_best_price > 0
      AND p.sell_price > phs.scraper_best_price + 0.01
      AND fk.id IS NULL AND fq.id IS NULL
      AND COALESCE(p.erp_cost, p.erp_cost_imputed, 0) > 0
      AND (pr.rule_type IS NULL OR pr.rule_type != 'sconto')
    ORDER BY
      COALESCE(phs.seasonal_score, 70) DESC,
      (phs.scraper_best_price - 0.01 - COALESCE(p.erp_cost, p.erp_cost_imputed, 0)) DESC,
      COALESCE(p.sales_30d_seller, 0) DESC
    LIMIT $2
  `, [tenantId, config.competitivePriceCutLimit]);

  const out = [];
  for (const r of rows) {
    if (excludeSkus.has(r.sku)) continue;
    const sellPrice = parseFloat(r.sell_price);
    const erpCost = parseFloat(r.erp_cost) || 0;
    const bestPrice = parseFloat(r.best_price) || 0;
    const newPrice = +(bestPrice - 0.01).toFixed(2);
    const acc = isCutAcceptable(newPrice, erpCost, config.salvaBilancioMinEur);
    if (!acc.ok) continue;
    out.push({
      sku: r.sku, name: r.product_name, action: 'PRICE_CUT',
      reason: `Competitivo: pos ${r.scraper_position}, attuale €${sellPrice} > best €${bestPrice}. Cut a €${newPrice} → margine €${acc.marginEur.toFixed(2)} (${acc.marginPct.toFixed(1)}%, ${acc.okBy === 'eur' ? 'OK Salva Bilancio' : 'OK fascia'})`,
      category: 'competitive_price_cut',
      cost: 0, clicks: 0,
      currentPrice: sellPrice,
      recommendedPrice: newPrice,
      priceCutPct: +(((sellPrice - newPrice) / sellPrice) * 100).toFixed(1),
      newMarginPct: +acc.marginPct.toFixed(1),
      newMarginEur: +acc.marginEur.toFixed(2),
      position: r.scraper_position,
    });
  }
  return out;
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
  // Archive previous non-KEEP actions to feed_action_history (audit trail)
  await pool.query(`
    INSERT INTO feed_action_history (tenant_id, sku, action, action_reason, action_source, recommended_price, health_score, classification)
    SELECT fa.tenant_id, fa.sku, fa.action, fa.action_reason, fa.action_source, fa.recommended_price,
           (SELECT health_score FROM product_health_scores WHERE tenant_id = fa.tenant_id AND sku = fa.sku),
           (SELECT classification FROM product_health_scores WHERE tenant_id = fa.tenant_id AND sku = fa.sku)
    FROM feed_actions fa
    WHERE fa.tenant_id = $1 AND fa.action IN ('REMOVE', 'ADD', 'PRICE_CUT')
  `, [tenantId]);

  // Clear old feed_actions
  await pool.query(`DELETE FROM feed_actions WHERE tenant_id = $1`, [tenantId]);

  // Ordine = priorita' in caso di conflitto SKU (ON CONFLICT DO NOTHING tiene
  // il primo). REMOVE prima (decisione definitiva di uscita); ADD subito dopo
  // (promozione attiva sovrascrive eventuali MONITOR delle briglie larghe);
  // PRICE_CUT e KEEP (in feed); MONITOR ultimo (osservazione passiva).
  const allActions = [
    ...actions.remove.map(a => ({ ...a, action: 'REMOVE' })),
    ...(actions.add || []).map(a => ({ ...a, action: 'ADD' })),
    ...actions.priceCut.map(a => ({ ...a, action: 'PRICE_CUT' })),
    ...actions.keep.map(a => ({ ...a, action: 'KEEP' })),
    ...actions.monitor.map(a => ({ ...a, action: 'MONITOR' })),
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
      // ON CONFLICT DO NOTHING perche' uno stesso SKU puo' apparire in piu' categorie
      // (es. remove + monitor in eccezioni). Mantieni il primo (ordine: REMOVE > KEEP > PRICE_CUT > MONITOR > ADD).
      await pool.query(`
        INSERT INTO feed_actions
          (tenant_id, sku, action, action_reason, action_source,
           clicks_consumed, cost_consumed, tp_position, direct_revenue,
           has_conversions, current_price, recommended_price, price_cut_pct)
        VALUES ${values.join(',')}
        ON CONFLICT (tenant_id, sku) DO NOTHING
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

async function buildRuleSet(tenantId, rules, priceRulesMap) {
  const excludedPriceRuleTypes = new Set();
  const excludedBrands = new Set();
  const protectedSkus = new Set();
  const excludedSkus = new Set();
  const noPriceCutSkus = new Set();   // SKU precomputati che non devono ricevere PRICE_CUT

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

  // Precomputo SKU da escludere PRICE_CUT in base a excludedBrands.
  // Match su brand E su manufacturer (UNIFARCO/BAKEL hanno brand vuoto in
  // Magento ma manufacturer popolato con codice Farmadati).
  if (excludedBrands.size > 0) {
    const list = [...excludedBrands];
    const { rows: bs } = await pool.query(
      `SELECT sku FROM products
       WHERE tenant_id = $1
         AND (LOWER(COALESCE(brand,'')) = ANY($2)
              OR LOWER(COALESCE(manufacturer,'')) = ANY($2))`,
      [tenantId, list]
    );
    for (const r of bs) noPriceCutSkus.add(r.sku);
  }

  return {
    canPriceCut(p) {
      if (p.rule_type && excludedPriceRuleTypes.has(p.rule_type)) return false;
      if (noPriceCutSkus.has(p.sku)) return false;
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
  const ruleSet = await buildRuleSet(tenantId, tenantRules);
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
  // (briglie larghe: se vendono nello store >= soglia, MONITOR invece di REMOVE)
  const { rows: quarantined } = await pool.query(`
    SELECT fq.sku, fq.quarantine_level, fq.reason, p.product_name,
           COALESCE(p.sales_30d_seller, 0) AS sales_30d_seller
    FROM feed_quarantine fq
    JOIN products p ON p.sku = fq.sku AND p.tenant_id = fq.tenant_id
    WHERE fq.tenant_id = $1 AND fq.reactivated = false
  `, [tenantId]);
  const triageSKUs = new Set(actions.remove.map(a => a.sku));
  let releasedQuar = 0;
  for (const q of quarantined) {
    if (triageSKUs.has(q.sku)) continue; // Already in remove from triage
    const storeSales = parseFloat(q.sales_30d_seller) || 0;
    if (config.quarantineReleaseMinStoreSales > 0 && storeSales >= config.quarantineReleaseMinStoreSales) {
      actions.monitor.push({
        sku: q.sku, name: q.product_name, action: 'MONITOR',
        reason: `Briglie larghe: quarantenato Q${q.quarantine_level} MA vende ${storeSales}/30g in store (>= ${config.quarantineReleaseMinStoreSales}). Lascio in feed.`,
        category: 'quarantine_release', cost: 0, clicks: 0,
      });
      releasedQuar++;
      continue;
    }
    actions.remove.push({
      sku: q.sku, name: q.product_name, action: 'REMOVE',
      reason: `In quarantena Q${q.quarantine_level}: ${q.reason}`,
      category: 'quarantined', cost: 0, clicks: 0,
    });
  }
  // Also include active killers not yet quarantined
  const { rows: activeKillers } = await pool.query(`
    SELECT fk.sku, p.product_name, fk.reason,
           COALESCE(p.sales_30d_seller, 0) AS sales_30d_seller
    FROM feed_killers fk
    JOIN products p ON p.sku = fk.sku AND p.tenant_id = fk.tenant_id
    WHERE fk.tenant_id = $1 AND fk.is_active = true
  `, [tenantId]);
  const allRemoveSKUs = new Set(actions.remove.map(a => a.sku));
  let releasedKiller = 0;
  for (const k of activeKillers) {
    if (allRemoveSKUs.has(k.sku)) continue;
    const storeSales = parseFloat(k.sales_30d_seller) || 0;
    if (config.killerSkipMinStoreSales > 0 && storeSales >= config.killerSkipMinStoreSales) {
      actions.monitor.push({
        sku: k.sku, name: k.product_name, action: 'MONITOR',
        reason: `Briglie larghe: killer MA vende ${storeSales}/30g in store. Lascio in feed.`,
        category: 'killer_release', cost: 0, clicks: 0,
      });
      releasedKiller++;
      continue;
    }
    actions.remove.push({
      sku: k.sku, name: k.product_name, action: 'REMOVE',
      reason: k.reason, category: 'killer', cost: 0, clicks: 0,
      quarantineDays: 30,
    });
  }
  console.log(`[FeedDaily] Total REMOVE: ${actions.remove.length} (triage: ${stats.killers + stats.bruciatori}, quarantined: ${quarantined.length - releasedQuar}, killers: ${activeKillers.length - releasedKiller})`);
  if (releasedQuar > 0 || releasedKiller > 0) {
    console.log(`[FeedDaily] Briglie larghe: rilasciati ${releasedQuar} quarantenati + ${releasedKiller} killer in MONITOR`);
  }

  // FASE 4b: Price cut per civetta=1 zero click con domanda
  const zeroPriceCuts = await findPriceCutCandidates(tenantId, config, snapshot);
  actions.priceCut.push(...zeroPriceCuts);
  console.log(`[FeedDaily] Price cuts (zero-click + triage): ${actions.priceCut.length}`);

  // FASE 5: Pepite
  const removedCost = actions.remove.reduce((s, a) => s + (a.cost || 0), 0);
  const pepite = await findPepite(tenantId, config, snapshot, removedCost);
  actions.add = pepite;
  console.log(`[FeedDaily] Pepite: ${pepite.length} candidate`);

  // FASE 5b: Promozione attiva di SKU non in feed civetta. Doppio criterio:
  //  - vendono in store >= soglia AND margine fascia OK → ADD puro
  //  - sopra best_price competitor + Salva Bilancio (margin_eur OR margin_pct
  //    fascia) → ADD con PRICE_CUT contestuale (pepita vera).
  // 0 = "attiva promozione senza vincolo sales" (apre tutto stock>0).
  // Negativo = disattivato. Default 3 = abilitato con minSales=3.
  if (config.promoteStoreSellerMinSales >= 0) {
    const promoted = await findStoreSellerPromotions(
      tenantId, config, snapshot,
      new Set(actions.add.map(a => a.sku))
    );
    actions.add.push(...promoted);
    const nSalva = promoted.filter(p => p.category === 'promotion_salva_bilancio').length;
    console.log(`[FeedDaily] Promozione store sellers: +${promoted.length} ADD (${nSalva} con cut Salva Bilancio, ${promoted.length - nSalva} ADD puri)`);
  }

  // FASE 5c: PRICE_CUT competitivo per SKU in feed con prezzo > best_price.
  // Verifica Salva Bilancio + fascia margine. Limita a competitivePriceCutLimit
  // per non sommergere Magento di PUT.
  if (config.competitivePriceCutLimit > 0) {
    const exclude = new Set([
      ...actions.priceCut.map(p => p.sku),
      ...actions.add.map(a => a.sku),
    ]);
    const cuts = await findCompetitivePriceCuts(tenantId, config, snapshot, exclude);
    actions.priceCut.push(...cuts);
    console.log(`[FeedDaily] PRICE_CUT competitivi (Salva Bilancio): +${cuts.length}`);
  }

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

  // Log to optimization_log (audit timeline visible in UI "Log modifiche")
  try {
    const { logAction } = require('./optimizationLog');
    await logAction(tenantId, 'feed_daily_engine',
      `Ciclo giornaliero: ${result.stats.REMOVE} REMOVE, ${result.stats.PRICE_CUT} PRICE_CUT, ${result.stats.KEEP} KEEP, ${result.stats.ADD} ADD, ${result.stats.MONITOR} MONITOR`,
      actions.remove.length + actions.priceCut.length + (actions.add?.length || 0),
      [],
      { stats: result.stats, savedCost: removedCost, killers: killers.detected.length });
  } catch (logErr) {
    console.warn('[FeedDaily] optimization_log write failed:', logErr.message);
  }

  // AI audit (fire-and-forget, non blocca; throttle interno 30 min).
  // Errori AI vengono solo loggati: l'engine procede normalmente.
  try {
    const { auditTenantRun } = require('./aiAuditor');
    auditTenantRun(tenantId, snapshot, result.stats).catch(() => {});
  } catch (e) { /* aiAuditor non disponibile, skip */ }

  return result;
}

module.exports = { runDailyFeedEngine, buildGlobalSnapshot, detectKillers };
