/**
 * Zombie Cron - Schedules daily Trovaprezzi click download at 00:05
 *
 * Downloads yesterday's click data for all configured tenants,
 * persists to DB, and uploads CSV to shared FTP.
 */

const zombieService = require('./zombieService');

let cronTimer = null;

function startZombieCron() {
  // Calculate ms until next 00:05
  function msUntilNext0005() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(0, 5, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function scheduleNext() {
    const ms = msUntilNext0005();
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
  console.log('[ZombieCron] Zombie Trovaprezzi cron initialized (daily at 00:05)');
}

function stopZombieCron() {
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
  }
}

module.exports = { startZombieCron, stopZombieCron };
