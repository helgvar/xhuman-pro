/**
 * 🔥 LOOP BURNER INCIDENZA>100% (ordine capo 17/7)
 *
 * "L'audit dei burner con incidenza >100% deve diventare un'azione ricorrente,
 *  collegata al loop dei burner — non più a mano."
 *
 * Ogni notte alle 05:45 IT (dopo il decadimento PC delle 05:30), per ogni tenant
 * operational, mette in dieta i BURNER a incidenza >100% FATTURATO-ZERO:
 *   - spesa click 15g > fatturato diretto 15g (incidenza >100%)
 *   - fatturato diretto 15g = 0 (rev=0)  → 0 fatturato diretto
 *   - NOT is_basket_protected                → 0 carrello (verificato: portano €0)
 *   - NOT is_brand_protected                 → brand cliente intatti
 *   - non pin, non già in dieta, stock < 10
 *
 * Sono prodotti che la rete vende altrove ma che QUESTO tenant paga in click
 * senza incassare nulla (né diretto né carrello). Toglierli non perde fatturato;
 * la rete continua a venderli dagli altri punti vendita.
 *
 * FRENO ANTI-9/7 (lezione Farmastelia [[portatori-di-traffico-mai-bulk]]):
 * MAX 80/tenant/giorno — "poco ma costante", mai bulk. Gli SKU più costosi (per
 * click) per primi. La guardia click/fatturato vigila; se un tenant crolla si
 * ferma da sé (dieta reversibile).
 *
 * Dieta 'burner_incidenza' con retest 21g (identico al pcDecay): chi è staccato
 * non torna il giorno dopo, ma viene ri-valutato dopo il cooldown. Tutto firmato
 * a verbale Arbitro.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const TENANT_OPERATIONAL = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF',
  'Farmainsieme', 'Farmastelia', 'Farmacia Mandanici'];
const MAX_PER_TENANT = 80;   // poco ma costante (freno anti-9/7)
const RETEST_DAYS = 21;      // cooldown prima del retesting
const DEFAULT_CPC = 0.2773;  // fallback se il tenant non ha avg_tp_cpc
const RUN_HOUR_UTC = 3;
const RUN_MIN_UTC = 45;

async function runBurnerIncidence() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('xhp.writer', 'burner_incidenza_cron', true),
      set_config('xhp.motivo', 'ordine capo 17/7: loop burner incidenza>100% fatturato-zero (0 diretto + 0 carrello), poco-ma-costante 80/tenant/g con retest 21g', true)`);

    const stacco = await client.query(`
      WITH op AS (
        SELECT t.id tid, t.name,
          COALESCE((SELECT hc.config_value::numeric FROM health_config hc
                    WHERE hc.tenant_id=t.id AND hc.config_key='avg_tp_cpc'), ${DEFAULT_CPC}) cpc
        FROM tenants t WHERE t.status='active' AND t.name = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM health_config hcx WHERE hcx.tenant_id=t.id AND hcx.config_key='tp_budget_exhausted' AND hcx.config_value='1' AND (hcx.expires_at IS NULL OR hcx.expires_at > NOW()))),
      ck AS (
        SELECT z.tenant_id tid, z.product_code sku, SUM(z.clicks) c15
        FROM zombie_clicks z WHERE z.fetch_date >= CURRENT_DATE - 15
          AND z.tenant_id IN (SELECT tid FROM op) GROUP BY 1, 2),
      revd AS (
        SELECT o.tenant_id tid, oi.sku, SUM(oi.row_total_incl_tax) rev15
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.order_date >= NOW() - INTERVAL '15 days'
          AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
          AND o.tenant_id IN (SELECT tid FROM op) GROUP BY 1, 2),
      cand AS (
        SELECT op.tid, ck.sku, ck.c15 * op.cpc spesa15,
          ROW_NUMBER() OVER (PARTITION BY op.tid ORDER BY ck.c15 DESC) rk
        FROM ck JOIN op ON op.tid = ck.tid
        JOIN products p ON p.tenant_id = op.tid AND p.sku = ck.sku
        LEFT JOIN revd ON revd.tid = ck.tid AND revd.sku = ck.sku
        WHERE COALESCE(revd.rev15, 0) = 0                        -- fatturato diretto ZERO
          -- MARGINE 100% BRUCIATO (capo 24/7): stacca quando la spesa click 15g
          -- ha eroso il 100% del margine unitario vero senza vendere nulla
          -- (bibbia margine-first). Non basta piu' spesa>0: serve spesa>=margine.
          AND ck.c15 * op.cpc >= GREATEST(margine_unitario_vero(op.tid, ck.sku), 0.01)
          -- GUARDIA TEST (riattivazione mig 072): non ri-bloccare in finestra test.
          AND NOT EXISTS (SELECT 1 FROM margin_block_tests m
              WHERE m.tenant_id = op.tid AND m.sku = ck.sku
                AND m.in_test AND m.test_ends_at > NOW())
          -- ALLINEATO ai trigger DB (fix 17/7): is_feed_protected unifica
          -- carrello/brand/stock/seller/vende-30g. Usando la stessa funzione
          -- del veto, ciò che il cron propone PASSA davvero (niente più veti a vuoto).
          AND NOT is_feed_protected(op.tid, ck.sku)
          AND NOT vende_in_rete_15g(ck.sku)                      -- L2/mig061: i vendenti-rete non si condannano dai motori (solo sessione)
          AND p.updated_at >= NOW() - INTERVAL '12 hours'        -- passa il fail-closed (mig 044)
          AND COALESCE(p.erp_stock, 0) < 10
          AND NOT EXISTS (SELECT 1 FROM feed_quarantine q
              WHERE q.tenant_id = op.tid AND q.sku = ck.sku AND q.reactivated = false)
          AND NOT EXISTS (SELECT 1 FROM capo_pins cp
              WHERE cp.tenant_id = op.tid AND cp.sku = ck.sku AND cp.revoked_at IS NULL)),
      ins AS (
        INSERT INTO feed_quarantine (tenant_id, sku, reason, quarantine_start, quarantine_end,
          reactivated, manual_override, manual_override_at, quarantine_level)
        SELECT tid, sku, 'burner_incidenza (loop 17/7): incidenza>100% fatturato-zero, la rete lo vende altrove',
          NOW(), NOW() + INTERVAL '${RETEST_DAYS} days', false, true, NOW(), 3
        FROM cand WHERE rk <= $2
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          reason = EXCLUDED.reason, quarantine_start = NOW(),
          quarantine_end = NOW() + INTERVAL '${RETEST_DAYS} days',
          reactivated = false, reactivated_at = NULL,
          manual_override = true, manual_override_at = NOW(), quarantine_level = 3
        RETURNING tenant_id, sku)
      SELECT t.name, COUNT(*) n FROM ins JOIN tenants t ON t.id = ins.tenant_id
      GROUP BY t.name ORDER BY n DESC`,
      [TENANT_OPERATIONAL, MAX_PER_TENANT]);

    // dieta_provati per gli staccati (carve-out uscita feed)
    await client.query(`
      INSERT INTO dieta_provati (tenant_id, sku)
      SELECT tenant_id, sku FROM feed_quarantine
      WHERE reason LIKE 'burner_incidenza (loop 17/7)%' AND reactivated = false
        AND quarantine_start > NOW() - INTERVAL '2 minutes'
      ON CONFLICT DO NOTHING`);

    // RETEST: NON piu' qui. Il rilascio/retest e' governato dall'unico scheduler
    // reactivate_margin_blocks (mig 072): R1 vende-in-rete, R2 restock magazzino,
    // R3 test 5gg ogni 20gg. Rimosso il retest cieco 21gg (autorita' unica).
    await client.query('COMMIT');

    const nStacco = stacco.rows.reduce((s, r) => s + parseInt(r.n), 0);
    const det = stacco.rows.map(r => `${r.name}: ${r.n}`).join(', ') || '0';
    console.log(`[BurnerIncidence] STACCO ${nStacco} burner margine-100%-bruciato (${det})`);
    if (nStacco > 0) {
      try { await sendTelegram(`🔥 <b>Loop burner margine-100%</b>\nStaccati ${nStacco} burner (margine unitario vero bruciato al 100% dai click, 0 vendite) (${det}). Cap 80/tenant. Riattivazione: scheduler unico (R1 rete / R2 restock / R3 test 5gg/20gg).`); } catch (_) {}
    }
    return { stacco: nStacco };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[BurnerIncidence] ERRORE:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    RUN_HOUR_UTC, RUN_MIN_UTC, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function startBurnerIncidenceCron() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[BurnerIncidence] prossimo run tra ${Math.round(delay / 60000)} min (03:45 UTC / 05:45 IT)`);
    setTimeout(async () => {
      try { await runBurnerIncidence(); } catch (_) { /* già loggato */ }
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startBurnerIncidenceCron, runBurnerIncidence };
