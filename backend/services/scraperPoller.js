/**
 * Scraper Poller (dictat utente 10/7 sera)
 *
 * "Lo scraper ti consegna ogni 4/5 ore: se tu non lo guardi è un problema
 * tuo." Verificato: file del fornitore alle ~03/08/13/21, ma l'healthCron
 * importava fuori sincrono (slice delle 13:12 in macchina alle 19:00 =
 * ~6h di ritardo sul campo di battaglia intraday).
 *
 * Questo poller importa la cartella globale e, SOLO se è arrivata roba nuova,
 * fa scattare la catena di riprezzo intraday (positionLog + priceJumpMonitor).
 *
 * 📦 11/8/2026 sera, ordine capo: il fornitore è passato a file piccoli
 * (~2.000 prodotti) ogni 15 minuti. Il giro passa da 60 a 5 MINUTI, così una
 * consegna sta in vetrina al massimo 5 minuti dopo essere atterrata.
 *
 * La "slice nuova" non si riconosce più da MAX(scraped_at) ma dai FILE
 * effettivamente ingeriti (registro scraper_files_seen): con la correzione del
 * fuso — i CSV sono ora di Bucarest, UTC+3 — i timestamp nuovi sono 3 ore più
 * indietro dei vecchi, e un confronto su MAX() avrebbe tenuto la catena ferma
 * per tre ore proprio mentre arrivavano dati freschi.
 */

const { pool } = require('../db/pool');
const { importScraperData } = require('./driveScraper');

const POLL_INTERVAL_MS = 5 * 60 * 1000;   // 5 min (consegne ogni 15)
const CATENA_MIN_MS = 30 * 60 * 1000;     // ricalcolo posizioni: max 1 ogni 30 min
const AMNISTIA_MIN_MS = 60 * 60 * 1000;   // amnistia: 1 ogni ora, non a ogni giro

let lastMaxScrape = null;
let running = false;
let ultimaCatena = null;
let catenaInCorso = false;
let ultimaAmnistia = 0;

