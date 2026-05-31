/**
 * Health Cron - Full enrichment pipeline every HOUR
 *
 * ALL data sources synced every cycle to keep everything aligned:
 * 0. Zombie clicks download (today's TP clicks)
 * 1. Scraper import (global competitor data)
 * 2. Sync civetta from Magento (per tenant)
 * 3. Health scores (product scoring + classification)
 * 4. GA4 attribution (revenue per product from GA4 sessions)
 * 5. Feed engine (decisions + quarantine + price cuts)
 * 6. Predictions (generate + monitor + calibrate)
 * 7. Reactivations (check quarantine)
 * 8. Observation windows (detect recidivism)
 * 9. Stable cache (for Farmabooster External API)
 */

const { pool } = require('../db/pool');
const { importScraperData } = require('./driveScraper');
const { syncCivettaFromMagento } = require('./farmaboosterProducts');
const { computeHealthScores } = require('./productHealth');
const { persistGA4Attribution } = require('./ga4Analytics');
const { googleApiService } = require('./googleApi');
const { computeFeedActions, checkReactivations, checkObservationWindows } = require('./feedEngine');
const { runDailyFeedEngine } = require('./feedDailyEngine');
const { generatePredictions, monitorPredictions, calibratePredictions } = require('./feedPrediction');
const { recalculateStableCache } = require('../routes/externalApi');
const zombieService = require('./zombieService');
const { importMerchantCenter } = require('./merchantCenter');
const { runDailyExplainerAllTenants } = require('./aiDailyExplainer');
const log = require('./logger');

let cronTimer = null;
let _cronRunning = false; // Prevent overlapping cron runs
const INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour
// Lo stato "ultimo sync MC" viene letto direttamente da merchant_center_runs:
// la Map in-memory si resettava ad ogni restart container facendo perdere il
// tracking, e nella finestra ridotta 04-06 i tenant a fine lista non venivano
// mai processati (es. Procaccini/MPF/SubitoFarma con 0 runs storici).
let _lastAIDailyRun = null; // Track daily AI Explainer run (09:00 window)

