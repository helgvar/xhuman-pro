/**
 * Position Economics (direttiva FONDAMENTALE utente 7/7/2026)
 *
 * "Fai un confronto giornaliero quando non ti trovi in prima posizione e
 *  cerca sempre di capire qual è il posizionamento migliore per margine e
 *  numero vendite."
 *
 * Giornaliero 08:45 italia: per ogni altorotante, dallo storico
 * feed_daily_tracking (posizione + ordini + margine per giorno) calcola la
 * resa per BANDA di posizione (1 / 2-3 / 4-6 / 7-10 / >10):
 *   margine/giorno = la metrica regina (margine x vendite insieme).
 * Salva la banda migliore in position_economics e segnala su Telegram i
 * "mal posizionati": banda attuale != banda storicamente più redditizia.
 * L'AI Margin Calibrator legge la banda migliore e ne tiene conto.
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

async function runPositionEconomics() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS position_economics (
      tenant_id UUID NOT NULL,
      sku VARCHAR(100) NOT NULL,
      best_band VARCHAR(8),
      current_band VARCHAR(8),
      stats JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, sku)
    )`);

  const { rows } = await pool.query(`
    WITH alto AS (
      SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_date >= NOW() - INTERVAL '15 days'
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY 1, 2 HAVING COUNT(DISTINCT o.id) >= 3
    ),
    bande AS (
      SELECT fdt.tenant_id, fdt.sku,
        CASE WHEN fdt.scraper_position <= 1 THEN '1'
             WHEN fdt.scraper_position <= 3 THEN '2-3'
             WHEN fdt.scraper_position <= 6 THEN '4-6'
             WHEN fdt.scraper_position <= 10 THEN '7-10'
             ELSE '>10' END AS banda,
        COUNT(DISTINCT fdt.track_date) AS giorni,
        SUM(COALESCE(fdt.orders, 0)) AS ordini,
        SUM(COALESCE(fdt.margin_earned, 0)) AS margine
      FROM feed_daily_tracking fdt
      JOIN alto a ON a.tenant_id = fdt.tenant_id AND a.sku = fdt.sku
      WHERE fdt.track_date >= NOW() - INTERVAL '15 days'
        AND fdt.scraper_position IS NOT NULL
      GROUP BY 1, 2, 3
      HAVING COUNT(DISTINCT fdt.track_date) >= 3
    ),
    ranked AS (
      SELECT tenant_id, sku, banda, giorni, ordini,
        ROUND((margine / giorni)::numeric, 2) AS margine_g,
        ROW_NUMBER() OVER (PARTITION BY tenant_id, sku ORDER BY margine / giorni DESC) AS rk,
        COUNT(*) OVER (PARTITION BY tenant_id, sku) AS n_bande
      FROM bande
    ),
    best AS (
      SELECT r.tenant_id, r.sku, r.banda AS best_band, r.margine_g AS best_margine_g,
        (SELECT jsonb_object_agg(r2.banda, jsonb_build_object('giorni', r2.giorni, 'ordini', r2.ordini, 'margine_g', r2.margine_g))
         FROM ranked r2 WHERE r2.tenant_id = r.tenant_id AND r2.sku = r.sku) AS stats
      FROM ranked r
      WHERE r.rk = 1 AND r.n_bande >= 2
    )
    INSERT INTO position_economics (tenant_id, sku, best_band, current_band, stats, updated_at)
    SELECT b.tenant_id, b.sku, b.best_band,
      CASE WHEN phs.scraper_position <= 1 THEN '1'
           WHEN phs.scraper_position <= 3 THEN '2-3'
           WHEN phs.scraper_position <= 6 THEN '4-6'
           WHEN phs.scraper_position <= 10 THEN '7-10'
           WHEN phs.scraper_position IS NULL THEN NULL
           ELSE '>10' END,
      b.stats, NOW()
    FROM best b
    LEFT JOIN product_health_scores phs ON phs.tenant_id = b.tenant_id AND phs.sku = b.sku
    ON CONFLICT (tenant_id, sku) DO UPDATE SET
      best_band = EXCLUDED.best_band, current_band = EXCLUDED.current_band,
      stats = EXCLUDED.stats, updated_at = NOW()
    RETURNING tenant_id, sku, best_band, current_band`);

  const misplaced = rows.filter(r => r.current_band && r.best_band !== r.current_band);

  // Report: i mal posizionati più pesanti per tenant
  if (misplaced.length > 0) {
    const { rows: top } = await pool.query(`
      SELECT t.name, pe.sku, pe.current_band, pe.best_band,
        (pe.stats->pe.best_band->>'margine_g')::numeric AS best_mg,
        COALESCE((pe.stats->pe.current_band->>'margine_g')::numeric, 0) AS cur_mg
      FROM position_economics pe
      JOIN tenants t ON t.id = pe.tenant_id
      WHERE pe.updated_at >= NOW() - INTERVAL '10 minutes'
        AND pe.current_band IS NOT NULL AND pe.best_band <> pe.current_band
        AND (pe.stats->pe.best_band->>'margine_g')::numeric >
            COALESCE((pe.stats->pe.current_band->>'margine_g')::numeric, 0) * 1.5
      ORDER BY (pe.stats->pe.best_band->>'margine_g')::numeric -
               COALESCE((pe.stats->pe.current_band->>'margine_g')::numeric, 0) DESC
      LIMIT 12`);
    if (top.length > 0) {
      let msg = `🎯 <b>Position Economics</b>: ${misplaced.length} altorotanti fuori dalla banda più redditizia\n\n`;
      for (const r of top) {
        msg += `${r.name} ${r.sku}: ora banda ${r.current_band} (€${r.cur_mg}/g) → storicamente banda ${r.best_band} rende €${r.best_mg}/g\n`;
      }
      try { await sendTelegram(msg.slice(0, 3900), { key: 'pos_economics', parseMode: 'HTML', throttleMs: 20 * 3600 * 1000 }); } catch {}
    }
  }

  console.log(`[PosEconomics] ${rows.length} altorotanti con storico multi-banda, ${misplaced.length} fuori banda ottima`);
  return { analyzed: rows.length, misplaced: misplaced.length };
}

let cronStarted = false;

function startPositionEconomics() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    // 06:45 UTC = 08:45 italia (estate), dopo scrape full e positionLog
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 45, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try { await runPositionEconomics(); } catch (e) { console.error('[PosEconomics] err:', e.message); }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[PosEconomics] Cron started — giornaliero 08:45 italia');
}

module.exports = { runPositionEconomics, startPositionEconomics };
