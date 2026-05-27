/**
 * Supervisor Fast Path — SQL-only health checks per tenant.
 * Output: array di signal {key, severity, evidence}.
 * Severity: 'green' (tutto ok), 'yellow' (anomalia da osservare), 'red' (intervento richiesto).
 *
 * Slow path LLM viene triggerato solo se almeno un signal e' yellow o red.
 */

const { pool } = require('../db/pool');

// ─── 1. CRON LOOP FRESHNESS ─────────────────────────────
async function checkCronFreshness(tenantId) {
  const results = [];

  // Zombie: usa zombie_runs.completed_at (qualsiasi status), NON zombie_clicks.fetch_date.
  // Quando il budget TP e' esaurito il cron gira ma torna 'no_data' — non e' un guasto.
  const { rows: [zr] } = await pool.query(`
    SELECT MAX(completed_at) AS last_at,
           (array_agg(status ORDER BY completed_at DESC NULLS LAST))[1] AS last_status
    FROM zombie_runs WHERE tenant_id = $1
  `, [tenantId]);
  if (!zr?.last_at) {
    results.push({ key: 'cron_zombie_missing', severity: 'red', evidence: { table: 'zombie_runs', last_at: null } });
  } else {
    const ageHours = (Date.now() - new Date(zr.last_at).getTime()) / (1000 * 3600);
    const ev = { table: 'zombie_runs', age_hours: Math.round(ageHours), last_status: zr.last_status };
    if (ageHours > 36) results.push({ key: 'cron_zombie_stale', severity: 'red', evidence: ev });
    else if (ageHours > 26) results.push({ key: 'cron_zombie_slow', severity: 'yellow', evidence: ev });
    else if (zr.last_status === 'no_data') results.push({ key: 'cron_zombie_no_data', severity: 'yellow', evidence: { ...ev, msg: 'TP budget esaurito o seller sospeso (cron OK, dato assente)' } });
    else results.push({ key: 'cron_zombie_ok', severity: 'green', evidence: ev });
  }

  // Altri loop standard
  const checks = [
    { name: 'orders', sql: `SELECT MAX(order_date) AS last_at FROM orders WHERE tenant_id = $1`, expectedHours: 6 },
    { name: 'products_sync', sql: `SELECT MAX(updated_at) AS last_at FROM products WHERE tenant_id = $1`, expectedHours: 24 },
    { name: 'feed_daily_summary', sql: `SELECT MAX(summary_date) AS last_at FROM feed_daily_summary WHERE tenant_id = $1`, expectedHours: 30 },
  ];
  for (const c of checks) {
    const { rows } = await pool.query(c.sql, [tenantId]);
    const lastAt = rows[0]?.last_at;
    if (!lastAt) {
      results.push({ key: `cron_${c.name}_missing`, severity: 'red', evidence: { table: c.name, last_at: null } });
      continue;
    }
    const ageHours = (Date.now() - new Date(lastAt).getTime()) / (1000 * 3600);
    if (ageHours > c.expectedHours * 2) {
      results.push({ key: `cron_${c.name}_stale`, severity: 'red', evidence: { table: c.name, age_hours: Math.round(ageHours), expected_hours: c.expectedHours } });
    } else if (ageHours > c.expectedHours) {
      results.push({ key: `cron_${c.name}_slow`, severity: 'yellow', evidence: { table: c.name, age_hours: Math.round(ageHours), expected_hours: c.expectedHours } });
    } else {
      results.push({ key: `cron_${c.name}_ok`, severity: 'green', evidence: { table: c.name, age_hours: Math.round(ageHours) } });
    }
  }
  return results;
}