// Step wrapper: esegue un await con timeout. Se scade, logga fatal e ritorna { timedOut:true }.
// Cosi nessun singolo step puo' bloccare la pipeline indefinitamente.
async function withStepTimeout(stepName, tenantId, tenantName, fn, timeoutMs) {
  const start = Date.now();
  log.info(`Step START: ${stepName}`, { source: 'healthCron', tenantId, tenantName });
  let timeoutId;
  const timerP = new Promise((_, rej) => {
    timeoutId = setTimeout(
      () => rej(new Error(`Step "${stepName}" timeout after ${Math.round(timeoutMs/1000)}s`)),
      timeoutMs
    );
  });
  timerP.catch(() => {});
  const taskP = Promise.resolve().then(() => fn());
  taskP.catch(() => {});
  try {
    const result = await Promise.race([taskP, timerP]);
    log.info(`Step OK: ${stepName} (${Date.now() - start}ms)`, { source: 'healthCron', tenantId, tenantName });
    return { ok: true, result };
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err.message && err.message.includes('timeout after')) {
      log.fatal(`Step TIMEOUT: ${stepName} on ${tenantName} after ${elapsed}ms`, {
        source: 'healthCron', tenantId, tenantName, step: stepName, elapsedMs: elapsed,
      });
      return { ok: false, timedOut: true, error: err };
    }
    log.error(`Step FAIL: ${stepName} on ${tenantName}`, { source: 'healthCron', tenantId, tenantName, step: stepName, elapsedMs: elapsed }, err);
    return { ok: false, error: err };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function runForAllTenants() {
  if (_cronRunning) {
    console.log('[HealthCron] Previous run still in progress, skipping');
    return [];
  }
  _cronRunning = true;
  try {
    return await _runForAllTenantsInner();
  } finally {
    _cronRunning = false;
  }
}

async function _runForAllTenantsInner() {
  const { rows: tenants } = await pool.query(
    `SELECT DISTINCT t.id, t.name
     FROM tenants t
     JOIN products p ON p.tenant_id = t.id
     LIMIT 50`
  );

  console.log(`[HealthCron] Running enrichment for ${tenants.length} tenant(s)`);

  // Step 0: Download today's zombie clicks for all tenants (TP click data)
  for (const tenant of tenants) {
    const tLabel = tenant.name || tenant.id.slice(0, 8);
    try {
      const isConfigured = await zombieService.isConfigured(tenant.id);
      if (!isConfigured) continue;

      // Download yesterday's clicks (most recent complete day)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
      const fetchDate = yesterday.toISOString().slice(0, 10);

      // Check if already downloaded
      const { rows: existing } = await pool.query(
        `SELECT id FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date = $2 LIMIT 1`,
        [tenant.id, fetchDate]
      );
      if (existing.length > 0) {
        // Also try today (partial, if available)
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const todayDate = new Date().toISOString().slice(0, 10);
        const { rows: todayExisting } = await pool.query(
          `SELECT id FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date = $2 LIMIT 1`,
          [tenant.id, todayDate]
        );
        if (todayExisting.length === 0 && new Date().getHours() >= 10) {
          // Download today's partial data (after 10am, enough clicks accumulated)
          try {
            const csv = await zombieService.downloadClicksCsv(tenant.id, todayStr, todayStr);
            if (csv) {
              const parsed = zombieService.parseClicksCsv(csv);
              if (parsed.length > 0) {
                await zombieService.persistToDb(tenant.id, parsed, todayDate);
                const totalClicks = parsed.reduce((s, r) => s + r.clicks, 0);
                console.log(`[HealthCron] [${tLabel}] Zombie today: ${parsed.length} products, ${totalClicks} clicks`);
              }
            }
          } catch (todayErr) {
            // Today's data might not be ready yet, that's fine
          }
        }
        continue;
      }

      console.log(`[HealthCron] [${tLabel}] Downloading zombie clicks for ${fetchDate}...`);
      const csv = await zombieService.downloadClicksCsv(tenant.id, dateStr, dateStr);
      if (csv) {
        const parsed = zombieService.parseClicksCsv(csv);
        if (parsed.length > 0) {
          await zombieService.persistToDb(tenant.id, parsed, fetchDate);
          const totalClicks = parsed.reduce((s, r) => s + r.clicks, 0);
          console.log(`[HealthCron] [${tLabel}] Zombie: ${parsed.length} products, ${totalClicks} clicks`);
        }
      } else {
        console.log(`[HealthCron] [${tLabel}] Zombie: no data for ${fetchDate}`);
      }
    } catch (zombieErr) {
      console.error(`[HealthCron] [${tLabel}] Zombie error:`, zombieErr.message);
    }
  }
  // Close browser after all tenants
  await zombieService.closeBrowser().catch(() => {});

  // Step 1: Scraper import (global, uses first tenant with Drive config)
  try {
    const scraperTenant = tenants.find(t => t.id);
    if (scraperTenant) {
      console.log(`[HealthCron] Scraper import (global)...`);
      const scraperResult = await importScraperData(scraperTenant.id);
      console.log(`[HealthCron] Scraper: ${scraperResult.products} products, ${scraperResult.entries} entries`);
    }
  } catch (scraperErr) {
    console.error(`[HealthCron] Scraper error:`, scraperErr.message);
  }

  const results = [];
  for (const tenant of tenants) {
    const tLabel = tenant.name || tenant.id.slice(0, 8);
    const tStart = Date.now();
    log.info(`Tenant pipeline START`, { source: 'healthCron', tenantId: tenant.id, tenantName: tLabel });
    let healthResult = null;
    try {
      // Step 0b: Sync civetta from Magento (timeout 540s = 9 min)
      // Tenant grossi possono avere 60k+ SKU civetta = 120+ pagine paginate;
      // Magento alcuni giorni risponde lento. MPF e San Vito timeoutavano a
      // 360s ricorrentemente: alzato a 540s.
      await withStepTimeout('civetta_sync', tenant.id, tLabel,
        () => syncCivettaFromMagento(tenant.id), 540 * 1000);

      // Step 1: Health scores (timeout 600s = 10 min). San Vito (800k SKU)
      // timeoutava sistematicamente a 300s: 22 fatal/24h. Alzato a 600s.
      const hRes = await withStepTimeout('health_scores', tenant.id, tLabel,
        () => computeHealthScores(tenant.id), 600 * 1000);
      if (hRes.ok) healthResult = hRes.result;

      // Step 2: GA4 attribution (timeout 120s).
      // GA4 produce errori "Step FAIL" silenziosi: API rate limit, dataset
      // vuoto, credenziali revocate, property_id sbagliato. NON e' bloccante
      // (GA4 e' lookup secondario per attribution), quindi catturiamo gli
      // errori per non sporcare i log con fatal.
      await withStepTimeout('ga4_attribution', tenant.id, tLabel, async () => {
        try {
          const hasGA4 = await googleApiService.hasGA4Credentials(tenant.id);
          if (!hasGA4) return { skipped: true, reason: 'no_credentials' };
          return await persistGA4Attribution(tenant.id);
        } catch (e) {
          return { skipped: true, reason: 'soft_fail', error: e.message?.slice(0, 200) };
        }
      }, 120 * 1000);

      // Step 2b: MC sync (finestra 04-12 UTC, max 1 volta ogni 22h per tenant).
      // 8 ore di finestra perche' processare 8 tenant in sequenza richiede
      // 50-60 min totali; le vecchie 2 ore (04-06) facevano restare fuori 4
      // tenant senza nessun sync MC mai.
      if (new Date().getUTCHours() >= 4 && new Date().getUTCHours() < 12) {
        const { rows: lastRunRows } = await pool.query(
          `SELECT EXTRACT(EPOCH FROM (NOW() - started_at)) AS sec_ago
           FROM merchant_center_runs
           WHERE tenant_id = $1 AND status = 'completed'
           ORDER BY started_at DESC LIMIT 1`,
          [tenant.id]
        );
        const secAgo = lastRunRows[0]?.sec_ago ?? Number.POSITIVE_INFINITY;
        if (secAgo > 22 * 3600) {
          await withStepTimeout('mc_sync', tenant.id, tLabel,
            () => importMerchantCenter(tenant.id), 600 * 1000);
        }
      }

      // Step 3: Feed Daily Engine (timeout 120s)
      await withStepTimeout('feed_daily', tenant.id, tLabel,
        () => runDailyFeedEngine(tenant.id), 120 * 1000);

      // Step 4: Reactivations (timeout 60s)
      await withStepTimeout('reactivations', tenant.id, tLabel,
        () => checkReactivations(tenant.id), 60 * 1000);

      // Step 5: Observation windows (timeout 60s)
      await withStepTimeout('observation', tenant.id, tLabel,
        () => checkObservationWindows(tenant.id), 60 * 1000);

      // Step 7: Stable cache (timeout 60s)
      await withStepTimeout('stable_cache', tenant.id, tLabel,
        () => recalculateStableCache(tenant.id), 60 * 1000);

      const elapsed = Date.now() - tStart;
      log.info(`Tenant pipeline DONE (${elapsed}ms)`, { source: 'healthCron', tenantId: tenant.id, tenantName: tLabel, elapsedMs: elapsed });
      results.push({ tenantId: tenant.id, ...(healthResult || {}) });
    } catch (err) {
      const elapsed = Date.now() - tStart;
      log.error(`Tenant pipeline FATAL (${elapsed}ms)`, { source: 'healthCron', tenantId: tenant.id, tenantName: tLabel, elapsedMs: elapsed }, err);
      results.push({ tenantId: tenant.id, error: err.message });
    }

    // Pause 30s between tenants to avoid overlapping external calls
    if (tenants.indexOf(tenant) < tenants.length - 1) {
      log.info(`Pausing 30s before next tenant`, { source: 'healthCron' });
      await new Promise(r => setTimeout(r, 30000));
    }
  }

  // Post-loop: AI Daily Explainer (1x/giorno, finestra 09:00-10:00, gate 22h)
  try {
    const now = new Date();
    if (now.getHours() >= 9 && now.getHours() < 10) {
      const lastAgo = _lastAIDailyRun ? Date.now() - _lastAIDailyRun : Infinity;
      if (lastAgo > 22 * 3600 * 1000) {
        console.log('[HealthCron] Running AI Daily Explainer...');
        const r = await runDailyExplainerAllTenants();
        console.log(`[HealthCron] AI Daily Explainer: ${r.length} tenant processed`);
        _lastAIDailyRun = Date.now();
      }
    }
  } catch (aiErr) {
    console.error('[HealthCron] AI Daily Explainer error:', aiErr.message);
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

  console.log('[HealthCron] Full pipeline cron initialized (every 1h, first run in 30s)');
}

function stopHealthCron() {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}

module.exports = { startHealthCron, stopHealthCron, runForAllTenants };
