/**
 * Refresh SOLO-ADD delle whitelist forzate del feed.
 *
 * Il problema che risolve (misurato su Papa l'11/8/2026): `feed_test_whitelist`
 * è una fotografia scattata una volta sola. Sui 5 giorni di test 81 SKU rimasti
 * FUORI dalla whitelist hanno comunque fatto 1.909,13 EUR — 56 di questi non
 * avevano mai venduto prima. Più la whitelist invecchia, più venditori
 * dimostrati restano chiusi fuori dalla vetrina: una proroga di 26 giorni
 * significa vendere con una foto vecchia di 26 giorni.
 *
 * Cosa fa, e nient'altro:
 *   per ogni tenant che ha una whitelist forzata ATTIVA (health_config
 *   feed_forced_whitelist non scaduta), aggiunge alla sua label gli SKU che
 *   hanno venduto negli ultimi 7 giorni e che non sono già dentro.
 *
 * Non rimuove MAI nessuno: il taglio deciso dal capo non si riapre da solo.
 * La finestra è 7 giorni e non 90 di proposito — al primo giro non deve
 * ribaltare dentro tutto lo storico e vanificare il taglio; deve far entrare
 * chi vende ADESSO. Da lì in poi la whitelist si tiene aggiornata da sola.
 *
 * Filtro vendibilità identico a quello del builder del feed
 * (routes/externalApi.js): saleable, stock proprio o del grossista, prezzo.
 * Senza, aggiungeremmo SKU che il builder scarterebbe comunque.
 *
 * 📍 GATE POSIZIONE (ordine capo 11/8): rientra solo chi sta in top10 sul
 * prezzo secco, calcolato sul prezzo che il feed manda davvero (price cut
 * incluso) contro scrape fresco ≤48h. Un venditore oltre la decima posizione
 * non prende click: rimetterlo in vetrina è vetrina occupata a vuoto.
 * Qui, a differenza del builder, chi NON ha scrape fresco resta fuori: tenere
 * dentro un dubbio è conservativo, farlo RIENTRARE su un dubbio è spesa nuova.
 *
 * 🔙 Il gate si spegne per singolo tenant con `health_config
 * feed_whitelist_gate_off` (letto con expires_at, come ogni bypass): stesso
 * interruttore del builder, così refresh e feed non dicono cose diverse.
 * Acceso di default.
 */

const { pool } = require('../db/pool');
const rootLogger = require('./logger');
const logger = rootLogger.with({ source: 'whitelistRefresh' });

const CHECK_INTERVAL_MS = 30 * 60 * 1000;   // 30 min, prima del giro di stableCacheCron
const FINESTRA_GIORNI = 7;

// Stati ordine validi — WHITELIST, mai NOT IN (legge del capo: gli annullati
// sono scaricati e congelati, contarli come vendite falsa tutto).
const VALID_STATUSES = ['pending', 'processing', 'complete', 'ritiro_farmacia', 'Ritirato', 'ritiro_sede_tmp'];

let cronTimer = null;

async function runForAll() {
  try {
    const { rows: attive } = await pool.query(`
      SELECT hc.tenant_id, hc.config_value AS label, t.name,
             EXISTS (
               SELECT 1 FROM health_config g
               WHERE g.tenant_id = hc.tenant_id
                 AND g.config_key = 'feed_whitelist_gate_off'
                 AND LOWER(COALESCE(g.config_value, '')) NOT IN ('', '0', 'false', 'off')
                 AND (g.expires_at IS NULL OR g.expires_at > NOW())
             ) AS gate_off
      FROM health_config hc
      JOIN tenants t ON t.id = hc.tenant_id
      WHERE hc.config_key = 'feed_forced_whitelist'
        AND COALESCE(hc.config_value, '') <> ''
        AND (hc.expires_at IS NULL OR hc.expires_at > NOW())
      ORDER BY t.name`);

    if (attive.length === 0) return;

    const righe = [];
    for (const w of attive) {
      try {
        const { rows: aggiunti } = await pool.query(`
          INSERT INTO feed_test_whitelist (tenant_id, test_label, sku)
          SELECT DISTINCT $1::uuid, $2, oi.sku
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          JOIN products p ON p.tenant_id = o.tenant_id AND p.sku = oi.sku
          LEFT JOIN LATERAL (
            SELECT MIN(fa.recommended_price) AS newprice FROM feed_actions fa
            WHERE fa.tenant_id = p.tenant_id AND fa.sku = p.sku
              AND fa.recommended_price IS NOT NULL
              AND fa.action IN ('PRICE_CUT', 'ADD')
          ) pc ON TRUE
          CROSS JOIN LATERAL (
            SELECT COALESCE(pc.newprice, NULLIF(p.applied_price, 0),
                            p.exported_price, p.sell_price) AS pz
          ) v
          WHERE o.tenant_id = $1
            AND o.order_status = ANY($3::text[])
            AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= CURRENT_DATE - $4::int
            AND p.saleable = true
            AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
            AND COALESCE(p.sell_price, 0) > 0
            AND ($5::boolean OR (
              (
                SELECT COUNT(*) FROM scraper_competitors sc
                WHERE sc.product_code = p.sku
                  AND sc.scraped_at > NOW() - INTERVAL '48 hours'
                  AND sc.base_price > 0
                  AND sc.base_price < v.pz
              ) < 10
              AND EXISTS (
                SELECT 1 FROM scraper_competitors sc2
                WHERE sc2.product_code = p.sku
                  AND sc2.scraped_at > NOW() - INTERVAL '48 hours'
                  AND sc2.base_price > 0
              )
            ))
          ON CONFLICT (tenant_id, test_label, sku) DO NOTHING
          RETURNING sku`,
          [w.tenant_id, w.label, VALID_STATUSES, FINESTRA_GIORNI, w.gate_off]);

        if (aggiunti.length > 0) {
          righe.push(`${w.name}=+${aggiunti.length}`);
          logger.info(`${w.name}: ${aggiunti.length} venditori nuovi in whitelist '${w.label}'`,
            { tenantId: w.tenant_id, skus: aggiunti.slice(0, 20).map(r => r.sku) });
        }
      } catch (e) {
        righe.push(`${w.name}=FAIL`);
        logger.error(`${w.name}: ${e.message}`, { tenantId: w.tenant_id }, e);
      }
    }

    if (righe.length > 0) {
      console.log(`[WhitelistRefresh] ${righe.join(' | ')} (finestra ${FINESTRA_GIORNI}gg, solo-ADD)`);
    }
  } catch (e) {
    console.error('[WhitelistRefresh] Fatal:', e.message);
    logger.error(`Fatal: ${e.message}`, null, e);
  }
}

function start() {
  console.log(`[WhitelistRefresh] Started (primo giro fra 90s, poi ogni ${CHECK_INTERVAL_MS / 60000}min)`);
  setTimeout(async () => {
    await runForAll();
    cronTimer = setInterval(runForAll, CHECK_INTERVAL_MS);
  }, 90 * 1000);
}

function stop() {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = null;
}

module.exports = { start, stop, runForAll };
