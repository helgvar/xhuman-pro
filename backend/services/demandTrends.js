/**
 * Demand Trends — Trend Detector (Margin Intelligence, strato 1 — 7/7/2026)
 *
 * "Registrare quando l'interesse entra in trend su una categoria o su un
 *  prodotto specifico: è una cosa ciclica. Qui si gioca davvero la partita."
 *
 * Giornaliero 08:50: accelerazione dell'interesse (click TP di rete, zombie)
 * ultimi 7g vs baseline 28g precedenti — per SKU e per CATEGORIA.
 *   ratio >= 1.5 (con volume minimo)  -> ENTRANTE  (la domanda accelera: margini più coraggiosi)
 *   ratio >= 1.2                      -> CALDO
 *   ratio <= 0.6                      -> RAFFREDDAMENTO (tornare competitivi)
 * Output: tabella demand_trends + digest Telegram dei trend emergenti.
 * Il calibrator legge il trend dello SKU e ne pesa l'aggressività.
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

async function runDemandTrends() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demand_trends (
      scope VARCHAR(10) NOT NULL,          -- 'sku' | 'categoria'
      chiave VARCHAR(200) NOT NULL,        -- sku o nome categoria
      click_7g NUMERIC(10,1),
      click_base_g NUMERIC(10,1),
      ratio NUMERIC(6,2),
      stato VARCHAR(16),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (scope, chiave)
    )`);

  // SKU network-level
  await pool.query(`
    WITH ck AS (
      SELECT product_code AS sku,
        SUM(clicks) FILTER (WHERE fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 7) / 7.0 AS c7,
        SUM(clicks) FILTER (WHERE fetch_date < (NOW() AT TIME ZONE 'Europe/Rome')::date - 7
          AND fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 35) / 28.0 AS cbase
      FROM zombie_clicks
      WHERE fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 35
      GROUP BY 1
      HAVING SUM(clicks) FILTER (WHERE fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 7) >= 7
    )
    INSERT INTO demand_trends (scope, chiave, click_7g, click_base_g, ratio, stato, updated_at)
    SELECT 'sku', sku, ROUND(c7, 1), ROUND(COALESCE(cbase, 0), 1),
      ROUND((c7 / NULLIF(cbase, 0))::numeric, 2),
      CASE WHEN cbase IS NULL OR cbase < 0.15 THEN 'nuovo_interesse'
           WHEN c7 / cbase >= 1.5 THEN 'entrante'
           WHEN c7 / cbase >= 1.2 THEN 'caldo'
           WHEN c7 / cbase <= 0.6 THEN 'raffreddamento'
           ELSE 'stabile' END,
      NOW()
    FROM ck
    ON CONFLICT (scope, chiave) DO UPDATE SET
      click_7g = EXCLUDED.click_7g, click_base_g = EXCLUDED.click_base_g,
      ratio = EXCLUDED.ratio, stato = EXCLUDED.stato, updated_at = NOW()`);

  // CATEGORIA network-level (prima categoria farmadati del prodotto)
  await pool.query(`
    WITH cat AS (
      SELECT DISTINCT ON (sku) sku, SPLIT_PART(category, '|', 1) AS categoria
      FROM products WHERE COALESCE(category, '') <> ''
      ORDER BY sku, tenant_id
    ),
    ck AS (
      SELECT c.categoria,
        SUM(z.clicks) FILTER (WHERE z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 7) / 7.0 AS c7,
        SUM(z.clicks) FILTER (WHERE z.fetch_date < (NOW() AT TIME ZONE 'Europe/Rome')::date - 7
          AND z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 35) / 28.0 AS cbase
      FROM zombie_clicks z JOIN cat c ON c.sku = z.product_code
      WHERE z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 35
      GROUP BY 1
      HAVING SUM(z.clicks) FILTER (WHERE z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 7) >= 35
    )
    INSERT INTO demand_trends (scope, chiave, click_7g, click_base_g, ratio, stato, updated_at)
    SELECT 'categoria', categoria, ROUND(c7, 1), ROUND(COALESCE(cbase, 0), 1),
      ROUND((c7 / NULLIF(cbase, 0))::numeric, 2),
      CASE WHEN cbase IS NULL OR cbase < 1 THEN 'nuovo_interesse'
           WHEN c7 / cbase >= 1.4 THEN 'entrante'
           WHEN c7 / cbase >= 1.15 THEN 'caldo'
           WHEN c7 / cbase <= 0.65 THEN 'raffreddamento'
           ELSE 'stabile' END,
      NOW()
    FROM ck
    ON CONFLICT (scope, chiave) DO UPDATE SET
      click_7g = EXCLUDED.click_7g, click_base_g = EXCLUDED.click_base_g,
      ratio = EXCLUDED.ratio, stato = EXCLUDED.stato, updated_at = NOW()`);

  const { rows: sum } = await pool.query(`
    SELECT scope, stato, COUNT(*) AS n FROM demand_trends
    WHERE updated_at >= NOW() - INTERVAL '10 minutes' GROUP BY 1, 2`);

  // Digest: trend emergenti (categorie entranti + top SKU entranti)
  const { rows: catUp } = await pool.query(`
    SELECT chiave, click_7g, click_base_g, ratio FROM demand_trends
    WHERE scope='categoria' AND stato='entrante' ORDER BY click_7g DESC LIMIT 8`);
  const { rows: skuUp } = await pool.query(`
    SELECT dt.chiave, dt.click_7g, dt.ratio,
      (SELECT LEFT(p.product_name, 32) FROM products p WHERE p.sku = dt.chiave LIMIT 1) AS nome
    FROM demand_trends dt
    WHERE dt.scope='sku' AND dt.stato='entrante' ORDER BY dt.click_7g DESC LIMIT 10`);

  if (catUp.length > 0 || skuUp.length > 0) {
    let msg = `📡 <b>Trend Detector</b> — interesse in accelerazione\n`;
    if (catUp.length) {
      msg += `\n<b>Categorie ENTRANTI:</b>\n` + catUp.map(c =>
        `• ${c.chiave}: ${c.click_7g} click/g (x${c.ratio} vs baseline)`).join('\n');
    }
    if (skuUp.length) {
      msg += `\n\n<b>SKU in trend:</b>\n` + skuUp.map(s =>
        `• ${s.chiave} ${s.nome || ''}: ${s.click_7g} click/g (x${s.ratio})`).join('\n');
    }
    try { await sendTelegram(msg.slice(0, 3900), { key: 'demand_trends', parseMode: 'HTML', throttleMs: 20 * 3600 * 1000 }); } catch {}
  }

  const compact = sum.map(r => `${r.scope}/${r.stato}=${r.n}`).join(' ');
  console.log(`[DemandTrends] ${compact}`);
  return { summary: sum, catEntranti: catUp.length, skuEntranti: skuUp.length };
}

let cronStarted = false;

function startDemandTrends() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    // 06:50 UTC = 08:50 italia
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 50, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try { await runDemandTrends(); } catch (e) { console.error('[DemandTrends] err:', e.message); }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[DemandTrends] Cron started — giornaliero 08:50 italia');
}

module.exports = { runDemandTrends, startDemandTrends };
