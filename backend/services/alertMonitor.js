/**
 * Alert Monitor — guardiano della pipeline.
 *
 * Ogni 30 minuti controlla per ogni tenant attivo:
 *  - ultimo ordine importato < 6h          (OrderSync)
 *  - ultimi TP click   < 36h               (ZombieCron, sospetto budget exhausted se > 48h)
 *  - ultimo health score < 3h              (HealthCron)
 *  - ultimo sync prodotti < 24h            (ProductSync)
 *
 * Se uno dei loop è oltre la soglia, invia Telegram con dedup (max 1 alert ogni 4h
 * per stessa coppia tenant+loop).
 *
 * Autocontained: legge global_config per telegram_bot_token / telegram_chat_id.
 */

const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const CHECK_INTERVAL_MS = 30 * 60 * 1000;          // 30 min
const ALERT_THROTTLE_MS = 12 * 60 * 60 * 1000;      // 12h (evita spam su anomalie persistenti)
const BOOT_GRACE_MS = 20 * 60 * 1000;               // 20 min di warm-up dopo restart
const _bootTime = Date.now();
const lastAlertKey = new Map();                    // dedup memo: "<tenantId>|<loop>" -> ts

// Soglie scelte per essere coerenti con frequenza cron:
// - OrderSync gira ogni 60min e ha first-run immediate -> 8h e' ampio per coprire 1-2 cicli persi
// - ZombieCron gira 1x/giorno alle 00:05 -> 36h copre fino a 1.5 giorni
// - HealthCron gira ogni 60min ma copre 8 tenant in sequenza, ciclo completo 20-30min -> 5h e' safe
// - ProductSync ogni 360min (6h) -> 24h copre 4 cicli persi
const THRESHOLDS_HOURS = {
  orders: 8,
  zombieClicks: 36,
  healthScores: 5,
  productSync: 24,
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
      (SELECT MAX(updated_at) FROM products WHERE tenant_id=t.id) AS last_product
    FROM tenants t
    WHERE t.status = 'active'
    ORDER BY t.name
  `);
  return rows;
}

async function checkAll() {
  const tenants = await getFreshnessByTenant();
  const issues = [];

  for (const t of tenants) {
    const checks = [
      { loop: 'OrderSync',    last: t.last_order,   threshold: THRESHOLDS_HOURS.orders,        label: 'OrderSync' },
      { loop: 'ZombieCron',   last: t.last_tp,      threshold: THRESHOLDS_HOURS.zombieClicks,  label: 'TP click' },
      { loop: 'HealthCron',   last: t.last_health,  threshold: THRESHOLDS_HOURS.healthScores,  label: 'HealthCron' },
      { loop: 'ProductSync',  last: t.last_product, threshold: THRESHOLDS_HOURS.productSync,   label: 'ProductSync' },
    ];

    for (const c of checks) {
      const h = hoursAgo(c.last);
      if (h > c.threshold) {
        issues.push({
          tenantId: t.id,
          tenant: t.name,
          loop: c.loop,
          label: c.label,
          hoursAgo: h,
          threshold: c.threshold,
        });
      }
    }
  }

  return issues;
}

async function maybeAlert(issue) {
  const key = `${issue.tenantId}|${issue.loop}`;
  const last = lastAlertKey.get(key) || 0;
  if (Date.now() - last < ALERT_THROTTLE_MS) return false;

  const msg = `<b>⚠ ${issue.tenant}</b>\n${issue.label} fermo da <b>${fmtAgo(issue.hoursAgo)}</b> (soglia ${issue.threshold}h)\n<i>xHumanPro AlertMonitor</i>`;
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
