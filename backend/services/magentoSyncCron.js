/**
 * Magento Sync Cron — push civettaai/special_price su tenant operational ogni 2h.
 *
 * Gira allo :30 ogni 2h (00:30, 02:30, ...): sfasato dai tick orari per non
 * collidere con healthCron (ogni 1h al minuto :00). Processa i tenant in
 * sequenza per non saturare i Magento simultaneamente.
 *
 * Tenant osservati (xhumanpro_magento_mode!='operational') vengono saltati.
 * Il magentoSync.execute() per quelli ritorna early.
 */

const { pool } = require('../db/pool');
const magentoSync = require('./magentoSync');
const rootLogger = require('./logger');
const logger = rootLogger.with({ source: 'magentoSyncCron' });

let cronTimer = null;
const RUN_INTERVAL_HOURS = 2;
const RUN_MINUTE = 30;

async function listOperationalTenants() {
  const { rows } = await pool.query(`
    SELECT t.id, t.name
    FROM tenants t
    JOIN tenant_configs tc ON tc.tenant_id = t.id
    WHERE tc.config_key = 'xhumanpro_magento_mode'
      AND tc.config_value = 'operational'
    ORDER BY t.name
  `);
  return rows;
}

async function runForAllOperational() {
  const tenants = await listOperationalTenants();
  console.log(`[MagentoSyncCron] Run start: ${tenants.length} operational tenants`);

  const results = [];
  for (const t of tenants) {
    const t0 = Date.now();
    try {
      const r = await magentoSync.execute(t.id, { confirm: true });
      const dt = Math.round((Date.now() - t0) / 1000);
      const ok1 = r.phase1_civetta?.success || 0;
      const fail1 = r.phase1_civetta?.failed || 0;
      const ok2 = r.phase2_prices?.success || 0;
      const fail2 = r.phase2_prices?.failed || 0;
      console.log(`[MagentoSyncCron] ${t.name}: ${dt}s, civetta ${ok1}/${ok1 + fail1}, prices ${ok2}/${ok2 + fail2}`);
      logger.info(`${t.name} done in ${dt}s`, {
        tenantId: t.id,
        civettaSuccess: ok1, civettaFailed: fail1,
        priceSuccess: ok2, priceFailed: fail2,
      });
      results.push({ tenant: t.name, ok: true, dt, civetta: { ok: ok1, fail: fail1 }, prices: { ok: ok2, fail: fail2 } });
    } catch (e) {
      const dt = Math.round((Date.now() - t0) / 1000);
      console.error(`[MagentoSyncCron] ${t.name} FAILED after ${dt}s: ${e.message}`);
      logger.error(`${t.name} FAILED: ${e.message}`, { tenantId: t.id }, e);
      results.push({ tenant: t.name, ok: false, dt, error: e.message });
    }
  }
  console.log(`[MagentoSyncCron] Run complete`);
  return results;
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(RUN_MINUTE, 0, 0);
  // Allinea ad ora pari (00, 02, 04, ...)
  let h = next.getHours();
  if (h % RUN_INTERVAL_HOURS !== 0) {
    h = h + (RUN_INTERVAL_HOURS - (h % RUN_INTERVAL_HOURS));
    next.setHours(h);
  }
  if (next <= now) {
    next.setHours(next.getHours() + RUN_INTERVAL_HOURS);
  }
  return next - now;
}

function scheduleNext() {
  const ms = msUntilNextRun();
  console.log(`[MagentoSyncCron] Next run in ${Math.round(ms / 60000)} minutes`);
  cronTimer = setTimeout(async () => {
    try {
      await runForAllOperational();
    } catch (e) {
      console.error('[MagentoSyncCron] Fatal:', e.message);
      logger.error(`Fatal: ${e.message}`, null, e);
    }
    scheduleNext();
  }, ms);
}

function startMagentoSyncCron() {
  scheduleNext();
  console.log(`[MagentoSyncCron] Initialized (every ${RUN_INTERVAL_HOURS}h at :${String(RUN_MINUTE).padStart(2, '0')}, sequential per tenant)`);
}

function stopMagentoSyncCron() {
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
  }
}

module.exports = { startMagentoSyncCron, stopMagentoSyncCron, runForAllOperational, listOperationalTenants };
