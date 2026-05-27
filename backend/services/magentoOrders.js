const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');
const {
  retryWithBackoff,
  checkRateLimit,
  withJobLock,
} = require('./requestQueue');
const { magentoQueue } = require('./apiQueue');

// Stati che consideriamo "ordini reali" (= fatturato confermato o in corso).
// Includiamo stati custom italiani per ordini ritirati di persona dal cliente:
// NON sono spediti ma sono comunque vendite reali.
// `Ritirato` (R maiuscola) è la variante più diffusa su Procaccini (650 ord/90gg).
const VALID_STATUSES = [
  'complete', 'processing', 'pending',
  'Ritirato', 'ritiro_farmacia', 'ritiro_sede_tmp',
];

// Stati che NON pagano spese di spedizione (cliente ritira in negozio).
// Usato dai calcoli MOL/margine per non addebitare il costo del corriere.
const PICKUP_STATUSES = new Set(['Ritirato', 'ritiro_farmacia', 'ritiro_sede_tmp']);
const PAGE_SIZE = 100;
const DELAY_BETWEEN_PAGES_MS = 500;  // 500ms between each page request
const DELAY_BETWEEN_SAVES_MS = 50;   // 50ms between DB saves (prevent DB overload)

/**
 * Get decrypted Magento config for a tenant
 */