// ─── 2. KPI ANOMALY (vs baseline ultime 4 settimane stesso giorno settimana) ──
async function checkKpiAnomaly(tenantId) {
  const { rows } = await pool.query(`
    WITH active AS (
      SELECT fetch_date d, SUM(clicks) clicks
      FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 35
      GROUP BY 1
    ),
    store AS (
      SELECT order_date::date d,
             COUNT(*) ords,
             SUM(grand_total_products) rev
      FROM orders
      WHERE tenant_id = $1
        AND order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND order_date::date >= CURRENT_DATE - 35
      GROUP BY 1
    ),
    j AS (SELECT a.d, a.clicks, COALESCE(s.ords,0) ords, COALESCE(s.rev,0) rev FROM active a LEFT JOIN store s USING(d)),
    yest AS (SELECT * FROM j WHERE d = CURRENT_DATE - 1),
    baseline AS (SELECT * FROM j WHERE d BETWEEN CURRENT_DATE - 35 AND CURRENT_DATE - 8 AND EXTRACT(isodow FROM d) = EXTRACT(isodow FROM (CURRENT_DATE - 1)))
    SELECT
      (SELECT clicks FROM yest) AS yest_clicks,
      (SELECT ords FROM yest) AS yest_ords,
      (SELECT rev FROM yest) AS yest_rev,
      (SELECT AVG(clicks) FROM baseline) AS base_clicks,
      (SELECT AVG(ords) FROM baseline) AS base_ords,
      (SELECT AVG(rev) FROM baseline) AS base_rev,
      (SELECT STDDEV_SAMP(rev) FROM baseline) AS std_rev
  `, [tenantId]);
  const r = rows[0];
  const out = [];
  if (!r || r.yest_clicks === null) {
    out.push({ key: 'kpi_no_yesterday_data', severity: 'yellow', evidence: { msg: 'No click data for yesterday' } });
    return out;
  }
  // Revenue anomaly z-score
  const baseRev = parseFloat(r.base_rev) || 0;
  const stdRev = parseFloat(r.std_rev) || 0;
  const yestRev = parseFloat(r.yest_rev) || 0;
  if (baseRev > 0 && stdRev > 0) {
    const z = (yestRev - baseRev) / stdRev;
    if (z < -2.5) out.push({ key: 'kpi_revenue_drop', severity: 'red', evidence: { yest: yestRev, baseline_avg: baseRev.toFixed(2), zscore: z.toFixed(2) } });
    else if (z < -1.5) out.push({ key: 'kpi_revenue_low', severity: 'yellow', evidence: { yest: yestRev, baseline_avg: baseRev.toFixed(2), zscore: z.toFixed(2) } });
  }
  // Click anomaly
  const baseClicks = parseFloat(r.base_clicks) || 0;
  const yestClicks = parseInt(r.yest_clicks) || 0;
  if (baseClicks > 0) {
    const ratio = yestClicks / baseClicks;
    if (ratio < 0.4) out.push({ key: 'kpi_clicks_drop', severity: 'red', evidence: { yest: yestClicks, baseline_avg: Math.round(baseClicks), ratio: ratio.toFixed(2) } });
    else if (ratio < 0.7) out.push({ key: 'kpi_clicks_low', severity: 'yellow', evidence: { yest: yestClicks, baseline_avg: Math.round(baseClicks), ratio: ratio.toFixed(2) } });
  }
  return out;
}

// ─── 3. BUDGET PACING (mese in corso vs target lineare) ─────────
async function checkBudgetPacing(tenantId) {
  const { rows: [cfg] } = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id=$1 AND config_key='feed_monthly_budget'`,
    [tenantId]
  );
  const monthlyBudget = parseFloat(cfg?.config_value || 3000);
  const { rows: [s] } = await pool.query(`
    SELECT SUM(clicks) AS clicks_mtd, COUNT(DISTINCT fetch_date) AS days_active
    FROM zombie_clicks
    WHERE tenant_id = $1 AND fetch_date >= date_trunc('month', CURRENT_DATE)
  `, [tenantId]);
  const { rows: [cpcRow] } = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id=$1 AND config_key='avg_tp_cpc'`,
    [tenantId]
  );
  const cpc = parseFloat(cpcRow?.config_value || 0.27);
  const spent = (parseInt(s?.clicks_mtd) || 0) * cpc;
  const today = new Date();
  const dayOfMonth = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const linearTarget = monthlyBudget * (dayOfMonth / daysInMonth);
  const pacePct = linearTarget > 0 ? (spent / linearTarget) * 100 : 0;
  const evidence = { spent_mtd: spent.toFixed(2), monthly_budget: monthlyBudget, linear_target: linearTarget.toFixed(2), pace_pct: pacePct.toFixed(0), day_of_month: dayOfMonth, days_in_month: daysInMonth };
  if (pacePct >= 130) return [{ key: 'budget_overpacing', severity: 'red', evidence }];
  if (pacePct >= 110) return [{ key: 'budget_overpacing_soft', severity: 'yellow', evidence }];
  if (pacePct < 50 && dayOfMonth >= 10) return [{ key: 'budget_underpacing', severity: 'yellow', evidence }];
  return [{ key: 'budget_pacing_ok', severity: 'green', evidence }];
}

