const { pool } = require('../db/pool');
const { importProducts } = require('./farmaboosterProducts');
const { isJobRunning } = require('./requestQueue');
const { withTenantLock, farmaboosterQueue } = require('./apiQueue');

const SYNC_INTERVAL_MS = 60 * 60 * 1000;      // 1 hour (era 6h; prezzi e stock_source cambiano intra-giorno,
                                              // cfr. feedback_pricing_freshness_critical)
const STAGGER_DELAY_MS = 60 * 1000;           // 60s delay between tenants (protegge FB server)

let syncRunning = false;

/**
 * Sync products for all active tenants with Farmabooster configured.
 * Staggered to avoid overlapping API calls.
 */
async function syncAllProducts() {
  if (syncRunning) {
    console.log('[ProductSync] Previous sync still running, skipping');
    return;
  }

  syncRunning = true;

  try {
    const { rows: tenants } = await pool.query(
      `SELECT DISTINCT t.id, t.name FROM tenants t
       JOIN tenant_configs tc ON tc.tenant_id = t.id
       WHERE t.status = 'active'
         AND tc.config_key = 'farmabooster_api_url'
         AND tc.config_value IS NOT NULL
         AND tc.config_value != ''`
    );

    console.log(`[ProductSync] Starting sync for ${tenants.length} tenant(s)`);

    for (let i = 0; i < tenants.length; i++) {
      const tenant = tenants[i];

      // Skip if circuit breaker is open
      if (farmaboosterQueue.isOpen()) {
        console.log(`[ProductSync] Circuit breaker OPEN, skipping remaining tenants`);
        break;
      }

      if (isJobRunning(tenant.id, 'products_import')) {
        console.log(`[ProductSync] Tenant "${tenant.name}" has import running, skipping`);
        continue;
      }

      try {
        // Tenant serialization: one at a time via global lock
        await withTenantLock(tenant.id, async () => {
          const { rows } = await pool.query(
            `INSERT INTO import_jobs (tenant_id, job_type, status, metadata)
             VALUES ($1, 'products_sync', 'pending', $2) RETURNING id`,
            [tenant.id, JSON.stringify({ trigger: 'cron' })]
          );

          await importProducts(tenant.id, rows[0].id);
          console.log(`[ProductSync] Tenant "${tenant.name}" sync complete`);
        });
      } catch (err) {
        console.error(`[ProductSync] Tenant "${tenant.name}" sync failed:`, err.message);
      }
    }

    console.log('[ProductSync] All tenants synced');
  } catch (err) {
    console.error('[ProductSync] Global sync error:', err.message);
  } finally {
    syncRunning = false;
  }
}

function startProductSync() {
  // First run in 5 min (offset da OrderSync che parte a 30s), poi ogni SYNC_INTERVAL_MS
  const INITIAL_DELAY_MS = 5 * 60 * 1000;
  console.log(`[ProductSync] Cron started - every ${SYNC_INTERVAL_MS / 60000}min (first run in ${INITIAL_DELAY_MS / 60000}min), ${STAGGER_DELAY_MS / 1000}s stagger`);
  setTimeout(() => {
    syncAllProducts().catch(e => console.error('[ProductSync] First-run error:', e.message));
    setInterval(syncAllProducts, SYNC_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}

module.exports = { startProductSync, syncAllProducts };
