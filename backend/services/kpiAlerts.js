const { pool } = require('../db/pool');
const { sendTelegram, fmtEur, fmtPct } = require('./telegramNotifier');

const MOL_FLOOR = 15;       // pp
const INCIDENZA_CEILING = 8; // %
const TP_SPEND_SPIKE_RATIO = 1.5;
// Copertura costo minima perche' un MOL sia un numero e non un'illusione.
// costo_al() torna NULL dove product_cost_history non arriva (parte dal
// 06/07/2026) e la somma lo conta ZERO: merce gratis, margine 100%.
const COPERTURA_MIN = 99;   // %

async function _kpiPerTenant() {
  // LA LEGGE DEL MOL sta in DB: mol_tenant() (mig 123/126/127, GO capo 11/09)
  //   MOL = vendita - costo prodotto - TP - saldo spedizione a carico negozio
  // Qui non si reimplementa niente: si chiama. Il CPC lordo lo da' cpc_tenant()
  // (mig 125: health_config.avg_tp_cpc e' NETTO, va moltiplicato x1,22).
  const { rows } = await pool.query(`
    WITH tt AS (SELECT id, name FROM tenants WHERE status='active'),
    tpd AS (
      SELECT zc.tenant_id,
        SUM(zc.clicks) FILTER (WHERE zc.fetch_date = CURRENT_DATE)     * cpc_tenant(zc.tenant_id) AS spend_today,
        SUM(zc.clicks) FILTER (WHERE zc.fetch_date = CURRENT_DATE - 1) * cpc_tenant(zc.tenant_id) AS spend_yest
      FROM zombie_clicks zc
      WHERE zc.fetch_date >= CURRENT_DATE - 1
      GROUP BY zc.tenant_id)
    SELECT tt.id, tt.name,
      ROUND(m.ricavo, 0)        AS rev_30g,
      m.mol_pct                 AS mol_pct,
      m.margine_pct             AS marg_lordo_pct,
      ROUND(m.spesa_tp, 0)      AS tp_30g,
      m.incidenza_pct           AS incid_pct,
      ROUND(m.spedizione_negozio, 0) AS sped_30g,
      m.copertura_costo_pct     AS copertura,
      ROUND(COALESCE(tpd.spend_today, 0), 0) AS tp_today,
      ROUND(COALESCE(tpd.spend_yest, 0), 0)  AS tp_yest
    FROM tt
    LEFT JOIN LATERAL mol_tenant(tt.id, CURRENT_DATE - 30, CURRENT_DATE) m ON true
    LEFT JOIN tpd ON tpd.tenant_id = tt.id
    ORDER BY tt.name
  `);
  return rows;
}

