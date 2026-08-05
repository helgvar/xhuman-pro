/**
 * Pareto Positioner AI (direttiva utente 11/7/2026)
 *
 * "Guardare la regola di Pareto e migliorare dove possibile il posizionamento
 * del ~24% di prodotti che fa l'80% del fatturato — e qui mettici l'AI."
 *
 * Ogni mattina (09:05): per ogni tenant prende i prodotti del Pareto-set
 * (80% revenue 30g) che sono SALVA BILANCIO (unica classe azionabile per
 * regola aurea) e NON in podio, e chiede a Opus la decisione per ciascuno:
 * taglio a X (dentro [floor fascia, prezzo regola - 0,01]) o lasciare.
 *
 * Contesto dato all'AI: posizione attuale, banda d'oro (positionEconomics),
 * best esterno fresco, muro (venditori fotocopia), costo vero, venduto/rev.
 * Paletti DURI post-AI (clamp) + i trigger DB come rete finale:
 * mai muri, mai sopra regola-0,01, mai sotto costo×fascia, solo CUT.
 */

const { pool } = require('../db/pool');
const { sendTelegram, fmtEur } = require('./telegramNotifier');

const CAP_PER_TENANT = 150;
const RETE_RX = 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia';

const SYSTEM_PROMPT = `Sei il calibratore posizionamento di una rete di farmacie online su Trovaprezzi.
Per ogni prodotto ricevi: pos (posizione attuale), banda_oro (fascia storicamente migliore per margine*vendite: 1|2-3|4-6|7-10|>10 o null),
scala (i 4 prezzi esterni piu bassi, dal 1o al 4o), regola (prezzo della regola Farmabooster), floor (minimo invalicabile),
muro (true se >=3 venditori entro 1 centesimo dal best), ord (ordini 30g), rev (fatturato 30g).
Decidi per ciascuno: {"sku":"...","cut":<prezzo|null>}.
FILOSOFIA (dal capo): VISIBILITA SANA, non correre alla prima se tira troppo la corda.
Prova la SCALA dall'alto: target pos1 = scala[0]-0.01; se sotto floor prova pos2 = scala[1]-0.01;
poi pos3 = scala[2]-0.01; poi pos4 = scala[3]-0.01. Prendi la POSIZIONE PIU ALTA che resta >= floor.
Se nemmeno la 4a e raggiungibile ma il floor chiude comunque un gap >2% dal prezzo attuale: cutta al floor. Altrimenti null.
REGOLE FERREE:
- MAI cut se muro=true: cut=null (comprare un muro intero costa margine per nulla).
- MAI sotto floor, MAI sopra regola - 0.01.
- Rispetta banda_oro: se la banda migliore e '4-6' non comprare il podio — il target giusto e ENTRARE nella banda.
- Prodotti con ord alti gia in pos <= 3: cut=null (non toccare chi vince).
Rispondi SOLO array JSON: [{"sku":"...","cut":12.34|null}, ...]`;

// Fable 5 (richiesta capo 11/7): il giudizio fine su scala/banda d'oro merita
// il tier massimo. Fallback automatico su Opus 4.8 se: modello non abilitato,
// oppure TOKEN/QUOTA GIORNALIERI esauriti (rate limit) — in tal caso Opus fa
// il resto della giornata e il giorno dopo si ritenta Fable (reset quotidiano).
let modelloAttivo = 'claude-fable-5';
let giornoFallback = null;

async function decideBatch(client, payload) {
  const oggi = new Date().toISOString().slice(0, 10);
  if (giornoFallback && giornoFallback !== oggi) {
    modelloAttivo = 'claude-fable-5';
    giornoFallback = null;
    console.log('[ParetoAI] nuovo giorno → ritento claude-fable-5');
  }
  let resp;
  try {
    resp = await client.messages.create({
      model: modelloAttivo,
      // 8000: il cap non costa se non usato, ma un cap stretto tronca il JSON
      // a metà array (i parse-error di Ospedale/Procaccini dell'11/7)
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
  } catch (e) {
    const fallbackabile = /model|not_found|permission|rate.?limit|429|overloaded|529|quota|credit|insufficient|exceeded/i.test(e.message);
    if (modelloAttivo !== 'claude-opus-4-8' && fallbackabile) {
      console.log(`[ParetoAI] ${modelloAttivo} esaurito/non disponibile (${e.message.slice(0, 60)}) → Opus per oggi`);
      modelloAttivo = 'claude-opus-4-8';
      giornoFallback = oggi;
      return decideBatch(client, payload);
    }
    throw e;
  }
  const text = resp.content?.[0]?.text || '[]';
  // Parser robusto (fix 11/7: Ospedale/Procaccini persi per testo attorno al JSON):
  // 1) parse diretto, 2) primo array bilanciato, 3) batch scartato con log
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('[');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '[') depth++;
      if (text[i] === ']') { depth--; if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      } }
    }
  }
  console.error('[ParetoAI] batch scartato: risposta non parsabile:', text.slice(0, 120));
  return [];
}

