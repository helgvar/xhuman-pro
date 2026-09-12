/**
 * 📦 SCRAPER DELIVERY WATCH v2 (ordine capo 12/8/2026 sera)
 *
 * "Ti arriveranno più consegne più veloci, non solo una ogni 4 ore:
 *  devi aggiornare sempre guardando la data."
 *
 * Dal 11/8 lo scraper consegna file piccoli (~2.000 prodotti) a flusso
 * quasi continuo (gap massimo osservato ~3h), non più dump da >100k righe
 * ogni 4-12h. Contare le righe "per consegna" non significa più niente e
 * generava falsi allarmi "consegna RIDOTTA": il giudizio si fa sulle
 * FINESTRE DI DATA.
 *
 * Ogni ora:
 *  - 🔇 SILENZIO: nessuna riga nuova da >4h (gap normale <3h) → allarme
 *  - ⚠️ DECIMAZIONE: copertura rotante 24h sotto 60k MINSAN distinti
 *    (rotazione sana ~110k; il 9/7 crollò a 7,7k) → allarme
 *  - ✅ RIENTRO: primo check verde dopo un allarme → conferma
 * Niente più ping orario "consegna OK": parla solo quando cambia qualcosa.
 * I timestamp scraper sono in ORA ITALIANA (non UTC).
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const ORE_SILENZIO = 4;            // gap max osservato 2,9h → oltre 4h è anomalia
const SOGLIA_MINSAN_24H = 60000;   // rotazione sana ~110k MINSAN/24h

let statoAllarme = false; // in RAM: al riavvio riparte verde (niente allarmi retroattivi)

async function runDeliveryWatch() {
  try {
    // scraped_at è ora italiana "naive" → confronto con l'ora italiana
    // corrente ricavata dal DB (evita doppi shift)
    const { rows: [f] } = await pool.query(
      `SELECT MAX(scraped_at) AS ultima,
              EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'Europe/Rome') - MAX(scraped_at)))/3600 AS ore
       FROM scraper_competitors`);
    if (!f.ultima) return;
    const oreDaUltima = parseFloat(f.ore);

    const { rows: [c] } = await pool.query(
      `SELECT COUNT(DISTINCT product_code) AS minsan, COUNT(*) AS righe
       FROM scraper_competitors
       WHERE scraped_at > (NOW() AT TIME ZONE 'Europe/Rome') - interval '24 hours'`);
    const minsan24 = parseInt(c.minsan);
    const righe24 = parseInt(c.righe);

    if (oreDaUltima > ORE_SILENZIO) {
      statoAllarme = true;
      console.log(`[DeliveryWatch] 🔇 silenzio da ${oreDaUltima.toFixed(1)}h`);
      await sendTelegram(
        `🔇 <b>Scraper: NESSUNA consegna da ${oreDaUltima.toFixed(1)}h</b> (flusso continuo, gap normale &lt;3h).\n` +
        `Ultima riga: ${String(f.ultima).slice(0, 16)}. Verificare lato FB.`,
        { key: 'scraper_delivery_silence', parseMode: 'HTML', throttleMs: 4 * 3600 * 1000 });
    } else if (minsan24 < SOGLIA_MINSAN_24H) {
      statoAllarme = true;
      console.log(`[DeliveryWatch] ⚠️ copertura 24h decimata: ${minsan24} MINSAN`);
      await sendTelegram(
        `⚠️ <b>Scraper: copertura 24h DECIMATA</b> — ${Math.round(minsan24 / 1000)}k MINSAN distinti ` +
        `(rotazione sana ~110k, soglia 60k).\nPossibile guasto export FB (come il 9/7). Verificare col dev.`,
        { key: 'scraper_delivery_low', parseMode: 'HTML', throttleMs: 4 * 3600 * 1000 });
    } else if (statoAllarme) {
      statoAllarme = false;
      console.log(`[DeliveryWatch] ✅ rientro: ${minsan24} MINSAN/24h, ultima ${oreDaUltima.toFixed(1)}h fa`);
      await sendTelegram(
        `✅ <b>Scraper: flusso rientrato</b> — ${Math.round(minsan24 / 1000)}k MINSAN/24h ` +
        `(${Math.round(righe24 / 1000)}k prezzi), ultima consegna ${Math.round(oreDaUltima * 60)} min fa.`,
        { key: 'scraper_delivery_recover', parseMode: 'HTML', throttleMs: 60 * 60 * 1000 });
    } else {
      console.log(`[DeliveryWatch] ok — ${minsan24} MINSAN/24h, ultima ${oreDaUltima.toFixed(1)}h fa`);
    }
  } catch (err) {
    console.error('[DeliveryWatch] err:', err.message);
  }
}

let started = false;
function startScraperDeliveryWatch() {
  if (started) return;
  started = true;
  // 8 min dopo il boot (il poller gira a +5) poi ogni ora
  setTimeout(() => {
    runDeliveryWatch();
    setInterval(runDeliveryWatch, 60 * 60 * 1000);
  }, 8 * 60 * 1000);
  console.log('[DeliveryWatch] 📦 sentinella consegne scraper v2 attiva — check orario su finestre di data');
}

module.exports = { runDeliveryWatch, startScraperDeliveryWatch };
