/**
 * 🔁 DECADIMENTO PRICE CUT (requisito capo 16/7)
 *
 * "Un PC attivato che non converte in un tempo ragionevole va staccato dal
 *  feed. Ma le azioni non si sovrappongono: chi è staccato NON torna il giorno
 *  dopo — ha una data di retesting a 15/30gg, e non ci si pesta i piedi."
 *
 * Ripristina il gate 'low_click_no_conversion' che viveva nel vecchio
 * feedEngine.js (computeFeedActions), non più chiamato dalla pipeline da giugno
 * (deprecato a favore di runDailyFeedEngine, che non l'ha ereditato).
 *
 * Ogni notte alle 03:30 UTC (05:30 IT) — zombie_clicks già rinfrescato, PRIMA
 * dell'igiene delle 06:00 — per ogni tenant operational, in UNA transazione:
 *
 *   1) RETEST: le diete 'pc_no_conversion_decay' scadute (quarantine_end < ora)
 *      vengono rilasciate (reactivated=true): il prodotto rientra nel pool e i
 *      motori lo ri-valutano. Se converte resta, se ri-fallisce ri-decade.
 *
 *   2) STACCO margine-first: i PC attivi (feed_actions recommended_price +
 *      action PRICE_CUT/ADD) che hanno consumato il loro budget-click
 *      (margine_vero/CPC × 1.5) con ZERO vendite reali in 30g, non protetti
 *      (is_feed_protected: carrello/brand/stock/seller), vengono messi in dieta
 *      'pc_no_conversion_decay' con quarantine_end = NOW()+21g e
 *      manual_override=true. I motori già saltano le diete reactivated=false →
 *      NESSUN loop lo ri-pesca prima del retest. Cap 80/tenant/giorno.
 *
 * Periodo di grazia: uno SKU ri-testato negli ultimi 14g non viene ri-staccato
 * (deve accumulare nuovi click e avere una vera seconda chance).
 *
 * Un solo padrone, tutto firmato a verbale (Arbitro). Fatturato blindato:
 * si stacca solo chi non ha venduto NULLA localmente e non è protetto.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const TENANT_OPERATIONAL = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF',
  'Farmainsieme', 'Farmastelia', 'Farmacia Mandanici'];
const MAX_PER_TENANT = 80;
const RETEST_DAYS = 21;      // cooldown prima del retesting (dentro il 15-30 del capo)
const GRACE_DAYS = 14;       // grazia post-retest: non ri-staccare subito
const CPC_GROSS = 0.3294;    // CPC lordo IVA-incl (costo vero del click)
const BUDGET_MULT = 1.5;     // Bibbia margine-first: soglia kill = margine/CPC × 1.5
const RUN_HOUR_UTC = 3;
const RUN_MIN_UTC = 30;

async function runPcDecay() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('xhp.writer', 'pc_decay_cron', true),
      set_config('xhp.motivo', 'requisito capo 16/7: PC che consuma budget-click senza convertire -> dieta con retest 21g (no sovrapposizione loop)', true)`);

    // 1) RETEST: rilascia le diete decadute (quarantine_end passato)
    const retest = await client.query(`
      UPDATE feed_quarantine SET reactivated = true, reactivated_at = NOW()
      WHERE reason = 'pc_no_conversion_decay' AND reactivated = false
        AND quarantine_end < NOW()
        AND tenant_id IN (SELECT id FROM tenants WHERE name = ANY($1))
      RETURNING tenant_id`, [TENANT_OPERATIONAL]);

    // 2) STACCO: PC morti (budget consumato, 0 vendite locali, non protetti, non in grazia)
    const stacco = await client.query(`
      WITH op AS (
        SELECT id tid FROM tenants t WHERE t.status = 'active' AND t.name = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM health_config hcx WHERE hcx.tenant_id=t.id AND hcx.config_key='tp_budget_exhausted' AND hcx.config_value='1' AND (hcx.expires_at IS NULL OR hcx.expires_at > NOW()))),
      pc AS (
        SELECT DISTINCT fa.tenant_id tid, fa.sku FROM feed_actions fa
        WHERE fa.recommended_price IS NOT NULL AND fa.action IN ('PRICE_CUT','ADD')
          AND fa.tenant_id IN (SELECT tid FROM op)),
      ck AS (
        SELECT tenant_id tid, product_code sku, SUM(clicks) c30 FROM zombie_clicks
        WHERE fetch_date >= CURRENT_DATE - 30 AND tenant_id IN (SELECT tid FROM op)
        GROUP BY 1, 2),
      cand AS (
        SELECT pc.tid, pc.sku, ck.c30,
          ROW_NUMBER() OVER (PARTITION BY pc.tid ORDER BY ck.c30 DESC) rk
        FROM pc JOIN ck ON ck.tid = pc.tid AND ck.sku = pc.sku
        WHERE ck.c30 >= GREATEST(8, margine_unitario_vero(pc.tid, pc.sku) / ${CPC_GROSS} * ${BUDGET_MULT})
          -- 0 vendite reali locali 30g (whitelist stati)
          AND NOT EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
              WHERE o.tenant_id = pc.tid AND oi.sku = pc.sku
                AND o.order_date >= NOW() - INTERVAL '15 days'
                AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato'))
          -- protezioni unificate (carrello/brand/stock/seller-posizionato)
          AND NOT is_feed_protected(pc.tid, pc.sku)
          -- non già in dieta (qualsiasi)
          AND NOT EXISTS (SELECT 1 FROM feed_quarantine q
              WHERE q.tenant_id = pc.tid AND q.sku = pc.sku AND q.reactivated = false)
          -- grazia: non ri-staccare chi è stato ri-testato di recente
          AND NOT EXISTS (SELECT 1 FROM feed_quarantine q2
              WHERE q2.tenant_id = pc.tid AND q2.sku = pc.sku
                AND q2.reason = 'pc_no_conversion_decay' AND q2.reactivated = true
                AND q2.reactivated_at > NOW() - INTERVAL '${GRACE_DAYS} days')),
      ins AS (
        INSERT INTO feed_quarantine (tenant_id, sku, reason, quarantine_start, quarantine_end,
          reactivated, manual_override, manual_override_at, quarantine_level)
        SELECT tid, sku, 'pc_no_conversion_decay', NOW(), NOW() + INTERVAL '${RETEST_DAYS} days',
          false, true, NOW(), 2
        FROM cand WHERE rk <= $2
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          reason = 'pc_no_conversion_decay', quarantine_start = NOW(),
          quarantine_end = NOW() + INTERVAL '${RETEST_DAYS} days',
          reactivated = false, reactivated_at = NULL,
          manual_override = true, manual_override_at = NOW(), quarantine_level = 2
        RETURNING tenant_id, sku)
      SELECT t.name, COUNT(*) n FROM ins JOIN tenants t ON t.id = ins.tenant_id
      GROUP BY t.name ORDER BY n DESC`,
      [TENANT_OPERATIONAL, MAX_PER_TENANT]);

    await client.query('COMMIT');

    const nStacco = stacco.rows.reduce((s, r) => s + parseInt(r.n), 0);
    const nRetest = retest.rows.length;
    const det = stacco.rows.map(r => `${r.name}: ${r.n}`).join(', ') || '0';
    console.log(`[PcDecay] STACCO ${nStacco} PC no-conversion (${det}) | RETEST ${nRetest} rilasciati (cooldown ${RETEST_DAYS}g scaduto)`);
    if (nStacco > 0 || nRetest > 0) {
      try {
        await sendTelegram(`🔁 <b>Decadimento PC</b>\nStaccati ${nStacco} price cut che consumano budget senza convertire (${det}).\nRe-immessi al retest: ${nRetest} (cooldown ${RETEST_DAYS}g).`);
      } catch (_) { /* telegram best-effort */ }
    }
    return { stacco: nStacco, retest: nRetest };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[PcDecay] ERRORE:', err.message);
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

function startPcDecayCron() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[PcDecay] prossimo run tra ${Math.round(delay / 60000)} min (03:30 UTC / 05:30 IT)`);
    setTimeout(async () => {
      try { await runPcDecay(); } catch (_) { /* già loggato */ }
      schedule(); // ri-schedula il giorno dopo
    }, delay);
  };
  schedule();
}

module.exports = { startPcDecayCron, runPcDecay };
