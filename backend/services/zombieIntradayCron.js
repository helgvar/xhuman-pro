/**
 * ⚡ ZOMBIE INTRA-DAY (idea capo 25/7, attivata 26/7)
 *
 * "Schedulare il file zombie di Trovaprezzi piu' volte al giorno col parziale
 *  dei click, cosi' interveniamo con correzioni anche giornaliere."
 *
 * Ogni 2 ore in fascia 08:35-20:35 IT scarica dal portale TP il PARZIALE di
 * OGGI per i tenant operational e lo upserta in zombie_clicks (fetch_date=oggi).
 * L'upsert per (tenant, giorno) e' idempotente: ogni giro sostituisce il
 * parziale precedente; il run notturno delle 00:05 riscrive il giorno completo.
 *
 * GUARDRAIL:
 *  - NIENTE FTP sui parziali (skipFtp=true): il file che Farmabooster consuma
 *    resta SOLO quello giornaliero completo.
 *  - Fascia 08-20 e stagger 20s tra tenant: ~7 login/tenant/giorno in piu',
 *    per non far scattare i limiti del portale TP.
 *  - Verificato 26/7: il portale espone il parziale di oggi (MPF 145 prodotti,
 *    188 click alle 09:15).
 */
const { pool } = require('../db/pool');
const zombieService = require('./zombieService');

const TENANT_OPERATIONAL = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF',
  'Farmainsieme', 'Farmastelia', 'Farmacia Mandanici'];
const RUN_HOURS_UTC = [6, 8, 10, 12, 14, 16, 18];   // = 08:35-20:35 IT (CEST)
const RUN_MIN = 35;
const STAGGER_MS = 20 * 1000;

let running = false;

async function runIntradayZombie() {
  if (running) { console.log('[ZombieIntraday] giro precedente ancora in corso, salto'); return null; }
  running = true;
  try {
    const today = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // data Roma (CEST)
    const { rows: tenants } = await pool.query(
      `SELECT id, name FROM tenants WHERE status='active' AND name = ANY($1) ORDER BY name`,
      [TENANT_OPERATIONAL]);
    const results = [];
    for (const t of tenants) {
      // 1 retry dopo 60s: assorbe le collisioni browser con healthCron (Session closed)
      let done = false;
      for (let attempt = 1; attempt <= 2 && !done; attempt++) {
        try {
          const r = await zombieService.runForTenant(t.id, today, true);  // skipFtp
          if (r.noData && attempt === 1) { await new Promise(res => setTimeout(res, 60 * 1000)); continue; }
          results.push(`${t.name}: ${r.totalClicks || 0} click`);
          done = true;
        } catch (e) {
          if (attempt === 1) { await new Promise(res => setTimeout(res, 60 * 1000)); continue; }
          results.push(`${t.name}: ERR ${e.message.slice(0, 60)}`);
          done = true;
        }
      }
      await new Promise(res => setTimeout(res, STAGGER_MS));
    }
    console.log(`[ZombieIntraday] parziale ${today} — ${results.join(' | ')}`);
    return results;
  } finally {
    running = false;
  }
}

function msUntilNextSlot() {
  const now = new Date();
  for (const h of RUN_HOURS_UTC) {
    const cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, RUN_MIN, 0, 0));
    if (cand.getTime() > now.getTime()) return cand.getTime() - now.getTime();
  }
  // domani, primo slot
  const cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, RUN_HOURS_UTC[0], RUN_MIN, 0, 0));
  return cand.getTime() - now.getTime();
}

function startZombieIntradayCron() {
  const schedule = () => {
    const delay = msUntilNextSlot();
    console.log(`[ZombieIntraday] armato — prossimo giro tra ${Math.round(delay / 60000)} min (fascia 08:35-20:35 IT, ogni 2h)`);
    setTimeout(async () => {
      try { await runIntradayZombie(); } catch (e) { console.error('[ZombieIntraday] err:', e.message); }
      schedule();
    }, delay);
  };
  schedule();
  // primo giro subito se siamo in fascia (per non aspettare fino a 2h dopo il boot)
  const hUtc = new Date().getUTCHours();
  if (hUtc >= RUN_HOURS_UTC[0] && hUtc <= RUN_HOURS_UTC[RUN_HOURS_UTC.length - 1]) {
    setTimeout(() => { runIntradayZombie().catch(e => console.error('[ZombieIntraday] boot-run err:', e.message)); }, 3 * 60 * 1000);
    console.log('[ZombieIntraday] in fascia: primo giro tra 3 min');
  }
}

module.exports = { startZombieIntradayCron, runIntradayZombie };
