/**
 * 🔔 SIRENA DI CONFORMITÀ (capo 14/7: "risuccederà?")
 *
 * Ogni mattina alle 07:00 italiane ricontrolla che NESSUNA legge sia violata
 * nello stato reale del DB — non nella teoria dei motori:
 *  C1. Blocchi (killer/quarantene/REMOVE) su SKU protetti (is_feed_protected)
 *  C2. Blocchi su SKU che vendono in RETE 15g (legge L2, mig 060)
 *  C3. Raccomandazioni SOPRA il prezzo vivo (legge L1 — mai rialzi)
 *  C4. Tocchi ANONIMI alle azioni nelle ultime 24h (tutti i motori si firmano)
 *  C5. Veti arbitro nelle ultime 24h (fuoco amico tentato — chi e quanto)
 *
 * Ogni violazione > 0 → Telegram con dettaglio. Tutto a zero → riga di log.
 * La differenza col passato: il fuoco amico si scopre in ORE, non in giorni.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

async function runConformityCheck() {
  const out = {};
  try {
    const { rows: [c] } = await pool.query(`
      WITH bloccati AS (
        SELECT fk.tenant_id, fk.sku FROM feed_killers fk WHERE fk.is_active
        UNION ALL
        SELECT fq.tenant_id, fq.sku FROM feed_quarantine fq
        WHERE fq.reactivated=false AND COALESCE(fq.manual_override,false)=false
        UNION ALL
        SELECT fa.tenant_id, fa.sku FROM feed_actions fa WHERE fa.action='REMOVE')
      SELECT
        COUNT(*) FILTER (WHERE is_feed_protected(b.tenant_id, b.sku))::int AS c1_protetti_bloccati,
        COUNT(*) FILTER (WHERE vende_in_rete_15g(b.sku))::int AS c2_vendenti_bloccati
      FROM bloccati b`);
    out.c1 = c.c1_protetti_bloccati;
    out.c2 = c.c2_vendenti_bloccati;

    const { rows: [r] } = await pool.query(`
      SELECT COUNT(*)::int AS c3 FROM feed_actions fa
      JOIN products p ON p.tenant_id=fa.tenant_id AND p.sku=fa.sku
      WHERE fa.recommended_price IS NOT NULL
        AND fa.recommended_price > COALESCE(p.applied_price, p.exported_price, p.sell_price) + 0.005`);
    out.c3 = r.c3;

    const { rows: [a] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE writer='anonimo')::int AS c4,
             COUNT(*) FILTER (WHERE operazione='veto_arbitro')::int AS c5
      FROM azioni_touch_log WHERE touched_at >= NOW() - INTERVAL '24 hours'`);
    out.c4 = a.c4;
    out.c5 = a.c5;

    const viol = out.c1 + out.c2 + out.c3 + out.c4;
    if (viol > 0) {
      let det = '';
      if (out.c2 > 0) {
        const { rows } = await pool.query(`
          WITH bloccati AS (
            SELECT fk.tenant_id, fk.sku FROM feed_killers fk WHERE fk.is_active
            UNION ALL SELECT fq.tenant_id, fq.sku FROM feed_quarantine fq
              WHERE fq.reactivated=false AND COALESCE(fq.manual_override,false)=false
            UNION ALL SELECT fa.tenant_id, fa.sku FROM feed_actions fa WHERE fa.action='REMOVE')
          SELECT t.name, COUNT(*) n FROM bloccati b JOIN tenants t ON t.id=b.tenant_id
          WHERE vende_in_rete_15g(b.sku) GROUP BY 1 ORDER BY n DESC LIMIT 5`);
        det = '\n' + rows.map(x => `  ${x.name}: ${x.n} vendenti bloccati`).join('\n');
      }
      await sendTelegram(
        `🔔 CONFORMITÀ: ${viol} violazioni stamattina\n` +
        `C1 protetti bloccati: ${out.c1}\nC2 vendenti-rete bloccati: ${out.c2}${det}\n` +
        `C3 rialzi vivi: ${out.c3}\nC4 tocchi anonimi 24h: ${out.c4}\n` +
        `(veti arbitro 24h: ${out.c5} — fuoco amico bloccato)\n` +
        `Dettaglio: dashboard /arbitro + azioni_touch_log`);
    }
    console.log(`[Conformity] C1=${out.c1} C2=${out.c2} C3=${out.c3} C4=${out.c4} veti24h=${out.c5}${viol > 0 ? ' ⚠️ TELEGRAM' : ' ✓'}`);
    return out;
  } catch (e) {
    console.error('[Conformity] err:', e.message);
    try { await sendTelegram(`🔔 CONFORMITÀ: check FALLITO (${e.message}) — controllare a mano`); } catch {}
    return null;
  }
}

function start() {
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(5, 0, 0, 0);                    // 05:00 UTC = 07:00 Italia
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      await runConformityCheck();
      schedule();
    }, next - now);
    console.log(`[Conformity] Sirena armata — prossimo check ${next.toISOString()}`);
  };
  schedule();
}

module.exports = { start, runConformityCheck };
