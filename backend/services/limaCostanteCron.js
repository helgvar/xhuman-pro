/**
 * ✂️ LIMA COSTANTE (ordine capo 15/7: "tagli di costo poco ma costante,
 * senza perdere fatturato — e che siano ORDINI per xHumanPro")
 *
 * Ogni mattina alle 06:15 italiane, PRIMA dell'igiene delle 06:00... no:
 * alle 04:15 UTC (06:15 IT), per ogni tenant operational:
 *   - prende i TOP burner cliccati: click 15g > 0, ZERO vendite di rete 15g,
 *     nessuna protezione (is_feed_protected), niente pin/brand
 *   - ne rimuove POCHI: max 80 per tenant per giorno (sotto il cap-condanne,
 *     "poco ma costante"), ordinati per click decrescenti (prima i più costosi)
 *   - sorgente 'pulizia_lima_costante' = CLASSE PROTETTA: il daily engine la
 *     preserva (preserve-list pulizia_%), i delete anonimi sono vetati (L3),
 *     il rilascio avviene SOLO per merito (vendita in rete → winback/L2)
 *   - tutto FIRMATO a verbale arbitro
 *
 * Il fatturato è blindato per costruzione: si rimuove solo chi non ha venduto
 * NULLA in rete in 15 giorni; al primo ordine di rete la legge lo libera.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const TENANT_OPERATIONAL = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF',
  'Farmainsieme', 'Farmastelia', 'Farmacia Mandanici'];
const MAX_PER_TENANT = 80;

async function runLimaCostante() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('xhp.writer', 'lima_costante', true),
      set_config('xhp.motivo', 'ordine permanente capo 15/7: taglio costi poco ma costante, zero vendite 15g', true)`);
    const { rows } = await client.query(`
      WITH op AS (
        SELECT t.id tid, t.name tname FROM tenants t
        WHERE t.status='active' AND t.name = ANY($1)),
      ck AS (
        SELECT z.tenant_id, z.product_code sku, SUM(z.clicks) clicks
        FROM zombie_clicks z
        WHERE z.fetch_date >= CURRENT_DATE - 15
          AND z.tenant_id IN (SELECT tid FROM op)
        GROUP BY 1, 2),
      cand AS (
        SELECT c.tenant_id tid, c.sku, c.clicks,
          ROW_NUMBER() OVER (PARTITION BY c.tenant_id ORDER BY c.clicks DESC) rk
        FROM ck c
        JOIN products p ON p.tenant_id = c.tenant_id AND p.sku = c.sku
        WHERE NOT EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
            WHERE oi.sku = c.sku AND o.order_date >= NOW() - INTERVAL '15 days'
              AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato'))
          AND NOT is_feed_protected(c.tenant_id, c.sku)
          -- GUARDIA MAGAZZINO (capo 24/7): stock fisico si SPINGE, non si toglie.
          -- La lima tocca SOLO prodotti da grossista (erp_stock=0). Magazzino intoccabile.
          AND COALESCE(p.erp_stock, 0) = 0
          -- GUARDIA MARGINE 100% (capo 24/7): rimuovi SOLO quando il click ha
          -- BRUCIATO IL 100% del margine unitario vero (bibbia margine-first):
          -- speso >= il margine intero di UN ordine senza vendere nulla.
          -- 1-2 click su un prodotto a buon margine NON lo eliminano.
          AND c.clicks * 0.3294 >= 1.0 * GREATEST(margine_unitario_vero(c.tenant_id, c.sku), 0.01)
          -- GUARDIA TEST (riattivazione mig 072): non ri-bloccare durante la
          -- finestra di test 5gg aperta dallo scheduler.
          AND NOT EXISTS (SELECT 1 FROM margin_block_tests m
            WHERE m.tenant_id = c.tenant_id AND m.sku = c.sku
              AND m.in_test AND m.test_ends_at > NOW())),
      ins AS (
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source, computed_at, expires_at, status)
        SELECT tid, sku, 'REMOVE',
          'lima costante (capo 15/7 + guardie margine/magazzino 24/7): ' || clicks || ' click 15g, 0 vendite, brucia margine, no-magazzino',
          'pulizia_lima_costante', NOW(), NOW() + INTERVAL '7 days', 'pending'
        FROM cand WHERE rk <= $2
        ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
          action = 'REMOVE', action_source = 'pulizia_lima_costante',
          action_reason = EXCLUDED.action_reason, recommended_price = NULL,
          computed_at = NOW(), expires_at = NOW() + INTERVAL '7 days', status = 'pending'
        WHERE feed_actions.action_source NOT IN ('muro_scavalco','manual_pepita','manual','capo_pin')
        RETURNING tenant_id, sku)
      SELECT t.name, COUNT(*) n,
        COALESCE(SUM((SELECT SUM(z2.clicks) FROM zombie_clicks z2
          WHERE z2.tenant_id = ins.tenant_id AND z2.product_code = ins.sku
            AND z2.fetch_date >= CURRENT_DATE - 15)), 0) click_15g
      FROM ins JOIN tenants t ON t.id = ins.tenant_id
      GROUP BY t.name ORDER BY n DESC`,
      [TENANT_OPERATIONAL, MAX_PER_TENANT]);
    await client.query('COMMIT');

    const tot = rows.reduce((s, r) => s + parseInt(r.n), 0);
    const clk = rows.reduce((s, r) => s + parseInt(r.click_15g), 0);
    const det = rows.map(r => `${r.name}: ${r.n}`).join(', ');
    console.log(`[LimaCostante] ${tot} REMOVE (${det}) — ~${clk} click/15g coperti`);

    // PASS 1-bis — BRUCIA-MARGINE (pilota mig 089/090, ordine capo 5/8): dove
    // l2_richiede_ripago=1, anche chi VENDE viene giudicato — se il click 15g
    // costa più di 1,5× il margine 15g va fuori 7 giorni. Costo VERO, click≥5,
    // mai protetti/pin/carrelli sani: tutto dentro vende_ma_brucia_margine().
    // Prima nessun motore candidava questi (il caso 981647821 del capo): lo
    // scudo cadeva solo per condanne scritte a mano. Writer motore, non
    // sessione: il cap-anti-strage governa come per tutti.
    let brucia = 0;
    try {
      const cB = await pool.connect();
      try {
        await cB.query('BEGIN');
        await cB.query(`SELECT set_config('xhp.writer', 'lima_brucia_margine', true),
          set_config('xhp.motivo', 'ordine capo 5/8: vende ma il click brucia il margine (margine-first 15g)', true)`);
        const { rowCount } = await cB.query(`
          WITH pilota AS (
            SELECT hc.tenant_id FROM health_config hc
            JOIN tenants t ON t.id = hc.tenant_id AND t.status='active' AND t.name = ANY($1)
            WHERE hc.config_key='l2_richiede_ripago' AND hc.config_value='1'),
          ck AS (
            SELECT z.tenant_id, z.product_code sku, SUM(z.clicks) clicks
            FROM zombie_clicks z
            WHERE z.fetch_date >= CURRENT_DATE - 15
              AND z.tenant_id IN (SELECT tenant_id FROM pilota)
            GROUP BY 1, 2
            HAVING SUM(z.clicks) >= 5),
          cand AS (
            SELECT c.tenant_id tid, c.sku, c.clicks,
              ROW_NUMBER() OVER (PARTITION BY c.tenant_id ORDER BY c.clicks DESC) rk
            FROM ck c
            WHERE EXISTS (SELECT 1 FROM feed_stable_sku f
                    WHERE f.tenant_id = c.tenant_id AND f.sku = c.sku)
              AND vende_su_tenant_15g(c.tenant_id, c.sku)
              AND vende_ma_brucia_margine(c.tenant_id, c.sku))
          INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source, computed_at, expires_at, status)
          SELECT tid, sku, 'REMOVE',
            'brucia-margine (capo 5/8): '||clicks||' click 15g, il click costa piu di 1,5x il margine 15g. esilio 7g',
            'pulizia_brucia_margine', NOW(), NOW() + INTERVAL '7 days', 'pending'
          FROM cand WHERE rk <= $2
          ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
            action='REMOVE', action_source='pulizia_brucia_margine',
            action_reason=EXCLUDED.action_reason, recommended_price=NULL,
            computed_at=NOW(), expires_at=NOW() + INTERVAL '7 days', status='pending'
          WHERE feed_actions.action_source NOT IN ('muro_scavalco','manual_pepita','manual','capo_pin')`,
          [TENANT_OPERATIONAL, MAX_PER_TENANT]);
        await cB.query('COMMIT');
        brucia = rowCount;
      } catch (e) {
        await cB.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { cB.release(); }
    } catch (e) {
      console.error('[LimaCostante] brucia-margine err:', e.message);
    }
    if (brucia > 0) console.log(`[LimaCostante] brucia-margine (pilota): ${brucia} vendenti che non ripagano fuori`);

    // BANCO DI TEST (ordine capo 15/7): i bloccati che vendono in RETE ma qui
    // non sono posizionati NON si liberano alla cieca — si testano SOLO se un
    // PC legale li porta su un gradino della scala >= floor. Max 20/tenant/g.
    let testati = 0;
    try {
      const cTest = await pool.connect();
      try {
        await cTest.query('BEGIN');
        await cTest.query(`SELECT set_config('xhp.writer', 'lima_costante_test', true),
          set_config('xhp.motivo', 'test posizione (ordine 15/7): vendente di rete non posizionato, PC legale lo porta in scala', true)`);
        const { rows: tRows } = await cTest.query(`
          WITH op AS (
            SELECT t.id tid FROM tenants t
            WHERE t.status='active' AND t.name = ANY($1)),
          bloccati AS (
            SELECT DISTINCT b.tenant_id, b.sku FROM (
              SELECT fk.tenant_id, fk.sku FROM feed_killers fk WHERE fk.is_active
              UNION ALL SELECT fq.tenant_id, fq.sku FROM feed_quarantine fq
                WHERE fq.reactivated=false AND COALESCE(fq.manual_override,false)=false
              UNION ALL SELECT fa.tenant_id, fa.sku FROM feed_actions fa WHERE fa.action='REMOVE') b
            WHERE b.tenant_id IN (SELECT tid FROM op)
              AND vende_in_rete_15g(b.sku)
              AND NOT vende_su_tenant_15g(b.tenant_id, b.sku)
              AND COALESCE(pos_fresca(b.tenant_id, b.sku), 999) >
                  COALESCE((SELECT hc.config_value::int FROM health_config hc
                    WHERE hc.tenant_id=b.tenant_id AND hc.config_key='release_pos_max'), 10)
              AND is_price_cut_allowed(b.tenant_id, b.sku)),
          fresco AS (
            SELECT product_code, merchant, base_price FROM scraper_competitors
            WHERE scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '20 hours'
              AND base_price > 0 AND product_code IN (SELECT sku FROM bloccati)),
          scala AS (
            SELECT f.product_code,
              (ARRAY_AGG(f.base_price ORDER BY f.base_price) FILTER (WHERE f.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'))[1] p1,
              (ARRAY_AGG(f.base_price ORDER BY f.base_price) FILTER (WHERE f.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'))[2] p2,
              (ARRAY_AGG(f.base_price ORDER BY f.base_price) FILTER (WHERE f.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'))[3] p3
            FROM fresco f GROUP BY 1),
          tgt AS (
            SELECT b.tenant_id tid, b.sku, p.sell_price,
              GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
                CASE WHEN COALESCE(p.erp_stock,0)>0 THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END)
                * (1 + COALESCE(
                    (SELECT hc.config_value::numeric FROM health_config hc
                     WHERE hc.tenant_id=b.tenant_id AND hc.config_key='ricarico_floor_pct'),
                    CASE WHEN p.sell_price < 10 THEN 18 WHEN p.sell_price <= 30 THEN 14 ELSE 12 END)/100) floorx,
              s.p1, s.p2, s.p3,
              ROW_NUMBER() OVER (PARTITION BY b.tenant_id ORDER BY random()) rk
            FROM bloccati b
            JOIN products p ON p.tenant_id=b.tenant_id AND p.sku=b.sku
            JOIN scala s ON s.product_code=b.sku
            WHERE p.saleable AND (COALESCE(p.erp_stock,0)+COALESCE(p.supplier_stock,0))>0),
          px AS (
            SELECT tid, sku, sell_price,
              CASE WHEN p1-0.01 >= floorx THEN ROUND((p1-0.01)::numeric,2)
                   WHEN p2-0.01 >= floorx THEN ROUND((p2-0.01)::numeric,2)
                   WHEN p3-0.01 >= floorx THEN ROUND((p3-0.01)::numeric,2)
                   ELSE NULL END v
            FROM tgt WHERE rk <= 20),
          ok AS (SELECT * FROM px WHERE v IS NOT NULL AND v < sell_price - 0.01),
          rel_k AS (UPDATE feed_killers fk SET is_active=false
            FROM ok WHERE fk.tenant_id=ok.tid AND fk.sku=ok.sku AND fk.is_active RETURNING 1),
          rel_q AS (UPDATE feed_quarantine fq SET reactivated=true, reactivated_at=NOW()
            FROM ok WHERE fq.tenant_id=ok.tid AND fq.sku=ok.sku AND fq.reactivated=false
              AND COALESCE(fq.manual_override,false)=false RETURNING 1),
          rel_r AS (DELETE FROM feed_actions fa USING ok
            WHERE fa.tenant_id=ok.tid AND fa.sku=ok.sku AND fa.action='REMOVE' RETURNING 1)
          INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
            current_price, recommended_price, computed_at, expires_at, status)
          SELECT tid, sku, 'PRICE_CUT',
            'test posizione (lima 15/7): vendente di rete, PC lo porta in scala',
            'manual_pepita', sell_price, v, NOW(), NOW()+INTERVAL '14 days', 'pending'
          FROM ok
          ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
            action='PRICE_CUT', action_source='manual_pepita',
            action_reason=EXCLUDED.action_reason, recommended_price=EXCLUDED.recommended_price,
            computed_at=NOW(), expires_at=NOW()+INTERVAL '14 days', status='pending'
          WHERE feed_actions.action_source <> 'muro_scavalco'
          RETURNING tenant_id`, [TENANT_OPERATIONAL]);
        await cTest.query('COMMIT');
        testati = tRows.length;
      } catch (e) {
        await cTest.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { cTest.release(); }
    } catch (e) {
      console.error('[LimaCostante] test posizione err:', e.message);
    }
    if (testati > 0) console.log(`[LimaCostante] test posizione: ${testati} vendenti-rete liberati CON PC`);

    // PASS 3 — VETRINA PIENA (ordine capo 15/7, mig 063): refresh giornaliero
    // del pattern (pos<=3, 150+ click 90g, <=1 ordine magro, incidenza>50%)
    // e REMOVE dei provati. Il carve-out magazzino vive in is_feed_protected.
    let vetrina = 0;
    try {
      const cV = await pool.connect();
      try {
        await cV.query('BEGIN');
        await cV.query(`SELECT set_config('xhp.writer', 'lima_vetrina_piena', true),
          set_config('xhp.motivo', 'pattern vetrina-piena: vetrina avuta 90g, il canale click non lo vende', true)`);
        await cV.query('SELECT refresh_vetrina_piena()');
        const { rowCount } = await cV.query(`
          INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source, computed_at, expires_at, status)
          SELECT v.tenant_id, v.sku, 'REMOVE',
            -- format() con %s tratta NULL come stringa vuota: action_reason non
            -- diventa mai NULL. v.pos e' NULL per i provati entrati dalle porte
            -- 5b/5c (porta PC chiusa / gap strutturale), non dalla vetrina fresca
            -- -> senza questo, '|| v.pos ||' NULL faceva crashare l'intero PASS 3
            format('vetrina piena: pos %s, %s click 90g, %s ordini rete, carrello EUR %s',
              COALESCE(v.pos::text, 'n/d'), v.click_90g, COALESCE(v.ordini_rete_90g, 0),
              ROUND(COALESCE(v.basket_margin_90g, 0), 2)),
            'pulizia_vetrina_piena', NOW(), NOW()+INTERVAL '7 days', 'pending'
          FROM vetrina_piena_provati v
          -- SOLO operational + Farmacri (capo 15/7: i non-operational NON si
          -- leggono insieme agli altri — feed loro = dominio Farmabooster)
          JOIN tenants tt ON tt.id = v.tenant_id
            AND tt.name = ANY($1 || ARRAY['Farmacri'])
          ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
            action='REMOVE', action_source='pulizia_vetrina_piena',
            action_reason=EXCLUDED.action_reason, recommended_price=NULL,
            computed_at=NOW(), expires_at=NOW()+INTERVAL '7 days', status='pending'
          WHERE feed_actions.action_source NOT IN ('muro_scavalco','manual_pepita','manual','capo_pin')`,
          [TENANT_OPERATIONAL]);
        await cV.query('COMMIT');
        vetrina = rowCount;
      } catch (e) {
        await cV.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { cV.release(); }
    } catch (e) {
      console.error('[LimaCostante] vetrina piena err:', e.message);
    }
    if (vetrina > 0) console.log(`[LimaCostante] vetrina piena: ${vetrina} provati fuori da TP`);

    // PASS 4 — RETE-ONLY CAP (ordine capo 15/7): un SKU che vende in RETE ma
    // NON sul suo tenant resta attivo finché la spesa click sta sotto il tetto
    // (global_config rete_only_cap_eur_month, default 80€/mese). Oltre → fuori.
    let reteonly = 0;
    try {
      const cR = await pool.connect();
      try {
        await cR.query('BEGIN');
        await cR.query(`SELECT set_config('xhp.writer', 'lima_reteonly_cap', true),
          set_config('xhp.motivo', 'tetto rete-only capo 15/7: vende in rete ma non qui, spesa oltre soglia', true)`);
        const capEur = `COALESCE((SELECT config_value::numeric FROM global_config WHERE config_key='rete_only_cap_eur_month'), 80)`;
        const { rowCount } = await cR.query(`
          WITH op AS (SELECT id FROM tenants WHERE status='active' AND name = ANY($1)),
          vende_rete AS (SELECT DISTINCT oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id
            WHERE o.order_date>=NOW()-INTERVAL '90 days' AND o.order_status NOT IN ('canceled','closed')),
          vende_tenant AS (SELECT o.tenant_id, oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id
            WHERE o.order_date>=NOW()-INTERVAL '90 days' AND o.order_status NOT IN ('canceled','closed') GROUP BY 1,2),
          ck AS (SELECT z.tenant_id, z.product_code sku, SUM(z.clicks) c30 FROM zombie_clicks z
            WHERE z.fetch_date>=CURRENT_DATE-30 GROUP BY 1,2),
          over_cap AS (
            SELECT c.tenant_id, c.sku FROM ck c JOIN op t ON t.id=c.tenant_id
            JOIN products p ON p.tenant_id=c.tenant_id AND p.sku=c.sku
            WHERE p.is_civetta AND c.c30*0.3294 > ${capEur}
              AND c.sku IN (SELECT sku FROM vende_rete)
              AND (c.tenant_id, c.sku) NOT IN (SELECT tenant_id, sku FROM vende_tenant)
              AND COALESCE(p.sales_30d_seller,0)=0
              AND NOT is_brand_protected(c.tenant_id,c.sku) AND NOT is_basket_protected(c.tenant_id,c.sku)
              AND NOT EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id=c.tenant_id AND cp.sku=c.sku AND cp.revoked_at IS NULL)),
          ins_dp AS (INSERT INTO dieta_provati SELECT tenant_id, sku FROM over_cap ON CONFLICT DO NOTHING RETURNING 1)
          INSERT INTO feed_quarantine (tenant_id, sku, reason, quarantine_start, quarantine_end, reactivated, manual_override, manual_override_at, quarantine_level)
          SELECT tenant_id, sku, 'rete-only cap 80€/mese (ordine permanente capo 15/7)', NOW(), NOW()+INTERVAL '30 days', false, true, NOW(), 3
          FROM over_cap
          ON CONFLICT (tenant_id,sku) DO UPDATE SET reason=EXCLUDED.reason, reactivated=false, reactivated_at=NULL,
            manual_override=true, manual_override_at=NOW(), quarantine_start=NOW(), quarantine_end=NOW()+INTERVAL '30 days'`,
          [TENANT_OPERATIONAL]);
        await cR.query('COMMIT');
        reteonly = rowCount;
      } catch (e) {
        await cR.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { cR.release(); }
    } catch (e) {
      console.error('[LimaCostante] rete-only cap err:', e.message);
    }
    if (reteonly > 0) console.log(`[LimaCostante] rete-only cap: ${reteonly} oltre 80€/mese fuori da TP`);

    if (tot > 0 || brucia > 0 || testati > 0 || vetrina > 0 || reteonly > 0) {
      await sendTelegram(`✂️ Lima costante: ${tot} burner fuori (${det}) — ~${Math.round(clk / 15)} click/g risparmiati. 🔥 Brucia-margine (pilota): ${brucia} vendenti che non ripagano fuori. 🧪 Test posizione: ${testati} liberati con PC. 🏪 Vetrina piena: ${vetrina} fuori. 🔁 Rete-only oltre 80€/mese: ${reteonly} fuori. Rilascio per merito sempre attivo.`).catch(() => {});
    }
    return { tot, brucia, testati, vetrina, reteonly, rows };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[LimaCostante] err:', e.message);
    return null;
  } finally { client.release(); }
}

function start() {
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(4, 15, 0, 0);                   // 04:15 UTC = 06:15 Italia
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      await runLimaCostante();
      schedule();
    }, next - now);
    console.log(`[LimaCostante] armata — prossimo giro ${next.toISOString()}`);
  };
  schedule();
}

module.exports = { start, runLimaCostante };
