/**
 * Recommendation Verifier — feedback loop sulle proposte applicate.
 *
 * Per ogni rule_recommendations con status='applied' e applied_at >= 3gg fa:
 *   1) Calcola le metriche REALI della regola nella finestra POST-APPLY
 *      (da applied_at a oggi)
 *   2) Calcola le metriche della regola nella finestra PRE-APPLY (stessa durata
 *      di N giorni, immediatamente precedente applied_at)
 *   3) Calcola delta reale (cost_delta, revenue_delta, incidence_delta)
 *   4) Confronta con expected_impact predetto
 *   5) Classifica: on_track | deviating | failed | success
 *   6) Genera testo di correzione se serve
 *
 * NB: la finestra minima e' 3gg (sotto e' troppo presto, dati rumorosi).
 *     La finestra ideale e' 7gg (settimana piena).
 */

const { pool } = require('../db/pool');

const CPC_DEFAULT = 0.27;
const MIN_WINDOW_DAYS = 3;
const MAX_WINDOW_DAYS = 14;
const PENDING_GRACE_DAYS = 3; // sotto questa eta', resta 'pending' (no verifica)

async function verifyTenant(tenantId, opts = {}) {
  const cpc = opts.cpc || CPC_DEFAULT;

  // 1) Trova le applied da verificare:
  //    - status='applied' (escludi superseded/dismissed)
  //    - applied_at tra 3gg e 60gg fa
  //    - verification_status NULL OR 'pending' OR 'deviating' (rivaluta)
  //    - NON verifichiamo le 'success' (gia' confermate)
  //    - NON verifichiamo le 'failed' (gia' attese azioni correttive)
  const { rows: applied } = await pool.query(`
    SELECT id, rule_id, rule_name, proposed_changes, expected_impact, applied_at, verification_status
    FROM rule_recommendations
    WHERE tenant_id = $1
      AND status = 'applied'
      AND applied_at IS NOT NULL
      AND applied_at >= NOW() - INTERVAL '60 days'
      AND applied_at <= NOW() - INTERVAL '${PENDING_GRACE_DAYS} days'
      AND (verification_status IS NULL OR verification_status IN ('pending', 'deviating'))
  `, [tenantId]);

  const results = [];
  for (const rec of applied) {
    const r = await verifyOne(tenantId, rec, cpc);
    results.push(r);
  }
  return results;
}

