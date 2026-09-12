/**
 * Position Log (direttiva utente 5/7/2026)
 *
 * "sarebbe importante tenere un log delle posizioni scraper degli altorotanti
 *  in modo da capire se i cali sono dati da una variazione di posizione"
 *  (i competitor abbassano i prezzi nel weekend per essere aggressivi)
 *
 * Ogni giorno alle 09:45 italia (dopo lo scraper import):
 *  1. SNAPSHOT in position_snapshots: posizione + prezzo di tutti i VENDITORI
 *     (>=2 ord/30g) e di tutti gli SKU in posizione visibile (<=15)
 *  2. DROP ALERT: altorotanti (>=3 ord/30g) scesi >=4 posizioni o caduti
 *     dalla vetrina (era <=5, ora >9) vs snapshot precedente -> Telegram
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

// 🛑 FRENO (11/8/2026 sera). Questo giro macina ~20 minuti. Da quando lo
// scraper consegna ogni 15 minuti lo chiamano in due — scraperPoller e
// healthCron — e si è arrivati a QUATTRO esecuzioni contemporanee sullo stesso
// DB. Il freno sta qui e non nei chiamanti: chi chiama non può sapere cosa
// stanno facendo gli altri. Il cron giornaliero delle 09:45 passa con `force`,
// perché quello è l'appuntamento che non si salta.
const CATENA_MIN_MS = 30 * 60 * 1000;
let inCorso = false;
let ultimoGiro = null;

async function runPositionLog(opts = {}) {
  if (inCorso) { console.log('[PositionLog] già in corso, salto'); return; }
  if (!opts.force && ultimoGiro && Date.now() - ultimoGiro < CATENA_MIN_MS) {
    console.log(`[PositionLog] saltato — ultimo giro ${Math.round((Date.now() - ultimoGiro) / 60000)} min fa (minimo ${CATENA_MIN_MS / 60000})`);
    return;
  }
  inCorso = true;
  try {
    return await eseguiPositionLog();
  } finally {
    inCorso = false;
    ultimoGiro = Date.now();
  }
}

async function eseguiPositionLog() {
  // 1) Snapshot del giorno (idempotente per snap_date)
  const { rowCount } = await pool.query(`
    WITH venditori AS (
      SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_date >= NOW() - INTERVAL '30 days'
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY 1, 2 HAVING COUNT(DISTINCT o.id) >= 2
    )
    INSERT INTO position_snapshots (tenant_id, sku, snap_date, scraper_position, sell_price, ord_30d)
    SELECT p.tenant_id, p.sku, (NOW() AT TIME ZONE 'Europe/Rome')::date,
      ROUND(phs.scraper_position), p.sell_price, COALESCE(v.ord, 0)
    FROM products p
    JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
    JOIN product_health_scores phs ON phs.tenant_id = p.tenant_id AND phs.sku = p.sku
    LEFT JOIN venditori v ON v.tenant_id = p.tenant_id AND v.sku = p.sku
    WHERE phs.scraper_position IS NOT NULL
      AND (v.ord IS NOT NULL OR phs.scraper_position <= 15)
    ON CONFLICT (tenant_id, sku, snap_date) DO UPDATE SET
      scraper_position = EXCLUDED.scraper_position,
      sell_price = EXCLUDED.sell_price,
      ord_30d = EXCLUDED.ord_30d`);

  // 2) Drop alert: altorotanti scivolati vs snapshot precedente disponibile
  const { rows: drops } = await pool.query(`
    WITH prev AS (
      SELECT DISTINCT ON (tenant_id, sku) tenant_id, sku, scraper_position AS pos_old, snap_date
      FROM position_snapshots
      WHERE snap_date < (NOW() AT TIME ZONE 'Europe/Rome')::date
        AND snap_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 4
      ORDER BY tenant_id, sku, snap_date DESC
    ),
    today AS (
      SELECT tenant_id, sku, scraper_position AS pos_now, ord_30d
      FROM position_snapshots
      WHERE snap_date = (NOW() AT TIME ZONE 'Europe/Rome')::date AND ord_30d >= 3
    )
    SELECT t.name, COUNT(*) AS caduti,
      COUNT(*) FILTER (WHERE p.pos_old <= 5 AND td.pos_now > 9) AS persi_vetrina,
      SUM(td.ord_30d) AS ordini_coinvolti
    FROM today td
    JOIN prev p ON p.tenant_id = td.tenant_id AND p.sku = td.sku
    JOIN tenants t ON t.id = td.tenant_id
    WHERE td.pos_now - p.pos_old >= 4 OR (p.pos_old <= 5 AND td.pos_now > 9)
    GROUP BY t.name
    HAVING COUNT(*) >= 5
    ORDER BY caduti DESC`);

  // ⛔ PAUSA scraper (ordine capo 11/7: 'lo scraper al momento non è da
  // prendere in considerazione'): con dump decimato i 'caduti' sono rumore
  // statistico della rotazione, non crolli veri. Alert silenziato.
  const posAlertPaused = await require('./scraperPause').isScraperOptimizationPaused();
  if (drops.length > 0 && posAlertPaused) {
    console.log(`[PositionLog] Drop alert SILENZIATO (pausa scraper): ${drops.length} tenant con cadute apparenti`);
  }
  if (drops.length > 0 && !posAlertPaused) {
    let msg = `📉 <b>Position Drop Alert</b> (altorotanti scivolati vs snapshot prec.)\n\n`;
    for (const d of drops) {
      msg += `${d.name}: ${d.caduti} caduti (${d.persi_vetrina} fuori vetrina) — ${d.ordini_coinvolti} ord/30g coinvolti\n`;
    }
    msg += `\nProbabile pressione prezzi competitor. Check: engine PC al prossimo giro + valutare riconquista su dati scraper freschi.`;
    try { await sendTelegram(msg, { key: 'position_drop', parseMode: 'HTML', throttleMs: 12 * 3600 * 1000 }); } catch {}
  }
  // 3) Refresh floor_overrides — REGOLA BASE (direttiva 7/7): sotto il 15%
  //    si scende SOLO se il prodotto è VERO altorotante 30gg (>=3 ordini)
  //    E da fornitura esterna pura (erp_stock=0, supplier>0) E sotto regola
  //    grossista. floor_overrides è l'UNICO canale dei floor sotto-15:
  //    - cluster (>=2 seller a prezzo identico) -> 11.50
  //    - tenant con ricarico_floor_grossista (SubitoFarma 11) -> il suo cap
  //    - prevale il più basso; tutti gli altri prodotti: regole normali 15/18.
  try {
    // PAUSA scraper (ordine capo 11/7): i floor sotto-15 derivano dai cluster
    // scraper — sospesi finché il capo non riattiva (il purge scaduti resta)
    const scraperPaused = await require('./scraperPause').isScraperOptimizationPaused();
    if (!scraperPaused) await pool.query(`
      WITH venditori AS (
        SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.order_date >= NOW() - INTERVAL '30 days'
          AND o.order_status NOT IN ('canceled','closed','pending_payment')
        GROUP BY 1, 2 HAVING COUNT(DISTINCT o.id) >= 3
      ),
      cluster AS (
        SELECT DISTINCT sc.product_code AS sku
        FROM scraper_competitors sc
        WHERE sc.base_price > 0
          -- guardrail freschezza (retention 7g dal 11/7): un doppione di prezzo
          -- vecchio di giorni fabbricherebbe un muro fantasma e abbasserebbe il floor
          AND sc.scraped_at >= NOW() - INTERVAL '48 hours'
        -- PREZZO SECCO (capo 21/8): cluster sul prezzo prodotto, non sul totale
        GROUP BY sc.product_code, sc.base_price
        HAVING COUNT(*) >= 2
      ),
      qualificati AS (
        SELECT v.tenant_id, v.sku,
          LEAST(
            CASE WHEN c.sku IS NOT NULL THEN 11.50 ELSE 15 END,
            COALESCE((SELECT hc.config_value::numeric FROM health_config hc
                      WHERE hc.tenant_id = v.tenant_id
                        AND hc.config_key = 'ricarico_floor_grossista'), 15)
          ) AS floor_pct
        FROM venditori v
        JOIN products p ON p.tenant_id = v.tenant_id AND p.sku = v.sku
        LEFT JOIN cluster c ON c.sku = v.sku
        WHERE p.erp_stock = 0
          AND COALESCE(p.supplier_stock, 0) > 0
          AND COALESCE((SELECT pr.rule_name ~* 'grossist' FROM price_rules pr
                        WHERE pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id), true)
          AND p.saleable = true AND p.erp_cost > 0
      )
      INSERT INTO floor_overrides (tenant_id, sku, floor_pct, reason, updated_at)
      SELECT tenant_id, sku, floor_pct,
        'altorotante 30g da supplier (regola base 7/7)', NOW()
      FROM qualificati WHERE floor_pct < 15
      ON CONFLICT (tenant_id, sku) DO UPDATE SET floor_pct = EXCLUDED.floor_pct, updated_at = NOW()`);
    const { rowCount: purged } = await pool.query(
      `DELETE FROM floor_overrides WHERE updated_at < NOW() - INTERVAL '4 days'`);
    console.log(`[PositionLog] floor_overrides ${scraperPaused ? 'SKIP (pausa scraper)' : 'refresh ok'}, ${purged} scaduti rimossi`);
  } catch (e) {
    console.error('[PositionLog] floor_overrides err:', e.message);
  }

  // 4) BRAND COVERAGE (quadra Eucerin 8/7): nessuna linea si smembra più in
  //    silenzio — se un brand con domanda di rete provata ha copertura CSV
  //    sotto il 60%% dei vendibili, alert con i numeri.
  try {
    const { rows: gaps } = await pool.query(`
      WITH brand_stat AS (
        SELECT p.tenant_id, t.name AS tname, UPPER(p.brand) AS brand,
          COUNT(*) FILTER (WHERE p.saleable AND (p.erp_stock + COALESCE(p.supplier_stock,0)) > 0) AS vendibili,
          COUNT(*) FILTER (WHERE p.saleable AND (p.erp_stock + COALESCE(p.supplier_stock,0)) > 0
            AND EXISTS (SELECT 1 FROM tenant_configs tc WHERE tc.tenant_id = p.tenant_id
              AND tc.config_key = 'stable_feed_codes' AND (tc.config_value::jsonb->'codes') ? p.sku)) AS nel_csv,
          SUM(COALESCE(p.sales_30d_aggregated, 0)) AS domanda_rete
        FROM products p
        JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
        WHERE COALESCE(p.brand, '') <> ''
        GROUP BY 1, 2, 3
        HAVING COUNT(*) FILTER (WHERE p.saleable AND (p.erp_stock + COALESCE(p.supplier_stock,0)) > 0) >= 20
          AND SUM(COALESCE(p.sales_30d_aggregated, 0)) >= 20
      )
      SELECT tname, brand, vendibili, nel_csv,
        ROUND(100.0 * nel_csv / vendibili) AS copertura_pct, domanda_rete
      FROM brand_stat
      WHERE nel_csv < vendibili * 0.6
      ORDER BY domanda_rete DESC LIMIT 12`);
    if (gaps.length > 0) {
      let msg = `🧩 <b>Brand Coverage Alert</b>: linee con domanda ma copertura CSV sotto 60%\n\n`;
      for (const g of gaps) {
        msg += `${g.tname} ${g.brand}: ${g.nel_csv}/${g.vendibili} nel CSV (${g.copertura_pct}%) — domanda rete ${g.domanda_rete}\n`;
      }
      try { await sendTelegram(msg.slice(0, 3900), { key: 'brand_coverage', parseMode: 'HTML', throttleMs: 20 * 3600 * 1000 }); } catch {}
      console.log(`[PositionLog] brand coverage: ${gaps.length} linee sotto soglia`);
    }
  } catch (e) {
    console.error('[PositionLog] brand coverage err:', e.message);
  }

  console.log(`[PositionLog] snapshot ${rowCount} righe, drop alert: ${drops.length} tenant`);
  return { snapshot: rowCount, drops };
}

let cronStarted = false;

function startPositionLog() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    // 07:45 UTC = 09:45 italia (estate), dopo scraper import del mattino
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 45, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try { await runPositionLog({ force: true }); } catch (e) { console.error('[PositionLog] err:', e.message); }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[PositionLog] Cron started — giornaliero 07:45 UTC (09:45 italia)');
}

module.exports = { runPositionLog, startPositionLog };
