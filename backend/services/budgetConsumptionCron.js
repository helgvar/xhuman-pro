/**
 * 💸 GUARDIANO CONSUMO BUDGET (ordine capo 15/8/2026)
 *
 * BUCO CHIUSO: `feed_actions.clicks_consumed` / `cost_consumed` / `budget_pct_used`
 * sono scritti UNA SOLA VOLTA alla nascita della riga e non li aggiorna nessuno
 * (verificato 15/8: nessuna delle 7 UPDATE su feed_actions nel backend li tocca,
 * e l'ON CONFLICT di feedEngine.js:1243 rinfresca solo action/reason/source).
 * Risultato: `max_click_budget` e' > 0 su 106 righe su 100.306, il confronto
 * consumo-vs-budget non e' mai avvenuto e nessuno SKU e' mai stato marcato
 * bruciatore. Ogni taglio fatto finora e' stato a mano, ondata per ondata.
 *
 * COSA FA: misura, per ogni SKU nel feed dei tenant operativi, quanto ha
 * consumato in click contro quanto vale il suo margine, e riscrive i contatori.
 * In `dryRun` non scrive niente: torna solo la fotografia.
 *
 * LEGGI RISPETTATE
 *  - Spesa LORDA: cpc netto x 1,22 (cpcConfig.getTenantCpcGross). Costo e budget
 *    sono entrambi lordi, quindi il rapporto non si sposta.
 *  - Costo vero alla sorgente: floor su erp_purchase_cost se c'e' stock fisico.
 *    Costo mancante = NON SO, lo SKU non si giudica (mai condannare al buio).
 *  - Prezzo esposto vero: prezzo_vero_row() (mig 131/132). applied_price vale
 *    solo finche' un'azione viva lo aggiorna; dopo e' un fossile.
 *    (sell_price da solo e' cieco sui prezzi applicati).
 *  - Scala del click: sotto MIN_CLICKS_TO_JUDGE lo zero vendite e' rumore.
 *    La soglia si misura su JUDGE_WINDOW_DAYS (90gg): il dry run del 15/8 ha
 *    mostrato che su 2.809 SKU nudi solo 3 arrivano a 15 click in 15 giorni —
 *    lo spreco e' polverizzato, non concentrato. Il budget in click e' un totale
 *    di vita ("quanti click ripaga il margine di una vendita"), quindi il
 *    consumo cumulato a 90gg e' il confronto onesto; la spesa resta anche a
 *    15gg per il ritmo corrente.
 *  - Ondate escludono il magazzino: erp_stock > 0 non si tocca.
 *  - Guardie: brand protetti, carrelli sani, pin del capo, chi vende qui a 90gg,
 *    chi vende in rete nella finestra.
 *  - Timezone: click per fetch_date (giorno TP), ordini AT TIME ZONE Europe/Rome.
 *
 * NON RIMUOVE NIENTE. Marca i candidati e li conta. La rimozione resta una
 * decisione separata, col suo rate limit (feed_max_remove_pct_per_run).
 *
 * CANCELLO DURO (ordine capo 15/8): il rischio fatturato deve restare ZERO.
 * Prima di scrivere, ogni candidato viene ricontrollato: se anche uno solo ha
 * fatturato o ordini > 0 nella finestra venditore, l'intero giro si ferma senza
 * toccare il DB e lo urla nel log. Meglio un cron muto che un taglio al buio.
 */
const { pool } = require('../db/pool');
const { getTenantCpcGross } = require('./cpcConfig');

const TENANT_OPERATIONAL = ['SubitoFarma', 'Papa', 'Farmacia Procaccini', 'MPF',
  'Farmainsieme', 'Farmastelia', 'Farmacia Mandanici'];

const VALID_STATUSES = ['pending', 'processing', 'complete', 'ritiro_farmacia',
  'Ritirato', 'ritiro_sede_tmp'];

const WINDOW_DAYS = 15;          // finestra di SPESA corrente (ritmo di oggi)
const JUDGE_WINDOW_DAYS = 90;    // finestra di CONSUMO cumulato contro il budget
const SELLER_WINDOW_DAYS = 90;   // chi ha venduto qui negli ultimi 90gg e' venditore
const BURN_THRESHOLD = 1.70;     // stessa soglia di feedEngine.js:679
const MIN_CLICKS_TO_JUDGE = 15;  // sotto: zero vendite = rumore statistico
const BUDGET_SAFETY = 1.5;       // bibbia margine: kill = margine_eur / cpc x 1,5
const MAX_CANDIDATI_PCT = 2.0;   // oltre: qualcosa e' rotto, non e' un'ondata

