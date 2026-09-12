/**
 * ⚖️ VERDETTO SUI TAGLI (ordine capo 21/8: "controlla che dopo i tagli il
 * fatturato non scenda insieme alla spesa")
 *
 * Il mantra è costo GIÙ *e* fatturato SU. Un taglio che porta via anche il
 * fatturato non è un risparmio: è potatura del ramo che dà i frutti. Questo
 * cron misura, ogni giorno, se i tagli fatti stanno rispettando il patto.
 *
 * Due tempi, perché la misura ne ha due:
 *
 *   FASE A — CONGELA (ogni giorno). Prende i REMOVE nuovi e fotografa il loro
 *   PRIMA sui 7 giorni chiusi precedenti: click, costo, quantità vendute,
 *   fatturato, margine retroattivo, e soprattutto i CARRELLI — quanti ordini
 *   passavano da quello SKU e quanto valevano *interi*. Si congela subito
 *   perché fra una settimana la finestra "prima" sarebbe già inquinata.
 *
 *   FASE B — GIUDICA (a 7 giorni). Rimisura il DOPO e confronta. Tre domande:
 *     1. il risparmio di click è reale?
 *     2. quel fatturato è sparito o si è spostato (vendono ancora fuori TP)?
 *     3. abbiamo perso CARRELLI? Un burner che porta il carrello non è un
 *        burner: è un'insegna. (dictat guardia carrello 9/7)
 *
 * IL CONTROFATTUALE È LA RETE. Agosto scende da solo: Procaccini -36% ordini,
 * ma nello stesso periodo Ospedale -49%, Farmainsieme -43%, San Vito -31%.
 * Senza un termine di paragone esterno si condanna il taglio per una stagione.
 * Quindi il tenant si misura contro la MEDIANA degli altri operativi. Conta lo
 * scarto, non il segno.
 *
 * ALLARME solo con evidenza multipla e soglia alta (i falsi allarmi bruciano
 * la fiducia più del problema che segnalano):
 *   - il tenant fa peggio della rete di oltre 10 punti, E
 *   - la perdita di margine supera il risparmio di click
 * oppure, indipendente e più netto:
 *   - i tagliati portavano carrelli veri (≥3 ordini con altre righe dentro)
 *
 * Non riattiva niente da solo: PROPONE i rientri. La mano resta del capo.
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');
const { getTenantCpcGross } = require('./cpcConfig');

const ORDER_STATUS = ['complete', 'processing', 'pending', 'holded', 'payment_review',
  'ritiro_farmacia', 'Ritirato', 'ritiro_sede_tmp'];

const FINESTRA = 7;               // giorni chiusi, stessa misura prima e dopo
const SCARTO_ALLARME = -10;       // punti sotto la rete oltre cui si alza la voce
const CARRELLI_ALLARME = 3;       // ordini-carrello persi che bastano da soli
const RUN_HOUR_UTC = 6;
const RUN_MIN_UTC = 30;           // 08:30 IT: file click atterrato, ordini sincronizzati

// ─── fatturato NETTO del tenant in una finestra: grand_total meno la
// spedizione (che non è fatturato nostro, è del corriere) ──────────────────
const SQL_FATT_TENANT = `
  SELECT COALESCE(SUM(o.grand_total - COALESCE(o.shipping_incl_tax, 0)), 0) AS netto,
         COUNT(*)::int AS ordini
  FROM orders o
  WHERE o.tenant_id = $1 AND o.order_status = ANY($2)
    AND (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN $3 AND $4`;

async function fattTenant(client, tenantId, da, a) {
  const { rows } = await client.query(SQL_FATT_TENANT, [tenantId, ORDER_STATUS, da, a]);
  return { netto: Number(rows[0].netto), ordini: rows[0].ordini };
}

async function costoClick(client, tenantId, cpc, da, a) {
  const { rows } = await client.query(`
    SELECT COALESCE(SUM(clicks), 0)::int AS click FROM zombie_clicks
    WHERE tenant_id = $1 AND fetch_date BETWEEN $2 AND $3`, [tenantId, da, a]);
  return { click: rows[0].click, costo: rows[0].click * cpc };
}

// ─── FASE A: congela il PRIMA dei tagli nuovi ─────────────────────────────
async function congela(client, tenant, cpc, giorno) {
  const da = `${giorno}::date - ${FINESTRA}`;
  const { rowCount } = await client.query(`
    WITH nuovi AS (
      SELECT fa.sku, fa.action_source, p.product_name
      FROM feed_actions fa
      JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      WHERE fa.tenant_id = $1 AND fa.action = 'REMOVE'
        AND (fa.computed_at AT TIME ZONE 'Europe/Rome')::date = $2::date
        AND NOT EXISTS (SELECT 1 FROM taglio_coorti c
                        WHERE c.tenant_id = $1 AND c.sku = fa.sku AND c.giorno_taglio = $2::date)),
    clic AS (
      SELECT product_code AS sku, SUM(clicks)::int AS click FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date BETWEEN ${da} AND $2::date - 1
      GROUP BY 1),
    -- righe vendute: IVA inclusa (row_total è esclusa, erp_cost è inclusa)
    righe AS (
      SELECT oi.sku,
             SUM(oi.qty_ordered)::int AS qta,
             SUM(COALESCE(NULLIF(oi.row_total_incl_tax, 0), oi.row_total)) AS fatt,
             SUM(COALESCE(NULLIF(oi.row_total_incl_tax, 0), oi.row_total)
                 - COALESCE(costo_al($1, oi.sku, (o.order_date AT TIME ZONE 'Europe/Rome')::date), 0)
                   * oi.qty_ordered) AS margine,
             COUNT(DISTINCT o.id)::int AS ordini
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status = ANY($3)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN ${da} AND $2::date - 1
      GROUP BY 1),
    -- IL CARRELLO: valore NETTO pieno degli ordini che passavano da quello SKU.
    -- Non quanto valeva la sua riga: quanto valeva la spesa che si portava dietro.
    carrello AS (
      SELECT oi.sku, SUM(DISTINCT o.grand_total - COALESCE(o.shipping_incl_tax, 0)) AS eur
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status = ANY($3)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN ${da} AND $2::date - 1
      GROUP BY 1)
    INSERT INTO taglio_coorti (tenant_id, sku, giorno_taglio, action_source, product_name,
      pre_click, pre_costo, pre_qta, pre_fatturato, pre_margine, pre_ordini, pre_carrello)
    SELECT $1, n.sku, $2::date, n.action_source, n.product_name,
      COALESCE(c.click, 0), ROUND(COALESCE(c.click, 0) * $4::numeric, 2),
      COALESCE(r.qta, 0), COALESCE(r.fatt, 0), COALESCE(r.margine, 0),
      COALESCE(r.ordini, 0), COALESCE(cr.eur, 0)
    FROM nuovi n
    LEFT JOIN clic c ON c.sku = n.sku
    LEFT JOIN righe r ON r.sku = n.sku
    LEFT JOIN carrello cr ON cr.sku = n.sku
    ON CONFLICT (tenant_id, sku, giorno_taglio) DO NOTHING`,
    [tenant.id, giorno, ORDER_STATUS, cpc]);
  return rowCount;
}

// ─── FASE B: giudica le coorti mature ─────────────────────────────────────
async function giudica(client, tenant, cpc, giorno, reteDelta) {
  const { rows: mature } = await client.query(`
    SELECT giorno_taglio, COUNT(*)::int AS n FROM taglio_coorti
    WHERE tenant_id = $1 AND giudicato_al IS NULL
      AND giorno_taglio <= $2::date - $3::int
    GROUP BY 1 ORDER BY 1`, [tenant.id, giorno, FINESTRA]);

  const verdetti = [];
  for (const m of mature) {
    const g = m.giorno_taglio;

    // il DOPO della coorte, stessa larghezza di finestra, per SKU
    await client.query(`
      UPDATE taglio_coorti c SET
        post_click = COALESCE((SELECT SUM(z.clicks)::int FROM zombie_clicks z
                     WHERE z.tenant_id = c.tenant_id AND z.product_code = c.sku
                       AND z.fetch_date BETWEEN c.giorno_taglio + 1 AND c.giorno_taglio + $3::int), 0),
        post_qta = COALESCE((SELECT SUM(oi.qty_ordered)::int FROM orders o
                     JOIN order_items oi ON oi.order_id = o.id
                     WHERE o.tenant_id = c.tenant_id AND oi.sku = c.sku AND o.order_status = ANY($4)
                       AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
                           BETWEEN c.giorno_taglio + 1 AND c.giorno_taglio + $3::int), 0),
        post_fatturato = COALESCE((SELECT SUM(COALESCE(NULLIF(oi.row_total_incl_tax,0), oi.row_total))
                     FROM orders o JOIN order_items oi ON oi.order_id = o.id
                     WHERE o.tenant_id = c.tenant_id AND oi.sku = c.sku AND o.order_status = ANY($4)
                       AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
                           BETWEEN c.giorno_taglio + 1 AND c.giorno_taglio + $3::int), 0),
        post_ordini = COALESCE((SELECT COUNT(DISTINCT o.id)::int FROM orders o
                     JOIN order_items oi ON oi.order_id = o.id
                     WHERE o.tenant_id = c.tenant_id AND oi.sku = c.sku AND o.order_status = ANY($4)
                       AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
                           BETWEEN c.giorno_taglio + 1 AND c.giorno_taglio + $3::int), 0),
        post_carrello = COALESCE((SELECT SUM(DISTINCT o.grand_total - COALESCE(o.shipping_incl_tax,0))
                     FROM orders o JOIN order_items oi ON oi.order_id = o.id
                     WHERE o.tenant_id = c.tenant_id AND oi.sku = c.sku AND o.order_status = ANY($4)
                       AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
                           BETWEEN c.giorno_taglio + 1 AND c.giorno_taglio + $3::int), 0)
      WHERE c.tenant_id = $1 AND c.giorno_taglio = $2::date AND c.giudicato_al IS NULL`,
      [tenant.id, g, FINESTRA, ORDER_STATUS]);

    await client.query(`
      UPDATE taglio_coorti c SET
        post_costo = ROUND(c.post_click * $3::numeric, 2),
        esito = CASE
          WHEN c.post_qta > 0                                THEN 'rientrato'
          WHEN c.pre_ordini >= 2 AND c.pre_carrello > 0      THEN 'carrello_perso'
          WHEN c.pre_fatturato > 0                           THEN 'costa_fatturato'
          ELSE 'pulito' END,
        giudicato_al = NOW()
      WHERE c.tenant_id = $1 AND c.giorno_taglio = $2::date AND c.giudicato_al IS NULL`,
      [tenant.id, g, cpc]);

    // il conto della coorte
    const { rows: [c] } = await client.query(`
      SELECT COUNT(*)::int AS n,
             SUM(pre_costo - COALESCE(post_costo, 0)) AS risparmio,
             SUM(pre_fatturato - COALESCE(post_fatturato, 0)) AS fatt_perso,
             SUM(pre_margine) AS margine_pre,
             COUNT(*) FILTER (WHERE esito = 'carrello_perso')::int AS carrelli,
             SUM(pre_carrello) FILTER (WHERE esito = 'carrello_perso') AS carrello_eur,
             COUNT(*) FILTER (WHERE esito = 'rientrato')::int AS rientrati
      FROM taglio_coorti WHERE tenant_id = $1 AND giorno_taglio = $2::date`, [tenant.id, g]);

    // il tenant: stessa larghezza di finestra, prima e dopo il taglio
    const pre = await fattTenant(client, tenant.id, `${g}`, `${g}`);
    const { rows: [fin] } = await client.query(
      `SELECT ($1::date - $2::int)::text AS pre_da, ($1::date - 1)::text AS pre_a,
              ($1::date + 1)::text AS post_da, ($1::date + $2::int)::text AS post_a`, [g, FINESTRA]);
    const tPre = await fattTenant(client, tenant.id, fin.pre_da, fin.pre_a);
    const tPost = await fattTenant(client, tenant.id, fin.post_da, fin.post_a);
    const cPre = await costoClick(client, tenant.id, cpc, fin.pre_da, fin.pre_a);
    const cPost = await costoClick(client, tenant.id, cpc, fin.post_da, fin.post_a);
    void pre;

    const deltaPct = tPre.netto > 0 ? ((tPost.netto - tPre.netto) / tPre.netto) * 100 : null;
    const scarto = (deltaPct !== null && reteDelta !== null) ? deltaPct - reteDelta : null;

    const risparmio = Number(c.risparmio) || 0;
    const fattPerso = Number(c.fatt_perso) || 0;
    const marginePerso = Number(c.margine_pre) || 0;

    // il verdetto: soglia alta, evidenza multipla
    let verdetto, nota;
    if (tPre.netto <= 0 || deltaPct === null) {
      verdetto = 'dati_insufficienti';
      nota = 'finestra pre senza fatturato: niente da confrontare';
    } else if (c.carrelli >= CARRELLI_ALLARME) {
      verdetto = 'allarme';
      nota = `${c.carrelli} tagliati portavano carrelli veri (€${Number(c.carrello_eur || 0).toFixed(0)} di spesa passava da lì). Proporre il rientro.`;
    } else if (scarto !== null && scarto <= SCARTO_ALLARME && marginePerso > risparmio) {
      verdetto = 'allarme';
      nota = `tenant ${deltaPct.toFixed(1)}% contro rete ${reteDelta.toFixed(1)}% (${scarto.toFixed(1)} punti sotto) e il margine perso (€${marginePerso.toFixed(0)}) supera il risparmio (€${risparmio.toFixed(0)})`;
    } else if (scarto !== null && scarto <= SCARTO_ALLARME) {
      verdetto = 'sorvegliato';
      nota = `sotto la rete di ${Math.abs(scarto).toFixed(1)} punti, ma il risparmio (€${risparmio.toFixed(0)}) regge il margine perso (€${marginePerso.toFixed(0)})`;
    } else if (c.carrelli > 0) {
      verdetto = 'sorvegliato';
      nota = `${c.carrelli} con carrello, sotto la soglia di allarme`;
    } else {
      verdetto = 'sano';
      nota = `risparmio €${risparmio.toFixed(0)}, fatturato in linea con la rete`;
    }

    await client.query(`
      INSERT INTO taglio_verdetti (tenant_id, giorno_taglio, sku_tagliati, risparmio_click,
        fatturato_perso, margine_perso, carrelli_persi, carrello_perso_eur,
        tenant_fatt_pre, tenant_fatt_post, tenant_delta_pct, tenant_costo_pre, tenant_costo_post,
        rete_delta_pct, scarto_da_rete, verdetto, nota)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (tenant_id, giorno_taglio) DO UPDATE SET
        sku_tagliati=EXCLUDED.sku_tagliati, risparmio_click=EXCLUDED.risparmio_click,
        fatturato_perso=EXCLUDED.fatturato_perso, margine_perso=EXCLUDED.margine_perso,
        carrelli_persi=EXCLUDED.carrelli_persi, carrello_perso_eur=EXCLUDED.carrello_perso_eur,
        tenant_fatt_pre=EXCLUDED.tenant_fatt_pre, tenant_fatt_post=EXCLUDED.tenant_fatt_post,
        tenant_delta_pct=EXCLUDED.tenant_delta_pct, rete_delta_pct=EXCLUDED.rete_delta_pct,
        scarto_da_rete=EXCLUDED.scarto_da_rete, verdetto=EXCLUDED.verdetto, nota=EXCLUDED.nota`,
      [tenant.id, g, c.n, risparmio, fattPerso, marginePerso, c.carrelli,
       Number(c.carrello_eur || 0), tPre.netto, tPost.netto, deltaPct,
       cPre.costo, cPost.costo, reteDelta, scarto, verdetto, nota]);

    verdetti.push({ giorno: g, n: c.n, verdetto, nota, risparmio, fattPerso,
                    carrelli: c.carrelli, rientrati: c.rientrati, deltaPct, reteDelta });
  }
  return verdetti;
}

// ─── il controfattuale: mediana della variazione sugli altri operativi ────
async function deltaRete(client, escludi, giorno) {
  const { rows } = await client.query(`
    WITH fin AS (SELECT ($1::date - $2::int) pre_da, ($1::date - 1) pre_a,
                        ($1::date + 1) post_da, ($1::date + $2::int) post_a),
    per_tenant AS (
      SELECT t.id,
        SUM(CASE WHEN (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN f.pre_da AND f.pre_a
                 THEN o.grand_total - COALESCE(o.shipping_incl_tax,0) ELSE 0 END) AS pre,
        SUM(CASE WHEN (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN f.post_da AND f.post_a
                 THEN o.grand_total - COALESCE(o.shipping_incl_tax,0) ELSE 0 END) AS post
      FROM tenants t CROSS JOIN fin f
      JOIN orders o ON o.tenant_id = t.id AND o.order_status = ANY($3)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN f.pre_da AND f.post_a
      WHERE t.status = 'active' AND t.id <> $4
      GROUP BY t.id)
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (post - pre) / pre * 100) AS mediana,
           COUNT(*)::int AS tenant_confrontati
    FROM per_tenant WHERE pre > 0`, [giorno, FINESTRA, ORDER_STATUS, escludi]);
  return { mediana: rows[0].mediana === null ? null : Number(rows[0].mediana),
           n: rows[0].tenant_confrontati };
}

async function runVerdettoTagli() {
  const client = await pool.connect();
  const righe = [];
  try {
    await client.query(`SELECT set_config('xhp.writer', 'verdetto_tagli', true),
      set_config('xhp.motivo', 'misura se dopo i tagli il fatturato scende insieme alla spesa', true)`);

    // il giorno CHIUSO: oggi è parziale e mente
    const { rows: [{ g: giorno }] } = await client.query(
      `SELECT (CURRENT_DATE - 1)::text AS g`);

    const { rows: tenants } = await client.query(`
      SELECT DISTINCT t.id, t.name FROM tenants t
      JOIN feed_actions fa ON fa.tenant_id = t.id AND fa.action = 'REMOVE'
      WHERE t.status = 'active'
        AND fa.computed_at >= NOW() - INTERVAL '30 days'
      ORDER BY t.name`);

    for (const tenant of tenants) {
      try {
        const cpc = await getTenantCpcGross(tenant.id);
        const congelati = await congela(client, tenant, cpc, giorno);
        const rete = await deltaRete(client, tenant.id, giorno);
        const verdetti = await giudica(client, tenant, cpc, giorno, rete.mediana);

        if (congelati) console.log(`[VerdettoTagli] ${tenant.name}: ${congelati} tagli congelati (${giorno})`);
        for (const v of verdetti) {
          console.log(`[VerdettoTagli] ${tenant.name} ${v.giorno}: ${v.verdetto.toUpperCase()} — ${v.nota}`);
          if (v.verdetto === 'allarme') {
            righe.push(`🚨 *${tenant.name}* taglio ${v.giorno} (${v.n} SKU): ${v.nota}`);
          } else if (v.verdetto === 'sorvegliato') {
            righe.push(`👁️ ${tenant.name} taglio ${v.giorno} (${v.n} SKU): ${v.nota}`);
          } else if (v.verdetto === 'sano' && v.risparmio > 0) {
            righe.push(`✅ ${tenant.name} taglio ${v.giorno} (${v.n} SKU): risparmio €${v.risparmio.toFixed(0)}/7gg, fatturato ${v.deltaPct === null ? 'n/d' : v.deltaPct.toFixed(1) + '%'} contro rete ${v.reteDelta === null ? 'n/d' : v.reteDelta.toFixed(1) + '%'}`);
          }
          if (v.rientrati) {
            righe.push(`   ↩️ ${v.rientrati} hanno ripreso a vendere fuori TP: candidati al rientro nel feed`);
          }
        }
      } catch (e) {
        console.error(`[VerdettoTagli] ${tenant.name} ERRORE:`, e.message);
        righe.push(`❌ ${tenant.name}: ${e.message}`);
      }
    }

    if (righe.length) {
      await sendTelegram(`⚖️ *Verdetto sui tagli*\n_costo giù È fatturato su, non l'uno al posto dell'altro_\n\n${righe.join('\n')}`);
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

function startVerdettoTagliCron() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[VerdettoTagli] prossimo run tra ${Math.round(delay / 60000)} min (06:30 UTC / 08:30 IT)`);
    setTimeout(async () => {
      try { await runVerdettoTagli(); } catch (e) { console.error('[VerdettoTagli] ERRORE:', e.message); }
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startVerdettoTagliCron, runVerdettoTagli };
