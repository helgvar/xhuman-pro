/**
 * GA4 Analytics - Attribution Engine
 *
 * Queries GA4 to determine:
 * 1. Which products were purchased in Trovaprezzi sessions (direct attribution)
 * 2. Which products were purchased after landing on a different TP product (assisted/indirect)
 * 3. Channel-level KPIs (trovaprezzi vs organic vs paid vs direct)
 * 4. Source/medium session breakdown
 *
 * Key: GA4 itemId = Magento entity_id, NOT SKU. We need products.magento_entity_id mapping.
 */

const { pool } = require('../db/pool');
const { googleApiService } = require('./googleApi');

const GA4_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// In-memory cache per tenant
const ga4Cache = new Map();

/**
 * Build entity_id → SKU mapping from products table
 * GA4 tracks Magento entity_id as itemId, we need to remap to SKU
 */
async function buildEntityIdMap(tenantId) {
  const { rows } = await pool.query(
    `SELECT sku, magento_entity_id FROM products
     WHERE tenant_id = $1 AND magento_entity_id IS NOT NULL`,
    [tenantId]
  );
  const map = {};
  for (const r of rows) {
    map[String(r.magento_entity_id)] = r.sku;
  }
  return map;
}

/**
 * Build entity_id → SKU mapping from GA4 itemId + itemName
 * For short itemIds (Magento entity_id), query GA4 for the item name,
 * then match against product_name in the catalog
 */
async function buildEntityIdMapFromGA4(client, propertyId, tenantId) {
  const map = {};

  try {
    // Get itemId + itemName from GA4 (last 30 days, trovaprezzi sessions)
    const [resp] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [
        { name: 'itemId' },
        { name: 'itemName' },
      ],
      metrics: [{ name: 'itemsPurchased' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionSource',
          stringFilter: { matchType: 'CONTAINS', value: 'trovaprezzi', caseSensitive: false },
        },
      },
      limit: 10000,
    });

    // Collect unmapped items (short IDs that don't look like SKUs)
    const unmapped = [];
    for (const row of (resp.rows || [])) {
      const itemId = row.dimensionValues[0].value;
      const itemName = row.dimensionValues[1].value;
      if (!itemId || itemId === '(not set)') continue;

      // SKUs are typically 9+ digits (minsan) — short IDs are entity_ids
      if (itemId.length <= 6 && /^\d+$/.test(itemId) && itemName && itemName !== '(not set)') {
        unmapped.push({ entityId: itemId, name: itemName });
      }
    }

    if (unmapped.length === 0) return map;

    // Batch match by product name
    const names = unmapped.map(u => u.name);
    const { rows: matches } = await pool.query(
      `SELECT sku, product_name FROM products
       WHERE tenant_id = $1 AND product_name = ANY($2)`,
      [tenantId, names]
    );

    const nameToSku = {};
    for (const m of matches) nameToSku[m.product_name] = m.sku;

    for (const u of unmapped) {
      if (nameToSku[u.name]) {
        map[u.entityId] = nameToSku[u.name];
      }
    }

    console.log(`[GA4] Built entity_id map from GA4 names: ${Object.keys(map).length} mapped out of ${unmapped.length} unmapped items`);

    // Persist to products table for future runs
    for (const [entityId, sku] of Object.entries(map)) {
      await pool.query(
        `UPDATE products SET magento_entity_id = $1 WHERE tenant_id = $2 AND sku = $3 AND magento_entity_id IS NULL`,
        [entityId, tenantId, sku]
      );
    }
  } catch (err) {
    console.error('[GA4] buildEntityIdMapFromGA4 error:', err.message);
  }

  return map;
}

/**
 * Extract product code (SKU) from landing page URL
 * Farmacri pattern: /nome-prodotto-CODICE.html (CODICE = 9-digit minsan at end)
 * Also handles ?sku=CODE and /NUMERIC_CODE.html patterns
 */
function extractProductCodeFromUrl(url) {
  if (!url) return null;
  if (url === '(not set)' || url === '/' || url.startsWith('/checkout')) return null;

  // Pattern 1: ?sku=CODE or &sku=CODE
  const skuMatch = url.match(/[?&]sku=([^&]+)/i);
  if (skuMatch) return skuMatch[1];

  // Pattern 2: Farmacri-style URL: /nome-prodotto-CODICE.html
  // CODICE is a 6-12 digit number at the end of the slug before .html
  const slugMatch = url.match(/-(\d{6,12})\.html/);
  if (slugMatch) return slugMatch[1];

  // Pattern 3: /NUMERIC_CODE.html (pure numeric URL)
  const numericMatch = url.match(/\/(\d{6,15})\.html/);
  if (numericMatch) return numericMatch[1];

  // Pattern 4: ?id=NNN
  const idMatch = url.match(/[?&]id=(\d+)/);
  if (idMatch) return idMatch[1];

  return null;
}

