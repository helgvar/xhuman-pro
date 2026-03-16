/**
 * Google Merchant Center Service
 *
 * Imports from Merchant Center:
 * 1. Product catalog (price, availability, categories, custom labels)
 * 2. Product statuses (approval, issues)
 * 3. Price Competitiveness (benchmark prices from Google)
 * 4. Price Insights (suggested prices with predicted impact)
 * 5. Product View (click potential, ranking)
 * 6. Performance reports (clicks, impressions, CTR per product)
 * 7. Daily performance trends
 *
 * All data per-tenant (each tenant has its own Merchant Center account).
 */

const { google } = require('googleapis');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const BATCH_SIZE = 200;

/**
 * Get authenticated Content API client for a tenant
 */
async function getMerchantClient(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM tenant_configs
     WHERE tenant_id = $1 AND config_key IN ('google_service_account_json', 'google_merchant_id')`,
    [tenantId]
  );

  const config = {};
  for (const r of rows) {
    try { config[r.config_key] = decrypt(r.config_value); }
    catch { config[r.config_key] = r.config_value; }
  }

  if (!config.google_service_account_json || !config.google_merchant_id) {
    throw new Error('Google Merchant Center not configured (missing service account or merchant ID)');
  }

  const credentials = JSON.parse(config.google_service_account_json);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/content'],
  });

  const content = google.content({ version: 'v2.1', auth });
  return { content, merchantId: config.google_merchant_id };
}

/**
 * Fetch all products from Merchant Center catalog
 */
async function fetchProducts(content, merchantId) {
  const products = [];
  let pageToken = undefined;

  do {
    const opts = { merchantId, maxResults: 250 };
    if (pageToken) opts.pageToken = pageToken;
    const res = await content.products.list(opts);
    products.push(...(res.data.resources || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return products;
}

/**
 * Fetch product statuses (approval, issues)
 */
async function fetchStatuses(content, merchantId) {
  const statuses = [];
  let pageToken = undefined;

  do {
    const opts = { merchantId, maxResults: 250 };
    if (pageToken) opts.pageToken = pageToken;
    const res = await content.productstatuses.list(opts);
    statuses.push(...(res.data.resources || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return statuses;
}

/**
 * Fetch report data using Reports API (paginated)
 */
async function fetchReport(content, merchantId, query) {
  const results = [];
  let pageToken = undefined;

  do {
    const body = { query };
    if (pageToken) body.pageToken = pageToken;
    const res = await content.reports.search({ merchantId, requestBody: body });
    results.push(...(res.data.results || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return results;
}

/**
 * Parse micros to decimal (e.g. 6590000 -> 6.59)
 */
function micros(val) {
  return val ? parseFloat(val) / 1000000 : 0;
}

/**
 * Main import: fetch ALL data from Merchant Center and persist
 */
async function importMerchantCenter(tenantId, jobId = null) {
  console.log(`[MerchantCenter] Starting import for tenant ${tenantId.slice(0, 8)}`);

  const { content, merchantId } = await getMerchantClient(tenantId);

  // Log run start
  const { rows: [run] } = await pool.query(
    `INSERT INTO merchant_center_runs (tenant_id, run_type, status, started_at)
     VALUES ($1, 'full', 'running', NOW()) RETURNING id`,
    [tenantId]
  );

  try {
    // ─── 1. Products catalog ─────────────────────────────────
    console.log('[MerchantCenter] Fetching products catalog...');
    const products = await fetchProducts(content, merchantId);
    console.log(`[MerchantCenter] ${products.length} products from catalog`);

    // Build product index: offerId -> data
    const productIndex = {};
    for (const p of products) {
      const offerId = p.offerId;
      if (!offerId) continue;
      productIndex[offerId] = {
        title: p.title || '',
        brand: p.brand || '',
        gtin: p.gtin || '',
        availability: p.availability || '',
        condition: p.condition || '',
        channel: p.channel || 'online',
        price: p.price ? parseFloat(p.price.value) : 0,
        salePrice: p.salePrice ? parseFloat(p.salePrice.value) : 0,
        currency: p.price?.currency || 'EUR',
        googleProductCategory: p.googleProductCategory || '',
        customLabel0: p.customLabel0 || '',
        customLabel1: p.customLabel1 || '',
        customLabel2: p.customLabel2 || '',
        customLabel3: p.customLabel3 || '',
        customLabel4: p.customLabel4 || '',
        excludedDestinations: p.excludedDestinations || [],
        productTypes: p.productTypes || [],
      };
    }

    // ─── 2. Product statuses ─────────────────────────────────
    console.log('[MerchantCenter] Fetching product statuses...');
    const statuses = await fetchStatuses(content, merchantId);
    console.log(`[MerchantCenter] ${statuses.length} product statuses`);

    for (const s of statuses) {
      const offerId = s.productId?.replace('online:it:IT:', '') || '';
      if (!offerId || !productIndex[offerId]) continue;

      const destStatuses = s.destinationStatuses || [];
      const shoppingStatus = destStatuses.find(d => d.destination === 'Shopping');
      productIndex[offerId].approvalStatus = shoppingStatus?.status || '';
      productIndex[offerId].issuesCount = (s.itemLevelIssues || []).length;
      productIndex[offerId].lastUpdate = s.lastUpdateDate || null;
      productIndex[offerId].expirationDate = s.googleExpirationDate || null;
      productIndex[offerId].creationDate = s.creationDate || null;
    }

    // ─── 3. Price Competitiveness ─────────────────────────────
    console.log('[MerchantCenter] Fetching price competitiveness...');
    let benchmarkCount = 0;
    try {
      const benchmarks = await fetchReport(content, merchantId,
        `SELECT product_view.id, product_view.offer_id, product_view.price_micros,
                price_competitiveness.country_code, price_competitiveness.benchmark_price_micros, price_competitiveness.benchmark_price_currency_code
         FROM PriceCompetitivenessProductView`
      );
      console.log(`[MerchantCenter] ${benchmarks.length} price benchmarks`);

      for (const b of benchmarks) {
        const offerId = b.productView?.offerId;
        if (!offerId || !productIndex[offerId]) continue;
        productIndex[offerId].benchmarkPrice = micros(b.priceCompetitiveness?.benchmarkPriceMicros);
        benchmarkCount++;
      }
    } catch (err) {
      console.warn('[MerchantCenter] Price competitiveness error:', err.message?.slice(0, 200));
    }

    // ─── 4. Price Insights ───────────────────────────────────
    console.log('[MerchantCenter] Fetching price insights...');
    let insightsCount = 0;
    try {
      const insights = await fetchReport(content, merchantId,
        `SELECT product_view.id, product_view.offer_id, product_view.price_micros,
                price_insights.suggested_price_micros, price_insights.suggested_price_currency_code,
                price_insights.predicted_impressions_change_fraction, price_insights.predicted_clicks_change_fraction
         FROM PriceInsightsProductView`
      );
      console.log(`[MerchantCenter] ${insights.length} price insights`);

      for (const ins of insights) {
        const offerId = ins.productView?.offerId;
        if (!offerId || !productIndex[offerId]) continue;
        productIndex[offerId].suggestedPrice = micros(ins.priceInsights?.suggestedPriceMicros);
        productIndex[offerId].predictedImpressionsChange = ins.priceInsights?.predictedImpressionsChangeFraction || 0;
        productIndex[offerId].predictedClicksChange = ins.priceInsights?.predictedClicksChangeFraction || 0;
        insightsCount++;
      }
    } catch (err) {
      console.warn('[MerchantCenter] Price insights error:', err.message?.slice(0, 200));
    }

    // ─── 5. Product View (click potential) ───────────────────
    console.log('[MerchantCenter] Fetching product view (click potential)...');
    try {
      const productViews = await fetchReport(content, merchantId,
        `SELECT product_view.id, product_view.offer_id, product_view.click_potential,
                product_view.click_potential_rank, product_view.creation_time, product_view.expiration_date
         FROM ProductView`
      );
      console.log(`[MerchantCenter] ${productViews.length} product views`);

      for (const pv of productViews) {
        const offerId = pv.productView?.offerId;
        if (!offerId || !productIndex[offerId]) continue;
        productIndex[offerId].clickPotential = pv.productView.clickPotential || '';
        productIndex[offerId].clickPotentialRank = parseInt(pv.productView.clickPotentialRank) || null;
        if (pv.productView.creationTime) productIndex[offerId].creationDate = pv.productView.creationTime;
        if (pv.productView.expirationDate) {
          const ed = pv.productView.expirationDate;
          productIndex[offerId].expirationDate = `${ed.year}-${String(ed.month).padStart(2, '0')}-${String(ed.day).padStart(2, '0')}`;
        }
      }
    } catch (err) {
      console.warn('[MerchantCenter] Product view error:', err.message?.slice(0, 200));
    }

    // ─── 6. Performance (last 14 days aggregated by product) ──
    console.log('[MerchantCenter] Fetching performance data (14d)...');
    let performanceCount = 0;
    const today = new Date();
    const d14ago = new Date(today);
    d14ago.setDate(d14ago.getDate() - 14);
    const dateFrom = d14ago.toISOString().slice(0, 10);
    const dateTo = new Date(today.setDate(today.getDate() - 1)).toISOString().slice(0, 10);

    try {
      const perf = await fetchReport(content, merchantId,
        `SELECT segments.offer_id, metrics.clicks, metrics.impressions, metrics.ctr,
                metrics.conversions, metrics.conversion_value_micros
         FROM MerchantPerformanceView
         WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'`
      );
      console.log(`[MerchantCenter] ${perf.length} performance rows`);

      for (const p of perf) {
        const offerId = p.segments?.offerId;
        if (!offerId || !productIndex[offerId]) continue;
        // Aggregate (could have multiple rows per product if daily)
        if (!productIndex[offerId].clicks14d) productIndex[offerId].clicks14d = 0;
        if (!productIndex[offerId].impressions14d) productIndex[offerId].impressions14d = 0;
        productIndex[offerId].clicks14d += parseInt(p.metrics?.clicks || 0);
        productIndex[offerId].impressions14d += parseInt(p.metrics?.impressions || 0);
        productIndex[offerId].conversions14d = (productIndex[offerId].conversions14d || 0) + parseFloat(p.metrics?.conversions || 0);
        productIndex[offerId].conversionValue14d = (productIndex[offerId].conversionValue14d || 0) + micros(p.metrics?.conversionValueMicros);
        performanceCount++;
      }

      // Calculate CTR
      for (const data of Object.values(productIndex)) {
        if (data.impressions14d > 0) {
          data.ctr14d = data.clicks14d / data.impressions14d;
        }
      }
    } catch (err) {
      console.warn('[MerchantCenter] Performance error:', err.message?.slice(0, 200));
    }

    // ─── 7. Daily trend (last 30 days by product) ────────────
    console.log('[MerchantCenter] Fetching daily performance trend...');
    const d30ago = new Date();
    d30ago.setDate(d30ago.getDate() - 30);
    const dateFrom30 = d30ago.toISOString().slice(0, 10);

    let dailyRows = [];
    try {
      dailyRows = await fetchReport(content, merchantId,
        `SELECT segments.date, segments.offer_id, metrics.clicks, metrics.impressions, metrics.ctr,
                metrics.conversions, metrics.conversion_value_micros
         FROM MerchantPerformanceView
         WHERE segments.date BETWEEN '${dateFrom30}' AND '${dateTo}'`
      );
      console.log(`[MerchantCenter] ${dailyRows.length} daily performance rows`);
    } catch (err) {
      console.warn('[MerchantCenter] Daily trend error:', err.message?.slice(0, 200));
    }

    // ─── PERSIST TO DB ───────────────────────────────────────

    // Persist product data
    console.log('[MerchantCenter] Persisting product data...');
    const entries = Object.entries(productIndex);
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      let idx = 1;

      for (const [offerId, d] of batch) {
        const placeholders = [];
        for (let p = 0; p < 33; p++) placeholders.push(`$${idx + p}`);
        placeholders.push('NOW()');
        values.push(`(${placeholders.join(',')})`);
        params.push(
          tenantId, offerId, d.title || '', d.brand || '', d.gtin || '',
          d.availability || '', d.condition || '', d.channel || 'ONLINE',
          d.price || 0, d.salePrice || 0, d.currency || 'EUR',
          d.googleProductCategory || '',
          d.customLabel0 || '', d.customLabel1 || '', d.customLabel2 || '', d.customLabel3 || '', d.customLabel4 || '',
          d.approvalStatus || '', d.issuesCount || 0,
          d.benchmarkPrice || null, d.suggestedPrice || null,
          d.predictedImpressionsChange || null, d.predictedClicksChange || null,
          d.clickPotential || '', d.clickPotentialRank || null,
          d.creationDate || null, d.expirationDate || null, d.lastUpdate || null,
          d.clicks14d || 0, d.impressions14d || 0, d.ctr14d || 0,
          d.conversions14d || 0, d.conversionValue14d || 0
        );
        idx += 33;
      }

      await pool.query(
        `INSERT INTO merchant_center_products (
          tenant_id, offer_id, mc_title, mc_brand, mc_gtin,
          mc_availability, mc_condition, mc_channel,
          mc_price, mc_sale_price, mc_currency,
          google_product_category,
          custom_label0, custom_label1, custom_label2, custom_label3, custom_label4,
          approval_status, item_issues_count,
          benchmark_price, suggested_price,
          predicted_impressions_change, predicted_clicks_change,
          click_potential, click_potential_rank,
          mc_creation_date, mc_expiration_date, mc_last_update,
          clicks_14d, impressions_14d, ctr_14d,
          conversions_14d, conversion_value_14d, updated_at
        ) VALUES ${values.join(',')}
        ON CONFLICT (tenant_id, offer_id) DO UPDATE SET
          mc_title = EXCLUDED.mc_title, mc_brand = EXCLUDED.mc_brand, mc_gtin = EXCLUDED.mc_gtin,
          mc_availability = EXCLUDED.mc_availability, mc_condition = EXCLUDED.mc_condition, mc_channel = EXCLUDED.mc_channel,
          mc_price = EXCLUDED.mc_price, mc_sale_price = EXCLUDED.mc_sale_price, mc_currency = EXCLUDED.mc_currency,
          google_product_category = EXCLUDED.google_product_category,
          custom_label0 = EXCLUDED.custom_label0, custom_label1 = EXCLUDED.custom_label1,
          custom_label2 = EXCLUDED.custom_label2, custom_label3 = EXCLUDED.custom_label3, custom_label4 = EXCLUDED.custom_label4,
          approval_status = EXCLUDED.approval_status, item_issues_count = EXCLUDED.item_issues_count,
          benchmark_price = EXCLUDED.benchmark_price, suggested_price = EXCLUDED.suggested_price,
          predicted_impressions_change = EXCLUDED.predicted_impressions_change, predicted_clicks_change = EXCLUDED.predicted_clicks_change,
          click_potential = EXCLUDED.click_potential, click_potential_rank = EXCLUDED.click_potential_rank,
          mc_creation_date = EXCLUDED.mc_creation_date, mc_expiration_date = EXCLUDED.mc_expiration_date, mc_last_update = EXCLUDED.mc_last_update,
          clicks_14d = EXCLUDED.clicks_14d, impressions_14d = EXCLUDED.impressions_14d, ctr_14d = EXCLUDED.ctr_14d,
          conversions_14d = EXCLUDED.conversions_14d, conversion_value_14d = EXCLUDED.conversion_value_14d,
          updated_at = NOW()`,
        params
      );
    }

    // Persist daily trend
    if (dailyRows.length > 0) {
      console.log('[MerchantCenter] Persisting daily trend...');
      for (let i = 0; i < dailyRows.length; i += BATCH_SIZE) {
        const batch = dailyRows.slice(i, i + BATCH_SIZE);
        const values = [];
        const params = [];
        let idx = 1;

        for (const row of batch) {
          const d = row.segments?.date;
          if (!d || !row.segments?.offerId) continue;
          const dateStr = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
          values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7})`);
          params.push(
            tenantId, dateStr, row.segments.offerId,
            parseInt(row.metrics?.clicks || 0),
            parseInt(row.metrics?.impressions || 0),
            parseFloat(row.metrics?.ctr || 0),
            parseFloat(row.metrics?.conversions || 0),
            micros(row.metrics?.conversionValueMicros)
          );
          idx += 8;
        }

        if (values.length > 0) {
          await pool.query(
            `INSERT INTO merchant_center_daily (tenant_id, report_date, offer_id, clicks, impressions, ctr, conversions, conversion_value)
             VALUES ${values.join(',')}
             ON CONFLICT (tenant_id, report_date, offer_id) DO UPDATE SET
               clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr,
               conversions = EXCLUDED.conversions, conversion_value = EXCLUDED.conversion_value`,
            params
          );
        }
      }
    }

    // Update run
    await pool.query(
      `UPDATE merchant_center_runs SET status = 'completed', completed_at = NOW(),
       products_count = $1, benchmark_count = $2, insights_count = $3, performance_count = $4
       WHERE id = $5`,
      [products.length, benchmarkCount, insightsCount, performanceCount, run.id]
    );

    console.log(`[MerchantCenter] Import complete: ${products.length} products, ${benchmarkCount} benchmarks, ${insightsCount} insights, ${performanceCount} performance rows, ${dailyRows.length} daily rows`);
    return { products: products.length, benchmarks: benchmarkCount, insights: insightsCount, performance: performanceCount, dailyRows: dailyRows.length };

  } catch (err) {
    console.error('[MerchantCenter] Import error:', err.message);
    await pool.query(
      `UPDATE merchant_center_runs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [err.message.slice(0, 500), run.id]
    ).catch(() => {});
    throw err;
  }
}

module.exports = { importMerchantCenter, getMerchantClient };
