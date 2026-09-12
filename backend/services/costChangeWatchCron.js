/**
 * 💶 GUARDIA G6 — IL LOOP CHE STA ADDOSSO AI CAMBI DI COSTO.
 *
 * Ordine capo 10/09: "io farei un loop supplementare sul controllo dei costi che
 * monitora i cambi costo".
 *
 * Il guardiano dei price cut (productSync + pcGuardianCron) dice COSA fare
 * adesso. Questo dice COSA E' CAMBIATO, e lo dice presto:
 *  - il registro dei costi si riempie anche fuori dal sync prodotti (la spazzata
 *    notturna di costHistoryCron gira 01-06);
 *  - un salto di costo grosso e' una notizia per il capo, non solo lavoro per la
 *    macchina;
 *  - se il cambio ha portato un taglio vivo sotto il minimo, il guardiano viene
 *    chiamato SUBITO su quel tenant, senza aspettare il giro dopo.
 *
 * Ogni 20 min: legge cambi_costo_su_pc(1.5h) (mig 110), scrive gli allarmi nuovi
 * in cambio_costo_allarme (una riga per SKU/fonte/costo/giorno), e se qualcuno e'
 * finito sotto il floor chiama reconfirm_price_cuts_v2 sul tenant.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const EVERY_MS = 20 * 60 * 1000;    // ogni 20 min
const FINESTRA_ORE = 1.5;           // sovrapposta al ciclo: nessun cambio scivola via
const SALTO_GROSSO_PCT = 15;        // sopra questo, il capo lo vuole sapere

async function runCostChangeWatch() {
  const client = await pool.connect();
  try {
    const { rows: cambi } = await client.query(
      'SELECT * FROM cambi_costo_su_pc($1::numeric)', [FINESTRA_ORE]
    );
    if (cambi.length === 0) {
      console.log('[CostChangeWatch] nessun cambio costo su price cut vivi');
      return { cambi: 0, sottoFloor: 0, riparati: 0 };
    }

    // 1) registro: una riga per SKU/fonte/costo/giorno, i doppioni cadono da soli
    let nuovi = 0;
    for (const c of cambi) {
      const { rowCount } = await client.query(
        `INSERT INTO cambio_costo_allarme
           (tenant_id, tenant, sku, source, costo_prima, costo_dopo, delta_pct,
            prezzo_vivo, margine_pct, floor_pct, sotto_floor, azione)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id, sku, source, costo_dopo, giorno) DO NOTHING`,
        [c.tenant_id, c.tenant, c.sku, c.source, c.costo_prima, c.costo_dopo, c.delta_pct,
         c.prezzo_vivo, c.margine_pct, c.floor_pct, c.sotto_floor,
         c.sotto_floor ? 'guardiano chiamato' : 'solo registrato']
      );
      nuovi += rowCount;
    }

    // 2) chi e' finito sotto il minimo va riparato adesso, tenant per tenant
    const tenantiRotti = [...new Set(cambi.filter(c => c.sotto_floor).map(c => c.tenant_id))];
    let riparati = 0;
    for (const tid of tenantiRotti) {
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          'SELECT esito, tenant, n FROM reconfirm_price_cuts_v2(false, $1::uuid, NULL)', [tid]
        );
        await client.query('COMMIT');
        riparati += rows
          .filter(r => r.esito !== 'sano' && r.esito !== 'in_coda')
          .reduce((s, r) => s + parseInt(r.n, 10), 0);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[CostChangeWatch] riparazione fallita su', tid, e.message);
      }
    }

    const sottoFloor = cambi.filter(c => c.sotto_floor).length;
    const salti = cambi.filter(c => Math.abs(parseFloat(c.delta_pct)) >= SALTO_GROSSO_PCT);
    console.log(`[CostChangeWatch] cambi=${cambi.length} nuovi=${nuovi} sotto_floor=${sottoFloor} salti_grossi=${salti.length} riparati=${riparati}`);

    if (nuovi > 0 && (sottoFloor > 0 || salti.length > 0)) {
      const top = salti
        .sort((a, b) => Math.abs(parseFloat(b.delta_pct)) - Math.abs(parseFloat(a.delta_pct)))
        .slice(0, 8)
        .map(c => `${c.tenant} ${c.sku}: ${c.costo_prima}→${c.costo_dopo} (${c.delta_pct > 0 ? '+' : ''}${c.delta_pct}%)`)
        .join('\n');
      try {
        await sendTelegram(
          `💶 <b>Cambi costo su price cut vivi</b> (ultime ${FINESTRA_ORE}h)\n` +
          `Cambiati: ${cambi.length}. Finiti sotto il minimo: ${sottoFloor}. Riparati subito: ${riparati}.` +
          (top ? `\n\n<b>Salti oltre ${SALTO_GROSSO_PCT}%</b>\n<i>${top}</i>` : '')
        );
      } catch (_) {}
    }
    return { cambi: cambi.length, sottoFloor, riparati };
  } catch (e) {
    console.error('[CostChangeWatch] ERRORE:', e.message);
    return null;
  } finally {
    client.release();
  }
}

function startCostChangeWatch() {
  // primo giro tra 6 min (dopo guardiano e sync), poi ogni 20 min
  setTimeout(function tick() {
    runCostChangeWatch().finally(() => setTimeout(tick, EVERY_MS));
  }, 6 * 60 * 1000);
  console.log('[CostChangeWatch] armato — primo giro tra 6 min, poi ogni 20 min');
}

module.exports = { startCostChangeWatch, runCostChangeWatch };
