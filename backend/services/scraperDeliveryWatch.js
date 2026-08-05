/**
 * 📦 SCRAPER DELIVERY WATCH (ordine capo 11/7/2026 sera)
 *
 * "Fai sempre un check una volta ogni ora per vedere se lo scraper ha
 *  consegnato." — La sentinella che è mancata il 9/7, quando il dump si è
 * decimato (104k→7,7k MINSAN) e nessuno se n'è accorto per 2 giorni.
 *
 * Ogni ora (dopo il giro del poller):
 *  - 📦 CONSEGNA PIENA (>100k righe nuove) → conferma Telegram con numeri
 *  - ⚠️ CONSEGNA DECIMATA (nuove righe ma sotto soglia) → allarme
 *  - 🔇 SILENZIO (nessuna slice nuova da >6h; FB consegna ogni 4-5h) → allarme
 * I timestamp scraper sono in ORA ITALIANA (non UTC).
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const SOGLIA_PIENA = 100000;   // righe per considerare la consegna "piena"
// 12/7 sera (capo): lo scraper riattivato consegnerà ~ogni 12h — la soglia
// silenzio segue la nuova cadenza (prima 6h sull'era 4-5h)
const ORE_SILENZIO = 16;

let lastMaxSeen = null; // baseline in RAM (al riavvio riparte dal MAX corrente)

async function runDeliveryWatch() {
  try {
    const { rows: [m] } = await pool.query(
      'SELECT MAX(scraped_at) AS mx FROM scraper_competitors');
    if (!m.mx) return;
    const maxTs = new Date(m.mx);

    // Età della consegna: scraped_at è ora italiana "naive" → confronto con
    // l'ora italiana corrente ricavata dal DB (evita doppi shift)
    const { rows: [e] } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'Europe/Rome') - MAX(scraped_at)))/3600 AS ore
       FROM scraper_competitors`);
    const oreDaUltima = parseFloat(e.ore);

    if (lastMaxSeen === null) {
      lastMaxSeen = maxTs; // baseline post-riavvio: niente allarmi retroattivi
      console.log(`[DeliveryWatch] baseline: ultima slice ${m.mx} (${oreDaUltima.toFixed(1)}h fa)`);
    } else if (maxTs > lastMaxSeen) {
      // SLICE NUOVA dall'ultimo check: quanto ha consegnato?
      const { rows: [n] } = await pool.query(
        `SELECT COUNT(*) AS righe, COUNT(DISTINCT product_code) AS minsan
         FROM scraper_competitors WHERE scraped_at > $1`, [lastMaxSeen]);
      const righe = parseInt(n.righe);
      lastMaxSeen = maxTs;
      if (righe >= SOGLIA_PIENA) {
        console.log(`[DeliveryWatch] 📦 consegna PIENA: ${righe} righe, ${n.minsan} MINSAN`);
        await sendTelegram(
          `📦 <b>Scraper: consegna OK</b> — ${Math.round(righe / 1000)}k prezzi, ${Math.round(parseInt(n.minsan) / 1000)}k MINSAN (slice ${String(m.mx).slice(11, 16)})`,
          { key: 'scraper_delivery_ok', parseMode: 'HTML', throttleMs: 60 * 60 * 1000 });
      } else {
        console.log(`[DeliveryWatch] ⚠️ consegna RIDOTTA: ${righe} righe`);
        await sendTelegram(
          `⚠️ <b>Scraper: consegna RIDOTTA</b> — solo ${righe} righe nuove (${n.minsan} MINSAN), attese >100k.\n` +
          `Possibile nuovo guasto export FB (come il 9/7). Verificare col dev.`,
          { key: 'scraper_delivery_low', parseMode: 'HTML', throttleMs: 4 * 3600 * 1000 });
      }
    } else if (oreDaUltima > ORE_SILENZIO) {
      // Nessuna slice nuova e silenzio oltre soglia
      await sendTelegram(
        `🔇 <b>Scraper: NESSUNA consegna da ${oreDaUltima.toFixed(1)}h</b> (cadenza normale 4-5h).\n` +
        `Ultima slice: ${String(m.mx).slice(0, 16)}. Verificare lato FB.`,
        { key: 'scraper_delivery_silence', parseMode: 'HTML', throttleMs: 4 * 3600 * 1000 });
      console.log(`[DeliveryWatch] 🔇 silenzio da ${oreDaUltima.toFixed(1)}h`);
    } else {
      console.log(`[DeliveryWatch] nessuna slice nuova (ultima ${oreDaUltima.toFixed(1)}h fa, ok)`);
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
  console.log('[DeliveryWatch] 📦 sentinella consegne scraper attiva — check orario');
}

module.exports = { runDeliveryWatch, startScraperDeliveryWatch };
