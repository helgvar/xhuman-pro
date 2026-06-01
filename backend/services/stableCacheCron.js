/**
 * Stable Cache Cron — rigenera /feed/civetta e /feed/prices cache per tutti
 * i tenant attivi ogni 30 min, INDIPENDENTEMENTE da healthCron.
 *
 * Bug pratico risolto: stable_cache era l'ultimo step di healthCron. Se uno
 * step precedente (mc_sync, civetta_sync, health_scores) andava in timeout
 * o crashava, lo step stable_cache veniva saltato per quel tenant. Risultato:
 * Farmabooster pulla /feed/prices e riceve un payload vecchio (es. 0 SKU)
 * mentre feed_actions ha decine di PRICE_CUT freschi nel DB.
 *
 * Soluzione: loop autonomo, sequenziale per non saturare DB, log compatto.
 */

const { pool } = require('../db/pool');
const { recalculateStableCache } = require('../routes/externalApi');
const rootLogger = require('./logger');
const logger = rootLogger.with({ source: 'stableCacheCron' });

const CHECK_INTERVAL_MS = 30 * 60 * 1000;  // 30 min
let cronTimer = null;

async function runForAll() {
  const t0 = Date.now();
  try {
    const { rows: tenants } = await pool.query(
      `SELECT id, name FROM tenants WHERE status='active' ORDER BY name`
    );
    const results = [];
    for (const t of tenants) {
      const t1 = Date.now();
      try {
        const r = await recalculateStableCache(t.id);
        results.push({
          tenant: t.name,
          ok: true,
          civetta: r.feedCodes?.length || 0,
          remove: r.removeCodes?.length || 0,
          price_cuts: r.priceCuts?.length || 0,
          ms: Date.now() - t1,
        });
      } catch (e) {
        results.push({ tenant: t.name, ok: false, error: e.message?.slice(0,200), ms: Date.now() - t1 });
        logger.error(`${t.name} failed: ${e.message}`, { tenantId: t.id }, e);
      }
    }
    const summary = results.map(r =>
      r.ok ? `${r.tenant}=${r.price_cuts}pc/${r.civetta}feed` : `${r.tenant}=FAIL`
    ).join(' | ');
    console.log(`[StableCacheCron] Done in ${Math.round((Date.now()-t0)/1000)}s: ${summary}`);
  } catch (e) {
    console.error('[StableCacheCron] Fatal:', e.message);
    logger.error(`Fatal: ${e.message}`, null, e);
  }
}

function startStableCacheCron() {
  console.log(`[StableCacheCron] Started (first run in 60s, then every ${CHECK_INTERVAL_MS/60000}min)`);
  setTimeout(async () => {
    await runForAll();
    cronTimer = setInterval(runForAll, CHECK_INTERVAL_MS);
  }, 60 * 1000);
}

function stopStableCacheCron() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
}

module.exports = { startStableCacheCron, stopStableCacheCron, runForAll };
