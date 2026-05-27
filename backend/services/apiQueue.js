/**
 * Global API Queue Manager with Circuit Breaker
 *
 * Central gateway for ALL external API calls.
 * Protects Farmabooster/Magento from overload:
 *
 * - GLOBAL max 3 concurrent requests to Farmabooster (across ALL tenants)
 * - Tenant serialization: one tenant at a time for bulk operations
 * - Circuit breaker: 3 failures → OPEN, 2min cooldown
 * - Request deduplication (same tenant+endpoint → share result)
 * - 200ms delay between each request
 * - No retry on timeout (avoids piling up)
 */

class ApiQueue {
  constructor({ maxConcurrent = 3, delayMs = 200, name = 'API', cbThreshold = 3, cbCooldownMs = 120000 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.delayMs = delayMs;
    this.name = name;
    this.running = 0;
    this.queue = [];

    // Circuit breaker
    this._cbState = 'closed'; // closed | open | half-open
    this._cbFailures = 0;
    this._cbThreshold = cbThreshold;
    this._cbCooldownMs = cbCooldownMs;
    this._cbOpenedAt = null;

    // Deduplication
    this._inflight = new Map(); // key → Promise

    // Stats
    this.stats = { completed: 0, failed: 0, rejected: 0, deduplicated: 0, totalMs: 0 };
  }

  _cbAllows() {
    if (this._cbState === 'closed') return true;
    if (this._cbState === 'open') {
      if (Date.now() - this._cbOpenedAt >= this._cbCooldownMs) {
        this._cbState = 'half-open';
        console.log(`[${this.name}] Circuit breaker → HALF-OPEN (testing)`);
        return true;
      }
      return false;
    }
    return this.running === 0; // half-open: 1 test
  }

  _cbRecordSuccess() {
    if (this._cbState === 'half-open') {
      this._cbState = 'closed';
      this._cbFailures = 0;
      console.log(`[${this.name}] Circuit breaker → CLOSED (recovered)`);
    } else {
      this._cbFailures = 0;
    }
    this.stats.completed++;
  }

  _cbRecordFailure() {
    this._cbFailures++;
    this.stats.failed++;
    if (this._cbFailures >= this._cbThreshold) {
      this._cbState = 'open';
      this._cbOpenedAt = Date.now();
      console.log(`[${this.name}] Circuit breaker → OPEN (${this._cbFailures} failures, cooldown ${this._cbCooldownMs / 1000}s)`);
      // Reject all queued
      const queued = this.queue.splice(0);
      for (const item of queued) {
        item.reject(new Error(`Circuit breaker OPEN for ${this.name}`));
        this.stats.rejected++;
      }
    }
  }

  isOpen() {
    return this._cbState === 'open';
  }

  async enqueue(fn, dedupKey = null, timeoutMs = 60000, label = '') {
    if (!this._cbAllows()) {
      const waitSec = Math.ceil((this._cbCooldownMs - (Date.now() - this._cbOpenedAt)) / 1000);
      this.stats.rejected++;
      throw new Error(`[${this.name}] Circuit breaker OPEN, retry in ${waitSec}s`);
    }

    if (dedupKey && this._inflight.has(dedupKey)) {
      this.stats.deduplicated++;
      return this._inflight.get(dedupKey);
    }

    const promise = new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, timeoutMs });
      this._process();
    });

    if (dedupKey) {
      this._inflight.set(dedupKey, promise);
      promise.finally(() => this._inflight.delete(dedupKey));
    }

    return promise;
  }

  async _process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;

    const item = this.queue.shift();
    this.running++;
    const start = Date.now();

    try {
      if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));

      // Adaptive timeout: use 3x avg response time if available, min 60s, max item.timeoutMs
      // Min alzato da 30s a 60s perche' Farmabooster API alcuni giorni e' lenta (avg 2-3s).
      const avgMs = this.stats.completed > 10 ? this.stats.totalMs / this.stats.completed : 0;
      const adaptiveTimeout = avgMs > 0 ? Math.min(Math.max(avgMs * 3, 60000), item.timeoutMs) : item.timeoutMs;

      // Pattern definitivo per evitare unhandled rejection:
      // 1) Avvia item.fn() E aggancia subito .catch(() => {}) PRIMA della race
      //    (la promise originale resta rejected, ma node vede l'handler).
      // 2) Idem sulla timer promise.
      // 3) Race fra le due. clearTimeout in finally.
      let timeoutId = null;
      const fnPromise = item.fn();
      fnPromise.catch(() => { /* silenzia se rejecta dopo timeout */ });

      const timerPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timeout after ${Math.round(adaptiveTimeout)}ms (avg: ${Math.round(avgMs)}ms)`)),
          adaptiveTimeout
        );
      });
      timerPromise.catch(() => { /* silenzia se rejecta dopo che race ha vinto */ });

      let result;
      try {
        result = await Promise.race([fnPromise, timerPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      this._cbRecordSuccess();
      this.stats.totalMs += Date.now() - start;
      item.resolve(result);
    } catch (err) {
      this._cbRecordFailure();
      this.stats.totalMs += Date.now() - start;
      item.reject(err);
    } finally {
      this.running--;
      this._process();
    }
  }

  getStatus() {
    return {
      name: this.name,
      state: this._cbState,
      running: this.running,
      queued: this.queue.length,
      failures: this._cbFailures,
      avgMs: this.stats.completed > 0 ? Math.round(this.stats.totalMs / this.stats.completed) : 0,
      stats: { ...this.stats },
    };
  }
}

// ─── GLOBAL INSTANCES ──────────────────────────────────

// Farmabooster: max 2 concurrent, 500ms delay — CONSERVATIVE
// With 20 tenants we must be very careful not to overload FB server
const farmaboosterQueue = new ApiQueue({
  maxConcurrent: 2,
  delayMs: 500,
  name: 'Farmabooster',
  cbThreshold: 3,
  cbCooldownMs: 3 * 60 * 1000, // 3 min cooldown
});

// Magento: max 3 concurrent, 300ms delay (each tenant has its own Magento)
const magentoQueue = new ApiQueue({
  maxConcurrent: 3,
  delayMs: 300,
  name: 'Magento',
  cbThreshold: 5,
  cbCooldownMs: 60 * 1000,
});

// ─── TENANT SERIALIZER ─────────────────────────────────
// Ensures only ONE tenant does bulk operations at a time

let _currentBulkTenant = null;
const _bulkQueue = []; // { tenantId, fn, resolve, reject }

const MAX_TENANT_QUEUE = 10; // Max tenants waiting in bulk queue
const INTER_TENANT_PAUSE_MS = 60000; // 60s pause between tenants

async function withTenantLock(tenantId, fn) {
  // Reject if queue is too long (prevents unbounded growth)
  if (_bulkQueue.length >= MAX_TENANT_QUEUE) {
    throw new Error(`[TenantQueue] Queue full (${_bulkQueue.length}/${MAX_TENANT_QUEUE}). Try again later.`);
  }
  // Skip if this tenant is already in queue
  if (_currentBulkTenant === tenantId || _bulkQueue.some(q => q.tenantId === tenantId)) {
    throw new Error(`[TenantQueue] Tenant ${tenantId.slice(0,8)} already in queue, skipping duplicate`);
  }
  return new Promise((resolve, reject) => {
    _bulkQueue.push({ tenantId, fn, resolve, reject });
    _processBulkQueue();
  });
}

async function _processBulkQueue() {
  if (_currentBulkTenant || _bulkQueue.length === 0) return;

  const item = _bulkQueue.shift();
  _currentBulkTenant = item.tenantId;
  console.log(`[TenantQueue] Starting tenant ${item.tenantId.slice(0,8)} (${_bulkQueue.length} waiting)`);

  try {
    // Check circuit breaker before starting bulk
    if (farmaboosterQueue.isOpen()) {
      throw new Error('Farmabooster circuit breaker OPEN, skipping bulk operation');
    }
    const result = await item.fn();
    item.resolve(result);
  } catch (err) {
    item.reject(err);
  } finally {
    _currentBulkTenant = null;
    // 60s pause between tenants — gives FB server breathing room
    if (_bulkQueue.length > 0) {
      console.log(`[TenantQueue] Pausing ${INTER_TENANT_PAUSE_MS/1000}s before next tenant (${_bulkQueue.length} in queue)`);
      setTimeout(_processBulkQueue, INTER_TENANT_PAUSE_MS);
    }
  }
}

// ─── THROTTLED BATCH FETCH ─────────────────────────────

async function throttledBatchFetch(fetchFns, batchSize = 3, delayMs = 500) {
  const results = [];
  for (let i = 0; i < fetchFns.length; i += batchSize) {
    // Check circuit breaker between batches
    if (farmaboosterQueue.isOpen()) {
      console.log(`[ThrottledBatch] Circuit breaker OPEN, aborting remaining ${fetchFns.length - i} fetches`);
      break;
    }
    const batch = fetchFns.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    for (const r of batchResults) {
      results.push(r.status === 'fulfilled' ? r.value : null);
    }
    if (i + batchSize < fetchFns.length && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ─── STATUS ENDPOINT ───────────────────────────────────

function getQueueStatus() {
  return {
    farmabooster: farmaboosterQueue.getStatus(),
    magento: magentoQueue.getStatus(),
    tenantQueue: {
      currentTenant: _currentBulkTenant,
      waiting: _bulkQueue.length,
    },
  };
}

module.exports = {
  ApiQueue,
  farmaboosterQueue,
  magentoQueue,
  withTenantLock,
  throttledBatchFetch,
  getQueueStatus,
};
