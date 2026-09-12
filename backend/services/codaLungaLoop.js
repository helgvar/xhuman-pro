/**
 * 🔁 LOOP CODA LUNGA v2 zero-conversione (ordine capo 29/7, esteso 12/8) — taglio + retest 7gg/3gg.
 *
 * Colma il GAP dei micro-burner sotto la soglia killer per-SKU: 1-14 click/15gg,
 * 0 vendite su TUTTA la rete 15gg, disponibili. Tagliati dal feed e RITESTATI ogni
 * 7gg per 3gg: se durante il test vendono in rete -> promossi (restano nel feed,
 * escono dal loop), altrimenti ri-tagliati. Niente esilio permanente
 * (feedback_oblio_quarantena_non_per_sempre).
 *
 * v2 (mig 096): perimetro a interruttore health_config 'coda_lunga_on' per tenant
 * (pilota: MPF, 30gg), holdout A/B (metà candidati restano nel feed come gruppo di
 * controllo in coda_lunga_controllo — le loro vendite misurano il fatturato che i
 * tagli avrebbero perso), fail-closed senza file click di ieri, taglio ordinato per
 * click DESC (il cap giornaliero trg_cap_condanne si spende sui più costosi).
 *
 * PARACADUTE FATTURATO (prima di ogni run, per tenant): ordini/revenue di ieri e
 * dell'altro ieri vs baseline stesso giorno-settimana PRE-attivazione
 * (coda_lunga_v2_since). RED due giorni di fila (ordini <70% E revenue <75%) =>
 * il loop si SPEGNE DA SOLO per quel tenant, rilascia tutti gli esiliati del loop
 * e avvisa su Telegram. Multi-evidenza, soglia alta (feedback_supervisor_no_false_alarms).
 *
 * RIENTRO A EVENTO VENDITA: releaseSoldCodaLunga(tenantId) è chiamato da orderSync
 * dopo ogni import ordini — uno SKU esiliato dal loop che risulta venduto (su
 * qualunque farmacia della rete) rientra subito (~1h), senza aspettare il retest.
 *
 * Logica di taglio interamente in DB (codalunga_retest_loop, mig 096): il writer
 * 'sessione_loop_codalunga' bypassa il veto-incidenza sui SOLI rilasci supervisionati;
 * il CUT resta cappato (writer normale 'loop_coda_lunga').
 *
 * Gira alle 03:20 UTC (05:20 IT), dopo riattivazione-margine (03:00), dopo il file
 * click delle 05:01 IT, e prima di burner (05:45)/lima (06:15).
 */
const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

const RUN_HOUR_UTC = 3;
const RUN_MIN_UTC = 20;

const STATUS_WHITELIST = ['processing', 'pending', 'complete', 'ritiro_farmacia', 'Ritirato', 'ritiro_sede_tmp'];
const LOOP_REASON = 'loop_coda_lunga_zero_conv';

/** Tenant attivi con l'interruttore del loop acceso e non scaduto. */
async function getTargets() {
  const { rows } = await pool.query(`
    SELECT t.id, t.name,
      (SELECT h2.config_value FROM health_config h2
        WHERE h2.tenant_id = t.id AND h2.config_key = 'coda_lunga_v2_since') AS since,
      COALESCE((SELECT c.config_value::numeric FROM health_config c
        WHERE c.tenant_id = t.id AND c.config_key = 'avg_tp_cpc'), 0.27) AS cpc
    FROM tenants t
    JOIN health_config hc ON hc.tenant_id = t.id
    WHERE t.status = 'active'
      AND hc.config_key = 'coda_lunga_on' AND hc.config_value = '1'
      AND (hc.expires_at IS NULL OR hc.expires_at > NOW())`);
  return rows;
}

/**
 * Paracadute fatturato: ieri e l'altro ieri vs baseline stesso giorno-settimana
 * PRE-attivazione (fino a 4 campioni su 8 settimane). Ritorna { trip, righe }.
 * Non scatta se un giorno valutato è <= giorno di attivazione (contaminato) o se
 * la baseline è insufficiente (<2 campioni o <5 ordini/g).
 */
