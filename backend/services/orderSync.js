const { pool } = require('../db/pool');
const { importOrders } = require('./magentoOrders');
const { isJobRunning } = require('./requestQueue');

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SYNC_DAYS_BACK = 3;
const STAGGER_DELAY_MS = 30 * 1000;      // 30s delay between tenants (avoid parallel API calls)

let syncRunning = false;

/**
 * Sync orders for all active tenants that have Magento configured.
 * Tenants are processed sequentially with staggered delays to prevent
 * overlapping API calls and to avoid overwhelming external services.
 */
async function syncAllTenants() {
  // Global overlap prevention
  if (syncRunning) {
    console.log('[OrderSync] Previous sync still running, skipping');
    return;
  }

  syncRunning = true;

  try {
    const { rows: tenants } = await pool.query(
      `SELECT DISTINCT t.id, t.name FROM tenants t
       JOIN tenant_configs tc ON tc.tenant_id = t.id
       WHERE t.status = 'active'
         AND tc.config_key = 'magento_api_token'
         AND tc.config_value IS NOT NULL
         AND tc.config_value != ''`
    );

    console.log(`[OrderSync] Starting sync for ${tenants.length} tenant(s)`);

    for (let i = 0; i < tenants.length; i++) {
      const tenant = tenants[i];

      // Skip if an import is already running for this tenant
      if (isJobRunning(tenant.id, 'orders_import')) {
        console.log(`[OrderSync] Tenant "${tenant.name}" has import running, skipping`);
        continue;
      }

      try {
        // Create job record
        const { rows } = await pool.query(
          `INSERT INTO import_jobs (tenant_id, job_type, status, metadata)
           VALUES ($1, 'orders_sync', 'pending', $2) RETURNING id`,
          [tenant.id, JSON.stringify({ daysBack: SYNC_DAYS_BACK, trigger: 'cron' })]
        );

        await importOrders(tenant.id, SYNC_DAYS_BACK, rows[0].id);
        console.log(`[OrderSync] Tenant "${tenant.name}" sync complete`);
      } catch (err) {
        console.error(`[OrderSync] Tenant "${tenant.name}" sync failed:`, err.message);
      }

      // Stagger: wait between tenants to avoid overlapping API calls
      if (i < tenants.length - 1 && STAGGER_DELAY_MS > 0) {
        console.log(`[OrderSync] Waiting ${STAGGER_DELAY_MS / 1000}s before next tenant...`);
        await new Promise(r => setTimeout(r, STAGGER_DELAY_MS));
      }
    }

    console.log('[OrderSync] All tenants synced');
  } catch (err) {
    console.error('[OrderSync] Global sync error:', err.message);
  } finally {
    syncRunning = false;
  }
}

function startOrderSync() {
  console.log(`[OrderSync] Cron started - every ${SYNC_INTERVAL_MS / 60000}min, ${SYNC_DAYS_BACK} days back, ${STAGGER_DELAY_MS / 1000}s stagger`);
  setInterval(syncAllTenants, SYNC_INTERVAL_MS);
}

module.exports = { startOrderSync, syncAllTenants };
