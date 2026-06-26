/**
 * Weekend Learning Engine
 * Snapshot baseline pre-weekend → analisi post-weekend per capire QUALI SKU
 * hanno generato vendite e PERCHÉ (pattern brand/prezzo/margine/click history).
 *
 * Lunedì sera 23:00 italia (21:00 UTC):
 *   1. Aggiorna click/cost/ord/revenue del weekend per gli SKU snapshot
 *   2. Calcola pattern e manda telegram report
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const SNAPSHOT_DATE = '2026-06-26';
const WEEKEND_START = '2026-06-27';
const WEEKEND_END = '2026-06-29';

async function updatePostWeekendMetrics(snapshotDate = SNAPSHOT_DATE,
                                         weekendStart = WEEKEND_START,
                                         weekendEnd = WEEKEND_END) {
  console.log(`[WeekendLearning] Aggiorno metriche ${weekendStart} → ${weekendEnd}`);

  await pool.query(`
    UPDATE weekend_learning wl
    SET click_weekend = COALESCE(ft.click_tot, 0),
        cost_weekend = COALESCE(ft.cost_tot, 0)
    FROM (
      SELECT sku, tenant_id, SUM(clicks) AS click_tot, SUM(click_cost) AS cost_tot
      FROM feed_daily_tracking
      WHERE track_date BETWEEN $2 AND $3
      GROUP BY sku, tenant_id
    ) ft
    WHERE wl.snapshot_date = $1 AND wl.sku = ft.sku AND wl.tenant_id = ft.tenant_id
  `, [snapshotDate, weekendStart, weekendEnd]);

  await pool.query(`
    UPDATE weekend_learning wl
    SET ord_weekend = COALESCE(o.ord_tot, 0),
        revenue_weekend = COALESCE(o.rev_tot, 0),
        generated_sale = COALESCE(o.ord_tot, 0) > 0
    FROM (
      SELECT oi.sku, o.tenant_id,
             COUNT(DISTINCT o.id) AS ord_tot,
             SUM(oi.row_total) AS rev_tot
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_status NOT IN ('canceled','closed','pending_payment')
        AND o.order_date::date BETWEEN $2 AND $3
      GROUP BY oi.sku, o.tenant_id
    ) o
    WHERE wl.snapshot_date = $1 AND wl.sku = o.sku AND wl.tenant_id = o.tenant_id
  `, [snapshotDate, weekendStart, weekendEnd]);

  await pool.query(`
    UPDATE weekend_learning SET generated_sale = false
    WHERE snapshot_date = $1 AND generated_sale IS NULL
  `, [snapshotDate]);
}

async function generateLearningReport(snapshotDate = SNAPSHOT_DATE) {
  // KPI globali
  const { rows: [kpi] } = await pool.query(`
    SELECT
      COUNT(*) AS sku_tot,
      COUNT(*) FILTER (WHERE generated_sale) AS sku_venduti,
      SUM(click_weekend) AS click_tot,
      SUM(cost_weekend) AS cost_tot,
      SUM(ord_weekend) AS ord_tot,
      SUM(revenue_weekend) AS rev_tot
    FROM weekend_learning WHERE snapshot_date=$1
  `, [snapshotDate]);

  // Conversion rate per range margine
  const { rows: byMargin } = await pool.query(`
    SELECT
      CASE
        WHEN margin_pct < 10 THEN '<10%'
        WHEN margin_pct < 15 THEN '10-15%'
        WHEN margin_pct < 20 THEN '15-20%'
        WHEN margin_pct < 25 THEN '20-25%'
        ELSE '>25%'
      END AS bucket_mrg,
      COUNT(*) AS sku_tot,
      COUNT(*) FILTER (WHERE generated_sale) AS sku_venduti,
      ROUND(100.0 * COUNT(*) FILTER (WHERE generated_sale) / NULLIF(COUNT(*),0), 1) AS conv_pct
    FROM weekend_learning WHERE snapshot_date=$1 AND click_weekend > 0
    GROUP BY 1 ORDER BY 1
  `, [snapshotDate]);

  // Conversion rate per range prezzo
  const { rows: byPrice } = await pool.query(`
    SELECT
      CASE
        WHEN sell_price < 10 THEN '<10€'
        WHEN sell_price < 30 THEN '10-30€'
        WHEN sell_price < 50 THEN '30-50€'
        WHEN sell_price < 100 THEN '50-100€'
        ELSE '>100€'
      END AS bucket_prz,
      COUNT(*) AS sku_tot,
      COUNT(*) FILTER (WHERE generated_sale) AS sku_venduti,
      ROUND(100.0 * COUNT(*) FILTER (WHERE generated_sale) / NULLIF(COUNT(*),0), 1) AS conv_pct
    FROM weekend_learning WHERE snapshot_date=$1 AND click_weekend > 0
    GROUP BY 1 ORDER BY MIN(sell_price)
  `, [snapshotDate]);

  // Top 10 brand per ordini generati
  const { rows: topBrand } = await pool.query(`
    SELECT brand,
      COUNT(*) FILTER (WHERE generated_sale) AS sku_venduti,
      SUM(ord_weekend) AS ord_tot,
      SUM(revenue_weekend) AS rev_tot
    FROM weekend_learning WHERE snapshot_date=$1 AND brand IS NOT NULL AND brand != ''
    GROUP BY brand HAVING SUM(ord_weekend) > 0
    ORDER BY SUM(revenue_weekend) DESC LIMIT 10
  `, [snapshotDate]);

  // SKU "sorpresa": 0 click 30g → vende nel weekend
  const { rows: sorprese } = await pool.query(`
    SELECT sku, product_name, brand, tenant_name, ord_weekend, revenue_weekend
    FROM weekend_learning
    WHERE snapshot_date=$1 AND click_30d_baseline=0 AND ord_weekend > 0
    ORDER BY revenue_weekend DESC LIMIT 10
  `, [snapshotDate]);

  // SKU "delusione": tanti click 30g → 0 vendite nel weekend
  const { rows: delusioni } = await pool.query(`
    SELECT sku, product_name, brand, tenant_name, click_weekend, cost_weekend
    FROM weekend_learning
    WHERE snapshot_date=$1 AND click_weekend > 10 AND ord_weekend = 0
    ORDER BY cost_weekend DESC LIMIT 10
  `, [snapshotDate]);

  return { kpi, byMargin, byPrice, topBrand, sorprese, delusioni };
}

async function runWeekendAnalysis() {
  try {
    await updatePostWeekendMetrics();
    const report = await generateLearningReport();

    const k = report.kpi;
    const incid = k.cost_tot > 0 ? (k.cost_tot / k.rev_tot * 100).toFixed(1) : 'n/a';
    const convPct = k.sku_tot > 0 ? (k.sku_venduti / k.sku_tot * 100).toFixed(1) : 0;

    let msg = `📊 *Weekend Learning Report*\n`;
    msg += `Periodo: 27-29/6 (Papa + Procaccini)\n\n`;
    msg += `*KPI Globali*\n`;
    msg += `• SKU snapshot: ${k.sku_tot}\n`;
    msg += `• SKU che hanno venduto: ${k.sku_venduti} (${convPct}%)\n`;
    msg += `• Click totali: ${k.click_tot}\n`;
    msg += `• Costo TP: €${Math.round(k.cost_tot)}\n`;
    msg += `• Ordini: ${k.ord_tot}\n`;
    msg += `• Revenue: €${Math.round(k.rev_tot)}\n`;
    msg += `• Incidenza: ${incid}%\n\n`;

    msg += `*Conversion per margine*\n`;
    for (const r of report.byMargin) {
      msg += `• ${r.bucket_mrg}: ${r.conv_pct}% (${r.sku_venduti}/${r.sku_tot})\n`;
    }
    msg += `\n*Conversion per prezzo*\n`;
    for (const r of report.byPrice) {
      msg += `• ${r.bucket_prz}: ${r.conv_pct}% (${r.sku_venduti}/${r.sku_tot})\n`;
    }

    msg += `\n*Top 5 brand (revenue)*\n`;
    for (const r of report.topBrand.slice(0, 5)) {
      msg += `• ${r.brand}: ${r.ord_tot}ord, €${Math.round(r.rev_tot)}\n`;
    }

    msg += `\n*Top 5 sorprese* (0 click 30g → venduti)\n`;
    for (const r of report.sorprese.slice(0, 5)) {
      msg += `• ${r.sku} ${r.product_name?.slice(0,30)}: ${r.ord_weekend}ord €${Math.round(r.revenue_weekend)}\n`;
    }

    msg += `\n*Top 5 delusioni* (>10 click → 0 vendite)\n`;
    for (const r of report.delusioni.slice(0, 5)) {
      msg += `• ${r.sku} ${r.product_name?.slice(0,30)}: ${r.click_weekend}click €${Math.round(r.cost_weekend)} sprecati\n`;
    }

    console.log('[WeekendLearning] Report generato:\n' + msg);
    try { await sendTelegram(msg, { key: 'weekend_learning', parseMode: 'Markdown' }); } catch (e) { console.error('telegram err', e.message); }

    return report;
  } catch (e) {
    console.error('[WeekendLearning] error:', e.message);
    throw e;
  }
}

let cronStarted = false;
function startWeekendLearningCron() {
  if (cronStarted) return;
  cronStarted = true;

  // Lunedì 30/6 alle 21:00 UTC (= 23:00 Italia)
  const fire = new Date(Date.UTC(2026, 5, 30, 21, 0, 0));
  const ms = fire.getTime() - Date.now();
  if (ms > 0) {
    setTimeout(() => runWeekendAnalysis(), ms);
    console.log(`[WeekendLearning] Cron scheduled per lunedì 30/6 23:00 italia (in ${Math.round(ms/3600000)}h)`);
  } else {
    console.log('[WeekendLearning] Lunedì 30/6 23:00 già passato, skip');
  }
}

module.exports = {
  updatePostWeekendMetrics,
  generateLearningReport,
  runWeekendAnalysis,
  startWeekendLearningCron,
};