async function checkParacadute(tenant) {
  const since = tenant.since;
  if (!since) return { trip: false, righe: ['baseline: data attivazione assente, paracadute non valutabile'] };

  const { rows } = await pool.query(`
    WITH ref AS (
      SELECT (NOW() AT TIME ZONE 'Europe/Rome')::date - 1 AS d1,
             (NOW() AT TIME ZONE 'Europe/Rome')::date - 2 AS d2,
             $2::date AS since
    ),
    giorni AS (SELECT d1 AS d FROM ref UNION ALL SELECT d2 FROM ref),
    eff AS (
      SELECT g.d, COUNT(o.id) AS n, COALESCE(SUM(o.subtotal_incl_tax), 0) AS rev
      FROM giorni g
      LEFT JOIN orders o ON o.tenant_id = $1 AND o.order_date::date = g.d
        AND o.order_status = ANY($3)
      GROUP BY g.d
    ),
    base AS (
      SELECT g.d AS giorno,
             COUNT(DISTINCT s.d) AS n_giorni,
             COUNT(o.id)::numeric / NULLIF(COUNT(DISTINCT s.d), 0) AS ord_avg,
             COALESCE(SUM(o.subtotal_incl_tax), 0) / NULLIF(COUNT(DISTINCT s.d), 0) AS rev_avg
      FROM giorni g
      JOIN LATERAL (
        SELECT g.d - 7 * k AS d FROM generate_series(1, 8) k, ref
        WHERE g.d - 7 * k < ref.since
        ORDER BY 1 DESC LIMIT 4
      ) s ON true
      LEFT JOIN orders o ON o.tenant_id = $1 AND o.order_date::date = s.d
        AND o.order_status = ANY($3)
      GROUP BY g.d
    )
    SELECT e.d, (SELECT since FROM ref) AS since, e.n AS ord_eff, ROUND(e.rev) AS rev_eff,
           b.n_giorni, ROUND(b.ord_avg, 1) AS ord_base, ROUND(b.rev_avg) AS rev_base
    FROM eff e JOIN base b ON b.giorno = e.d
    ORDER BY e.d DESC`, [tenant.id, since, STATUS_WHITELIST]);

  const righe = [];
  let redDays = 0;
  for (const r of rows) {
    if (new Date(r.d) <= new Date(r.since)) { righe.push(`${r.d}: pre/pari attivazione, non valutato`); continue; }
    if (!r.n_giorni || Number(r.n_giorni) < 2 || Number(r.ord_base) < 5) {
      righe.push(`${r.d}: baseline insufficiente (${r.n_giorni || 0} campioni, ${r.ord_base || 0} ord/g)`);
      continue;
    }
    const ordPct = Number(r.ord_eff) / Number(r.ord_base) * 100;
    const revPct = Number(r.rev_eff) / Number(r.rev_base) * 100;
    const red = ordPct < 70 && revPct < 75;
    if (red) redDays++;
    righe.push(`${r.d}: ordini ${r.ord_eff} vs ${r.ord_base} base (${Math.round(ordPct)}%), ` +
      `rev €${r.rev_eff} vs €${r.rev_base} (${Math.round(revPct)}%) ${red ? '🔴' : '🟢'}`);
  }
  return { trip: redDays === 2, righe };
}

