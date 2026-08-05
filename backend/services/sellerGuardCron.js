/**
 * 🛡️ GUARDIA VENDITORI (nata 18/7 dalla domanda del capo:
 * "perché non te ne sei accorto da solo?")
 *
 * Le guardie esistenti sorvegliano il DANNO (spesa su, fatturato giù, click
 * giù). Nessuna sorvegliava il FATTURATO MANCANTE: le malattie lente che
 * erodono la conversione senza far scattare soglie da crollo. Diagnosi MPF
 * 18/7: 13 venditori fantasma (€2.634/30g), top seller sopra il best,
 * stock-out silenziosi — trovate solo su richiesta del capo.
 *
 * Ogni mattina 05:10 UTC (07:10 IT), per ogni tenant operational, visita i
 * TOP SELLER (rev 30g >= 80€, ordini reali Magento whitelist):
 *
 *  1. 👻 FANTASMA TP: click 7g = 0 con click >= 5 nelle 2 settimane prima,
 *     presente nel CSV (feed_membership), stock disponibile. TP non ci
 *     espone più = fatturato che si spegne in silenzio. → Telegram (dossier
 *     pannello TP, non risolvibile dal nostro lato).
 *
 *  2. 💶 SOPRA-BEST: prezzo vivo > best competitor ESTERNO fresco (<=48h)
 *     + margine. Se il cut a best-0.01 regge il floor (costo_vero ×
 *     (1+floor tenant/fascia)) e il perimetro is_price_cut_allowed →
 *     PC AUTOMATICO (source 'pulizia_seller_guard', classe preservata).
 *     Regola aurea rispettata: solo cut, mai rialzi (L1 vigila comunque).
 *
 *  3. 📦 STOCK-OUT TOTALE: erp+supplier = 0 su un venditore → lista
 *     riassortimento (integra winnerStockAlert che copre solo lo stock
 *     in esaurimento con backup debole).
 *
 * Solo il punto 2 agisce (direzione cut, mai narrowing); 1 e 3 segnalano.
 * Tutto firmato arbitro 'seller_guard'.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const TENANT_OPERATIONAL = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF',
  'Farmainsieme', 'Farmastelia', 'Farmacia Mandanici'];
const MIN_REV30 = 80;
const MAX_PC_PER_TENANT = 40;
const RUN_HOUR_UTC = 5;
const RUN_MIN_UTC = 10;

async function runSellerGuard() {
  const client = await pool.connect();
  try {
    await client.query(`SELECT set_config('xhp.writer', 'seller_guard', true),
      set_config('xhp.motivo', 'guardia venditori: fatturato mancante (fantasmi TP / sopra-best / stock-out) sui top seller', true)`);

    const { rows } = await client.query(`
      WITH op AS (
        SELECT t.id, t.name,
          COALESCE((SELECT hc.config_value::numeric FROM health_config hc
                    WHERE hc.tenant_id=t.id AND hc.config_key='ricarico_floor_pct'), -1) floor_cfg
        FROM tenants t WHERE t.status='active' AND t.name = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM health_config hcx WHERE hcx.tenant_id=t.id AND hcx.config_key='tp_budget_exhausted' AND hcx.config_value='1' AND (hcx.expires_at IS NULL OR hcx.expires_at > NOW()))),
      sellers AS (
        SELECT o.tenant_id, oi.sku, SUM(oi.row_total_incl_tax) rev30
        FROM orders o JOIN order_items oi ON oi.order_id=o.id
        WHERE o.tenant_id IN (SELECT id FROM op) AND o.order_date>=NOW()-INTERVAL '30 days'
          AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
        GROUP BY 1,2 HAVING SUM(oi.row_total_incl_tax) >= $2),
      ck AS (
        SELECT z.tenant_id, z.product_code sku,
          SUM(z.clicks) FILTER (WHERE z.fetch_date>=CURRENT_DATE-7) c7,
          SUM(z.clicks) FILTER (WHERE z.fetch_date>=CURRENT_DATE-21 AND z.fetch_date<CURRENT_DATE-7) c14prec
        FROM zombie_clicks z WHERE z.tenant_id IN (SELECT id FROM op)
          AND z.fetch_date>=CURRENT_DATE-21 GROUP BY 1,2),
      fresco AS (
        SELECT sc.product_code, MIN(sc.base_price) FILTER (WHERE sc.merchant !~*
          'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia') p1
        FROM scraper_competitors sc
        WHERE sc.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '48 hours'
          AND sc.base_price > 0 AND sc.product_code IN (SELECT sku FROM sellers)
        GROUP BY 1)
      SELECT op.name tenant, op.id tid, s.sku, s.rev30,
        LEFT(p.product_name, 30) nome,
        COALESCE(ck.c7,0) c7, COALESCE(ck.c14prec,0) c14prec,
        COALESCE(p.erp_stock,0)+COALESCE(p.supplier_stock,0) disp,
        COALESCE(NULLIF(p.applied_price,0), NULLIF(p.exported_price,0), p.sell_price) vivo,
        f.p1, ROUND((f.p1-0.01)::numeric,2) target,
        -- floor ALLINEATO all'igiene (feedHygieneCycle): stessa base GREATEST e
        -- stesso default 15 — altrimenti l'igiene delle 06:00 annulla i PC delle 07:10
        GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
                 CASE WHEN COALESCE(p.erp_stock,0)>0 THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END) costo,
        CASE WHEN op.floor_cfg > 0 THEN op.floor_cfg
             WHEN COALESCE(NULLIF(p.applied_price,0),p.sell_price) < 10 THEN 18
             ELSE 15 END floorpct,
        (EXISTS(SELECT 1 FROM feed_membership fm WHERE fm.tenant_id=op.id AND fm.sku=s.sku)) in_csv,
        (EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=op.id AND q.sku=s.sku AND q.reactivated=false)) in_dieta,
        is_brand_protected(op.id, s.sku) brandp,
        is_price_cut_allowed(op.id, s.sku) pc_ok,
        p.saleable
      FROM sellers s JOIN op ON op.id=s.tenant_id
      JOIN products p ON p.tenant_id=s.tenant_id AND p.sku=s.sku
      LEFT JOIN ck ON ck.tenant_id=s.tenant_id AND ck.sku=s.sku
      LEFT JOIN fresco f ON f.product_code=s.sku`,
      [TENANT_OPERATIONAL, MIN_REV30]);

    const perTenant = {};
    for (const r of rows) {
      const t = perTenant[r.tenant] = perTenant[r.tenant] || { fantasmi: [], sopraBest: [], stockout: [], tid: r.tid };
      const rev = parseFloat(r.rev30);
      if (parseInt(r.c7) === 0 && parseInt(r.c14prec) >= 5 && r.in_csv && parseFloat(r.disp) > 0)
        t.fantasmi.push({ sku: r.sku, nome: r.nome, rev });
      if (parseFloat(r.disp) === 0)
        t.stockout.push({ sku: r.sku, nome: r.nome, rev });
      const vivo = parseFloat(r.vivo), target = parseFloat(r.target), costo = parseFloat(r.costo);
      if (r.p1 && costo > 0.5 && target < vivo - 0.01 && !r.brandp && r.pc_ok && r.saleable
          && !r.in_dieta   // niente PC su SKU in dieta (churn inutile con i loop taglio)
          && (target - costo) / costo * 100 >= parseFloat(r.floorpct))
        t.sopraBest.push({ sku: r.sku, nome: r.nome, rev, vivo, target,
          ric: Math.round((target - costo) / costo * 100) });
    }

    // 2) PC automatici sui sopra-best (cap per tenant, i più grossi prima)
    let pcTot = 0;
    for (const [name, t] of Object.entries(perTenant)) {
      const lot = t.sopraBest.sort((a, b) => b.rev - a.rev).slice(0, MAX_PC_PER_TENANT);
      for (const x of lot) {
        await client.query(`
          INSERT INTO feed_actions (tenant_id, sku, action, action_source, action_reason,
            current_price, recommended_price, price_cut_pct, computed_at, expires_at, status)
          VALUES ($1, $2, 'PRICE_CUT', 'pulizia_seller_guard',
            'guardia venditori: top seller sopra il best, PC a best-0.01 (ricarico '||($5::int)||'%)',
            $3::numeric, $4::numeric,
            ROUND(($3::numeric - $4::numeric)/NULLIF($3::numeric,0)*100,1),
            NOW(), NOW()+INTERVAL '7 days', 'active')
          ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
            action='PRICE_CUT', action_source='pulizia_seller_guard',
            action_reason=EXCLUDED.action_reason, current_price=EXCLUDED.current_price,
            recommended_price=EXCLUDED.recommended_price, price_cut_pct=EXCLUDED.price_cut_pct,
            computed_at=NOW(), expires_at=NOW()+INTERVAL '7 days', status='active'
          -- ARBITRO: mai sovrascrivere il lavoro di sessione/capo (autosabotaggio)
          WHERE feed_actions.action_source IS NULL
             OR (feed_actions.action_source NOT IN ('muro_scavalco','manual_pepita','manual','capo_pin')
                 AND feed_actions.action_source NOT LIKE 'sessione%')
          `, [t.tid, x.sku, x.vivo, x.target, x.ric]).catch(e =>
            console.warn(`[SellerGuard] PC ${name}/${x.sku} saltato: ${e.message}`));
        pcTot++;
      }
      t.pcApplied = lot.length;
    }

    // 3) report
    const parts = [];
    for (const [name, t] of Object.entries(perTenant)) {
      if (!t.fantasmi.length && !t.stockout.length && !t.pcApplied) continue;
      const f = t.fantasmi.reduce((s, x) => s + x.rev, 0);
      const so = t.stockout.reduce((s, x) => s + x.rev, 0);
      parts.push(`<b>${name}</b>: 👻 ${t.fantasmi.length} fantasmi (€${Math.round(f)}/30g)` +
        ` | 💶 ${t.pcApplied} PC auto | 📦 ${t.stockout.length} stockout (€${Math.round(so)}/30g)`);
    }
    const summary = parts.join('\n') || 'tutto pulito';
    console.log(`[SellerGuard] ${summary.replace(/<[^>]+>/g, '')}`);
    if (parts.length) {
      try { await sendTelegram(`🛡️ <b>Guardia Venditori</b>\n${summary}`); } catch (_) {}
    }
    return perTenant;
  } finally {
    client.release();
  }
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    RUN_HOUR_UTC, RUN_MIN_UTC, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function startSellerGuardCron() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[SellerGuard] prossimo run tra ${Math.round(delay / 60000)} min (05:10 UTC / 07:10 IT)`);
    setTimeout(async () => {
      try { await runSellerGuard(); } catch (e) { console.error('[SellerGuard] ERRORE:', e.message); }
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startSellerGuardCron, runSellerGuard };
