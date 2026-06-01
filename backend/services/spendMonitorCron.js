/**
 * Spend Monitor Cron — guardiano economico del feed TP.
 *
 * Ogni 3 ore per tenant operational:
 *  - Incidenza IERI = spesa_TP_ieri / revenue_store_ieri.
 *    Calcolata SOLO se zombie_clicks copre ieri (gira ~03 UTC del giorno
 *    dopo) E orderSync è fresco (< 6h). Se uno dei due dati è stale, skip
 *    con motivo loggato — niente alert "a capocchia".
 *  - Spesa anomala = clicks ieri vs media 7g precedenti. Stessa gate freschezza.
 *  - Calo ordini = ordini today vs media stesso DOW alla stessa ora. Solo
 *    orderSync fresh richiesto.
 *
 * Soglie configurabili in global_config.spend_monitor_thresholds (JSON).
 */

const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;       // 3h
const ALERT_THROTTLE_MS = 4 * 60 * 60 * 1000;        // 4h per coppia tenant+alert_type
const BOOT_GRACE_MS = 5 * 60 * 1000;                 // 5 min post-restart
const _bootTime = Date.now();
const lastAlertKey = new Map();

const DEFAULT_THRESHOLDS = {
  incidence_alert_pct: 8.0,
  spend_anomaly_pct: 150,
  orders_drop_pct: 40,
  min_clicks_for_check: 20,
};

async function readGlobalConfig(key) {
  const { rows: [row] } = await pool.query(
    `SELECT config_value FROM global_config WHERE config_key=$1`, [key]
  );
  if (!row) return null;
  try { return decrypt(row.config_value); } catch { return row.config_value; }
}