async function getMagentoConfig(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM tenant_configs
     WHERE tenant_id = $1 AND config_key IN ('magento_base_url', 'magento_api_token', 'magento_store_code')`,
    [tenantId]
  );

  const config = {};
  for (const row of rows) {
    try {
      config[row.config_key] = decrypt(row.config_value);
    } catch {
      config[row.config_key] = row.config_value;
    }
  }

  if (!config.magento_base_url || !config.magento_api_token) {
    throw new Error('Magento configuration missing (base_url or api_token)');
  }

  // Normalizzazione URL: aggiungi 'https://' se manca, rimuovi trailing slash.
  let url = String(config.magento_base_url).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/\/+$/, '');
  config.magento_base_url = url;

  return config;
}

/**
 * Fetch orders from Magento 2 REST API (single page)
 * Wrapped with retry + rate limiting
 */
async function fetchMagentoOrders(tenantId, config, dateFrom, dateTo, page = 1) {
  // Check rate limit before calling
  await checkRateLimit(tenantId, 'magento');

  return retryWithBackoff(async () => {
    const baseUrl = config.magento_base_url.replace(/\/$/, '');
    const storeCode = config.magento_store_code || 'default';

    const params = new URLSearchParams();

    // Try with status OR filter first (works on most Magento installs)
    // If it fails (400), fallback to date-only filter
    let statusGroupOffset = 0;
    if (!config._skipStatusFilter) {
      VALID_STATUSES.forEach((status, i) => {
        params.append(`searchCriteria[filter_groups][0][filters][${i}][field]`, 'status');
        params.append(`searchCriteria[filter_groups][0][filters][${i}][value]`, status);
        params.append(`searchCriteria[filter_groups][0][filters][${i}][condition_type]`, 'eq');
      });
      statusGroupOffset = 1;
    }

    // Filter by date from
    params.append(`searchCriteria[filter_groups][${statusGroupOffset}][filters][0][field]`, 'created_at');
    params.append(`searchCriteria[filter_groups][${statusGroupOffset}][filters][0][value]`, dateFrom);
    params.append(`searchCriteria[filter_groups][${statusGroupOffset}][filters][0][condition_type]`, 'gteq');

    // Filter by date to
    params.append(`searchCriteria[filter_groups][${statusGroupOffset + 1}][filters][0][field]`, 'created_at');
    params.append(`searchCriteria[filter_groups][${statusGroupOffset + 1}][filters][0][value]`, dateTo);
    params.append(`searchCriteria[filter_groups][${statusGroupOffset + 1}][filters][0][condition_type]`, 'lteq');

    // Pagination
    params.append('searchCriteria[pageSize]', PAGE_SIZE);
    params.append('searchCriteria[currentPage]', page);

    // Sort by date desc
    params.append('searchCriteria[sortOrders][0][field]', 'created_at');
    params.append('searchCriteria[sortOrders][0][direction]', 'DESC');

    const restPath = storeCode && storeCode !== 'none' ? `/rest/${storeCode}/V1/orders` : '/rest/V1/orders';
    const url = `${baseUrl}${restPath}?${params.toString()}`;

    return magentoQueue.enqueue(async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.magento_api_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const body = await response.text();
        const err = new Error(`Magento API error ${response.status}: ${body.substring(0, 200)}`);
        err.statusCode = response.status;
        throw err;
      }

      return response.json();
    }, `magento:orders:${tenantId}:${page}`);
  }, {
    maxRetries: 3,
    baseDelay: 2000,
    maxDelay: 15000,
  });
}

/**
 * Extract province from shipping address
 */
function extractProvince(order) {
  const addr = order.extension_attributes?.shipping_assignments?.[0]?.shipping?.address
    || order.billing_address;
  if (!addr) return null;
  return addr.region_code || addr.region || null;
}

/**
 * Calculate products-only total (subtotal - discount, no shipping)
 */
function calcProductsTotal(order) {
  const subtotal = parseFloat(order.subtotal || 0);
  const discount = Math.abs(parseFloat(order.discount_amount || 0));
  return Math.round((subtotal - discount) * 100) / 100;
}

/**
 * Save a single order + items to DB (upsert)
 */
async function saveOrder(tenantId, order) {
  const orderNumber = order.increment_id;
  const province = extractProvince(order);
  const productsTotal = calcProductsTotal(order);

  const grandTotal = parseFloat(order.grand_total || 0);

  const subtotalInclTax = parseFloat(order.subtotal_incl_tax || 0);
  const shippingAmount = parseFloat(order.shipping_amount || 0);
  const shippingInclTax = parseFloat(order.shipping_incl_tax || 0);
  const taxAmount = parseFloat(order.tax_amount || 0);

  const { rows } = await pool.query(
    `INSERT INTO orders (tenant_id, order_number, order_status, customer_firstname, customer_lastname,
       customer_email, customer_province, subtotal, subtotal_incl_tax, discount_amount, grand_total_products,
       grand_total, shipping_amount, shipping_incl_tax, tax_amount, order_date, magento_order_id, raw_data, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
     ON CONFLICT (tenant_id, order_number) DO UPDATE SET
       order_status = EXCLUDED.order_status,
       customer_province = EXCLUDED.customer_province,
       subtotal = EXCLUDED.subtotal,
       subtotal_incl_tax = EXCLUDED.subtotal_incl_tax,
       discount_amount = EXCLUDED.discount_amount,
       grand_total_products = EXCLUDED.grand_total_products,
       grand_total = EXCLUDED.grand_total,
       shipping_amount = EXCLUDED.shipping_amount,
       shipping_incl_tax = EXCLUDED.shipping_incl_tax,
       tax_amount = EXCLUDED.tax_amount,
       raw_data = EXCLUDED.raw_data,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new`,
    [
      tenantId,
      orderNumber,
      order.status,
      order.customer_firstname || '',
      order.customer_lastname || '',
      order.customer_email || '',
      province,
      parseFloat(order.subtotal || 0),
      subtotalInclTax,
      Math.abs(parseFloat(order.discount_amount || 0)),
      productsTotal,
      grandTotal,
      shippingAmount,
      shippingInclTax,
      taxAmount,
      order.created_at,
      order.entity_id,
      JSON.stringify({
        entity_id: order.entity_id,
        grand_total: order.grand_total,
        shipping_amount: order.shipping_amount,
        shipping_incl_tax: order.shipping_incl_tax,
        tax_amount: order.tax_amount,
        payment_method: order.payment?.method,
      }),
    ]
  );

  const orderId = rows[0].id;
  const isNew = rows[0].is_new;

  // Replace order items
  await pool.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);

  const items = (order.items || []).filter(item =>
    item.product_type !== 'configurable' && parseFloat(item.qty_ordered) > 0
  );

  for (const item of items) {
    await pool.query(
      `INSERT INTO order_items (order_id, tenant_id, sku, product_name, qty_ordered, price, row_total, row_total_incl_tax)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        orderId,
        tenantId,
        item.sku,
        item.name,
        parseFloat(item.qty_ordered),
        parseFloat(item.price || 0),
        parseFloat(item.row_total || 0),
        parseFloat(item.row_total_incl_tax || item.row_total || 0),
      ]
    );
  }

  return isNew;
}

