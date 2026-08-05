/**
 * 🔁 RIATTIVAZIONE MARGINE (ordine capo 24/7) — UNICA autorita' di rilascio
 * per la classe "margine 100% bruciato" (lima + burner + killer).
 *
 * Regole (funzione DB reactivate_margin_blocks, mig 072):
 *   R1 — riprende vendite da ALTRI canali (vende_in_rete_15g) -> rilascio def.
 *   R2 — bloccato da grossista, ora RESTOCK in farmacia (erp_stock>0): l'economia
 *        flippa (costo giu', margine su) -> rilascio per ri-valutazione.
 *   R3 — nessuna delle 2 -> TEST di 5 giorni ogni 20gg. Se vende nel test resta,
 *        altrimenti i loop lo ri-bloccano al giro successivo.
 *
 * Gira alle 03:00 UTC (05:00 IT), PRIMA di burner (05:45) e lima (06:15), cosi'
 * un test chiuso no-sale viene ri-bloccato dai loop la stessa mattina.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const RUN_HOUR_UTC = 3;
const RUN_MIN_UTC = 0;

async function runMarginBlockReactivation() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT phase, src, n FROM reactivate_margin_blocks(false)');
    await client.query('COMMIT');

    const sum = (pref) => rows.filter(r => r.phase.startsWith(pref)).reduce((s, r) => s + parseInt(r.n), 0);
    const rel = sum('released');
    const opened = sum('test_opened');
    const closedSold = sum('test_closed_sold');
    const closedNo = sum('test_closed_nosale');
    console.log(`[MarginReactiv] rilasciati(R1+R2)=${rel} | test aperti=${opened} | test chiusi: venduti=${closedSold} ri-blocco=${closedNo}`);

    if (rel > 0 || opened > 0 || closedSold > 0) {
      const det = rows.map(r => `${r.phase}/${r.src}:${r.n}`).join(', ');
      try {
        await sendTelegram(`🔁 <b>Riattivazione margine</b>\nRilasciati (vende-rete/restock): ${rel}. Test 5gg aperti: ${opened}. Promossi (venduti nel test): ${closedSold}. Ri-blocco (no-sale): ${closedNo}.\n<i>${det}</i>`);
      } catch (_) {}
    }
    return { rel, opened, closedSold, closedNo, rows };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[MarginReactiv] ERRORE:', e.message);
    return null;
  } finally {
    client.release();
  }
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    RUN_HOUR_UTC, RUN_MIN_UTC, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function startMarginBlockReactivation() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[MarginReactiv] armata — prossimo run tra ${Math.round(delay / 60000)} min (03:00 UTC / 05:00 IT)`);
    setTimeout(async () => {
      try { await runMarginBlockReactivation(); } catch (_) { /* già loggato */ }
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startMarginBlockReactivation, runMarginBlockReactivation };
