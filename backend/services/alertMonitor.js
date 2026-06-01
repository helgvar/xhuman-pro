/**
 * Alert Monitor — guardiano della pipeline.
 *
 * Ogni 60 minuti controlla TUTTI gli import critici. Se uno fallisce, alert
 * immediato Telegram (dedup 4h per stessa coppia tenant+loop). 4 giorni di
 * scraper Drive fermo senza alert NON DEVE PIÙ SUCCEDERE.
 *
 * Coperti:
 *  - OrderSync           (orders.imported_at)
 *  - ZombieCron          (zombie_clicks.fetch_date)
 *  - HealthCron          (product_health_scores.computed_at)
 *  - ProductSync         (products.updated_at)
 *  - DriveScraper        (scraper_refresh_log status=completed)
 *  - MerchantCenterSync  (merchant_center_runs status=completed) - solo per tenant ops
 *  - MagentoSyncCron     (feed_dispatch_log endpoint='magento-sync') - solo tenant ops
 *
 * Autocontained: legge global_config per telegram_bot_token / telegram_chat_id.
 */

const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;           // 60 min
const ALERT_THROTTLE_MS = 4 * 60 * 60 * 1000;        // 4h per coppia tenant+loop
const BOOT_GRACE_MS = 5 * 60 * 1000;                 // 5 min warm-up post-restart
const _bootTime = Date.now();
const lastAlertKey = new Map();                     // dedup memo: "<tenantId>|<loop>" -> ts

const THRESHOLDS_HOURS = {
  orders: 8,                  // OrderSync 60min cycle
  zombieClicks: 36,           // ZombieCron daily 03:00 UTC
  healthScores: 6,            // HealthCron 60min ma loop tenant lungo
  productSync: 3,             // ProductSync ogni 1h, soglia 3h
  driveScraper: 25,           // gira ogni 4-6h dal productSync
  mcSync: 30,                 // gira 1x/24h finestra 04-12 UTC
  magentoSync: 5,             // gira ogni 4h allineato TP, soglia 5h
  stableCache: 1.5,           // gira ogni 30 min via stableCacheCron, soglia 1.5h
                              // (se vecchio, Farmabooster serve dati stale)
};

async function readGlobalConfig(key) {
  const { rows: [row] } = await pool.query(
    `SELECT config_value FROM global_config WHERE config_key=$1`, [key]
  );
  if (!row) return null;
  try { return decrypt(row.config_value); } catch { return row.config_value; }
}

async function sendTelegram(text) {
  const botToken = await readGlobalConfig('telegram_bot_token');
  const chatId = await readGlobalConfig('telegram_chat_id');
  if (!botToken || !chatId) {
    console.warn('[AlertMonitor] Telegram non configurato, alert solo a log');
    return false;
  }
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[AlertMonitor] Telegram ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[AlertMonitor] Telegram fetch error:', err.message);
    return false;
  }
}

function hoursAgo(date) {
  if (!date) return Infinity;
  return (Date.now() - new Date(date).getTime()) / 3600000;
}

function fmtAgo(h) {
  if (h === Infinity) return 'MAI';
  if (h < 1) return `${Math.round(h * 60)}min fa`;
  if (h < 24) return `${h.toFixed(1)}h fa`;
  return `${(h / 24).toFixed(1)}gg fa`;
}

async function getFreshnessByTenant() {
  const { rows } = await pool.query(`
    SELECT
      t.id, t.name,
      (SELECT MAX(imported_at) FROM orders WHERE tenant_id=t.id) AS last_order,
      (SELECT MAX(fetch_date)::timestamp + TIME '23:59:59' FROM zombie_clicks WHERE tenant_id=t.id) AS last_tp,
      (SELECT MAX(computed_at) FROM product_health_scores WHERE tenant_id=t.id) AS last_health,
      (SELECT MAX(updated_at) FROM products WHERE tenant_id=t.id) AS last_product,
      (SELECT MAX(completed_at) FROM merchant_center_runs WHERE tenant_id=t.id AND status='completed') AS last_mc,
      (SELECT MAX(dispatched_at) FROM feed_dispatch_log WHERE tenant_id=t.id AND endpoint='magento-sync') AS last_magento_sync,
      (SELECT updated_at FROM tenant_configs WHERE tenant_id=t.id AND config_key='stable_price_cuts') AS last_stable_cache,
      -- Disallineamento: PRICE_CUT in feed_actions vs PRICE_CUT in stable cache
      (SELECT COUNT(*) FROM feed_actions WHERE tenant_id=t.id AND action='PRICE_CUT' AND recommended_price IS NOT NULL) AS pc_in_actions,
      (SELECT jsonb_array_length((config_value::jsonb)->'products')
       FROM tenant_configs WHERE tenant_id=t.id AND config_key='stable_price_cuts'
       AND config_value IS NOT NULL AND config_value::jsonb ? 'products') AS pc_in_cache,
      (SELECT config_value FROM tenant_configs WHERE tenant_id=t.id AND config_key='xhumanpro_magento_mode') AS magento_mode
    FROM tenants t
    WHERE t.status = 'active'
    ORDER BY t.name
  `);
  return rows;
}

async function getDriveScraperFreshness() {
  // Drive scraper è globale (non per tenant): verifichiamo l'ultimo run completato
  const { rows: [r] } = await pool.query(`
    SELECT MAX(completed_at) AS last_ok,
      (SELECT error_message FROM scraper_refresh_log
       WHERE status='failed' AND started_at > NOW() - INTERVAL '2 days'
       ORDER BY started_at DESC LIMIT 1) AS last_error
    FROM scraper_refresh_log
    WHERE status='completed'
  `);
  return r;
}

