/**
 * 💓 IL BATTITO DEI LOOP — mig 117.
 *
 * Ordine capo 10/09: "crea un monitor che controlla ogni ora tutti i loop e
 * sblocca quelli bloccati."
 *
 * Per sapere se un loop e' fermo bisogna prima sapere quando ha battuto
 * l'ultima volta. I loop qui dentro sono 47 registrati in server.js, sparsi su
 * 102 file di services, e si schedulano in due modi diversi: 28 file con
 * setInterval, 63 con setTimeout ricorsivo (`tick().finally(() => setTimeout(tick, EVERY_MS))`).
 * Patcharli uno per uno sarebbe 102 occasioni di rompere qualcosa.
 *
 * Invece il battito si attacca da solo: avvolgiamo setInterval e setTimeout una
 * volta sola, qui, e ogni schedulazione da 60 secondi in su viene registrata a
 * nome del file che l'ha chiesta. Sotto il minuto non e' un loop, e' un'attesa
 * (retry, backoff, pausa fra pagine): quelle non si contano.
 *
 * Regole di sicurezza, in ordine di importanza:
 *  1. il battito non deve MAI rompere il loop che sta misurando — ogni errore
 *     muore qui dentro, in silenzio;
 *  2. non si scrive sul DB a ogni tick — si accumula in memoria e si scarica
 *     una volta al minuto, in una sola query;
 *  3. lo scaricatore usa il setTimeout ORIGINALE, altrimenti misura se stesso.
 *
 * Va richiesto per PRIMO in server.js, prima di qualunque servizio: avvolge i
 * timer globali, quindi deve essere in piedi prima che qualcuno ne schedule uno.
 */
const { pool } = require('../db/pool');

const SOGLIA_MS  = 60 * 1000;        // sotto il minuto non e' un loop
const FLUSH_MS   = 60 * 1000;        // scarico su DB una volta al minuto
const MAX_NOMI   = 400;              // paracadute: non facciamo crescere la mappa a caso

const origInterval = global.setInterval;
const origTimeout  = global.setTimeout;

// nome loop -> { cadenza, n, ultimo }
const battiti = new Map();
let avviato = false;

/**
 * Chi ha schedulato questo timer. Si legge dallo stack al momento della
 * schedulazione: il primo file di services/ o routes/ che non sia questo.
 */
function nomeChiamante() {
  const linee = String(new Error().stack || '').split('\n');
  for (const l of linee) {
    const m = l.match(/[/\\](services|routes)[/\\]([A-Za-z0-9_.-]+\.js)/);
    if (m && m[2] !== 'loopHeartbeat.js') return m[2];
  }
  return null;
}

function segna(nome, cadenza) {
  try {
    if (!battiti.has(nome) && battiti.size >= MAX_NOMI) return;
    const b = battiti.get(nome) || { cadenza: null, n: 0, ultimo: null };
    b.cadenza = cadenza;
    b.n += 1;
    b.ultimo = new Date();
    battiti.set(nome, b);
  } catch (_) { /* il battito non rompe mai il loop */ }
}

function avvolgi(fn, ms, nome) {
  return function battente(...a) {
    segna(nome, ms);
    return fn.apply(this, a);
  };
}

function forse(originale) {
  return function (fn, ms, ...resto) {
    if (typeof fn === 'function' && typeof ms === 'number' && ms >= SOGLIA_MS) {
      let nome = null;
      try { nome = nomeChiamante(); } catch (_) { nome = null; }
      if (nome) return originale.call(this, avvolgi(fn, ms, nome), ms, ...resto);
    }
    return originale.call(this, fn, ms, ...resto);
  };
}

global.setInterval = forse(origInterval);
global.setTimeout  = forse(origTimeout);
// setTimeout porta con se' delle proprieta' usate da util.promisify: le teniamo.
Object.setPrototypeOf(global.setTimeout, origTimeout);
Object.getOwnPropertySymbols(origTimeout).forEach((s) => {
  try { global.setTimeout[s] = origTimeout[s]; } catch (_) {}
});
Object.getOwnPropertySymbols(origInterval).forEach((s) => {
  try { global.setInterval[s] = origInterval[s]; } catch (_) {}
});

async function scarica() {
  if (battiti.size === 0) return;
  const nomi = [], ultimi = [], cadenze = [], conteggi = [];
  for (const [nome, b] of battiti.entries()) {
    nomi.push(nome); ultimi.push(b.ultimo); cadenze.push(b.cadenza); conteggi.push(b.n);
  }
  battiti.clear();
  try {
    await pool.query(
      `INSERT INTO loop_heartbeat (loop_name, ultimo_battito, primo_battito, cadenza_ms, battiti)
       SELECT x.nome, x.ultimo, x.ultimo, x.cadenza, x.n
         FROM unnest($1::text[], $2::timestamptz[], $3::bigint[], $4::bigint[])
              AS x(nome, ultimo, cadenza, n)
       ON CONFLICT (loop_name) DO UPDATE
         SET ultimo_battito = EXCLUDED.ultimo_battito,
             cadenza_ms     = EXCLUDED.cadenza_ms,
             battiti        = loop_heartbeat.battiti + EXCLUDED.battiti`,
      [nomi, ultimi, cadenze, conteggi]
    );
  } catch (e) {
    // Se la tabella non c'e' ancora (mig 117 non applicata) o il DB tossisce, si
    // tace: un battito perso e' un dato in meno, non un loop rotto.
  }
}

function startLoopHeartbeat() {
  if (avviato) return;
  avviato = true;
  origInterval(() => { scarica().catch(() => {}); }, FLUSH_MS);
  console.log('[LoopHeartbeat] attaccato a setInterval/setTimeout — registra ogni schedulazione da 60s in su');
}

module.exports = { startLoopHeartbeat };
