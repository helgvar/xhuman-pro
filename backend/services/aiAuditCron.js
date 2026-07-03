/**
 * Cron AI audit:
 *  - 09:00 UTC daily: Telegram digest top suggerimenti HIGH/MEDIUM pending
 *  - 04:00 / 16:00 UTC: auto-apply low+medium severity (safety-gated)
 *
 * I cron sono separati per evitare che un fallimento blocchi l'altro.
 */

const { pool } = require('../db/pool');
const { processAutoApply } = require('./aiSuggestionApplier');

const DIGEST_HOUR_UTC = 9;
// Loop ottimizzazione AI ogni 6h: 00, 06, 12, 18 UTC (= 02, 08, 14, 20 italia).
// Ogni slot: 1) audit globale di tutti i tenant attivi 2) auto-apply suggerimenti safe.
const OPTIMIZATION_HOURS_UTC = [0, 6, 12, 18];

async function sendDigest() {
  const { sendTelegram } = require('./telegramNotifier');
  const { rows } = await pool.query(
    `SELECT t.name AS tenant, s.severity, s.category, s.title, s.id
     FROM ai_audit_suggestions s JOIN tenants t ON t.id=s.tenant_id
     WHERE s.status='pending' AND s.severity IN ('high','medium')
       AND s.run_at > NOW() - INTERVAL '24 hours'
     ORDER BY
       CASE s.severity WHEN 'high' THEN 1 ELSE 2 END,
       s.run_at DESC
     LIMIT 10`
  );
  if (rows.length === 0) {
    console.log('[aiAuditCron] No high/medium suggestions to digest');
    return;
  }
  const lines = ['🤖 <b>AI Audit Daily Digest</b>', ''];
  let lastTenant = null;
  for (const r of rows) {
    if (r.tenant !== lastTenant) {
      lines.push('', `<b>${r.tenant}</b>`);
      lastTenant = r.tenant;
    }
    const icon = r.severity === 'high' ? '🔴' : '🟡';
    lines.push(`${icon} [${r.category}] ${r.title}`);
  }
  lines.push('', `<i>Totale pending: ${rows.length}. Approva da dashboard /ai-audit</i>`);
  await sendTelegram(lines.join('\n'), { key: 'ai_digest', throttleMs: 8 * 3600 * 1000 });
  console.log(`[aiAuditCron] Digest inviato (${rows.length} suggerimenti)`);
}

async function runAutoApply() {
  try {
    const r = await processAutoApply({ dryRun: false });
    console.log('[aiAuditCron] auto-apply:', JSON.stringify(r));
    if (r.applied > 0) {
      try {
        const { sendTelegram } = require('./telegramNotifier');
        await sendTelegram(
          `🤖 AI auto-apply: ${r.applied} suggerimenti applicati, ${r.skipped} skippati`,
          { key: 'ai_apply', throttleMs: 60 * 60 * 1000 }
        );
      } catch {}
    }
  } catch (e) {
    console.error('[aiAuditCron] auto-apply err:', e.message);
  }
}

/**
 * Loop di ottimizzazione AI completo: audit di TUTTI i tenant attivi + auto-apply.
 * Gira ogni 6h. Forza l'audit anche se l'engine non ha appena girato.
 */
async function runOptimizationLoop() {
  console.log('[aiAuditCron] ===== Optimization loop START =====');
  try {
    const { auditTenantRun } = require('./aiAuditor');
    const { rows: tenants } = await pool.query(
      `SELECT id, name FROM tenants WHERE status='active' ORDER BY name`
    );
    let totalSuggestions = 0;
    let totalTokens = 0;
    for (const t of tenants) {
      try {
        // Loop ogni 6h usa Opus + extended thinking (analisi profonda)
        // bypassThrottle perche' il loop e' temporizzato, non event-driven
        const r = await auditTenantRun(t.id, null, null, {
          profile: 'deep',
          bypassThrottle: true,
        });
        if (r.ok) {
          totalSuggestions += r.suggestions || 0;
          totalTokens += (r.tokens_in || 0) + (r.tokens_out || 0);
          console.log(`[aiAuditCron] ${t.name}: ${r.suggestions} sugg`);
        } else {
          console.log(`[aiAuditCron] ${t.name}: skip (${r.reason})`);
        }
      } catch (e) {
        console.warn(`[aiAuditCron] ${t.name} audit err:`, e.message);
      }
    }
    console.log(`[aiAuditCron] Audit globale: ${totalSuggestions} suggerimenti su ${tenants.length} tenant (~${totalTokens} token)`);

    // Auto-apply dopo audit
    await runAutoApply();

    // Telegram riepilogo loop
    try {
      const { sendTelegram } = require('./telegramNotifier');
      await sendTelegram(
        `🔁 AI Optimization loop completato\n` +
        `Tenant analizzati: ${tenants.length}\n` +
        `Nuovi suggerimenti: ${totalSuggestions}\n` +
        `Token consumati: ~${totalTokens}`,
        { key: 'ai_opt_loop', throttleMs: 5 * 3600 * 1000 }
      );
    } catch {}
  } catch (e) {
    console.error('[aiAuditCron] optimization loop err:', e.message);
  }
  console.log('[aiAuditCron] ===== Optimization loop END =====');
}

// Purge giornaliero: i suggerimenti pending piu' vecchi di 7gg passano a
// 'expired' (transizione di stato, storico preservato). Senza questo il
// backlog risale a migliaia di righe in pochi giorni e la UI si ingolfa.
async function purgeStalePending() {
  const { pool } = require('../db/pool');
  const { rowCount } = await pool.query(`
    UPDATE ai_audit_suggestions SET status='expired', reviewed_at=NOW()
    WHERE status='pending' AND run_at < NOW() - INTERVAL '7 days'
  `);
  if (rowCount > 0) console.log(`[aiAuditCron] Purge: ${rowCount} pending >7gg → expired`);
  return rowCount;
}

function start() {
  let lastDigestHour = -1;
  let lastOptHour = -1;
  setInterval(async () => {
    const h = new Date().getUTCHours();
    // Digest Telegram giornaliero + purge backlog (stessa finestra oraria)
    if (h === DIGEST_HOUR_UTC && lastDigestHour !== h) {
      lastDigestHour = h;
      try { await purgeStalePending(); } catch (e) { console.error('[aiAuditCron] purge err:', e.message); }
      try { await sendDigest(); } catch (e) { console.error('[aiAuditCron] digest err:', e.message); }
    } else if (h !== DIGEST_HOUR_UTC) {
      lastDigestHour = -1;
    }
    // Loop ottimizzazione AI ogni 6h (audit + auto-apply)
    if (OPTIMIZATION_HOURS_UTC.includes(h) && lastOptHour !== h) {
      lastOptHour = h;
      await runOptimizationLoop();
    } else if (!OPTIMIZATION_HOURS_UTC.includes(h)) {
      lastOptHour = -1;
    }
  }, 60 * 1000);
  console.log(`[aiAuditCron] Started — digest UTC ${DIGEST_HOUR_UTC}:00, optimization loop UTC ${OPTIMIZATION_HOURS_UTC.join(',')}:00 (ogni 6h)`);
}

module.exports = { start, sendDigest, runAutoApply, runOptimizationLoop, purgeStalePending };
