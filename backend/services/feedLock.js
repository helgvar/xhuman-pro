/**
 * Lucchetto condiviso sul ricalcolo del feed, per tenant.
 *
 * Il motore giornaliero puo' partire da due porte: il cron notturno e la chat
 * dell'agente (`recalculate_feed`). Nessuna delle due sapeva dell'altra. Due
 * ricalcoli sovrapposti sullo stesso tenant si pestano i piedi sul DELETE di
 * `feed_actions`: il primo cancella e sta riscrivendo, il secondo cancella di
 * nuovo e riscrive con una fotografia diversa. Quello che resta non e' il
 * risultato di nessuno dei due.
 *
 * Il freno in-process dentro claudeAgent fermava solo agente-contro-agente, e
 * comunque muore al riavvio del container. Qui il lucchetto sta nel DB, quindi
 * lo vedono tutti i percorsi e tutti i processi.
 *
 * `pg_try_advisory_lock` non aspetta: o lo prende o dice di no. Un ricalcolo
 * che aspetta il suo turno e' un ricalcolo che parte su dati vecchi di mezz'ora
 * — meglio rifiutare e rifarlo dopo.
 *
 * IMPORTANTE: il lock e' legato alla SESSIONE Postgres, quindi la connessione
 * va tenuta presa fino allo sblocco. Da qui il client dedicato invece del pool.
 */

const { pool } = require('../db/pool');

// Primo dei due interi della chiave: identifica QUESTO lucchetto e non un altro.
const CLASSE_LOCK_FEED = 748201;

/**
 * Esegue `lavoro` col lucchetto del tenant in mano.
 * Se il lucchetto e' gia' di qualcun altro, NON esegue e torna
 * `{ preso: false }` — sta a chi chiama decidere cosa dire.
 */
async function conLockFeed(tenantId, lavoro) {
  const client = await pool.connect();
  let preso = false;
  try {
    const { rows: [r] } = await client.query(
      'SELECT pg_try_advisory_lock($1, hashtext($2)) AS preso',
      [CLASSE_LOCK_FEED, String(tenantId)]
    );
    preso = r.preso === true;
    if (!preso) return { preso: false };

    return { preso: true, risultato: await lavoro() };
  } finally {
    if (preso) {
      await client.query(
        'SELECT pg_advisory_unlock($1, hashtext($2))',
        [CLASSE_LOCK_FEED, String(tenantId)]
      ).catch(() => {});
    }
    client.release();
  }
}

module.exports = { conLockFeed, CLASSE_LOCK_FEED };
