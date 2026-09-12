/**
 * Sales Anomaly Monitor (direttiva utente 5/7/2026)
 *
 * "monitor per valutare l'andamento giornaliero delle vendite... se vediamo
 *  anomalie tra fatturato e spesa per gli operational interveniamo. Ogni 2h."
 *
 * Ogni 2h, tenant con health_config sales_monitor='on':
 *  A) INTRADAY: ordini di oggi alla stessa ora vs media degli stessi giorni
 *     settimana (3 settimane) alla stessa ora. Drop >50% con volume minimo
 *     e ora >= 10 → alert (multi-evidenza: anche revenue sotto).
 *  B) SPESA vs FATTURATO (ieri, giorno pieno): incidenza ieri > 1.8x la media
 *     7gg O click ieri > +60% con revenue < 90% della media → alert.
 * Anti-rumore: soglie alte, throttle Telegram 6h per tenant, flag
 * tp_budget_exhausted silenzia la parte spesa (budget finito = report vuoto).
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const CPC = 0.3294;

async function runSalesAnomalyMonitor() {
  const { rows: data } = await pool.query(`
    WITH enabled AS (
      SELECT t.id, t.name,
        COALESCE((SELECT hc2.config_value FROM health_config hc2
                  WHERE hc2.tenant_id = t.id AND hc2.config_key = 'tp_budget_exhausted'
                    -- FIX 6/8/2026: la scadenza va onorata come negli altri 5 consumatori
                    -- (mantraLoop, sellerGuard, burnerIncidence, pcDecay, alertMonitor).
                    -- Senza, un flag scaduto silenzia per sempre: Procaccini fuori dal
                    -- monitor dal 21/7 con expires_at 22/7 e 3.942 click in 7 giorni.
                    AND (hc2.expires_at IS NULL OR hc2.expires_at > NOW())), '0') AS budget_out
      FROM tenants t
      JOIN health_config hc ON hc.tenant_id = t.id
        AND hc.config_key = 'sales_monitor' AND hc.config_value = 'on'
      WHERE t.status = 'active'
    ),
    ita AS (SELECT (NOW() AT TIME ZONE 'Europe/Rome') AS now_ita),
    ref_days AS (
      SELECT (SELECT now_ita::date FROM ita) - (7 * s) AS d FROM generate_series(1, 3) s
    ),
    ord_today AS (
      SELECT o.tenant_id, COUNT(DISTINCT o.id) AS ord, COALESCE(SUM(oi.row_total_incl_tax), 0) AS rev
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date = (SELECT now_ita::date FROM ita)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::time <= (SELECT now_ita::time FROM ita)
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY o.tenant_id
    ),
    ord_base AS (
      SELECT o.tenant_id, COUNT(DISTINCT o.id) / 3.0 AS ord, COALESCE(SUM(oi.row_total_incl_tax), 0) / 3.0 AS rev
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date IN (SELECT d FROM ref_days)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::time <= (SELECT now_ita::time FROM ita)
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY o.tenant_id
    ),
    rev_ieri AS (
      SELECT o.tenant_id, COALESCE(SUM(oi.row_total_incl_tax), 0) AS rev
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date = (SELECT now_ita::date FROM ita) - 1
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY o.tenant_id
    ),
    rev_7g AS (
      SELECT o.tenant_id, COALESCE(SUM(oi.row_total_incl_tax), 0) / 7.0 AS rev
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN (SELECT now_ita::date FROM ita) - 8 AND (SELECT now_ita::date FROM ita) - 2
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY o.tenant_id
    ),
    ck_ieri AS (
      SELECT tenant_id, SUM(clicks) AS ck FROM zombie_clicks
      WHERE fetch_date = (SELECT now_ita::date FROM ita) - 1 GROUP BY tenant_id
    ),
    ck_7g AS (
      SELECT tenant_id, SUM(clicks) / 7.0 AS ck FROM zombie_clicks
      WHERE fetch_date BETWEEN (SELECT now_ita::date FROM ita) - 8 AND (SELECT now_ita::date FROM ita) - 2
      GROUP BY tenant_id
    )
    SELECT e.name, e.budget_out,
      COALESCE(ot.ord, 0) AS ord_oggi, ROUND(COALESCE(ot.rev, 0)) AS rev_oggi,
      ROUND(COALESCE(ob.ord, 0), 1) AS ord_base, ROUND(COALESCE(ob.rev, 0)) AS rev_base,
      ROUND(COALESCE(ri.rev, 0)) AS rev_ieri, ROUND(COALESCE(r7.rev, 0)) AS rev_media7,
      COALESCE(ci.ck, 0) AS ck_ieri, ROUND(COALESCE(c7.ck, 0)) AS ck_media7,
      EXTRACT(HOUR FROM (SELECT now_ita FROM ita))::int AS ora_ita
    FROM enabled e
    LEFT JOIN ord_today ot ON ot.tenant_id = e.id
    LEFT JOIN ord_base ob ON ob.tenant_id = e.id
    LEFT JOIN rev_ieri ri ON ri.tenant_id = e.id
    LEFT JOIN rev_7g r7 ON r7.tenant_id = e.id
    LEFT JOIN ck_ieri ci ON ci.tenant_id = e.id
    LEFT JOIN ck_7g c7 ON c7.tenant_id = e.id`);

  const alerts = [];
  for (const r of data) {
    const ora = parseInt(r.ora_ita);
    // A) Drop intraday: multi-evidenza (ordini E revenue), volume minimo, ora >= 10.
    // Silenziato se budget TP esaurito: il calo ordini è atteso (restano solo organici)
    if (r.budget_out !== '1' && ora >= 10 && parseFloat(r.ord_base) >= 6
        && parseInt(r.ord_oggi) < parseFloat(r.ord_base) * 0.5
        && parseFloat(r.rev_oggi) < parseFloat(r.rev_base) * 0.6) {
      alerts.push(`🔴 <b>${r.name}</b> VENDITE IN CALO: ${r.ord_oggi} ordini a quest'ora vs ${r.ord_base} attesi (stesso giorno sett. prec.) | €${r.rev_oggi} vs €${r.rev_base}`);
    }
    // A2) SILENZIO ASSOLUTO (lezione MPF 9/7: buco ordini 23:38→10:00 mai
    // segnalato perché sotto le soglie standard): zero ordini con attesi >=4
    // è statisticamente quasi impossibile → allarme già dalle 8, canale
    // dedicato. Con 0 ordini la multi-evidenza è implicita (rev = 0).
    if (r.budget_out !== '1' && ora >= 8 && parseInt(r.ord_oggi) === 0
        && parseFloat(r.ord_base) >= 4) {
      alerts.push(`🚨 <b>${r.name}</b> SILENZIO ASSOLUTO: 0 ordini oggi vs ${r.ord_base} attesi a quest'ora — verificare checkout/pagamenti SUBITO`);
    }
    // B) Spesa vs fatturato (ieri, giorno pieno) — silenziata se budget esaurito
    if (r.budget_out !== '1' && parseInt(r.ck_ieri) > 0) {
      const costoIeri = parseInt(r.ck_ieri) * CPC;
      const costoMedia = parseFloat(r.ck_media7) * CPC;
      const incIeri = parseFloat(r.rev_ieri) > 0 ? costoIeri / parseFloat(r.rev_ieri) : 99;
      const incMedia = parseFloat(r.rev_media7) > 0 ? costoMedia / parseFloat(r.rev_media7) : 0;
      if (costoIeri > 40 && incMedia > 0 && incIeri > incMedia * 1.8) {
        alerts.push(`🟠 <b>${r.name}</b> INCIDENZA ANOMALA ieri: ${(incIeri * 100).toFixed(1)}% vs media ${(incMedia * 100).toFixed(1)}% (spesa €${Math.round(costoIeri)}, rev €${r.rev_ieri})`);
      } else if (parseInt(r.ck_ieri) > parseFloat(r.ck_media7) * 1.6
                 && parseFloat(r.rev_ieri) < parseFloat(r.rev_media7) * 0.9
                 && costoIeri > 40) {
        alerts.push(`🟠 <b>${r.name}</b> SPESA SU SENZA RESA ieri: ${r.ck_ieri} click vs ${r.ck_media7} media (rev €${r.rev_ieri} vs €${r.rev_media7} media)`);
      }
    }
  }

  // C) FRESCHEZZA PREZZI/COSTI (allarme rosso 9/7 + direttiva 11/7: 'la
  // sirena non deve essere solo un alert, deve far scattare l'aggiornamento').
  // SLA 6h: se un tenant è stantio → AUTO-SYNC IMMEDIATO + alert che lo dice.
  try {
    const { rows: stale } = await pool.query(`
      SELECT t.id, t.name, COUNT(*) AS n
      FROM products p JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
      WHERE p.is_civetta = true AND p.updated_at < NOW() - INTERVAL '6 hours'
      GROUP BY t.id, t.name HAVING COUNT(*) > 500 ORDER BY 3 DESC`);
    for (const s of stale) {
      alerts.push(`🚨 <b>${s.name}</b> DATI STANTII: ${s.n} civetta non aggiornati da oltre 6h — AUTO-SYNC LANCIATO ORA, ricontrollo al prossimo giro`);
      // Auto-guarigione: sync immediato, non solo la campanella
      setImmediate(() => {
        try {
          const { importProducts } = require('./farmaboosterProducts');
          importProducts(s.id).catch(e => console.error(`[SalesAnomaly] auto-sync ${s.name} err:`, e.message));
        } catch (e) { console.error('[SalesAnomaly] auto-sync err:', e.message); }
      });
    }
  } catch (e) {
    console.error('[SalesAnomaly] staleness check err:', e.message);
  }

  // D) VENDITORI ESCLUSI DAL FEED (ultimatum utente 10/7: 'se capita di nuovo
  // ti stacco'). Un prodotto che VENDE fuori dal CSV senza blocco deliberato
  // (quarantena/killer/REMOVE/oblio) = regressione del circolo dell'eco o
  // qualsiasi bug futuro. Tolleranza: ZERO. Sirena immediata.
  try {
    const { rows: esclusi } = await pool.query(`
      WITH csv AS (
        SELECT tc.tenant_id, jsonb_array_elements_text(tc.config_value::jsonb->'codes') AS sku
        FROM tenant_configs tc WHERE tc.config_key = 'stable_feed_codes'),
      venditori AS (
        SELECT p.tenant_id, p.sku FROM products p
        JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
        WHERE COALESCE(p.sales_30d_seller, 0) > 0
          AND (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) > 0
          AND COALESCE(p.sell_price, 0) > 0)
      SELECT t.name, COUNT(*) AS n
      FROM venditori v
      JOIN tenants t ON t.id = v.tenant_id
      WHERE NOT EXISTS (SELECT 1 FROM csv WHERE csv.tenant_id = v.tenant_id AND csv.sku = v.sku)
        AND NOT EXISTS (SELECT 1 FROM feed_quarantine fq WHERE fq.tenant_id = v.tenant_id AND fq.sku = v.sku AND fq.reactivated = false)
        AND NOT EXISTS (SELECT 1 FROM feed_killers fk WHERE fk.tenant_id = v.tenant_id AND fk.sku = v.sku AND fk.is_active)
        AND NOT EXISTS (SELECT 1 FROM feed_actions fa WHERE fa.tenant_id = v.tenant_id AND fa.sku = v.sku AND fa.action = 'REMOVE')
        AND NOT EXISTS (SELECT 1 FROM cross_tenant_oblio o WHERE o.sku = v.sku AND o.status = 'active')
      GROUP BY t.name HAVING COUNT(*) >= 5 ORDER BY 2 DESC`);
    for (const e of esclusi) {
      alerts.push(`🚨 <b>${e.name}</b> VENDITORI FUORI DAL FEED: ${e.n} prodotti che VENDONO sono fuori dal CSV senza blocco deliberato — regressione da investigare SUBITO`);
    }
  } catch (e) {
    console.error('[SalesAnomaly] check venditori esclusi err:', e.message);
  }

  if (alerts.length > 0) {
    // Le emergenze (silenzio assoluto) viaggiano su canale proprio con
    // throttle corto: non devono essere inghiottite dal throttle 6h standard
    const isEmergenza = a => a.includes('SILENZIO ASSOLUTO') || a.includes('DATI STANTII') || a.includes('VENDITORI FUORI DAL FEED');
    const emergenze = alerts.filter(isEmergenza);
    const normali = alerts.filter(a => !isEmergenza(a));
    if (normali.length > 0) {
      const msg = `⚡ <b>Sales Anomaly Monitor</b>\n\n` + normali.join('\n');
      try { await sendTelegram(msg, { key: 'sales_anomaly', parseMode: 'HTML', throttleMs: 6 * 3600 * 1000 }); } catch {}
    }
    if (emergenze.length > 0) {
      try { await sendTelegram(emergenze.join('\n'), { key: 'sales_anomaly_zero', parseMode: 'HTML', throttleMs: 2 * 3600 * 1000 }); } catch {}
    }
  }
  console.log(`[SalesAnomaly] check su ${data.length} tenant, ${alerts.length} anomalie`);
  return { checked: data.length, alerts };
}

let cronStarted = false;

function startSalesAnomalyMonitor() {
  if (cronStarted) return;
  cronStarted = true;
  setTimeout(() => {
    runSalesAnomalyMonitor().catch(e => console.error('[SalesAnomaly] err:', e.message));
    setInterval(() => {
      runSalesAnomalyMonitor().catch(e => console.error('[SalesAnomaly] err:', e.message));
    }, 2 * 60 * 60 * 1000);
  }, 20 * 60 * 1000);
  console.log('[SalesAnomaly] Cron started — ogni 2h, primo run tra 20 min');
}

module.exports = { runSalesAnomalyMonitor, startSalesAnomalyMonitor };