/** Auto-spegnimento: interruttori scaduti + rilascio integrale degli esiliati del tenant. */
async function tripParacadute(tenant, righe) {
  const client = await pool.connect();
  let rilasciati = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('xhp.writer', 'sessione_loop_codalunga', true),
      set_config('xhp.motivo', 'PARACADUTE fatturato: 2 giorni RED vs baseline pre-attivazione — auto-spegnimento e rilascio integrale', true)`);
    await client.query(`
      UPDATE health_config SET expires_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1 AND config_key IN ('coda_lunga_on', 'coda_lunga_holdout')`, [tenant.id]);
    const { rows: freed } = await client.query(`
      UPDATE feed_quarantine
      SET reactivated = true, reactivated_at = NOW(),
          observation_start = NULL, observation_end = NULL, reactivation_check_at = NULL
      WHERE tenant_id = $1 AND reason = $2 AND reactivated = false
      RETURNING sku`, [tenant.id, LOOP_REASON]);
    rilasciati = freed.length;
    await client.query(`
      INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio)
      VALUES ($1, NULL, 'paracadute_off', $2)`,
      [tenant.id, `fatturato RED 2 giorni vs baseline: loop spento, ${rilasciati} SKU rilasciati. ${righe.join(' | ')}`]);
    if (rilasciati > 0) {
      await client.query(`
        INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio)
        SELECT $1, unnest($2::text[]), 'rilascio_paracadute', 'rilascio integrale da paracadute fatturato'`,
        [tenant.id, freed.map(r => r.sku)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
  console.error(`[CodaLungaLoop] 🪂 PARACADUTE su ${tenant.name}: loop spento, ${rilasciati} SKU rilasciati`);
  try {
    await sendTelegram(`🪂 <b>PARACADUTE FATTURATO — Loop coda lunga SPENTO su ${tenant.name}</b>\n` +
      `${righe.join('\n')}\n${rilasciati} SKU rilasciati dal loop. Riattivazione: solo a mano (coda_lunga_on).`,
      { key: `codalunga_paracadute_${tenant.id}`, throttleMs: 60 * 60 * 1000 });
  } catch (_) {}
  return rilasciati;
}

/**
 * RIENTRO A EVENTO: rilascia dagli esili del loop (su TUTTE le farmacie) gli SKU
 * appena venduti sul tenant importato. Chiamata da orderSync dopo importOrders.
 */
async function releaseSoldCodaLunga(tenantId) {
  const { rows: [chk] } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM feed_quarantine WHERE reason = $1 AND reactivated = false) AS any`,
    [LOOP_REASON]);
  if (!chk.any) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('xhp.writer', 'sessione_loop_codalunga', true),
      set_config('xhp.motivo', 'rientro a evento: venduto in rete, rilascio immediato dall''esilio coda lunga', true)`);
    const { rows } = await client.query(`
      UPDATE feed_quarantine fq
      SET reactivated = true, reactivated_at = NOW(),
          reason = 'loop_coda_lunga_promosso',
          observation_start = NULL, observation_end = NULL,
          observation_orders = 1, reactivation_check_at = NULL
      WHERE fq.reason = $2 AND fq.reactivated = false
        AND EXISTS (
          SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.sku = fq.sku AND o.tenant_id = $1
            AND o.order_status = ANY($3)
            AND o.order_date >= NOW() - INTERVAL '3 days')
      RETURNING fq.tenant_id, fq.sku`, [tenantId, LOOP_REASON, STATUS_WHITELIST]);
    if (rows.length > 0) {
      await client.query(`
        INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio)
        SELECT tenant_id, sku, 'rientro_evento', 'venduto in rete: rilascio immediato senza aspettare il retest'
        FROM jsonb_to_recordset($1::jsonb) AS x(tenant_id uuid, sku text)`,
        [JSON.stringify(rows)]);
    }
    await client.query('COMMIT');
    if (rows.length > 0) {
      console.log(`[CodaLungaLoop] rientro a evento: ${rows.length} SKU rilasciati (venduti in rete): ${rows.slice(0, 10).map(r => r.sku).join(', ')}${rows.length > 10 ? '…' : ''}`);
      try {
        await sendTelegram(`🔓 <b>Coda lunga — rientro a evento</b>\n${rows.length} SKU esiliati hanno venduto in rete e sono rientrati nel feed subito.`,
          { key: 'codalunga_rientro_evento', throttleMs: 30 * 60 * 1000 });
      } catch (_) {}
    }
    return rows.length;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[CodaLungaLoop] rientro a evento fallito:', e.message);
    return 0;
  } finally {
    client.release();
  }
}

/** Stato del loop + gruppo di controllo per il report giornaliero di un tenant. */
async function statoTenant(tenant) {
  const { rows: [q] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE reason = $2 AND reactivated = false AND observation_start IS NULL) AS in_esilio,
      COUNT(*) FILTER (WHERE reason = $2 AND observation_start IS NOT NULL) AS in_test,
      COUNT(*) FILTER (WHERE reason = 'loop_coda_lunga_promosso') AS promossi
    FROM feed_quarantine WHERE tenant_id = $1`, [tenant.id, LOOP_REASON]);

  const { rows: [clk] } = await pool.query(`
    WITH esil AS (
      SELECT sku, quarantine_start FROM feed_quarantine
      WHERE tenant_id = $1 AND reason = $2 AND reactivated = false)
    SELECT
      COALESCE(SUM(z.clicks) FILTER (WHERE z.fetch_date = (NOW() AT TIME ZONE 'Europe/Rome')::date - 1), 0) AS click_ieri,
      ROUND(COALESCE(SUM(z.clicks) FILTER (
        WHERE z.fetch_date >= e.quarantine_start::date - 7
          AND z.fetch_date < e.quarantine_start::date), 0) / 7.0, 1) AS click_g_pre
    FROM esil e
    JOIN zombie_clicks z ON z.tenant_id = $1 AND z.product_code = e.sku`, [tenant.id, LOOP_REASON]);

  const { rows: [ctl] } = await pool.query(`
    SELECT COUNT(*) AS n,
      COUNT(*) FILTER (WHERE venduto) AS venduti,
      ROUND(COALESCE(SUM(rev), 0)) AS rev,
      COUNT(*) FILTER (WHERE quarantenato) AS contaminati
    FROM (
      SELECT c.sku,
        EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.sku = c.sku AND o.order_status = ANY($2)
            AND o.order_date >= c.listed_at) AS venduto,
        (SELECT COALESCE(SUM(oi.row_total_incl_tax), 0)
          FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE oi.sku = c.sku AND o.order_status = ANY($2)
            AND o.order_date >= c.listed_at) AS rev,
        EXISTS (SELECT 1 FROM feed_quarantine fq
          WHERE fq.tenant_id = c.tenant_id AND fq.sku = c.sku AND fq.reactivated = false) AS quarantenato
      FROM coda_lunga_controllo c WHERE c.tenant_id = $1
    ) x`, [tenant.id, STATUS_WHITELIST]);

  const cpcLordo = Number(tenant.cpc) * 1.22;
  const risparmioG = Math.max(0, Math.round((Number(clk.click_g_pre) - Number(clk.click_ieri)) * cpcLordo));
  return { q, clk, ctl, risparmioG };
}

