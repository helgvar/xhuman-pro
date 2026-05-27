const { pool } = require('../db/pool');
const { sendTelegram, fmtEur, fmtPct } = require('./telegramNotifier');

const MOL_FLOOR = 15;       // pp
const INCIDENZA_CEILING = 8; // %
const TP_SPEND_SPIKE_RATIO = 1.5;
const DEFAULT_CPC = 0.27;

async function _kpiPerTenant() {
  // CPC per-tenant via health_config.avg_tp_cpc, fallback DEFAULT_CPC
  const { rows } = await pool.query(`
    WITH cpc_per_tenant AS (
      SELECT t.id AS tenant_id,
        COALESCE((SELECT NULLIF(config_value, '')::numeric FROM health_config hc
                  WHERE hc.tenant_id = t.id AND hc.config_key = 'avg_tp_cpc'), ${DEFAULT_CPC}::numeric) AS cpc
      FROM tenants t
    ),
    ord AS (
      SELECT o.tenant_id,
        SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.1)) FILTER (WHERE o.order_date::date >= CURRENT_DATE - 30) AS rev_30g,
        SUM((COALESCE(oi.row_total_incl_tax, oi.row_total*1.1)) - oi.qty_ordered * COALESCE(NULLIF(p.erp_cost, 0), p.erp_cost_imputed, 0))
          FILTER (WHERE o.order_date::date >= CURRENT_DATE - 30) AS margin_30g
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.tenant_id=o.tenant_id AND p.sku=oi.sku
      WHERE o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
      GROUP BY o.tenant_id
    ),
    tp AS (
      SELECT zc.tenant_id,
        SUM(zc.clicks) FILTER (WHERE zc.fetch_date >= CURRENT_DATE - 30) * cpt.cpc AS spend_30g,
        SUM(zc.clicks) FILTER (WHERE zc.fetch_date = CURRENT_DATE)         * cpt.cpc AS spend_today,
        SUM(zc.clicks) FILTER (WHERE zc.fetch_date = CURRENT_DATE - 1)     * cpt.cpc AS spend_yest
      FROM zombie_clicks zc
      JOIN cpc_per_tenant cpt ON cpt.tenant_id = zc.tenant_id
      GROUP BY zc.tenant_id, cpt.cpc
    )
    SELECT t.id, t.name,
      ROUND(ord.rev_30g::numeric, 0)    AS rev_30g,
      ROUND((ord.margin_30g / NULLIF(ord.rev_30g,0) * 100)::numeric, 1) AS mol_pct,
      ROUND(tp.spend_30g::numeric, 0)   AS tp_30g,
      ROUND((tp.spend_30g / NULLIF(ord.rev_30g,0) * 100)::numeric, 2) AS incid_pct,
      ROUND(COALESCE(tp.spend_today,0)::numeric, 0) AS tp_today,
      ROUND(COALESCE(tp.spend_yest,0)::numeric, 0)  AS tp_yest
    FROM tenants t
    LEFT JOIN ord ON ord.tenant_id=t.id
    LEFT JOIN tp ON tp.tenant_id=t.id
    WHERE t.status='active'
    ORDER BY t.name
  `);
  return rows;
}

// Alert MOL/incidenza per tenant in zona critica. Throttle 12h per tenant per non spammare.
// Baseline rolling 90g per tenant: mean + stddev di MOL e incidenza giornalieri.
// Usata per detection z-score (anomalie relative al pattern del tenant), in
// aggiunta alle soglie globali (MOL_FLOOR/INCIDENZA_CEILING).
async function _baselinePerTenant() {
  const { rows } = await pool.query(`
    WITH daily AS (
      SELECT t.id AS tenant_id, t.name, o.order_date::date AS d,
        SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.1)) AS rev,
        SUM((COALESCE(oi.row_total_incl_tax, oi.row_total*1.1))
          - oi.qty_ordered * COALESCE(NULLIF(p.erp_cost, 0), p.erp_cost_imputed, 0)) AS marg
      FROM tenants t
      JOIN orders o ON o.tenant_id = t.id AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND o.order_date::date BETWEEN CURRENT_DATE - 90 AND CURRENT_DATE - 8
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.tenant_id=o.tenant_id AND p.sku=oi.sku
      WHERE t.status='active'
      GROUP BY t.id, t.name, o.order_date::date
      HAVING SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.1)) > 0
    )
    SELECT tenant_id, name,
      ROUND(AVG(marg/NULLIF(rev,0)*100)::numeric, 2)    AS mol_mean_90g,
      ROUND(STDDEV(marg/NULLIF(rev,0)*100)::numeric, 2) AS mol_std_90g,
      COUNT(*) AS n_days
    FROM daily GROUP BY tenant_id, name;
  `);
  return rows;
}