/** Budget in click secondo la dottrina: quanti click ripaga il margine. */
function budgetClicksDoctrine(marginEur, cpcGross) {
  if (!(marginEur > 0) || !(cpcGross > 0)) return 0;
  return (marginEur / cpcGross) * BUDGET_SAFETY;
}

/** Budget in click secondo le fasce legacy di health_config.feed_margin_brackets. */
function budgetClicksBrackets(marginEur, brackets) {
  if (!brackets || !brackets.length) return 0;
  const b = brackets.find(x => marginEur >= x.min && marginEur < x.max);
  return b ? b.maxClicks : 0;
}

const MEASURE_SQL = `
WITH px AS (
  SELECT p.tenant_id, p.sku, p.product_name,
         -- mig 132: legge del prezzo, non applied_price grezzo. Il margine che
         -- esce di qui decide max_click_budget, cioe' chi vive e chi muore.
         NULLIF(prezzo_vero_row(p.tenant_id, p.sku, p.applied_price,
                                p.exported_price, p.sell_price), 0)     AS prezzo,
         GREATEST(
           COALESCE(NULLIF(p.erp_cost, 0), 0),
           CASE WHEN COALESCE(p.erp_stock, 0) > 0
                THEN COALESCE(p.erp_purchase_cost, 0) ELSE 0 END)       AS costo,
         COALESCE(p.erp_stock, 0)                                       AS stock
  FROM products p
  WHERE p.tenant_id = $1
),
cl AS (
  SELECT z.product_code AS sku, SUM(z.clicks)::int AS click
  FROM zombie_clicks z
  WHERE z.tenant_id = $1 AND z.fetch_date >= CURRENT_DATE - $2::int
  GROUP BY 1
),
cl90 AS (
  SELECT z.product_code AS sku, SUM(z.clicks)::int AS click
  FROM zombie_clicks z
  WHERE z.tenant_id = $1 AND z.fetch_date >= CURRENT_DATE - $5::int
  GROUP BY 1
),
own AS (
  SELECT oi.sku, COUNT(DISTINCT o.id)::int AS ord,
         SUM(oi.row_total_incl_tax)::numeric AS rev
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  WHERE o.tenant_id = $1 AND o.order_status = ANY($4)
    AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= CURRENT_DATE - $2::int
  GROUP BY 1
),
own90 AS (
  SELECT oi.sku, COUNT(DISTINCT o.id)::int AS ord,
         SUM(oi.row_total_incl_tax)::numeric AS rev
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  WHERE o.tenant_id = $1 AND o.order_status = ANY($4)
    AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= CURRENT_DATE - $3::int
  GROUP BY 1
),
rete AS (
  SELECT oi.sku, COUNT(DISTINCT o.id)::int AS ord
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  WHERE o.order_status = ANY($4)
    AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= CURRENT_DATE - $2::int
  GROUP BY 1
),
-- Se il giudizio guarda 90gg di click, anche "vende in rete" deve guardare 90gg:
-- una vendita di rete a 60 giorni resta la prova che lo SKU non e' morto.
rete90 AS (
  SELECT oi.sku, COUNT(DISTINCT o.id)::int AS ord
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  WHERE o.order_status = ANY($4)
    AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= CURRENT_DATE - $3::int
  GROUP BY 1
)
SELECT f.sku,
       px.product_name,
       px.prezzo,
       px.costo,
       px.stock,
       CASE WHEN px.costo > 0 AND px.prezzo > 0
            THEN px.prezzo - px.costo END                     AS margine_eur,
       COALESCE(cl.click, 0)                                  AS click,
       COALESCE(cl90.click, 0)                                AS click_90gg,
       COALESCE(own.ord, 0)                                   AS ord_finestra,
       ROUND(COALESCE(own.rev, 0), 2)                         AS rev_finestra,
       COALESCE(own90.ord, 0)                                 AS ord_90gg,
       ROUND(COALESCE(own90.rev, 0), 2)                       AS rev_90gg,
       COALESCE(rete.ord, 0)                                  AS ord_rete,
       COALESCE(rete90.ord, 0)                                AS ord_rete_90gg,
       is_brand_protected($1, f.sku)                          AS brand_protetto,
       porta_carrelli_sani($1, f.sku)                         AS carrello_sano,
       EXISTS (SELECT 1 FROM capo_pins cp
               WHERE cp.tenant_id = $1 AND cp.sku = f.sku
                 AND cp.revoked_at IS NULL)                   AS pin_capo
FROM feed_stable_sku f
JOIN px       ON px.sku   = f.sku
LEFT JOIN cl    ON cl.sku    = f.sku
LEFT JOIN cl90  ON cl90.sku  = f.sku
LEFT JOIN own   ON own.sku   = f.sku
LEFT JOIN own90 ON own90.sku = f.sku
LEFT JOIN rete   ON rete.sku   = f.sku
LEFT JOIN rete90 ON rete90.sku = f.sku
WHERE f.tenant_id = $1
  AND COALESCE(cl90.click, 0) > 0`;

