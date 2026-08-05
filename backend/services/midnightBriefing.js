/**
 * Midnight Briefing (direttiva utente 9/7/2026)
 *
 * "Ogni sera a mezzanotte prepara un check per combattere la giornata
 * successiva." Alle 00:05 Italia compila il rapporto di battaglia:
 *   1. Consuntivo di ieri per tenant (ordini/rev vs stesso giorno-settimana)
 *   2. Posizioni TP: chi ha perso terreno, crolli sui venditori, banda d'oro
 *   3. Stato guardie (blocchi su protetti, veti 24h, sotto-costo, dati stantii)
 *   4. Scadenze config nelle prossime 24h (freeze, briglie temporanee)
 *   5. Sorvegliati speciali del giorno
 * Telegram sempre: è il briefing che si legge al mattino.
 */

const { pool } = require('../db/pool');
const { sendTelegram, fmtEur } = require('./telegramNotifier');

async function runMidnightBriefing() {
  const S = [];

  // ── 1. Consuntivo di ieri (giorno pieno, Europe/Rome) ──────────────────
  try {
    const { rows } = await pool.query(`
      WITH ieri AS (SELECT ((NOW() AT TIME ZONE 'Europe/Rome')::date - 1) AS d),
      base_days AS (
        SELECT (SELECT d FROM ieri) - (7 * k) AS d FROM generate_series(1, 3) k),
      ord AS (
        SELECT o.tenant_id,
          COUNT(*) FILTER (WHERE o.order_date::date = (SELECT d FROM ieri)) AS n_ieri,
          COALESCE(SUM(o.subtotal_incl_tax) FILTER (WHERE o.order_date::date = (SELECT d FROM ieri)), 0) AS rev_ieri,
          COUNT(*) FILTER (WHERE o.order_date::date IN (SELECT d FROM base_days))::numeric / 3 AS n_base,
          COALESCE(SUM(o.subtotal_incl_tax) FILTER (WHERE o.order_date::date IN (SELECT d FROM base_days)), 0) / 3 AS rev_base
        FROM orders o
        WHERE o.order_status NOT IN ('canceled','closed')
          AND (o.order_date::date = (SELECT d FROM ieri) OR o.order_date::date IN (SELECT d FROM base_days))
        GROUP BY o.tenant_id),
      clk AS (
        SELECT z.tenant_id, SUM(z.clicks) AS c FROM zombie_clicks z
        WHERE z.fetch_date = (SELECT d FROM ieri) GROUP BY z.tenant_id)
      SELECT t.name, o.n_ieri, ROUND(o.rev_ieri) rev, ROUND(o.n_base, 1) n_base,
        ROUND(o.rev_base) rev_base, COALESCE(c.c, 0) click,
        ROUND(COALESCE(c.c, 0) * 0.3294) spesa
      FROM ord o JOIN tenants t ON t.id = o.tenant_id AND t.status = 'active'
      LEFT JOIN clk c ON c.tenant_id = o.tenant_id
      ORDER BY o.rev_ieri DESC`);
    const righe = rows.map(r => {
      const base = parseFloat(r.rev_base) || 0;
      const pct = base > 0 ? Math.round(parseFloat(r.rev) / base * 100) : 100;
      const flag = pct < 75 ? '🔴' : pct < 90 ? '🟡' : '🟢';
      return `${flag} ${r.name}: ${r.n_ieri} ord / ${fmtEur(r.rev)} (${pct}% del solito) — spesa ${fmtEur(r.spesa)}`;
    });
    S.push(`<b>📊 IERI</b>\n${righe.join('\n')}`);
  } catch (e) { S.push(`📊 IERI: errore (${e.message.slice(0, 50)})`); }

  // ── 2. Posizioni TP ─────────────────────────────────────────────────────
  try {
    const { rows: pos } = await pool.query(`
      WITH oggi AS (SELECT * FROM position_snapshots WHERE snap_date = (SELECT MAX(snap_date) FROM position_snapshots)),
      prima AS (SELECT * FROM position_snapshots WHERE snap_date = (SELECT MAX(snap_date) - 2 FROM position_snapshots))
      SELECT t.name,
        COUNT(*) FILTER (WHERE o.scraper_position > pr.scraper_position + 2) AS persi,
        (SELECT COUNT(*) FROM position_economics pe WHERE pe.tenant_id = t.id AND pe.best_band <> pe.current_band) AS fuori_banda
      FROM oggi o JOIN tenants t ON t.id = o.tenant_id AND t.status = 'active'
      LEFT JOIN prima pr ON pr.tenant_id = o.tenant_id AND pr.sku = o.sku
      GROUP BY t.id, t.name HAVING COUNT(*) FILTER (WHERE o.scraper_position > pr.scraper_position + 2) > 300
      ORDER BY 2 DESC LIMIT 4`);
    const { rows: crolli } = await pool.query(`
      SELECT t.name, o.sku, pr.scraper_position AS da, o.scraper_position AS a, o.ord_30d
      FROM position_snapshots o
      JOIN position_snapshots pr ON pr.tenant_id = o.tenant_id AND pr.sku = o.sku
        AND pr.snap_date = (SELECT MAX(snap_date) - 2 FROM position_snapshots)
      JOIN tenants t ON t.id = o.tenant_id AND t.status = 'active'
      WHERE o.snap_date = (SELECT MAX(snap_date) FROM position_snapshots)
        AND o.scraper_position > pr.scraper_position + 4 AND o.ord_30d >= 5
      ORDER BY o.ord_30d DESC LIMIT 5`);
    const p1 = pos.map(p => `${p.name}: ${p.persi} SKU in ritirata, ${p.fuori_banda} fuori banda d'oro`).join('\n');
    const p2 = crolli.map(c => `  ⚠️ ${c.name} ${c.sku}: pos ${c.da}→${c.a} (${c.ord_30d} ord/30g)`).join('\n');
    S.push(`<b>📉 POSIZIONI (48h)</b>\n${p1 || 'nessuna ritirata di massa'}${p2 ? '\nVenditori in crollo:\n' + p2 : ''}`);
  } catch (e) { S.push(`📉 POSIZIONI: errore (${e.message.slice(0, 50)})`); }

  // ── 3. Stato guardie ────────────────────────────────────────────────────
  try {
    const { rows: [g] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM feed_killers fk WHERE fk.is_active
          AND (is_basket_protected(fk.tenant_id, fk.sku) OR is_brand_protected(fk.tenant_id, fk.sku)
               OR is_stock_protected(fk.tenant_id, fk.sku)))
        + (SELECT COUNT(*) FROM feed_quarantine fq WHERE fq.reactivated = false AND fq.reason NOT LIKE 'cost_diet%'
          AND (is_basket_protected(fq.tenant_id, fq.sku) OR is_brand_protected(fq.tenant_id, fq.sku)
               OR is_stock_protected(fq.tenant_id, fq.sku))) AS blocchi_su_protetti,
        (SELECT COUNT(*) FROM basket_veto_log WHERE vetoed_at > NOW() - INTERVAL '24 hours') AS veti_24h,
        (SELECT COUNT(*) FROM basket_veto_log WHERE vetoed_at > NOW() - INTERVAL '24 hours'
          AND target_table IN ('feed_actions:SOTTO_COSTO','feed_actions:REGOLA_SCONTO')) AS veti_prezzo_24h,
        (SELECT COUNT(*) FROM feed_actions fa JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
          WHERE fa.recommended_price IS NOT NULL
            AND fa.recommended_price < GREATEST(COALESCE(NULLIF(p.erp_cost, 0), 0),
              CASE WHEN COALESCE(p.erp_stock, 0) > 0 THEN COALESCE(p.erp_purchase_cost, 0) ELSE 0 END)) AS rec_sotto_costo,
        (SELECT COUNT(*) FROM products p JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
          WHERE p.is_civetta AND p.updated_at < NOW() - INTERVAL '12 hours') AS civetta_stantii_12h`);
    const ok = (v, label) => `${parseInt(v) === 0 ? '✅' : '🚨'} ${label}: ${v}`;
    S.push(`<b>🛡 GUARDIE</b>\n${ok(g.blocchi_su_protetti, 'blocchi su protetti')}\n${ok(g.rec_sotto_costo, 'raccomandazioni sotto costo')}\n${ok(g.civetta_stantii_12h, 'civetta con dati stantii >12h')}\n▫️ veti 24h: ${g.veti_24h} (di cui prezzo: ${g.veti_prezzo_24h})`);
  } catch (e) { S.push(`🛡 GUARDIE: errore (${e.message.slice(0, 50)})`); }

  // ── 4. Scadenze prossime 24h ────────────────────────────────────────────
  try {
    const { rows } = await pool.query(`
      SELECT t.name, hc.config_key, hc.config_value,
        TO_CHAR(hc.expires_at AT TIME ZONE 'Europe/Rome', 'HH24:MI') AS ora
      FROM health_config hc JOIN tenants t ON t.id = hc.tenant_id
      WHERE hc.expires_at IS NOT NULL AND hc.expires_at BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
      ORDER BY hc.expires_at`);
    if (rows.length > 0) {
      S.push(`<b>⏰ SCADENZE OGGI</b>\n` + rows.map(r => `${r.name}: ${r.config_key}=${r.config_value} scade alle ${r.ora}`).join('\n'));
    }
  } catch (e) { /* sezione opzionale */ }

  // ── 5. Sorvegliati speciali ─────────────────────────────────────────────
  try {
    const { rows } = await pool.query(`
      WITH ieri AS (SELECT ((NOW() AT TIME ZONE 'Europe/Rome')::date - 1) AS d),
      clk AS (
        SELECT z.tenant_id,
          SUM(z.clicks) FILTER (WHERE z.fetch_date = (SELECT d FROM ieri)) AS ieri,
          SUM(z.clicks) FILTER (WHERE z.fetch_date BETWEEN (SELECT d FROM ieri) - 7 AND (SELECT d FROM ieri) - 1) / 7.0 AS media
        FROM zombie_clicks z GROUP BY z.tenant_id)
      SELECT t.name,
        CASE WHEN COALESCE(c.ieri, 0) < c.media * 0.4 AND c.media > 100 THEN 'click -60% vs media: budget in esaurimento?' END AS motivo
      FROM tenants t LEFT JOIN clk c ON c.tenant_id = t.id
      WHERE t.status = 'active'
        AND COALESCE(c.ieri, 0) < c.media * 0.4 AND c.media > 100`);
    if (rows.length > 0) {
      S.push(`<b>👁 SORVEGLIATI</b>\n` + rows.map(r => `${r.name}: ${r.motivo}`).join('\n'));
    }
  } catch (e) { /* sezione opzionale */ }

  const msg = `🌙 <b>BRIEFING DI MEZZANOTTE — piano di battaglia ${new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}</b>\n\n${S.join('\n\n')}`;
  console.log('[MidnightBriefing]', S.length, 'sezioni compilate');
  try { await sendTelegram(msg, { key: 'midnight_briefing', parseMode: 'HTML' }); } catch (e) {
    console.error('[MidnightBriefing] telegram err:', e.message);
  }
  return msg;
}

let cronStarted = false;

function startMidnightBriefing() {
  if (cronStarted) return;
  cronStarted = true;
  // 00:05 Italia estiva = 22:05 UTC
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(22, 5, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(() => {
      runMidnightBriefing().catch(e => console.error('[MidnightBriefing] err:', e.message));
      schedule();
    }, next - now);
  };
  schedule();
  console.log('[MidnightBriefing] Cron attivo — ogni notte 22:05 UTC (00:05 Italia)');
}

module.exports = { runMidnightBriefing, startMidnightBriefing };
