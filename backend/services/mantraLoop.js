/**
 * 🧭 LOOP DEL MANTRA (ordine capo 19/7)
 *
 * "Crea un loop che porti soluzioni nuove almeno una volta al giorno.
 *  Il mantra è: AUMENTA IL FATTURATO e ABBASSA I COSTI."
 *
 * Ogni mattina 05:50 UTC (07:50 IT, dopo pcDecay/burnerIncidence/sellerGuard,
 * coi loro dati freschi), lo stratega AI legge il quadro della rete e propone
 * 3-5 SOLUZIONI NUOVE — mai già proposte (memoria in mantra_soluzioni) — con
 * azione concreta e stima €/giorno. Digest su Telegram.
 *
 * Il loop PROPONE, non applica: le direzioni narrowing e i prezzi restano a
 * capo/sessione (dictat auto-apply). I tagli meccanici sicuri hanno già i loro
 * loop dedicati. Qui si genera strategia, non si esegue.
 *
 * Leggi passate all'AI: regola aurea (mai rialzi, muri FB, floor fascia),
 * classi protette (brand cliente, carrello-che-ripaga, pin), portafoglio
 * incidenza (espandi bassa, taglia alta), margine-first.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const MODEL = 'claude-sonnet-4-5';
const RUN_HOUR_UTC = 5;
const RUN_MIN_UTC = 50;

async function getApiKey() {
  const { decrypt } = require('./crypto');
  const { rows } = await pool.query(
    `SELECT config_value FROM global_config WHERE config_key='claude_api_key' LIMIT 1`);
  if (!rows.length) throw new Error('claude_api_key non in global_config');
  // la chiave è cifrata AES (come in claudeAgent): decrypt obbligatorio
  try { return decrypt(rows[0].config_value); } catch (_) { return rows[0].config_value; }
}

async function buildSnapshot() {
  const kpi = await pool.query(`
    WITH op AS (SELECT t.id,t.name, COALESCE((SELECT hc.config_value::numeric FROM health_config hc
        WHERE hc.tenant_id=t.id AND hc.config_key='avg_tp_cpc'),0.2773) cpc
      FROM tenants t WHERE t.name IN ('SubitoFarma','Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmastelia','Farmacia Mandanici')
        AND NOT EXISTS (SELECT 1 FROM health_config hcx WHERE hcx.tenant_id=t.id AND hcx.config_key='tp_budget_exhausted' AND hcx.config_value='1' AND (hcx.expires_at IS NULL OR hcx.expires_at > NOW()))),
    sp AS (SELECT tenant_id, SUM(clicks) ck FROM zombie_clicks WHERE fetch_date=CURRENT_DATE-1 GROUP BY 1),
    fa AS (SELECT tenant_id, SUM(grand_total) gt, COUNT(DISTINCT id) n FROM orders
      WHERE order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
        AND (order_date AT TIME ZONE 'Europe/Rome')::date = CURRENT_DATE-1 GROUP BY 1),
    diete AS (SELECT tenant_id, COUNT(*) n FROM feed_quarantine WHERE reactivated=false GROUP BY 1),
    pc AS (SELECT tenant_id, COUNT(*) n FROM feed_actions WHERE recommended_price IS NOT NULL
      AND action IN ('PRICE_CUT','ADD') GROUP BY 1)
    SELECT op.name, ROUND(COALESCE(sp.ck,0)*op.cpc) spesa_ieri, ROUND(COALESCE(fa.gt,0)) fatt_ieri,
      COALESCE(fa.n,0) ordini, ROUND(100.0*COALESCE(sp.ck,0)*op.cpc/NULLIF(fa.gt,0),1) incid_pct,
      COALESCE(diete.n,0) sku_in_dieta, COALESCE(pc.n,0) pc_attivi
    FROM op LEFT JOIN sp ON sp.tenant_id=op.id LEFT JOIN fa ON fa.tenant_id=op.id
    LEFT JOIN diete ON diete.tenant_id=op.id LEFT JOIN pc ON pc.tenant_id=op.id
    ORDER BY op.name`);

  const movers = await pool.query(`
    WITH op AS (SELECT t.id,t.name FROM tenants t WHERE t.name IN ('SubitoFarma','Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmastelia','Farmacia Mandanici')
      AND NOT EXISTS (SELECT 1 FROM health_config hcx WHERE hcx.tenant_id=t.id AND hcx.config_key='tp_budget_exhausted' AND hcx.config_value='1' AND (hcx.expires_at IS NULL OR hcx.expires_at > NOW()))),
    wk AS (SELECT o.tenant_id, oi.sku, MAX(oi.product_name) nome,
        SUM(oi.row_total_incl_tax) FILTER (WHERE o.order_date>=NOW()-INTERVAL '7 days') rev7,
        SUM(oi.row_total_incl_tax) FILTER (WHERE o.order_date<NOW()-INTERVAL '7 days') rev7prec
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.tenant_id IN (SELECT id FROM op) AND o.order_date>=NOW()-INTERVAL '14 days'
        AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
      GROUP BY 1,2)
    (SELECT t.name tenant, wk.sku, LEFT(wk.nome,30) nome, ROUND(COALESCE(rev7,0)) rev7,
       ROUND(COALESCE(rev7prec,0)) rev7prec, 'crescita' dir
     FROM wk JOIN op t ON t.id=wk.tenant_id
     WHERE COALESCE(rev7,0) > COALESCE(rev7prec,0)*2 AND COALESCE(rev7,0)>=150
     ORDER BY rev7 DESC LIMIT 8)
    UNION ALL
    (SELECT t.name, wk.sku, LEFT(wk.nome,30), ROUND(COALESCE(rev7,0)), ROUND(COALESCE(rev7prec,0)), 'calo'
     FROM wk JOIN op t ON t.id=wk.tenant_id
     WHERE COALESCE(rev7prec,0) > COALESCE(rev7,0)*2 AND COALESCE(rev7prec,0)>=150
     ORDER BY rev7prec DESC LIMIT 8)`);

  const giaProposte = await pool.query(
    `SELECT proposta_at, titolo, tipo, tenant, status FROM mantra_soluzioni
     ORDER BY id DESC LIMIT 25`);

  return {
    kpi_ieri: kpi.rows,
    prodotti_in_crescita_o_calo_7g: movers.rows,
    soluzioni_gia_proposte_NON_RIPETERE: giaProposte.rows,
  };
}

const SYSTEM = `Sei lo stratega quotidiano di xHumanPro (SaaS che ottimizza i feed Trovaprezzi di farmacie italiane). MANTRA ASSOLUTO: AUMENTARE IL FATTURATO e ABBASSARE I COSTI — i due insieme, mai uno solo.

LEGGI VIGENTI (mai violarle nelle proposte):
- Mai rialzi prezzo; solo cut sopra il floor di fascia (<10€:18%, 10-30€:14%, >30€:12%). Regole Muro/Sconto = territorio Farmabooster.
- Brand protetti (strategia cliente), carrello-che-ripaga, pin del capo: intoccabili.
- Portafoglio incidenza: tenant sotto il 5% → ESPANDERE esposizione; sopra il 7% → riallocare/tagliare zombie; MPF si risolleva con conversione e leve cliente, non col machete.
- I tagli meccanici (zombie, decadimento PC, burner) hanno già loop automatici: NON proporli di nuovo.
- Fantasmi TP e stock-out sono già nel dossier clienti: proponli solo se hai un angolo NUOVO.

Il tuo compito: 3-5 soluzioni NUOVE oggi (mai già proposte — vedi lista), specifiche e azionabili domattina, ciascuna con stima €/giorno onesta. Pensa a: categorie in domanda, pattern orari/stagionali, riallocazione tra tenant, cross-sell carrelli, prodotti in crescita da cavalcare con PC/posizione, cali da investigare, opportunità di espansione a bassa incidenza.

Rispondi SOLO con JSON: [{"titolo":"...","tipo":"fatturato|costo|misto","tenant":"nome o rete","descrizione":"azione concreta: cosa fare, come, con che numeri","stima_eur_g":N}]`;

// FALLBACK deterministico: se l'AI non è disponibile (crediti/API giù), le
// soluzioni del giorno arrivano comunque, generate dai dati. Il mantra non
// aspetta il billing.
function heuristicProposals(snapshot) {
  const out = [];
  const giaTitoli = new Set((snapshot.soluzioni_gia_proposte_NON_RIPETERE || []).map(s => s.titolo));
  const push = p => { if (!giaTitoli.has(p.titolo) && out.length < 5) out.push(p); };
  for (const m of (snapshot.prodotti_in_crescita_o_calo_7g || [])) {
    if (m.dir === 'crescita')
      push({ titolo: `Cavalca la crescita: ${m.nome} (${m.tenant})`, tipo: 'fatturato', tenant: m.tenant,
        descrizione: `${m.sku} è passato da €${m.rev7prec} a €${m.rev7}/7g. Verificare posizione TP e stock; se pos>3 valutare PC legale a best-0,01; assicurare riassortimento prima del weekend.`,
        stima_eur_g: Math.round((m.rev7 - m.rev7prec) / 7 * 0.3) });
    else
      push({ titolo: `Indaga il calo: ${m.nome} (${m.tenant})`, tipo: 'fatturato', tenant: m.tenant,
        descrizione: `${m.sku} è sceso da €${m.rev7prec} a €${m.rev7}/7g. Check: fantasma TP? stock? prezzo scavalcato? posizione persa? Una causa trovata = fatturato recuperato.`,
        stima_eur_g: Math.round((m.rev7prec - m.rev7) / 7 * 0.5) });
  }
  for (const k of (snapshot.kpi_ieri || [])) {
    if (k.incid_pct && parseFloat(k.incid_pct) < 4.5)
      push({ titolo: `Espandi ${k.name}: incidenza ${k.incid_pct}%`, tipo: 'fatturato', tenant: k.name,
        descrizione: `Incidenza sotto il target: ogni click marginale rende sopra la media di rete. Allargare ADD/pepite di 300-500 SKU di qualità e misurare 48h.`, stima_eur_g: 40 });
  }
  return out;
}

async function runMantraLoop() {
  const snapshot = await buildSnapshot();
  let proposals = [];
  let fonte = 'AI';
  try {
    const apiKey = await getApiKey();
    const { getAiClient } = require('./aiClient');
    const client = await getAiClient('mantra', apiKey);
    if (!client) throw new Error('nessun provider AI disponibile');
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content:
        `Quadro di oggi (${new Date().toISOString().slice(0,10)}):\n` +
        JSON.stringify(snapshot, null, 1) +
        `\n\nProduci le soluzioni nuove di oggi (solo JSON).` }],
    });
    const text = msg.content?.[0]?.text || '';
    const jsonStr = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    proposals = JSON.parse(jsonStr);
  } catch (e) {
    console.warn(`[MantraLoop] AI non disponibile (${e.message?.slice(0,80)}) — fallback dati`);
    proposals = heuristicProposals(snapshot);
    fonte = 'dati (AI non disponibile)';
  }

  const lines = [];
  for (const p of proposals.slice(0, 6)) {
    if (!p.titolo || !p.descrizione) continue;
    await pool.query(
      `INSERT INTO mantra_soluzioni (titolo, tipo, tenant, descrizione, stima_eur_g)
       VALUES ($1,$2,$3,$4,$5)`,
      [String(p.titolo).slice(0,200), String(p.tipo||'misto').slice(0,20),
       String(p.tenant||'rete').slice(0,60), String(p.descrizione).slice(0,2000),
       parseFloat(p.stima_eur_g) || null]);
    const icon = p.tipo==='fatturato' ? '📈' : p.tipo==='costo' ? '✂️' : '⚖️';
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    lines.push(`${icon} <b>${esc(p.titolo)}</b> [${esc(p.tenant||'rete')}]${p.stima_eur_g ? ' ~€'+Math.round(p.stima_eur_g)+'/g' : ''}\n${esc(String(p.descrizione).slice(0,300))}`);
  }
  console.log(`[MantraLoop] ${lines.length} soluzioni nuove proposte (fonte: ${fonte})`);
  if (lines.length) {
    try {
      await sendTelegram(`🧭 <b>Soluzioni del giorno — Loop del Mantra</b>\n(fatturato SU + costi GIÙ · fonte: ${fonte})\n\n${lines.join('\n\n')}`);
    } catch (_) {}
  }
  return { ok: true, n: lines.length, fonte };
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    RUN_HOUR_UTC, RUN_MIN_UTC, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function startMantraLoop() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[MantraLoop] prossimo run tra ${Math.round(delay / 60000)} min (05:50 UTC / 07:50 IT)`);
    setTimeout(async () => {
      try { await runMantraLoop(); } catch (e) { console.error('[MantraLoop] ERRORE:', e.message); }
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startMantraLoop, runMantraLoop };