async function checkCriticalKPIs() {
  const rows = await _kpiPerTenant();
  const baselineRows = await _baselinePerTenant();
  const baseline = new Map(baselineRows.map(b => [b.name, b]));

  const offenders = [];
  for (const r of rows) {
    const reasons = [];
    if (r.mol_pct !== null && r.mol_pct < MOL_FLOOR)
      reasons.push({ type: 'mol_floor', label: `MOL <b>${fmtPct(r.mol_pct)}</b> sotto floor ${MOL_FLOOR}%` });
    if (r.incid_pct !== null && r.incid_pct > INCIDENZA_CEILING)
      reasons.push({ type: 'incid_ceil', label: `incid <b>${fmtPct(r.incid_pct, 2)}</b> sopra ${INCIDENZA_CEILING}%` });

    // Z-score: anomalia relativa al pattern del tenant (≥2σ dalla baseline 90g)
    const b = baseline.get(r.name);
    if (b && b.n_days >= 14 && b.mol_std_90g > 0 && r.mol_pct !== null) {
      const z = (r.mol_pct - b.mol_mean_90g) / b.mol_std_90g;
      if (z <= -2) {
        reasons.push({ type: 'z_score',
          label: `MOL <b>${fmtPct(r.mol_pct)}</b> = ${z.toFixed(1)}σ sotto media 90g (${fmtPct(b.mol_mean_90g)} ± ${fmtPct(b.mol_std_90g)})` });
      }
    }
    if (reasons.length > 0) offenders.push({ ...r, reasons });
  }
  if (!offenders.length) return { sent: 0, offenders: 0 };

  const lines = ['🚨 <b>Alert KPI critici (ultimi 30g)</b>', ''];
  for (const r of offenders) {
    lines.push(`• <b>${r.name}</b>: ${r.reasons.map(x => x.label).join(' · ')} (rev ${fmtEur(r.rev_30g)}, TP ${fmtEur(r.tp_30g)})`);
  }

  const key = 'kpi-critical:' + offenders.map(o => o.name).sort().join(',');
  const result = await sendTelegram(lines.join('\n'), { key, throttleMs: 12 * 60 * 60 * 1000 });
  return { sent: result.ok ? 1 : 0, offenders: offenders.length, throttled: result.reason === 'throttled' };
}

// Spesa TP anomala: spesa oggi > 1.5x media giorni precedenti, in proporzione all'ora del giorno.
async function checkTPSpikes() {
  const rows = await _kpiPerTenant();
  const hour = new Date().getHours();
  const dayFraction = Math.max(0.1, hour / 24); // evita div by 0 a mezzanotte
  const offenders = [];

  for (const r of rows) {
    if (!r.tp_today || !r.tp_yest) continue;
    const expectedSoFar = r.tp_yest * dayFraction;
    if (r.tp_today > expectedSoFar * TP_SPEND_SPIKE_RATIO && r.tp_today > 30) {
      offenders.push({ ...r, expected: Math.round(expectedSoFar) });
    }
  }
  if (!offenders.length) return { sent: 0, offenders: 0 };

  const lines = ['📈 <b>Spike spesa TP rilevato</b>', ''];
  for (const r of offenders) {
    lines.push(`• <b>${r.name}</b>: oggi ${fmtEur(r.tp_today)} vs atteso ~${fmtEur(r.expected)} (ieri totale ${fmtEur(r.tp_yest)})`);
  }
  const key = 'tp-spike:' + offenders.map(o => o.name).sort().join(',');
  const result = await sendTelegram(lines.join('\n'), { key, throttleMs: 4 * 60 * 60 * 1000 });
  return { sent: result.ok ? 1 : 0, offenders: offenders.length };
}

// Daily summary 9:00 - snapshot per tenant.
async function sendDailySummary() {
  const rows = await _kpiPerTenant();
  const lines = ['📊 <b>xHumanPro · daily ' + new Date().toLocaleDateString('it-IT') + '</b>', ''];
  for (const r of rows) {
    const molIcon = r.mol_pct === null ? '—' : r.mol_pct < MOL_FLOOR ? '🔴' : r.mol_pct >= 20 ? '🟢' : '🟡';
    const incidIcon = r.incid_pct === null ? '—' : r.incid_pct > INCIDENZA_CEILING ? '🔴' : r.incid_pct <= 5 ? '🟢' : '🟡';
    lines.push(`<b>${r.name}</b>`);
    lines.push(`  rev30g ${fmtEur(r.rev_30g)} · MOL ${molIcon} ${fmtPct(r.mol_pct)} · TP ${fmtEur(r.tp_30g)} · incid ${incidIcon} ${fmtPct(r.incid_pct, 2)}`);
  }
  const result = await sendTelegram(lines.join('\n'), { key: 'daily-summary:' + new Date().toISOString().slice(0, 10), throttleMs: 20 * 60 * 60 * 1000 });
  return { sent: result.ok ? 1 : 0, tenants: rows.length };
}

module.exports = { checkCriticalKPIs, checkTPSpikes, sendDailySummary };
