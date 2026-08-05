/**
 * 🛡️ GUARDIANO PC (ordine capo 24/7) — "ogni PC va confermato a ogni loop".
 *
 * Il costo d'acquisto è una SERIE TEMPORALE: un PC fatto quando il prodotto era
 * in magazzino (costo farmacia basso) diventa una trappola quando il magazzino
 * finisce e si compra da grossista (costo su) → il prezzo tagliato non tiene più
 * il margine. Ambito (scelto dal capo): SOLO aumento-costo (protezione pura).
 *
 * Ogni 2h ricalcola costo_vero del momento per ogni PC attivo (funzione DB
 * reconfirm_price_cuts, mig 073): se il costo è salito oltre la baseline e il
 * margine sfonda il floor (25/19/16/13/11% per fascia), RIALZA al prezzo
 * floor-safe se resta competitivo, altrimenti RITIRA il PC (torna a regola FB).
 * SubitoFarma escluso (eccezione floor cliente). Firmato writer sessione_.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const EVERY_MS = 2 * 60 * 60 * 1000;   // ogni 2h

async function runPcGuardian() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT azione, tenant, n FROM reconfirm_price_cuts(false)');
    await client.query('COMMIT');

    const sum = (a) => rows.filter(r => r.azione === a).reduce((s, r) => s + parseInt(r.n), 0);
    const revised = sum('revised');
    const withdrawn = sum('withdrawn');
    if (revised > 0 || withdrawn > 0) {
      const det = rows.filter(r => r.n > 0).map(r => `${r.azione}/${r.tenant}:${r.n}`).join(', ');
      console.log(`[PcGuardian] costo salito: rialzati floor-safe=${revised}, ritirati=${withdrawn} | ${det}`);
      try {
        await sendTelegram(`🛡️ <b>Guardiano PC</b> (costo salito → margine a rischio)\nRialzati floor-safe: ${revised}. Ritirati (non più competitivi in margine): ${withdrawn}.\n<i>${det}</i>`);
      } catch (_) {}
    } else {
      console.log('[PcGuardian] ok — nessun PC sotto floor per aumento-costo');
    }
    return { revised, withdrawn };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[PcGuardian] ERRORE:', e.message);
    return null;
  } finally {
    client.release();
  }
}

function startPcGuardian() {
  // primo giro tra 3 min (dopo il boot), poi ogni 2h
  setTimeout(function tick() {
    runPcGuardian().finally(() => setTimeout(tick, EVERY_MS));
  }, 3 * 60 * 1000);
  console.log('[PcGuardian] armato — primo giro tra 3 min, poi ogni 2h');
}

module.exports = { startPcGuardian, runPcGuardian };
