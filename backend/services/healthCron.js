/**
 * Health Cron - Full enrichment pipeline every 2 hours
 *
 * Sequence:
 * 1. Health scores (product scoring + classification)
 * 2. GA4 attribution (revenue per product from GA4 sessions)
 * 3. Feed engine (3 evaluations → feed actions)
 * 4. Predictions (generate + monitor + calibrate)
 * 5. Reactivations (check quarantine)
 */

const { pool } = require('../db/pool');
const { computeHealthScores } = require('./productHealth');
const { persistGA4Attribution } = require('./ga4Analytics');
const { googleApiService } = require('./googleApi');
const { computeFeedActions, checkReactivations } = require('./feedEngine');
const { generatePredictions, monitorPredictions, calibratePredictions } = require('./feedPrediction');

let cronTimer = null;
const INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

async function runForAllTenants() {
  const { rows: tenants } = await pool.query(
    `SELECT DISTINCT t.id, t.name
     FROM tenants t
     JOIN products p ON p.tenant_id = t.id
     LIMIT 50`
  );

  console.log(`[HealthCron] Running enrichment for ${tenants.length} tenant(s)`);

  const results = [];
  for (const tenant of tenants) {
    const tLabel = tenant.name || tenant.id.slice(0, 8);
    try {
      // Step 1: Health scores
      const result = await computeHealthScores(tenant.id);

      // Step 2: GA4 attribution
      try {
        const hasGA4 = await googleApiService.hasGA4Credentials(tenant.id);
        if (hasGA4) {
          console.log(`[HealthCron] [${tLabel}] GA4 attribution...`);
          const ga4Result = await persistGA4Attribution(tenant.id);
          console.log(`[HealthCron] [${tLabel}] GA4: ${ga4Result.updated} products`);
        }
      } catch (ga4Err) {
        console.error(`[HealthCron] [${tLabel}] GA4 error:`, ga4Err.message);
      }

      // Step 3: Feed Decision Engine
      try {
        console.log(`[HealthCron] [${tLabel}] Feed engine...`);
        const feedResult = await computeFeedActions(tenant.id);
        console.log(`[HealthCron] [${tLabel}] Feed: ${JSON.stringify(feedResult.stats)}`);
      } catch (feedErr) {
        console.error(`[HealthCron] [${tLabel}] Feed engine error:`, feedErr.message);
      }

      // Step 4: Predictions
      try {
        await generatePredictions(tenant.id);
        await monitorPredictions(tenant.id);
        await calibratePredictions(tenant.id);
      } catch (predErr) {
        console.error(`[HealthCron] [${tLabel}] Prediction error:`, predErr.message);
      }

      // Step 5: Reactivations
      try {
        const reactivResult = await checkReactivations(tenant.id);
        if (reactivResult.reactivated > 0) {
          console.log(`[HealthCron] [${tLabel}] Reactivated ${reactivResult.reactivated} products`);
        }
      } catch (reactErr) {
        console.error(`[HealthCron] [${tLabel}] Reactivation error:`, reactErr.message);
      }

      results.push({ tenantId: tenant.id, ...result });
    } catch (err) {
      console.error(`[HealthCron] [${tLabel}] Error:`, err.message);
      results.push({ tenantId: tenant.id, error: err.message });
    }
  }

  return results;
}

function startHealthCron() {
  setTimeout(async () => {
    console.log('[HealthCron] Initial enrichment run...');
    try {
      await runForAllTenants();
    } catch (err) {
      console.error('[HealthCron] Initial run error:', err.message);
    }

    cronTimer = setInterval(async () => {
      console.log('[HealthCron] Scheduled enrichment run...');
      try {
        await runForAllTenants();
      } catch (err) {
        console.error('[HealthCron] Scheduled run error:', err.message);
      }
    }, INTERVAL_MS);

    console.log(`[HealthCron] Scheduled every ${INTERVAL_MS / 3600000}h`);
  }, 30000);

  console.log('[HealthCron] Full pipeline cron initialized (every 2h, first run in 30s)');
}

function stopHealthCron() {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}

module.exports = { startHealthCron, stopHealthCron, runForAllTenants };
