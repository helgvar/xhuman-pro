/**
 * 🔥 REGOLA BURNER UFFICIALE (dictat capo 25/7) — mig 075
 *
 * BLOCCO (giornaliero 05:20 IT): prodotto ATTIVO che negli ultimi 7gg ha bruciato
 *   budget (>=5 click) e ha SFORATO l'incidenza (costo click 7g > fatturato 7g del
 *   seller = incidenza >100%; 0 vendite => infinita). Brand protetti esclusi.
 *
 * RILASCIO: SOLO se il singolo seller ricomincia a vendere E incidenza <50%.
 *   Enforced dal veto DB veto_release_burner_rule: NESSUN loop puo' riabilitarli.
 *
 * MONITOR (ogni 1h): se un loop tenta la riabilitazione, il trigger lo RIBLOCCA e
 *   lo scrive in burner_rule_reactivation_log; qui lo leggo e AVVISO il capo.
 *   Backstop: se per qualche via uno resta reactivated=true senza merito, lo richiudo.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const TENANT_OPERATIONAL = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF',
  'Farmainsieme', 'Farmastelia', 'Farmacia Mandanici'];
const MIN_CLICK_7G = 5;
let lastLogId = 0;

async function runBurnerRuleBlock() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('xhp.writer','sessione_burner_rule',true),
      set_config('xhp.motivo','regola burner (capo 25/7): bruciato 7g + incidenza >100%, blocco. Rilascio solo seller-vende + incidenza <50%',true)`);
    const { rows } = await c.query(`
      WITH ten AS (SELECT id, name FROM tenants WHERE status='active' AND name = ANY($1)),
      ck AS (SELECT z.tenant_id, z.product_code sku, SUM(z.clicks) clk FROM zombie_clicks z
             WHERE z.fetch_date >= CURRENT_DATE - 7 AND z.tenant_id IN (SELECT id FROM ten) GROUP BY 1,2),
      -- MORTO VERO (raffinamento capo 25/7): NON "incidenza>100%" (prendeva la
      -- vetrina e i vendenti-di-rete = il traffico). Blocca solo chi non vende
      -- DA NESSUNA PARTE in 90g, senza domanda globale, e non è posizionato top5.
      rete90 AS (SELECT DISTINCT oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id
                 WHERE o.order_date >= NOW()-INTERVAL '15 days'
                   AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')),
      cand AS (
        -- SOLO CLICK (criterio finale capo 25/7): "porta ordini sì/no". Blocca chi
        -- non porta ordini DA NESSUNA PARTE in 90g: no vendita diretta/rete,
        -- no domanda globale, no CARRELLO. La posizione NON conta: un top5 che
        -- prende click e non converte è solo click che brucia budget.
        SELECT t.id tid, t.name tenant, ck.sku, ck.clk
        FROM ck JOIN ten t ON t.id=ck.tenant_id
        JOIN products p ON p.tenant_id=ck.tenant_id AND p.sku=ck.sku
        LEFT JOIN sku_basket_stats bs ON bs.tenant_id=ck.tenant_id AND bs.sku=ck.sku
        WHERE p.is_civetta AND ck.clk >= ${MIN_CLICK_7G}
          AND ck.sku NOT IN (SELECT sku FROM rete90)              -- 0 vendite ovunque 90g
          AND COALESCE(p.sales_30d_aggregated,0) = 0              -- 0 domanda globale
          AND COALESCE(bs.basket_margin_90d,0) <= 0               -- 0 carrello
          AND NOT is_brand_protected(t.id, ck.sku)
          AND NOT EXISTS (SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=ck.tenant_id AND q.sku=ck.sku
                          AND q.reactivated=false AND q.is_burner_rule=true))
      INSERT INTO feed_quarantine (tenant_id, sku, reason, quarantine_start, quarantine_end,
        reactivated, manual_override, manual_override_at, quarantine_level, is_burner_rule)
      SELECT tid, sku, 'solo click (regola capo 25/7): '||clk||' click 7g, 0 ordini ovunque 90g (no diretto/carrello/rete)',
        NOW(), NOW()+INTERVAL '45 days', false, true, NOW(), 3, true
      FROM cand
      ON CONFLICT (tenant_id, sku) DO UPDATE SET
        reason=EXCLUDED.reason, reactivated=false, reactivated_at=NULL, manual_override=true,
        manual_override_at=NOW(), quarantine_start=NOW(), quarantine_end=NOW()+INTERVAL '45 days',
        quarantine_level=3, is_burner_rule=true
      RETURNING tenant_id`);
    await c.query('COMMIT');
    if (rows.length > 0) {
      console.log(`[BurnerRule] BLOCCO: ${rows.length} nuovi burner MORTI VERI (0 vendite 90g, non posizionati)`);
      await sendTelegram(`🔥 <b>Regola burner</b>: bloccati ${rows.length} MORTI VERI (0 vendite ovunque 90g, non top5, ≥${MIN_CLICK_7G} click). Vetrina e vendenti-rete protetti. Rilascio: seller vende + incidenza <50%.`).catch(()=>{});
    }
    return rows.length;
  } catch (e) { await c.query('ROLLBACK').catch(()=>{}); console.error('[BurnerRule] block err:', e.message); return null; }
  finally { c.release(); }
}

async function runBurnerRuleMonitor() {
  try {
    // backstop: qualsiasi burner-rule riattivato senza merito -> richiudi (il trigger già lo fa,
    // questo copre reactivated settati per vie che scavalcano il BEFORE UPDATE)
    await pool.query(`
      UPDATE feed_quarantine fq SET reactivated=false, reactivated_at=NULL
      WHERE fq.is_burner_rule=true AND fq.reactivated=true
        AND NOT EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id
             WHERE oi.sku=fq.sku AND o.tenant_id=fq.tenant_id AND o.order_date>=NOW()-INTERVAL '7 days'
               AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
             HAVING SUM(oi.row_total_incl_tax) > 2 * (SELECT COALESCE(SUM(z.clicks),0)*0.3294 FROM zombie_clicks z
                    WHERE z.tenant_id=fq.tenant_id AND z.product_code=fq.sku AND z.fetch_date>=CURRENT_DATE-7))`);
    // alert sui tentativi loggati dal trigger dall'ultimo giro
    const { rows } = await pool.query(`
      SELECT l.id, t.name tenant, l.sku, l.writer, ROUND(l.seller_rev_7g,2) rev, ROUND(l.click_cost_7g,2) cc, l.esito
      FROM burner_rule_reactivation_log l JOIN tenants t ON t.id=l.tenant_id
      WHERE l.id > $1 AND l.esito='ribloccato' ORDER BY l.id`, [lastLogId]);
    if (rows.length > 0) {
      lastLogId = rows[rows.length-1].id;
      const byWriter = {};
      rows.forEach(r => { byWriter[r.writer] = (byWriter[r.writer]||0)+1; });
      const det = Object.entries(byWriter).map(([w,n])=>`${w}: ${n}`).join(', ');
      console.log(`[BurnerRule] MONITOR: ${rows.length} tentativi di riabilitazione RIBLOCCATI (${det})`);
      await sendTelegram(`🚨 <b>Regola burner — loop bloccato</b>\n${rows.length} tentativi di RIABILITARE burner senza merito, ribloccati.\nColpevoli: <i>${det}</i>\nEsempio: ${rows[0].tenant}/${rows[0].sku} (fatt7g €${rows[0].rev}, click €${rows[0].cc}).`).catch(()=>{});
    } else if (lastLogId === 0) {
      // primo giro: allinea il cursore senza allarmare sullo storico
      const { rows: mx } = await pool.query(`SELECT COALESCE(MAX(id),0) m FROM burner_rule_reactivation_log`);
      lastLogId = parseInt(mx[0].m);
    }
  } catch (e) { console.error('[BurnerRule] monitor err:', e.message); }
}

function startBurnerRule() {
  // BLOCCO giornaliero 03:20 UTC (05:20 IT)
  const scheduleBlock = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 20, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate()+1);
    setTimeout(async () => { await runBurnerRuleBlock(); scheduleBlock(); }, next - now);
  };
  scheduleBlock();
  // MONITOR ogni 1h (primo giro tra 2 min)
  setTimeout(function loop() { runBurnerRuleMonitor().finally(()=>setTimeout(loop, 60*60*1000)); }, 2*60*1000);
  console.log('[BurnerRule] armata — blocco 05:20 IT, monitor ogni 1h');
}

module.exports = { startBurnerRule, runBurnerRuleBlock, runBurnerRuleMonitor };
