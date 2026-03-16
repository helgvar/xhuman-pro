/**
 * Request Queue & Throttling Service
 *
 * Replicates safeguards from DASHBOARD FB:
 * - Throttled batch fetch (configurable batch size + delay)
 * - Token deduplication (prevents concurrent login/auth calls)
 * - Retry with exponential backoff
 * - Job overlap prevention
 * - Rate limiting per tenant
 */

// ── Token Deduplication ──────────────────────────────────────────────
// Prevents multiple concurrent token fetch calls per tenant
const tokenCache = new Map();     // tenantId → { token, expires }
const tokenPromises = new Map();  // tenantId → Promise (dedup)

function getCachedToken(tenantId) {
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.token;
  return null;
}

function setCachedToken(tenantId, token, ttlMs = 50 * 60 * 1000) {
  tokenCache.set(tenantId, { token, expires: Date.now() + ttlMs });
}

function clearCachedToken(tenantId) {
  tokenCache.delete(tenantId);
}

async function deduplicatedCall(key, fetchFn) {
  if (tokenPromises.has(key)) {
    return tokenPromises.get(key);
  }
  const promise = fetchFn();
  tokenPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    tokenPromises.delete(key);
  }
}

// ── Throttled Batch Fetch ────────────────────────────────────────────
/**
 * Runs API calls in small batches with delay between them.
 * Prevents overwhelming external APIs with too many concurrent requests.
 *
 * @param {Array<Function>} fetchFns - Array of () => Promise functions
 * @param {number} batchSize - Max concurrent calls per batch (default 5)
 * @param {number} delayMs - Delay between batches in ms (default 300)
 * @param {Function} onProgress - Optional progress callback (processed, total)
 * @returns {Array} - Results in order
 */
async function throttledBatchFetch(fetchFns, batchSize = 5, delayMs = 300, onProgress = null) {
  const results = [];
  const total = fetchFns.length;

  for (let i = 0; i < total; i += batchSize) {
    const batch = fetchFns.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn => fn()));
    results.push(...batchResults);

    if (onProgress) {
      onProgress(Math.min(i + batchSize, total), total);
    }

    // Delay between batches (skip after last batch)
    if (i + batchSize < total && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}

// ── Retry with Exponential Backoff ───────────────────────────────────
/**
 * Retries a function with exponential backoff.
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} opts - Options
 * @param {number} opts.maxRetries - Max retries (default 3)
 * @param {number} opts.baseDelay - Base delay in ms (default 1000)
 * @param {number} opts.maxDelay - Max delay in ms (default 10000)
 * @param {Function} opts.shouldRetry - (error) => boolean (default: retry on 429, 5xx)
 * @returns {*} - Result of fn
 */
async function retryWithBackoff(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    shouldRetry = defaultShouldRetry,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !shouldRetry(err)) {
        throw err;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * (0.5 + Math.random() * 0.5);
      console.log(`[RequestQueue] Retry ${attempt + 1}/${maxRetries} after ${Math.round(jitter)}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, jitter));
    }
  }

  throw lastError;
}

function defaultShouldRetry(err) {
  if (err.statusCode === 429) return true;              // Rate limited
  if (err.statusCode >= 500) return true;               // Server error
  if (err.code === 'ECONNRESET') return true;           // Connection reset
  if (err.code === 'ETIMEDOUT') return true;            // Timeout
  if (err.message?.includes('ECONNREFUSED')) return true;
  return false;
}

// ── Job Overlap Prevention ───────────────────────────────────────────
const runningJobs = new Map(); // 'tenantId:jobType' → true

function isJobRunning(tenantId, jobType) {
  return runningJobs.has(`${tenantId}:${jobType}`);
}

function markJobRunning(tenantId, jobType) {
  runningJobs.set(`${tenantId}:${jobType}`, true);
}

function markJobFinished(tenantId, jobType) {
  runningJobs.delete(`${tenantId}:${jobType}`);
}

/**
 * Execute a job with overlap prevention.
 * If the same job type is already running for this tenant, skip.
 */
async function withJobLock(tenantId, jobType, fn) {
  const key = `${tenantId}:${jobType}`;

  if (runningJobs.has(key)) {
    console.log(`[RequestQueue] Job ${jobType} already running for tenant ${tenantId}, skipping`);
    return null;
  }

  runningJobs.set(key, true);
  try {
    return await fn();
  } finally {
    runningJobs.delete(key);
  }
}

// ── Rate Limiter (per tenant, per API) ───────────────────────────────
const rateLimiters = new Map(); // 'tenantId:api' → { count, windowStart }

const RATE_LIMITS = {
  magento: { maxRequests: 100, windowMs: 60 * 1000 },      // 100 req/min
  farmabooster: { maxRequests: 30, windowMs: 60 * 1000 },   // 30 req/min
  default: { maxRequests: 60, windowMs: 60 * 1000 },        // 60 req/min
};

async function checkRateLimit(tenantId, apiName = 'default') {
  const key = `${tenantId}:${apiName}`;
  const limits = RATE_LIMITS[apiName] || RATE_LIMITS.default;
  const now = Date.now();

  let entry = rateLimiters.get(key);
  if (!entry || now - entry.windowStart > limits.windowMs) {
    entry = { count: 0, windowStart: now };
    rateLimiters.set(key, entry);
  }

  if (entry.count >= limits.maxRequests) {
    const waitMs = limits.windowMs - (now - entry.windowStart);
    console.log(`[RequestQueue] Rate limit hit for ${apiName} (tenant ${tenantId}), waiting ${waitMs}ms`);
    await new Promise(r => setTimeout(r, waitMs));
    entry.count = 0;
    entry.windowStart = Date.now();
  }

  entry.count++;
}

// ── Cleanup ──────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (entry.expires < now) tokenCache.delete(key);
  }
  for (const [key, entry] of rateLimiters) {
    if (now - entry.windowStart > 120000) rateLimiters.delete(key);
  }
}, 60000);

module.exports = {
  // Token dedup
  getCachedToken,
  setCachedToken,
  clearCachedToken,
  deduplicatedCall,
  // Batch throttling
  throttledBatchFetch,
  // Retry
  retryWithBackoff,
  // Job overlap
  isJobRunning,
  markJobRunning,
  markJobFinished,
  withJobLock,
  // Rate limiting
  checkRateLimit,
};
