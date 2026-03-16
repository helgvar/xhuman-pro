/**
 * Farmabooster API Client
 *
 * Safeguards (replicated from DASHBOARD FB):
 * - Token caching + promise deduplication (no concurrent logins)
 * - Rate limiting: max 30 req/min per tenant
 * - Sequential page fetching with 500ms delay between pages
 * - Batch page fetching (max 3 concurrent, 1s delay between batches)
 * - Retry with exponential backoff on errors
 * - Global overlap prevention per tenant
 */

const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');
const {
  retryWithBackoff,
  checkRateLimit,
  deduplicatedCall,
  getCachedToken,
  setCachedToken,
  clearCachedToken,
  throttledBatchFetch,
} = require('./requestQueue');

const DELAY_BETWEEN_PAGES_MS = 500;   // 500ms between sequential pages
const BATCH_SIZE = 3;                  // Max 3 concurrent requests per batch
const BATCH_DELAY_MS = 1000;           // 1s delay between batches (~1.2 req/sec)

/**
 * Get Farmabooster config for a tenant (decrypted)
 */
async function getFarmaboosterConfig(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_key, config_value FROM tenant_configs
     WHERE tenant_id = $1 AND config_key IN ('farmabooster_api_url', 'farmabooster_api_email', 'farmabooster_api_password')`,
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

  if (!config.farmabooster_api_url || !config.farmabooster_api_email || !config.farmabooster_api_password) {
    throw new Error('Farmabooster configuration missing (url, email or password)');
  }

  return config;
}

/**
 * Login to Farmabooster API with token caching + deduplication
 */
async function getToken(tenantId, config) {
  // Check cache first
  const cached = getCachedToken(`fb:${tenantId}`);
  if (cached) return cached;

  // Deduplicate concurrent login calls for same tenant
  return deduplicatedCall(`fb:${tenantId}`, async () => {
    const url = `${config.farmabooster_api_url}/login`;

    const res = await retryWithBackoff(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: config.farmabooster_api_email,
          pwd: config.farmabooster_api_password,
        }),
      });

      if (!response.ok) {
        const err = new Error(`Farmabooster login failed: ${response.status}`);
        err.statusCode = response.status;
        throw err;
      }

      return response.json();
    }, { maxRetries: 2, baseDelay: 3000 });

    if (!res.ok || !res.data?.token) {
      throw new Error('Farmabooster login failed: invalid response');
    }

    // Cache token for 50 minutes
    setCachedToken(`fb:${tenantId}`, res.data.token, 50 * 60 * 1000);
    console.log(`[FarmaboosterClient] Token obtained for tenant ${tenantId}`);
    return res.data.token;
  });
}

/**
 * Make a single API call to Farmabooster with rate limiting + retry
 */
async function apiCall(tenantId, config, endpoint, params = {}) {
  await checkRateLimit(tenantId, 'farmabooster');

  const token = await getToken(tenantId, config);

  return retryWithBackoff(async () => {
    const url = `${config.farmabooster_api_url}/${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...params }),
    });

    if (!response.ok) {
      // If 401/403, clear cached token and retry
      if (response.status === 401 || response.status === 403) {
        clearCachedToken(`fb:${tenantId}`);
      }
      const err = new Error(`Farmabooster API ${endpoint} error: ${response.status}`);
      err.statusCode = response.status;
      throw err;
    }

    const data = await response.json();
    // Login returns { ok, data: { token } }, other endpoints return { page, total_records, data }
    // Only fail if explicitly ok === false (not if ok is absent)
    if (data.ok === false) {
      throw new Error(`Farmabooster API ${endpoint}: response not ok`);
    }

    return data;
  }, { maxRetries: 3, baseDelay: 2000, maxDelay: 10000 });
}

/**
 * Fetch all pages from a Farmabooster endpoint.
 * Uses sequential fetching with delay to avoid overwhelming the server.
 *
 * @param {string} tenantId
 * @param {object} config
 * @param {string} endpoint - API endpoint (e.g., 'products', 'clickstats')
 * @param {number} maxPages - Safety limit
 * @param {Function} onProgress - (fetched, total) callback
 * @returns {Array} All data items
 */
async function fetchAllPages(tenantId, config, endpoint, maxPages = 60, onProgress = null) {
  // Fetch first page to get total
  const firstPage = await apiCall(tenantId, config, endpoint, { page: 1 });
  const totalPages = Math.min(parseInt(firstPage.total_pages || 1), maxPages);
  const totalRecords = parseInt(firstPage.total_records || 0);
  const allData = [...(firstPage.data || [])];

  console.log(`[FarmaboosterClient] ${endpoint}: page 1/${totalPages} (${totalRecords} total records)`);

  if (onProgress) onProgress(1, totalPages);

  if (totalPages <= 1) return allData;

  // Fetch remaining pages in small batches with delay
  // Batch 3 pages at a time, 1s delay between batches (~1.2 req/sec)
  const fetchFns = [];
  for (let p = 2; p <= totalPages; p++) {
    const page = p;
    fetchFns.push(() => apiCall(tenantId, config, endpoint, { page }));
  }

  const results = await throttledBatchFetch(fetchFns, BATCH_SIZE, BATCH_DELAY_MS, (done, total) => {
    if (done % 5 === 0 || done === total) {
      console.log(`[FarmaboosterClient] ${endpoint}: ${done + 1}/${totalPages} pages fetched`);
    }
    if (onProgress) onProgress(done + 1, totalPages);
  });

  for (const result of results) {
    allData.push(...(result.data || []));
  }

  console.log(`[FarmaboosterClient] ${endpoint}: complete - ${allData.length} records`);
  return allData;
}

module.exports = {
  getFarmaboosterConfig,
  getToken,
  apiCall,
  fetchAllPages,
};