/**
 * Query 1: Products purchased in Trovaprezzi sessions
 * Returns per-SKU: { trovaprezziPurchases, trovaprezziRevenue }
 */
async function queryTrovaprezziPurchases(client, propertyId, days = 90) {
  const startDate = `${days}daysAgo`;

  const [response] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [
      { name: 'itemId' },
      { name: 'sessionSource' },
    ],
    metrics: [
      { name: 'itemsPurchased' },
      { name: 'itemRevenue' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionSource',
        stringFilter: { matchType: 'CONTAINS', value: 'trovaprezzi', caseSensitive: false },
      },
    },
    limit: 50000,
  });

  const index = {};
  let totalRevenue = 0;
  let totalPurchases = 0;

  for (const row of (response.rows || [])) {
    const itemId = row.dimensionValues[0].value;
    const purchased = parseInt(row.metricValues[0].value) || 0;
    const revenue = parseFloat(row.metricValues[1].value) || 0;

    totalRevenue += revenue;
    totalPurchases += purchased;

    if (!itemId || itemId === '(not set)' || itemId === 'undefined') continue;

    if (!index[itemId]) {
      index[itemId] = { trovaprezziPurchases: 0, trovaprezziRevenue: 0 };
    }
    index[itemId].trovaprezziPurchases += purchased;
    index[itemId].trovaprezziRevenue += revenue;
  }

  console.log(`[GA4] Query1 TP purchases: ${(response.rows || []).length} rows, ${totalPurchases} purchases, €${totalRevenue.toFixed(2)}`);
  return index;
}

/**
 * Query 2: Landing page → purchased item mapping for assisted sales
 */
async function queryAssistedSales(client, propertyId, entityIdMap, days = 90) {
  const startDate = `${days}daysAgo`;

  const [response] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [
      { name: 'landingPagePlusQueryString' },
      { name: 'itemId' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'itemsPurchased' },
      { name: 'itemRevenue' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionSource',
        stringFilter: { matchType: 'CONTAINS', value: 'trovaprezzi', caseSensitive: false },
      },
    },
    limit: 100000,
  });

  // Build landing product → purchased items map
  const assistMap = {}; // purchasedSku → { assistedSales, assistedRevenue, assistedFrom: [landingSku] }

  for (const row of (response.rows || [])) {
    const landingPage = row.dimensionValues[0].value;
    const purchasedItemId = row.dimensionValues[1].value;
    const purchased = parseInt(row.metricValues[1].value) || 0;
    const revenue = parseFloat(row.metricValues[2].value) || 0;

    if (purchased === 0) continue;
    if (!purchasedItemId || purchasedItemId === '(not set)') continue;

    // Try to extract product identifier from landing URL
    const landingEntityId = extractProductCodeFromUrl(landingPage);
    if (!landingEntityId) continue;

    // Remap both to SKU
    const landingSku = entityIdMap[landingEntityId] || landingEntityId;
    const purchasedSku = entityIdMap[purchasedItemId] || purchasedItemId;

    // If purchased product is DIFFERENT from landing product → assisted sale
    if (purchasedSku !== landingSku) {
      if (!assistMap[purchasedSku]) {
        assistMap[purchasedSku] = { assistedSales: 0, assistedRevenue: 0 };
      }
      assistMap[purchasedSku].assistedSales += purchased;
      assistMap[purchasedSku].assistedRevenue += revenue;
    }
  }

  console.log(`[GA4] Query2 assisted sales: ${Object.keys(assistMap).length} products with assists`);
  return assistMap;
}

/**
 * Query 3: Channel-level KPIs
 */
