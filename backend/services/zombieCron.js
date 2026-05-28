/**
 * Zombie Cron - Schedules daily Trovaprezzi click download at 06:00 local time.
 *
 * Trovaprezzi finalizes the previous day's click data by early morning —
 * running at midnight returned partial counts (observed underreporting), 06:00
 * is the user-chosen sweet spot between freshness and TP data completeness.
 *
 * Downloads yesterday's click data for all configured tenants,
 * persists to DB, and uploads CSV to shared FTP.
 */

const zombieService = require('./zombieService');

let cronTimer = null;

const RUN_HOUR = 3;  // 03:00 UTC = 05:00 Italia. Spostato da 06:00 perche gli utenti
// guardano la dashboard tra 07:00-08:00 italiane e prima del cron yesterday appariva
// con dato parziale (healthCron Step 0 fa fetch a meta' mattina precedente).
const RUN_MIN  = 0;

function startZombieCron() {
  function msUntilNextRun() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(RUN_HOUR, RUN_MIN, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function scheduleNext() {
    const ms = msUntilNextRun();
    console.log(`[ZombieCron] Next run in ${Math.round(ms / 60000)} minutes`);

    cronTimer = setTimeout(async () => {
      console.log('[ZombieCron] Starting daily Trovaprezzi click download...');
      try {
        const results = await zombieService.runForAllTenants();
        console.log(`[ZombieCron] Completed:`, results.map(r =>
          `T:${r.tenantId?.slice(0, 8)} → ${r.error ? 'ERROR: ' + r.error : `${r.products} products, ${r.totalClicks} clicks, FTP: ${r.ftpUploaded}`}`
        ).join('; '));
      } catch (err) {
        console.error('[ZombieCron] Fatal error:', err.message);
      }
      scheduleNext();
    }, ms);
  }

  scheduleNext();
  console.log(`[ZombieCron] Zombie Trovaprezzi cron initialized (daily at ${String(RUN_HOUR).padStart(2,'0')}:${String(RUN_MIN).padStart(2,'0')})`);
}

function stopZombieCron() {
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
  }
}

module.exports = { startZombieCron, stopZombieCron };