async function runParetoPositioner() {
  const { isScraperOptimizationPaused } = require('./scraperPause');
  if (await isScraperOptimizationPaused()) {
    console.log('[ParetoAI] PAUSA scraper-optimization (ordine capo 11/7) — skip ciclo');
    return;
  }
  const { getGlobal } = require('./globalConfig');
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  const key = await getGlobal('claude_api_key');
  if (!key) { console.error('[ParetoAI] claude_api_key mancante'); return; }
  const client = new Anthropic({ apiKey: key });

  const { rows: tenants } = await pool.query(
    "SELECT id, name FROM tenants WHERE status='active' ORDER BY name");
  const report = [];

  for (const t of tenants) {
    try {
      const { rows: cand } = await pool.query(`
        WITH rev AS (
          SELECT oi.sku, SUM(oi.row_total_incl_tax) rev, COUNT(DISTINCT o.id) ord
          FROM order_items oi JOIN orders o ON o.id=oi.order_id
          WHERE o.tenant_id = $1 AND o.order_date >= NOW()-INTERVAL '15 days'
            AND o.order_status NOT IN ('canceled','closed')
          GROUP BY 1),
        ranked AS (
          SELECT r.*, SUM(r.rev) OVER (ORDER BY r.rev DESC) / NULLIF(SUM(r.rev) OVER (),0) cum
          FROM rev r),
        pareto AS (SELECT * FROM ranked WHERE cum <= 0.80),
        -- FIX perf (25/7): il vecchio 'best' aveva una subquery CORRELATA per-riga
        -- (MIN su scraper_competitors 4GB per ogni riga) -> 383M cost, 59 min.
        -- Ora: filtro esterni UNA volta, ristretto ai soli SKU Pareto, minimo
        -- per prodotto in un solo passaggio (niente subplan).
        ext AS (
          SELECT sc.product_code, sc.base_price
          FROM scraper_competitors sc
          WHERE sc.scraped_at >= NOW()-INTERVAL '30 hours' AND sc.base_price > 0
            AND sc.merchant !~* $2
            AND sc.product_code IN (SELECT sku FROM pareto)),
        mins AS (SELECT product_code, MIN(base_price) mn FROM ext GROUP BY 1),
        best AS (
          SELECT e.product_code,
            MIN(e.base_price) best_est,
            (ARRAY_AGG(e.base_price ORDER BY e.base_price))[1:4] scala,
            COUNT(*) FILTER (WHERE e.base_price <= m.mn + 0.01) n_al_best
          FROM ext e JOIN mins m ON m.product_code = e.product_code
          GROUP BY e.product_code)
        SELECT pa.sku, pa.ord, ROUND(pa.rev) rev,
          h.scraper_position pos, pe.best_band banda,
          b.best_est, b.scala, b.n_al_best,
          p.sell_price regola,
          ROUND((GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
            CASE WHEN COALESCE(p.erp_stock,0)>0 THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END)
            * CASE WHEN $3 = 'SubitoFarma' THEN 1.11 ELSE 1.15 END)::numeric, 2) floor_px
        FROM pareto pa
        JOIN products p ON p.tenant_id=$1 AND p.sku=pa.sku
        LEFT JOIN product_health_scores h ON h.tenant_id=$1 AND h.sku=pa.sku
        LEFT JOIN position_economics pe ON pe.tenant_id=$1 AND pe.sku=pa.sku
        JOIN best b ON b.product_code=pa.sku
        WHERE is_salva_bilancio_product($1, pa.sku)
          AND NOT is_muro_rule_product($1, pa.sku)
          AND COALESCE(h.scraper_position, 99) > 3
          AND p.sell_price > 0 AND b.best_est > 0
          AND (COALESCE(p.erp_stock,0)+COALESCE(p.supplier_stock,0)) > 0
          AND p.updated_at >= NOW()-INTERVAL '6 hours'
        ORDER BY pa.rev DESC LIMIT $4`,
        [t.id, RETE_RX, t.name, CAP_PER_TENANT]);

      if (cand.length === 0) { report.push(`${t.name}: 0 candidati`); continue; }

      const payload = cand.map(c => ({
        sku: c.sku, pos: c.pos, banda_oro: c.banda || null,
        scala: (c.scala || []).map(x => parseFloat(x)),
        regola: parseFloat(c.regola),
        floor: parseFloat(c.floor_px), muro: parseInt(c.n_al_best) >= 3,
        ord: parseInt(c.ord), rev: parseFloat(c.rev),
      }));

      let decisioni = [];
      for (let i = 0; i < payload.length; i += 50) {
        decisioni = decisioni.concat(await decideBatch(client, payload.slice(i, i + 50)));
      }

      let applicati = 0, lasciati = 0, clampati = 0;
      for (const d of decisioni) {
        const c = cand.find(x => x.sku === d.sku);
        if (!c || d.cut == null) { lasciati++; continue; }
        // Clamp duro post-AI (i trigger DB restano la rete finale)
        let cut = Math.round(d.cut * 100) / 100;
        const maxCut = parseFloat(c.regola) - 0.01;
        const minCut = parseFloat(c.floor_px);
        if (cut > maxCut || cut < minCut) { clampati++; cut = Math.min(Math.max(cut, minCut), maxCut); }
        if (cut < minCut || cut > maxCut) { lasciati++; continue; }
        await pool.query(`
          INSERT INTO feed_actions (tenant_id, sku, action, action_source, recommended_price, computed_at)
          VALUES ($1, $2, 'PRICE_CUT', 'pareto_ai', $3, NOW())
          ON CONFLICT ON CONSTRAINT uq_feed_action_tenant_sku DO UPDATE SET
            action='PRICE_CUT', action_source='pareto_ai',
            recommended_price=$3, computed_at=NOW()`,
          [t.id, c.sku, cut]);
        applicati++;
      }
      report.push(`${t.name}: ${cand.length} esaminati → ${applicati} cut AI, ${lasciati} lasciati (${clampati} clampati)`);
    } catch (e) {
      console.error(`[ParetoAI] ${t.name} err:`, e.message);
      report.push(`${t.name}: errore ${e.message.slice(0, 50)}`);
    }
  }

  console.log('[ParetoAI]', report.join(' | '));
  try {
    await sendTelegram(`🎯 <b>PARETO POSITIONER AI</b>\n${report.join('\n')}`, { key: 'pareto_ai', parseMode: 'HTML' });
  } catch {}
  return report;
}

let cronStarted = false;

function startParetoPositioner() {
  if (cronStarted) return;
  cronStarted = true;
  // 4 volte al giorno (direttiva 11/7): 06:10, 11:10, 14:10, 18:10 Italia
  // (= 04:10, 09:10, 12:10, 16:10 UTC estivi) — dopo le slice scraper,
  // per generare movimento continuo sul Pareto-set (weekend compreso)
  const ORE_UTC = [4, 9, 12, 16];
  const schedule = () => {
    const now = new Date();
    let next = null;
    for (const h of ORE_UTC) {
      const c = new Date(now);
      c.setUTCHours(h, 10, 0, 0);
      if (c > now && (next === null || c < next)) next = c;
    }
    if (!next) {
      next = new Date(now);
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(ORE_UTC[0], 10, 0, 0);
    }
    setTimeout(() => {
      runParetoPositioner().catch(e => console.error('[ParetoAI] err:', e.message));
      schedule();
    }, next - now);
  };
  schedule();
  console.log('[ParetoAI] Cron attivo — 4x/giorno: 06:10, 11:10, 14:10, 18:10 Italia');
}

module.exports = { runParetoPositioner, startParetoPositioner };