async function runCodaLungaLoop() {
  let targets;
  try {
    targets = await getTargets();
  } catch (e) {
    console.error('[CodaLungaLoop] lettura perimetro fallita:', e.message);
    return;
  }
  if (targets.length === 0) {
    console.log('[CodaLungaLoop] nessun tenant con coda_lunga_on: run saltato');
    return;
  }

  // Paracadute fatturato PRIMA del taglio: un tenant RED 2 giorni si spegne da
  // solo e la funzione DB (che rilegge il perimetro) lo esclude dal run.
  const paraRighe = {};
  for (const t of targets) {
    try {
      const { trip, righe } = await checkParacadute(t);
      paraRighe[t.id] = righe;
      if (trip) await tripParacadute(t, righe);
    } catch (e) {
      console.error(`[CodaLungaLoop] paracadute ${t.name} errore:`, e.message);
      paraRighe[t.id] = [`paracadute in errore: ${e.message.slice(0, 60)}`];
    }
  }

  const client = await pool.connect();
  let rows;
  try {
    await client.query('BEGIN');
    ({ rows } = await client.query('SELECT phase, n FROM codalunga_retest_loop(false)'));
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[CodaLungaLoop] errore:', e.message);
    client.release();
    return;
  }
  client.release();

  const get = (p) => parseInt(rows.find(r => r.phase === p)?.n || 0);
  const cut = get('cut'), promosso = get('promosso'), ritagliato = get('ritagliato'), aperto = get('test_aperto');
  console.log(`[CodaLungaLoop] cut=${cut} | test aperti=${aperto} | chiusi: promossi=${promosso} ri-taglio=${ritagliato}`);

  // Report per tenant (mai medie): stato loop, risparmio, gruppo di controllo, fatturato vs baseline.
  const blocchi = [];
  for (const t of getTargetsStillOn(targets, paraRighe)) {
    try {
      const s = await statoTenant(t);
      blocchi.push(
        `<b>${t.name}</b>\n` +
        `In esilio: ${s.q.in_esilio} | In test: ${s.q.in_test} | Promossi: ${s.q.promossi}\n` +
        `Click ieri su esiliati: ${s.clk.click_ieri} (pre-taglio ${s.clk.click_g_pre}/g) → risparmio ~€${s.risparmioG}/g\n` +
        `Controllo: ${s.ctl.n} SKU, venduti ${s.ctl.venduti} (€${s.ctl.rev})${Number(s.ctl.contaminati) > 0 ? `, contaminati ${s.ctl.contaminati}` : ''}\n` +
        (paraRighe[t.id] || []).map(r => `Paracadute ${r}`).join('\n')
      );
    } catch (e) {
      blocchi.push(`<b>${t.name}</b>: report in errore (${e.message.slice(0, 60)})`);
    }
  }

  if (cut > 0 || promosso > 0 || aperto > 0 || blocchi.length > 0) {
    try {
      await sendTelegram(`🔁 <b>Loop coda lunga v2</b>\nNuovi tagli: ${cut}. Retest aperti (3gg): ${aperto}. Promossi: ${promosso}. Ri-taglio: ${ritagliato}.\n\n${blocchi.join('\n\n')}`,
        { key: 'codalunga_report', throttleMs: 60 * 60 * 1000 });
    } catch (_) {}
  }
}

/* Tenant ancora accesi dopo il giro di paracadute (chi è scattato è già spento). */
function getTargetsStillOn(targets, paraRighe) {
  return targets.filter(t => !(paraRighe[t.id] || []).some(r => r.includes('auto-spegnimento')));
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, RUN_MIN_UTC, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function startCodaLungaLoop() {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[CodaLungaLoop] armato — prossimo run tra ${Math.round(delay / 60000)} min (03:20 UTC / 05:20 IT)`);
    setTimeout(async () => {
      try { await runCodaLungaLoop(); } catch (_) { /* già loggato */ }
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startCodaLungaLoop, runCodaLungaLoop, releaseSoldCodaLunga };