// ─── 4. DATA HEALTH (campi prodotto popolati, GA4 freshness, ecc.) ────
// Nota: i prodotti senza prezzo/margine vengono valutati SOLO sul subset "vendibile"
// (con stock > 0). I prodotti fuori catalogo / senza stock spesso hanno sell_price=0
// per design e producevano falsi positivi.
async function checkDataHealth(tenantId) {
  const out = [];
  // Conta solo prodotti EFFETTIVAMENTE esportati a TP:
  // - hanno stock (erp o supplier > 0)
  // - export_status != '0' (status 0 = non esportato per design, no prezzo lecito)
  const { rows: [p] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE
        (COALESCE(erp_stock,0) > 0 OR COALESCE(supplier_stock,0) > 0)
        AND COALESCE(raw_data->>'export_status', '') != '0'
      ) AS sellable,
      COUNT(*) FILTER (WHERE
        (COALESCE(erp_stock,0) > 0 OR COALESCE(supplier_stock,0) > 0)
        AND COALESCE(raw_data->>'export_status', '') != '0'
        AND (sell_price = 0 OR sell_price IS NULL)
      ) AS no_price,
      COUNT(*) FILTER (WHERE
        (COALESCE(erp_stock,0) > 0 OR COALESCE(supplier_stock,0) > 0)
        AND COALESCE(raw_data->>'export_status', '') != '0'
        AND (margin_pct = 0 OR margin_pct IS NULL)
      ) AS no_margin
    FROM products WHERE tenant_id = $1
  `, [tenantId]);
  const sellable = parseInt(p.sellable) || 0;
  if (sellable > 0) {
    const noPricePct = (parseInt(p.no_price) / sellable) * 100;
    const noMarginPct = (parseInt(p.no_margin) / sellable) * 100;
    const ev = { sellable_total: sellable, no_price: parseInt(p.no_price), no_price_pct: noPricePct.toFixed(1), no_margin: parseInt(p.no_margin), no_margin_pct: noMarginPct.toFixed(1), scope: 'sellable_exported_only (stock>0 AND export_status!=0)' };
    if (noPricePct > 30 || noMarginPct > 30) out.push({ key: 'data_health_products_critical', severity: 'red', evidence: ev });
    else if (noPricePct > 10 || noMarginPct > 10) out.push({ key: 'data_health_products_warn', severity: 'yellow', evidence: ev });
    else out.push({ key: 'data_health_products_ok', severity: 'green', evidence: ev });
  } else {
    out.push({ key: 'data_health_no_sellable_products', severity: 'yellow', evidence: { msg: 'tenant has 0 sellable products' } });
  }
  // GA4 freshness via product_health_scores.updated_at (post migration 017)
  const { rows: [g] } = await pool.query(`
    SELECT MAX(updated_at) AS last FROM product_health_scores WHERE tenant_id = $1
  `, [tenantId]);
  if (g.last) {
    const ageHours = (Date.now() - new Date(g.last).getTime()) / (1000 * 3600);
    if (ageHours > 72) out.push({ key: 'data_health_ga4_stale', severity: 'red', evidence: { age_hours: Math.round(ageHours) } });
    else if (ageHours > 36) out.push({ key: 'data_health_ga4_slow', severity: 'yellow', evidence: { age_hours: Math.round(ageHours) } });
  } else {
    out.push({ key: 'data_health_ga4_never', severity: 'red', evidence: { msg: 'no product_health_scores rows' } });
  }
  return out;
}

// ─── 5. FEED ENGINE EFFECTIVENESS (ultima esecuzione + savings reali) ──
async function checkFeedEngineEffectiveness(tenantId) {
  const out = [];
  const { rows } = await pool.query(`
    SELECT
      MAX(action_date) AS last_action,
      COUNT(*) FILTER (WHERE action_date >= NOW() - INTERVAL '24 hours') AS actions_24h,
      COUNT(*) FILTER (WHERE action_date >= NOW() - INTERVAL '24 hours' AND action_type = 'feed_engine') AS feed_runs_24h
    FROM optimization_log WHERE tenant_id = $1
  `, [tenantId]);
  const lastAction = rows[0]?.last_action;
  const runs24h = parseInt(rows[0]?.feed_runs_24h) || 0;
  if (!lastAction) {
    out.push({ key: 'feed_engine_never_ran', severity: 'red', evidence: { msg: 'no optimization_log entries' } });
  } else {
    const ageHours = (Date.now() - new Date(lastAction).getTime()) / (1000 * 3600);
    if (ageHours > 6) out.push({ key: 'feed_engine_stale', severity: 'red', evidence: { age_hours: Math.round(ageHours), runs_24h: runs24h } });
    else if (runs24h < 4) out.push({ key: 'feed_engine_low_freq', severity: 'yellow', evidence: { age_hours: Math.round(ageHours), runs_24h: runs24h } });
  }
  return out;
}

// ─── 5b. MASS QUARANTINE GUARD ──────────────────
// Flag se in un singolo giorno > 5% del catalogo TP attivo e' stato quarantinato.
// Difesa contro il "breadth penalty" di TP osservato su Farmacri 15/4/2026.
async function checkMassQuarantine(tenantId) {
  const { rows } = await pool.query(`
    WITH q24 AS (
      SELECT quarantine_start::date d, COUNT(*) AS n
      FROM feed_quarantine
      WHERE tenant_id = $1 AND quarantine_start >= NOW() - INTERVAL '7 days'
      GROUP BY 1
    ),
    catalog AS (
      SELECT COUNT(DISTINCT product_code) AS active_skus
      FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date >= CURRENT_DATE - 14
    )
    SELECT q24.d::text d, q24.n,
           catalog.active_skus,
           ROUND(q24.n::numeric / NULLIF(catalog.active_skus, 0) * 100, 1) AS pct
    FROM q24, catalog
    WHERE q24.n > GREATEST(50, catalog.active_skus * 0.05)
    ORDER BY q24.d DESC LIMIT 5
  `, [tenantId]);
  if (rows.length === 0) return [{ key: 'mass_quarantine_ok', severity: 'green', evidence: { msg: 'no mass quarantine events in last 7d' } }];
  const worst = rows[0];
  const evidence = { date: worst.d, quarantined: parseInt(worst.n), active_catalog: parseInt(worst.active_skus), pct: parseFloat(worst.pct), other_events: rows.slice(1) };
  return [{ key: 'mass_quarantine_breadth_penalty_risk', severity: 'red', evidence }];
}

// ─── 6. ACTION FOLLOW-UP (REMOVE non efficaci) ────
async function checkActionFollowups(tenantId) {
  const { rows: [r] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE outcome = 'effective') AS effective,
      COUNT(*) FILTER (WHERE outcome = 'noop') AS noop,
      COUNT(*) FILTER (WHERE outcome = 'reverted') AS reverted,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) AS total_evaluated
    FROM supervisor_action_followups
    WHERE tenant_id = $1 AND evaluated_at >= NOW() - INTERVAL '14 days'
  `, [tenantId]);
  const total = parseInt(r.total_evaluated) || 0;
  if (total < 10) return []; // troppo pochi dati
  const noopPct = (parseInt(r.noop) / total) * 100;
  const revertedPct = (parseInt(r.reverted) / total) * 100;
  const ev = { total, effective: parseInt(r.effective), noop: parseInt(r.noop), reverted: parseInt(r.reverted), noop_pct: noopPct.toFixed(0), reverted_pct: revertedPct.toFixed(0) };
  if (noopPct > 50) return [{ key: 'actions_mostly_noop', severity: 'red', evidence: ev }];
  if (revertedPct > 30) return [{ key: 'actions_mostly_reverted', severity: 'yellow', evidence: ev }];
  return [{ key: 'actions_effectiveness_ok', severity: 'green', evidence: ev }];
}