async function verifyOne(tenantId, rec, cpc) {
  const appliedAt = new Date(rec.applied_at);
  const now = new Date();
  const msPerDay = 24 * 3600 * 1000;
  const daysSince = Math.floor((now - appliedAt) / msPerDay);

  // Finestra post = min(daysSince, MAX_WINDOW_DAYS). Finestra pre = stessa durata.
  const windowDays = Math.min(daysSince, MAX_WINDOW_DAYS);
  if (windowDays < MIN_WINDOW_DAYS) {
    // Troppo presto, lascia 'pending'
    await pool.query(
      `UPDATE rule_recommendations SET verification_status='pending', verified_at=NOW() WHERE id=$1`,
      [rec.id]
    );
    return { id: rec.id, status: 'pending', reason: `solo ${daysSince}gg dall'apply` };
  }

  const postEnd = new Date(now);
  const postStart = new Date(appliedAt.getTime());
  // Ma se daysSince > MAX_WINDOW_DAYS, considera solo l'ultima finestra MAX
  if (daysSince > MAX_WINDOW_DAYS) {
    postStart.setTime(postEnd.getTime() - MAX_WINDOW_DAYS * msPerDay);
  }
  const preEnd = new Date(appliedAt.getTime());
  const preStart = new Date(preEnd.getTime() - windowDays * msPerDay);

  // 2-3) Metriche regola in finestra pre e post
  const metricsPre = await getRuleMetrics(tenantId, rec.rule_id, preStart, preEnd, cpc);
  const metricsPost = await getRuleMetrics(tenantId, rec.rule_id, postStart, postEnd, cpc);

  // Delta reale
  const actualImpact = {
    window_days: windowDays,
    pre: { from: preStart.toISOString().slice(0,10), to: preEnd.toISOString().slice(0,10), ...metricsPre },
    post: { from: postStart.toISOString().slice(0,10), to: postEnd.toISOString().slice(0,10), ...metricsPost },
    cost_delta_eur: +(metricsPost.cost - metricsPre.cost).toFixed(2),
    revenue_delta_eur: +(metricsPost.revenue - metricsPre.revenue).toFixed(2),
    clicks_delta_pct: metricsPre.clicks > 0 ? +(((metricsPost.clicks - metricsPre.clicks) / metricsPre.clicks) * 100).toFixed(1) : null,
    orders_delta_pct: metricsPre.orders > 0 ? +(((metricsPost.orders - metricsPre.orders) / metricsPre.orders) * 100).toFixed(1) : null,
    incidence_pre_pct: metricsPre.incidence,
    incidence_post_pct: metricsPost.incidence,
    incidence_delta_pp: (metricsPre.incidence != null && metricsPost.incidence != null)
      ? +(metricsPost.incidence - metricsPre.incidence).toFixed(2)
      : null,
  };

  // 4) Confronto con predetto
  const expected = rec.expected_impact || {};
  const expCostDelta = parseFloat(expected.cost_delta_eur);
  const expRevDelta = parseFloat(expected.revenue_delta_eur);

  let verificationStatus = 'on_track';
  let deviationPct = 0;
  const reasons = [];

  // Regola di valutazione: se NON c'erano predizioni di delta, valutiamo segno di
  // PnL post-apply (revenue_delta - cost_delta deve essere >= 0 idealmente).
  const actualPnl = actualImpact.revenue_delta_eur - actualImpact.cost_delta_eur;
  const expectedPnl = (Number.isFinite(expRevDelta) ? expRevDelta : 0) -
                      (Number.isFinite(expCostDelta) ? expCostDelta : 0);

  // Se la predizione era positiva ma il reale e' negativo → failed
  if (expectedPnl > 0 && actualPnl < -expectedPnl * 0.5) {
    verificationStatus = 'failed';
    deviationPct = 100;
    reasons.push(`PnL reale ${actualPnl.toFixed(0)}€ vs predetto ${expectedPnl.toFixed(0)}€`);
  }
  // Se reale fortemente migliore → success
  else if (expectedPnl > 0 && actualPnl >= expectedPnl * 0.7) {
    verificationStatus = 'success';
    deviationPct = 0;
    reasons.push(`PnL ${actualPnl.toFixed(0)}€ in linea con predetto ${expectedPnl.toFixed(0)}€`);
  }
  // Se c'e' un cost_delta atteso negativo (cioe' meno spesa TP) e invece spesa salita:
  else if (Number.isFinite(expCostDelta) && expCostDelta < 0 && actualImpact.cost_delta_eur > 0) {
    verificationStatus = 'failed';
    deviationPct = Math.abs(((actualImpact.cost_delta_eur - expCostDelta) / expCostDelta) * 100);
    reasons.push(`spesa TP +${actualImpact.cost_delta_eur.toFixed(0)}€ vs attesa ${expCostDelta.toFixed(0)}€`);
  }
  // Revenue atteso positivo ma in calo
  else if (Number.isFinite(expRevDelta) && expRevDelta > 0 && actualImpact.revenue_delta_eur < 0) {
    verificationStatus = 'failed';
    deviationPct = 100;
    reasons.push(`revenue ${actualImpact.revenue_delta_eur.toFixed(0)}€ vs atteso +${expRevDelta.toFixed(0)}€`);
  }
  // Incidence sale tanto: deviation
  else if (actualImpact.incidence_delta_pp != null && actualImpact.incidence_delta_pp > 3) {
    verificationStatus = 'deviating';
    deviationPct = 50;
    reasons.push(`incidenza +${actualImpact.incidence_delta_pp}pp post-apply (era ${actualImpact.incidence_pre_pct}% → ora ${actualImpact.incidence_post_pct}%)`);
  }
  // Click esplosi e ordini non in proporzione → deviating
  else if (actualImpact.clicks_delta_pct != null && actualImpact.clicks_delta_pct > 80 &&
           (actualImpact.orders_delta_pct == null || actualImpact.orders_delta_pct < actualImpact.clicks_delta_pct * 0.5)) {
    verificationStatus = 'deviating';
    deviationPct = 60;
    reasons.push(`click +${actualImpact.clicks_delta_pct}% ma ordini +${actualImpact.orders_delta_pct ?? 0}% (efficienza calata)`);
  }

  // 5) Genera testo di correzione
  let correctionText = '';
  const pc = rec.proposed_changes || {};
  if (verificationStatus === 'failed') {
    if (pc.tolerance_to != null && pc.tolerance_from != null) {
      correctionText = `ROLLBACK consigliato: riporta tolleranza da ${pc.tolerance_to}% a ${pc.tolerance_from}%. ` + reasons.join(' · ');
    } else if (pc.markup_to != null && pc.markup_from != null) {
      correctionText = `ROLLBACK consigliato: riporta markup da ${pc.markup_to}% a ${pc.markup_from}%. ` + reasons.join(' · ');
    } else if (pc.window_to != null && pc.window_to_from != null) {
      correctionText = `ROLLBACK consigliato: riporta finestra da 0-${pc.window_to} a 0-${pc.window_to_from}. ` + reasons.join(' · ');
    } else if (pc.sub_segment?.should_split) {
      correctionText = `Lo SPLIT regola non ha funzionato. ` + reasons.join(' · ') + ` Valutare riaggregare o cambiare strategia.`;
    } else {
      correctionText = `Modifica applicata NON ha portato i risultati attesi. ` + reasons.join(' · ');
    }
  } else if (verificationStatus === 'deviating') {
    correctionText = `Tendenza in deviazione dalle attese: ` + reasons.join(' · ') + ` Monitorare ancora 7gg, se non rientra valutare rollback.`;
  } else if (verificationStatus === 'success') {
    correctionText = `OK: l'azione ha portato i risultati attesi. ` + reasons.join(' · ');
  }

  // 6) Persist
  await pool.query(
    `UPDATE rule_recommendations
     SET verification_status=$2, verified_at=NOW(), actual_impact=$3, deviation_pct=$4, correction_proposed=$5
     WHERE id=$1`,
    [rec.id, verificationStatus, JSON.stringify(actualImpact), deviationPct.toFixed(2), correctionText || null]
  );

  return {
    id: rec.id,
    rule_name: rec.rule_name,
    status: verificationStatus,
    deviation_pct: deviationPct,
    actual_impact: actualImpact,
    correction: correctionText,
  };
}