async function pollScraper() {
  if (running) { console.log('[ScraperPoller] run precedente ancora attivo, skip'); return; }
  running = true;
  try {
    const { rows: [t] } = await pool.query(
      "SELECT id FROM tenants WHERE status='active' ORDER BY name LIMIT 1");
    if (!t) return;
    const inizioGiro = new Date();
    const esito = await importScraperData(t.id);
    const { rows: [m] } = await pool.query('SELECT MAX(scraped_at) AS mx FROM scraper_competitors');
    // Solo righe di DETTAGLIO fanno riprezzo: un top_results.csv aggiorna la
    // mappa dei listing e non sposta un prezzo, non vale 20 minuti di catena.
    const nuovaSlice = (esito && esito.filesProcessed > 0 && esito.entries > 0);
    if (nuovaSlice) {
      console.log(`[ScraperPoller] ${esito.filesProcessed} file nuovi (${esito.entries} righe) → riprezzo intraday immediato`);
      // Storia per slice (griglia 4-aggiornamenti): i nostri merchant di rete
      // fotografati a ogni consegna — senza questa, ogni slice sovrascriveva
      // la precedente e l'erosione intraday era invisibile
      try {
        await pool.query(`
          INSERT INTO scraper_position_history (slice_ts, product_code, merchant, position, base_price)
          SELECT sc.scraped_at, sc.product_code, sc.merchant, sc.position, sc.base_price
          FROM scraper_competitors sc
          WHERE sc.updated_at >= $1
            AND sc.merchant ~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'`,
          [inizioGiro]);
        // 90 giorni di storia posizioni/prezzi nostri (12/7, disco 320GB):
        // il carburante di cut-back prezzi-saliti, banda d'oro e trend
        await pool.query(`DELETE FROM scraper_position_history WHERE created_at < NOW() - INTERVAL '90 days'`);
      } catch (e) { console.error('[ScraperPoller] history err:', e.message); }
      // FRENO SULLA CATENA PESANTE (11/8 sera): positionLog macina ~20 minuti a
      // giro. Agganciata a una consegna ogni 15 minuti si accavalla con sé
      // stessa — misurate 4 esecuzioni contemporanee sul DB. L'import resta a 5
      // minuti (i prezzi in tabella sono sempre freschi), il ricalcolo di
      // posizioni e salti gira al massimo ogni 30 minuti e mai in doppio.
      if (catenaInCorso) {
        console.log('[ScraperPoller] catena posizioni già in corso, salto');
      } else if (ultimaCatena && Date.now() - ultimaCatena < CATENA_MIN_MS) {
        const min = Math.round((CATENA_MIN_MS - (Date.now() - ultimaCatena)) / 60000);
        console.log(`[ScraperPoller] catena posizioni rimandata (${min} min al prossimo giro utile)`);
      } else {
        catenaInCorso = true;
        try {
          const { runPositionLog } = require('./positionLog');
          await runPositionLog();
        } catch (e) { console.error('[ScraperPoller] positionLog err:', e.message); }
        try {
          const { runPriceJumpMonitor } = require('./priceJumpMonitor');
          await runPriceJumpMonitor();
        } catch (e) { console.error('[ScraperPoller] priceJump err:', e.message); }
        ultimaCatena = Date.now();
        catenaInCorso = false;
      }
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
      console.log('[ScraperPoller] nessun file nuovo');
    }
    lastMaxScrape = m.mx || lastMaxScrape;   // solo per diagnostica/log

    // AMNISTIA ORARIA (11/7: 'perché ancora prodotti bloccati?') — i sync
    // orari promuovono prodotti a protetti DOPO i blocchi: la pulizia dei
    // blocchi resi retroattivamente ingiusti non può aspettare le 07:45.
    // Finestra massima di deriva: 1 ora.
    // 27/8: il blocco viveva dentro il giro da 5 minuti e girava 180 volte al
    // giorno invece di 24 — misurati 581.117 UPDATE in 24h sulle stesse ~3.250
    // quarantene, ribloccate dal trigger al giro dopo. Quel WAL a vuoto ha
    // prodotto checkpoint ogni 28 secondi ("checkpoints are occurring too
    // frequently") e 2 deadlock. Ora l'amnistia rispetta l'ora che dichiara.
    if (Date.now() - ultimaAmnistia >= AMNISTIA_MIN_MS) {
      ultimaAmnistia = Date.now();
      try {
        const { rowCount: k } = await pool.query(
          'UPDATE feed_killers fk SET is_active = false WHERE fk.is_active AND is_feed_protected(fk.tenant_id, fk.sku)');
        const { rowCount: q } = await pool.query(
          `UPDATE feed_quarantine fq SET reactivated = true, reactivated_at = NOW()
           WHERE fq.reactivated = false AND is_feed_protected(fq.tenant_id, fq.sku)
             -- P0 26/8: l'amnistia non riapre cio' che e' stato chiuso di
             -- proposito (1.031 burner vivi + 2.493 manual_override misurati
             -- il 27/8). Il trigger ribloccava e la query ritentava a ogni
             -- giro: 3.258 righe riaperte a vuoto ogni volta, 482 legittime.
             AND COALESCE(fq.is_burner_rule, false) = false
             AND COALESCE(fq.manual_override, false) = false`);
        const { rowCount: r } = await pool.query(
          `DELETE FROM feed_actions fa WHERE fa.action = 'REMOVE' AND is_feed_protected(fa.tenant_id, fa.sku)`);
        if (k + q + r > 0) console.log(`[ScraperPoller] amnistia oraria: ${k} killer + ${q} quarantene + ${r} REMOVE liberati`);
      } catch (e) { console.error('[ScraperPoller] amnistia err:', e.message); }
    }
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
  // Ogni 5 minuti: il fornitore consegna ogni 15, così nessuna consegna resta
  // ferma su Drive più di un quarto d'ora. Il guardiano `running` impedisce che
  // due giri si accavallino quando arriva un file grosso.
  setTimeout(() => {
    pollScraper();
    setInterval(pollScraper, POLL_INTERVAL_MS);
  }, 60 * 1000);
  console.log(`[ScraperPoller] attivo — controllo file nuovi ogni ${POLL_INTERVAL_MS / 60000} min, riprezzo su consegna nuova`);
}

module.exports = { pollScraper, startScraperPoller };
