/**
 * AI Margin Calibrator (regola aurea posizionale — direttiva utente 7/7/2026)
 *
 * "Se siamo secondi guardiamo il terzo, se quarti il quinto... ma il prezzo
 *  va PESATO tra il concorrente prima e quello dopo: se sono 3° a 10€, il 2°
 *  a 9,90 e il 4° a 11, NON posso uscire a 10,99 — troppo lontano dal 2°,
 *  divento poco appetibile. Serve l'AI per pesare i competitor prima e dopo."
 *
 * 2x/giorno (post scrape completo): per gli altorotanti (>=3 ord/30g) dei
 * tenant con pipe prezzi, con spazio di rialzo verso il vicino sopra (>3%),
 * l'AI (Opus) calibra il prezzo di equilibrio tra vicino-sotto e vicino-sopra:
 * massimo margine recuperabile senza perdere appetibilità.
 * Guardrail HARD post-AI: raise-only, <= vicino_sopra - 0.01, <= listino,
 * mai sotto floor. action_source='margin_harvest_pilot' (protetto da engine).
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const PIPE = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF', 'Farmainsieme', 'Farmacri', 'Farmacia Mandanici','Farmastelia'];
const MAX_PER_RUN = 120;

async function getAnthropic() {
  try {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    // Stessa fonte dell'aiAuditor: chiave in globalConfig (DB), non env
    const { getGlobal } = require('./globalConfig');
    const key = await getGlobal('claude_api_key');
    if (!key) return null;
    const { getAiClient } = require('./aiClient');
    return await getAiClient('calibrator', key);
  } catch { return null; }
}

const SYSTEM_PROMPT = `Sei un pricing manager esperto di Trovaprezzi (farmacia online italiana).
Per ogni prodotto ricevi: prezzo attuale nostro (eff), posizione attuale (pos), prezzo del vicino più economico prima di noi (sotto, può mancare se siamo primi), prezzo del vicino subito dopo di noi (sopra), ordini 30gg (ord), prezzo massimo consentito (cap = min(vicino sopra - 0.01, listino)).
Il tuo compito: proporre il nuovo prezzo che RECUPERA IL MASSIMO MARGINE senza perdere appetibilità.
Regole di equilibrio:
- Mai superare cap. Mai scendere sotto eff (solo rialzi).
- Se siamo PRIMI (sotto assente): sali verso cap ma resta psicologicamente vicino al mercato — se il salto da eff a cap supera ~10-12%, fermati a metà strada circa.
- Se abbiamo un vicino più economico (sotto): il nostro nuovo prezzo NON deve distanziarsi troppo da lui, altrimenti il cliente sceglie lui. Se il vicino-sopra è molto lontano, NON inseguirlo: calibra vicino al vicino-sotto + un margine ragionevole.
- PESA LA ROTAZIONE (ord/30gg): chi VENDE ha domanda dimostrata e regge il prezzo — puoi essere PIÙ aggressivo sul rialzo. Gap massimo dal vicino-sotto: ord 3-5 → ~3%; ord 6-15 → ~5%; ord >15 (bestseller) → fino a ~7% e avvicinati di più al cap. Chi vende poco vive di appetibilità: resta stretto al vicino-sotto.
- Campo banda_top (se presente) = banda di posizione storicamente PIÙ REDDITIZIA per quel prodotto (margine x vendite). Se la posizione attuale (pos) è PEGGIORE della banda_top (numero più alto), NON rialzare (price 0): quel prodotto rende di più in posizioni migliori e sarà il price-cut a riportarcelo. Se pos è dentro o migliore della banda_top, rialza con fiducia verso il bordo del corridoio.
- Campo trend (se presente): 'entrante'/'nuovo_interesse' = la domanda sta ACCELERANDO — l'elasticità cala, sii PIÙ aggressivo sul rialzo (la gente compra comunque); 'caldo' = moderatamente aggressivo; 'raffreddamento' = conservativo, l'interesse cala e il prezzo torna decisivo.
- Se il rialzo sensato è inferiore a 5 centesimi, rispondi 0 (non vale la pena).
Rispondi SOLO con un array JSON: [{"sku":"...","price":0.00}, ...] — price=0 per i prodotti da saltare. Nessun altro testo.`;

async function runAiMarginCalibrator() {
  {
    const { isScraperOptimizationPaused } = require('./scraperPause');
    if (await isScraperOptimizationPaused()) {
      console.log('[AiCalibrator] PAUSA scraper-optimization (ordine capo 11/7) — skip');
      return { calibrated: 0 };
    }
  }
  const client = await getAnthropic();
  if (!client) { console.log('[AiCalibrator] no API key, skip'); return { calibrated: 0 }; }

  const { rows: cands } = await pool.query(`
    WITH alto AS (
      SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_date >= NOW() - INTERVAL '30 days'
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY 1, 2 HAVING COUNT(DISTINCT o.id) >= 3
    )
    SELECT t.name AS tname, a.tenant_id, a.sku, a.ord,
      ROUND(COALESCE(p.applied_price, p.exported_price, p.sell_price)::numeric, 2) AS eff,
      p.sell_price AS listino, p.erp_cost,
      ROUND((p.erp_cost * CASE WHEN COALESCE(p.applied_price, p.sell_price) < 10 THEN 1.18 ELSE 1.15 END)::numeric, 2) AS floor_std,
      -- PREZZO SECCO (capo 21/8): applied/exported/sell_price sono SECCHI, quindi
      -- i vicini e la posizione si misurano su base_price. Col totale il
      -- calibrator vedeva tutti i competitor "sopra di noi" e alzava a vuoto.
      (SELECT MAX(sc.base_price) FROM scraper_competitors sc
       WHERE sc.product_code = a.sku AND sc.base_price > 0
         AND sc.scraped_at >= NOW() - INTERVAL '48 hours'  -- guardrail freschezza (retention 7g)
         AND sc.base_price < COALESCE(p.applied_price, p.exported_price, p.sell_price) - 0.005) AS vicino_sotto,
      (SELECT MIN(sc.base_price) FROM scraper_competitors sc
       WHERE sc.product_code = a.sku AND sc.base_price > 0
         AND sc.scraped_at >= NOW() - INTERVAL '48 hours'  -- guardrail freschezza (retention 7g)
         AND sc.base_price > COALESCE(p.applied_price, p.exported_price, p.sell_price) + 0.005) AS vicino_sopra,
      (SELECT COUNT(*) + 1 FROM scraper_competitors sc
       WHERE sc.product_code = a.sku AND sc.base_price > 0
         AND sc.scraped_at >= NOW() - INTERVAL '48 hours'  -- guardrail freschezza (retention 7g)
         AND sc.base_price < COALESCE(p.applied_price, p.exported_price, p.sell_price)) AS pos,
      (SELECT pe.best_band FROM position_economics pe
       WHERE pe.tenant_id = a.tenant_id AND pe.sku = a.sku) AS banda_top,
      (SELECT dt.stato FROM demand_trends dt
       WHERE dt.scope = 'sku' AND dt.chiave = a.sku) AS trend
    FROM alto a
    JOIN tenants t ON t.id = a.tenant_id AND t.name = ANY($1)
    JOIN products p ON p.tenant_id = a.tenant_id AND p.sku = a.sku
    WHERE p.erp_cost > 0 AND p.saleable = true
      AND (p.erp_stock + COALESCE(p.supplier_stock, 0)) > 0
      AND NOT EXISTS (SELECT 1 FROM feed_killers fk WHERE fk.tenant_id = a.tenant_id AND fk.sku = a.sku AND fk.is_active)
      -- Brand protetti (es. Unifarco/LFP su MPF): strategia prezzi del
      -- cliente — il calibrator NON li tocca, né su né giù
      AND NOT EXISTS (SELECT 1 FROM health_config hc
        WHERE hc.tenant_id = a.tenant_id AND hc.config_key = 'killer_protected_brands'
          AND UPPER(COALESCE(p.brand, '')) = ANY(STRING_TO_ARRAY(UPPER(hc.config_value), ',')))
    ORDER BY (a.ord * COALESCE(p.applied_price, p.sell_price)) DESC`,
    [PIPE]);

  // Solo chi ha spazio: vicino_sopra almeno +3% del nostro eff
  const conSpazio = cands.filter(c =>
    c.vicino_sopra && parseFloat(c.vicino_sopra) > parseFloat(c.eff) * 1.03
    && Math.min(parseFloat(c.vicino_sopra) - 0.01, parseFloat(c.listino)) > parseFloat(c.eff) + 0.05
  ).slice(0, MAX_PER_RUN);

  if (conSpazio.length === 0) { console.log('[AiCalibrator] nessun candidato con spazio'); return { calibrated: 0 }; }

  const payload = conSpazio.map(c => ({
    sku: c.sku, eff: parseFloat(c.eff), pos: parseInt(c.pos), ord: parseInt(c.ord),
    sotto: c.vicino_sotto ? parseFloat(c.vicino_sotto) : null,
    sopra: parseFloat(c.vicino_sopra),
    cap: Math.round(Math.min(parseFloat(c.vicino_sopra) - 0.01, parseFloat(c.listino)) * 100) / 100,
    banda_top: c.banda_top || null,
    trend: c.trend || null,
  }));

  let prices = [];
  try {
    const resp = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
    const text = resp.content.map(b => b.text || '').join('');
    const m = text.match(/\[[\s\S]*\]/);
    prices = m ? JSON.parse(m[0]) : [];
  } catch (e) {
    console.error('[AiCalibrator] AI err:', e.message);
    return { calibrated: 0, error: e.message };
  }

  const byIdx = new Map(conSpazio.map(c => [c.sku + '|' + c.tenant_id, c]));
  const bySku = new Map(conSpazio.map(c => [c.sku, c]));
  let applied = 0, clamped = 0;
  for (const pr of prices) {
    const c = bySku.get(pr.sku);
    if (!c || !pr.price || pr.price <= 0) continue;
    // GUARDRAIL HARD: raise-only, dentro cap, mai sotto floor standard
    const cap = Math.min(parseFloat(c.vicino_sopra) - 0.01, parseFloat(c.listino));
    let newPrice = Math.round(Math.min(Math.max(pr.price, parseFloat(c.eff)), cap) * 100) / 100;
    if (newPrice !== Math.round(pr.price * 100) / 100) clamped++;
    if (newPrice < parseFloat(c.eff) + 0.05) continue;
    await pool.query(`
      INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
        current_price, recommended_price, price_cut_pct, erp_cost, new_margin, new_margin_pct,
        status, expires_at, computed_at)
      VALUES ($1, $2, 'PRICE_CUT', $3, 'margin_harvest_pilot', $4::numeric, $5::numeric,
        ROUND((($4::numeric - $5::numeric) / $4::numeric * 100), 2), $6::numeric,
        ROUND(($5::numeric - $6::numeric), 2), ROUND((($5::numeric - $6::numeric) / $5::numeric * 100), 2),
        'pending', NOW() + INTERVAL '14 days', NOW())
      ON CONFLICT (tenant_id, sku) DO UPDATE SET
        recommended_price = EXCLUDED.recommended_price,
        action_reason = EXCLUDED.action_reason, current_price = EXCLUDED.current_price,
        new_margin = EXCLUDED.new_margin, new_margin_pct = EXCLUDED.new_margin_pct,
        status = 'pending', expires_at = EXCLUDED.expires_at, computed_at = NOW()
      WHERE (feed_actions.recommended_price IS NULL
         OR EXCLUDED.recommended_price > feed_actions.recommended_price)
        -- ARBITRO (18/7): il calibratore non sovrascrive sorgenti manuali/protette
        -- (sessione, capo, guardia venditori) — ognuno il suo spazio operativo
        AND COALESCE(feed_actions.action_source,'') NOT IN ('muro_scavalco','manual_pepita','manual','capo_pin')
        AND COALESCE(feed_actions.action_source,'') NOT LIKE 'pulizia_%'
        AND COALESCE(feed_actions.action_source,'') NOT LIKE 'sessione%'`,
      [c.tenant_id, c.sku,
       `AI-CALIBRATO: pos ${c.pos}, sotto €${c.vicino_sotto || '-'} / sopra €${c.vicino_sopra} -> equilibrio €${newPrice} (${c.ord} ord/30g)`,
       c.eff, newPrice, c.erp_cost]);
    applied++;
  }

  console.log(`[AiCalibrator] ${conSpazio.length} candidati, ${applied} calibrati (${clamped} clampati dai guardrail)`);
  if (applied > 0) {
    try {
      await sendTelegram(`🧠💰 <b>AI Margin Calibrator</b>: ${applied} rialzi calibrati tra vicino-sotto e vicino-sopra (guardrail: ${clamped} clampati)`,
        { key: 'ai_calibrator', parseMode: 'HTML', throttleMs: 6 * 3600 * 1000 });
    } catch {}
  }
  return { calibrated: applied, candidates: conSpazio.length };
}

let cronStarted = false;

function startAiMarginCalibrator() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    // 2x/giorno: 05:30 UTC (07:30 ita, post scrape full) e 13:00 UTC (15:00 ita)
    const slots = [[5, 30], [13, 0]];
    let next = null;
    for (const [h, m] of slots) {
      const cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0));
      if (cand > now) { next = cand; break; }
    }
    if (!next) next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 5, 30, 0));
    setTimeout(async () => {
      try { await runAiMarginCalibrator(); } catch (e) { console.error('[AiCalibrator] err:', e.message); }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[AiCalibrator] Cron started — 07:30 e 15:00 italia');
}

module.exports = { runAiMarginCalibrator, startAiMarginCalibrator };
