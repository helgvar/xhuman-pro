const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { decrypt, encrypt } = require('../services/crypto');
const { withTenantLock } = require('../services/apiQueue');
const router = express.Router();

// ─── SSE Log helper ────────────────────────────────────
function sendLog(res, level, message, data = null) {
  const entry = { ts: new Date().toISOString(), level, message, data };
  res.write(`data: ${JSON.stringify(entry)}\n\n`);
}

// ─── GET /api/onboarding/:tenantId/status ──────────────
// Returns current onboarding status for a tenant
router.get('/:tenantId/status', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const status = await getOnboardingStatus(tenantId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/onboarding/:tenantId/generate-api-key ───
router.post('/:tenantId/generate-api-key', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { name } = req.body;

    // Deactivate old keys
    await pool.query('UPDATE tenant_api_keys SET active = false WHERE tenant_id = $1', [tenantId]);

    // Generate new key
    const apiKey = 'xhp_' + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const tenantName = (await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0]?.name || 'Unknown';
    const keyName = name || `Farmabooster ${tenantName}`;

    // Save key hash + encrypted key (for admin retrieval)
    const encryptedKey = encrypt(apiKey);
    await pool.query(
      'INSERT INTO tenant_api_keys (tenant_id, name, key_hash, encrypted_key) VALUES ($1, $2, $3, $4)',
      [tenantId, keyName, keyHash, encryptedKey]
    );

    res.json({ apiKey, name: keyName, message: 'API Key generata. Configurala in Farmabooster.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/onboarding/:tenantId/api-key ─────────────
// Retrieve the current active API key (decrypted)
router.get('/:tenantId/api-key', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { rows } = await pool.query(
      'SELECT name, encrypted_key, created_at, last_used_at FROM tenant_api_keys WHERE tenant_id = $1 AND active = true ORDER BY created_at DESC LIMIT 1',
      [tenantId]
    );
    if (rows.length === 0 || !rows[0].encrypted_key) {
      return res.json({ apiKey: null, message: 'Nessuna API key recuperabile. Genera una nuova.' });
    }
    const apiKey = decrypt(rows[0].encrypted_key);
    res.json({ apiKey, name: rows[0].name, createdAt: rows[0].created_at, lastUsed: rows[0].last_used_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/onboarding/:tenantId/run ────────────────
// Runs full onboarding pipeline with SSE streaming logs
router.post('/:tenantId/run', async (req, res) => {
  const { tenantId } = req.params;
  const { steps } = req.body; // optional: array of step names to run, or null for all

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Heartbeat ogni 20s per evitare il timeout SSE quando uno step (es. import 90k prodotti)
  // non scrive log per minuti. Nginx send_timeout / browser keepalive chiudono la connessione
  // dopo ~60s di silenzio. Il commento SSE `: ping\n\n` mantiene viva la connessione.
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${new Date().toISOString()}\n\n`); }
    catch { clearInterval(heartbeat); }
  }, 20000);
  res.on('close', () => clearInterval(heartbeat));

  const log = (level, msg, data) => sendLog(res, level, msg, data);

  try {
    const tenant = (await pool.query('SELECT id, name, slug FROM tenants WHERE id = $1', [tenantId])).rows[0];
    if (!tenant) { log('error', 'Tenant non trovato'); res.end(); return; }

    log('info', `Onboarding avviato per ${tenant.name}`, { tenantId, slug: tenant.slug });

    // ─── STEP 1: Verifica configurazione ─────────────
    log('step', 'Verifica configurazione...');
    const configStatus = await checkConfig(tenantId);
    if (configStatus.missing.length > 0) {
      log('warn', `Config mancanti: ${configStatus.missing.join(', ')}`, configStatus);
    } else {
      log('success', `Tutte le ${configStatus.total} configurazioni presenti`);
    }

    // Check required for proceeding
    const critical = ['farmabooster_api_url', 'farmabooster_api_email', 'farmabooster_api_password'];
    const hasCritical = critical.every(k => configStatus.present.includes(k));
    if (!hasCritical) {
      log('error', 'Configurazioni Farmabooster mancanti. Impossibile procedere.', { missing: configStatus.missing.filter(k => critical.includes(k)) });
      res.write(`data: ${JSON.stringify({ done: true, success: false })}\n\n`);
      res.end();
      return;
    }

    // ─── STEP 2: Setup health_config defaults ────────
    if (!steps || steps.includes('config')) {
      log('step', 'Setup configurazione ottimizzazione...');
      await setupHealthConfigDefaults(tenantId, req.body.config || {});
      log('success', 'Configurazione ottimizzazione salvata');
    }

    // ─── STEP 3: Import prodotti ─────────────────────
    if (!steps || steps.includes('products')) {
      log('step', 'Import prodotti da Farmabooster (in coda)...');
      try {
        const { importProducts } = require('../services/farmaboosterProducts');
        const result = await withTenantLock(tenantId, () => importProducts(tenantId));
        log('success', `${result.totalImported} prodotti importati, ${result.rulesSaved} regole prezzo`, result);
      } catch (e) {
        log('error', `Import prodotti fallito: ${e.message}`);
      }
    }

    // ─── STEP 4: Civetta sync da Magento ─────────────
    if (!steps || steps.includes('civetta')) {
      log('step', 'Sync civetta da Magento...');
      try {
        const hasMagento = configStatus.present.includes('magento_base_url') && configStatus.present.includes('magento_api_token');
        if (hasMagento) {
          const { syncCivettaFromMagento } = require('../services/farmaboosterProducts');
          const count = await syncCivettaFromMagento(tenantId);
          log('success', `Civetta sincronizzata: ${count} prodotti`);
        } else {
          log('warn', 'Magento non configurato, skip civetta sync');
        }
      } catch (e) {
        log('error', `Civetta sync fallita: ${e.message}`);
      }
    }

    // ─── STEP 5: Import ordini ───────────────────────
    if (!steps || steps.includes('orders')) {
      log('step', 'Import ordini da Magento (30gg)...');
      try {
        const hasMagento = configStatus.present.includes('magento_base_url') && configStatus.present.includes('magento_api_token');
        if (hasMagento) {
          const { importOrders } = require('../services/magentoOrders');
          await importOrders(tenantId, 30);
          const { rows: [c] } = await pool.query('SELECT COUNT(*) as cnt FROM orders WHERE tenant_id = $1', [tenantId]);
          log('success', `${c.cnt} ordini importati`);
        } else {
          log('warn', 'Magento non configurato, skip ordini');
        }
      } catch (e) {
        log('error', `Import ordini fallito: ${e.message}`);
      }
    }

    // ─── STEP 6: Download zombie clicks ──────────────
    if (!steps || steps.includes('zombie')) {
      log('step', 'Download click Trovaprezzi...');
      try {
        const hasTP = configStatus.present.includes('trovaprezzi_username') && configStatus.present.includes('trovaprezzi_password');
        if (hasTP) {
          const zombie = require('../services/zombieService');
          let totalDays = 0, totalClicks = 0;

          // Try last 30 days
          for (let d = 30; d >= 0; d--) {
            const date = new Date();
            date.setDate(date.getDate() - d);
            const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
            const fetchDate = date.toISOString().slice(0, 10);

            // Skip if already have data for this date
            const { rows: [existing] } = await pool.query(
              'SELECT COUNT(*) as cnt FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date = $2', [tenantId, fetchDate]
            );
            if (parseInt(existing.cnt) > 0) { totalDays++; continue; }

            try {
              const csv = await zombie.downloadClicksCsv(tenantId, dateStr, dateStr);
              if (csv) {
                const parsed = zombie.parseClicksCsv(csv);
                await zombie.persistToDb(tenantId, parsed, fetchDate);
                const clicks = parsed.reduce((s, r) => s + r.clicks, 0);
                totalDays++;
                totalClicks += clicks;
                log('info', `${fetchDate}: ${parsed.length} prodotti, ${clicks} click`);
              }
            } catch { /* no data for this day */ }
            await new Promise(r => setTimeout(r, 1500));
          }
          await zombie.closeBrowser();
          log('success', `${totalDays} giorni di click, ${totalClicks} click totali`);
        } else {
          log('warn', 'Trovaprezzi non configurato, skip zombie');
        }
      } catch (e) {
        log('error', `Download zombie fallito: ${e.message}`);
      }
    }

    // ─── STEP 7: Scraper import ──────────────────────
    if (!steps || steps.includes('scraper')) {
      log('step', 'Import dati competitor (scraper)...');
      try {
        const hasScraper = configStatus.present.includes('google_service_account_json') && configStatus.present.includes('scraper_drive_folder_id');
        if (hasScraper) {
          const { importScraperFromDrive } = require('../services/driveScraper');
          const result = await importScraperFromDrive(tenantId);
          log('success', `Scraper: ${result.products} prodotti, ${result.entries} competitor`);
        } else {
          log('warn', 'Google Drive non configurato, skip scraper');
        }
      } catch (e) {
        log('error', `Scraper fallito: ${e.message}`);
      }
    }

    // ─── STEP 8: Health scores ───────────────────────
    if (!steps || steps.includes('health')) {
      log('step', 'Calcolo health scores...');
      try {
        const { computeHealthScores } = require('../services/productHealth');
        const hs = await computeHealthScores(tenantId);
        log('success', `${hs.total} prodotti scorati`, hs.byClassification);
      } catch (e) {
        log('error', `Health scores fallito: ${e.message}`);
      }
    }

    // ─── STEP 9: GA4 attribution ─────────────────────
    if (!steps || steps.includes('ga4')) {
      log('step', 'GA4 attribution...');
      try {
        const hasGA4 = configStatus.present.includes('ga4_property_id') && configStatus.present.includes('google_service_account_json');
        if (hasGA4) {
          const { persistGA4Attribution } = require('../services/ga4Analytics');
          const ga4 = await persistGA4Attribution(tenantId);
          log('success', `GA4: ${ga4.updated} prodotti con attribution`);
        } else {
          log('warn', 'GA4 non configurato, skip attribution');
        }
      } catch (e) {
        log('error', `GA4 fallito: ${e.message}`);
      }
    }

    // ─── STEP 10: Feed engine ────────────────────────
    if (!steps || steps.includes('feed')) {
      log('step', 'Feed engine (triage + quarantena)...');
      try {
        const { runDailyFeedEngine } = require('../services/feedDailyEngine');
        const feed = await runDailyFeedEngine(tenantId);
        log('success', `Feed: ${JSON.stringify(feed.stats)} | Incidenza: ${feed.snapshot.incidence.toFixed(1)}%`, {
          stats: feed.stats,
          incidence: feed.snapshot.incidence,
          cost: feed.snapshot.totalCost,
          revenue: feed.snapshot.totalRevenue,
          killers: feed.killers,
          saved: feed.savedCost,
        });
      } catch (e) {
        log('error', `Feed engine fallito: ${e.message}`);
      }
    }

    // ─── STEP 11: Stable cache ───────────────────────
    if (!steps || steps.includes('stable')) {
      log('step', 'Generazione cache per External API...');
      try {
        const { recalculateStableCache } = require('./externalApi');
        await recalculateStableCache(tenantId);
        log('success', 'Stable cache generata');
      } catch (e) {
        log('error', `Stable cache fallita: ${e.message}`);
      }
    }

    // ─── STEP 12: API Key check ──────────────────────
    const { rows: [ak] } = await pool.query('SELECT name FROM tenant_api_keys WHERE tenant_id = $1 AND active = true', [tenantId]);
    if (ak) {
      log('success', `API Key attiva: ${ak.name}`);
    } else {
      log('warn', 'Nessuna API Key generata. Genera dalla pagina Configurazione.');
    }

    // ─── DONE ────────────────────────────────────────
    const finalStatus = await getOnboardingStatus(tenantId);
    log('info', 'Onboarding completato', finalStatus);
    res.write(`data: ${JSON.stringify({ done: true, success: true, status: finalStatus })}\n\n`);
  } catch (err) {
    log('error', `Errore fatale: ${err.message}`);
    res.write(`data: ${JSON.stringify({ done: true, success: false, error: err.message })}\n\n`);
  }

  res.end();
});

// ─── Helpers ───────────────────────────────────────────

async function checkConfig(tenantId) {
  const required = [
    'farmabooster_api_url', 'farmabooster_api_email', 'farmabooster_api_password',
    'magento_base_url', 'magento_api_token',
    'ga4_property_id',
    'google_merchant_id',
    'trovaprezzi_username', 'trovaprezzi_password', 'trovaprezzi_seller_name',
  ];

  const { rows } = await pool.query(
    'SELECT config_key FROM tenant_configs WHERE tenant_id = $1',
    [tenantId]
  );
  let present = rows.map(r => r.config_key);

  // Pull in network-wide global keys so downstream gates (scraper, GA4) see them as configured.
  const { rows: g } = await pool.query(
    `SELECT config_key FROM global_config
     WHERE config_key IN ('google_service_account_json','ga4_credentials_json','scraper_drive_folder_id')
       AND config_value IS NOT NULL AND config_value <> ''`
  );
  present = present.concat(g.map(r => r.config_key));

  const missing = required.filter(k => !present.includes(k));

  return { total: present.length, present, missing, required };
}

async function setupHealthConfigDefaults(tenantId, overrides = {}) {
  const defaults = {
    avg_tp_cpc: '0.27',
    revenue_source: overrides.revenue_source || 'magento',
    feed_monthly_budget: overrides.monthly_budget || '3500',
    tp_target_incidence_min: '3',
    tp_target_incidence_max: '5',
    feed_min_margin_pct: '8',
    feed_min_margin_eur: '0.50',
    feed_pepite_pct: '0.80',
    feed_quarantine_days_budget: '30',
    feed_quarantine_days_stock: '7',
    feed_reactivation_interval_days: '3',
    feed_reactivation_min_demand_score: '3',
    quarantine_observation_days: '3',
    quarantine_q1_days: '7',
    quarantine_q2_days: '15',
    quarantine_q3_days: '30',
    weight_revenue: '0.30',
    weight_efficiency: '0.25',
    weight_competitive: '0.15',
    weight_growth: '0.10',
    weight_seasonal: '0.10',
    weight_indirect: '0.10',
    feed_big_player_merchants: JSON.stringify(["Amazon", "DocPeter", "Farmacia Loreto", "1000Farmacie", "Farmacia Fatigato", "Amicafarmacia", "Dr. Max"]),
    feed_margin_brackets: JSON.stringify([
      { min: 0, max: 1, maxClicks: 1 }, { min: 1, max: 3, maxClicks: 2 },
      { min: 3, max: 5, maxClicks: 3 }, { min: 5, max: 10, maxClicks: 4 },
      { min: 10, max: 15, maxClicks: 5 }, { min: 15, max: 25, maxClicks: 8 },
      { min: 25, max: 50, maxClicks: 13 }, { min: 50, max: 999, maxClicks: 18 },
    ]),
  };

  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      'INSERT INTO health_config (tenant_id, config_key, config_value) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, config_key) DO NOTHING',
      [tenantId, key, value]
    );
  }
}

async function getOnboardingStatus(tenantId) {
  const [products, orders, health, zombie, scraper, mc, ga4, feed, apiKey, quarantine] = await Promise.all([
    pool.query('SELECT COUNT(*) as cnt FROM products WHERE tenant_id = $1', [tenantId]),
    pool.query('SELECT COUNT(*) as cnt FROM orders WHERE tenant_id = $1', [tenantId]),
    pool.query('SELECT COUNT(*) as cnt FROM product_health_scores WHERE tenant_id = $1', [tenantId]),
    pool.query('SELECT COUNT(DISTINCT fetch_date) as days, COALESCE(SUM(clicks), 0) as clicks FROM zombie_clicks WHERE tenant_id = $1', [tenantId]),
    pool.query("SELECT COUNT(DISTINCT product_code) as cnt FROM scraper_competitors WHERE updated_at > NOW() - INTERVAL '72h'"),
    pool.query('SELECT COUNT(*) as cnt FROM merchant_center_products WHERE tenant_id = $1', [tenantId]),
    pool.query("SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'ga4_tp_revenue_30d'", [tenantId]),
    pool.query("SELECT action, COUNT(*) as cnt FROM feed_actions WHERE tenant_id = $1 GROUP BY action", [tenantId]),
    pool.query('SELECT name, last_used_at FROM tenant_api_keys WHERE tenant_id = $1 AND active = true', [tenantId]),
    pool.query('SELECT COUNT(*) as cnt FROM feed_quarantine WHERE tenant_id = $1 AND reactivated = false', [tenantId]),
  ]);

  const feedMap = {};
  feed.rows.forEach(r => feedMap[r.action] = parseInt(r.cnt));

  const summary = (await pool.query(
    'SELECT * FROM feed_daily_summary WHERE tenant_id = $1 ORDER BY summary_date DESC LIMIT 1', [tenantId]
  )).rows[0];

  const configStatus = await checkConfig(tenantId);
  const revSource = (await pool.query("SELECT config_value FROM health_config WHERE tenant_id = $1 AND config_key = 'revenue_source'", [tenantId])).rows[0]?.config_value;

  return {
    config: { total: configStatus.total, missing: configStatus.missing },
    products: parseInt(products.rows[0].cnt),
    orders: parseInt(orders.rows[0].cnt),
    health: parseInt(health.rows[0].cnt),
    zombie: { days: parseInt(zombie.rows[0].days), clicks: parseInt(zombie.rows[0].clicks) },
    scraper: parseInt(scraper.rows[0].cnt),
    merchantCenter: parseInt(mc.rows[0].cnt),
    ga4Revenue: ga4.rows[0]?.config_value || null,
    revenueSource: revSource || 'not set',
    feed: feedMap,
    quarantine: parseInt(quarantine.rows[0].cnt),
    apiKey: apiKey.rows[0] ? { name: apiKey.rows[0].name, lastUsed: apiKey.rows[0].last_used_at } : null,
    incidence: summary ? parseFloat(summary.cumulative_incidence) : null,
    summary: summary || null,
  };
}

module.exports = router;
