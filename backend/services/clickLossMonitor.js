/**
 * 🔍 CLICK LOSS MONITOR (idea capo 12/7/2026)
 *
 * "Dimmi perché SKU venduti con frequenza bassa, media e alta hanno smesso
 *  di ricevere click." — Il fatturato non muore quando un prodotto smette di
 * vendere: muore quando smette di RICEVERE TRAFFICO. Questo monitor giornaliero
 * prende chi VENDE (ordini 90g) e ha perso i click (settimana vs settimana)
 * e ne DIAGNOSTICA la causa, in ordine di priorità:
 *   1. fuori dal feed (oblio / quarantena / REMOVE / killer / civetta FB=0)
 *   2. senza prezzo regola FB (sell_price=0 — caso FAROS 12/7)
 *   3. senza stock
 *   4. prezzo NOSTRO salito (storia slice 14g, +3%+)
 *   5. posizione persa (storia slice 14g, -3 posizioni o peggio)
 *   6. invisibile allo scraper (nessun dato recente: slide non misurabile)
 *   7. da indagare
 *
 * Classi di frequenza vendita (ordini 90g): alta >=10, media 3-9, bassa 1-2.
 * Output: Telegram con il quadro per classe/causa + top esempi.
 * Orario: 08:40 Italia (dopo i sync del mattino).
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const DIAG_SQL = `
WITH merchant_map AS (
  SELECT * FROM (VALUES
    ('SubitoFarma','subitofarma'), ('Farmacia San Vito','san vito'), ('MPF','personal farma'),
    ('Papa','farmacia papa'), ('Farmacia Procaccini','procaccini'), ('Farmacri','farmacri'),
    ('Farmainsieme','farmainsieme'), ('Farmacia Mandanici','mandanici'),
    ('Farmacia Ospedale','ospedale'), ('Farmastelia','farmastelia')) m(tenant_name, rx)),
vendite AS (
  SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) ord90
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  WHERE o.order_date >= NOW() - INTERVAL '90 days'
    AND o.order_status NOT IN ('canceled','closed','pending_payment')
  GROUP BY 1, 2),
click_a AS (
  SELECT z.tenant_id, z.product_code, SUM(z.clicks) c
  FROM zombie_clicks z
  WHERE z.fetch_date BETWEEN (NOW() AT TIME ZONE 'Europe/Rome')::date - 14
                         AND (NOW() AT TIME ZONE 'Europe/Rome')::date - 8
  GROUP BY 1, 2),
click_b AS (
  SELECT z.tenant_id, z.product_code, SUM(z.clicks) c
  FROM zombie_clicks z
  WHERE z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 7
  GROUP BY 1, 2),
persi AS (
  SELECT v.tenant_id, v.sku, v.ord90, ca.c click_prima, COALESCE(cb.c, 0) click_dopo,
    CASE WHEN v.ord90 >= 10 THEN 'alta' WHEN v.ord90 >= 3 THEN 'media' ELSE 'bassa' END freq
  FROM vendite v
  JOIN click_a ca ON ca.tenant_id = v.tenant_id AND ca.product_code = v.sku
  LEFT JOIN click_b cb ON cb.tenant_id = v.tenant_id AND cb.product_code = v.sku
  WHERE ca.c >= 5 AND COALESCE(cb.c, 0) <= GREATEST(1, ca.c * 0.2)),
storia AS (
  SELECT mm.tenant_name, h.product_code,
    (ARRAY_AGG(h.position ORDER BY h.slice_ts ASC))[1] pos_prima,
    (ARRAY_AGG(h.position ORDER BY h.slice_ts DESC))[1] pos_ultima,
    (ARRAY_AGG(h.base_price ORDER BY h.slice_ts ASC))[1] px_prima,
    (ARRAY_AGG(h.base_price ORDER BY h.slice_ts DESC))[1] px_ultimo
  FROM scraper_position_history h
  JOIN merchant_map mm ON h.merchant ~* mm.rx
  GROUP BY 1, 2)
SELECT t.name tenant, pe.sku, LEFT(p.product_name, 26) nome, pe.freq, pe.ord90,
  pe.click_prima, pe.click_dopo,
  CASE
    -- PRIMA lo stock/prezzo (correzione capo 12/7, caso DERMAFRESH): un
    -- prodotto senza giacenza viene spento da FB (civetta=0, prezzo=0)
    -- CORRETTAMENTE — non è un caso da pannello, rientra da solo al restock
    WHEN (COALESCE(p.erp_stock, 0) + COALESCE(p.supplier_stock, 0)) = 0
      THEN 'SENZA STOCK (FB lo spegne, auto-rientro al restock)'
    WHEN COALESCE(p.sell_price, 0) = 0 THEN 'SENZA PREZZO REGOLA FB (con stock: caso pannello)'
    WHEN EXISTS (SELECT 1 FROM cross_tenant_oblio o WHERE o.sku = pe.sku AND o.status = 'active')
      THEN 'FUORI FEED: oblio'
    WHEN EXISTS (SELECT 1 FROM feed_quarantine fq WHERE fq.tenant_id = pe.tenant_id AND fq.sku = pe.sku AND fq.reactivated = false)
      THEN 'FUORI FEED: quarantena'
    WHEN EXISTS (SELECT 1 FROM feed_actions fa WHERE fa.tenant_id = pe.tenant_id AND fa.sku = pe.sku AND fa.action = 'REMOVE')
      THEN 'FUORI FEED: REMOVE'
    WHEN EXISTS (SELECT 1 FROM feed_killers fk WHERE fk.tenant_id = pe.tenant_id AND fk.sku = pe.sku AND fk.is_active)
      THEN 'FUORI FEED: killer'
    WHEN NOT (tc.config_value::jsonb->'codes') ? pe.sku
      THEN 'FUORI FEED: ' || CASE WHEN p.is_civetta THEN 'filtri' ELSE 'civetta FB=0' END
    -- FANTASMA TP (calibrazione capo 12/7, caso RESTAX EFFLUVIUM): nel nostro
    -- CSV + civetta FB + il listing viene scrappato MA il nostro merchant non
    -- c'è = sparisce tra FB e TP. Item da pannello, non da prezzo.
    WHEN EXISTS (SELECT 1 FROM scraper_competitors scf
                 WHERE scf.product_code = pe.sku
                   AND scf.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '48 hours')
     AND NOT EXISTS (SELECT 1 FROM scraper_competitors scn
                     JOIN merchant_map mm2 ON scn.merchant ~* mm2.rx AND mm2.tenant_name = t.name
                     WHERE scn.product_code = pe.sku
                       AND scn.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '48 hours')
      THEN 'FANTASMA TP (listing scrappato, noi assenti)'
    WHEN s.px_ultimo > s.px_prima * 1.03
      THEN 'PREZZO SALITO ' || s.px_prima || '->' || s.px_ultimo
    WHEN s.pos_ultima >= s.pos_prima + 3
      THEN 'POSIZIONE PERSA ' || s.pos_prima || '->' || s.pos_ultima
    WHEN s.product_code IS NULL THEN 'INVISIBILE ALLO SCRAPER (14g)'
    -- DOMANDA EVAPORATA (caso VULNAMIN 12/7: 1° posto CONFERMATO a mano dal
    -- capo, zero click): la posizione c'è, sono le ricerche a essere morte
    WHEN s.pos_ultima <= 5 THEN 'POSIZIONE OK (' || s.pos_ultima || '), DOMANDA GIU'
    ELSE 'DA INDAGARE (pos ' || COALESCE(s.pos_ultima::text, '?') || ')'
  END diagnosi
FROM persi pe
JOIN tenants t ON t.id = pe.tenant_id
JOIN products p ON p.tenant_id = pe.tenant_id AND p.sku = pe.sku
LEFT JOIN tenant_configs tc ON tc.tenant_id = pe.tenant_id AND tc.config_key = 'stable_feed_codes'
LEFT JOIN storia s ON s.tenant_name = t.name AND s.product_code = pe.sku
ORDER BY pe.freq, pe.ord90 DESC, pe.click_prima DESC`;

async function runClickLossMonitor({ notify = true } = {}) {
  const { rows } = await pool.query(DIAG_SQL);
  if (rows.length === 0) {
    console.log('[ClickLoss] nessun venduto ha perso click — ottimo');
    return [];
  }

  // Quadro per classe/causa
  const quadro = {};
  for (const r of rows) {
    const causa = r.diagnosi.split(':')[0].split(' 0')[0];
    quadro[r.freq] = quadro[r.freq] || {};
    quadro[r.freq][causa] = (quadro[r.freq][causa] || 0) + 1;
  }
  console.log('[ClickLoss]', JSON.stringify(quadro));

  if (notify) {
    let msg = `🔍 <b>VENDUTI CHE HANNO PERSO I CLICK</b> (sett. vs sett.)\n`;
    for (const freq of ['alta', 'media', 'bassa']) {
      if (!quadro[freq]) continue;
      const tot = Object.values(quadro[freq]).reduce((a, b) => a + b, 0);
      msg += `\n<b>Frequenza ${freq}</b> (${tot}): `;
      msg += Object.entries(quadro[freq]).sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c} ${n}`).join(' | ');
    }
    const esempi = rows.filter(r => r.freq === 'alta').slice(0, 5);
    if (esempi.length) {
      msg += `\n\nTop frequenza alta:\n` + esempi.map(r =>
        `${r.tenant.replace('Farmacia ', '')} ${r.sku} (${r.ord90} ord): ${r.diagnosi}`).join('\n');
    }
    try {
      await sendTelegram(msg, { key: 'click_loss', parseMode: 'HTML', throttleMs: 12 * 3600 * 1000 });
    } catch {}
  }
  return rows;
}

let started = false;
function startClickLossMonitor() {
  if (started) return;
  started = true;
  const schedule = () => {
    const now = new Date();
    const italyStr = now.toLocaleString('en-US', { timeZone: 'Europe/Rome' });
    const italy = new Date(italyStr);
    const next = new Date(italy);
    next.setHours(8, 40, 0, 0);
    if (italy >= next) next.setDate(next.getDate() + 1);
    const ms = next - italy;
    setTimeout(() => {
      runClickLossMonitor().catch(e => console.error('[ClickLoss] err:', e.message));
      setInterval(() => {
        runClickLossMonitor().catch(e => console.error('[ClickLoss] err:', e.message));
      }, 24 * 60 * 60 * 1000);
    }, ms);
    console.log(`[ClickLoss] 🔍 monitor venduti-senza-click attivo — ogni giorno 08:40 Italia (primo giro tra ${Math.round(ms / 60000)}min)`);
  };
  schedule();
}

module.exports = { runClickLossMonitor, startClickLossMonitor };
