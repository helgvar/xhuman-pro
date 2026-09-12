/**
 * Feed Hygiene Cycle (direttiva utente 11/7/2026)
 *
 * "La pulizia dei retroattivi una volta al giorno non è pensabile: deve
 * girare almeno 4 volte al giorno PRIMA che passi Trovaprezzi — 06:00,
 * 11:00, 14:00, 18:00 — così aggiorniamo Magento in tempo. Questo ritmo
 * vale per TUTTE le azioni che inseriscono o levano prodotti dal feed."
 *
 * Ogni ciclo, in ordine:
 *  1. AMNISTIA COMPLETA: killer/quarantene/REMOVE su prodotti protetti
 *     (6 classi: carrello, brand, stock, seller, top10, freschezza)
 *  2. OBLIO: rilascio degli SKU con meriti sopravvenuti
 *  3. PREZZI DERIVATI: neutralizza le rec rese illegittime dal movimento
 *     delle regole FB (muro, sopra-regola, fuori-SB)
 *  4. REBUILD di TUTTI i CSV → Magento riceve lo stato pulito prima di TP
 *  5. Report Telegram compatto
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

async function runFeedHygieneCycle() {
  const t0 = Date.now();
  const R = {};

  // 1. Amnistia completa (6 classi di protezione)
  try {
    R.killer = (await pool.query(
      'UPDATE feed_killers fk SET is_active=false WHERE fk.is_active AND is_feed_protected(fk.tenant_id, fk.sku)')).rowCount;
    R.quarantene = (await pool.query(
      `UPDATE feed_quarantine fq SET reactivated=true, reactivated_at=NOW()
       WHERE fq.reactivated=false AND is_feed_protected(fq.tenant_id, fq.sku)`)).rowCount;
    R.remove = (await pool.query(
      `DELETE FROM feed_actions fa WHERE fa.action='REMOVE' AND is_feed_protected(fa.tenant_id, fa.sku)`)).rowCount;
  } catch (e) { console.error('[Hygiene] amnistia err:', e.message); }

  // 1b. TREND IN SALITA (11/7: 'ragiona su chi POTREBBE vendere'): bloccati
  // con domanda click in crescita (entrante/caldo) = condannati in un regime
  // di domanda che non esiste più. L'evidenza è scaduta → liberi.
  try {
    R.trend_killer = (await pool.query(`
      UPDATE feed_killers fk SET is_active=false
      FROM demand_trends dt WHERE dt.scope='sku' AND dt.chiave=fk.sku
        AND dt.stato IN ('entrante','caldo') AND fk.is_active`)).rowCount;
    R.trend_quar = (await pool.query(`
      UPDATE feed_quarantine fq SET reactivated=true, reactivated_at=NOW()
      FROM demand_trends dt WHERE dt.scope='sku' AND dt.chiave=fq.sku
        AND dt.stato IN ('entrante','caldo') AND fq.reactivated=false`)).rowCount;
    R.trend_remove = (await pool.query(`
      DELETE FROM feed_actions fa
      USING demand_trends dt WHERE dt.scope='sku' AND dt.chiave=fa.sku
        AND dt.stato IN ('entrante','caldo') AND fa.action='REMOVE'`)).rowCount;
  } catch (e) { console.error('[Hygiene] trend err:', e.message); }

  // 2. Oblio con meriti sopravvenuti (vendite seller, stock fisico, brand,
  //    vendite di RETE — censimento 13/7: OBLIO = 0 vendite OVUNQUE, quindi
  //    un ordine reale su qualsiasi tenant falsifica l'evidenza)
  try {
    R.oblio = (await pool.query(`
      UPDATE cross_tenant_oblio o SET status='released', released_at=NOW(),
        released_reason='igiene 4x: meriti sopravvenuti (seller/stock/brand/rete)'
      WHERE o.status='active' AND (
        EXISTS (
          SELECT 1 FROM products p WHERE p.sku=o.sku
            AND (COALESCE(p.sales_30d_seller,0) > 0
                 OR (COALESCE(p.erp_stock,0) >= 5 AND COALESCE(p.margin_pct,0) >= 20)
                 OR is_brand_protected(p.tenant_id, p.sku)))
        OR EXISTS (
          SELECT 1 FROM orders ord JOIN order_items oi ON oi.order_id=ord.id
          WHERE oi.sku=o.sku AND ord.order_date >= NOW()-INTERVAL '30 days'
            AND ord.order_status NOT IN ('canceled','closed','pending_payment')))`)).rowCount;
  } catch (e) { console.error('[Hygiene] oblio err:', e.message); }

  // 3. Prezzi derivati: rec rese illegittime dal movimento regole FB.
  // PERIMETRO VERO (mig. 052/054, fix 13/7): usa is_price_cut_allowed —
  // la vecchia 'NOT is_salva_bilancio' annullava i PC legali su Ricarico
  // con vendite (225 PC di Farmastelia falciati alle 06:00). Gli scavalchi
  // muro (action_source='muro_scavalco') hanno la loro legge dedicata (053)
  // e la sentinella di riallineo: qui non si toccano.
  // ARBITRO (mig. 058): l'igiene si FIRMA — tocchi anonimi alle azioni manuali
  // vengono vetati dal trigger trg_arbitro_azioni. Transazione + SET LOCAL.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('xhp.writer', 'igiene_prezzi_derivati', true),
      set_config('xhp.motivo', 'legge: fuori perimetro PC / sopra sell_price / sotto costo', true)`);
    R.prezzi_derivati = (await client.query(`
      UPDATE feed_actions fa SET recommended_price = NULL
      FROM products p, tenants t
      WHERE p.tenant_id=fa.tenant_id AND p.sku=fa.sku AND t.id=fa.tenant_id AND t.status='active'
        AND fa.recommended_price IS NOT NULL
        AND fa.action_source <> 'muro_scavalco'
        -- Guardia legame regola (31/8): durante products_sync le price_rules
        -- vengono rifatte PRIMA dei prodotti, quindi chi punta a un rule_id
        -- gia' sparito non trova match e risulta fuori perimetro PC anche se
        -- non lo e'. Misurato: 10.401 orfani su San Vito, 3.630 su Farmastelia
        -- a sync in volo. Non si condanna su legame rotto.
        AND (p.price_rule_id IS NULL OR EXISTS (
              SELECT 1 FROM price_rules pr
              WHERE pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id))
        -- Guardia sync in volo: a catalogo in scrittura anche sell_price ed
        -- erp_cost sono in transito. Finestra 60 min per non restare bloccati
        -- su un job incastrato.
        AND NOT EXISTS (
              SELECT 1 FROM import_jobs ij
              WHERE ij.tenant_id = fa.tenant_id AND ij.job_type = 'products_sync'
                AND ij.status = 'running' AND ij.created_at > NOW() - INTERVAL '60 minutes')
        AND (NOT is_price_cut_allowed(fa.tenant_id, fa.sku)
             OR fa.recommended_price > p.sell_price - 0.01
             OR fa.recommended_price < GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
                 CASE WHEN COALESCE(p.erp_stock,0)>0 THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END))`)).rowCount;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Hygiene] prezzi err:', e.message);
  } finally { client.release(); }

  // Retention log arbitro: 30 giorni
  try {
    await pool.query(`DELETE FROM azioni_touch_log WHERE touched_at < NOW() - INTERVAL '30 days'`);
  } catch (e) { console.error('[Hygiene] touch_log purge err:', e.message); }

  // 3b. CACCIA ALLE OPPORTUNITÀ (dictat 11/7: 'questo è il tuo compito —
  // aumentare il fatturato e tagliare la spesa, da solo, a ogni giro'):
  // bloccati che la RETE vende con margine per il podio (3°/4° prezzo -0,01
  // sopra il floor di fascia) → liberati + PC se Salva Bilancio.
  // In PAUSA scraper (ordine capo 11/7): le LIBERAZIONI (r1-r3) restano vive,
  // i PC calcolati dalla scala scraper (r4) sono sospesi.
  const scraperPaused = await require('./scraperPause').isScraperOptimizationPaused();
  try {
    const { rows: [opp] } = await pool.query(`
      WITH rete_rx AS (SELECT 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'::text rx),
      bloccati AS (
        SELECT DISTINCT b.tenant_id, b.sku FROM (
          SELECT fq.tenant_id, fq.sku FROM feed_quarantine fq WHERE fq.reactivated=false
          UNION ALL SELECT fk.tenant_id, fk.sku FROM feed_killers fk WHERE fk.is_active
          UNION ALL SELECT fa.tenant_id, fa.sku FROM feed_actions fa WHERE fa.action='REMOVE') b
        WHERE EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id
          WHERE oi.sku=b.sku AND o.order_date >= NOW()-INTERVAL '30 days' AND o.order_status NOT IN ('canceled','closed'))),
      scala AS (
        SELECT sc.product_code,
          (ARRAY_AGG(sc.base_price ORDER BY sc.base_price) FILTER (WHERE sc.merchant !~* (SELECT rx FROM rete_rx)))[3] terzo,
          (ARRAY_AGG(sc.base_price ORDER BY sc.base_price) FILTER (WHERE sc.merchant !~* (SELECT rx FROM rete_rx)))[4] quarto
        FROM scraper_competitors sc WHERE sc.scraped_at >= NOW()-INTERVAL '48 hours' AND sc.base_price > 0 GROUP BY 1),
      opp AS (
        SELECT bl.tenant_id tid, bl.sku,
          (is_salva_bilancio_product(bl.tenant_id, bl.sku) AND NOT is_muro_rule_product(bl.tenant_id, bl.sku)) sb,
          ROUND((CASE WHEN s.terzo - 0.01 >= flr.f THEN s.terzo - 0.01 ELSE s.quarto - 0.01 END)::numeric, 2) px
        FROM bloccati bl
        JOIN tenants t ON t.id=bl.tenant_id AND t.status='active'
        JOIN products p ON p.tenant_id=bl.tenant_id AND p.sku=bl.sku
        JOIN scala s ON s.product_code=bl.sku
        CROSS JOIN LATERAL (SELECT GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
          CASE WHEN COALESCE(p.erp_stock,0)>0 THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END)
          * (1 + COALESCE((SELECT hcf.config_value::numeric FROM health_config hcf WHERE hcf.tenant_id=t.id AND hcf.config_key='ricarico_floor_pct'), 15)/100) AS f) flr
        WHERE (COALESCE(p.erp_stock,0)+COALESCE(p.supplier_stock,0)) > 0 AND COALESCE(p.sell_price,0) > 0
          AND COALESCE(s.quarto, s.terzo) - 0.01 >= flr.f),
      r1 AS (UPDATE feed_quarantine fq SET reactivated=true, reactivated_at=NOW()
             FROM opp o WHERE fq.tenant_id=o.tid AND fq.sku=o.sku AND fq.reactivated=false RETURNING 1),
      r2 AS (UPDATE feed_killers fk SET is_active=false
             FROM opp o WHERE fk.tenant_id=o.tid AND fk.sku=o.sku AND fk.is_active RETURNING 1),
      r3 AS (DELETE FROM feed_actions fa USING opp o
             WHERE fa.tenant_id=o.tid AND fa.sku=o.sku AND fa.action='REMOVE' RETURNING 1),
      r4 AS (INSERT INTO feed_actions (tenant_id, sku, action, action_source, recommended_price, computed_at)
             SELECT tid, sku, 'PRICE_CUT', 'manual_pepita', px, NOW() FROM opp WHERE sb ${scraperPaused ? 'AND false /* PAUSA scraper */' : ''}
             ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
               action='PRICE_CUT', action_source='manual_pepita',
               recommended_price=EXCLUDED.recommended_price, computed_at=NOW()
             RETURNING 1)
      SELECT (SELECT COUNT(*) FROM opp) n,
             (SELECT COUNT(*) FROM r1)+(SELECT COUNT(*) FROM r2)+(SELECT COUNT(*) FROM r3) sbloccati,
             (SELECT COUNT(*) FROM r4) pc`);
    if (opp && parseInt(opp.n) > 0) R.opportunita = `${opp.n} idonei, ${opp.sbloccati} sbloccati, ${opp.pc} PC`;
  } catch (e) { console.error('[Hygiene] opportunità err:', e.message); }

  // 3c. CUT-BACK PREZZI SALITI (ordine capo 12/7: 'il ragionamento è giusto e
  // va applicato a tutta la rete'): venduti (>=2 ord/90g) il cui prezzo è
  // SALITO — visto dalla storia slice (>3% in 14g) O dalla firma da giugno
  // (margine% +2pt e click crollati) — riportati al 4° prezzo base -1c.
  // Gira SOLO con dump scraper PIENO fresco (>=50k MINSAN nelle ultime 8h):
  // senza scala affidabile non si prezza. Sempre e solo SB non-muro + floor.
  try {
    const { rows: [fresh] } = await pool.query(`
      SELECT COUNT(DISTINCT product_code) n FROM scraper_competitors
      WHERE scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '14 hours'`);
    if (parseInt(fresh.n) < 50000) {
      console.log(`[Hygiene] cut-back prezzi-saliti SKIP: dump non pieno (${fresh.n} MINSAN freschi)`);
    } else {
      const { rowCount: cb } = await pool.query(`
        WITH merchant_map AS (
          SELECT * FROM (VALUES
            ('SubitoFarma','subitofarma'), ('Farmacia San Vito','san vito'), ('MPF','personal farma'),
            ('Papa','farmacia papa'), ('Farmacia Procaccini','procaccini'), ('Farmacri','farmacri'),
            ('Farmainsieme','farmainsieme'), ('Farmacia Mandanici','mandanici'),
            ('Farmacia Ospedale','ospedale'), ('Farmastelia','farmastelia')) m(tenant_name, rx)),
        saliti_slice AS (
          SELECT mm.tenant_name, h.product_code
          FROM scraper_position_history h JOIN merchant_map mm ON h.merchant ~* mm.rx
          GROUP BY 1,2
          HAVING (ARRAY_AGG(h.base_price ORDER BY h.slice_ts DESC))[1] >
                 (ARRAY_AGG(h.base_price ORDER BY h.slice_ts ASC))[1] * 1.03),
        baseline AS (
          SELECT fdt.tenant_id, fdt.sku, AVG(fdt.margin_pct) mp_base, SUM(fdt.clicks) click_base
          FROM feed_daily_tracking fdt
          WHERE fdt.track_date BETWEEN (NOW() AT TIME ZONE 'Europe/Rome')::date - 28
                                   AND (NOW() AT TIME ZONE 'Europe/Rome')::date - 14
          GROUP BY 1,2 HAVING SUM(fdt.clicks) >= 5),
        ora7 AS (
          SELECT fdt.tenant_id, fdt.sku, SUM(fdt.clicks) click_ora
          FROM feed_daily_tracking fdt
          WHERE fdt.track_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 7 GROUP BY 1,2),
        saliti_firma AS (
          SELECT b.tenant_id, b.sku FROM baseline b
          JOIN products p ON p.tenant_id=b.tenant_id AND p.sku=b.sku
          LEFT JOIN ora7 o ON o.tenant_id=b.tenant_id AND o.sku=b.sku
          WHERE p.margin_pct >= b.mp_base + 2 AND COALESCE(o.click_ora,0) <= b.click_base * 0.35),
        candidati AS (
          SELECT t.id tenant_id, s.product_code sku FROM saliti_slice s JOIN tenants t ON t.name=s.tenant_name
          UNION SELECT sf.tenant_id, sf.sku FROM saliti_firma sf),
        venduti AS (
          SELECT o.tenant_id, oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id
          WHERE o.order_date >= NOW()-INTERVAL '90 days' AND o.order_status NOT IN ('canceled','closed','pending_payment')
          GROUP BY 1,2 HAVING COUNT(DISTINCT o.id) >= 2),
        scala AS (
          SELECT product_code, (ARRAY_AGG(base_price ORDER BY base_price))[4] quarto
          FROM scraper_competitors WHERE base_price > 0
            AND scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '30 hours'
          GROUP BY 1),
        muri2 AS (SELECT DISTINCT product_code FROM scraper_competitors
          WHERE scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '30 hours'
          -- PREZZO SECCO (capo 21/8): il muro e' 3+ venditori allo stesso prezzo
          -- PRODOTTO. Sul totale spedizioni diverse spezzavano muri veri.
          GROUP BY product_code, base_price HAVING COUNT(*) >= 3)
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source, current_price, recommended_price, computed_at, expires_at, status)
        SELECT c.tenant_id, c.sku, 'PRICE_CUT', 'cutback prezzi-saliti (igiene auto)', 'manual_pepita',
          p.sell_price, ROUND((sc.quarto-0.01)::numeric,2), NOW(), NOW()+INTERVAL '21 days', 'pending'
        FROM candidati c
        JOIN venduti v ON v.tenant_id=c.tenant_id AND v.sku=c.sku
        JOIN products p ON p.tenant_id=c.tenant_id AND p.sku=c.sku
        JOIN tenants t ON t.id=c.tenant_id
        JOIN scala sc ON sc.product_code=c.sku
        -- Tenant STATISTICI (capo 12/7: San Vito e Ospedale non sono operational):
        -- niente azioni prezzo, i loro PC non verrebbero mai applicati
        WHERE NOT EXISTS (SELECT 1 FROM health_config hcm
          WHERE hcm.tenant_id=c.tenant_id AND hcm.config_key='tenant_mode' AND hcm.config_value='statistical')
          AND NOT EXISTS (SELECT 1 FROM muri2 m WHERE m.product_code=c.sku)
          -- Perimetro VERO regola aurea (capo 12/7, mig. 052): SB sempre +
          -- Ricarico con vendite rete 30g; Sconto/Muro mai; mai rialzi
          AND is_price_cut_allowed(c.tenant_id, c.sku)
          AND p.sell_price > 0 AND (COALESCE(p.erp_stock,0)+COALESCE(p.supplier_stock,0)) > 0
          AND sc.quarto-0.01 < p.sell_price - 0.01
          AND sc.quarto-0.01 >= GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
            CASE WHEN COALESCE(p.erp_stock,0)>0 THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END)
            * (1 + COALESCE((SELECT hcf2.config_value::numeric FROM health_config hcf2 WHERE hcf2.tenant_id=t.id AND hcf2.config_key='ricarico_floor_pct'), 15)/100)
        ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO NOTHING`);
      if (cb > 0) R.cutback_saliti = cb + ' cut-back prezzi-saliti';
      console.log(`[Hygiene] cut-back prezzi-saliti: ${cb} nuovi`);
    }
  } catch (e) { console.error('[Hygiene] cut-back saliti err:', e.message); }

  // 4. Rebuild TUTTI i CSV (lo stato pulito arriva a FB → Magento prima di TP)
  try {
    const { recalculateStableCache } = require('../routes/externalApi');
    const { rows } = await pool.query("SELECT id FROM tenants WHERE status='active'");
    for (const t of rows) {
      try { await recalculateStableCache(t.id); } catch (e) { console.error('[Hygiene] rebuild err:', e.message); }
    }
    R.rebuild = rows.length;
  } catch (e) { console.error('[Hygiene] rebuild loop err:', e.message); }

  const secs = Math.round((Date.now() - t0) / 1000);
  const tot = (R.killer||0)+(R.quarantene||0)+(R.remove||0)+(R.oblio||0)+(R.prezzi_derivati||0);
  console.log(`[Hygiene] ciclo completo in ${secs}s:`, JSON.stringify(R));
  if (tot > 0) {
    try {
      await sendTelegram(
        `🧹 <b>IGIENE FEED (ciclo 4x)</b> — ${secs}s\n` +
        `Liberati: ${R.killer||0} killer, ${R.quarantene||0} quarantene, ${R.remove||0} REMOVE, ${R.oblio||0} oblio\n` +
        `Prezzi derivati neutralizzati: ${R.prezzi_derivati||0} | CSV rigenerati: ${R.rebuild||0}`,
        { key: 'hygiene', parseMode: 'HTML' });
    } catch {}
  }
  return R;
}

let cronStarted = false;

function startFeedHygieneCycle() {
  if (cronStarted) return;
  cronStarted = true;
  // 06:00, 11:00, 14:00, 18:00 Italia = 04:00, 09:00, 12:00, 16:00 UTC estivi
  const ORE_UTC = [4, 9, 12, 16];
  const schedule = () => {
    const now = new Date();
    let next = null;
    for (const h of ORE_UTC) {
      const c = new Date(now);
      c.setUTCHours(h, 0, 0, 0);
      if (c > now && (next === null || c < next)) next = c;
    }
    if (!next) {
      next = new Date(now);
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(ORE_UTC[0], 0, 0, 0);
    }
    setTimeout(() => {
      runFeedHygieneCycle().catch(e => console.error('[Hygiene] err:', e.message));
      schedule();
    }, next - now);
  };
  schedule();
  console.log('[Hygiene] Ciclo igiene feed attivo — 06:00, 11:00, 14:00, 18:00 Italia');
}

module.exports = { runFeedHygieneCycle, startFeedHygieneCycle };
