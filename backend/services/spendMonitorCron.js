/**
 * Spend Monitor Cron — guardiano economico del feed TP.
 *
 * Ogni 3 ore controlla per ciascun tenant operational:
 *  - spesa TP cumulativa del giorno (zombie_clicks × avg_cpc)
 *  - incidenza giornaliera = spesa / revenue store del giorno
 *  - delta spesa vs media stessa fascia oraria settimana precedente
 *  - delta ordini vs media stesso giorno settimana
 *
 * Se una soglia di anomalia è superata, invia alert Telegram con dedup 4h
 * per (tenant, alert_type). Log strutturati in log_events (source='spendMonitor').
 *
 * Soglie (configurabili in global_config.spend_monitor_thresholds JSON):
 *  - incidence_alert_pct:   8.0   (cap 6.5% + buffer)
 *  - spend_anomaly_pct:    150    (spesa today > +50% media 7g)
 *  - orders_drop_pct:       40    (ordini today < -40% media DOW)
 *  - min_clicks_for_check:  20    (sotto questa soglia ignoriamo, dato rumoroso)
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
  // Tutti i numeri in Europe/Rome day boundaries
  const { rows: [r] } = await pool.query(`
    WITH dates AS (
      SELECT
        (NOW() AT TIME ZONE 'Europe/Rome')::date AS today,
        ((NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '7 days')::date AS last7_start,
        ((NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '1 day')::date AS yest,
        EXTRACT(DOW FROM (NOW() AT TIME ZONE 'Europe/Rome'))::int AS today_dow
    ),
    avg_cpc AS (
      SELECT COALESCE(NULLIF(config_value, '')::numeric, 0.27) AS cpc
      FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc'
      UNION ALL SELECT 0.27 LIMIT 1
    ),
    spend_today AS (
      SELECT COALESCE(SUM(clicks), 0)::int AS clicks
      FROM zombie_clicks WHERE tenant_id=$1 AND fetch_date=(SELECT today FROM dates)
    ),
    spend_yest AS (
      SELECT COALESCE(SUM(clicks), 0)::int AS clicks
      FROM zombie_clicks WHERE tenant_id=$1 AND fetch_date=(SELECT yest FROM dates)
    ),
    spend_7day_avg AS (
      SELECT AVG(daily_clicks) AS clicks
      FROM (
        SELECT SUM(clicks) AS daily_clicks
        FROM zombie_clicks
        WHERE tenant_id=$1 AND fetch_date BETWEEN (SELECT last7_start FROM dates) AND (SELECT yest FROM dates)
        GROUP BY fetch_date
      ) s
    ),
    orders_today AS (
      SELECT COUNT(*) AS n, COALESCE(SUM(grand_total_products), 0) AS rev
      FROM orders WHERE tenant_id=$1
        AND (order_date AT TIME ZONE 'Europe/Rome')::date = (SELECT today FROM dates)
        AND order_status NOT IN ('canceled','closed')
    ),
    orders_dow_avg AS (
      SELECT AVG(daily_n) AS avg_orders
      FROM (
        SELECT COUNT(*) AS daily_n
        FROM orders WHERE tenant_id=$1
          AND order_date AT TIME ZONE 'Europe/Rome' >= NOW() - INTERVAL '28 days'
          AND (order_date AT TIME ZONE 'Europe/Rome')::date < (SELECT today FROM dates)
          AND EXTRACT(DOW FROM (order_date AT TIME ZONE 'Europe/Rome')) = (SELECT today_dow FROM dates)
          AND order_status NOT IN ('canceled','closed')
        GROUP BY (order_date AT TIME ZONE 'Europe/Rome')::date
      ) s
    )
    SELECT
      (SELECT cpc FROM avg_cpc) AS avg_cpc,
      (SELECT clicks FROM spend_today) AS clicks_today,
      (SELECT clicks FROM spend_yest) AS clicks_yest,
      (SELECT clicks FROM spend_7day_avg) AS clicks_7day_avg,
      (SELECT n FROM orders_today) AS orders_today,
      (SELECT rev FROM orders_today) AS rev_today,
      (SELECT avg_orders FROM orders_dow_avg) AS orders_dow_avg
  `, [tenantId]);

  const cpc = Number(r.avg_cpc) || 0.27;
  const clicksToday = Number(r.clicks_today) || 0;
  const clicks7avg = Number(r.clicks_7day_avg) || 0;
  const ordersToday = Number(r.orders_today) || 0;
  const ordersDowAvg = Number(r.orders_dow_avg) || 0;
  const revToday = Number(r.rev_today) || 0;

  return {
    cpc,
    clicks_today: clicksToday,
    clicks_7day_avg: clicks7avg,
    spend_today: clicksToday * cpc,
    spend_7day_avg: clicks7avg * cpc,
    spend_delta_pct: clicks7avg > 0 ? Math.round(((clicksToday - clicks7avg) / clicks7avg) * 100) : null,
    orders_today: ordersToday,
    orders_dow_avg: ordersDowAvg,
    orders_delta_pct: ordersDowAvg > 0 ? Math.round(((ordersToday - ordersDowAvg) / ordersDowAvg) * 100) : null,
    revenue_today: revToday,
    incidence_pct: revToday > 0 ? +(((clicksToday * cpc) / revToday) * 100).toFixed(1) : null,
  };
}

async function checkAlerts(tenantName, m, th) {
  const alerts = [];

  // Skip se traffico TP troppo basso (dato rumoroso)
  if (m.clicks_today < th.min_clicks_for_check) return alerts;

  // ALERT A: incidenza giornaliera sopra soglia
  if (m.incidence_pct != null && m.incidence_pct >= th.incidence_alert_pct) {
    alerts.push({
      type: 'incidence_high',
      severity: 'high',
      msg: `Incidenza giornaliera <b>${m.incidence_pct}%</b> (soglia ${th.incidence_alert_pct}%). Spesa €${m.spend_today.toFixed(0)} su €${m.revenue_today.toFixed(0)} revenue.`,
    });
  }

  // ALERT B: spesa anomala (today >> 7d avg)
  if (m.spend_delta_pct != null && m.spend_delta_pct >= th.spend_anomaly_pct - 100) {
    alerts.push({
      type: 'spend_anomaly',
      severity: 'medium',
      msg: `Spesa anomala: €${m.spend_today.toFixed(0)} oggi vs €${m.spend_7day_avg.toFixed(0)} media 7g (+${m.spend_delta_pct}%).`,
    });
  }

  // ALERT C: calo ordini drammatico vs DOW
  if (m.orders_delta_pct != null && m.orders_delta_pct <= -th.orders_drop_pct && m.orders_dow_avg >= 3) {
    alerts.push({
      type: 'orders_drop',
      severity: 'high',
      msg: `Ordini in calo: <b>${m.orders_today}</b> oggi vs <b>${m.orders_dow_avg.toFixed(1)}</b> media stesso giorno (${m.orders_delta_pct}%).`,
    });
  }

  return alerts;
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
      const alerts = await checkAlerts(t.name, m, th);
      summary.push({
        tenant: t.name,
        spend: Math.round(m.spend_today),
        incidence_pct: m.incidence_pct,
        orders: m.orders_today,
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

    console.log(`[SpendMonitor] Check complete: ${summary.map(s => `${s.tenant} €${s.spend}/inc${s.incidence_pct||'-'}/${s.orders}ord${s.alerts_count?'!':''}`).join(' | ')}`);
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
