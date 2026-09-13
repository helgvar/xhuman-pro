/**
 * 🔁 LOOP RETE-ONLY — "vende in rete, non qui" (ordine capo 13/09)
 *
 *   "Se vende nella rete e non sul singolo tenant, o va riposizionato e
 *    monitorato per massimo 3 giorni o va staccato subito. Se dopo i 3 giorni
 *    comunque non vende o non ha un'incidenza giusta deve essere tagliato."
 *
 * Prima di oggi questo caso aveva solo SCUDI e nessun orologio. Misura del
 * 13/09 su Procaccini: 546 SKU vivi, 293,08 EUR/30gg, e nessuno dei pezzi
 * esistenti li toccava (tetto lima 80 EUR/mese PER SKU vs 4,61 EUR di massimo,
 * banco di test lima aperto solo ai gia' bloccati, scudo L2-rete eterno,
 * is_feed_protected che protegge per sola posizione top-10).
 *
 * DUE FASI, come vuole una misura onesta.
 *
 *   FASE A — BIVIO (ogni giorno). Candidati: nel feed servito, vendono in rete
 *   15gg, NON vendono su questo tenant, ricevono click. Per ognuno si misura lo
 *   spazio prezzo su scraper FRESCO (<=30h) contro il minimo ESTERNO (mai la
 *   rete: no internal pricing war):
 *     - c'e' spazio sopra il floor di fascia  -> PRICE_CUT + orologio 3 giorni
 *     - non c'e' (gia' primo, o il taglio sfonda il floor) -> REMOVE subito
 *
 *   FASE B — VERDETTO (a 3 giorni). Si rimisura sulla finestra di osservazione:
 *     - ha venduto qui E incidenza <= soglia -> PROMOSSO, il PC resta
 *     - zero pezzi, o incidenza sbagliata    -> BOCCIATO, REMOVE + quarantena
 *
 * IL TETTO E' SUL BUCKET, NON SULLO SKU. Il PASS 4 della lima (80 EUR/mese per
 * SKU) resta dov'e' e prende i singoli grandi bruciatori. Qui il tetto e'
 * aggregato: quanta spesa click puo' stare in osservazione aperta insieme.
 * Senza, il loop stesso diventerebbe la perdita che deve chiudere.
 *
 * COSA NON SCAVALCA MAI (mig 133): brand protetto, carrello sano, pin del capo,
 * dati piu' vecchi di 12h. E gli scudi L2 (vende su QUESTO tenant) e L4 (vende
 * e ripaga) restano in piedi: se durante i 3 giorni lo SKU inizia a vendere
 * qui, il verdetto e' 'promosso' e il taglio non parte; se partisse per errore,
 * il trigger lo blocca lo stesso. E' la rete di sicurezza, non un doppione.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');
const { getTenantCpcGross } = require('./cpcConfig');

const TENANT_OPERATIONAL = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF',
  'Farmainsieme', 'Farmastelia', 'Farmacia Mandanici'];

// Gradualita' (dottrina 500-1500/ciclo sulle promozioni; qui si taglia, quindi
// molto piu' stretto): il bucket si smaltisce in giorni, non in un botto.
const MAX_PC_PER_TENANT     = 60;
const MAX_REMOVE_PER_TENANT = 120;
const GIORNI_OSSERVAZIONE   = 3;
const ORDER_STATUS = ['complete', 'processing', 'pending', 'holded', 'payment_review',
  'fraud', 'ritiro_farmacia', 'Ritirato'];

// I nostri negozi non fanno da riferimento a se stessi (no internal pricing war).
const MERCHANT_RETE = 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia';

const RUN_HOUR_UTC = 4;
const RUN_MIN_UTC  = 45;   // 06:45 IT — dopo la lima (06:15) e dopo il file click (05:01)

async function getCfg(key, dflt) {
  const { rows } = await pool.query(
    `SELECT config_value FROM global_config WHERE config_key = $1`, [key]);
  const v = rows[0] && parseFloat(rows[0].config_value);
  return Number.isFinite(v) ? v : dflt;
}

// ---------------------------------------------------------------------------
// FASE A — il bivio: riposiziona o stacca
// ---------------------------------------------------------------------------
// Cancello di freschezza sugli ORDINI (13/09): un tenant il cui orders_sync e'
// vecchio non si giudica. Senza questo, un prodotto venduto dopo l'ultimo sync
// risulta "mai venduto qui" e viene tagliato — successo davvero su XIOGLICAN,
// venduto alle 11:22 con sync fermo alle 10:34.
const ORE_MAX_SYNC_ORDINI = 3;

async function ordiniFreschi(tenantId) {
  const { rows } = await pool.query(`
    SELECT MAX(completed_at) ultimo,
           EXTRACT(EPOCH FROM (NOW() - MAX(completed_at))) / 3600 ore
      FROM import_jobs
     WHERE tenant_id = $1 AND job_type = 'orders_sync' AND status = 'completed'`,
    [tenantId]);
  const ore = rows[0]?.ore == null ? null : parseFloat(rows[0].ore);
  return { ok: ore !== null && ore <= ORE_MAX_SYNC_ORDINI, ore };
}

async function faseA(tenant, cpcGross, capBucket, dry) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('xhp.writer', 'sessione_rete_only_bivio', true),
              set_config('xhp.motivo', $1, true)`,
      ['ordine capo 13/09: vende in rete ma non qui — riposiziona 3gg o stacca subito']);

    // La spesa gia' impegnata in osservazioni aperte: il tetto e' del bucket.
    const { rows: [imp] } = await client.query(`
      SELECT COALESCE(SUM(spesa_prima_30g), 0)::numeric impegnata,
             COUNT(*)::int aperte
      FROM rete_only_osservazioni
      WHERE tenant_id = $1 AND esito IS NULL`, [tenant.id]);
    const spazioBucket = Math.max(0, capBucket - parseFloat(imp.impegnata));

    const { rows: cand } = await client.query(`
      WITH ck AS (
        SELECT z.product_code sku, SUM(z.clicks)::int click30
        FROM zombie_clicks z
        WHERE z.tenant_id = $1 AND z.fetch_date >= CURRENT_DATE - 30
        GROUP BY 1 HAVING SUM(z.clicks) > 0),
      base AS (
        SELECT c.sku, c.click30, ROUND(c.click30 * $2::numeric, 2) spesa30,
          p.product_name, p.erp_stock, p.supplier_stock,
          -- prezzo VIVO: quello che TP vede davvero (legge prezzo secco)
          COALESCE(NULLIF(p.exported_price,0), NULLIF(p.applied_price,0), NULLIF(p.sell_price,0)) prezzo_vivo,
          -- costo di guardia: farmacia se c'e' giacenza, altrimenti grossista
          costo_guardia(p.tenant_id, p.sku) costo_v,
          pos_fresca(p.tenant_id, p.sku) pos
        FROM ck c
        JOIN products p ON p.tenant_id = $1 AND p.sku = c.sku
        JOIN feed_stable_sku f ON f.tenant_id = $1 AND f.sku = c.sku
        WHERE p.saleable
          AND (COALESCE(p.erp_stock,0) + COALESCE(p.supplier_stock,0)) > 0
          -- legge del costo (25/08): niente giudizi su dati stantii
          AND p.updated_at >= NOW() - INTERVAL '12 hours'
          AND vende_in_rete_15g(c.sku)
          -- "MAI venduto qui" (ordine capo 13/09): 90 giorni, non 15. Con 15gg
          -- passavano venditori da 25-30 giorni fa e venivano tagliati a torto:
          -- 116 su 252 al primo giro su Procaccini.
          AND NOT EXISTS (
                SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                 WHERE oi.tenant_id = $1 AND o.tenant_id = $1 AND oi.sku = c.sku
                   AND o.order_status = ANY($4)
                   AND o.order_date >= NOW() - INTERVAL '90 days')
          AND NOT is_brand_protected($1, c.sku)
          AND NOT is_basket_protected($1, c.sku)
          AND NOT porta_carrelli_sani($1, c.sku)
          AND NOT EXISTS (SELECT 1 FROM capo_pins cp
                WHERE cp.tenant_id = $1 AND cp.sku = c.sku AND cp.revoked_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM feed_quarantine q
                WHERE q.tenant_id = $1 AND q.sku = c.sku AND q.reactivated = false)
          AND NOT EXISTS (SELECT 1 FROM feed_actions fa
                WHERE fa.tenant_id = $1 AND fa.sku = c.sku AND fa.action = 'REMOVE')
          AND NOT EXISTS (SELECT 1 FROM rete_only_osservazioni ro
                WHERE ro.tenant_id = $1 AND ro.sku = c.sku AND ro.esito IS NULL)),
      -- minimo ESTERNO su scraper fresco. Il floor del taglio non e' mai la rete.
      fresco AS (
        SELECT sc.product_code, MIN(sc.base_price) p1
        FROM scraper_competitors sc
        WHERE sc.scraped_at >= NOW() - INTERVAL '30 hours'
          AND sc.base_price > 0
          AND sc.merchant !~* $3
          AND sc.product_code IN (SELECT sku FROM base)
        GROUP BY 1),
      calc AS (
        SELECT b.*, f.p1,
          ROUND((f.p1 - 0.01)::numeric, 2) nuovo,
          COALESCE(
            (SELECT hc.config_value::numeric FROM health_config hc
              WHERE hc.tenant_id = $1 AND hc.config_key = 'ricarico_floor_pct'),
            CASE WHEN b.prezzo_vivo < 10 THEN 18 WHEN b.prezzo_vivo <= 30 THEN 14 ELSE 12 END
          ) floor_pct
        FROM base b LEFT JOIN fresco f ON f.product_code = b.sku
        -- prezzo 0 = dato ASSENTE, mai un prezzo. Costo <= 0,10 con giacenza = idem.
        WHERE b.prezzo_vivo > 0 AND b.costo_v > 0.10)
      SELECT sku, product_name, click30, spesa30, pos, prezzo_vivo, costo_v,
        erp_stock, supplier_stock, p1, nuovo, floor_pct,
        CASE WHEN costo_v > 0 AND nuovo IS NOT NULL
             THEN ROUND(((nuovo - costo_v) / costo_v * 100)::numeric, 1) END ric_post,
        (nuovo IS NOT NULL
         AND nuovo < prezzo_vivo - 0.01
         AND (nuovo - costo_v) / costo_v * 100 >= floor_pct) riposizionabile
      FROM calc
      ORDER BY spesa30 DESC`,
      [tenant.id, cpcGross, MERCHANT_RETE, ORDER_STATUS]);

    // Il bivio. Chi ha spazio prezzo entra in osservazione fino a capienza del
    // tetto di bucket; chi non ne ha esce subito (non c'e' niente da provare).
    const daTagliare = [];
    const daRiposizionare = [];
    let budget = spazioBucket;
    for (const r of cand) {
      if (r.riposizionabile) {
        if (daRiposizionare.length < MAX_PC_PER_TENANT && budget >= parseFloat(r.spesa30)) {
          budget -= parseFloat(r.spesa30);
          daRiposizionare.push(r);
        }
        // oltre il tetto: resta com'e', si riprova domani. Non si taglia
        // per capienza — si taglia per merito.
      } else if (daTagliare.length < MAX_REMOVE_PER_TENANT) {
        daTagliare.push(r);
      }
    }

    if (dry) {
      await client.query('ROLLBACK');
      return { cand: cand.length, pc: daRiposizionare.length, rem: daTagliare.length,
        spesaPc: somma(daRiposizionare), spesaRem: somma(daTagliare), aperte: imp.aperte, dry: true };
    }

    // --- PRICE_CUT + orologio ---
    let pcVetati = 0;
    for (const r of daRiposizionare) {
      const ins = await client.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
          current_price, recommended_price, erp_cost, cost_source,
          erp_stock, supplier_stock, stock_source, computed_at, expires_at, status)
        VALUES ($1, $2, 'PRICE_CUT', $3, 'pulizia_rete_only', $4, $5, $6, 'guardia',
          $7, $8, CASE WHEN $7 > 0 THEN 'erp' ELSE 'supplier' END,
          NOW(), NOW() + make_interval(days => $9::int), 'pending')
        ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
          action = 'PRICE_CUT', action_source = 'pulizia_rete_only',
          action_reason = EXCLUDED.action_reason,
          current_price = EXCLUDED.current_price,
          recommended_price = EXCLUDED.recommended_price,
          erp_cost = EXCLUDED.erp_cost, cost_source = 'guardia',
          computed_at = NOW(), expires_at = EXCLUDED.expires_at, status = 'pending'
        WHERE feed_actions.action_source NOT IN ('muro_scavalco','manual_pepita','manual','capo_pin')`,
        [tenant.id, r.sku,
         `rete-only (capo 13/09): vende in rete, non qui. ${r.click30} click 30gg = ${r.spesa30} EUR, pos ${r.pos ?? 'n/d'}. PC a ${r.nuovo} (min esterno ${r.p1}), ricarico post ${r.ric_post}% >= floor ${r.floor_pct}%. Orologio ${GIORNI_OSSERVAZIONE}gg.`,
         r.prezzo_vivo, r.nuovo, r.costo_v, r.erp_stock || 0, r.supplier_stock || 0,
         GIORNI_OSSERVAZIONE]);

      // Il PC vetato non esiste: niente orologio su un riposizionamento mai
      // avvenuto, altrimenti fra 3 giorni lo si condanna per non aver venduto
      // a un prezzo che non ha mai avuto.
      if (ins.rowCount === 0) { pcVetati++; continue; }

      await client.query(`
        INSERT INTO rete_only_osservazioni (tenant_id, sku, fase, prezzo_prima, prezzo_dopo,
          costo_prima, ricarico_post_pct, pos_prima, click_prima_30g, spesa_prima_30g,
          activated_at, osservazione_giorni, osservazione_end)
        VALUES ($1, $2, 'riposizionato', $3, $4, $5, $6, $7, $8, $9,
          NOW(), $10::int, NOW() + make_interval(days => $10::int))
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          fase = 'riposizionato', prezzo_prima = EXCLUDED.prezzo_prima,
          prezzo_dopo = EXCLUDED.prezzo_dopo, costo_prima = EXCLUDED.costo_prima,
          ricarico_post_pct = EXCLUDED.ricarico_post_pct, pos_prima = EXCLUDED.pos_prima,
          click_prima_30g = EXCLUDED.click_prima_30g, spesa_prima_30g = EXCLUDED.spesa_prima_30g,
          activated_at = NOW(), osservazione_end = EXCLUDED.osservazione_end,
          esito = NULL, motivo_esito = NULL, closed_at = NULL,
          pezzi_dopo = NULL, netto_dopo = NULL, click_dopo = NULL,
          spesa_dopo = NULL, incidenza_dopo = NULL`,
        [tenant.id, r.sku, r.prezzo_vivo, r.nuovo, r.costo_v, r.ric_post,
         r.pos, r.click30, r.spesa30, GIORNI_OSSERVAZIONE]);
    }

    // --- REMOVE subito: nessuno spazio prezzo, niente da provare ---
    for (const r of daTagliare) {
      const perche = r.p1 == null
        ? 'nessun riferimento esterno fresco'
        : (parseFloat(r.nuovo) >= parseFloat(r.prezzo_vivo) - 0.01
            ? `gia' al minimo o sotto (min esterno ${r.p1}, noi ${r.prezzo_vivo})`
            : `il taglio a ${r.nuovo} sfonda il floor (ricarico ${r.ric_post}% < ${r.floor_pct}%)`);
      await client.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
          current_price, erp_cost, cost_source, erp_stock, supplier_stock, stock_source,
          computed_at, expires_at, status)
        VALUES ($1, $2, 'REMOVE', $3, 'pulizia_rete_only', $4, $5, 'guardia',
          $6, $7, CASE WHEN $6 > 0 THEN 'erp' ELSE 'supplier' END,
          NOW(), NOW() + INTERVAL '30 days', 'pending')
        ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
          action = 'REMOVE', action_source = 'pulizia_rete_only',
          action_reason = EXCLUDED.action_reason, recommended_price = NULL,
          current_price = EXCLUDED.current_price, erp_cost = EXCLUDED.erp_cost,
          cost_source = 'guardia', computed_at = NOW(),
          expires_at = NOW() + INTERVAL '30 days', status = 'pending'
        WHERE feed_actions.action_source NOT IN ('muro_scavalco','manual_pepita','manual','capo_pin')`,
        [tenant.id, r.sku,
         `rete-only (capo 13/09): vende in rete, non qui, e non c'e' riposizionamento possibile — ${perche}. ${r.click30} click 30gg = ${r.spesa30} EUR, pos ${r.pos ?? 'n/d'}.`,
         r.prezzo_vivo, r.costo_v, r.erp_stock || 0, r.supplier_stock || 0]);
    }

    // Quanti sono davvero atterrati: i trigger scartano in SILENZIO (RETURN NULL).
    const { rows: [land] } = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE action = 'PRICE_CUT')::int pc,
        COUNT(*) FILTER (WHERE action = 'REMOVE')::int rem
      FROM feed_actions
      WHERE tenant_id = $1 AND action_source = 'pulizia_rete_only'
        AND computed_at >= NOW() - INTERVAL '10 minutes'`, [tenant.id]);

    await client.query('COMMIT');
    return {
      cand: cand.length,
      pc: land.pc, pcChiesti: daRiposizionare.length, pcVetati,
      rem: land.rem, remChiesti: daTagliare.length,
      spesaPc: somma(daRiposizionare), spesaRem: somma(daTagliare),
      aperte: imp.aperte
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[ReteOnly] fase A ${tenant.name} err:`, e.message);
    return null;
  } finally { client.release(); }
}

// ---------------------------------------------------------------------------
// FASE B — il verdetto a 3 giorni
// ---------------------------------------------------------------------------
async function faseB(tenant, cpcGross, incidenzaMax, dry) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('xhp.writer', 'sessione_rete_only_verdetto', true),
              set_config('xhp.motivo', $1, true)`,
      [`ordine capo 13/09: verdetto a ${GIORNI_OSSERVAZIONE} giorni sul riposizionamento rete-only`]);

    // Misura sulla SOLA finestra di osservazione, mai a scorrimento.
    const { rows: giudizi } = await client.query(`
      WITH scaduti AS (
        SELECT * FROM rete_only_osservazioni
        WHERE tenant_id = $1 AND esito IS NULL AND osservazione_end <= NOW()),
      -- netto IVA inclusa, come tutte le incidenze della macchina
      vend AS (
        SELECT s.sku,
          (SELECT COALESCE(SUM(oi.qty_ordered), 0)::int
             FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE oi.tenant_id = $1 AND oi.sku = s.sku
              AND o.tenant_id = $1 AND o.order_status = ANY($3)
              AND (o.order_date AT TIME ZONE 'Europe/Rome') >= (s.activated_at AT TIME ZONE 'Europe/Rome')) pezzi,
          (SELECT COALESCE(SUM(COALESCE(NULLIF(oi.row_total_incl_tax,0), oi.row_total * 1.10)), 0)::numeric
             FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE oi.tenant_id = $1 AND oi.sku = s.sku
              AND o.tenant_id = $1 AND o.order_status = ANY($3)
              AND (o.order_date AT TIME ZONE 'Europe/Rome') >= (s.activated_at AT TIME ZONE 'Europe/Rome')) netto
        FROM scaduti s),
      clk AS (
        SELECT s.sku, COALESCE(SUM(z.clicks), 0)::int click
        FROM scaduti s
        LEFT JOIN zombie_clicks z ON z.tenant_id = $1 AND z.product_code = s.sku
          AND z.fetch_date >= s.activated_at::date
        GROUP BY 1)
      SELECT s.*, COALESCE(v.pezzi,0) pezzi, COALESCE(v.netto,0) netto,
        COALESCE(c.click,0) click,
        ROUND(COALESCE(c.click,0) * $2::numeric, 2) spesa,
        CASE WHEN COALESCE(v.netto,0) > 0
             THEN ROUND((COALESCE(c.click,0) * $2::numeric / v.netto * 100)::numeric, 2)
             END incidenza
      FROM scaduti s
      LEFT JOIN vend v ON v.sku = s.sku
      LEFT JOIN clk  c ON c.sku = s.sku`,
      [tenant.id, cpcGross, ORDER_STATUS]);

    if (!giudizi.length) { await client.query('ROLLBACK'); return { n: 0, promossi: 0, bocciati: 0 }; }

    const promossi = giudizi.filter(g => g.pezzi > 0
      && (g.incidenza === null || parseFloat(g.incidenza) <= incidenzaMax));
    const bocciati = giudizi.filter(g => !promossi.includes(g));

    if (dry) {
      await client.query('ROLLBACK');
      return { n: giudizi.length, promossi: promossi.length, bocciati: bocciati.length,
        spesaBocciati: somma(bocciati, 'spesa_prima_30g'), dry: true };
    }

    for (const g of promossi) {
      await client.query(`
        UPDATE rete_only_osservazioni SET esito = 'promosso',
          motivo_esito = $3, closed_at = NOW(),
          pezzi_dopo = $4, netto_dopo = $5, click_dopo = $6, spesa_dopo = $7, incidenza_dopo = $8
        WHERE tenant_id = $1 AND sku = $2`,
        [tenant.id, g.sku,
         `promosso: ${g.pezzi} pezzi in ${GIORNI_OSSERVAZIONE}gg, incidenza ${g.incidenza ?? 'n/d'}% <= ${incidenzaMax}%`,
         g.pezzi, g.netto, g.click, g.spesa, g.incidenza]);
      // il PC resta: ha funzionato. Gli si toglie solo la scadenza corta.
      await client.query(`
        UPDATE feed_actions SET expires_at = NOW() + INTERVAL '30 days',
          action_reason = action_reason || ' | PROMOSSO: ha venduto qui.'
        WHERE tenant_id = $1 AND sku = $2 AND action_source = 'pulizia_rete_only'
          AND action = 'PRICE_CUT'`, [tenant.id, g.sku]);
    }

    let remVetati = 0;
    for (const g of bocciati) {
      const perche = g.pezzi === 0
        ? `zero pezzi in ${GIORNI_OSSERVAZIONE}gg dopo il riposizionamento (${g.click} click, ${g.spesa} EUR bruciati)`
        : `incidenza ${g.incidenza}% oltre il ${incidenzaMax}% (${g.pezzi} pezzi, ${g.spesa} EUR di click)`;

      const rem = await client.query(`
        INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
          current_price, erp_cost, cost_source, computed_at, expires_at, status)
        VALUES ($1, $2, 'REMOVE', $3, 'pulizia_rete_only', $4, $5, 'guardia',
          NOW(), NOW() + INTERVAL '60 days', 'pending')
        ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
          action = 'REMOVE', action_source = 'pulizia_rete_only',
          action_reason = EXCLUDED.action_reason, recommended_price = NULL,
          computed_at = NOW(), expires_at = NOW() + INTERVAL '60 days', status = 'pending'`,
        [tenant.id, g.sku,
         `rete-only BOCCIATO (capo 13/09): ${perche}. Riposizionato da ${g.prezzo_prima} a ${g.prezzo_dopo} il ${new Date(g.activated_at).toLocaleDateString('it-IT')}.`,
         g.prezzo_dopo, g.costo_prima]);

      // Uno scudo ancora in piedi (L2/L4) ha l'ultima parola: il verdetto resta
      // agli atti, ma il taglio non c'e' stato e non va raccontato come fatto.
      if (rem.rowCount === 0) {
        remVetati++;
        await client.query(`
          UPDATE rete_only_osservazioni SET esito = 'bocciato_ma_salvato',
            motivo_esito = $3 || ' | REMOVE respinto da uno scudo ancora attivo (L2/L4): resta nel feed',
            closed_at = NOW(), pezzi_dopo = $4, netto_dopo = $5,
            click_dopo = $6, spesa_dopo = $7, incidenza_dopo = $8
          WHERE tenant_id = $1 AND sku = $2`,
          [tenant.id, g.sku, perche, g.pezzi, g.netto, g.click, g.spesa, g.incidenza]);
        continue;
      }

      await client.query(`
        UPDATE rete_only_osservazioni SET esito = 'bocciato',
          motivo_esito = $3, closed_at = NOW(),
          pezzi_dopo = $4, netto_dopo = $5, click_dopo = $6, spesa_dopo = $7, incidenza_dopo = $8
        WHERE tenant_id = $1 AND sku = $2`,
        [tenant.id, g.sku, perche, g.pezzi, g.netto, g.click, g.spesa, g.incidenza]);

      await client.query(`
        INSERT INTO feed_quarantine (tenant_id, sku, reason, quarantine_start, quarantine_end,
          quarantine_level, manual_override, manual_override_at,
          observation_start, observation_end, observation_clicks, observation_orders)
        VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '60 days', 2, true, NOW(), $4, $5, $6, $7)
        ON CONFLICT (tenant_id, sku) DO UPDATE SET
          reason = EXCLUDED.reason, quarantine_start = NOW(),
          quarantine_end = NOW() + INTERVAL '60 days',
          reactivated = false, reactivated_at = NULL,
          manual_override = true, manual_override_at = NOW(),
          observation_start = EXCLUDED.observation_start,
          observation_end = EXCLUDED.observation_end,
          observation_clicks = EXCLUDED.observation_clicks,
          observation_orders = EXCLUDED.observation_orders`,
        [tenant.id, g.sku, `rete-only bocciato dopo ${GIORNI_OSSERVAZIONE}gg: ${perche}`,
         g.activated_at, g.osservazione_end, g.click, g.pezzi]);
    }

    // Verifica di atterraggio: i veti scartano in silenzio.
    const { rows: [land] } = await client.query(`
      SELECT COUNT(*)::int n FROM feed_actions
      WHERE tenant_id = $1 AND action_source = 'pulizia_rete_only' AND action = 'REMOVE'
        AND computed_at >= NOW() - INTERVAL '10 minutes'`, [tenant.id]);

    await client.query('COMMIT');
    return { n: giudizi.length, promossi: promossi.length, bocciati: bocciati.length,
      remVetati, tagliati: land.n, spesaBocciati: somma(bocciati, 'spesa_prima_30g') };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[ReteOnly] fase B ${tenant.name} err:`, e.message);
    return null;
  } finally { client.release(); }
}

function somma(rows, campo = 'spesa30') {
  return Math.round(rows.reduce((a, r) => a + parseFloat(r[campo] || 0), 0) * 100) / 100;
}

async function runReteOnlyLoop({ dry = false, soloTenant = null } = {}) {
  const capBucket   = await getCfg('rete_only_bucket_cap_eur', 60);
  const incidenzaMax = await getCfg('rete_only_incidenza_max', 8);
  const { rows: tenants } = await pool.query(
    `SELECT id, name FROM tenants WHERE status = 'active' AND name = ANY($1)
       ${soloTenant ? 'AND name = $2' : ''} ORDER BY name`,
    soloTenant ? [TENANT_OPERATIONAL, soloTenant] : [TENANT_OPERATIONAL]);

  const esiti = [];
  for (const t of tenants) {
    const cpc = await getTenantCpcGross(t.id);
    // Fail-closed: senza ordini freschi non si condanna nessuno.
    const fr = await ordiniFreschi(t.id);
    if (!fr.ok) {
      console.log(`[ReteOnly]${dry ? ' DRY' : ''} ${t.name} — SALTATO: orders_sync vecchio di ${fr.ore == null ? 'MAI' : fr.ore.toFixed(1) + 'h'} (max ${ORE_MAX_SYNC_ORDINI}h)`);
      esiti.push({ tenant: t.name, saltato: true, ore: fr.ore });
      continue;
    }
    // Prima il verdetto (chiude i conti aperti), poi il bivio (ne apre di nuovi).
    const b = await faseB(t, cpc, incidenzaMax, dry);
    const a = await faseA(t, cpc, capBucket, dry);
    if (!a && !b) continue;
    esiti.push({ tenant: t.name, a, b });
    const pa = a ? `bivio: ${a.cand} candidati, ${a.pc}/${a.pcChiesti ?? a.pc} PC (${a.spesaPc} EUR), ${a.rem}/${a.remChiesti ?? a.rem} REMOVE (${a.spesaRem} EUR), ${a.aperte} in osservazione` : 'bivio: errore';
    const pb = b && b.n ? ` | verdetto: ${b.n} scaduti, ${b.promossi} promossi, ${b.bocciati} bocciati (${b.spesaBocciati} EUR)` : '';
    console.log(`[ReteOnly]${dry ? ' DRY' : ''} ${t.name} — ${pa}${pb}`);
  }

  if (!dry) {
    const tot = esiti.reduce((acc, e) => ({
      pc:  acc.pc  + (e.a?.pc  || 0),
      rem: acc.rem + (e.a?.rem || 0),
      pro: acc.pro + (e.b?.promossi || 0),
      boc: acc.boc + (e.b?.bocciati || 0),
      eur: acc.eur + (e.a?.spesaRem || 0) + (e.b?.spesaBocciati || 0)
    }), { pc: 0, rem: 0, pro: 0, boc: 0, eur: 0 });
    if (tot.pc || tot.rem || tot.pro || tot.boc) {
      await sendTelegram(
        `🔁 <b>Loop rete-only</b> (vende in rete, non qui)\n` +
        `🎯 Riposizionati con orologio ${GIORNI_OSSERVAZIONE}gg: <b>${tot.pc}</b>\n` +
        `✂️ Staccati subito (nessuno spazio prezzo): <b>${tot.rem}</b>\n` +
        `⚖️ Verdetto: ${tot.pro} promossi, ${tot.boc} bocciati e tagliati\n` +
        `💰 Spesa click tolta: ~${Math.round(tot.eur * 100) / 100} EUR/30gg`
      ).catch(() => {});
    }
  }
  return esiti;
}

function start() {
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(RUN_HOUR_UTC, RUN_MIN_UTC, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      await runReteOnlyLoop();
      schedule();
    }, next - now);
    console.log(`[ReteOnly] armato — prossimo giro ${next.toISOString()} (06:45 IT)`);
  };
  schedule();
}

module.exports = { start, runReteOnlyLoop };