// Verifica se il tenant usa il feed gestito da xHumanPro. Se no, i check
// relativi al feed (feedEngine, mass quarantine, budget pacing, action followups)
// sono irrilevanti — il nostro sistema non controlla quel feed. Resta utile
// monitorare solo i check di salute dati/cron/kpi.
async function isFeedManaged(tenantId) {
  const { rows } = await pool.query(
    `SELECT config_value FROM health_config WHERE tenant_id=$1 AND config_key='feed_managed' LIMIT 1`,
    [tenantId]
  );
  // Default: true (assume gestito se config mancante per retrocompatibilita')
  return rows[0]?.config_value !== 'false';
}

// ─── ENTRY POINT ────────────────────────────────────────
async function runFastPath(tenantId) {
  const feedManaged = await isFeedManaged(tenantId);
  const baseChecks = [
    checkCronFreshness(tenantId),
    checkKpiAnomaly(tenantId),
    checkDataHealth(tenantId),
  ];
  const feedChecks = feedManaged ? [
    checkBudgetPacing(tenantId),
    checkFeedEngineEffectiveness(tenantId),
    checkMassQuarantine(tenantId),
    checkActionFollowups(tenantId),
  ] : [
    Promise.resolve([{
      key: 'feed_unmanaged',
      severity: 'green',
      evidence: { msg: 'Tenant non usa il feed gestito da xHumanPro: check feed/quarantine/budget skippati. Solo monitoraggio dati/KPI di base.' },
    }]),
  ];
  const allChecks = await Promise.all([...baseChecks, ...feedChecks]);
  const signals = allChecks.flat();
  const reds = signals.filter(s => s.severity === 'red');
  const yellows = signals.filter(s => s.severity === 'yellow');
  return {
    signals,
    summary: { red: reds.length, yellow: yellows.length, green: signals.filter(s => s.severity === 'green').length },
    needsSlowPath: reds.length > 0 || yellows.length > 0,
    feedManaged,
  };
}

module.exports = { runFastPath };
