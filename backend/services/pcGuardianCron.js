/**
 * 🛡️ GUARDIANO PC v2 (ordine capo 10/09) — "ad ogni loop di dati i pc vengono
 * ricontrollati in base al costo attuale e ricalcolati o cancellati".
 *
 * Il costo d'acquisto è una SERIE TEMPORALE: un PC fatto quando il prodotto era
 * in magazzino (costo farmacia basso) diventa una trappola quando il magazzino
 * finisce e si ricompra da grossista (costo su) → il prezzo tagliato non tiene
 * più il margine e il prodotto esce sotto costo.
 *
 * Il posto vero del guardiano è dentro productSync.js: gira per ogni tenant
 * subito dopo l'import dei costi nuovi (reconfirmPriceCuts). Questo cron resta
 * come RETE DI SICUREZZA di rete: se un sync salta (circuit breaker FB aperto,
 * lock zombie, import fallito) i PC non restano scoperti più di 2h.
 *
 * v2 (mig 108) rispetto alla v1 (mig 073):
 *  - perimetro: TUTTI i PC vivi dei 7 tenant operativi, non solo le 8 sorgenti AI
 *    (1.243 PC capo_%/pulizia_% erano invisibili al guardiano);
 *  - niente baseline che condona: il giudizio è sul costo di RIACQUISTO di ADESSO,
 *    non su "il costo è salito rispetto a quando l'ho registrato";
 *  - SubitoFarma dentro con il suo floor 11% (eccezione cliente), non escluso;
 *  - mano umana (manual, manual_review, capo_pin) NON piu' esente (ordine capo
 *    10/09: "non esiste nessun veto o nessun ordine manuale che puo' bloccare il
 *    ricalcolo di un prezzo ai che va sotto floor"), ma segnata nel log;
 *  - legge del costo: non si calcola un prezzo su un costo vecchio (>12h); se e'
 *    gia' sotto il minimo si cancella, che non richiede alcun calcolo;
 *  - il rialzo di riparazione passa il veto universale SOLO se è il costo ad aver
 *    portato il margine sotto il minimo, e solo fino al minimo (ordine capo 10/09);
 *  - se non si può riparare senza superare il listino FB, il PC si CANCELLA
 *    (copia integrale in pc_guardian_cestino: la mossa è reversibile);
 *  - i numeri riportati sono quelli SCRITTI, non la classificazione pre-scrittura
 *    (la v1 contava i "revised" prima del veto, e il log diceva il falso).
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const EVERY_MS = 2 * 60 * 60 * 1000;   // ogni 2h
// Legge capo 10/09: tutti i PC a ogni giro, nessun tetto. Il parametro resta
// solo come freno d'emergenza se un giorno servisse.
const CAP_PER_TENANT = null;

async function runPcGuardian() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT esito, tenant, n FROM reconfirm_price_cuts_v2(false, NULL, $1::int)',
      [CAP_PER_TENANT]
    );
    await client.query('COMMIT');

    const sum = (e) => rows.filter(r => r.esito === e).reduce((s, r) => s + parseInt(r.n, 10), 0);
    const giu = sum('ricalcolato_giu');
    const rialzo = sum('rialzo_riparazione');
    const cancellati = sum('cancellato') + sum('cancellato_veto')
                     + sum('cancellato_dato_assente') + sum('cancellato_costo_vecchio')
                     + sum('cancellato_regola_fb');
    const costoVecchio = sum('fermo_costo_vecchio') + sum('cancellato_costo_vecchio');
    // Mig 113/114: muro e sconto non si toccano. Il PC che entra in muro muore,
    // la ADD resta nel feed ma perde il prezzo.
    const regolaFb = sum('cancellato_regola_fb');
    const addSenzaPrezzo = sum('prezzo_add_annullato');
    const coda = sum('in_coda');

    const toccati = giu + rialzo + cancellati + addSenzaPrezzo;

    if (toccati > 0) {
      const det = rows
        .filter(r => parseInt(r.n, 10) > 0 && ['ricalcolato_giu', 'rialzo_riparazione', 'cancellato', 'cancellato_veto', 'cancellato_dato_assente', 'cancellato_costo_vecchio', 'cancellato_regola_fb', 'prezzo_add_annullato'].includes(r.esito))
        .map(r => `${r.esito}/${r.tenant}:${r.n}`)
        .join(', ');
      console.log(`[PcGuardian] rete di sicurezza: giu=${giu}, rialzo_riparazione=${rialzo}, cancellati=${cancellati} (regola_fb=${regolaFb}), add_senza_prezzo=${addSenzaPrezzo}, costo_vecchio=${costoVecchio}, in_coda=${coda} | ${det}`);
      try {
        await sendTelegram(
          `🛡️ <b>Guardiano PC</b> (rete di sicurezza 2h — il sync non li aveva coperti)\n` +
          `Ricalcolati giù: ${giu}. Rialzati al minimo consentito: ${rialzo}. Cancellati: ${cancellati}${regolaFb > 0 ? ` (${regolaFb} finiti in regola muro/sconto)` : ''}.` +
          (addSenzaPrezzo > 0 ? `\nADD lasciate nel feed ma senza prezzo: ${addSenzaPrezzo}.` : '') +
          (coda > 0 ? `\nIn coda al prossimo giro: ${coda}.` : '') +
          (costoVecchio > 0 ? `\n⚠️ Costo non aggiornato da oltre 12h su ${costoVecchio}: nessun prezzo calcolato su costo vecchio.` : '') +
          `\n<i>${det}</i>`
        );
      } catch (_) {}
    } else {
      console.log('[PcGuardian] ok — nessun PC fuori floor sul costo di adesso');
    }
    return { giu, rialzo, cancellati, regolaFb, addSenzaPrezzo, costoVecchio, coda };
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
  console.log('[PcGuardian] armato v2 — rete di sicurezza: primo giro tra 3 min, poi ogni 2h');
}

module.exports = { startPcGuardian, runPcGuardian };
