/**
 * Civetta Gap Monitor (direttiva utente 11/7/2026)
 *
 * "Ogni 3 ore compara civetta FB e civettaAI: dei prodotti che tu NON stai
 * inserendo e Farmabooster sì, capisci cosa puoi recuperare."
 *
 * La magagna scoperta su SubitoFarma (gap ~8.700): 3.560 invendibili +
 * 5.105 SENZA ALCUNA POSIZIONE SCRAPER — il circolo uovo-gallina: niente
 * esposizione → niente click → niente scrape → niente evidenza → esclusi.
 *
 * Ogni 3 ore:
 *  1. Misura il gap per tenant (civetta Magento/FB=1 ma fuori dal nostro CSV)
 *  2. Classifica: invendibili / senza-evidenza / fuori-target / oblio / con-domanda
 *  3. RECUPERO immediato: chi ha domanda di mercato (aggregated>=2) + margine>=15
 *  4. ESPLORAZIONE a rotazione: lotto di test (cap 300/tenant/ciclo) dei
 *     senza-evidenza con margine>=18 e stock — entrano in coorte 14g e si
 *     guadagnano l'evidenza; i motori normali poi li giudicano con dati veri
 *  5. Report Telegram
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const CAP_ESPLORAZIONE = 300;

async function runCivettaGapMonitor() {
  const { rows: tenants } = await pool.query(
    "SELECT id, name FROM tenants WHERE status='active' ORDER BY name");
  const report = [];

  for (const t of tenants) {
    // Floor margine tenant-aware: SubitoFarma lavora all'11% per scelta cliente
    // (eccezione documentata) — il floor 15 uguale-per-tutti le negava 1.483
    // prodotti con domanda di rete (scoperto 11/7)
    const marginFloor = t.name === 'SubitoFarma' ? 11 : 15;
    try {
      const { rows: [g] } = await pool.query(`
        WITH csv AS (SELECT jsonb_array_elements_text(tc.config_value::jsonb->'codes') sku
          FROM tenant_configs tc WHERE tc.tenant_id=$1 AND tc.config_key='stable_feed_codes'),
        gap AS (
          SELECT p.sku, p.sales_30d_aggregated agg, p.margin_pct, p.erp_stock, p.supplier_stock, p.sell_price,
            h.scraper_position pos,
            (m.product_code IS NOT NULL) AS listing_tp
          FROM products p
          LEFT JOIN product_health_scores h ON h.tenant_id=$1 AND h.sku=p.sku
          LEFT JOIN scraper_listing_map m ON m.product_code=p.sku
          WHERE p.tenant_id=$1 AND p.is_civetta=true
            AND NOT EXISTS (SELECT 1 FROM csv WHERE csv.sku=p.sku)),
        recupero AS (
          INSERT INTO activation_cohorts (cohort_name, tenant_id, sku, sell_price, ricarico_pct, scraper_position, erp_stock, note)
          SELECT 'gap_recupero_' || TO_CHAR(NOW(), 'YYYYMMDD'), $1, g.sku, g.sell_price, NULL, g.pos, g.erp_stock,
            'gap civetta: domanda reale (aggregated o ordini di rete 60g)'
          FROM gap g
          WHERE (COALESCE(g.erp_stock,0)+COALESCE(g.supplier_stock,0)) > 0 AND COALESCE(g.sell_price,0) > 0
            AND COALESCE(g.margin_pct,0) >= $2
            -- Domanda REALE (fix 11/7: aggregated è sparso — 17 su 5.100 nel gap SF!):
            -- aggregated >= 2 OPPURE ordini di RETE negli ultimi 60 giorni
            AND (COALESCE(g.agg,0) >= 2 OR EXISTS (
              SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id
              WHERE oi.sku=g.sku AND o.order_date >= NOW()-INTERVAL '60 days'
                AND o.order_status NOT IN ('canceled','closed')))
            AND NOT EXISTS (SELECT 1 FROM activation_cohorts ac WHERE ac.tenant_id=$1 AND ac.sku=g.sku
              AND ac.activated_at >= NOW()-INTERVAL '14 days')
            AND NOT EXISTS (SELECT 1 FROM cross_tenant_oblio o WHERE o.sku=g.sku AND o.status='active')
          ORDER BY COALESCE(g.margin_pct,0) DESC
          -- cap giornaliero di gradualita: 400/tenant/giorno
          LIMIT GREATEST(0, 400 - (
            SELECT COUNT(*) FROM activation_cohorts ac4
            WHERE ac4.tenant_id=$1 AND ac4.cohort_name='gap_recupero_' || TO_CHAR(NOW(), 'YYYYMMDD')))
          RETURNING 1),
        esplorazione AS (
          INSERT INTO activation_cohorts (cohort_name, tenant_id, sku, sell_price, ricarico_pct, scraper_position, erp_stock, note)
          SELECT 'gap_esplora_' || TO_CHAR(NOW(), 'YYYYMMDD'), $1, g.sku, g.sell_price, NULL, g.pos, g.erp_stock,
            CASE WHEN g.listing_tp THEN 'esplorazione: listing TP reale, dettaglio mai arrivato'
                 ELSE 'esplorazione: listing TP mai visto dallo scraper' END
          FROM gap g
          WHERE (COALESCE(g.erp_stock,0)+COALESCE(g.supplier_stock,0)) > 0 AND COALESCE(g.sell_price,0) > 0
            AND g.pos IS NULL AND COALESCE(g.margin_pct,0) >= 18
            AND NOT EXISTS (SELECT 1 FROM activation_cohorts ac WHERE ac.tenant_id=$1 AND ac.sku=g.sku
              AND ac.activated_at >= NOW()-INTERVAL '14 days')
            AND NOT EXISTS (SELECT 1 FROM cross_tenant_oblio o WHERE o.sku=g.sku AND o.status='active')
          -- Prima i listing che TP HA GIÀ (domanda dimostrata dal mercato),
          -- a parità di ciò il margine più alto
          ORDER BY g.listing_tp DESC, COALESCE(g.margin_pct,0) DESC
          -- cap GIORNALIERO (gradualità): 300/tenant/GIORNO, non per ciclo
          LIMIT GREATEST(0, ${CAP_ESPLORAZIONE} - (
            SELECT COUNT(*) FROM activation_cohorts ac3
            WHERE ac3.tenant_id=$1 AND ac3.cohort_name='gap_esplora_' || TO_CHAR(NOW(), 'YYYYMMDD')))
          RETURNING 1)
        SELECT
          (SELECT COUNT(*) FROM gap) gap_tot,
          (SELECT COUNT(*) FROM gap WHERE (COALESCE(erp_stock,0)+COALESCE(supplier_stock,0))=0 OR COALESCE(sell_price,0)=0) invendibili,
          (SELECT COUNT(*) FROM gap WHERE (COALESCE(erp_stock,0)+COALESCE(supplier_stock,0))>0 AND COALESCE(sell_price,0)>0 AND pos IS NULL AND listing_tp) dettaglio_in_rotazione,
          (SELECT COUNT(*) FROM gap WHERE (COALESCE(erp_stock,0)+COALESCE(supplier_stock,0))>0 AND COALESCE(sell_price,0)>0 AND pos IS NULL AND NOT listing_tp) senza_listing_tp,
          (SELECT COUNT(*) FROM recupero) recuperati,
          (SELECT COUNT(*) FROM esplorazione) in_esplorazione`,
        [t.id, marginFloor]);
      if (parseInt(g.gap_tot) > 0) {
        report.push(`${t.name}: gap ${g.gap_tot} (invend. ${g.invendibili}, dett.rotazione ${g.dettaglio_in_rotazione}, no-listing ${g.senza_listing_tp}) → recuperati ${g.recuperati}, esplorazione ${g.in_esplorazione}`);
      }
    } catch (e) {
      console.error(`[CivettaGap] ${t.name} err:`, e.message);
      report.push(`${t.name}: errore ${e.message.slice(0, 40)}`);
    }
  }

  console.log('[CivettaGap]', report.join(' | ') || 'nessun gap');
  if (report.length > 0) {
    try {
      await sendTelegram(`🔬 <b>CIVETTA GAP (loop 3h)</b>\n${report.join('\n')}`,
        { key: 'civetta_gap', parseMode: 'HTML', throttleMs: 3 * 3600 * 1000 });
    } catch {}
  }
  return report;
}

let cronStarted = false;

function startCivettaGapMonitor() {
  if (cronStarted) return;
  cronStarted = true;
  setTimeout(() => {
    runCivettaGapMonitor().catch(e => console.error('[CivettaGap] err:', e.message));
    setInterval(() => {
      runCivettaGapMonitor().catch(e => console.error('[CivettaGap] err:', e.message));
    }, 3 * 60 * 60 * 1000);
  }, 8 * 60 * 1000);
  console.log('[CivettaGap] attivo — comparazione civetta FB vs civettaAI ogni 3h + recupero/esplorazione');
}

module.exports = { runCivettaGapMonitor, startCivettaGapMonitor };
