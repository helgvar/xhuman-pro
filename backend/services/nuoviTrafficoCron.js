/**
 * 🌊 TAGLIO NUOVI NEL TRAFFICO (nato 21/8 dall'ordine del capo: "STACCHIAMOLI",
 * dopo tre giorni di tagli a mano — 84 il 20/8, 17 il 21/8 — sulla stessa marea)
 *
 * Ogni giorno TP fa entrare nel traffico decine di SKU che non erano mai stati
 * cliccati: 174 il 20/8 su Procaccini, 37 il 21/8. Non sono prodotti nuovi, sono
 * prodotti fermi da sempre che all'improvviso prendono un click. La maggior parte
 * non vende, e ognuno costa un CPC al giorno finché qualcuno non se ne accorge.
 *
 * Questo cron applica il criterio che il capo ha approvato due volte a mano:
 *
 *   ENTRA nel taglio chi ha TUTTE queste:
 *     1. ha DEBUTTATO nel traffico negli ultimi 5 giorni chiusi (mai CURRENT_DATE:
 *        il fetch_date di oggi è parziale e mente)
 *     2. zero click nei 7 giorni prima del debutto → è entrato ora, non è un abituale
 *     3. zero ordini propri negli ultimi 30 giorni
 *     4. zero vendite proprie negli ultimi 90 giorni
 *     5. erp_stock = 0  → il magazzino della farmacia non si spegne mai, si spinge
 *     6. è davvero nel feed (exported_price > 0)
 *
 *   VA AL GUINZAGLIO (MONITOR, non REMOVE) chi soddisfa 1-3 e 5-6 ma HA VENDUTO
 *   negli ultimi 90 giorni. Chi vende non si condanna: si sorveglia.
 *
 * Le guardie di merito NON sono duplicate qui: i trigger su feed_actions
 * (brand protetti, veto carrello, cap condanne, arbitro) restano sovrani. Per
 * questo la firma è 'pulizia_nuovi_traffico' e NON 'capo_*': il prefisso capo
 * scavalcherebbe i veti, e qui li vogliamo tutti in piedi.
 *
 * Perché il DEBUTTO e non "chi ha click ieri": il cap anti-strage su feed_actions
 * respinge i tagli automatici quando la giornata è già piena (giusto: la macchina
 * non scavalca il cap, solo la mano del capo lo fa). Guardando solo ieri, un
 * respinto oggi domani non sarebbe più "nuovo" e sfuggirebbe per sempre. Col
 * debutto ha 5 giorni di ripescaggio. Per lo stesso motivo gira alle 14:00 IT e
 * non al mattino: prende gli avanzi del cap, non li ruba a chi taglia danno più
 * grosso.
 *
 * FAIL-CLOSED (prima i dati freschi, poi il giudizio, poi la condanna):
 *   - manca il file click del giorno chiuso        → non taglia
 *   - ultimo import ordini più vecchio di 12h      → non taglia
 *   - candidati oltre il cap giornaliero           → non taglia NIENTE e allarma
 *     (una marea anomala si guarda a mano, non si esegue alla cieca)
 *
 * Il REMOVE scade dopo 60 giorni: l'oblio non è per sempre. Se lo SKU rientra e
 * ricomincia a prendere click a vuoto, al giro dopo è di nuovo "nuovo" e
 * ripassa da qui; se invece ha ripreso a vendere, la guardia 4 lo salva.
 *
 * Acceso per tenant con health_config.auto_nuovi_traffico_on = '1'.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');
const { getTenantCpcGross } = require('./cpcConfig');

// ordini reali Magento: unica verità sulle vendite (annullati esclusi)
const ORDER_STATUS = ['complete', 'processing', 'pending', 'holded', 'payment_review',
  'ritiro_farmacia', 'Ritirato', 'ritiro_sede_tmp'];

const MAX_CUT_PER_TENANT = 150;   // quanti se ne staccano al massimo in un giorno
const MAREA_ANOMALA = 450;        // 3x: oltre non è arretrato, è il criterio impazzito
const MAX_IMPORT_AGE_H = 12;      // fail-closed sulla freschezza ordini
const REMOVE_TTL_DAYS = 60;       // l'oblio non è per sempre
const RETRY_DAYS = 5;             // giorni di ripescaggio se il cap respinge il taglio
// 14:00 IT, DOPO il motore feed delle ~12:49: il cap giornaliero (150) è una
// risorsa scarsa e condivisa, e chi taglia danno misurato grosso (bruciatore,
// budget_cut) ha la precedenza su chi toglie un click da 34 centesimi. Qui si
// prendono gli avanzi. Nei giorni normali ne restano ~140.
const RUN_HOUR_UTC = 12;
const RUN_MIN_UTC = 0;

async function runTenant(client, tenant) {
  const cpc = await getTenantCpcGross(tenant.id);

  // 1. il giorno CHIUSO più recente con un file click. Mai CURRENT_DATE: è parziale.
  const { rows: gg } = await client.query(`
    SELECT MAX(fetch_date) AS d FROM zombie_clicks
    WHERE tenant_id = $1 AND fetch_date < CURRENT_DATE`, [tenant.id]);
  const giorno = gg[0]?.d;
  if (!giorno) return { skip: 'nessun file click chiuso' };

  // il file dev'essere quello di ieri: se è più vecchio, i click non sono arrivati
  const { rows: fresh } = await client.query(
    `SELECT (CURRENT_DATE - $1::date) AS eta_gg`, [giorno]);
  if (Number(fresh[0].eta_gg) > 1) {
    return { skip: `file click vecchio di ${fresh[0].eta_gg} giorni (${giorno})` };
  }

  // 2. freschezza ordini: senza vendite fresche non si condanna nessuno
  const { rows: imp } = await client.query(`
    SELECT EXTRACT(EPOCH FROM (NOW() - MAX(COALESCE(completed_at, started_at)))) / 3600 AS ore
    FROM import_jobs WHERE tenant_id = $1 AND job_type = 'orders_sync' AND status = 'completed'`,
    [tenant.id]);
  const oreImport = imp[0]?.ore;
  if (oreImport === null || oreImport === undefined || Number(oreImport) > MAX_IMPORT_AGE_H) {
    return { skip: `import ordini vecchio ${oreImport ? Math.round(oreImport) + 'h' : 'mai'}` };
  }

  // 3. i candidati.
  // NON si guarda "chi ha click ieri": si guarda il giorno di DEBUTTO nel traffico.
  // Serve perché il cap anti-strage può respingere il taglio (giustamente: la
  // macchina non scavalca il cap, solo la mano del capo lo fa). Se guardassimo
  // solo ieri, il respinto domani non sarebbe più "nuovo" e sfuggirebbe per
  // sempre. Col debutto ha RETRY_DAYS giorni di ripescaggio.
  const { rows: cand } = await client.query(`
    WITH fin AS (
      SELECT product_code AS sku, fetch_date, SUM(clicks) AS clicks
      FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date BETWEEN $2::date - 30 AND $2::date
      GROUP BY 1, 2 HAVING SUM(clicks) > 0),
    debutto AS (
      SELECT sku, MIN(fetch_date) AS d1, SUM(clicks)::int AS click FROM fin GROUP BY 1),
    nuovi AS (
      SELECT d.* FROM debutto d
      WHERE d.d1 >= $2::date - $4::int          -- debuttato dentro la finestra di ripescaggio
        AND NOT EXISTS (                        -- e prima del debutto, silenzio per 7 giorni
          SELECT 1 FROM zombie_clicks z
          WHERE z.tenant_id = $1 AND z.product_code = d.sku
            AND z.fetch_date BETWEEN d.d1 - 7 AND d.d1 - 1)),
    ord30 AS (
      SELECT DISTINCT oi.sku FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status = ANY($3)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= CURRENT_DATE - 30),
    ven90 AS (
      SELECT DISTINCT oi.sku FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status = ANY($3)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= CURRENT_DATE - 90)
    SELECT n.sku, n.click, n.d1, p.product_name, COALESCE(p.supplier_stock, 0) AS supplier_stock,
           (v90.sku IS NOT NULL) AS vende_90gg
    FROM nuovi n
    JOIN products p ON p.tenant_id = $1 AND p.sku = n.sku
    LEFT JOIN ord30 ON ord30.sku = n.sku
    LEFT JOIN ven90 v90 ON v90.sku = n.sku
    LEFT JOIN feed_actions fa ON fa.tenant_id = $1 AND fa.sku = n.sku
    WHERE ord30.sku IS NULL              -- zero ordini 30gg
      AND COALESCE(p.erp_stock, 0) = 0   -- il magazzino fisico non si spegne
      AND COALESCE(p.exported_price, 0) > 0
      -- mai sopra la mano di qualcun altro: si tocca solo il vuoto o la propria firma
      AND (fa.sku IS NULL OR (fa.action_source = 'pulizia_nuovi_traffico' AND fa.action <> 'REMOVE'))
    ORDER BY n.click DESC`, [tenant.id, giorno, ORDER_STATUS, RETRY_DAYS]);

  if (!cand.length) return { giorno, tagliati: 0, guinzaglio: 0, costo: 0 };

  const daTagliare = cand.filter(c => !c.vende_90gg);
  const daSorvegliare = cand.filter(c => c.vende_90gg);

  // Il cap non si sfonda e non si esegue alla cieca, ma un arretrato non è una
  // marea. Alla PRIMA accensione di un tenant i candidati sono 30 giorni di
  // debutti mai potati (MPF 21/8: 227). Due soglie, quindi:
  //   oltre MAREA_ANOMALA  = il criterio è impazzito, non si tocca niente
  //   fra il cap e la marea = arretrato legittimo: si drena dai più cari, il
  //                           resto ripassa domani (finestra RETRY_DAYS).
  let arretrato = 0;
  if (daTagliare.length > MAREA_ANOMALA) {
    return { giorno, capSforato: daTagliare.length };
  }
  if (daTagliare.length > MAX_CUT_PER_TENANT) {
    daTagliare.sort((a, b) => Number(b.click) - Number(a.click));
    arretrato = daTagliare.length - MAX_CUT_PER_TENANT;
    daTagliare.length = MAX_CUT_PER_TENANT;
  }

  const click = daTagliare.reduce((s, c) => s + Number(c.click), 0);
  const costo = click * cpc;

  if (daTagliare.length) {
    await client.query(`
      INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
                                erp_stock, supplier_stock, status, expires_at)
      SELECT $1, x.sku, 'REMOVE',
        'AUTO ' || TO_CHAR($2::date, 'DD/MM') || ': nuovo nel traffico (debutto ' ||
        TO_CHAR(x.d1, 'DD/MM') || ', ' || x.click || ' click, zero nei 7gg prima), ' ||
        'zero ordini 30gg, zero vendite 90gg, zero stock fisico',
        'pulizia_nuovi_traffico', 0, x.sup, 'pending', NOW() + ($3 || ' days')::interval
      FROM UNNEST($4::text[], $5::int[], $6::int[], $7::date[]) AS x(sku, click, sup, d1)
      ON CONFLICT (tenant_id, sku) DO UPDATE
        SET action = 'REMOVE', action_reason = EXCLUDED.action_reason,
            action_source = EXCLUDED.action_source, status = 'pending',
            expires_at = EXCLUDED.expires_at, computed_at = NOW()`,
      [tenant.id, giorno, String(REMOVE_TTL_DAYS),
       daTagliare.map(c => c.sku), daTagliare.map(c => Number(c.click)),
       daTagliare.map(c => Number(c.supplier_stock)), daTagliare.map(c => c.d1)]);
  }

  if (daSorvegliare.length) {
    await client.query(`
      INSERT INTO feed_actions (tenant_id, sku, action, action_reason, action_source,
                                erp_stock, supplier_stock, status)
      SELECT $1, x.sku, 'MONITOR',
        'AUTO ' || TO_CHAR($2::date, 'DD/MM') || ': nuovo nel traffico, zero ordini 30gg MA ha venduto a 90gg. Sorvegliato, non tagliato',
        'pulizia_nuovi_traffico', 0, x.sup, 'pending'
      FROM UNNEST($3::text[], $4::int[]) AS x(sku, sup)
      ON CONFLICT (tenant_id, sku) DO NOTHING`,
      [tenant.id, giorno, daSorvegliare.map(c => c.sku),
       daSorvegliare.map(c => Number(c.supplier_stock))]);
  }

  // quello che è atterrato davvero: i trigger di veto possono aver respinto
  const { rows: fatto } = await client.query(`
    SELECT action, COUNT(*)::int AS n FROM feed_actions
    WHERE tenant_id = $1 AND action_source = 'pulizia_nuovi_traffico'
      AND computed_at >= NOW() - INTERVAL '5 minutes' GROUP BY 1`, [tenant.id]);
  const atterrati = Object.fromEntries(fatto.map(r => [r.action, r.n]));

  return {
    giorno,
    candidati: cand.length,
    tagliati: atterrati.REMOVE || 0,
    respinti: daTagliare.length - (atterrati.REMOVE || 0),
    guinzaglio: atterrati.MONITOR || 0,
    arretrato,
    click,
    costo,
  };
}

async function runNuoviTraffico() {
  const client = await pool.connect();
  const righe = [];
  try {
    await client.query(`SELECT set_config('xhp.writer', 'nuovi_traffico', true),
      set_config('xhp.motivo', 'taglio automatico dei nuovi entrati nel traffico che non vendono e non hanno stock fisico', true)`);

    const { rows: tenants } = await client.query(`
      SELECT t.id, t.name FROM tenants t
      WHERE t.status = 'active'
        AND EXISTS (SELECT 1 FROM health_config hc
                    WHERE hc.tenant_id = t.id AND hc.config_key = 'auto_nuovi_traffico_on'
                      AND hc.config_value = '1'
                      AND (hc.expires_at IS NULL OR hc.expires_at > NOW()))
      ORDER BY t.name`);

    for (const tenant of tenants) {
      try {
        const r = await runTenant(client, tenant);
        if (r.skip) {
          console.log(`[NuoviTraffico] ${tenant.name}: SALTATO — ${r.skip}`);
          righe.push(`⏭️ ${tenant.name}: saltato (${r.skip})`);
        } else if (r.capSforato) {
          console.warn(`[NuoviTraffico] ${tenant.name}: MAREA ANOMALA ${r.capSforato} > ${MAREA_ANOMALA}`);
          righe.push(`🚨 ${tenant.name}: ${r.capSforato} candidati oltre la marea di ${MAREA_ANOMALA}. NON tagliato niente, da guardare a mano`);
        } else if (!r.tagliati && !r.guinzaglio) {
          console.log(`[NuoviTraffico] ${tenant.name}: nessun candidato (${r.giorno})`);
        } else {
          console.log(`[NuoviTraffico] ${tenant.name}: ${r.tagliati} tagliati, ${r.guinzaglio} al guinzaglio, ${r.respinti} respinti, €${r.costo.toFixed(2)} risparmiati/gg`);
          righe.push(`✂️ ${tenant.name}: ${r.tagliati} staccati (${r.click} click, €${r.costo.toFixed(2)}/gg)` +
            (r.guinzaglio ? `, ${r.guinzaglio} al guinzaglio (vendono a 90gg)` : '') +
            (r.respinti ? `, ⚠️ ${r.respinti} respinti dai veti/cap` : '') +
            (r.arretrato ? `, 📦 ${r.arretrato} in coda per domani` : ''));
        }
      } catch (e) {
        console.error(`[NuoviTraffico] ${tenant.name} ERRORE:`, e.message);
        righe.push(`❌ ${tenant.name}: ${e.message}`);
      }
    }

    if (righe.length) {
      await sendTelegram(`🌊 *Nuovi nel traffico*\n\n${righe.join('\n')}`);
    }
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

function startNuoviTrafficoCron() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[NuoviTraffico] prossimo run tra ${Math.round(delay / 60000)} min (12:00 UTC / 14:00 IT)`);
    setTimeout(async () => {
      try { await runNuoviTraffico(); } catch (e) { console.error('[NuoviTraffico] ERRORE:', e.message); }
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startNuoviTrafficoCron, runNuoviTraffico };
