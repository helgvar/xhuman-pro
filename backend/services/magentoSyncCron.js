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
// Allineamento al ciclo TP: TP rilegge il feed ogni 4h dalle 00:00 italia
// (= 22:00 UTC del giorno prima in estate). MagentoSync deve completare
// almeno 1h prima del refresh TP. Schedule UTC: 20:30, 00:30, 04:30, 08:30,
// 12:30, 16:30 → completa entro 21:00, 01:00, 05:00, ecc → 1h margine prima
// che TP rilegga alle 22:00, 02:00, 06:00 UTC (= 00:00, 04:00, 08:00 italia).
// Cfr. project_tp_feed_refresh_cycle.
const RUN_INTERVAL_HOURS = 4;
const RUN_MINUTE = 30;
const RUN_HOURS_UTC = [0, 4, 8, 12, 16, 20];

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
  // Allineamento esplicito UTC (container TZ = UTC): trova il prossimo slot
  // tra RUN_HOURS_UTC al minuto RUN_MINUTE.
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const slotMins = RUN_HOURS_UTC.map(h => h * 60 + RUN_MINUTE);
  // Trova slot strettamente futuro oggi, altrimenti primo slot di domani.
  let nextSlot = slotMins.find(m => m > nowMin);
  let dayOffset = 0;
  if (nextSlot == null) {
    nextSlot = slotMins[0];
    dayOffset = 1;
  }
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset,
    Math.floor(nextSlot / 60), nextSlot % 60, 0, 0
  ));
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
  console.log(`[MagentoSyncCron] Initialized (slot UTC ${RUN_HOURS_UTC.map(h => String(h).padStart(2,'0')+':'+String(RUN_MINUTE).padStart(2,'0')).join(', ')}, allineato al ciclo TP refresh)`);
}

function stopMagentoSyncCron() {
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
  }
}

module.exports = { startMagentoSyncCron, stopMagentoSyncCron, runForAllOperational, listOperationalTenants };
