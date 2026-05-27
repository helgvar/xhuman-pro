/**
 * Rule Optimizer — analizza settimanalmente le regole prezzo Farmabooster di ogni tenant
 * e produce raccomandazioni di modifica (mai disattivazioni).
 *
 * Logica severity:
 *   🔴 RED: incidenza > 25% OR threshold_ratio > 30% OR (clicks >= 200 AND conv < 5%)
 *   🟡 YELLOW: incidenza 15-25% OR threshold_ratio 15-30%
 *   🟢 GREEN: incidenza < 15% AND threshold_ratio < 15%
 *
 * Categorie raccomandazione:
 *   - high_incidence: markup troppo aggressivo per la fascia → abbassare
 *   - threshold_risk: troppi SKU in posizione 8-10 (rischio flip in SalvaBilancio)
 *   - low_conversion: tanti click ma poche conversioni → prezzo dinamico spinge troppo
 *   - low_visibility: pochi click su tanti SKU (markup li tiene fuori finestra)
 *   - top_search_underperform: regola TopSearch con incidenza > gemella diretta
 *
 * NB: niente modifiche operative. Solo lettura + scrittura raccomandazioni in DB.
 */

const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const CPC_DEFAULT = 0.27;
// Tre fasce MOL store (def. utente 3/5/2026):
//   - MOL_FLOOR_PCT (15%): MINIMO assoluto. Hard constraint: nessuna proposta puo' far
//     scendere lo store MOL sotto questo valore.
//   - MOL_STANDARD_PCT (20%): STANDARD aziendale. Obiettivo medio-termine, salute normale.
//   - MOL_GOOD_PCT (21%): BUONO. Target di lungo periodo: tutte le ottimizzazioni devono
//     puntare a portarci e mantenerci sopra questa soglia.
const MOL_FLOOR_PCT = 15;
const MOL_STANDARD_PCT = 20;
const MOL_GOOD_PCT = 21;

function molBand(molPct) {
  if (molPct == null) return 'unknown';
  if (molPct < MOL_FLOOR_PCT) return 'critical';
  if (molPct < MOL_STANDARD_PCT) return 'minimum';
  if (molPct < MOL_GOOD_PCT) return 'standard';
  return 'good';
}

// Stima il margine % atteso della SINGOLA REGOLA dopo un cambio di markup (linearizzato).
// markup_pct e' "(price - cost) / price * 100" per definizione contabile.
function estimateRuleMolPostCut(currentRuleMarginPct, currentMarkupPct, newMarkupPct) {
  if (!currentMarkupPct || !newMarkupPct || !currentRuleMarginPct) return null;
  const ratio = newMarkupPct / currentMarkupPct;
  return +(currentRuleMarginPct * ratio).toFixed(2);
}

// Stima il MOL STORE post-cut, pesando il delta della regola per il suo peso sul fatturato store.
// Formula: newStoreMol = storeMol - (currentRuleMargin - newRuleMargin) * (ruleRevenue / storeRevenue)
function estimateStoreMolPostRuleCut(storeMolPct, currentRuleMarginPct, currentMarkupPct, newMarkupPct, ruleRevenue, storeRevenue) {
  if (storeMolPct == null || !storeRevenue || storeRevenue <= 0) return null;
  const newRuleMargin = estimateRuleMolPostCut(currentRuleMarginPct, currentMarkupPct, newMarkupPct);
  if (newRuleMargin == null) return storeMolPct;
  const ruleWeight = (ruleRevenue || 0) / storeRevenue;
  const deltaMarginPp = currentRuleMarginPct - newRuleMargin;
  const deltaStoreMolPp = deltaMarginPp * ruleWeight;
  return +(storeMolPct - deltaStoreMolPp).toFixed(2);
}

// Sub-segment detection: data una distribuzione di SKU per fascia di costo,
// trova se il problema (es. SKU at threshold o senza click) e' concentrato in 1-2 bin.
// Restituisce { should_split: bool, segments: [{from, to, action}] } oppure null.
function detectSubSegment(costDistribution, totalProblematic) {
  if (!costDistribution || costDistribution.length === 0 || totalProblematic < 50) return null;
  // Ordina per fascia
  const sorted = costDistribution.sort((a, b) => a.cost_bin_min - b.cost_bin_min);
  // Trova bin che concentrano > 70% del problema
  const concentrated = sorted.filter(b => b.problematic_count > totalProblematic * 0.5);
  if (concentrated.length === 0 || concentrated.length > 2) return null;
  const ratio = concentrated.reduce((s, b) => s + b.problematic_count, 0) / totalProblematic;
  if (ratio < 0.7) return null;
  return {
    should_split: true,
    concentrated_bins: concentrated.map(b => ({ from: b.cost_bin_min, to: b.cost_bin_max, n_skus: b.problematic_count })),
    concentration_ratio_pct: +(ratio * 100).toFixed(1),
  };
}