async function queryChannelKpis(client, propertyId, days = 30) {
  const startDate = `${days}daysAgo`;

  // purchaseRevenue is compatible with session dimensions
  // We subtract shipping later if needed
  const [channelData] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
    metrics: [
      { name: 'purchaseRevenue' },
      { name: 'transactions' },
      { name: 'sessions' },
      { name: 'shippingAmount' },
    ],
  });

  const channels = {};
  for (const row of (channelData.rows || [])) {
    const channel = row.dimensionValues[0].value;
    const grossRevenue = parseFloat(row.metricValues[0].value) || 0;
    const transactions = parseInt(row.metricValues[1].value) || 0;
    const sessions = parseInt(row.metricValues[2].value) || 0;
    const shipping = parseFloat(row.metricValues[3]?.value) || 0;
    const revenue = grossRevenue - shipping; // Net of shipping
    channels[channel] = {
      revenue: Math.max(0, revenue),
      transactions,
      sessions,
      avgBasket: transactions > 0 ? +(revenue / transactions).toFixed(2) : 0,
      convRate: sessions > 0 ? +((transactions / sessions) * 100).toFixed(2) : 0,
    };
  }

  // Add Trovaprezzi-specific data (subtract shipping from purchaseRevenue)
  const [tpData] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [{ name: 'sessionSource' }],
    metrics: [
      { name: 'purchaseRevenue' },
      { name: 'transactions' },
      { name: 'sessions' },
      { name: 'shippingAmount' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionSource',
        stringFilter: { matchType: 'CONTAINS', value: 'trovaprezzi', caseSensitive: false },
      },
    },
  });

  if (tpData.rows?.length) {
    let tpRev = 0, tpTx = 0, tpSess = 0, tpShip = 0;
    for (const row of tpData.rows) {
      tpRev += parseFloat(row.metricValues[0].value) || 0;
      tpTx += parseInt(row.metricValues[1].value) || 0;
      tpSess += parseInt(row.metricValues[2].value) || 0;
      tpShip += parseFloat(row.metricValues[3]?.value) || 0;
    }
    const netTpRev = Math.max(0, tpRev - tpShip);
    channels['Trovaprezzi'] = {
      revenue: netTpRev,
      transactions: tpTx,
      sessions: tpSess,
      avgBasket: tpTx > 0 ? +(netTpRev / tpTx).toFixed(2) : 0,
      convRate: tpSess > 0 ? +((tpTx / tpSess) * 100).toFixed(2) : 0,
    };
  }

  return channels;
}

/**
 * Query 4: Source/Medium breakdown (all sources, last 30 days)
 */
async function querySourceMedium(client, propertyId, days = 30) {
  const startDate = `${days}daysAgo`;

  const [response] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [
      { name: 'sessionSource' },
      { name: 'sessionMedium' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'purchaseRevenue' },
      { name: 'transactions' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 100,
  });

  return (response.rows || []).map(r => ({
    source: r.dimensionValues[0].value,
    medium: r.dimensionValues[1].value,
    sessions: parseInt(r.metricValues[0].value) || 0,
    revenue: parseFloat(r.metricValues[1].value) || 0,
    transactions: parseInt(r.metricValues[2].value) || 0,
  }));
}

/**
 * Query 5: First-touch attribution
 * Users whose FIRST contact was trovaprezzi — total lifetime revenue
 * Difference with sessionSource = cross-session assisted value
 */
async function queryFirstTouchAttribution(client, propertyId, days = 30) {
  const startDate = `${days}daysAgo`;

  // First user source = trovaprezzi (users acquired via TP)
  const [firstTouch] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [{ name: 'firstUserSource' }],
    metrics: [
      { name: 'purchaseRevenue' },
      { name: 'transactions' },
      { name: 'sessions' },
      { name: 'shippingAmount' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'firstUserSource',
        stringFilter: { matchType: 'CONTAINS', value: 'trovaprezzi', caseSensitive: false },
      },
    },
  });

  // Session source = trovaprezzi (direct TP sessions)
  const [sessionTouch] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate: 'today' }],
    dimensions: [{ name: 'sessionSource' }],
    metrics: [
      { name: 'purchaseRevenue' },
      { name: 'transactions' },
      { name: 'sessions' },
      { name: 'shippingAmount' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionSource',
        stringFilter: { matchType: 'CONTAINS', value: 'trovaprezzi', caseSensitive: false },
      },
    },
  });

  let ftRevenue = 0, ftTx = 0, ftSess = 0, ftShip = 0;
  for (const row of (firstTouch.rows || [])) {
    ftRevenue += parseFloat(row.metricValues[0].value) || 0;
    ftTx += parseInt(row.metricValues[1].value) || 0;
    ftSess += parseInt(row.metricValues[2].value) || 0;
    ftShip += parseFloat(row.metricValues[3]?.value) || 0;
  }

  let ssRevenue = 0, ssTx = 0, ssSess = 0, ssShip = 0;
  for (const row of (sessionTouch.rows || [])) {
    ssRevenue += parseFloat(row.metricValues[0].value) || 0;
    ssTx += parseInt(row.metricValues[1].value) || 0;
    ssSess += parseInt(row.metricValues[2].value) || 0;
    ssShip += parseFloat(row.metricValues[3]?.value) || 0;
  }

  const result = {
    firstTouch: {
      revenue: Math.max(0, ftRevenue - ftShip),
      transactions: ftTx,
      sessions: ftSess,
    },
    sessionDirect: {
      revenue: Math.max(0, ssRevenue - ssShip),
      transactions: ssTx,
      sessions: ssSess,
    },
    crossSession: {
      revenue: Math.max(0, (ftRevenue - ftShip) - (ssRevenue - ssShip)),
      transactions: Math.max(0, ftTx - ssTx),
    },
  };

  console.log(`[GA4] First-touch: €${result.firstTouch.revenue.toFixed(2)} (${ftTx}tx) | Session: €${result.sessionDirect.revenue.toFixed(2)} (${ssTx}tx) | Cross-session: €${result.crossSession.revenue.toFixed(2)} (${result.crossSession.transactions}tx)`);
  return result;
}

