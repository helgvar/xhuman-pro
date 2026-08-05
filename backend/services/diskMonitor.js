/**
 * 💾 DISK MONITOR (11/7/2026 — sera del crash da disco pieno)
 *
 * Il DB di produzione è crashato con disco al 100% (13MB liberi) durante
 * l'ingestione del dump scraper ripristinato. Il capo aumenterà il disco;
 * fino ad allora (e anche dopo): sorveglianza ORARIA con allarme Telegram.
 *
 * Soglie: >92% = ⚠️ avviso (1/12h) | >95% = 🚨 critico (1/2h) — sotto, silenzio.
 * Il df dentro il container (overlay) riflette il disco host /dev/sda1.
 */

const { execFile } = require('child_process');
const { sendTelegram } = require('./telegramNotifier');

function dfRoot() {
  return new Promise((resolve, reject) => {
    execFile('df', ['-k', '/'], (err, stdout) => {
      if (err) return reject(err);
      const line = stdout.trim().split('\n').pop().split(/\s+/);
      // Filesystem 1K-blocks Used Available Use% Mounted
      const totalGb = parseInt(line[1]) / 1024 / 1024;
      const freeGb = parseInt(line[3]) / 1024 / 1024;
      const pct = parseInt(line[4]);
      resolve({ totalGb, freeGb, pct });
    });
  });
}

async function runDiskMonitor() {
  try {
    const { totalGb, freeGb, pct } = await dfRoot();
    console.log(`[Disk] ${pct}% usato, ${freeGb.toFixed(1)}GB liberi su ${totalGb.toFixed(0)}GB`);
    if (pct >= 95) {
      await sendTelegram(
        `🚨 <b>DISCO CRITICO ${pct}%</b> — ${freeGb.toFixed(1)}GB liberi su ${totalGb.toFixed(0)}GB\n` +
        `Il DB può crashare da un momento all'altro (già successo l'11/7). ` +
        `Serve SUBITO: resize disco o pulizia storici (product_health_history 18GB, feed_action_history 16GB).`,
        { key: 'disk_critical', parseMode: 'HTML', throttleMs: 2 * 3600 * 1000 });
    } else if (pct >= 92) {
      await sendTelegram(
        `⚠️ <b>Disco al ${pct}%</b> — ${freeGb.toFixed(1)}GB liberi su ${totalGb.toFixed(0)}GB. ` +
        `Promemoria: resize disco in programma (capo, 11/7).`,
        { key: 'disk_warn', parseMode: 'HTML', throttleMs: 12 * 3600 * 1000 });
    }
  } catch (e) {
    console.error('[Disk] err:', e.message);
  }
}

let started = false;
function startDiskMonitor() {
  if (started) return;
  started = true;
  setTimeout(() => {
    runDiskMonitor();
    setInterval(runDiskMonitor, 60 * 60 * 1000);
  }, 90 * 1000);
  console.log('[Disk] 💾 monitor disco attivo — ogni ora, avviso >92%, critico >95%');
}

module.exports = { runDiskMonitor, startDiskMonitor };