async function getRuleMetrics(tenantId, ruleId, from, to, cpc) {
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    WITH rule_skus AS (
      SELECT sku FROM products WHERE tenant_id=$1 AND price_rule_id=$2 AND is_civetta=true
    ),
    zc AS (
      SELECT product_code AS sku, SUM(clicks) AS clicks
      FROM zombie_clicks
      WHERE tenant_id=$1 AND fetch_date >= $3::date AND fetch_date < $4::date
      GROUP BY 1
    ),
    ord AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) AS orders,
             SUM(COALESCE(oi.row_total_incl_tax, oi.row_total*1.1)) AS rev
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.tenant_id=$1
        AND o.order_status IN ('complete','processing','Ritirato','ritiro_farmacia','ritiro_sede_tmp')
        AND o.order_date >= $3::date AND o.order_date < $4::date
      GROUP BY 1
    )
    SELECT
      COALESCE(SUM(zc.clicks),0)::int AS clicks,
      COALESCE(SUM(ord.orders),0)::int AS orders,
      ROUND(COALESCE(SUM(ord.rev),0)::numeric, 2)::float AS revenue,
      ROUND((COALESCE(SUM(zc.clicks),0) * $5)::numeric, 2)::float AS cost
    FROM rule_skus rs
    LEFT JOIN zc USING(sku)
    LEFT JOIN ord USING(sku)
  `, [tenantId, ruleId, fromStr, toStr, cpc]);
  const r = rows[0] || {};
  const clicks = parseInt(r.clicks) || 0;
  const orders = parseInt(r.orders) || 0;
  const revenue = parseFloat(r.revenue) || 0;
  const cost = parseFloat(r.cost) || 0;
  const incidence = revenue > 0 ? +(cost / revenue * 100).toFixed(2) : null;
  return { clicks, orders, revenue, cost, incidence };
}

async function verifyAllTenants() {
  const { rows: tenants } = await pool.query(
    "SELECT id, name FROM tenants WHERE status='active' ORDER BY name"
  );
  const results = [];
  for (const t of tenants) {
    try {
      const r = await verifyTenant(t.id);
      const counts = { success: 0, on_track: 0, deviating: 0, failed: 0, pending: 0 };
      for (const x of r) { counts[x.status] = (counts[x.status] || 0) + 1; }
      console.log(`[Verifier] [${t.name}] ${r.length} verified: ${JSON.stringify(counts)}`);
      results.push({ tenant: t.name, counts, total: r.length });
    } catch (err) {
      console.error(`[Verifier] [${t.name}] FAILED:`, err.message);
      results.push({ tenant: t.name, error: err.message });
    }
  }
  return results;
}

module.exports = { verifyTenant, verifyOne, verifyAllTenants };