async function analyzeTenant(tenantId, opts = {}) {
  const startedAt = Date.now();
  const dryRun = opts.dryRun === true;

  // 1) Crea run row (idempotente per giorno)
  let runId = null;
  if (!dryRun) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: [existing] } = await pool.query(
      `SELECT id FROM rule_optimization_runs WHERE tenant_id = $1 AND run_date = $2`,
      [tenantId, today]
    );
    if (existing) {
      // Marca le vecchie recommendations di oggi come superseded
      await pool.query(
        `UPDATE rule_recommendations SET status = 'superseded' WHERE run_id = $1 AND status = 'pending'`,
        [existing.id]
      );
      runId = existing.id;
    } else {
      const { rows: [r] } = await pool.query(
        `INSERT INTO rule_optimization_runs (tenant_id, run_date, status) VALUES ($1, $2, 'running') RETURNING id`,
        [tenantId, today]
      );
      runId = r.id;
    }
  }

  // 2) Carica regole CON config attuale (markup, tolleranza, finestra, ecc.)
  const { rows: ruleRows } = await pool.query(
    `SELECT rule_id, rule_name, rule_type, priority, is_active, rule_data FROM price_rules WHERE tenant_id = $1`,
    [tenantId]
  );
  // Map con dati arricchiti (current_* dai rule_data)
  const ruleNameMap = new Map(ruleRows.map(r => {
    const rd = r.rule_data || {};
    // Sourcing della REGOLA Farmabooster (derivato dal rule_data, NON dagli SKU):
    //   erp_ids non vuoto + supplier_ids vuoto → diretto (magazzino farmacia)
    //   supplier_ids non vuoto + erp_ids vuoto → grossista (suppliers)
    //   entrambi presenti → mixed (caso raro)
    //   entrambi vuoti → unknown
    const erpIds = String(rd.erp_ids || '').trim();
    const supplierIds = String(rd.supplier_ids || '').trim();
    let ruleSourcing = 'unknown';
    if (erpIds && !supplierIds) ruleSourcing = 'diretto';
    else if (supplierIds && !erpIds) ruleSourcing = 'grossista';
    else if (erpIds && supplierIds) ruleSourcing = 'mixed';
    return [r.rule_id, {
      ...r,
      current_markup: parseFloat(rd.recharge_pct) || parseFloat(rd.discount_pct) || null,
      current_tolerance: parseFloat(rd.budgetsave_threshold) || null,
      current_window_from: rd.scraper_from_position != null ? parseInt(rd.scraper_from_position) : null,
      current_window_to: rd.scraper_position != null ? parseInt(rd.scraper_position) : null,
      current_dynamic_price: rd.position_dynamic_price === true,
      current_from_cost: parseFloat(rd.from_cost) || null,
      current_to_cost: parseFloat(rd.to_cost) || null,
      current_only_topsearch: rd.only_topsearch === true,
      rule_sourcing: ruleSourcing,
      erp_ids: erpIds,
      supplier_ids: supplierIds,
    }];
  }));

  // 3) Carica avg_tp_cpc per il tenant
  const { rows: cpcRows } = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'avg_tp_cpc'`,
    [tenantId]
  );
  const cpc = parseFloat(cpcRows[0]?.config_value) || CPC_DEFAULT;

  // 3b) Soglia free shipping per tenant (per la formula MOL)
  const { rows: fsRows } = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'free_shipping_threshold_eur'`,
    [tenantId]
  );
  const freeShippingThreshold = parseFloat(fsRows[0]?.config_value) || 59.90;

  // 3c) Costo spedizione del tenant (criptato in tenant_configs come 'trovaprezzi_shipping_cost')
  let shippingCost = 0;
  try {
    const { rows: scRows } = await pool.query(
      `SELECT config_value FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'trovaprezzi_shipping_cost'`,
      [tenantId]
    );
    if (scRows[0]?.config_value) {
      const raw = decrypt(scRows[0].config_value);
      // valori formattati italiano "4,90" → 4.90
      shippingCost = parseFloat(String(raw).replace(',', '.')) || 0;
    }
  } catch (e) {
    console.warn(`[RuleOptimizer] Cannot read shipping_cost for ${tenantId}:`, e.message);
  }

  // 3d) MOL STORE-WIDE (formula utente):
  //     MOL = (Fatturato_store - Costo_merce_store - Costo_spedizione_per_ordini_>=_soglia_free) / Fatturato_store
  //     Tutti i valori IVA INCLUSA (revenue da row_total_incl_tax, cost da erp_cost FB iva incl).
  //     Il costo spedizione e' a carico nostro SOLO se l'ordine supera la soglia free shipping.
  //     E' la media ponderata di tutti gli ordini store negli ultimi 30gg.
  const { rows: storeMolRows } = await pool.query(`
    WITH order_totals AS (
      SELECT
        o.id AS order_id,
        SUM(COALESCE(oi.row_total_incl_tax, oi.row_total)) AS order_revenue_incl,
        SUM(oi.qty_ordered * COALESCE(NULLIF(p.erp_cost, 0), p.erp_cost_imputed, 0)) AS order_cost_incl
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.tenant_id = o.tenant_id AND p.sku = oi.sku
      WHERE o.tenant_id = $1
        AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND o.order_date::date >= CURRENT_DATE - 30
      GROUP BY o.id
    )
    SELECT
      COUNT(*) AS n_orders,
      COALESCE(SUM(order_revenue_incl), 0)::float AS store_revenue_30d,
      COALESCE(SUM(order_cost_incl), 0)::float AS store_cost_30d,
      COUNT(*) FILTER (WHERE order_revenue_incl >= $2)::int AS n_orders_free_shipping,
      (COUNT(*) FILTER (WHERE order_revenue_incl >= $2)::float * $3) AS store_shipping_cost_30d
    FROM order_totals
    WHERE order_cost_incl > 0
  `, [tenantId, freeShippingThreshold, shippingCost]);
  const storeRevenue30d = parseFloat(storeMolRows[0]?.store_revenue_30d) || 0;
  const storeCost30d = parseFloat(storeMolRows[0]?.store_cost_30d) || 0;
  const storeShippingCost30d = parseFloat(storeMolRows[0]?.store_shipping_cost_30d) || 0;
  const storeMargin30d = storeRevenue30d - storeCost30d - storeShippingCost30d;
  const storeMolPct = storeRevenue30d > 0 ? +((storeMargin30d / storeRevenue30d) * 100).toFixed(2) : null;

  // 3e) MOL STORE PRECEDENTE (30-60gg): per detection trend negativo.
  //     Se MOL e' calato di >= 5pp tra le 2 finestre, attiva alert "verifica contesto business"
  //     PRIMA di proporre cut markup. Causa tipica: cambio filtro costo minimo TP.
  const { rows: storeMolPrevRows } = await pool.query(`
    WITH order_totals AS (
      SELECT o.id AS order_id,
        SUM(COALESCE(oi.row_total_incl_tax, oi.row_total)) AS order_revenue_incl,
        SUM(oi.qty_ordered * COALESCE(NULLIF(p.erp_cost, 0), p.erp_cost_imputed, 0)) AS order_cost_incl
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.tenant_id = o.tenant_id AND p.sku = oi.sku
      WHERE o.tenant_id = $1
        AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND o.order_date::date BETWEEN CURRENT_DATE - 60 AND CURRENT_DATE - 31
      GROUP BY o.id
    )
    SELECT
      COALESCE(SUM(order_revenue_incl), 0)::float AS rev,
      COALESCE(SUM(order_cost_incl), 0)::float AS cost,
      COUNT(*) FILTER (WHERE order_revenue_incl >= $2)::int AS n_free,
      (COUNT(*) FILTER (WHERE order_revenue_incl >= $2)::float * $3) AS ship
    FROM order_totals
    WHERE order_cost_incl > 0
  `, [tenantId, freeShippingThreshold, shippingCost]);
  const storeRevenuePrev = parseFloat(storeMolPrevRows[0]?.rev) || 0;
  const storeCostPrev = parseFloat(storeMolPrevRows[0]?.cost) || 0;
  const storeShipPrev = parseFloat(storeMolPrevRows[0]?.ship) || 0;
  const storeMolPrev30dPct = storeRevenuePrev > 0
    ? +(((storeRevenuePrev - storeCostPrev - storeShipPrev) / storeRevenuePrev) * 100).toFixed(2)
    : null;
  const storeMolTrendPp = (storeMolPct != null && storeMolPrev30dPct != null)
    ? +(storeMolPct - storeMolPrev30dPct).toFixed(2)
    : null;
  // Alert MOL: calo trend >= 2pp (sensibile, evita rumore < 2pp)
  const molTrendAlert = (storeMolTrendPp != null && storeMolTrendPp <= -2);

  // 3f) Stima soglia COSTO MINIMO TP attiva: P10 dei costi degli SKU is_civetta=true.
  //     Cambi di policy lato Farmabooster (es. da min €10 a min €3) si vedono qui.
  //     Confronto P10 attuale vs media storica per detection cambio policy.
  const { rows: tpCostRows } = await pool.query(`
    WITH civetta_costs AS (
      SELECT erp_cost FROM products
      WHERE tenant_id = $1 AND is_civetta = true AND erp_cost > 0
    )
    SELECT
      ROUND(percentile_cont(0.10) WITHIN GROUP (ORDER BY erp_cost)::numeric, 2)::float AS p10,
      ROUND(percentile_cont(0.05) WITHIN GROUP (ORDER BY erp_cost)::numeric, 2)::float AS p5,
      ROUND(MIN(erp_cost)::numeric, 2)::float AS min_cost,
      COUNT(*) AS n_civetta
    FROM civetta_costs
  `, [tenantId]);
  const tpMinCostP10 = parseFloat(tpCostRows[0]?.p10) || null;
  const tpMinCostP5 = parseFloat(tpCostRows[0]?.p5) || null;
  const tpMinCostAbsolute = parseFloat(tpCostRows[0]?.min_cost) || null;
  const nCivettaSkus = parseInt(tpCostRows[0]?.n_civetta) || 0;
  // Alert "esposizione TP allargata": P10 costo civetta sotto €6 = molti SKU low-cost
  // (margine assoluto basso, spedizione divora il MOL). Segnale strutturale anche
  // se non c'e' un trend acuto.
  const tpExposureAlert = (tpMinCostP10 != null && tpMinCostP10 < 6);
  // Alert master: trend negativo OPPURE esposizione larga.
  // In entrambi i casi blocca cut markup e suggerisce verifica del contesto business.
  const molDropAlert = molTrendAlert || tpExposureAlert;
  // Headroom verso il FLOOR (15%): quanto cut posso permettermi senza violare il minimo.
  // Distanza verso il GOOD (21%): obiettivo di lungo periodo per tutti i tenant.
  const storeMolHeadroomPct = storeMolPct != null ? +(storeMolPct - MOL_FLOOR_PCT).toFixed(2) : null;
  const storeMolGapToGoodPct = storeMolPct != null ? +(MOL_GOOD_PCT - storeMolPct).toFixed(2) : null;
  const storeMolBand = molBand(storeMolPct);
  const nOrdersFreeShipping = parseInt(storeMolRows[0]?.n_orders_free_shipping) || 0;
  const nOrdersTotal = parseInt(storeMolRows[0]?.n_orders) || 0;
  console.log(`[RuleOptimizer] [tenant ${tenantId}] store MOL ${storeMolPct}% [${storeMolBand}] trend ${storeMolTrendPp != null ? (storeMolTrendPp >=0 ? '+' : '') + storeMolTrendPp + 'pp' : 'n/d'} (prev ${storeMolPrev30dPct || 'n/d'}%) | TP min cost P10 €${tpMinCostP10 || 'n/d'} (${nCivettaSkus} civetta SKU)${molDropAlert ? ' 🚨 DROP ALERT' : ''}`);

  // 4a) Carica basket metrics (per traini cross-sell)
  const { rows: basketRows } = await pool.query(
    `SELECT sku, traino_score, traino_role, avg_cart_value, pct_in_large_carts
     FROM product_basket_metrics WHERE tenant_id = $1`,
    [tenantId]
  );
  const basketMap = new Map(basketRows.map(b => [b.sku, b]));

  // 4b) Cost distribution per regola (per sub-segment detection)
  const { rows: costDistRows } = await pool.query(`
    WITH zc AS (
      SELECT product_code AS sku FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 30 GROUP BY 1
    ),
    ord AS (
      SELECT oi.sku FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND o.order_date::date >= CURRENT_DATE - 30 GROUP BY oi.sku
    )
    SELECT
      p.price_rule_id AS rule_id,
      WIDTH_BUCKET(LEAST(GREATEST(p.erp_cost::numeric, 0.01), 100), 0, 100, 20) AS cost_bin,
      COUNT(*) AS n_skus,
      COUNT(*) FILTER (WHERE p.scraper_position BETWEEN 8 AND 10 OR (zc.sku IS NOT NULL AND ord.sku IS NULL)) AS problematic_count,
      MIN(p.erp_cost) AS bin_min,
      MAX(p.erp_cost) AS bin_max
    FROM products p
    LEFT JOIN zc USING(sku)
    LEFT JOIN ord USING(sku)
    WHERE p.tenant_id = $1 AND p.is_civetta = true AND p.price_rule_id IS NOT NULL AND p.erp_cost > 0
    GROUP BY p.price_rule_id, cost_bin
  `, [tenantId]);
  const costDistMap = new Map();
  for (const r of costDistRows) {
    if (!costDistMap.has(r.rule_id)) costDistMap.set(r.rule_id, []);
    costDistMap.get(r.rule_id).push({
      cost_bin_min: parseFloat(r.bin_min) || 0,
      cost_bin_max: parseFloat(r.bin_max) || 0,
      n_skus: parseInt(r.n_skus),
      problematic_count: parseInt(r.problematic_count),
    });
  }

  // 4) Aggrega metriche per regola
  const { rows: ruleMetrics } = await pool.query(`
    WITH zc AS (
      SELECT product_code AS sku, SUM(clicks) AS clicks
      FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 30
      GROUP BY 1
    ),
    ord AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) AS ords, SUM(oi.row_total) AS rev
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND o.order_date::date >= CURRENT_DATE - 30
      GROUP BY 1
    ),
    quar AS (
      SELECT sku FROM feed_quarantine
      WHERE tenant_id = $1 AND reactivated = false
    )
    SELECT
      p.price_rule_id AS rule_id,
      COUNT(*) AS skus_total,
      COUNT(*) FILTER (WHERE p.is_topsearch = true) AS skus_topsearch,
      COUNT(*) FILTER (WHERE p.is_civetta = true) AS skus_civetta,
      COUNT(*) FILTER (WHERE zc.sku IS NOT NULL) AS skus_with_clicks,
      COUNT(*) FILTER (WHERE ord.sku IS NOT NULL) AS skus_with_orders,
      COUNT(*) FILTER (WHERE p.scraper_position BETWEEN 8 AND 10) AS skus_at_threshold,
      COUNT(*) FILTER (WHERE p.scraper_position > 10) AS skus_outside_window,
      COUNT(*) FILTER (WHERE quar.sku IS NOT NULL) AS skus_in_quarantine,
      COALESCE(SUM(zc.clicks), 0)::int AS total_clicks,
      COALESCE(SUM(ord.ords), 0)::int AS total_orders,
      COALESCE(ROUND(SUM(ord.rev)::numeric, 2), 0)::float AS total_revenue,
      ROUND(AVG(p.margin_pct) FILTER (WHERE p.margin_pct > 0)::numeric, 2)::float AS avg_margin_pct,
      ROUND(AVG(p.scraper_position) FILTER (WHERE p.scraper_position > 0)::numeric, 1)::float AS avg_position,
      ROUND(AVG(p.sell_price) FILTER (WHERE p.sell_price > 0)::numeric, 2)::float AS avg_sell_price,
      ROUND(AVG(p.erp_cost) FILTER (WHERE p.erp_cost > 0)::numeric, 2)::float AS avg_cost,
      MIN(p.erp_cost) FILTER (WHERE p.erp_cost > 0)::float AS min_cost,
      MAX(p.erp_cost) FILTER (WHERE p.erp_cost > 0)::float AS max_cost,
      COUNT(*) FILTER (WHERE COALESCE(p.raw_data->>'min_cost_source','') = 'E') AS skus_diretto,
      COUNT(*) FILTER (WHERE COALESCE(p.raw_data->>'min_cost_source','') = 'S') AS skus_grossista
    FROM products p
    LEFT JOIN zc USING(sku)
    LEFT JOIN ord USING(sku)
    LEFT JOIN quar USING(sku)
    WHERE p.tenant_id = $1 AND p.price_rule_id IS NOT NULL AND p.is_civetta = true
    GROUP BY p.price_rule_id
    HAVING COUNT(*) > 0
  `, [tenantId]);

  // 5) Costruisci raccomandazioni per regola
  const recommendations = [];
  for (const m of ruleMetrics) {
    const skus = parseInt(m.skus_total) || 0;
    const clicks = parseInt(m.total_clicks) || 0;
    const orders = parseInt(m.total_orders) || 0;
    const revenue = parseFloat(m.total_revenue) || 0;
    const cost = +(clicks * cpc).toFixed(2);
    const incidence = revenue > 0 ? +(cost / revenue * 100).toFixed(2) : null;
    const conv = clicks > 0 ? +(orders / clicks * 100).toFixed(2) : null;
    const thresholdRatio = skus > 0 ? +(parseInt(m.skus_at_threshold) / skus * 100).toFixed(1) : 0;
    const isTopSearch = parseInt(m.skus_topsearch) >= skus * 0.5; // regola "TopSearch" se >50% SKU sono TS

    // Severity
    let severity = 'green';
    const reasons = [];
    if (incidence != null && incidence > 25) { severity = 'red'; reasons.push(`incidenza ${incidence}%`); }
    if (thresholdRatio > 30) { severity = 'red'; reasons.push(`${thresholdRatio}% SKU in pos 8-10`); }
    if (clicks >= 200 && (conv == null || conv < 5)) {
      if (severity !== 'red') severity = 'yellow';
      reasons.push(`${clicks} click ma conv ${conv || 0}%`);
    }
    if (severity !== 'red') {
      if (incidence != null && incidence > 15) { severity = 'yellow'; reasons.push(`incidenza ${incidence}%`); }
      else if (thresholdRatio > 15) { severity = 'yellow'; reasons.push(`${thresholdRatio}% SKU pos 8-10`); }
    }
    if (skus >= 500 && clicks < 30) {
      severity = severity === 'green' ? 'yellow' : severity;
      reasons.push(`solo ${clicks} click su ${skus} SKU (poca visibilita')`);
    }

    // Categoria + raccomandazione + proposed changes
    const ruleInfo = ruleNameMap.get(String(m.rule_id)) || ruleNameMap.get(m.rule_id) || {};
    const ruleName = ruleInfo.rule_name || `Rule ${m.rule_id}`;
    const ruleType = ruleInfo.rule_type || 'unknown';
    // Markup REALE da rule_data (NON dal nome - puo' essere obsoleto)
    const nominalMarkup = ruleInfo.current_markup;
    const currentTolerance = ruleInfo.current_tolerance;
    const currentWindowFrom = ruleInfo.current_window_from;
    const currentWindowTo = ruleInfo.current_window_to;
    const currentDynamic = ruleInfo.current_dynamic_price;
    const currentFromCost = ruleInfo.current_from_cost;
    const currentToCost = ruleInfo.current_to_cost;
    const ruleSourcing = ruleInfo.rule_sourcing || 'unknown';

    let category = 'monitor';
    let title = `${ruleName} — ${severity.toUpperCase()}`;
    let recommendationText = '';
    let proposedChanges = {};
    let expectedImpact = {};

    // MOL Guard: il cut markup non deve far scendere il MOL STORE sotto MOL_FLOOR_PCT (20%)
    // Il MOL della singola regola puo' anche scendere sotto floor (es. traini), purche' la
    // media ponderata store resti >= floor. La regola pesa per il suo % di fatturato store.
    const currentRuleMargin = parseFloat(m.avg_margin_pct) || 0;
    const ruleRevenueWeight = storeRevenue30d > 0 ? (revenue / storeRevenue30d) : 0;
    function safeCutMarkup(targetMarkupPct) {
      if (!nominalMarkup || !targetMarkupPct) return targetMarkupPct;
      if (storeMolPct == null) return +targetMarkupPct.toFixed(1); // no store ref → no guard
      const newStoreMol = estimateStoreMolPostRuleCut(storeMolPct, currentRuleMargin, nominalMarkup, targetMarkupPct, revenue, storeRevenue30d);
      if (newStoreMol != null && newStoreMol < MOL_FLOOR_PCT) {
        // Trova il markup minimo che mantiene STORE MOL >= floor
        // newStoreMol = storeMol - (currentRuleMargin - newRuleMargin) * w
        // floor = storeMol - (currentRuleMargin - newRuleMargin) * w
        // newRuleMargin = currentRuleMargin - (storeMol - floor) / w
        // newMarkup = nominalMarkup * (newRuleMargin / currentRuleMargin)
        if (ruleRevenueWeight <= 0 || currentRuleMargin <= 0) return +targetMarkupPct.toFixed(1);
        const minNewRuleMargin = currentRuleMargin - (storeMolPct - MOL_FLOOR_PCT) / ruleRevenueWeight;
        const minMarkup = nominalMarkup * Math.max(0, minNewRuleMargin) / currentRuleMargin;
        return +Math.max(targetMarkupPct, minMarkup).toFixed(1);
      }
      return +targetMarkupPct.toFixed(1);
    }

    // Basket analysis per i SKU della regola
    let trainoCount = 0;
    let trainoRevenue = 0;
    if (basketMap.size > 0 && skus < 5000) {
      // Per regole non gigantesche, conto i traini consultando basketMap su SKU della regola
      const { rows: ruleSkusList } = await pool.query(
        `SELECT sku FROM products WHERE tenant_id = $1 AND price_rule_id = $2 AND is_civetta = true`,
        [tenantId, m.rule_id]
      );
      for (const s of ruleSkusList) {
        const b = basketMap.get(s.sku);
        if (b && parseFloat(b.traino_score) >= 70) {
          trainoCount++;
          trainoRevenue += parseFloat(b.avg_cart_value) || 0;
        }
      }
    }
    const trainoPct = skus > 0 ? +(trainoCount / skus * 100).toFixed(1) : 0;

    // Sub-segment detection
    const costDist = costDistMap.get(m.rule_id) || costDistMap.get(String(m.rule_id)) || [];
    const totalProblematic = parseInt(m.skus_at_threshold) + parseInt(m.skus_outside_window);
    const subSegment = (severity !== 'green' && skus >= 200) ? detectSubSegment(costDist, totalProblematic) : null;

    // Helper proposte: solo se differenti dal current. Restituisce null se no-op.
    function proposeMarkupCut(targetCut) {
      if (nominalMarkup == null || !targetCut) return null;
      // BAND-GUARD: non proporre cut markup se MOL store NON e' almeno STANDARD (>=20%).
      // In fascia MINIMUM/CRITICAL la direzione strategica e' salire verso 21%, non consumare headroom.
      if (storeMolBand !== 'standard' && storeMolBand !== 'good') return null;
      // TREND-GUARD: se il MOL e' in calo significativo, NON proporre cut.
      // Prima va verificato il contesto business (filtro costo TP, cambio mix, ecc.).
      if (molDropAlert) return null;
      const safe = safeCutMarkup(targetCut);
      if (safe == null || safe >= nominalMarkup - 0.4) return null; // no-op (cut < 0.5pp)
      const ruleMolPost = estimateRuleMolPostCut(currentRuleMargin, nominalMarkup, safe);
      const storeMolPost = estimateStoreMolPostRuleCut(storeMolPct, currentRuleMargin, nominalMarkup, safe, revenue, storeRevenue30d);
      const molBlocked = storeMolPost != null && storeMolPost < MOL_FLOOR_PCT;
      return {
        markup_from: nominalMarkup,
        markup_to: safe,
        rule_mol_pre_pct: currentRuleMargin,
        rule_mol_post_pct: ruleMolPost,
        store_mol_pre_pct: storeMolPct,
        store_mol_post_pct: storeMolPost,
        rule_revenue_weight_pct: +(ruleRevenueWeight * 100).toFixed(2),
        mol_blocked: molBlocked,
      };
    }
    function proposeToleranceUp(deltaUp = 2) {
      if (currentTolerance == null) return null;
      const target = +(currentTolerance + deltaUp).toFixed(1);
      if (target <= currentTolerance + 0.4) return null;
      // Non andare oltre il 20% (improbabile sia utile)
      if (currentTolerance >= 18) return null;
      return { tolerance_from: currentTolerance, tolerance_to: target };
    }
    function proposeWindowNarrower(targetTo) {
      if (currentWindowTo == null || targetTo == null) return null;
      if (targetTo >= currentWindowTo) return null;
      return { window_from: currentWindowFrom || 0, window_to_from: currentWindowTo, window_to: targetTo };
    }
    // Inverso del cut: alza markup. Indicato quando incid>10% e MOL store non good,
    // o quando la regola brucia spesa TP senza convertire e c'e' headroom verso target.
    function proposeMarkupUp(deltaUp = 2) {
      if (nominalMarkup == null || nominalMarkup >= 35) return null;
      const target = +(nominalMarkup + deltaUp).toFixed(1);
      return {
        markup_from: nominalMarkup,
        markup_to: target,
        direction: 'up',
        rule_revenue_weight_pct: +(ruleRevenueWeight * 100).toFixed(2),
        rationale: 'incidenza elevata + MOL store non buono: alzare markup riduce click marginali, protegge margine',
      };
    }
    // Quarantena SKU burner (click >= 3 in 30g, 0 ordini in 60g) della regola.
    async function proposeQuarantineBurner() {
      if (!skus || skus < 20) return null;
      const { rows } = await pool.query(
        `WITH zc AS (
           SELECT product_code AS sku, SUM(clicks) AS clicks
           FROM zombie_clicks WHERE tenant_id=$1 AND fetch_date >= CURRENT_DATE - 30 GROUP BY 1
         ),
         ord AS (
           SELECT DISTINCT oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id
           WHERE o.tenant_id=$1 AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
             AND o.order_date::date >= CURRENT_DATE - 60
         )
         SELECT p.sku, zc.clicks
         FROM products p
         JOIN zc ON zc.sku=p.sku
         LEFT JOIN ord ON ord.sku=p.sku
         WHERE p.tenant_id=$1 AND p.price_rule_id=$2 AND p.is_civetta=true
           AND zc.clicks >= 3 AND ord.sku IS NULL`,
        [tenantId, m.rule_id]
      );
      if (rows.length < Math.max(5, skus * 0.03)) return null; // serve almeno 3% burner
      const wastedClicks = rows.reduce((s, r) => s + parseInt(r.clicks), 0);
      const wastedSpend = +(wastedClicks * cpc).toFixed(0);
      return {
        action: 'quarantine_burner_skus',
        n_skus: rows.length,
        wasted_clicks_30g: wastedClicks,
        wasted_spend_eur_30g: wastedSpend,
        sample_skus: rows.slice(0, 10).map(r => r.sku),
      };
    }
    // Suggerisce esclusione SKU sotto soglia costo se la spedizione mangia il margine.
    function proposeShippingExclude(minCostEur = 5) {
      if (currentFromCost == null || currentFromCost >= minCostEur) return null;
      if (incidence == null || incidence < 10) return null; // non urgente se incidenza bassa
      return {
        action: 'shipping_cost_floor',
        cost_floor_from_eur: currentFromCost,
        cost_floor_to_eur: minCostEur,
        rationale: `SKU sotto €${minCostEur} di costo: con spedizione €4.90 il margine assoluto e' eroso. Considera esclusione.`,
      };
    }
    // Sub-segment piu' aggressivo: anche quando severity=yellow e cost range > €20.
    function proposeSubSegmentDeep() {
      if (currentFromCost == null || currentToCost == null) return null;
      const span = currentToCost - currentFromCost;
      if (span < 15) return null; // gia' fascia stretta
      if (subSegment?.should_split) return null; // gia' segnalato sopra
      if (clicks < 100) return null;
      // Split semplice in 2: punto medio
      const mid = +((currentFromCost + currentToCost) / 2).toFixed(2);
      return {
        action: 'split_rule',
        split_at_cost: mid,
        rationale: `Fascia costo €${currentFromCost}-${currentToCost} (span €${span.toFixed(1)}). Split a €${mid} permette markup differenziati per ottimizzare margine assoluto.`,
      };
    }
    // Killer split: SKU sotto-prezzati aggressivamente vs competitor (position 1 ma margine basso)
    async function proposeKillerSplit() {
      if (!skus || skus < 30) return null;
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM products p JOIN feed_killers fk ON fk.tenant_id=p.tenant_id AND fk.sku=p.sku AND fk.is_active=true
         WHERE p.tenant_id=$1 AND p.price_rule_id=$2`,
        [tenantId, m.rule_id]
      );
      const n = rows[0]?.n || 0;
      if (n < 10) return null;
      return {
        action: 'isolate_killers',
        n_killers: n,
        rationale: `${n} SKU rilevati come killer (sotto-prezzati vs competitor): isolarli in regola dedicata con markup ridotto previene cannibalizzazione.`,
      };
    }
    // Confronto cross-tenant: SKU performante nella rete ma killer qui
    async function proposeCrossTenantLeverage() {
      if (!skus || skus < 30) return null;
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n_better_elsewhere
         FROM products p
         JOIN cross_tenant_products ctp ON ctp.sku = p.sku
         WHERE p.tenant_id=$1 AND p.price_rule_id=$2 AND ctp.verdict='universal_star'`,
        [tenantId, m.rule_id]
      );
      const n = rows[0]?.n_better_elsewhere || 0;
      if (n < 5) return null;
      return {
        action: 'review_cross_tenant_winners',
        n_winners_elsewhere: n,
        rationale: `${n} SKU di questa regola sono "universal_star" nella rete xHumanPro (top performer in altri tenant) ma qui non rendono: verificare pricing / esposizione.`,
      };
    }
    // Helper testo current/proposed per chiarezza
    const currentSummary = [
      nominalMarkup != null ? `markup ${nominalMarkup}%` : null,
      currentTolerance != null ? `tolleranza ${currentTolerance}%` : null,
      currentWindowTo != null ? `finestra ${currentWindowFrom || 0}-${currentWindowTo}` : null,
      currentFromCost != null && currentToCost != null ? `costo €${currentFromCost}-${currentToCost}` : null,
    ].filter(Boolean).join(', ');

    // CROSS-CHECK metriche vs parametri regola: spiegare PERCHE' il dato di vendita
    // suggerisce la modifica del parametro specifico (markup/tolleranza/finestra/costo)
    // — non basta la metrica aggregata, serve il legame esplicito col parametro regola.
    const crossChecks = [];
    // 0. ALERT STORE (PRIMA di tutto): se trend MOL negativo o esposizione TP allargata,
    //    blocca proposte aggressive di cut markup e segnala contesto business da verificare.
    if (molDropAlert) {
      const segnali = [];
      if (molTrendAlert) {
        segnali.push(`📉 Trend MOL ${storeMolTrendPp}pp (${storeMolPrev30dPct}% 30-60gg → ${storeMolPct}% ultimi 30gg)`);
      }
      if (tpExposureAlert) {
        segnali.push(`📦 Esposizione TP allargata: P10 costo civetta €${tpMinCostP10} (min €${tpMinCostAbsolute}, ${nCivettaSkus} SKU). Sotto €6 il margine assoluto e' eroso da spedizione`);
      }
      crossChecks.push(`🚨 ALERT STORE: ${segnali.join(' · ')}. PRIMA di accettare proposte di cut markup verifica il CONTESTO BUSINESS: 1) Filtro costo minimo TP cambiato? (€10 = restrittivo, €6 = bilanciato, €3 = aggressivo); 2) Cambio sourcing Diretto→Grossista? 3) Promozioni/sconti recenti su Magento? 4) Aumento costi grossisti? Le proposte di cut markup sono BLOCCATE finche' la causa root non e' identificata.`);
    }
    // 1. Markup nominale vs MOL reale (livello REGOLA) → gap = competitor pulling prices down
    if (nominalMarkup != null && currentRuleMargin > 0) {
      const gap = +(nominalMarkup - currentRuleMargin).toFixed(1);
      if (gap >= 5) {
        crossChecks.push(`Markup configurato ${nominalMarkup}% ma MOL regola solo ${currentRuleMargin}% (gap ${gap}pp = competitor abbassano i prezzi: il markup nominale non si traduce in margine)`);
      } else if (gap < 0) {
        crossChecks.push(`MOL regola ${currentRuleMargin}% > markup nominale ${nominalMarkup}% (probabili sotto-fasce di costo a margine alto: ok)`);
      }
    }
    // 2. Finestra vs posizione media → SKU al limite
    if (currentWindowTo != null && m.avg_position != null) {
      const avgPos = parseFloat(m.avg_position);
      const edgeGap = currentWindowTo - avgPos;
      if (edgeGap < 1.5 && skus >= 50) {
        crossChecks.push(`Finestra 0-${currentWindowTo} ma posizione media ${avgPos} (al limite della finestra: SKU borderline rischiano flip ad ogni variazione competitor)`);
      } else if (edgeGap > 5 && clicks > 100) {
        crossChecks.push(`Finestra 0-${currentWindowTo} ma posizione media ${avgPos} (i nostri stanno gia' molto avanti: la finestra puo' restringersi senza perdere visibilita')`);
      }
    }
    // 3. Tolleranza vs SKU at threshold → tolleranza non basta a coprire
    if (currentTolerance != null && thresholdRatio > 15) {
      crossChecks.push(`Tolleranza ${currentTolerance}% configurata ma ${thresholdRatio}% SKU comunque in pos 8-10 (la tolleranza attuale non basta a tenerli dentro)`);
    }
    // 4. Cost range regola vs cost range SKU problematici → mismatch fascia
    if (currentFromCost != null && currentToCost != null && m.avg_cost != null) {
      const avgC = parseFloat(m.avg_cost);
      const ruleSpan = currentToCost - currentFromCost;
      if (ruleSpan > 30 && subSegment?.should_split) {
        crossChecks.push(`Regola copre costo €${currentFromCost}-${currentToCost} (span €${ruleSpan}) ma il problema e' concentrato in €${subSegment.concentrated_bins[0].from?.toFixed(2)}-${subSegment.concentrated_bins[subSegment.concentrated_bins.length-1].to?.toFixed(2)} (range troppo largo per un'unica regola)`);
      }
    }
    // 5. Click/conv vs markup → tanti click ma niente conv = prezzo borderline
    if (clicks >= 200 && conv != null && conv < 5 && nominalMarkup != null) {
      crossChecks.push(`${clicks} click in 30gg ma conv ${conv}% (utenti ci trovano ma scelgono altri: a parita' di markup ${nominalMarkup}% il prezzo finale non e' competitivo nel checkout)`);
    }
    // 6. Visibilita' vs markup → pochi click su tanti SKU = markup ci spinge fuori
    if (skus >= 500 && clicks < 30 && nominalMarkup != null) {
      crossChecks.push(`${skus} SKU ma solo ${clicks} click (markup ${nominalMarkup}% ci tiene fuori dalla finestra: competitor sotto al nostro prezzo target)`);
    }
    // 7. MOL ceiling teorico vs MOL floor → segnale per cambio sourcing (obj 4)
    if (m.avg_cost != null && m.avg_sell_price != null) {
      const ceiling = ((parseFloat(m.avg_sell_price) - parseFloat(m.avg_cost)) / parseFloat(m.avg_sell_price)) * 100;
      if (ceiling < MOL_FLOOR_PCT) {
        crossChecks.push(`MOL ceiling teorico ${ceiling.toFixed(1)}% < floor ${MOL_FLOOR_PCT}% (al prezzo medio di mercato, il costo attuale NON permette MOL target → segnale CAMBIO SOURCING / valutare equivalente Diretto)`);
      }
    }
    // 8. MOL HEADROOM (STORE-WIDE): quanto margine store ho sopra il floor 20%
    //    L'headroom e' del MOL store, non per regola. Una regola pesa per il suo % fatturato.
    //    Per una regola con peso w, il cut markup massimo e' tale da non far scendere lo
    //    storeMOL sotto il floor: storeMOL - (Δrule_margin * w) >= floor
    //    → Δrule_margin_max = headroomStore / w → newRuleMargin_min = currentRuleMargin - Δmax
    //    → newMarkup_min = nominalMarkup * (newRuleMargin_min / currentRuleMargin)
    let maxMarkupCutPp = null; // cut MAX in punti markup prima che lo store scenda sotto floor
    let safeMarkupCutPp = null; // cut SAFE (meta' dell'headroom store → buffer 50%)
    if (storeMolHeadroomPct != null && storeMolHeadroomPct > 0 &&
        nominalMarkup != null && nominalMarkup > 0 &&
        currentRuleMargin > 0 && ruleRevenueWeight > 0) {
      const maxRuleMarginDrop = storeMolHeadroomPct / ruleRevenueWeight; // pp di margine regola
      const minRuleMargin = Math.max(0, currentRuleMargin - maxRuleMarginDrop);
      const minMarkup = nominalMarkup * (minRuleMargin / currentRuleMargin);
      maxMarkupCutPp = +Math.max(0, nominalMarkup - minMarkup).toFixed(1);
      safeMarkupCutPp = +(maxMarkupCutPp / 2).toFixed(1);
    }
    // Le 3 fasce determinano il TONO della raccomandazione:
    //   critical (<15%): nessun cut markup. Solo difesa: tolleranza/finestra/sub-segmenti/sourcing.
    //   minimum (15-20%): cut SOLO conservativi (max meta' headroom, mai sotto floor 15%).
    //   standard (20-21%): cut moderati ok, ma direzione = portare lo store sopra 21% (good).
    //   good (>=21%): cut piu' aggressivi ok per spingere volume/fatturato.
    if (storeMolBand === 'critical') {
      crossChecks.push(`🚨 MOL store ${storeMolPct}% < FLOOR ${MOL_FLOOR_PCT}% (deficit ${Math.abs(storeMolHeadroomPct)}pp). Fascia CRITICA: nessun cut markup proponibile. Direzione: portare lo store almeno al ${MOL_FLOOR_PCT}% via leve difensive (sourcing Diretto, pricing prodotti alto-MOL, riduzione spesa TP) — gap a "Buono" ${MOL_GOOD_PCT}% = ${storeMolGapToGoodPct}pp.`);
    } else if (storeMolBand === 'minimum') {
      // Fascia MINIMO: NON suggerire cut markup (la direzione e' salire verso 21%, non consumare headroom).
      // Mostra solo lo stato store + gap a "Buono" come contesto, senza numero teorico fuorviante.
      crossChecks.push(`⚠️ MOL store ${storeMolPct}% in fascia MINIMO (15-20%). Headroom ${storeMolHeadroomPct}pp sopra floor ${MOL_FLOOR_PCT}%, gap ${storeMolGapToGoodPct}pp a "Buono" ${MOL_GOOD_PCT}%. NON proporre cut markup: la direzione strategica e' salire verso 21%. Solo leve neutre/positive sul MOL (tolleranza, finestra, sub-segmenti).`);
    } else if ((storeMolBand === 'standard' || storeMolBand === 'good') &&
               nominalMarkup != null && maxMarkupCutPp != null && maxMarkupCutPp >= 1) {
      const safeTargetMarkup = +(nominalMarkup - safeMarkupCutPp).toFixed(1);
      const maxTargetMarkup = +(nominalMarkup - maxMarkupCutPp).toFixed(1);
      const bandLabel = storeMolBand === 'good' ? 'BUONO (>=21%)' : `STANDARD (${MOL_STANDARD_PCT}-${MOL_GOOD_PCT}%)`;
      crossChecks.push(`🚀 MOL store ${storeMolPct}% in fascia ${bandLabel}. Headroom ${storeMolHeadroomPct}pp sopra floor ${MOL_FLOOR_PCT}%. Questa regola pesa ${(ruleRevenueWeight * 100).toFixed(1)}% → cut markup MAX ${maxMarkupCutPp}pp (${nominalMarkup}%→${maxTargetMarkup}%), SAFE ${safeMarkupCutPp}pp (${nominalMarkup}%→${safeTargetMarkup}%). Spendibile per crescere volume/fatturato senza scendere sotto floor.`);
    }
    const crossCheckText = crossChecks.length > 0 ? `\n\n📊 Cross-check vendite vs config regola:\n• ${crossChecks.join('\n• ')}` : '';

    // Soglia di incidenza dinamica: in fascia MOL critical/minimum scattiamo a >15%,
    // in standard/good restiamo a >25% (l'incidenza alta lì è meno urgente).
    const highIncidThreshold = (storeMolBand === 'critical' || storeMolBand === 'minimum') ? 15 : 25;
    if (incidence != null && incidence > highIncidThreshold && (severity === 'red' || severity === 'yellow')) {
      category = 'high_incidence';
      // Strategia: in fascia MOL bassa NON tagliamo markup (eroderebbe ulteriormente).
      // Proviamo cut markup solo se MOL store standard/good; altrimenti proponiamo markup UP
      // per ridurre i click marginali e migliorare l'incidenza.
      const rawSuggestion = nominalMarkup ? Math.max(nominalMarkup - 3, nominalMarkup * 0.7) : null;
      const cutProp = proposeMarkupCut(rawSuggestion);
      const upProp = (!cutProp && (storeMolBand === 'critical' || storeMolBand === 'minimum'))
        ? proposeMarkupUp(incidence > 20 ? 4 : 3)
        : null;
      recommendationText = `Incidenza ${incidence}% (target <${highIncidThreshold}% in fascia MOL ${storeMolBand}). ${reasons.join(', ')}. ` +
        `Config attuale: ${currentSummary || 'n/d'}. ` +
        (subSegment?.should_split
          ? `🎯 Problema concentrato nella fascia costo €${subSegment.concentrated_bins[0].from?.toFixed(2)}-${subSegment.concentrated_bins[subSegment.concentrated_bins.length-1].to?.toFixed(2)}. Considera SPLIT regola invece di modifica globale. `
          : cutProp
            ? `Proposta CUT: abbassare markup da ${nominalMarkup}% a ${cutProp.markup_to}%${cutProp.mol_blocked ? ' (LIMITATO da floor MOL store)' : ''}. MOL store post: ~${cutProp.store_mol_post_pct?.toFixed(2) || 'n/d'}% (peso regola ${cutProp.rule_revenue_weight_pct}% del fatturato store). `
            : upProp
              ? `🆙 Proposta MARKUP UP: ${nominalMarkup}% → ${upProp.markup_to}% (+${(upProp.markup_to - nominalMarkup).toFixed(1)}pp). Il MOL store è in fascia ${storeMolBand}: tagliare markup peggiorerebbe il margine. Alzando il markup riduci i click marginali (atteso -15/-25% click, -1/-2pp incidenza), proteggi il margine. `
              : nominalMarkup ? `Markup ${nominalMarkup}% gia' al limite. Valutare cambio sourcing. ` : '');
      if (cutProp) proposedChanges = { ...cutProp, sub_segment: subSegment };
      else if (upProp) proposedChanges = { ...upProp, sub_segment: subSegment };
      else if (subSegment) proposedChanges = { sub_segment: subSegment };
      expectedImpact = cutProp
        ? { cost_delta_eur: -(cost * 0.25), revenue_delta_eur: revenue * 0.15, incidence_delta_pct: -8 }
        : { cost_delta_eur: -(cost * 0.20), revenue_delta_eur: -(revenue * 0.08), incidence_delta_pct: -3, margin_protected: true };
    } else if (severity === 'red' && thresholdRatio > 30) {
      category = 'threshold_risk';
      const winProp = proposeWindowNarrower(currentWindowTo != null ? Math.max(7, currentWindowTo - 3) : null);
      const tolProp = proposeToleranceUp(2);
      const proposalParts = [];
      if (winProp) proposalParts.push(`restringere finestra da 0-${winProp.window_to_from} a 0-${winProp.window_to}`);
      if (tolProp) proposalParts.push(`alzare tolleranza da ${tolProp.tolerance_from}% a ${tolProp.tolerance_to}%`);
      recommendationText = `${thresholdRatio}% degli SKU in posizione 8-10 (rischio flip SalvaBilancio). ` +
        `Config attuale: ${currentSummary || 'n/d'}. ` +
        (proposalParts.length > 0 ? `Proposta: ${proposalParts.join(' OPPURE ')}.` : `Tolleranza/finestra gia' nei valori suggeriti, valutare riduzione markup.`);
      proposedChanges = { ...(winProp || {}), ...(tolProp || {}) };
      expectedImpact = { incidence_delta_pct: -3, revenue_delta_eur: revenue * 0.05 };
    } else if (severity !== 'green' && clicks >= 200 && conv != null && conv < 5) {
      category = 'low_conversion';
      const tolProp = proposeToleranceUp(2);
      recommendationText = `${clicks} click in 30gg ma solo ${orders} ordini (conv ${conv}%). Posizione media ${m.avg_position} OK. ` +
        `Config attuale: ${currentSummary || 'n/d'}. ` +
        (tolProp ? `Proposta: alzare tolleranza da ${tolProp.tolerance_from}% a ${tolProp.tolerance_to}% per recuperare SKU borderline.` : `Tolleranza gia' alta (${currentTolerance}%). Valutare rivedere prezzo dinamico o markup.`);
      proposedChanges = tolProp || {};
      expectedImpact = { revenue_delta_eur: revenue * 0.1 };
    } else if (skus >= 500 && clicks < 30) {
      category = 'low_visibility';
      const rawSuggestion = nominalMarkup ? Math.max(nominalMarkup - 3, nominalMarkup * 0.7) : null;
      const cutProp = proposeMarkupCut(rawSuggestion);
      recommendationText = `Regola con ${skus} SKU ma solo ${clicks} click in 30gg = invisibile su TP. ` +
        `Config attuale: ${currentSummary || 'n/d'}. ` +
        (subSegment?.should_split
          ? `Problema concentrato in fascia €${subSegment.concentrated_bins[0].from?.toFixed(2)}-${subSegment.concentrated_bins[subSegment.concentrated_bins.length-1].to?.toFixed(2)}: split consigliato. `
          : cutProp
            ? `Proposta: ridurre markup da ${nominalMarkup}% a ${cutProp.markup_to}%${cutProp.mol_blocked ? ' (LIMITATO floor MOL store)' : ''}. MOL store post: ~${cutProp.store_mol_post_pct?.toFixed(2) || 'n/d'}%.`
            : nominalMarkup ? `Markup ${nominalMarkup}% gia' al limite per il floor MOL store.` : '');
      if (cutProp) proposedChanges = { ...cutProp, sub_segment: subSegment };
      else if (subSegment) proposedChanges = { sub_segment: subSegment };
      expectedImpact = { revenue_delta_eur: revenue * 0.5, cost_delta_eur: cost * 0.2 };
    } else if (severity === 'yellow') {
      category = 'fine_tuning';
      // Quando incidenza è borderline alta e MOL store è in fascia critical/minimum,
      // proponi markup UP invece della classica tolerance up (che non riduce la spesa).
      const wantMarkupUp = (incidence != null && incidence > 10 &&
                            (storeMolBand === 'critical' || storeMolBand === 'minimum'));
      const upProp = wantMarkupUp ? proposeMarkupUp(2) : null;
      const tolProp = proposeToleranceUp(1.5);
      recommendationText = `${reasons.join(', ')}. Config attuale: ${currentSummary || 'n/d'}. ` +
        (upProp
          ? `🆙 Proposta: markup ${nominalMarkup}% → ${upProp.markup_to}% (+2pp). Incidenza ${incidence}% in fascia MOL ${storeMolBand}: alza markup per ridurre click marginali e proteggere margine. ${tolProp ? `Alternativa light: tolleranza ${tolProp.tolerance_from}% → ${tolProp.tolerance_to}%.` : ''}`
          : tolProp ? `Proposta light: tolleranza ${tolProp.tolerance_from}% → ${tolProp.tolerance_to}%.` : `Config gia' nei valori suggeriti, monitorare prossima settimana.`);
      proposedChanges = upProp || tolProp || {};
    } else {
      category = 'ok';
      title = `${ruleName} — OK`;
      recommendationText = `Regola in salute (incidenza ${incidence != null ? incidence + '%' : 'n/d'}, conv ${conv != null ? conv + '%' : 'n/d'}). Config attuale: ${currentSummary || 'n/d'}. Mantenere.`;
    }

    // TopSearch underperform check (gemello diretta vs grossista)
    if (isTopSearch && incidence != null && incidence > 8) {
      // Cerca regola gemella diretta (stesso TopSearch ma min_cost_source diverso)
      const twin = ruleMetrics.find(rm => {
        const t = (ruleNameMap.get(String(rm.rule_id))?.rule_name || '').toLowerCase();
        return t.includes('top search') && rm.rule_id !== m.rule_id;
      });
      if (twin) {
        const twinClicks = parseInt(twin.total_clicks) || 0;
        const twinRev = parseFloat(twin.total_revenue) || 0;
        const twinIncidence = twinRev > 0 ? +((twinClicks * cpc) / twinRev * 100).toFixed(2) : null;
        if (twinIncidence != null && twinIncidence < incidence * 0.6) {
          category = 'top_search_underperform';
          recommendationText = `Regola TopSearch sotto-perfomante: incidenza ${incidence}% vs gemella ${twinIncidence}% (${ruleNameMap.get(String(twin.rule_id))?.rule_name}). ` +
            `Il costo del sourcing di questa regola (${ruleSourcing}) non e' competitivo per i TopSearch. ` +
            `Forzare il sourcing dal gemello, OR abbassare il markup di 2-3 punti per allinearsi.`;
        }
      }
    }

    // Inietta warning basket-aware se la regola ha molti traini
    if (trainoCount >= 5 && trainoPct >= 10 && (severity === 'red' || severity === 'yellow')) {
      recommendationText += ` ⚠️ ATTENZIONE: ${trainoCount} SKU di questa regola sono "traini" (carrelli medi >= €90). Tagliare il markup potrebbe danneggiare il loro ruolo cross-sell. Valutare con attenzione.`;
    }

    // OBIETTIVI STRATEGICI tag: quale dei 4 obiettivi questa raccomandazione serve
    const objectives = [];
    if (expectedImpact.revenue_delta_eur > 0) objectives.push('obj_revenue_up');
    if (expectedImpact.cost_delta_eur < 0) objectives.push('obj_cost_down');
    if (storeMolPct != null && storeMolPct >= MOL_FLOOR_PCT) objectives.push('obj_mol_protect');
    // Diretto preference: tag obj_4 SOLO se la REGOLA stessa e' configurata Diretto
    // (rule_data.erp_ids non vuoto e supplier_ids vuoto), non in base agli SKU al suo interno.
    if (ruleSourcing === 'diretto') objectives.push('obj_diretto_priority');

    // Suggerimento shift Grossista→Diretto (calibrato): per regole Grossista sotto-performanti,
    // verifica quanti dei TOP SKU della regola (con click/vendite) hanno ALSO erp_stock>0.
    // NB: il magazzino farmacia e' UNO solo, mentre i grossisti sono 4: il numero assoluto di
    // skus_diretto vs skus_grossista NON e' un confronto sensato. Conta la % di SKU top che
    // hanno copertura Diretto utilizzabile.
    if (ruleSourcing === 'grossista' && incidence != null && incidence > 15) {
      const { rows: topWithDirect } = await pool.query(`
        WITH zc AS (
          SELECT product_code AS sku, SUM(clicks) AS clicks
          FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 30
          GROUP BY 1
        ),
        top_skus AS (
          SELECT p.sku, p.erp_stock, p.erp_cost,
                 (p.raw_data->>'erp_cost')::numeric AS direct_cost,
                 (p.raw_data->>'supplier_cost')::numeric AS supplier_cost
          FROM products p
          LEFT JOIN zc ON zc.sku = p.sku
          WHERE p.tenant_id = $1 AND p.price_rule_id = $2 AND p.is_civetta = true
            AND zc.clicks IS NOT NULL
          ORDER BY zc.clicks DESC NULLS LAST
          LIMIT 50
        )
        SELECT
          COUNT(*) AS top_skus_count,
          COUNT(*) FILTER (WHERE erp_stock > 0) AS top_with_erp_stock,
          COUNT(*) FILTER (WHERE direct_cost > 0 AND supplier_cost > 0
                           AND direct_cost <= supplier_cost * 1.05) AS top_direct_competitive
        FROM top_skus
      `, [tenantId, m.rule_id]);
      const topCount = parseInt(topWithDirect[0]?.top_skus_count) || 0;
      const topWithStock = parseInt(topWithDirect[0]?.top_with_erp_stock) || 0;
      const topCompetitive = parseInt(topWithDirect[0]?.top_direct_competitive) || 0;
      if (topCount > 0 && topWithStock / topCount >= 0.3 && topCompetitive >= 5) {
        const pctStock = Math.round(topWithStock / topCount * 100);
        const pctComp = Math.round(topCompetitive / topCount * 100);
        recommendationText += ` 📦 OBIETTIVO #4: ${topCompetitive} dei top ${topCount} SKU di questa regola Grossista (${pctComp}%) hanno equivalente in magazzino farmacia a costo competitivo (Diretto cost <= Grossista +5%). Valutare uno SPLIT: passare questi SKU su una regola Diretto gemella per recuperare margine.`;
      }
      // se invece pochi/zero SKU hanno equivalente Diretto, NON suggerire shift (sarebbe fuorviante)
    }

    // ECONOMIC GUARD: blocca proposte che alzano spesa o abbassano fatturato (= viola revenue-first)
    // Stime sono approssimative; il guard si basa sui valori in expected_impact gia' calcolati.
    //
    // ECCEZIONE markup UP: il guard NON si applica alle proposte markup_up. Sono difensive:
    // l'obiettivo è proteggere margine in fascia MOL critical/minimum riducendo click marginali.
    // Il revenue_delta sarà negativo (atteso) ma è un trade-off voluto. Il flag margin_protected
    // segnala questa eccezione esplicita.
    const revDelta = expectedImpact.revenue_delta_eur || 0;
    const costDelta = expectedImpact.cost_delta_eur || 0;
    const netPnl = revDelta + (-costDelta); // positivo = guadagno netto atteso
    const isMarkupUp = proposedChanges.direction === 'up';
    let economicBlocked = false;
    if (!isMarkupUp && Object.keys(proposedChanges).length > 0 && proposedChanges.markup_to != null) {
      if (revDelta < 0 || costDelta > 0 || netPnl <= 0) {
        economicBlocked = true;
        recommendationText = `🚫 PROPOSTA NON APPLICABILE (vincolo economico): ` +
          `delta atteso fatturato ${revDelta >= 0 ? '+' : ''}${revDelta.toFixed(0)}€, ` +
          `delta spesa ${costDelta >= 0 ? '+' : ''}${costDelta.toFixed(0)}€, ` +
          `net PnL ${netPnl.toFixed(0)}€. ` +
          `Originale: ${recommendationText}`;
        if (severity === 'red') severity = 'yellow';
      }
    }
    proposedChanges.economic_blocked = economicBlocked;
    proposedChanges.net_pnl_eur = +netPnl.toFixed(2);

    // Aggancia il cross-check parametri-vs-vendite al testo finale
    if (crossCheckText) {
      recommendationText = recommendationText + crossCheckText;
    }

    // Costruisci una SINTESI del problema in 1-2 frasi (separata dalla recommendationText
    // estesa). Sarà mostrata nel blocco "B · PROBLEMA" della card UI.
    const problemBits = [];
    if (incidence != null && incidence > 25) problemBits.push(`Incidenza ${incidence}% (target <15%): troppo alta`);
    else if (incidence != null && incidence > 15) problemBits.push(`Incidenza ${incidence}% sopra il target del 15%`);
    if (thresholdRatio > 30) problemBits.push(`${thresholdRatio}% degli SKU in posizione 8-10 (rischio flip SalvaBilancio)`);
    else if (thresholdRatio > 15) problemBits.push(`${thresholdRatio}% degli SKU in posizione 8-10`);
    if (clicks >= 200 && conv != null && conv < 5) problemBits.push(`${clicks} click ma conversione solo ${conv}% (utenti ci trovano ma non comprano)`);
    if (skus >= 500 && clicks < 30) problemBits.push(`Regola con ${skus} SKU ma solo ${clicks} click in 30gg = invisibile su TP`);
    if (molDropAlert) problemBits.push(`MOL store in calo o esposizione TP allargata — verifica contesto business prima`);
    if (problemBits.length === 0) problemBits.push(`Regola in salute, monitorare`);
    const problemSummary = problemBits.join(' · ');

    // Finestra di verifica attesa per i risultati (default 7gg). Per modifiche grosse di
    // markup, 14gg perche' il mercato deve rispondere.
    const verificationWindowDays = (proposedChanges.markup_to != null && nominalMarkup != null &&
      Math.abs(nominalMarkup - proposedChanges.markup_to) >= 3) ? 14 : 7;

    recommendations.push({
      rule_id: String(m.rule_id),
      rule_name: ruleName,
      rule_type: ruleType,
      severity,
      category,
      title,
      recommendation: recommendationText,
      problem_summary: problemSummary,
      verification_window_days: verificationWindowDays,
      proposed_changes: proposedChanges,
      expected_impact: { ...expectedImpact, verification_window_days: verificationWindowDays },
      metrics: {
        skus_total: skus,
        skus_topsearch: parseInt(m.skus_topsearch) || 0,
        skus_with_clicks: parseInt(m.skus_with_clicks) || 0,
        skus_with_orders: parseInt(m.skus_with_orders) || 0,
        skus_at_threshold: parseInt(m.skus_at_threshold) || 0,
        skus_outside_window: parseInt(m.skus_outside_window) || 0,
        skus_in_quarantine: parseInt(m.skus_in_quarantine) || 0,
        skus_diretto: parseInt(m.skus_diretto) || 0,
        skus_grossista: parseInt(m.skus_grossista) || 0,
        // Sourcing della REGOLA Farmabooster (da rule_data.erp_ids/supplier_ids, NON dagli SKU):
        // 'diretto' | 'grossista' | 'mixed' | 'unknown'
        rule_sourcing: ruleSourcing,
        rule_erp_ids: ruleInfo.erp_ids || '',
        rule_supplier_ids: ruleInfo.supplier_ids || '',
        total_clicks: clicks,
        total_orders: orders,
        total_revenue: revenue,
        cost: cost,
        incidence_pct: incidence,
        conv_pct: conv,
        avg_margin_pct: parseFloat(m.avg_margin_pct) || null,
        avg_position: parseFloat(m.avg_position) || null,
        avg_sell_price: parseFloat(m.avg_sell_price) || null,
        threshold_ratio_pct: thresholdRatio,
        nominal_markup_pct: nominalMarkup,
        is_topsearch_rule: isTopSearch,
        avg_cost: parseFloat(m.avg_cost) || null,
        cost_range: m.min_cost != null ? `€${parseFloat(m.min_cost).toFixed(2)}-${parseFloat(m.max_cost).toFixed(2)}` : null,
        // MOL ceiling teorico: dato costo medio, qual e' il MOL massimo raggiungibile
        // se vendessimo al prezzo medio attuale di mercato. Se < 20%, il segmento non
        // permette MOL target con i costi attuali (= dato per fase 4 cambio sourcing).
        mol_ceiling_pct: (m.avg_cost && m.avg_sell_price && m.avg_sell_price > 0)
          ? +(((parseFloat(m.avg_sell_price) - parseFloat(m.avg_cost)) / parseFloat(m.avg_sell_price)) * 100).toFixed(2)
          : null,
        traino_count: trainoCount,
        traino_pct: trainoPct,
        mol_floor_pct: MOL_FLOOR_PCT,
        // STORE-WIDE MOL (riferimento per il floor — formula: rev - cost - shipping_per_free_orders)
        store_mol_pct: storeMolPct,
        store_mol_headroom_pct: storeMolHeadroomPct,
        store_mol_gap_to_good_pct: storeMolGapToGoodPct,
        store_mol_band: storeMolBand,
        mol_standard_pct: MOL_STANDARD_PCT,
        mol_good_pct: MOL_GOOD_PCT,
        // TREND e ALERT (per detection cambio policy / mix / sourcing)
        store_mol_prev30d_pct: storeMolPrev30dPct,
        store_mol_trend_pp: storeMolTrendPp,
        mol_trend_alert: molTrendAlert,
        tp_exposure_alert: tpExposureAlert,
        mol_drop_alert: molDropAlert,
        // Stima soglia costo TP attiva (proxy del filtro Farmabooster sui prodotti in feed)
        tp_min_cost_p10_eur: tpMinCostP10,
        tp_min_cost_p5_eur: tpMinCostP5,
        tp_min_cost_abs_eur: tpMinCostAbsolute,
        n_civetta_skus: nCivettaSkus,
        store_revenue_30d: +storeRevenue30d.toFixed(2),
        store_shipping_cost_30d: +storeShippingCost30d.toFixed(2),
        shipping_cost_unit: shippingCost,
        free_shipping_threshold_eur: freeShippingThreshold,
        rule_revenue_weight_pct: +(ruleRevenueWeight * 100).toFixed(2),
        max_markup_cut_pp: maxMarkupCutPp,
        safe_markup_cut_pp: safeMarkupCutPp,
        objectives,
        problem_summary: problemSummary,
        verification_window_days: verificationWindowDays,
      },
    });
  }

  // 6) Persist
  if (!dryRun && runId) {
    // 6a) Carica le recommendation 'applied' degli ultimi 14gg per questo tenant.
    //     Se la nuova proposta combacia con una applied (stessi proposed_changes core),
    //     la nuova viene registrata come 'applied' (eredita) invece di 'pending', evitando
    //     di "ri-proporre" all'utente azioni che lui ha gia' fatto.
    //     Inoltre, per le pending che NON combaciano, includiamo nelle metrics un riassunto
    //     'prior_actions' delle azioni storiche per la stessa rule (contesto utente).
    const { rows: recentApplied } = await pool.query(
      `SELECT rule_id, proposed_changes, applied_at, applied_by
       FROM rule_recommendations
       WHERE tenant_id = $1 AND status = 'applied' AND applied_at >= NOW() - INTERVAL '14 days'`,
      [tenantId]
    );
    const appliedByRule = new Map();
    for (const a of recentApplied) {
      if (!appliedByRule.has(a.rule_id)) appliedByRule.set(a.rule_id, []);
      appliedByRule.get(a.rule_id).push(a);
    }
    function summarizePriorAction(pa) {
      const pc = pa.proposed_changes || {};
      const parts = [];
      if (pc.markup_to != null && pc.markup_from != null) parts.push(`markup ${pc.markup_from}%→${pc.markup_to}%`);
      else if (pc.markup_to != null) parts.push(`markup→${pc.markup_to}%`);
      if (pc.tolerance_to != null && pc.tolerance_from != null) parts.push(`tolleranza ${pc.tolerance_from}%→${pc.tolerance_to}%`);
      else if (pc.tolerance_to != null) parts.push(`tolleranza→${pc.tolerance_to}%`);
      if (pc.window_to != null && pc.window_to_from != null) parts.push(`finestra 0-${pc.window_to_from}→0-${pc.window_to}`);
      else if (pc.window_to != null) parts.push(`finestra→0-${pc.window_to}`);
      if (pc.sub_segment?.should_split) parts.push('split regola');
      const dateStr = pa.applied_at ? new Date(pa.applied_at).toISOString().slice(0, 10) : 'n/d';
      return { date: dateStr, summary: parts.length > 0 ? parts.join(', ') : 'azione applicata', applied_by: pa.applied_by || null };
    }
    function proposalsMatch(newPC, oldPC) {
      // Match se markup_to/tolerance_to/window_to combaciano (campi "core" dell'azione)
      const keys = ['markup_to', 'tolerance_to', 'window_to'];
      let hasAny = false;
      for (const k of keys) {
        const nv = newPC?.[k];
        const ov = oldPC?.[k];
        if (nv == null && ov == null) continue;
        if (nv == null || ov == null) return false;
        hasAny = true;
        if (Math.abs(parseFloat(nv) - parseFloat(ov)) > 0.05) return false;
      }
      return hasAny; // match solo se almeno un campo core e' presente E combacia
    }

    let red = 0, yellow = 0, green = 0, inheritedApplied = 0;
    for (const rec of recommendations) {
      if (rec.severity === 'red') red++;
      else if (rec.severity === 'yellow') yellow++;
      else green++;
      // Eredita 'applied' se proposta combacia con applied recente per stessa rule
      let initialStatus = 'pending';
      let inheritedAppliedAt = null;
      let inheritedAppliedBy = null;
      const priorApplied = appliedByRule.get(rec.rule_id) || [];
      for (const pa of priorApplied) {
        if (proposalsMatch(rec.proposed_changes, pa.proposed_changes)) {
          initialStatus = 'applied';
          inheritedAppliedAt = pa.applied_at;
          inheritedAppliedBy = pa.applied_by || 'inherited';
          inheritedApplied++;
          break;
        }
      }
      // Inietta 'prior_actions' nelle metrics se ci sono applied recenti per questa rule
      // (utile sopratutto per pending non-ereditate: l'utente vede contesto storico)
      if (priorApplied.length > 0) {
        rec.metrics.prior_actions = priorApplied.map(summarizePriorAction);
      }
      await pool.query(
        `INSERT INTO rule_recommendations
          (run_id, tenant_id, rule_id, rule_name, rule_type, severity, category, title,
           recommendation, proposed_changes, expected_impact, metrics, status, applied_at, applied_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [runId, tenantId, rec.rule_id, rec.rule_name, rec.rule_type, rec.severity,
         rec.category, rec.title, rec.recommendation,
         JSON.stringify(rec.proposed_changes), JSON.stringify(rec.expected_impact),
         JSON.stringify(rec.metrics), initialStatus, inheritedAppliedAt, inheritedAppliedBy]
      );
    }
    if (inheritedApplied > 0) {
      console.log(`[RuleOptimizer] [${tenantId}] ${inheritedApplied} recommendations auto-marked 'applied' (matching prior actions)`);
    }
    await pool.query(`
      UPDATE rule_optimization_runs SET
        rules_analyzed = $2,
        recommendations_count = $3,
        red_count = $4, yellow_count = $5, green_count = $6,
        status = 'completed',
        duration_ms = $7,
        completed_at = NOW()
      WHERE id = $1
    `, [runId, recommendations.length, recommendations.length, red, yellow, green, Date.now() - startedAt]);
  }

  return { runId, recommendations, durationMs: Date.now() - startedAt };
}

async function runWeeklyForAllTenants() {
  const { rows: tenants } = await pool.query(
    "SELECT id, name FROM tenants WHERE status = 'active' ORDER BY name"
  );
  const results = [];
  for (const t of tenants) {
    try {
      const r = await analyzeTenant(t.id);
      results.push({ tenant: t.name, runId: r.runId, recommendations: r.recommendations.length, ms: r.durationMs });
      console.log(`[RuleOptimizer] [${t.name}] ${r.recommendations.length} recommendations in ${r.durationMs}ms`);
      // Feedback loop: dopo l'analisi, verifica le proposte gia' applicate
      try {
        const { verifyTenant } = require('./recommendationVerifier');
        const v = await verifyTenant(t.id);
        const counts = { success: 0, on_track: 0, deviating: 0, failed: 0, pending: 0 };
        for (const x of v) { counts[x.status] = (counts[x.status] || 0) + 1; }
        if (v.length > 0) {
          console.log(`[RuleOptimizer] [${t.name}] verifier: ${v.length} checked (${counts.success} OK, ${counts.deviating} deviating, ${counts.failed} FAILED, ${counts.pending} pending)`);
        }
      } catch (verr) {
        console.error(`[RuleOptimizer] [${t.name}] verifier failed:`, verr.message);
      }
    } catch (err) {
      console.error(`[RuleOptimizer] [${t.name}] FAILED:`, err.message);
      results.push({ tenant: t.name, error: err.message });
    }
  }
  return results;
}

module.exports = { analyzeTenant, runWeeklyForAllTenants };
