/**
 * Push Monitor — "Spinta Luglio" (direttiva utente 4/7/2026)
 *
 * "dobbiamo fare un luglio importante su tutti": scoreboard giornaliero
 * (08:15 italia) per ogni tenant — mese corrente vs passo del mese
 * precedente su fatturato/g, ordini/g, spesa TP/g (zombie x 0.3294),
 * incidenza. Solo giorni COMPLETI del mese corrente (ieri incluso, oggi no).
 * Telegram compatto + bandierina sui tenant in ritardo >15%.
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const CPC = 0.3294; // €0,27 + 22% IVA

async function runPushMonitor() {
  const { rows } = await pool.query(`
    WITH bounds AS (
      SELECT
        date_trunc('month', (NOW() AT TIME ZONE 'Europe/Rome'))::date AS cur_start,
        (NOW() AT TIME ZONE 'Europe/Rome')::date AS today,
        date_trunc('month', (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '1 month')::date AS prev_start,
        (date_trunc('month', (NOW() AT TIME ZONE 'Europe/Rome'))::date - 1) AS prev_end
    ),
    giorni AS (
      SELECT GREATEST((SELECT today - cur_start FROM bounds), 1) AS cur_days,
             ((SELECT prev_end - prev_start FROM bounds) + 1) AS prev_days
    ),
    ord AS (
      SELECT o.tenant_id,
        COUNT(DISTINCT o.id) FILTER (WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date >= (SELECT cur_start FROM bounds)
          AND (o.order_date AT TIME ZONE 'Europe/Rome')::date < (SELECT today FROM bounds)) AS ord_cur,
        SUM(oi.row_total_incl_tax) FILTER (WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date >= (SELECT cur_start FROM bounds)
          AND (o.order_date AT TIME ZONE 'Europe/Rome')::date < (SELECT today FROM bounds)) AS rev_cur,
        COUNT(DISTINCT o.id) FILTER (WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN (SELECT prev_start FROM bounds) AND (SELECT prev_end FROM bounds)) AS ord_prev,
        SUM(oi.row_total_incl_tax) FILTER (WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN (SELECT prev_start FROM bounds) AND (SELECT prev_end FROM bounds)) AS rev_prev
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_date >= (SELECT prev_start FROM bounds) - INTERVAL '1 day'
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY o.tenant_id
    ),
    ck AS (
      SELECT tenant_id,
        SUM(clicks) FILTER (WHERE fetch_date >= (SELECT cur_start FROM bounds)
          AND fetch_date < (SELECT today FROM bounds)) AS ck_cur,
        SUM(clicks) FILTER (WHERE fetch_date BETWEEN (SELECT prev_start FROM bounds) AND (SELECT prev_end FROM bounds)) AS ck_prev
      FROM zombie_clicks
      WHERE fetch_date >= (SELECT prev_start FROM bounds)
      GROUP BY tenant_id
    )
    SELECT t.name,
      ROUND(COALESCE(o.rev_cur, 0) / g.cur_days) AS rev_g_cur,
      ROUND(COALESCE(o.rev_prev, 0) / g.prev_days) AS rev_g_prev,
      ROUND(COALESCE(o.ord_cur, 0)::numeric / g.cur_days, 1) AS ord_g_cur,
      ROUND(COALESCE(o.ord_prev, 0)::numeric / g.prev_days, 1) AS ord_g_prev,
      ROUND(COALESCE(c.ck_cur, 0) * ${CPC} / g.cur_days) AS spesa_g_cur,
      ROUND(COALESCE(c.ck_prev, 0) * ${CPC} / g.prev_days) AS spesa_g_prev,
      ROUND(100.0 * COALESCE(c.ck_cur, 0) * ${CPC} / NULLIF(o.rev_cur, 0), 1) AS incid_cur
    FROM tenants t
    LEFT JOIN ord o ON o.tenant_id = t.id
    LEFT JOIN ck c ON c.tenant_id = t.id
    CROSS JOIN giorni g
    WHERE t.status = 'active'
    ORDER BY rev_g_cur DESC NULLS LAST`);

  const pct = (cur, prev) => {
    if (!prev || prev === 0) return null;
    return Math.round((cur - prev) / prev * 100);
  };
  const fmt = (v) => (v == null ? 'n/d' : (v >= 0 ? `+${v}%` : `${v}%`));

  let totRevCur = 0, totRevPrev = 0, totSpCur = 0, totSpPrev = 0, totOrdCur = 0, totOrdPrev = 0;
  const lines = [];
  const lagging = [];
  for (const r of rows) {
    const dRev = pct(parseFloat(r.rev_g_cur), parseFloat(r.rev_g_prev));
    const dSp = pct(parseFloat(r.spesa_g_cur), parseFloat(r.spesa_g_prev));
    totRevCur += parseFloat(r.rev_g_cur) || 0; totRevPrev += parseFloat(r.rev_g_prev) || 0;
    totSpCur += parseFloat(r.spesa_g_cur) || 0; totSpPrev += parseFloat(r.spesa_g_prev) || 0;
    totOrdCur += parseFloat(r.ord_g_cur) || 0; totOrdPrev += parseFloat(r.ord_g_prev) || 0;
    const flag = dRev != null && dRev < -15 ? ' 🔴' : (dRev != null && dRev < 0 ? ' 🟡' : ' ✅');
    lines.push(`${r.name}: €${r.rev_g_cur}/g (${fmt(dRev)}) | ${r.ord_g_cur} ord/g | spesa €${r.spesa_g_cur}/g (${fmt(dSp)}) | inc ${r.incid_cur || 0}%${flag}`);
    if (dRev != null && dRev < -15) lagging.push(r.name);
  }

  const meseNome = new Date().toLocaleString('it-IT', { month: 'long', timeZone: 'Europe/Rome' });
  let msg = `🚀 <b>SPINTA ${meseNome.toUpperCase()}</b>\n`;
  msg += `<b>RETE</b>: €${Math.round(totRevCur)}/g vs €${Math.round(totRevPrev)}/g (${fmt(pct(totRevCur, totRevPrev))}) | `;
  msg += `${Math.round(totOrdCur)} ord/g (${fmt(pct(totOrdCur, totOrdPrev))}) | `;
  msg += `spesa €${Math.round(totSpCur)}/g (${fmt(pct(totSpCur, totSpPrev))})\n\n`;
  msg += lines.join('\n');
  if (lagging.length) msg += `\n\n⚠️ In ritardo >15%: ${lagging.join(', ')}`;

  try { await sendTelegram(msg, { key: 'push_monitor', parseMode: 'HTML', throttleMs: 12 * 3600 * 1000 }); } catch {}
  console.log('[PushMonitor] scoreboard inviato:', lines.length, 'tenant, lagging:', lagging.join(',') || 'nessuno');
  return { lines, lagging };
}

let cronStarted = false;

function startPushMonitor() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    // 06:15 UTC = 08:15 italia (estate)
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 15, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try { await runPushMonitor(); } catch (e) { console.error('[PushMonitor] err:', e.message); }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[PushMonitor] Cron started — giornaliero 06:15 UTC (08:15 italia)');
}

module.exports = { runPushMonitor, startPushMonitor };
