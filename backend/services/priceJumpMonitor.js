/**
 * Price Jump Monitor (direttiva utente 6/7/2026 — "cosa tragica, loop 1x/giorno")
 *
 * Scoperta del 26/6: i competitor si muovono in massa -> le regole prezzo
 * (ancorate alla classifica) ricalcolano VERSO L'ALTO -> i nostri prezzi
 * salgono -> posizioni crollano -> ordini -17/34%.
 *
 * Ogni giorno 10:15 italia, per ogni tenant: venditori (>=4 ord) il cui
 * prezzo venduto recente (7gg) supera del 3%+ il venduto precedente (8-21gg fa).
 *  - Tenant con pipe prezzi: PC automatico di ripristino al prezzo precedente
 *    (floor-bounded per regime) — riconquista posizione
 *  - Tenant solo-statistiche (San Vito, Ospedale): lista in Telegram per il cliente
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const PIPE_ATTIVA = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF', 'Farmainsieme', 'Farmacri', 'Farmacia Mandanici','Farmastelia'];

async function runPriceJumpMonitor() {
  {
    const { isScraperOptimizationPaused } = require('./scraperPause');
    if (await isScraperOptimizationPaused()) {
      console.log('[PriceJump] PAUSA scraper-optimization (ordine capo 11/7) — skip governor/harvest/autofix');
      return;
    }
  }
  // Due firme (lezione 6/7: il solo confronto venduto/venduto è cieco sui
  // prodotti UCCISI dal rincaro — niente vendite recenti = invisibili):
  //  A) sopravvissuti: venduto recente > venduto pre +3%
  //  B) ammutoliti/dimezzati: ordini recenti < 40% dei pre E prezzo ATTUALE
  //     (applied/exported/sell) > venduto pre +3%
  // 🧾 IVA (ordine capo 21/08): tutti i prezzi e i costi si ragionano LORDI.
  // `order_items.price` e `row_total` sono IVA ESCLUSA, mentre applied/exported/
  // sell_price ed erp_cost sono IVA INCLUSA. Confrontarli faceva leggere un
  // +22,0% da fermo — era solo l'aliquota. Due danni: il filtro d'ingresso a
  // +3% lo sfondava ogni prodotto, e il ripristino (max fra floor e prezzo_pre)
  // scriveva un prezzo netto come prezzo di vendita, regalando il 22%.
  // 32 casi su 408, 4 finiti a scaffale. Ora la finestra storica esce lorda.
  const { rows: jumps } = await pool.query(`
    WITH pre AS (
      SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord_pre, AVG(COALESCE(NULLIF(oi.row_total_incl_tax,0), oi.row_total) / NULLIF(oi.qty_ordered, 0)) AS prezzo_pre
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date
          BETWEEN (NOW() AT TIME ZONE 'Europe/Rome')::date - 21 AND (NOW() AT TIME ZONE 'Europe/Rome')::date - 8
        AND COALESCE(NULLIF(oi.row_total_incl_tax,0), oi.row_total) > 0 AND oi.qty_ordered > 0
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY 1, 2 HAVING COUNT(DISTINCT o.id) >= 3
    ),
    recenti AS (
      SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord_rec, AVG(COALESCE(NULLIF(oi.row_total_incl_tax,0), oi.row_total) / NULLIF(oi.qty_ordered, 0)) AS prezzo_rec
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 7
        AND COALESCE(NULLIF(oi.row_total_incl_tax,0), oi.row_total) > 0 AND oi.qty_ordered > 0
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY 1, 2
    )
    SELECT t.name AS tname, pre.tenant_id, pre.sku,
      pre.ord_pre AS ord_tot, COALESCE(r.ord_rec, 0) AS ord_rec,
      ROUND(pre.prezzo_pre::numeric, 2) AS prezzo_pre,
      ROUND(COALESCE(r.prezzo_rec, NULLIF(prezzo_vero_row(p.tenant_id, p.sku, p.applied_price, p.exported_price, p.sell_price), 0))::numeric, 2) AS prezzo_recent,
      ROUND(((COALESCE(r.prezzo_rec, NULLIF(prezzo_vero_row(p.tenant_id, p.sku, p.applied_price, p.exported_price, p.sell_price), 0)) / pre.prezzo_pre - 1) * 100)::numeric, 1) AS salto_pct,
      CASE WHEN COALESCE(r.ord_rec, 0) = 0 THEN 'AMMUTOLITO'
           WHEN COALESCE(r.ord_rec, 0) < pre.ord_pre * 0.4 * (7.0/14) THEN 'DIMEZZATO'
           ELSE 'sopravvissuto' END AS firma,
      p.sell_price, p.erp_cost, p.erp_stock, p.supplier_min_cost, p.supplier_stock,
      ROUND(phs.scraper_position) AS pos_now,
      -- floor basso SOLO fornitura esterna pura: erp_stock=0 obbligatorio
      (p.erp_stock = 0 AND COALESCE((SELECT pr.rule_name ~* 'grossist' FROM price_rules pr
                WHERE pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id), true)) AS gross,
      -- floor sotto-15 SOLO via floor_overrides (altorotante 30g + supplier puro)
      COALESCE((SELECT fo.floor_pct FROM floor_overrides fo
                WHERE fo.tenant_id = p.tenant_id AND fo.sku = p.sku), 15) AS floor_gr
    FROM pre
    JOIN tenants t ON t.id = pre.tenant_id AND t.status = 'active'
    JOIN products p ON p.tenant_id = pre.tenant_id AND p.sku = pre.sku
    LEFT JOIN recenti r ON r.tenant_id = pre.tenant_id AND r.sku = pre.sku
    LEFT JOIN product_health_scores phs ON phs.tenant_id = pre.tenant_id AND phs.sku = pre.sku
    WHERE p.erp_cost > 0 AND p.saleable = true
      AND (p.erp_stock + COALESCE(p.supplier_stock, 0)) > 0
      AND (
        (r.prezzo_rec IS NOT NULL AND r.prezzo_rec > pre.prezzo_pre * 1.03)
        OR (COALESCE(r.ord_rec, 0) < pre.ord_pre * 0.4 * (7.0/14)
            AND NULLIF(prezzo_vero_row(p.tenant_id, p.sku, p.applied_price, p.exported_price, p.sell_price), 0) > pre.prezzo_pre * 1.03)
      )
      AND NOT EXISTS (SELECT 1 FROM feed_killers fk WHERE fk.tenant_id = p.tenant_id AND fk.sku = p.sku AND fk.is_active)
      AND NOT EXISTS (SELECT 1 FROM feed_actions fa WHERE fa.tenant_id = p.tenant_id AND fa.sku = p.sku
                      AND fa.recommended_price IS NOT NULL AND fa.recommended_price <= pre.prezzo_pre * 1.01)
    ORDER BY t.name, salto_pct DESC`);

  let fixed = 0;
  const perTenant = {};
  for (const j of jumps) {
    perTenant[j.tname] = perTenant[j.tname] || { fix: 0, report: [] };
    const floorPct = j.gross ? parseFloat(j.floor_gr) : (parseFloat(j.sell_price) < 10 ? 18 : 15);
    const floorPrice = Math.round(parseFloat(j.erp_cost) * (1 + floorPct / 100) * 100) / 100;
    const newPrice = Math.max(floorPrice, parseFloat(j.prezzo_pre));
    const anchor = Math.max(parseFloat(j.sell_price), parseFloat(j.prezzo_recent));

    // 🩸 COSTO PONDERATO (5/8, corretto in giornata dopo il rilievo del capo).
    // erp_cost NON e' un dato sballato: e' l'acquisto vero dei pezzi a scaffale
    // (erp_purchase_cost identico su 802 SKU su 802 in rete). Il difetto e' che
    // il floor lo applicava a TUTTI i pezzi, anche alle centinaia del grossista
    // che costano molto di piu'. Su LACTOFLORENE REPAIR IBS (4 pezzi a 0,37,
    // 296 a 5,95) chiedeva tagli a 5,54: 158 PRICE_CUT in 10 giorni, mai
    // applicati, che intanto lo tenevano in feed (il ramo PRICE_CUT della build
    // lo esenta pure dal filtro strict).
    // Il costo giusto e' la media pesata sulle giacenze: chi ha lo scaffale
    // profondo comprato bene deve poterlo vendere (regola "spingi magazzino"),
    // chi ha 4 pezzi su 300 no. Sotto quel costo non si taglia: e' materia da
    // feed, non da price cut. Nessun rialzo, si salta e basta.
    const stkErp = parseFloat(j.erp_stock) || 0;
    const stkGr = parseFloat(j.supplier_stock) || 0;
    const cErp = parseFloat(j.erp_cost) || 0;
    const cGr = parseFloat(j.supplier_min_cost) || cErp;
    const costoPesato = (stkErp + stkGr) > 0
      ? (stkErp * cErp + stkGr * cGr) / (stkErp + stkGr)
      : Math.max(cErp, cGr);
    if (newPrice < costoPesato) {
      perTenant[j.tname].report.push(
        `${j.sku} SOTTO COSTO PONDERATO: ripristino €${newPrice} < costo €${costoPesato.toFixed(2)} ` +
        `(scaffale ${stkErp}@${cErp.toFixed(2)}, grossista ${stkGr}@${cGr.toFixed(2)}) — saltato`);
      continue;
    }

    if (PIPE_ATTIVA.includes(j.tname) && newPrice < anchor - 0.05) {
      // ARBITRO (14/7): l'auto-fix si firma — era il grosso degli "anonimi"
      const cfix = await pool.connect();
      try {
        await cfix.query('BEGIN');
        await cfix.query(`SELECT set_config('xhp.writer', 'pricejump_autofix', true),
          set_config('xhp.motivo', 'ripristino prezzo venduto dopo salto regola', true)`);
        await cfix.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
          current_price, recommended_price, price_cut_pct, erp_cost, new_margin, new_margin_pct,
          status, expires_at, computed_at)
        VALUES ($1, $2, 'PRICE_CUT', $3, 'manual_review', $4::numeric, $5::numeric,
          ROUND((($4::numeric - $5::numeric) / $4::numeric * 100), 2), $6::numeric,
          ROUND(($5::numeric - $6::numeric), 2), ROUND((($5::numeric - $6::numeric) / $5::numeric * 100), 2),
          'pending', NOW() + INTERVAL '7 days', NOW())
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          action = 'PRICE_CUT', action_source = 'manual_review',
          action_reason = EXCLUDED.action_reason, recommended_price = EXCLUDED.recommended_price,
          current_price = EXCLUDED.current_price, status = 'pending',
          expires_at = EXCLUDED.expires_at, computed_at = NOW()`,
        [j.tenant_id, j.sku,
         `PRICE-JUMP auto-fix: venduto €${j.prezzo_pre} -> €${j.prezzo_recent} (+${j.salto_pct}%, pos ${j.pos_now || '?'}), ripristino €${newPrice}`,
         anchor, newPrice, j.erp_cost]);
        await cfix.query('COMMIT');
      } catch (e) {
        await cfix.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { cfix.release(); }
      perTenant[j.tname].fix++;
      fixed++;
    } else {
      perTenant[j.tname].report.push(`${j.sku} +${j.salto_pct}% (€${j.prezzo_pre}→€${j.prezzo_recent}, pos ${j.pos_now || '?'}, ${j.ord_tot} ord)`);
    }
  }

  // GOVERNOR (direttiva 7/7): nessun PC più basso del necessario — chi sta
  // sotto (primo competitor - 1 cent) viene RIALZATO esattamente a primo-1c.
  // Stessa posizione, margine pieno. Gira a ogni ciclo su ladder fresca.
  let governed = 0;
  const govClient = await pool.connect();
  try {
    // ARBITRO (13/7): il governor si FIRMA e NON tocca le righe manuali/di
    // sessione — quelle onde hanno target propri (scala base fresca), il
    // rimaneggiamento incrociato era churn puro (1.100 tocchi anonimi/giro).
    await govClient.query('BEGIN');
    await govClient.query(`SELECT set_config('xhp.writer', 'governor_pricejump', true),
      set_config('xhp.motivo', 'mai piu basso del necessario: riallineo a best base esterno -1c', true)`);
    const { rowCount } = await govClient.query(`
      WITH pc AS (
        SELECT fa.tenant_id, fa.sku, fa.recommended_price, fa.current_price,
          -- BASE PRICE, non total: TP classifica per prezzo base (fix 13/7 —
          -- col total il governor rialzava i PC sopra il muro base e perdevamo
          -- la posizione comprata). Esclusi i merchant della NOSTRA rete.
          (SELECT MIN(sc.base_price) FROM scraper_competitors sc
           WHERE sc.product_code = fa.sku AND sc.base_price > 0
             AND sc.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'
             -- guardrail freschezza (retention 7g dal 11/7): prezzi solo da scrape recente
             AND sc.scraped_at >= NOW() - INTERVAL '48 hours') AS best_comp
        FROM feed_actions fa
        JOIN tenants t ON t.id = fa.tenant_id
          AND t.name IN ('SubitoFarma','Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmacri','Farmacia Mandanici','Farmastelia')
        WHERE fa.recommended_price IS NOT NULL
          AND COALESCE(fa.action_source, '') NOT IN ('manual_pepita', 'manual', 'capo_pin', 'muro_scavalco')
          -- Brand protetti (strategia prezzi del cliente): MAI toccati dal governor
          AND NOT EXISTS (SELECT 1 FROM products p2 JOIN health_config hc
              ON hc.tenant_id = p2.tenant_id AND hc.config_key = 'killer_protected_brands'
            WHERE p2.tenant_id = fa.tenant_id AND p2.sku = fa.sku
              AND UPPER(COALESCE(p2.brand, '')) = ANY(STRING_TO_ARRAY(UPPER(hc.config_value), ',')))
      ),
      adj AS (
        SELECT tenant_id, sku,
          LEAST(ROUND((best_comp - 0.01)::numeric, 2), current_price - 0.05) AS new_rec
        FROM pc
        WHERE best_comp IS NOT NULL
          AND recommended_price < best_comp - 0.03
          AND LEAST(ROUND((best_comp - 0.01)::numeric, 2), current_price - 0.05) > recommended_price + 0.02
      )
      UPDATE feed_actions fa
      SET recommended_price = a.new_rec,
          new_margin = ROUND((a.new_rec - fa.erp_cost)::numeric, 2),
          new_margin_pct = ROUND(((a.new_rec - fa.erp_cost) / a.new_rec * 100)::numeric, 2),
          computed_at = NOW()
      FROM adj a
      WHERE fa.tenant_id = a.tenant_id AND fa.sku = a.sku`);
    await govClient.query('COMMIT');
    governed = rowCount;
    if (governed > 0) console.log(`[PriceJump] governor: ${governed} PC rialzati a 1c dal primo`);
  } catch (e) {
    await govClient.query('ROLLBACK').catch(() => {});
    console.error('[PriceJump] governor err:', e.message);
  } finally { govClient.release(); }

  // MARGIN HARVEST — ⛔ SOSPESO dalla REGOLA AUREA PREZZI 10/7 (veto TOTALE
  // rialzi). Il 13-14/7 la revoca della pausa scraper lo ha riacceso per
  // errore (stesso flag) → 112 rialzi/giro, stallo MPF. Ora: gate dedicato
  // (global_config margin_harvest_enabled='1' SOLO su ordine del capo) +
  // veto DB trg_veto_harvest_sospeso (mig 059) come cintura di sicurezza.
  let harvested = 0;
  try {
    const { rows: [hg] } = await pool.query(
      `SELECT config_value FROM global_config WHERE config_key='margin_harvest_enabled'`);
    if (!hg || hg.config_value !== '1') {
      throw Object.assign(new Error('harvest sospeso (regola aurea 10/7)'), { harvestOff: true });
    }
    const { rowCount } = await pool.query(`
      WITH alto AS (
        SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.order_date >= NOW() - INTERVAL '15 days'
          AND o.order_status NOT IN ('canceled','closed','pending_payment')
        GROUP BY 1, 2 HAVING COUNT(DISTINCT o.id) >= 3
      ),
      cand AS (
        SELECT a.tenant_id, a.sku, a.ord, p.sell_price, p.erp_cost,
          NULLIF(prezzo_vero_row(p.tenant_id, p.sku, p.applied_price, p.exported_price, p.sell_price), 0) AS prezzo_eff,
          -- PREZZO SECCO (capo 21/8): prezzo_eff e sell_price sono SECCHI. Con
          -- MIN(total_price) confrontavamo mele con pere e alzavamo di ~2,83 EUR
          -- di media sopra il vero best esterno.
          (SELECT MIN(sc.base_price) FROM scraper_competitors sc
           WHERE sc.product_code = a.sku AND sc.base_price > 0
             -- guardrail freschezza (retention 7g dal 11/7): prezzi solo da scrape recente
             AND sc.scraped_at >= NOW() - INTERVAL '48 hours'
             AND sc.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia') AS best_esterno
        FROM alto a
        JOIN tenants t ON t.id = a.tenant_id
          AND t.name IN ('SubitoFarma','Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmacri','Farmacia Mandanici','Farmastelia')
        JOIN products p ON p.tenant_id = a.tenant_id AND p.sku = a.sku
        WHERE p.erp_cost > 0 AND p.saleable = true
          AND (p.erp_stock + COALESCE(p.supplier_stock, 0)) > 0
          AND NOT EXISTS (SELECT 1 FROM feed_killers fk WHERE fk.tenant_id = a.tenant_id AND fk.sku = a.sku AND fk.is_active)
          -- Brand protetti: prezzi del cliente, l'harvest NON li tocca
          AND NOT EXISTS (SELECT 1 FROM health_config hc
            WHERE hc.tenant_id = a.tenant_id AND hc.config_key = 'killer_protected_brands'
              AND UPPER(COALESCE(p.brand, '')) = ANY(STRING_TO_ARRAY(UPPER(hc.config_value), ',')))
      ),
      raise_cand AS (
        SELECT tenant_id, sku, ord, prezzo_eff, erp_cost,
          LEAST(ROUND((best_esterno - 0.01)::numeric, 2), sell_price) AS new_price
        FROM cand
        WHERE best_esterno IS NOT NULL
          AND LEAST(ROUND((best_esterno - 0.01)::numeric, 2), sell_price) > prezzo_eff + 0.05
          -- solo rialzi PICCOLI (<=10%): i salti grossi li calibra l'AI
          -- pesando vicino-sotto/vicino-sopra (aiMarginCalibrator)
          AND LEAST(ROUND((best_esterno - 0.01)::numeric, 2), sell_price) <= prezzo_eff * 1.10
      )
      INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
        current_price, recommended_price, price_cut_pct, erp_cost, new_margin, new_margin_pct,
        status, expires_at, computed_at)
      SELECT tenant_id, sku, 'PRICE_CUT',
        'MARGIN HARVEST: competitor esterni saliti — su da €' || prezzo_eff || ' a €' || new_price || ' (1c sotto il best esterno, ' || ord || ' ord/30g)',
        'margin_harvest_pilot', prezzo_eff, new_price,
        ROUND(((prezzo_eff - new_price) / prezzo_eff * 100)::numeric, 2), erp_cost,
        ROUND((new_price - erp_cost)::numeric, 2), ROUND(((new_price - erp_cost) / new_price * 100)::numeric, 2),
        'pending', NOW() + INTERVAL '14 days', NOW()
      FROM raise_cand
      ON CONFLICT (tenant_id, sku) DO UPDATE SET
        recommended_price = EXCLUDED.recommended_price,
        action_reason = EXCLUDED.action_reason,
        current_price = EXCLUDED.current_price,
        new_margin = EXCLUDED.new_margin, new_margin_pct = EXCLUDED.new_margin_pct,
        status = 'pending', expires_at = EXCLUDED.expires_at, computed_at = NOW()
      WHERE feed_actions.recommended_price IS NULL
         OR EXCLUDED.recommended_price > feed_actions.recommended_price`);
    harvested = rowCount;
    if (harvested > 0) console.log(`[PriceJump] margin harvest: ${harvested} rialzi a 1c dal best esterno`);
  } catch (e) {
    if (e.harvestOff) console.log('[PriceJump] harvest SOSPESO (regola aurea 10/7) — skip');
    else console.error('[PriceJump] harvest err:', e.message);
  }

  if (jumps.length > 0) {
    // Le righe di report contengono '<' (es. "ripristino €X < costo €Y"):
    // in parseMode HTML Telegram lo legge come tag aperto e rifiuta TUTTO il
    // messaggio ("can't parse entities: Unsupported start tag"). Dal 13/8 gli
    // alert non arrivavano più. Si scappa tutto ciò che è interpolato; i <b>
    // del template restano.
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let msg = `📈🔻 <b>Price Jump Monitor</b>: ${jumps.length} venditori col prezzo salito &gt;3% (7gg vs 8-21gg)\n\n`;
    for (const [name, d] of Object.entries(perTenant)) {
      msg += `<b>${esc(name)}</b>: ${d.fix} auto-fix`;
      if (d.report.length) msg += ` | da segnalare al cliente: ${d.report.length}\n` + d.report.slice(0, 5).map(r => `  ${esc(r)}`).join('\n');
      msg += '\n';
    }
    try { await sendTelegram(msg.slice(0, 3900), { key: 'price_jump', parseMode: 'HTML', throttleMs: 12 * 3600 * 1000 }); } catch {}
  }
  console.log(`[PriceJump] ${jumps.length} salti rilevati, ${fixed} auto-fix su tenant pipe`);
  return { jumps: jumps.length, fixed };
}

let cronStarted = false;

function startPriceJumpMonitor() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    // 08:15 UTC = 10:15 italia (estate)
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 15, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try { await runPriceJumpMonitor(); } catch (e) { console.error('[PriceJump] err:', e.message); }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[PriceJump] Cron started — giornaliero 08:15 UTC (10:15 italia)');
}

module.exports = { runPriceJumpMonitor, startPriceJumpMonitor };
