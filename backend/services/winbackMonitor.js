/**
 * Winback Monitor (direttiva utente 3/7/2026)
 *
 * "I prodotti rimossi dal CSV vanno monitorati: se iniziano a vendere su
 *  altri canali vanno abilitati e spinti. Ti potresti trovare prodotti
 *  venduti senza click evidenti nei file di Trovaprezzi."
 *
 * Cron giornaliero 05:45 UTC (prima del refresh TP 08:00 italia):
 * cerca SKU con is_civetta=false che hanno ORDINI STORE reali negli ultimi
 * 7 giorni (vendite organiche/altri canali, senza bisogno di click TP).
 * Se hanno stock, ricarico e un atterraggio TP vendibile:
 *   - landing <= 10 col prezzo attuale -> riattiva civetta (visibile subito)
 *   - landing > 10 ma PC possibile sopra floor di fascia -> riattiva + PC
 *   - altrimenti -> solo report (non si butta dentro chi non puo' competere)
 * Ogni riattivazione e' tracciata in activation_cohorts (winback_YYYYMMDD).
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

async function runWinback() {
  const cohortName = 'winback_' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // PAUSA scraper (ordine capo 11/7): i rilasci restano, i PC da target_prezzo
  // (calcolato dalla scala scraper) sono sospesi finché il capo non riattiva
  const scraperPaused = await require('./scraperPause').isScraperOptimizationPaused();

  // GUARDIA CARRELLO (dictat 9/7): refresh giornaliero delle stats che
  // alimentano i trigger trg_veto_basket_* (ordini 90g + margine carrello).
  try {
    await pool.query('SELECT refresh_sku_basket_stats()');
  } catch (e) {
    console.error('[Winback] refresh basket stats err:', e.message);
  }

  // RILASCIO SU VENDITE DI RETE (lezione Eucerin 8/7): killer = click senza
  // vendite OVUNQUE. Se lo SKU vende su QUALSIASI tenant, l'evidenza è
  // falsificata e il killer decade su TUTTI i tenant (prima si guardava solo
  // il tenant locale e le linee si smembravano in silenzio).
  try {
    // RILASCIO CON POSIZIONE (ordine capo 15/7): la vendita di rete libera
    // SOLO se su QUESTO tenant la posizione fresca è raggiungibile (<=
    // release_pos_max, default 10) o se vende localmente. Gli altri restano
    // a monitor: il test con PC lo fa la lima costante.
    const POS_GATE = `(
      vende_su_tenant_15g(x.tenant_id, x.sku)
      OR COALESCE(pos_fresca(x.tenant_id, x.sku), 999) <=
         COALESCE((SELECT hc.config_value::int FROM health_config hc
           WHERE hc.tenant_id = x.tenant_id AND hc.config_key = 'release_pos_max'), 10)
    )`;
    const { rowCount: kRel } = await pool.query(`
      UPDATE feed_killers fk SET is_active = false
      FROM (SELECT fk2.tenant_id, fk2.sku FROM feed_killers fk2 WHERE fk2.is_active) x
      WHERE fk.tenant_id = x.tenant_id AND fk.sku = x.sku AND fk.is_active
        AND EXISTS (
          SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.sku = fk.sku AND o.order_date >= NOW() - INTERVAL '15 days'
            AND o.order_status NOT IN ('canceled','closed','pending_payment')
        )
        AND ${POS_GATE}`);
    const { rowCount: qRel } = await pool.query(`
      UPDATE feed_quarantine fq SET reactivated = true, reactivated_at = NOW()
      FROM (SELECT fq2.tenant_id, fq2.sku FROM feed_quarantine fq2
            WHERE fq2.reactivated = false) x
      WHERE fq.tenant_id = x.tenant_id AND fq.sku = x.sku AND fq.reactivated = false
        -- Quarantene DELIBERATE (dieta costi 9/7): il rilascio-rete non le
        -- tocca — vendere su un altro tenant non ripaga i click locali
        AND COALESCE(fq.manual_override, false) = false
        AND EXISTS (
          SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.sku = fq.sku AND o.order_date >= NOW() - INTERVAL '15 days'
            AND o.order_status NOT IN ('canceled','closed','pending_payment')
        )
        AND ${POS_GATE}`);
    // BUCO CHIUSO (censimento capo 13/7): anche i REMOVE decadono su vendite
    // di rete — ma dal 15/7 SOLO col cancello di posizione.
    const { rowCount: rRel } = await pool.query(`
      DELETE FROM feed_actions fa
      USING (SELECT fa2.tenant_id, fa2.sku FROM feed_actions fa2 WHERE fa2.action='REMOVE') x
      WHERE fa.tenant_id = x.tenant_id AND fa.sku = x.sku AND fa.action = 'REMOVE'
        AND EXISTS (
          SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.sku = fa.sku AND o.order_date >= NOW() - INTERVAL '15 days'
            AND o.order_status NOT IN ('canceled','closed','pending_payment')
        )
        AND ${POS_GATE}`);
    if (kRel + qRel + rRel > 0) console.log(`[Winback] rilascio rete: ${kRel} killer + ${qRel} quarantene + ${rRel} REMOVE decaduti (lo SKU vende in rete)`);
  } catch (e) {
    console.error('[Winback] rilascio rete err:', e.message);
  }

  // AMNISTIA CARRELLO GIORNALIERA (dictat 9/7): qualsiasi blocco residuo su
  // SKU protetti dal carrello decade ogni mattina. Auto-guarigione per ciò
  // che sfugge ai trigger (stats stantie di 24h, fonti nuove, condanne
  // precedenti al primo ordine). Le quarantene cost_diet restano fuori: i
  // loro rientri passano dal flusso candidati winback (landing gate).
  try {
    const { rowCount: aRem } = await pool.query(`
      DELETE FROM feed_actions fa
      WHERE fa.action = 'REMOVE' AND is_feed_protected(fa.tenant_id, fa.sku)`);
    const { rowCount: aKil } = await pool.query(`
      UPDATE feed_killers fk SET is_active = false
      WHERE fk.is_active AND is_feed_protected(fk.tenant_id, fk.sku)`);
    const { rowCount: aQua } = await pool.query(`
      UPDATE feed_quarantine fq SET reactivated = true, reactivated_at = NOW()
      WHERE fq.reactivated = false AND fq.reason NOT LIKE 'cost_diet%'
        AND is_feed_protected(fq.tenant_id, fq.sku)`);
    if (aRem + aKil + aQua > 0) {
      console.log(`[Winback] amnistia carrello: ${aRem} REMOVE + ${aKil} killer + ${aQua} quarantene rilasciati (SKU con ordini)`);
    }
  } catch (e) {
    console.error('[Winback] amnistia carrello err:', e.message);
  }

  // Candidati: fuori dal CSV ma vendono in store (canali non-TP)
  const { rows: candidates } = await pool.query(`
    WITH vendite_30d AS (
      -- Finestra 30g: i rotatori lenti (2-4 ord/mese) sfuggivano al 7g-only.
      -- Fast-track: basta 1 ordine negli ultimi 7g.
      SELECT o.tenant_id, oi.sku,
        COUNT(DISTINCT o.id) AS ord_30d,
        COUNT(DISTINCT o.id) FILTER (WHERE o.order_date >= NOW() - INTERVAL '7 days') AS ord_7d
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_date >= NOW() - INTERVAL '15 days'
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY o.tenant_id, oi.sku
      HAVING COUNT(DISTINCT o.id) >= 2
          OR COUNT(DISTINCT o.id) FILTER (WHERE o.order_date >= NOW() - INTERVAL '7 days') >= 1
    ),
    tenant_pos AS (
      SELECT tenant_id, MAX((rule_data->>'scraper_position')::int) AS max_pos
      FROM price_rules
      WHERE (rule_data->>'scraper_position')::int > 0
      GROUP BY tenant_id
    )
    SELECT t.name AS tenant_name, p.tenant_id, p.sku, p.product_name,
      fk.id AS killer_id, fq.id AS quarantine_id,
      ROUND(p.sell_price::numeric, 2) AS sell_price,
      ROUND(p.erp_cost::numeric, 2) AS erp_cost,
      ROUND(((p.sell_price - p.erp_cost) / p.erp_cost * 100)::numeric, 2) AS ricarico,
      p.erp_stock, v.ord_30d, v.ord_7d,
      COALESCE(fo.floor_pct, 15) AS floor_grossista,
      -- La regola prezzo dichiara il regime: Grossista o Diretto (nel nome).
      -- Fallback se non parla: erp_stock=0 => grossista
      COALESCE((SELECT pr4.rule_name ~* 'grossist' FROM price_rules pr4
                WHERE pr4.tenant_id = p.tenant_id AND pr4.rule_id = p.price_rule_id),
               p.erp_stock = 0) AS regime_grossista,
      -- Posizione target dalla regola prezzo del prodotto (fallback: max tenant),
      -- con floor per-tenant strict_pos_target_min (hack SubitoFarma 4/7: 5/6 -> 9)
      GREATEST(COALESCE(
        NULLIF((SELECT (pr2.rule_data->>'scraper_position')::int FROM price_rules pr2
                WHERE pr2.tenant_id = p.tenant_id AND pr2.rule_id = p.price_rule_id), 0),
        tp.max_pos, 10),
        COALESCE(hcp.config_value::int, 0)) AS pos_target,
      -- PREZZO SECCO (capo 21/8): p.sell_price e' secco, quindi landing e prezzo
      -- target si leggono su base_price. Col totale il landing risultava sempre
      -- ottimo (nessuno "sotto di noi") e il winback non partiva mai.
      (SELECT COUNT(*) + 1 FROM scraper_competitors sc
        WHERE sc.product_code = p.sku AND sc.base_price > 0
          AND sc.scraped_at >= NOW() - INTERVAL '48 hours'  -- guardrail freschezza (retention 7g)
          AND sc.base_price < p.sell_price) AS landing,
      (SELECT sc.base_price FROM scraper_competitors sc
        WHERE sc.product_code = p.sku AND sc.base_price > 0
          AND sc.scraped_at >= NOW() - INTERVAL '48 hours'  -- guardrail freschezza (retention 7g)
        ORDER BY sc.base_price ASC
        OFFSET GREATEST(COALESCE(
          NULLIF((SELECT (pr3.rule_data->>'scraper_position')::int FROM price_rules pr3
                  WHERE pr3.tenant_id = p.tenant_id AND pr3.rule_id = p.price_rule_id), 0),
          tp.max_pos, 10), COALESCE(hcp.config_value::int, 0)) - 1
        LIMIT 1) AS target_prezzo
    FROM vendite_30d v
    JOIN products p ON p.tenant_id = v.tenant_id AND p.sku = v.sku
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN tenant_pos tp ON tp.tenant_id = p.tenant_id
    -- Floor ricarico grossista per-tenant (es. SubitoFarma 11%, default 15%)
    LEFT JOIN health_config hcf ON hcf.tenant_id = p.tenant_id
      AND hcf.config_key = 'ricarico_floor_grossista'
    -- Floor valutazione posizione per-tenant (hack SubitoFarma: 5/6 -> 9)
    LEFT JOIN health_config hcp ON hcp.tenant_id = p.tenant_id
      AND hcp.config_key = 'strict_pos_target_min'
    -- Cap 11.5 per grossisti altorotanti in classifiche con seller in pareggio (6/7)
    LEFT JOIN floor_overrides fo ON fo.tenant_id = p.tenant_id AND fo.sku = p.sku
    LEFT JOIN feed_killers fk ON fk.sku = p.sku AND fk.tenant_id = p.tenant_id AND fk.is_active = true
    LEFT JOIN feed_quarantine fq ON fq.sku = p.sku AND fq.tenant_id = p.tenant_id AND fq.reactivated = false
    WHERE t.status = 'active'
      AND (p.is_civetta = false OR p.is_civetta IS NULL)
      AND p.saleable = true
      AND (p.erp_stock >= 2 OR COALESCE(p.supplier_stock, 0) >= 5)
      AND p.sell_price >= 5 AND p.erp_cost > 0
      AND (p.sell_price - p.erp_cost) / p.erp_cost * 100 >=
          CASE WHEN p.erp_stock = 0
                 AND COALESCE((SELECT pr5.rule_name ~* 'grossist' FROM price_rules pr5
                               WHERE pr5.tenant_id = p.tenant_id AND pr5.rule_id = p.price_rule_id), true)
               THEN COALESCE(fo.floor_pct, 15) ELSE 15 END
      -- Killer/quarantena NON escludono: ordini store reali falsificano il kill
      -- (killer = click SENZA vendite; se vende, la premessa è caduta) → release
      AND NOT EXISTS (SELECT 1 FROM cross_tenant_oblio ob WHERE ob.sku = p.sku AND ob.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM price_rules pr
        WHERE pr.rule_id = p.price_rule_id AND pr.tenant_id = p.tenant_id AND pr.rule_type = 'sconto')
    ORDER BY v.ord_30d DESC
    LIMIT 300
  `);

  let direct = 0, withPc = 0, skipped = 0, killersReleased = 0, quarReleased = 0;
  const activated = [];

  // Ordini reali falsificano killer/quarantena: release al momento della
  // riattivazione (solo se lo SKU viene effettivamente riattivato)
  const releaseLocks = async (c) => {
    if (c.killer_id) {
      await pool.query(`UPDATE feed_killers SET is_active = false WHERE id = $1`, [c.killer_id]);
      killersReleased++;
    }
    if (c.quarantine_id) {
      await pool.query(
        `UPDATE feed_quarantine SET reactivated = true, reactivated_at = NOW() WHERE id = $1`,
        [c.quarantine_id]);
      quarReleased++;
    }
    if (c.killer_id || c.quarantine_id) {
      await pool.query(
        `DELETE FROM feed_actions WHERE tenant_id = $1 AND sku = $2 AND action = 'REMOVE'`,
        [c.tenant_id, c.sku]);
    }
  };

  for (const c of candidates) {
    const landing = parseInt(c.landing);
    const posTarget = parseInt(c.pos_target) || 10;
    // Floor basso SOLO per fornitura esterna pura (erp_stock=0) sotto regola
    // grossista (direttiva 7/7: mai sotto 15% su prodotti da magazzino ERP)
    const floorPct = (c.regime_grossista && parseInt(c.erp_stock) === 0)
      ? parseFloat(c.floor_grossista)
      : (parseFloat(c.sell_price) < 10 ? 18 : 15);
    const floorMul = 1 + floorPct / 100;
    const floorPrice = parseFloat(c.erp_cost) * floorMul;

    if (landing <= posTarget) {
      // Vendibile col prezzo attuale: dentro subito
      await releaseLocks(c);
      // In pausa scraper NON forziamo il flag: il civetta resta quello VERO
      // di FB (regola backup: se FB dice 0, non si attiva) — la coorte basta
      if (!scraperPaused) await pool.query(
        `UPDATE products SET is_civetta = true, updated_at = NOW()
         WHERE tenant_id = $1 AND sku = $2`, [c.tenant_id, c.sku]);
      await pool.query(`
        INSERT INTO activation_cohorts (cohort_name, tenant_id, sku, sell_price, ricarico_pct, scraper_position, erp_stock, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [cohortName, c.tenant_id, c.sku, c.sell_price, c.ricarico, landing, c.erp_stock,
         `winback: ${c.ord_30d} ord/30g altri canali, landing ${landing}`]);
      direct++;
      activated.push(`${c.tenant_name} ${c.sku} (${c.ord_30d} ord, landing ${landing})`);
    } else if (!scraperPaused && c.target_prezzo && (parseFloat(c.target_prezzo) - 0.01) >= floorPrice
               && (parseFloat(c.target_prezzo) - 0.01) < parseFloat(c.sell_price) - 0.05) {
      // Serve un PC per entrare nel target di regola e il floor regge
      const newPrice = Math.round((parseFloat(c.target_prezzo) - 0.01) * 100) / 100;
      await releaseLocks(c);
      await pool.query(
        `UPDATE products SET is_civetta = true, updated_at = NOW()
         WHERE tenant_id = $1 AND sku = $2`, [c.tenant_id, c.sku]);
      await pool.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
          current_price, recommended_price, price_cut_pct, erp_cost, new_margin, new_margin_pct,
          status, expires_at, computed_at)
        VALUES ($1, $2, 'PRICE_CUT', $3, 'manual_pepita', $4::numeric, $5::numeric,
          ROUND((($4::numeric - $5::numeric) / $4::numeric * 100), 2), $6::numeric,
          ROUND(($5::numeric - $6::numeric), 2), ROUND((($5::numeric - $6::numeric) / $5::numeric * 100), 2),
          'pending', NOW() + INTERVAL '21 days', NOW())
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          action = 'PRICE_CUT', action_source = 'manual_pepita',
          action_reason = EXCLUDED.action_reason, recommended_price = EXCLUDED.recommended_price,
          current_price = EXCLUDED.current_price, status = 'pending',
          expires_at = EXCLUDED.expires_at, computed_at = NOW()`,
        [c.tenant_id, c.sku,
         `Winback+PC: ${c.ord_30d} ord/30g altri canali, da pos ~${landing} a top${posTarget} con €${newPrice}`,
         c.sell_price, newPrice, c.erp_cost]);
      await pool.query(`
        INSERT INTO activation_cohorts (cohort_name, tenant_id, sku, sell_price, ricarico_pct, scraper_position, erp_stock, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [cohortName, c.tenant_id, c.sku, c.sell_price, c.ricarico, landing, c.erp_stock,
         `winback+PC a €${newPrice}: ${c.ord_30d} ord/30g, landing pre ${landing}`]);
      withPc++;
      activated.push(`${c.tenant_name} ${c.sku} (${c.ord_30d} ord, PC €${newPrice})`);
    } else {
      skipped++;
    }
  }

  if (direct + withPc > 0) {
    let msg = `🔄 <b>Winback Monitor</b>\n`;
    msg += `${direct + withPc} SKU riattivati (vendono su altri canali):\n`;
    msg += `• ${direct} già competitivi (landing top10)\n`;
    msg += `• ${withPc} con PC per rientrare in top10\n`;
    msg += `• ${skipped} scartati (non competitivi senza sfondare floor)\n`;
    if (killersReleased + quarReleased > 0) {
      msg += `• 🔓 ${killersReleased} killer + ${quarReleased} quarantene rilasciati (vendono → premessa kill caduta)\n`;
    }
    msg += `\n`;
    for (const a of activated.slice(0, 10)) msg += `  ${a}\n`;
    if (activated.length > 10) msg += `  … +${activated.length - 10} altri\n`;
    try { await sendTelegram(msg, { key: 'winback_monitor', parseMode: 'HTML', throttleMs: 20 * 3600 * 1000 }); } catch {}
  }
  console.log(`[WinbackMonitor] direct=${direct} withPc=${withPc} skipped=${skipped} killersReleased=${killersReleased} quarReleased=${quarReleased}`);
  return { direct, withPc, skipped, killersReleased, quarReleased, cohortName };
}

let cronStarted = false;

function startWinbackMonitor() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 45, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try { await runWinback(); } catch (e) { console.error('[WinbackMonitor] err:', e.message); }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[WinbackMonitor] Cron started — giornaliero 05:45 UTC (07:45 italia)');
}

module.exports = { runWinback, startWinbackMonitor };
