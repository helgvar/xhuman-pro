/**
 * 🔁 LOOP CODA LUNGA zero-conversione (ordine capo 29/7) — taglio + retest 7gg/3gg.
 *
 * Colma il GAP dei micro-burner sotto la soglia killer per-SKU: cliccati 1x/15gg,
 * 0 vendite rete 90gg, disponibili. Vengono tagliati dal feed e RITESTATI ogni 7gg
 * per 3gg. Se durante il test vendono in rete -> promossi (restano nel feed, escono
 * dal loop). Altrimenti ri-tagliati per altri 7gg. Niente esilio permanente
 * (feedback_oblio_quarantena_non_per_sempre).
 *
 * Logica interamente in DB (funzione codalunga_retest_loop, mig 078): il writer
 * 'sessione_loop_codalunga' bypassa il veto-incidenza sui SOLI rilasci supervisionati
 * (stesso pattern di reactivate_margin_blocks); il CUT resta cappato (writer normale).
 *
 * Gira alle 03:20 UTC (05:20 IT), dopo riattivazione-margine (03:00) e prima di
 * burner (05:45)/lima (06:15).
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const RUN_HOUR_UTC = 3;
const RUN_MIN_UTC = 20;

async function runCodaLungaLoop() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT phase, n FROM codalunga_retest_loop(false)');
    await client.query('COMMIT');

    const get = (p) => parseInt(rows.find(r => r.phase === p)?.n || 0);
    const cut = get('cut'), promosso = get('promosso'), ritagliato = get('ritagliato'), aperto = get('test_aperto');
    console.log(`[CodaLungaLoop] cut=${cut} | test aperti=${aperto} | chiusi: promossi=${promosso} ri-taglio=${ritagliato}`);

    if (cut > 0 || promosso > 0 || aperto > 0) {
      try {
        await sendTelegram(`🔁 <b>Loop coda lunga</b>\nNuovi tagli: ${cut}. Retest aperti (3gg): ${aperto}. Promossi (venduti nel test): ${promosso}. Ri-taglio (no-sale): ${ritagliato}.`);
      } catch (_) {}
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[CodaLungaLoop] errore:', e.message);
  } finally {
    client.release();
  }
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, RUN_MIN_UTC, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function startCodaLungaLoop() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[CodaLungaLoop] armato — prossimo run tra ${Math.round(delay / 60000)} min (03:20 UTC / 05:20 IT)`);
    setTimeout(async () => {
      try { await runCodaLungaLoop(); } catch (_) { /* già loggato */ }
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startCodaLungaLoop, runCodaLungaLoop };
