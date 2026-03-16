const { pool } = require('../db/pool');
const { importProducts } = require('./farmaboosterProducts');
const { isJobRunning } = require('./requestQueue');

const SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const STAGGER_DELAY_MS = 30 * 1000;           // 30s delay between tenants

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

      if (isJobRunning(tenant.id, 'products_import')) {
        console.log(`[ProductSync] Tenant "${tenant.name}" has import running, skipping`);
        continue;
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO import_jobs (tenant_id, job_type, status, metadata)
           VALUES ($1, 'products_sync', 'pending', $2) RETURNING id`,
          [tenant.id, JSON.stringify({ trigger: 'cron' })]
        );

        await importProducts(tenant.id, rows[0].id);
        console.log(`[ProductSync] Tenant "${tenant.name}" sync complete`);
      } catch (err) {
        console.error(`[ProductSync] Tenant "${tenant.name}" sync failed:`, err.message);
      }

      if (i < tenants.length - 1 && STAGGER_DELAY_MS > 0) {
        console.log(`[ProductSync] Waiting ${STAGGER_DELAY_MS / 1000}s before next tenant...`);
        await new Promise(r => setTimeout(r, STAGGER_DELAY_MS));
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
  // Offset by 1 hour from orders to avoid simultaneous API calls
  const INITIAL_DELAY_MS = 60 * 60 * 1000; // 1 hour after startup
  console.log(`[ProductSync] Cron started - every ${SYNC_INTERVAL_MS / 60000}min (first run in ${INITIAL_DELAY_MS / 60000}min), ${STAGGER_DELAY_MS / 1000}s stagger`);
  setTimeout(() => {
    syncAllProducts();
    setInterval(syncAllProducts, SYNC_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}

module.exports = { startProductSync, syncAllProducts };
