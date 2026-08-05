/**
 * Scraper Poller (dictat utente 10/7 sera)
 *
 * "Lo scraper ti consegna ogni 4/5 ore: se tu non lo guardi è un problema
 * tuo." Verificato: file del fornitore alle ~03/08/13/21, ma l'healthCron
 * importava fuori sincrono (slice delle 13:12 in macchina alle 19:00 =
 * ~6h di ritardo sul campo di battaglia intraday).
 *
 * Questo poller ogni ora: importa la cartella globale e, SOLO se è arrivata
 * una slice nuova (MAX(scraped_at) avanzato), fa scattare la catena di
 * riprezzo intraday (positionLog + priceJumpMonitor). Ritardo massimo
 * file→reazione: ~1 ora.
 */

const { pool } = require('../db/pool');
const { importScraperData } = require('./driveScraper');

let lastMaxScrape = null;
let running = false;

async function pollScraper() {
  if (running) { console.log('[ScraperPoller] run precedente ancora attivo, skip'); return; }
  running = true;
  try {
    const { rows: [t] } = await pool.query(
      "SELECT id FROM tenants WHERE status='active' ORDER BY name LIMIT 1");
    if (!t) return;
    await importScraperData(t.id);
    const { rows: [m] } = await pool.query('SELECT MAX(scraped_at) AS mx FROM scraper_competitors');
    const nuovaSlice = lastMaxScrape && m.mx && new Date(m.mx) > new Date(lastMaxScrape);
    if (nuovaSlice) {
      console.log(`[ScraperPoller] SLICE NUOVA (${m.mx}) → riprezzo intraday immediato`);
      // Storia per slice (griglia 4-aggiornamenti): i nostri merchant di rete
      // fotografati a ogni consegna — senza questa, ogni slice sovrascriveva
      // la precedente e l'erosione intraday era invisibile
      try {
        await pool.query(`
          INSERT INTO scraper_position_history (slice_ts, product_code, merchant, position, base_price)
          SELECT sc.scraped_at, sc.product_code, sc.merchant, sc.position, sc.base_price
          FROM scraper_competitors sc
          WHERE sc.scraped_at > $1
            AND sc.merchant ~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'`,
          [lastMaxScrape]);
        // 90 giorni di storia posizioni/prezzi nostri (12/7, disco 320GB):
        // il carburante di cut-back prezzi-saliti, banda d'oro e trend
        await pool.query(`DELETE FROM scraper_position_history WHERE created_at < NOW() - INTERVAL '90 days'`);
      } catch (e) { console.error('[ScraperPoller] history err:', e.message); }
      try {
        const { runPositionLog } = require('./positionLog');
        await runPositionLog();
      } catch (e) { console.error('[ScraperPoller] positionLog err:', e.message); }
      try {
        const { runPriceJumpMonitor } = require('./priceJumpMonitor');
        await runPriceJumpMonitor();
      } catch (e) { console.error('[ScraperPoller] priceJump err:', e.message); }
      // MURO SCAVALCO — ricontrollo a ogni slice nuova (ordine capo 12/7):
      // se il prezzo regola FB si è RIALLINEATO da solo (sell_price sceso
      // a/adiacente al nostro target), lo scavalco non serve più: si ritira
      // e NON glielo ripassiamo. Via anche i neutralizzati dal veto.
      let ritirati = 0;
      const csent = await pool.connect();
      try {
        await csent.query('BEGIN');
        await csent.query(`SELECT set_config('xhp.writer', 'sentinella_riallineo_muri', true),
          set_config('xhp.motivo', 'regola FB riallineata sotto il target: scavalco non serve piu', true)`);
        ({ rowCount: ritirati } = await csent.query(`
          DELETE FROM feed_actions fa
          USING products p
          WHERE fa.action_source = 'muro_scavalco' AND fa.action = 'PRICE_CUT'
            AND p.tenant_id = fa.tenant_id AND p.sku = fa.sku
            AND (fa.recommended_price IS NULL
                 -- FB riallineato = la sua regola batte il muro DA SOLA
                 -- (strettamente sotto il nostro target; sui muri sell_price
                 -- è PARI al muro per definizione: il vecchio +0.01 ritirava
                 -- tutto all'istante — bug 13/7)
                 OR p.sell_price < fa.recommended_price)`));
        await csent.query('COMMIT');
      } catch (e) {
        await csent.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { csent.release(); }
      try {
        if (ritirati > 0) {
          console.log(`[ScraperPoller] muro-scavalco: ${ritirati} ritirati (FB riallineato o veto)`);
          try {
            const { sendTelegram } = require('./telegramNotifier');
            await sendTelegram(`🧱 Muro-scavalco: ${ritirati} prezzi ritirati — la regola FB si è riallineata da sola, non glieli ripassiamo (ordine 12/7)`,
              { key: 'muro_realign', throttleMs: 6 * 3600 * 1000 });
          } catch {}
        }
      } catch (e) { console.error('[ScraperPoller] muro realign err:', e.message); }
    } else {
      console.log('[ScraperPoller] nessuna slice nuova');
    }
    lastMaxScrape = m.mx || lastMaxScrape;

    // AMNISTIA ORARIA (11/7: 'perché ancora prodotti bloccati?') — i sync
    // orari promuovono prodotti a protetti DOPO i blocchi: la pulizia dei
    // blocchi resi retroattivamente ingiusti non può aspettare le 07:45.
    // Finestra massima di deriva: 1 ora.
    try {
      const { rowCount: k } = await pool.query(
        'UPDATE feed_killers fk SET is_active = false WHERE fk.is_active AND is_feed_protected(fk.tenant_id, fk.sku)');
      const { rowCount: q } = await pool.query(
        `UPDATE feed_quarantine fq SET reactivated = true, reactivated_at = NOW()
         WHERE fq.reactivated = false AND is_feed_protected(fq.tenant_id, fq.sku)`);
      const { rowCount: r } = await pool.query(
        `DELETE FROM feed_actions fa WHERE fa.action = 'REMOVE' AND is_feed_protected(fa.tenant_id, fa.sku)`);
      if (k + q + r > 0) console.log(`[ScraperPoller] amnistia oraria: ${k} killer + ${q} quarantene + ${r} REMOVE liberati`);
    } catch (e) { console.error('[ScraperPoller] amnistia err:', e.message); }
  } catch (e) {
    console.error('[ScraperPoller] err:', e.message);
  } finally {
    running = false;
  }
}

let cronStarted = false;

function startScraperPoller() {
  if (cronStarted) return;
  cronStarted = true;
  // Ogni ora al minuto :50 (i file arrivano a inizio ora: :00-:15)
  setTimeout(() => {
    pollScraper();
    setInterval(pollScraper, 60 * 60 * 1000);
  }, 5 * 60 * 1000);
  console.log('[ScraperPoller] attivo — import orario, riprezzo su slice nuova');
}

module.exports = { pollScraper, startScraperPoller };