// Baseline rolling per tenant: media e deviazione del MOL GIORNALIERO, con la
// stessa legge del numero che poi confrontiamo — altrimenti lo z-score mette a
// confronto margine lordo e MOL netto e non spara mai.
// Finestra: da primo_giorno_costo_coperto() (mig 128), MAI prima. Con i 90
// giorni pieni la media usciva 30-47% (costo ignoto contato zero) e la
// deviazione 37-44pp: una soglia a 2 sigma che nessun crollo poteva superare.
// Si scartano anche i singoli giorni con copertura sotto l'1% di buco.
async function _baselinePerTenant() {
  const { rows } = await pool.query(`
    WITH tt AS (
      SELECT id, name, GREATEST(primo_giorno_costo_coperto(id), CURRENT_DATE - 90) AS dal
      FROM tenants WHERE status='active'),
    g AS (
      SELECT o.tenant_id, (o.order_date AT TIME ZONE 'Europe/Rome')::date AS d,
             SUM(oi.row_total_incl_tax) AS rev,
             SUM(COALESCE(costo_al(o.tenant_id, oi.sku, (o.order_date AT TIME ZONE 'Europe/Rome')::date),0) * oi.qty_ordered) AS cogs,
             COALESCE(SUM(oi.row_total_incl_tax) FILTER (
               WHERE costo_al(o.tenant_id, oi.sku, (o.order_date AT TIME ZONE 'Europe/Rome')::date) IS NULL),0) AS scoperto
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN tt ON tt.id = o.tenant_id
      WHERE o.order_status = ANY (stati_ordine_validi())
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN tt.dal AND CURRENT_DATE - 8
      GROUP BY 1,2),
    s AS (
      SELECT o.tenant_id, (o.order_date AT TIME ZONE 'Europe/Rome')::date AS d,
             SUM(spedizione_a_carico_negozio(o.tenant_id, o.order_status, o.shipping_incl_tax)) AS sped
      FROM orders o JOIN tt ON tt.id = o.tenant_id
      WHERE o.order_status = ANY (stati_ordine_validi())
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN tt.dal AND CURRENT_DATE - 8
      GROUP BY 1,2),
    c AS (
      SELECT zc.tenant_id, zc.fetch_date AS d, SUM(zc.clicks) * cpc_tenant(zc.tenant_id) AS tp
      FROM zombie_clicks zc WHERE zc.fetch_date >= CURRENT_DATE - 90 GROUP BY 1,2),
    daily AS (
      SELECT tt.id AS tenant_id, tt.name,
        (g.rev - g.cogs - COALESCE(c.tp,0) - COALESCE(s.sped,0)) / NULLIF(g.rev,0) * 100 AS mol
      FROM g
      JOIN tt ON tt.id = g.tenant_id
      LEFT JOIN s ON s.tenant_id = g.tenant_id AND s.d = g.d
      LEFT JOIN c ON c.tenant_id = g.tenant_id AND c.d = g.d
      WHERE g.rev > 0 AND g.scoperto / g.rev < 0.01)
    SELECT tenant_id, name,
      ROUND(AVG(mol)::numeric, 2)    AS mol_mean_90g,
      ROUND(STDDEV(mol)::numeric, 2) AS mol_std_90g,
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

    // Legge #48 del capo: "non si calcolano prezzi di vendita se il costo non
    // e' aggiornato". Vale anche a valle: un MOL costruito su righe di cui non
    // sappiamo il costo e' gonfiato verso l'alto (il NULL vale zero), quindi
    // non puo' far scattare NE' un allarme NE' un via libera. Si segnala il
    // buco di dato e si passa oltre.
    const cop = r.copertura === null || r.copertura === undefined ? null : Number(r.copertura);
    if (r.rev_30g !== null && (cop === null || cop < COPERTURA_MIN)) {
      offenders.push({ ...r, reasons: [{ type: 'costo_assente',
        label: `costo noto solo sul <b>${cop === null ? '?' : fmtPct(cop, 1)}</b> del venduto: MOL NON misurabile` }] });
      continue;
    }

    // Z-score PRIMA: serve anche a decidere se il sotto-floor e' una notizia.
    const b = baseline.get(r.name);
    let z = null;
    if (b && b.n_days >= 14 && b.mol_std_90g > 0 && r.mol_pct !== null) {
      z = (r.mol_pct - b.mol_mean_90g) / b.mol_std_90g;
    }

    // Il pavimento 15% resta LA LEGGE, ma col MOL vero (vendita - costo - TP -
    // spedizione) nessun tenant della rete lo tocca: farne un alert significa
    // spedire l'elenco completo dei tenant ogni 12h, cioe' spegnere l'allarme
    // a forza di rumore. Sotto-floor e' uno STATO e vive nel daily. Qui si
    // suona solo quando e' un EVENTO:
    //   a) MOL negativo — sta perdendo soldi su ogni ordine, sempre notizia;
    //   b) MOL sotto floor E in caduta >=2 sigma rispetto a se stesso.
    if (r.mol_pct !== null && r.mol_pct < 0) {
      reasons.push({ type: 'mol_negativo',
        label: `MOL <b>${fmtPct(r.mol_pct)}</b> — <b>in perdita</b>` });
    } else if (r.mol_pct !== null && r.mol_pct < MOL_FLOOR && z !== null && z <= -2) {
      reasons.push({ type: 'mol_floor',
        label: `MOL <b>${fmtPct(r.mol_pct)}</b> sotto floor ${MOL_FLOOR}% e in caduta (${z.toFixed(1)}σ)` });
    }

    if (r.incid_pct !== null && r.incid_pct > INCIDENZA_CEILING)
      reasons.push({ type: 'incid_ceil', label: `incid <b>${fmtPct(r.incid_pct, 2)}</b> sopra ${INCIDENZA_CEILING}%` });

    if (z !== null && z <= -2 && !reasons.some(x => x.type === 'mol_floor')) {
      reasons.push({ type: 'z_score',
        label: `MOL <b>${fmtPct(r.mol_pct)}</b> = ${z.toFixed(1)}σ sotto la propria media (${fmtPct(b.mol_mean_90g)} ± ${fmtPct(b.mol_std_90g)} su ${b.n_days}gg)` });
    }
    if (reasons.length > 0) offenders.push({ ...r, reasons });
  }
  if (!offenders.length) return { sent: 0, offenders: 0 };

  const lines = ['🚨 <b>Alert KPI critici (ultimi 30g)</b>', ''];
  for (const r of offenders) {
    lines.push(`• <b>${r.name}</b>: ${r.reasons.map(x => x.label).join(' · ')}`);
    lines.push(`   rev ${fmtEur(r.rev_30g)} · lordo ${fmtPct(r.marg_lordo_pct)} · TP ${fmtEur(r.tp_30g)} · sped ${fmtEur(r.sped_30g)}`);
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
