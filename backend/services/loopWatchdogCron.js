/**
 * 🐕 IL CANE DA GUARDIA DEI LOOP — mig 117.
 *
 * Ordine capo 10/09: "crea un monitor che controlla ogni ora tutti i loop e
 * sblocca quelli bloccati."
 *
 * Il fatto: 5 products_sync fermi in 'running'/'pending' da 14-25 giorni
 * (Mandanici 612h, Farmacri 488h e 364h, Papa 340h, SubitoFarma 339h). Nessuno
 * li chiude — farmaboosterProducts.js e magentoOrders.js scrivono lo stato
 * finale solo dentro il proprio ciclo, e quei processi sono morti col container
 * settimane fa. Misurato: non bloccavano i sync nuovi, ma avvelenano ogni
 * lettura di "c'e' un sync in volo?", compresa quella che decide se si puo'
 * fare un restart.
 *
 * Ogni ora fa tre cose, in ordine di quanto sono sicure:
 *
 *  1. JOB ZOMBIE — un import_job piu' vecchio della sua soglia viene chiuso
 *     'failed' con il motivo scritto dentro error_message. Le soglie vengono
 *     dalla misura su 30 giorni, non a occhio:
 *       products_sync : media 8,7 min, p95 10,8, max 45,4  -> soglia  90 min
 *       orders_sync   : media 0,2 min, p95  1,2, max  2,9  -> soglia  30 min
 *       sconosciuto                                        -> soglia 180 min
 *     Larghe apposta. Il cane morde solo i morti veri.
 *
 *  2. SESSIONE APPESA — una sessione Postgres 'idle in transaction' da oltre 30
 *     minuti tiene lock e non li mollera' mai da sola. Si termina. Stesso
 *     trattamento per chi tiene un lock advisory (feedLock.js) ed e' fermo da
 *     oltre 30 minuti: quel lucchetto blocca il motore feed. Mai la sessione
 *     del cane stesso, mai una sessione che sta davvero lavorando ('active').
 *
 *  3. LOOP FERMO — battito piu' vecchio di 3 cadenze (loop_heartbeat, riempita
 *     da loopHeartbeat.js). Qui il cane NON puo' sbloccare: un loop incastrato
 *     su una flag `inCorso` rimasta true vive nella memoria del processo, e
 *     l'unico sblocco e' il restart del container. Il restart non lo fa da
 *     solo — puo' cadere in mezzo a un sync e sporcare i costi, e la legge del
 *     capo e' che la macchina si tiene sul costo. Quindi lo SEGNALA, con nome e
 *     minuti, e aspetta la mano.
 *
 * Tutto quello che tocca finisce in loop_watchdog_log: uno sblocco senza motivo
 * scritto e' uno sblocco che nessuno puo' verificare.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const EVERY_MS            = 60 * 60 * 1000;  // ogni ora, come chiesto
const PRIMO_GIRO_MS       = 4 * 60 * 1000;   // lascia respirare il boot
const SESSIONE_APPESA_MIN = 30;
const CADENZE_TOLLERATE   = 3;               // 3 cadenze senza battito = fermo
const ETA_MINIMA_LOOP_ORE = 2;               // non si accusa un loop appena nato

async function runLoopWatchdog() {
  const client = await pool.connect();
  const sbloccati = [];
  const fermi = [];
  const uccise = [];
  try {
    // ---------------------------------------------------------------- 1. ZOMBIE
    const { rows: zombie } = await client.query(`
      UPDATE import_jobs j
         SET status        = 'failed',
             completed_at  = NOW(),
             error_message = left(COALESCE(j.error_message || ' | ', '')
                             || 'cane da guardia ' || to_char(NOW() AT TIME ZONE 'Europe/Rome', 'DD/MM HH24:MI')
                             || ': fermo in ' || j.status || ' da '
                             || round(EXTRACT(EPOCH FROM (NOW() - j.created_at)) / 3600.0, 1)
                             || 'h, oltre la soglia del tipo. Sbloccato d''ufficio (mig 117).', 900)
       WHERE j.status IN ('running', 'pending')
         AND j.created_at < NOW() - (CASE j.job_type
               WHEN 'products_sync' THEN interval '90 minutes'
               WHEN 'orders_sync'   THEN interval '30 minutes'
               ELSE                      interval '180 minutes' END)
      RETURNING j.id, j.tenant_id, j.job_type, j.status AS stato_nuovo,
                round(EXTRACT(EPOCH FROM (NOW() - j.created_at)) / 3600.0, 1) AS ore_fermo
    `);
    for (const z of zombie) {
      sbloccati.push(z);
      await client.query(
        `INSERT INTO loop_watchdog_log (tipo, bersaglio, dettaglio, azione)
         VALUES ('job_zombie', $1, $2, 'sbloccato')`,
        [z.id, `${z.job_type} fermo da ${z.ore_fermo}h, chiuso failed`]
      );
    }

    // ------------------------------------------------------- 2. SESSIONI APPESE
    // Solo chi e' fermo davvero: 'idle in transaction' tiene i lock e non li
    // molla, un lock advisory in mano a una sessione ferma blocca il motore feed.
    const { rows: appese } = await client.query(`
      SELECT DISTINCT a.pid, a.state,
             round(EXTRACT(EPOCH FROM (NOW() - a.state_change)) / 60.0) AS min_fermo,
             left(COALESCE(a.query, ''), 80) AS q,
             EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'advisory') AS ha_advisory
        FROM pg_stat_activity a
       WHERE a.pid <> pg_backend_pid()
         AND a.datname = current_database()
         AND a.state_change < NOW() - ($1 || ' minutes')::interval
         AND (a.state = 'idle in transaction'
              OR (a.state <> 'active'
                  AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'advisory')))
    `, [SESSIONE_APPESA_MIN]);
    for (const s of appese) {
      try {
        await client.query('SELECT pg_terminate_backend($1)', [s.pid]);
        uccise.push(s);
        await client.query(
          `INSERT INTO loop_watchdog_log (tipo, bersaglio, dettaglio, azione)
           VALUES ('sessione_appesa', $1, $2, 'sbloccato')`,
          [String(s.pid), `${s.state} da ${s.min_fermo} min${s.ha_advisory ? ', teneva un lock advisory' : ''} — ${s.q}`]
        );
      } catch (e) {
        console.error(`[LoopWatchdog] pid ${s.pid} non terminato: ${e.message}`);
      }
    }

    // ------------------------------------------------------------ 3. LOOP FERMI
    const { rows: morti } = await client.query(`
      SELECT h.loop_name,
             round(h.cadenza_ms / 60000.0, 1) AS cadenza_min,
             round(EXTRACT(EPOCH FROM (NOW() - h.ultimo_battito)) / 60.0) AS fermo_da_min,
             h.battiti
        FROM loop_heartbeat h
       WHERE h.cadenza_ms IS NOT NULL
         AND h.primo_battito  < NOW() - ($1 || ' hours')::interval
         AND h.ultimo_battito < NOW() - (h.cadenza_ms * $2 / 1000.0) * interval '1 second'
       ORDER BY 3 DESC
    `, [ETA_MINIMA_LOOP_ORE, CADENZE_TOLLERATE]);
    for (const m of morti) {
      fermi.push(m);
      await client.query(
        `INSERT INTO loop_watchdog_log (tipo, bersaglio, dettaglio, azione)
         VALUES ('loop_fermo', $1, $2, 'segnalato')`,
        [m.loop_name, `cadenza ${m.cadenza_min} min, nessun battito da ${m.fermo_da_min} min (${m.battiti} battiti in tutto)`]
      );
    }

    // ------------------------------------------------------------------ REFERTO
    if (sbloccati.length === 0 && uccise.length === 0 && fermi.length === 0) {
      console.log('[LoopWatchdog] tutti i loop battono, nessun job zombie, nessuna sessione appesa');
      return { sbloccati: 0, uccise: 0, fermi: 0 };
    }

    console.log(`[LoopWatchdog] job zombie sbloccati=${sbloccati.length} sessioni terminate=${uccise.length} loop fermi=${fermi.length}`);

    const righe = ['🐕 <b>CANE DA GUARDIA DEI LOOP</b>'];
    if (sbloccati.length) {
      righe.push(`\n🔓 <b>${sbloccati.length} job zombie sbloccati</b>`);
      for (const z of sbloccati.slice(0, 10)) {
        righe.push(`· ${z.job_type} fermo da ${z.ore_fermo}h → failed`);
      }
      if (sbloccati.length > 10) righe.push(`· …e altri ${sbloccati.length - 10}`);
    }
    if (uccise.length) {
      righe.push(`\n🔪 <b>${uccise.length} sessioni appese terminate</b>`);
      for (const s of uccise.slice(0, 5)) {
        righe.push(`· pid ${s.pid}: ${s.state} da ${s.min_fermo} min${s.ha_advisory ? ' (teneva un lucchetto)' : ''}`);
      }
    }
    if (fermi.length) {
      righe.push(`\n🚨 <b>${fermi.length} LOOP FERMI — serve la mano, il cane non puo' riavviare da solo</b>`);
      for (const m of fermi.slice(0, 12)) {
        righe.push(`· ${m.loop_name}: cadenza ${m.cadenza_min} min, muto da ${m.fermo_da_min} min`);
      }
      if (fermi.length > 12) righe.push(`· …e altri ${fermi.length - 12}`);
    }
    try { await sendTelegram(righe.join('\n')); } catch (e) {
      console.error('[LoopWatchdog] telegram fallito:', e.message);
    }

    return { sbloccati: sbloccati.length, uccise: uccise.length, fermi: fermi.length };
  } catch (e) {
    console.error('[LoopWatchdog] giro fallito:', e.message);
    return { errore: e.message };
  } finally {
    client.release();
  }
}

function startLoopWatchdog() {
  console.log(`[LoopWatchdog] armato — primo giro tra ${PRIMO_GIRO_MS / 60000} min, poi ogni ora`);
  setTimeout(function tick() {
    runLoopWatchdog().finally(() => setTimeout(tick, EVERY_MS));
  }, PRIMO_GIRO_MS);
}

module.exports = { startLoopWatchdog, runLoopWatchdog };