async function checkAll() {
  const tenants = await getFreshnessByTenant();
  const issues = [];

  // Check globali (non per tenant)
  const drive = await getDriveScraperFreshness();
  const driveAgo = hoursAgo(drive?.last_ok);
  if (driveAgo > THRESHOLDS_HOURS.driveScraper) {
    issues.push({
      tenantId: null, tenant: 'GLOBALE', loop: 'DriveScraper',
      label: 'Drive scraper (posizioni TP)',
      hoursAgo: driveAgo, threshold: THRESHOLDS_HOURS.driveScraper,
      details: drive?.last_error ? `Ultimo errore: ${drive.last_error.slice(0, 120)}` : '',
    });
  }

  for (const t of tenants) {
    const isOperational = t.magento_mode === 'operational';
    const checks = [
      { loop: 'OrderSync',    last: t.last_order,   threshold: THRESHOLDS_HOURS.orders,        label: 'OrderSync' },
      { loop: 'ZombieCron',   last: t.last_tp,      threshold: THRESHOLDS_HOURS.zombieClicks,  label: 'TP click' },
      { loop: 'HealthCron',   last: t.last_health,  threshold: THRESHOLDS_HOURS.healthScores,  label: 'HealthCron' },
      { loop: 'ProductSync',  last: t.last_product, threshold: THRESHOLDS_HOURS.productSync,   label: 'ProductSync' },
      { loop: 'MCSync',       last: t.last_mc,      threshold: THRESHOLDS_HOURS.mcSync,        label: 'Merchant Center sync' },
    ];
    if (isOperational) {
      checks.push({ loop: 'MagentoSync', last: t.last_magento_sync, threshold: THRESHOLDS_HOURS.magentoSync, label: 'Magento sync (civettaai)' });
    }
    // StableCache: serve a Farmabooster via /feed/civetta, /feed/prices.
    // Se non si aggiorna, Farmabooster riceve dati stale (zero PC, civetta vecchi).
    checks.push({ loop: 'StableCache', last: t.last_stable_cache, threshold: THRESHOLDS_HOURS.stableCache, label: 'Stable cache (feed Farmabooster)' });

    for (const c of checks) {
      const h = hoursAgo(c.last);
      if (h > c.threshold) {
        issues.push({
          tenantId: t.id, tenant: t.name, loop: c.loop, label: c.label,
          hoursAgo: h, threshold: c.threshold,
        });
      }
    }

    // Disallineamento PRICE_CUT: se in feed_actions ne abbiamo ≥10 e la cache
    // /feed/prices ne ha 0 (o <10% di quelli reali), Farmabooster non li vede.
    const pcActions = Number(t.pc_in_actions) || 0;
    const pcCache = Number(t.pc_in_cache) || 0;
    if (pcActions >= 10 && pcCache < pcActions * 0.5) {
      issues.push({
        tenantId: t.id, tenant: t.name, loop: 'PCMismatch',
        label: `PRICE_CUT misalignment (feed_actions ${pcActions} vs cache ${pcCache})`,
        hoursAgo: 0, threshold: 0,
        details: `Farmabooster sta ricevendo ${pcCache} PC ma ne abbiamo ${pcActions} pronti. Forzare recalculateStableCache.`,
      });
    }
  }

  return issues;
}

async function maybeAlert(issue) {
  const key = `${issue.tenantId || 'global'}|${issue.loop}`;
  const last = lastAlertKey.get(key) || 0;
  if (Date.now() - last < ALERT_THROTTLE_MS) return false;

  const details = issue.details ? `\n<i>${issue.details}</i>` : '';
  const msg = `<b>🚨 ${issue.tenant}</b>\n<b>${issue.label}</b> fermo da <b>${fmtAgo(issue.hoursAgo)}</b> (soglia ${issue.threshold}h)${details}\n<i>xHumanPro AlertMonitor</i>`;
  const sent = await sendTelegram(msg);
  if (sent) lastAlertKey.set(key, Date.now());
  return sent;
}

async function runCheck() {
  try {
    const issues = await checkAll();
    const uptimeMs = Date.now() - _bootTime;
    const inGrace = uptimeMs < BOOT_GRACE_MS;

    if (issues.length === 0) {
      console.log('[AlertMonitor] All loops OK');
      return;
    }
    console.warn(`[AlertMonitor] ${issues.length} issue(s) detected${inGrace ? ' (boot grace period, no Telegram)' : ''}`);
    for (const i of issues) {
      console.warn(`[AlertMonitor]  ${i.tenant}/${i.loop} ${fmtAgo(i.hoursAgo)}`);
      if (!inGrace) await maybeAlert(i);
    }
  } catch (err) {
    console.error('[AlertMonitor] Check error:', err.message);
  }
}

function startAlertMonitor() {
  // Primo check immediato (5s dopo boot per dare tempo al DB)
  setTimeout(runCheck, 5000);
  // Poi ogni 30 min
  setInterval(runCheck, CHECK_INTERVAL_MS);
  console.log(`[AlertMonitor] Started (first check in 5s, then every ${CHECK_INTERVAL_MS / 60000}min)`);
}

module.exports = { startAlertMonitor, runCheck, checkAll };