async function loadThresholds() {
  try {
    const raw = await readGlobalConfig('spend_monitor_thresholds');
    if (!raw) return DEFAULT_THRESHOLDS;
    return { ...DEFAULT_THRESHOLDS, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

async function sendTelegram(text) {
  const botToken = await readGlobalConfig('telegram_bot_token');
  const chatId = await readGlobalConfig('telegram_chat_id');
  if (!botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return res.ok;
  } catch { return false; }
}

async function getTenantMetrics(tenantId) {
  // Incidenza si calcola su YESTERDAY (giorno chiuso), perchè:
  //  - Click TP arrivano via ZombieCron alle ~03 UTC del giorno dopo
  //  - Ordini today sono parziali fino a fine giornata + 1-2h di sync
  // Calcolare incidenza su giorno corrente porta a falsi allarmi: spesa parziale
  // (=0 fino alle 5 del giorno dopo) contro revenue parziale (cresce ora per ora).
  //
  // Per "ordini drop" usiamo invece confronto today-vs-DOW perchè gli ordini
  // crescono in continuo e un calo drammatico è rilevabile anche durante la
  // giornata (es. ore 18: confronto vs media DOW alla stessa ora).
  const { rows: [r] } = await pool.query(`
    WITH dates AS (
      SELECT
        (NOW() AT TIME ZONE 'Europe/Rome')::date AS today,
        ((NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '1 day')::date AS yest,
        ((NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '8 days')::date AS last8_start,
        EXTRACT(DOW FROM (NOW() AT TIME ZONE 'Europe/Rome'))::int AS today_dow
    ),
    avg_cpc AS (
      SELECT COALESCE(MAX(NULLIF(config_value,'')::numeric), 0.27) AS cpc
      FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc'
    ),
    -- Freshness gates
    last_zombie AS (
      SELECT MAX(fetch_date) AS max_fetch_date,
             MAX(created_at) AS last_loaded_at
      FROM zombie_clicks WHERE tenant_id=$1
    ),
    last_order AS (
      SELECT MAX(imported_at) AS last_import FROM orders WHERE tenant_id=$1
    ),
    -- YESTERDAY metrics (per incidenza affidabile)
    clicks_yest AS (
      SELECT COALESCE(SUM(clicks), 0)::int AS clicks
      FROM zombie_clicks WHERE tenant_id=$1 AND fetch_date=(SELECT yest FROM dates)
    ),
    orders_yest AS (
      SELECT COUNT(*) AS n, COALESCE(SUM(grand_total_products), 0) AS rev
      FROM orders WHERE tenant_id=$1
        AND (order_date AT TIME ZONE 'Europe/Rome')::date = (SELECT yest FROM dates)
        AND order_status NOT IN ('canceled','closed')
    ),
    clicks_7day_avg AS (
      SELECT AVG(daily_clicks) AS clicks
      FROM (
        SELECT SUM(clicks) AS daily_clicks
        FROM zombie_clicks
        WHERE tenant_id=$1
          AND fetch_date BETWEEN (SELECT last8_start FROM dates) AND ((SELECT yest FROM dates) - INTERVAL '1 day')
        GROUP BY fetch_date
      ) s
    ),
    -- TODAY metrics (per ordini-drop a metà giornata)
    orders_today AS (
      SELECT COUNT(*) AS n
      FROM orders WHERE tenant_id=$1
        AND (order_date AT TIME ZONE 'Europe/Rome')::date = (SELECT today FROM dates)
        AND order_status NOT IN ('canceled','closed')
    ),
    orders_dow_avg AS (
      -- Per confronto realistico durante la giornata: media ordini fino allo
      -- stesso orario nei 4 DOW precedenti (es. lunedì 14:00 = media ordini
      -- fino alle 14:00 dei 4 lunedì precedenti).
      SELECT AVG(daily_n) AS avg_orders
      FROM (
        SELECT COUNT(*) AS daily_n
        FROM orders WHERE tenant_id=$1
          AND order_date >= NOW() - INTERVAL '28 days'
          AND (order_date AT TIME ZONE 'Europe/Rome')::date < (SELECT today FROM dates)
          AND EXTRACT(DOW FROM (order_date AT TIME ZONE 'Europe/Rome')) = (SELECT today_dow FROM dates)
          -- finestra "fino all'ora attuale del DOW di riferimento"
          AND EXTRACT(EPOCH FROM (order_date AT TIME ZONE 'Europe/Rome'))::bigint % 86400
              < EXTRACT(EPOCH FROM (NOW() AT TIME ZONE 'Europe/Rome'))::bigint % 86400
          AND order_status NOT IN ('canceled','closed')
        GROUP BY (order_date AT TIME ZONE 'Europe/Rome')::date
      ) s
    )
    SELECT
      (SELECT cpc FROM avg_cpc) AS avg_cpc,
      (SELECT max_fetch_date FROM last_zombie) AS last_zombie_date,
      (SELECT last_loaded_at FROM last_zombie) AS last_zombie_loaded,
      (SELECT last_import FROM last_order) AS last_order_import,
      (SELECT yest FROM dates) AS yest,
      (SELECT clicks FROM clicks_yest) AS clicks_yest,
      (SELECT n FROM orders_yest) AS orders_yest,
      (SELECT rev FROM orders_yest) AS rev_yest,
      (SELECT clicks FROM clicks_7day_avg) AS clicks_7day_avg,
      (SELECT n FROM orders_today) AS orders_today,
      (SELECT avg_orders FROM orders_dow_avg) AS orders_dow_avg_so_far
  `, [tenantId]);

  const cpc = Number(r.avg_cpc) || 0.27;
  const yest = r.yest;
  const clicksYest = Number(r.clicks_yest) || 0;
  const revYest = Number(r.rev_yest) || 0;
  const ordersYest = Number(r.orders_yest) || 0;
  const clicks7avg = Number(r.clicks_7day_avg) || 0;
  const ordersToday = Number(r.orders_today) || 0;
  const ordersDowAvg = Number(r.orders_dow_avg_so_far) || 0;
  const spendYest = clicksYest * cpc;

  // Freshness flags
  const zombieDate = r.last_zombie_date ? new Date(r.last_zombie_date) : null;
  const zombieCoversYest = zombieDate && zombieDate.toISOString().slice(0,10) >= new Date(yest).toISOString().slice(0,10);
  const orderImportAgeH = r.last_order_import ? (Date.now() - new Date(r.last_order_import).getTime()) / 3600000 : Infinity;

  return {
    cpc,
    yest,
    clicks_yest: clicksYest,
    revenue_yest: revYest,
    orders_yest: ordersYest,
    spend_yest: spendYest,
    spend_7day_avg: clicks7avg * cpc,
    spend_delta_pct: clicks7avg > 0 ? Math.round(((clicksYest - clicks7avg) / clicks7avg) * 100) : null,
    incidence_yest_pct: revYest > 0 ? +((spendYest / revYest) * 100).toFixed(1) : null,
    orders_today: ordersToday,
    orders_dow_avg_so_far: ordersDowAvg,
    orders_delta_pct: ordersDowAvg > 0 ? Math.round(((ordersToday - ordersDowAvg) / ordersDowAvg) * 100) : null,
    // Freshness
    zombie_covers_yest: zombieCoversYest,
    order_import_age_h: orderImportAgeH,
  };
}

async function checkAlerts(tenantName, m, th) {
  const alerts = [];
  const reasonsSkipped = [];

  // === ALERT A+B (incidenza, spesa anomala) richiedono ENTRAMBI freschi: ===
  //  - clicks_yest (zombie ha coperto fino a ieri) — gira alle ~03 UTC
  //  - rev_yest    (ordini di ieri tutti importati) — orderSync ogni 1h
  // Se uno dei due non è pronto, SKIP (no alert capocchia).
  const incidenceDataFresh =
    m.zombie_covers_yest === true &&
    m.order_import_age_h <= 6 &&
    m.clicks_yest >= th.min_clicks_for_check &&
    m.revenue_yest > 0;

  if (incidenceDataFresh) {
    if (m.incidence_yest_pct != null && m.incidence_yest_pct >= th.incidence_alert_pct) {
      alerts.push({
        type: 'incidence_high',
        severity: 'high',
        msg: `Incidenza ieri <b>${m.incidence_yest_pct}%</b> (soglia ${th.incidence_alert_pct}%). Spesa €${m.spend_yest.toFixed(0)} su €${m.revenue_yest.toFixed(0)} revenue (${m.orders_yest} ordini).`,
      });
    }
    if (m.spend_delta_pct != null && m.spend_delta_pct >= th.spend_anomaly_pct - 100 && m.spend_7day_avg > 5) {
      alerts.push({
        type: 'spend_anomaly',
        severity: 'medium',
        msg: `Spesa anomala ieri: €${m.spend_yest.toFixed(0)} vs €${m.spend_7day_avg.toFixed(0)} media 7g (+${m.spend_delta_pct}%).`,
      });
    }
  } else {
    if (!m.zombie_covers_yest) reasonsSkipped.push('zombie_clicks non copre ieri');
    if (m.order_import_age_h > 6) reasonsSkipped.push(`orderSync vecchio ${m.order_import_age_h.toFixed(1)}h`);
    if (m.clicks_yest < th.min_clicks_for_check) reasonsSkipped.push(`click ieri <${th.min_clicks_for_check}`);
    if (m.revenue_yest === 0) reasonsSkipped.push('revenue ieri = 0');
  }

  // === ALERT C (calo ordini today vs DOW): non richiede zombie, basta ===
  // che orderSync sia fresh (< 6h). Dato cumulativo crescente, confronto con
  // media DOW alla stessa ora del giorno è robusto.
  const ordersFresh = m.order_import_age_h <= 6;
  if (ordersFresh && m.orders_delta_pct != null && m.orders_delta_pct <= -th.orders_drop_pct
      && m.orders_dow_avg_so_far >= 3) {
    alerts.push({
      type: 'orders_drop',
      severity: 'high',
      msg: `Ordini in calo: <b>${m.orders_today}</b> oggi vs media stesso DOW <b>${m.orders_dow_avg_so_far.toFixed(1)}</b> (${m.orders_delta_pct}%).`,
    });
  }

  return { alerts, reasonsSkipped, incidenceDataFresh };
}

async function maybeAlert(tenantName, tenantId, alert) {
  const key = `${tenantId}|${alert.type}`;
  const last = lastAlertKey.get(key) || 0;
  if (Date.now() - last < ALERT_THROTTLE_MS) return false;
  const icon = alert.severity === 'high' ? '🔴' : '🟡';
  const text = `<b>${icon} ${tenantName}</b>\n${alert.msg}\n<i>xHumanPro SpendMonitor</i>`;
  const sent = await sendTelegram(text);
  if (sent) lastAlertKey.set(key, Date.now());
  return sent;
}

async function runCheck() {
  try {
    const th = await loadThresholds();
    const { rows: tenants } = await pool.query(`
      SELECT t.id, t.name FROM tenants t
      JOIN tenant_configs tc ON tc.tenant_id=t.id
      WHERE tc.config_key='xhumanpro_magento_mode' AND tc.config_value='operational'
        AND t.status='active' ORDER BY t.name
    `);

    const inGrace = Date.now() - _bootTime < BOOT_GRACE_MS;
    const summary = [];

    for (const t of tenants) {
      const m = await getTenantMetrics(t.id);
      const { alerts, reasonsSkipped, incidenceDataFresh } = await checkAlerts(t.name, m, th);

      const incLabel = incidenceDataFresh
        ? `inc-y${m.incidence_yest_pct}%`
        : `inc=skip(${reasonsSkipped.join(';') || 'no-data'})`;
      summary.push({
        tenant: t.name,
        spend_yest: Math.round(m.spend_yest || 0),
        incLabel,
        orders_today: m.orders_today,
        alerts_count: alerts.length,
      });

      for (const a of alerts) {
        if (inGrace) {
          console.log(`[SpendMonitor] ${t.name}: ${a.type} (grace period, no Telegram)`);
          continue;
        }
        await maybeAlert(t.name, t.id, a);
        console.warn(`[SpendMonitor] ${t.name} alert ${a.type}: ${a.msg.replace(/<[^>]+>/g,'')}`);
      }
    }

    console.log(`[SpendMonitor] Check complete: ${summary.map(s => `${s.tenant} €${s.spend_yest}y/${s.incLabel}/${s.orders_today}otd${s.alerts_count?'!':''}`).join(' | ')}`);
  } catch (err) {
    console.error('[SpendMonitor] Check error:', err.message);
  }
}

function startSpendMonitorCron() {
  console.log(`[SpendMonitor] Started (first check in 30s, then every ${CHECK_INTERVAL_MS/3600000}h)`);
  setTimeout(() => {
    runCheck().catch(e => console.error('[SpendMonitor] First-run error:', e.message));
    setInterval(runCheck, CHECK_INTERVAL_MS);
  }, 30 * 1000);
}

module.exports = { startSpendMonitorCron, runCheck };
