/**
 * AI Health Monitor: verifica ogni 4h che il loop AI Audit stia girando.
 *
 * Check 1 — AI ferma: MAX(run_at) su ai_audit_suggestions piu' vecchio di
 *           8h (il loop di ottimizzazione gira ogni 6h, quindi 8h = 1 run
 *           saltato + margine) → alert Telegram "AI Audit fermo da Xh".
 * Check 2 — AI genera ma non applica: >500 suggerimenti pending creati
 *           nelle ultime 24h e ZERO applied nello stesso periodo → alert
 *           "AI Audit genera ma non applica".
 *
 * Solo lettura DB + Telegram: nessuna azione correttiva automatica.
 */

const { pool } = require('../db/pool');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // ogni 4h
const INITIAL_DELAY_MS = 5 * 60 * 1000;       // primo check 5 min dopo il boot
const STALE_THRESHOLD_HOURS = 8;
const PENDING_FLOOD_THRESHOLD = 500;

async function checkAiHealth() {
  const { sendTelegram } = require('./telegramNotifier');
  const result = { stale: false, notApplying: false };

  // --- Check 1: ultimo run AI ---
  try {
    const { rows } = await pool.query(
      `SELECT MAX(run_at) AS last_run,
              EXTRACT(EPOCH FROM (NOW() - MAX(run_at))) / 3600 AS hours_ago
       FROM ai_audit_suggestions`
    );
    const lastRun = rows[0]?.last_run;
    const hoursAgo = rows[0]?.hours_ago != null ? Number(rows[0].hours_ago) : null;

    if (!lastRun) {
      result.stale = true;
      await sendTelegram(
        '🚨 <b>AI Health Monitor</b>\nAI Audit: nessun run registrato in ai_audit_suggestions (tabella vuota).',
        { key: 'ai_health_stale', throttleMs: 8 * 3600 * 1000 }
      );
    } else if (hoursAgo != null && hoursAgo > STALE_THRESHOLD_HOURS) {
      result.stale = true;
      await sendTelegram(
        `🚨 <b>AI Health Monitor</b>\nAI Audit fermo da ${Math.floor(hoursAgo)}h ` +
        `(ultimo run: ${new Date(lastRun).toISOString().slice(0, 16).replace('T', ' ')} UTC).\n` +
        `Atteso un run ogni 6h — verificare aiAuditCron / claude API.`,
        { key: 'ai_health_stale', throttleMs: 8 * 3600 * 1000 }
      );
    }
    console.log(
      `[aiHealthMonitor] last run ${hoursAgo != null ? hoursAgo.toFixed(1) + 'h fa' : 'MAI'}` +
      (result.stale ? ' → STALE' : ' → OK')
    );
  } catch (e) {
    console.error('[aiHealthMonitor] check stale err:', e.message);
  }

  // --- Check 2: genera ma non applica ---
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
              COUNT(*) FILTER (WHERE status = 'applied')  AS applied
       FROM ai_audit_suggestions
       WHERE run_at > NOW() - INTERVAL '24 hours'`
    );
    const pending = Number(rows[0]?.pending || 0);
    const applied = Number(rows[0]?.applied || 0);

    if (pending > PENDING_FLOOD_THRESHOLD && applied === 0) {
      result.notApplying = true;
      await sendTelegram(
        `⚠️ <b>AI Health Monitor</b>\nAI Audit genera ma non applica: ` +
        `${pending} suggerimenti pending nelle ultime 24h, 0 applied.\n` +
        `Verificare aiSuggestionApplier / gate di safety.`,
        { key: 'ai_health_noapply', throttleMs: 12 * 3600 * 1000 }
      );
    }
    console.log(
      `[aiHealthMonitor] 24h: pending=${pending} applied=${applied}` +
      (result.notApplying ? ' → NOT APPLYING' : ' → OK')
    );
  } catch (e) {
    console.error('[aiHealthMonitor] check apply err:', e.message);
  }

  return result;
}

function startAiHealthMonitor() {
  setTimeout(() => {
    checkAiHealth().catch((e) => console.error('[aiHealthMonitor] err:', e.message));
  }, INITIAL_DELAY_MS);
  setInterval(() => {
    checkAiHealth().catch((e) => console.error('[aiHealthMonitor] err:', e.message));
  }, CHECK_INTERVAL_MS);
  console.log('[aiHealthMonitor] Started — check ogni 4h (soglia stale 8h, flood pending >500/24h)');
}

module.exports = { startAiHealthMonitor, checkAiHealth };
