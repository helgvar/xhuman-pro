/**
 * 🔬 MONITOR SUPPLEMENTARE — TEST Pareto Positioning (ordine capo 24/7)
 *
 * Sorveglia da vicino i PC 'pareto_positioning' (partenza: 413 su Papa). Ogni
 * 30 min fotografa in `pareto_test_snapshots`: costo VERO del momento, baseline,
 * prezzo-PC, margine, floor, posizione e i flag di rischio (sotto_costo,
 * sotto_floor, cost_rise). Serve a capire su 2 giorni cosa succede ai COSTI
 * (switch magazzino→grossista) e alla tenuta del margine.
 *
 * Telegram: heartbeat compatto ogni ~3h + ALERT IMMEDIATO se compare un
 * sotto_costo o un cost_rise che sfonda il floor. Il guardiano PC (mig 073)
 * AGISCE; questo monitor OSSERVA e avvisa.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const EVERY_MS = 30 * 60 * 1000;   // 30 min
const HEARTBEAT_EVERY = 6;         // ogni 6 giri = ~3h
let tick = 0;

async function runParetoTestMonitor() {
  try {
    // snapshot + ritorno aggregato in un colpo
    const { rows } = await pool.query(`
      WITH pc AS (
        SELECT fa.tenant_id, fa.sku, fa.recommended_price rp,
          costo_vero(fa.tenant_id, fa.sku) costo,
          b.baseline_cost base,
          (SELECT phs.scraper_position FROM product_health_scores phs
             WHERE phs.tenant_id=fa.tenant_id AND phs.sku=fa.sku) pos,
          CASE WHEN COALESCE(p.erp_stock,0)>0 THEN 'magazzino' ELSE 'grossista' END fonte
        FROM feed_actions fa
        JOIN products p ON p.tenant_id=fa.tenant_id AND p.sku=fa.sku
        LEFT JOIN pc_cost_baseline b ON b.tenant_id=fa.tenant_id AND b.sku=fa.sku
        WHERE fa.action='PRICE_CUT'
          AND (fa.action_source='pareto_positioning' OR fa.action_reason LIKE 'riposizionamento pareto%')
          AND fa.status IN ('pending','dispatched','active') AND fa.recommended_price>0),
      ev AS (
        SELECT *,
          ROUND((rp-costo)/NULLIF(rp,0)*100,1) marg,
          (CASE WHEN rp<5 THEN 25 WHEN rp<10 THEN 19 WHEN rp<30 THEN 16 WHEN rp<50 THEN 13 ELSE 11 END) floor,
          (rp <= costo) sotto_costo,
          (rp > costo AND (rp-costo)/NULLIF(rp,0)*100 < (CASE WHEN rp<5 THEN 25 WHEN rp<10 THEN 19 WHEN rp<30 THEN 16 WHEN rp<50 THEN 13 ELSE 11 END)) sotto_floor,
          (base IS NOT NULL AND costo > base) cost_rise
        FROM pc WHERE costo > 0),
      ins AS (
        INSERT INTO pareto_test_snapshots
          (tenant_id, sku, costo_now, baseline_cost, recommended_price, margin_pct, floor_pct, scraper_position, fonte, sotto_costo, sotto_floor, cost_rise)
        SELECT tenant_id, sku, costo, base, rp, marg, floor, pos, fonte, sotto_costo, sotto_floor, cost_rise FROM ev
        RETURNING 1)
      SELECT
        (SELECT COUNT(*) FROM ev) n,
        (SELECT COUNT(*) FROM ev WHERE sotto_costo) n_sotto_costo,
        (SELECT COUNT(*) FROM ev WHERE sotto_floor) n_sotto_floor,
        (SELECT COUNT(*) FROM ev WHERE cost_rise) n_cost_rise,
        (SELECT ROUND(AVG(marg),1) FROM ev) marg_medio,
        (SELECT ROUND(AVG(pos),1) FROM ev WHERE pos IS NOT NULL) pos_media,
        (SELECT COUNT(*) FROM ev WHERE pos IS NOT NULL AND pos<=10) n_top10,
        (SELECT COUNT(*) FROM ins) snap
    `);
    const r = rows[0] || {};
    const n = parseInt(r.n || 0);
    const breach = parseInt(r.n_sotto_costo || 0) + parseInt(r.n_cost_rise || 0);
    tick++;

    console.log(`[ParetoTestMon] ${n} PC | sotto_costo=${r.n_sotto_costo} sotto_floor=${r.n_sotto_floor} cost_rise=${r.n_cost_rise} | marg_medio=${r.marg_medio}% pos_media=${r.pos_media} top10=${r.n_top10}`);

    const alertBreach = parseInt(r.n_sotto_costo || 0) > 0 || parseInt(r.n_cost_rise || 0) > 0;
    if (alertBreach) {
      await sendTelegram(`⚠️ <b>Monitor Pareto — anomalia costo</b>\n${r.n_cost_rise} PC con COSTO SALITO (switch?), di cui sotto costo: ${r.n_sotto_costo}, sotto floor: ${r.n_sotto_floor}.\nIl guardiano PC li corregge al prossimo giro (rialzo floor-safe o ritiro). Margine medio ${r.marg_medio}%, pos media ${r.pos_media}, in top10 ${r.n_top10}/${n}.`).catch(() => {});
    } else if (tick % HEARTBEAT_EVERY === 1) {
      await sendTelegram(`🔬 <b>Monitor Pareto (test Papa)</b>\n${n} PC attivi. Margine medio ${r.marg_medio}% · pos media ${r.pos_media} · in top10 ${r.n_top10}/${n}. Sotto floor: ${r.n_sotto_floor}, costo salito: ${r.n_cost_rise}. Tutto sotto controllo.`).catch(() => {});
    }
    return r;
  } catch (e) {
    console.error('[ParetoTestMon] ERRORE:', e.message);
    return null;
  }
}

function startParetoTestMonitor() {
  setTimeout(function loop() {
    runParetoTestMonitor().finally(() => setTimeout(loop, EVERY_MS));
  }, 60 * 1000);   // primo giro tra 1 min
  console.log('[ParetoTestMon] armato — primo giro tra 1 min, poi ogni 30 min');
}

module.exports = { startParetoTestMonitor, runParetoTestMonitor };