/**
 * Build full GA4 attribution index for a tenant
 * Combines all queries into a unified per-SKU attribution map
 */
async function buildGA4Index(tenantId) {
  const hasCredentials = await googleApiService.hasGA4Credentials(tenantId);
  if (!hasCredentials) {
    console.log(`[GA4] Tenant ${tenantId.slice(0, 8)}: no GA4 credentials configured`);
    return null;
  }

  console.log(`[GA4] Building attribution index for tenant ${tenantId.slice(0, 8)}...`);
  const startTime = Date.now();

  const client = await googleApiService.getGA4Client(tenantId);
  const propertyId = await googleApiService.getGA4PropertyId(tenantId);

  // Build entity_id → SKU map (from products.magento_entity_id)
  const entityIdMap = await buildEntityIdMap(tenantId);
  console.log(`[GA4] Entity ID map: ${Object.keys(entityIdMap).length} products`);

  // Run all queries in parallel — all 30 days for consistency
  const [tpPurchases, assistedSales, channelKpis, sourceMedium, firstTouchData] = await Promise.all([
    queryTrovaprezziPurchases(client, propertyId, 30),
    queryAssistedSales(client, propertyId, entityIdMap, 30),
    queryChannelKpis(client, propertyId, 30),
    querySourceMedium(client, propertyId, 30),
    queryFirstTouchAttribution(client, propertyId, 30),
  ]);

  // Remap TP purchases from entity_id to SKU
  const productIndex = {};
  let mapped = 0, unmapped = 0;

  for (const [key, data] of Object.entries(tpPurchases)) {
    const sku = entityIdMap[key] || key;
    if (entityIdMap[key]) mapped++;
    else unmapped++;

    if (productIndex[sku]) {
      productIndex[sku].trovaprezziPurchases += data.trovaprezziPurchases;
      productIndex[sku].trovaprezziRevenue += data.trovaprezziRevenue;
    } else {
      productIndex[sku] = {
        trovaprezziPurchases: data.trovaprezziPurchases,
        trovaprezziRevenue: data.trovaprezziRevenue,
        assistedSales: 0,
        assistedRevenue: 0,
      };
    }
  }

  // Merge assisted sales
  for (const [sku, data] of Object.entries(assistedSales)) {
    if (!productIndex[sku]) {
      productIndex[sku] = {
        trovaprezziPurchases: 0,
        trovaprezziRevenue: 0,
        assistedSales: 0,
        assistedRevenue: 0,
      };
    }
    productIndex[sku].assistedSales += data.assistedSales;
    productIndex[sku].assistedRevenue += data.assistedRevenue;
  }

  // Calculate total Trovaprezzi value per product
  for (const data of Object.values(productIndex)) {
    data.totalTrovaprezziValue = data.trovaprezziRevenue + data.assistedRevenue;
  }

  console.log(`[GA4] Key remap: ${mapped} mapped to SKU, ${unmapped} unmapped`);
  console.log(`[GA4] Product index: ${Object.keys(productIndex).length} products with TP attribution`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[GA4] Attribution index built in ${elapsed}s`);

  const result = {
    productIndex,
    channelKpis,
    sourceMedium,
    firstTouchAttribution: firstTouchData,
    builtAt: Date.now(),
  };

  // Cache
  ga4Cache.set(tenantId, result);

  return result;
}

/**
 * Get GA4 attribution data (cached)
 */
async function getGA4Attribution(tenantId) {
  const cached = ga4Cache.get(tenantId);
  if (cached && (Date.now() - cached.builtAt < GA4_CACHE_TTL)) {
    return cached;
  }
  return buildGA4Index(tenantId);
}

/**
 * Persist GA4 attribution to product_health_scores (called during health enrichment)
 */
async function persistGA4Attribution(tenantId) {
  const data = await getGA4Attribution(tenantId);
  if (!data || !data.productIndex) return { updated: 0 };

  // Reset GA4-specific columns to 0 before writing new data
  // This prevents stale values from previous runs with different date ranges
  // NOTE: tp_attributed_orders and tp_attributed_revenue are calculated from Magento
  // orders by computeHealthScores — NEVER reset them here, only GA4-specific fields
  await pool.query(`
    UPDATE product_health_scores SET
      ga4_tp_purchases = 0, ga4_tp_revenue = 0,
      ga4_assisted_sales = 0, ga4_assisted_revenue = 0,
      ga4_total_tp_value = 0, ga4_is_assist_product = false
    WHERE tenant_id = $1
  `, [tenantId]);

  const entries = Object.entries(data.productIndex);
  let updated = 0;
  const BATCH = 50;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const values = [];
    const cases = { purchases: [], revenue: [], assisted: [], assistedRev: [] };

    batch.forEach(([sku, d], idx) => {
      const base = idx * 5;
      values.push(tenantId, sku, d.trovaprezziPurchases, d.trovaprezziRevenue, d.assistedSales, d.assistedRevenue);
      // We'll use a simpler approach: individual updates
    });

    // Update each product with GA4 attribution data
    for (const [sku, d] of batch) {
      await pool.query(`
        UPDATE product_health_scores SET
          tp_attributed_orders = $3,
          tp_attributed_revenue = $4,
          ga4_tp_purchases = $3,
          ga4_tp_revenue = $4,
          ga4_assisted_sales = $5,
          ga4_assisted_revenue = $6,
          ga4_total_tp_value = $7,
          ga4_is_assist_product = ($5 > 0 AND $3 = 0),
          tp_gross_margin = $4 - COALESCE(tp_cogs, 0) - tp_click_cost_30d
        WHERE tenant_id = $1 AND sku = $2
      `, [tenantId, sku, d.trovaprezziPurchases, d.trovaprezziRevenue,
          d.assistedSales, d.assistedRevenue, d.totalTrovaprezziValue]);
      updated++;
    }
  }

  // Also persist channel KPIs and TP-specific data
  if (data.channelKpis?.['Trovaprezzi']) {
    const tp = data.channelKpis['Trovaprezzi'];
    // Store in health_config for quick access
    const configEntries = [
      ['ga4_tp_revenue_30d', tp.revenue.toFixed(2)],
      ['ga4_tp_transactions_30d', String(tp.transactions)],
      ['ga4_tp_sessions_30d', String(tp.sessions)],
      ['ga4_tp_avg_basket', tp.avgBasket.toFixed(2)],
      ['ga4_tp_conv_rate', tp.convRate.toFixed(2)],
      ['ga4_last_update', new Date().toISOString()],
    ];

    // Add first-touch attribution data
    if (data.firstTouchAttribution) {
      const ft = data.firstTouchAttribution;
      configEntries.push(
        ['ga4_ft_revenue_30d', ft.firstTouch.revenue.toFixed(2)],
        ['ga4_ft_transactions_30d', String(ft.firstTouch.transactions)],
        ['ga4_cross_session_revenue_30d', ft.crossSession.revenue.toFixed(2)],
        ['ga4_cross_session_transactions_30d', String(ft.crossSession.transactions)],
      );
    }

    // Count assisted sales from product index
    const totalAssisted = Object.values(data.productIndex || {})
      .reduce((sum, p) => sum + (p.assistedSales || 0), 0);
    const totalAssistedRev = Object.values(data.productIndex || {})
      .reduce((sum, p) => sum + (p.assistedRevenue || 0), 0);
    configEntries.push(
      ['ga4_assisted_sales_90d', String(totalAssisted)],
      ['ga4_assisted_revenue_90d', totalAssistedRev.toFixed(2)],
    );

    for (const [key, value] of configEntries) {
      await pool.query(`
        INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = $3, updated_at = NOW()
      `, [tenantId, key, value]);
    }
  }

  console.log(`[GA4] Persisted attribution for ${updated} products`);
  return { updated, channelKpis: data.channelKpis };
}

module.exports = {
  buildGA4Index,
  getGA4Attribution,
  persistGA4Attribution,
  queryChannelKpis,
  querySourceMedium,
};