/**
 * Misura un tenant. Non scrive mai.
 * @returns {{tenant, cpcGross, feedSize, righe, tot, candidati}}
 */
async function measureTenant(tenant) {
  const cpcGross = await getTenantCpcGross(tenant.id);

  const { rows: cfg } = await pool.query(
    `SELECT config_value FROM health_config
     WHERE tenant_id = $1 AND config_key = 'feed_margin_brackets'`, [tenant.id]);
  let brackets = [];
  try { brackets = JSON.parse(cfg[0]?.config_value || '[]'); } catch { brackets = []; }

  const { rows: feedRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM feed_stable_sku WHERE tenant_id = $1`, [tenant.id]);
  const feedSize = feedRows[0].n;

  const { rows } = await pool.query(MEASURE_SQL,
    [tenant.id, WINDOW_DAYS, SELLER_WINDOW_DAYS, VALID_STATUSES, JUDGE_WINDOW_DAYS]);

  const tot = { sku: rows.length, click: 0, click90: 0, costo: 0, costo90: 0, senzaCosto: 0 };
  const candidati = { dottrina: [], fasce: [] };

  for (const r of rows) {
    const click = r.click;              // ritmo corrente (15gg)
    const click90 = r.click_90gg;       // consumo cumulato contro il budget
    const costo = click * cpcGross;
    tot.click += click;
    tot.click90 += click90;
    tot.costo += costo;
    tot.costo90 += click90 * cpcGross;

    const margine = r.margine_eur === null ? null : parseFloat(r.margine_eur);
    if (margine === null) { tot.senzaCosto++; continue; }   // costo ignoto: non si giudica

    // Guardie: chi non si tocca mai, qualunque sia il consumo.
    const protetto = r.brand_protetto || r.carrello_sano || r.pin_capo
      || r.stock > 0 || r.ord_90gg > 0 || r.ord_finestra > 0
      || r.ord_rete > 0 || r.ord_rete_90gg > 0;
    if (protetto) continue;

    // Scala del click: sotto la soglia lo zero vendite non prova niente.
    if (click90 < MIN_CLICKS_TO_JUDGE) continue;

    const bDot = budgetClicksDoctrine(margine, cpcGross);
    const bFas = budgetClicksBrackets(margine, brackets);

    const riga = {
      sku: r.sku, nome: r.product_name, click, click90,
      costo: +costo.toFixed(2), costo90: +(click90 * cpcGross).toFixed(2),
      margine: +margine.toFixed(2),
      prezzo: parseFloat(r.prezzo), stock: r.stock,
      rev90: parseFloat(r.rev_90gg), ord90: r.ord_90gg,
      ordRete90: r.ord_rete_90gg,
      budgetClickDottrina: Math.round(bDot),
      budgetClickFasce: bFas,
    };
    if (bDot > 0 && click90 >= bDot * BURN_THRESHOLD) candidati.dottrina.push(riga);
    if (bFas > 0 && click90 >= bFas * BURN_THRESHOLD) candidati.fasce.push(riga);
  }

  candidati.dottrina.sort((a, b) => b.costo90 - a.costo90);
  candidati.fasce.sort((a, b) => b.costo90 - a.costo90);

  return {
    tenant: tenant.name, tenantId: tenant.id,
    cpcGross: +cpcGross.toFixed(4), feedSize,
    tot: { ...tot, costo: +tot.costo.toFixed(2), costo90: +tot.costo90.toFixed(2) },
    candidati,
    rischio: valutaRischio(candidati, feedSize),
  };
}

/**
 * CANCELLO DURO — il rischio fatturato deve restare ZERO.
 * Ricontrolla i candidati gia' filtrati: qualunque euro o ordine trovato qui
 * significa che una guardia a monte ha lasciato passare un venditore.
 * @returns {{ok: boolean, motivi: string[], revAtRisk: number, ordAtRisk: number, pctFeed: number}}
 */
function valutaRischio(candidati, feedSize) {
  const tutti = [...candidati.dottrina, ...candidati.fasce];
  const revAtRisk = tutti.reduce((s, r) => s + (r.rev90 || 0), 0);
  const ordAtRisk = tutti.reduce((s, r) => s + (r.ord90 || 0) + (r.ordRete90 || 0), 0);
  const unici = new Set(tutti.map(r => r.sku)).size;
  const pctFeed = feedSize > 0 ? (unici / feedSize) * 100 : 0;

  const motivi = [];
  if (revAtRisk > 0) motivi.push(`fatturato 90gg a rischio €${revAtRisk.toFixed(2)} (deve essere 0)`);
  if (ordAtRisk > 0) motivi.push(`ordini 90gg a rischio ${ordAtRisk} (deve essere 0)`);
  if (pctFeed > MAX_CANDIDATI_PCT) {
    motivi.push(`candidati ${pctFeed.toFixed(2)}% del feed, sopra il tetto ${MAX_CANDIDATI_PCT}%`);
  }
  return {
    ok: motivi.length === 0, motivi,
    revAtRisk: +revAtRisk.toFixed(2), ordAtRisk, pctFeed: +pctFeed.toFixed(3),
  };
}

/**
 * Riscrive i contatori di consumo su feed_actions per il tenant.
 * Chiamata SOLO quando dryRun = false.
 */
async function writeCounters(tenant, misura) {
  const cpcGross = misura.cpcGross;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Firma arbitro: senza questa `trg_arbitro_azioni` mette il veto sui tocchi
    // alle righe manuali (pulizia_*, capo_*). Vedi mig 058.
    await client.query(`SELECT set_config('xhp.writer', 'budget_guard', true)`);
    await client.query(`SELECT set_config('xhp.motivo', 'rinfresco contatori consumo budget', true)`);
    const { rowCount } = await client.query(`
    WITH cl AS (
      SELECT z.product_code AS sku, SUM(z.clicks)::int AS click
      FROM zombie_clicks z
      WHERE z.tenant_id = $1 AND z.fetch_date >= CURRENT_DATE - $2::int
      GROUP BY 1),
    own AS (
      SELECT oi.sku, COUNT(DISTINCT o.id)::int AS ord,
             SUM(oi.row_total_incl_tax)::numeric AS rev
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status = ANY($4)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= CURRENT_DATE - $2::int
      GROUP BY 1)
    UPDATE feed_actions fa SET
      clicks_consumed = COALESCE(cl.click, 0),
      cost_consumed   = ROUND(COALESCE(cl.click, 0) * $3::numeric, 2),
      max_click_budget = ROUND(GREATEST(
        (NULLIF(prezzo_vero_row(p.tenant_id, p.sku, p.applied_price, p.exported_price, p.sell_price), 0)
         - GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
             CASE WHEN COALESCE(p.erp_stock,0) > 0
                  THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END)) * $5::numeric, 0), 2),
      budget_pct_used = LEAST(9999, ROUND(
        100.0 * COALESCE(cl.click,0) * $3::numeric / NULLIF(GREATEST(
          (NULLIF(prezzo_vero_row(p.tenant_id, p.sku, p.applied_price, p.exported_price, p.sell_price), 0)
           - GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
               CASE WHEN COALESCE(p.erp_stock,0) > 0
                    THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END)) * $5::numeric, 0), 0), 1)),
      has_conversions = COALESCE(own.ord, 0) > 0,
      direct_revenue  = ROUND(COALESCE(own.rev, 0), 2)
    FROM products p
    LEFT JOIN cl  ON cl.sku  = p.sku
    LEFT JOIN own ON own.sku = p.sku
    WHERE p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      AND fa.tenant_id = $1`,
      [tenant.id, WINDOW_DAYS, cpcGross, VALID_STATUSES, BUDGET_SAFETY]);
    await client.query('COMMIT');
    return rowCount;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {{dryRun?: boolean, tenants?: string[]}} opts
 */
async function run(opts = {}) {
  const dryRun = opts.dryRun !== false;   // di default NON scrive
  const names = opts.tenants || TENANT_OPERATIONAL;

  const { rows: tenants } = await pool.query(
    `SELECT id, name FROM tenants WHERE status='active' AND name = ANY($1) ORDER BY name`,
    [names]);

  // 1) MISURA TUTTO PRIMA. Nessuna scrittura finche' il cancello non e' passato.
  const report = [];
  for (const t of tenants) report.push(await measureTenant(t));

  // 2) CANCELLO DURO su tutta la rete: basta un tenant sporco per fermare tutti.
  const sporchi = report.filter(r => !r.rischio.ok);
  const revTot = report.reduce((s, r) => s + r.rischio.revAtRisk, 0);
  const ordTot = report.reduce((s, r) => s + r.rischio.ordAtRisk, 0);

  const modo = dryRun ? 'DRY RUN (nessuna scrittura)' : 'SCRITTURA';
  console.log(`[BudgetGuard] ${modo} — spesa ${WINDOW_DAYS}gg, giudizio ${JUDGE_WINDOW_DAYS}gg, ` +
    `soglia ${BURN_THRESHOLD}x, min ${MIN_CLICKS_TO_JUDGE} click`);
  console.log(`[BudgetGuard] RISCHIO FATTURATO: €${revTot.toFixed(2)} su ${ordTot} ordini ` +
    `(patto col capo: deve restare 0)`);

  if (sporchi.length) {
    console.error('[BudgetGuard] 🚨 CANCELLO CHIUSO — giro fermato, DB non toccato:');
    for (const r of sporchi) {
      console.error(`[BudgetGuard]   ${r.tenant}: ${r.rischio.motivi.join(' · ')}`);
    }
    return { report, scritto: false, bloccato: true, revAtRisk: +revTot.toFixed(2), ordAtRisk: ordTot };
  }

  // 3) Ora si puo' scrivere.
  let scritto = false;
  for (const r of report) {
    const t = tenants.find(x => x.id === r.tenantId);
    if (!dryRun) { r.righeAggiornate = await writeCounters(t, r); scritto = true; }
    console.log(`[BudgetGuard] ${r.tenant}: feed ${r.feedSize}, ${r.tot.sku} SKU cliccati, ` +
      `${r.tot.click} click 15gg (€${r.tot.costo}) / ${r.tot.click90} click 90gg (€${r.tot.costo90}) ` +
      `— candidati: dottrina ${r.candidati.dottrina.length}, fasce ${r.candidati.fasce.length}, ` +
      `rischio €${r.rischio.revAtRisk} / ${r.rischio.ordAtRisk} ord / ${r.rischio.pctFeed}% feed` +
      (r.righeAggiornate !== undefined ? ` — righe aggiornate ${r.righeAggiornate}` : ''));
  }
  return { report, scritto, bloccato: false, revAtRisk: +revTot.toFixed(2), ordAtRisk: ordTot };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
const INTERVALLO_MS = 4 * 60 * 60 * 1000;  // ogni 4h, come il ciclo feed TP
const RITARDO_BOOT_MS = 15 * 60 * 1000;    // 15 min dal boot: il sync deve finire
let cronStarted = false;
let inCorso = false;

async function giro() {
  if (inCorso) { console.log('[BudgetGuard] giro precedente ancora in corso, salto'); return; }
  inCorso = true;
  try {
    await run({ dryRun: false });
  } catch (e) {
    console.error('[BudgetGuard] errore giro:', e.message);
  } finally {
    inCorso = false;
  }
}

function startBudgetGuardCron() {
  if (cronStarted) return;
  cronStarted = true;
  setTimeout(() => {
    giro();
    setInterval(giro, INTERVALLO_MS);
  }, RITARDO_BOOT_MS);
  console.log(`[BudgetGuard] loop attivo — ogni ${INTERVALLO_MS / 3600000}h, ` +
    `spesa ${WINDOW_DAYS}gg, giudizio ${JUDGE_WINDOW_DAYS}gg, min ${MIN_CLICKS_TO_JUDGE} click, ` +
    `soglia ${BURN_THRESHOLD}x — cancello: rischio fatturato deve restare 0`);
}

module.exports = {
  run, measureTenant, writeCounters, valutaRischio, startBudgetGuardCron,
  WINDOW_DAYS, JUDGE_WINDOW_DAYS, BURN_THRESHOLD, MIN_CLICKS_TO_JUDGE,
  BUDGET_SAFETY, MAX_CANDIDATI_PCT, TENANT_OPERATIONAL,
};