/**
 * Main import function with safeguards:
 * - Job overlap prevention (withJobLock)
 * - Rate limiting per tenant (checkRateLimit)
 * - Retry with exponential backoff on each API call
 * - Delay between pages to avoid overwhelming Magento
 * - Delay between DB saves to avoid DB overload
 */
async function importOrders(tenantId, daysBack = 365, jobId = null) {
  return withJobLock(tenantId, 'orders_import', async () => {
    const config = await getMagentoConfig(tenantId);

    const dateTo = new Date().toISOString().split('T')[0] + ' 23:59:59';
    const dateFrom = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0] + ' 00:00:00';

    console.log(`[Orders] Importing for tenant ${tenantId}: ${dateFrom} → ${dateTo}`);

    if (jobId) {
      await pool.query(
        "UPDATE import_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
        [jobId]
      );
    }

    let page = 1;
    let totalProcessed = 0;
    let totalImported = 0;
    let totalUpdated = 0;
    let hasMore = true;

    try {
      // Test if status filter works — some Magento installs don't support OR filters
      try {
        const testUrl = `${config.magento_base_url.replace(/\/$/, '')}/rest/${config.magento_store_code || 'default'}/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=status&searchCriteria[filter_groups][0][filters][0][value]=complete&searchCriteria[filter_groups][0][filters][0][condition_type]=eq&searchCriteria[filter_groups][0][filters][1][field]=status&searchCriteria[filter_groups][0][filters][1][value]=processing&searchCriteria[filter_groups][0][filters][1][condition_type]=eq&searchCriteria[pageSize]=1`;
        const testResp = await fetch(testUrl, { headers: { 'Authorization': `Bearer ${config.magento_api_token}` } });
        if (!testResp.ok) {
          console.log(`[Orders] Status OR filter not supported (${testResp.status}), falling back to date-only`);
          config._skipStatusFilter = true;
        }
      } catch (testErr) {
        console.log(`[Orders] Status filter test failed, using date-only`);
        config._skipStatusFilter = true;
      }

      while (hasMore) {
        // Fetch page with rate limiting + retry
        const result = await fetchMagentoOrders(tenantId, config, dateFrom, dateTo, page);
        const orders = result.items || [];
        const totalCount = result.total_count || 0;

        // Save orders sequentially with small delay to avoid DB pressure
        for (const order of orders) {
          totalProcessed++;
          const isNew = await saveOrder(tenantId, order);
          if (isNew) totalImported++;
          else totalUpdated++;

          // Small delay every 10 orders to reduce DB pressure
          if (totalProcessed % 10 === 0 && DELAY_BETWEEN_SAVES_MS > 0) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_SAVES_MS));
          }
        }

        console.log(`[Orders] Page ${page}: ${orders.length} orders (${totalProcessed}/${totalCount})`);

        hasMore = totalProcessed < totalCount && orders.length === PAGE_SIZE;
        page++;

        // Update job progress
        if (jobId) {
          await pool.query(
            `UPDATE import_jobs SET records_processed = $1, records_imported = $2, records_updated = $3 WHERE id = $4`,
            [totalProcessed, totalImported, totalUpdated, jobId]
          );
        }

        // Delay between pages to avoid overwhelming Magento API
        if (hasMore && DELAY_BETWEEN_PAGES_MS > 0) {
          await new Promise(r => setTimeout(r, DELAY_BETWEEN_PAGES_MS));
        }
      }

      if (jobId) {
        await pool.query(
          `UPDATE import_jobs SET status = 'completed', completed_at = NOW(),
           records_processed = $1, records_imported = $2, records_updated = $3 WHERE id = $4`,
          [totalProcessed, totalImported, totalUpdated, jobId]
        );
      }

      console.log(`[Orders] Import complete: ${totalImported} new, ${totalUpdated} updated, ${totalProcessed} total`);
      return { totalProcessed, totalImported, totalUpdated };

    } catch (err) {
      console.error(`[Orders] Import error:`, err.message);
      if (jobId) {
        await pool.query(
          `UPDATE import_jobs SET status = 'failed', completed_at = NOW(), error_message = $1 WHERE id = $2`,
          [err.message, jobId]
        );
      }
      throw err;
    }
  });
}

module.exports = { importOrders, getMagentoConfig, VALID_STATUSES, PICKUP_STATUSES };
