/**
 * Monitor coorti di posizione — ordine capo 15/08/2026
 *
 * "lasciala così ma crea un loop di monitoraggio per valutare tutti questi sku
 *  in momenti più giusti dell'anno."
 *
 * IL FATTO. `scraper_competitors.position` è il rango sul PREZZO SECCO. Il
 * cliente su Trovaprezzi ordina sul TOTALE (secco + spedizione). Le due liste
 * non coincidono: ci sono SKU che il sistema crede in vetrina e il cliente non
 * vede mai (FANTASMI), e SKU che il sistema crede fuori mentre il cliente li
 * vede primi (REGALI). Catena del difetto:
 *   farmaboosterProducts.js:126 -> productHealth.js:188 (my_position)
 *   -> product_health_scores.scraper_position -> positionLog.js:53
 *   -> position_snapshots -> gate posizione top10, pepite, sbVisibleSweep
 *
 * LA DECISIONE DEL CAPO. Non si corregge. La misura del 15/8 dice che i
 * fantasmi rendono MEGLIO della vetrina vera (6,0% vs 6,8% di incidenza), e
 * correggere il gate avrebbe tagliato 19.635 SKU che fanno €48.497 in 15
 * giorni. Ma quella misura è stata presa nella settimana di Ferragosto, la meno
 * rappresentativa dell'anno. Quindi: non si tocca niente e si tiene il registro
 * finché non arriva un periodo giudicabile.
 *
 * COSA FA QUESTO LOOP. Solo misura. Nessun motore lo legge per agire.
 *  1. ogni giorno classifica ogni SKU pubblicato su TP in 6 coorti e scrive la
 *     storia A GRADINI (solo quando la coorte cambia o il rango si muove >= 3).
 *     Serve perché scraper_competitors ha retention 7 giorni: senza registro, a
 *     settembre la storia di agosto non esiste più.
 *  2. aggrega per giorno x coorte click, costo, ordini, fatturato.
 *  3. marca i giorni NON giudicabili: Ferragosto, Natale, budget TP esaurito,
 *     e i crolli di click sotto la metà della mediana (feed fermo, TP giù...).
 *  4. quando i giorni validi accumulati bastano, `verdetto()` risponde. Prima
 *     di allora dice quanti giorni mancano e si rifiuta di concludere.
 *
 * Il verdetto NON esegue: produce numeri per il capo.
 */

const { pool } = require('../db/pool');
const { getTenantCpcGross } = require('./cpcConfig');
const { sendTelegram } = require('./telegramNotifier');

const ORDER_OK = ['pending', 'processing', 'complete', 'ritiro_farmacia', 'Ritirato', 'ritiro_sede_tmp'];

// Un gradino nuovo si scrive solo se la coorte cambia o il rango balla >= 3
// posizioni: sotto è rumore di rotazione dello scraper, non un movimento.
const DELTA_RANGO = 3;

// Giorni dell'anno in cui la domanda non è quella vera. Non si giudica qui.
// Formato MM-DD, estremi inclusi; l'intervallo di Natale scavalca l'anno.
const STAGIONI_MORTE = [
  { da: '08-01', a: '08-25', nome: 'Ferragosto' },
  { da: '12-20', a: '01-06', nome: 'Natale/Capodanno' },
];

// Un giorno con meno della metà dei click della mediana recente non è un giorno
// normale: budget finito, feed fermo, TP in avaria. Fuori dal verdetto.
const CROLLO_CLICK_PCT = 0.5;
const MEDIANA_GIORNI = 60;

// Soglie per poter concludere qualcosa. Sotto queste il verdetto tace.
const MIN_GIORNI_VALIDI = 30;    // un mese pieno di domanda normale
const MIN_CLICK_COORTE = 300;    // sotto: la conversione è rumore
const RIAGGREGA_GIORNI = 7;      // gli ordini arrivano in ritardo: si rifà una settimana

const MERCHANT_MAP = `
  SELECT * FROM (VALUES
    ('SubitoFarma','subitofarma'), ('Farmacia San Vito','san vito'), ('MPF','personal farma'),
    ('Papa','farmacia papa'), ('Farmacia Procaccini','procaccini'), ('Farmacri','farmacri'),
    ('Farmainsieme','farmainsieme'), ('Farmacia Mandanici','mandanici'),
    ('Farmacia Ospedale','ospedale'), ('Farmastelia','farmastelia')) m(tenant_name, rx)`;

/**
 * Coorte da (rango secco, rango totale). Stessa griglia della misura del 15/8.
 *   1 VETRINA VERA · 2 FANTASMA 11-20 · 3 FANTASMA 21-30 · 4 FANTASMA >30
 *   5 REGALO (top10 vero che il sistema non vede) · 6 FUORI VETRINA
 */
const CASE_COORTE = `
  CASE
    WHEN r_secco <= 10 AND r_totale <= 10 THEN 1
    WHEN r_secco <= 10 AND r_totale <= 20 THEN 2
    WHEN r_secco <= 10 AND r_totale <= 30 THEN 3
    WHEN r_secco <= 10                    THEN 4
    WHEN r_totale <= 10                   THEN 5
    ELSE 6
  END`;

function iso(d) { return d.toISOString().slice(0, 10); }

function oggiRoma() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
}

/** Il giorno cade in una stagione morta? Ritorna il nome, o null. */
function stagioneMorta(dataIso) {
  const md = dataIso.slice(5);
  for (const s of STAGIONI_MORTE) {
    const dentro = s.da <= s.a
      ? (md >= s.da && md <= s.a)          // intervallo normale
      : (md >= s.da || md <= s.a);         // scavalca capodanno
    if (dentro) return s.nome;
  }
  return null;
}

/**
 * PASSO 1 — classifica oggi e scrive i gradini.
 * Un tenant entra solo se il suo merchant compare nel dump scraper fresco:
 * se non c'è, su quel prodotto non siamo pubblicati e non c'è niente da dire.
 */
async function classificaOggi(dataIso) {
  const { rows: [fresh] } = await pool.query(`
    SELECT COUNT(DISTINCT product_code)::int AS n FROM scraper_competitors
    WHERE scraped_at >= NOW() - INTERVAL '48 hours'`);
  // Dump decimato = ranghi falsi. Meglio nessun gradino che un gradino sbagliato.
  if (fresh.n < 30000) {
    console.log(`[CoortiPos] classificazione SALTATA: dump magro (${fresh.n} MINSAN freschi, minimo 30000)`);
    return { saltato: true, minsan: fresh.n };
  }

  const { rowCount } = await pool.query(`
    WITH merchant_map AS (${MERCHANT_MAP}),
    ranghi AS (
      SELECT sc.product_code, sc.merchant, sc.base_price, sc.total_price, sc.shipping_cost,
        RANK() OVER (PARTITION BY sc.product_code ORDER BY sc.base_price)::int  AS r_secco,
        RANK() OVER (PARTITION BY sc.product_code ORDER BY sc.total_price)::int AS r_totale,
        COUNT(*) OVER (PARTITION BY sc.product_code)::int AS n_comp
      FROM scraper_competitors sc
      WHERE sc.scraped_at >= NOW() - INTERVAL '48 hours'
        AND sc.base_price > 0 AND sc.total_price > 0
    ),
    nostri AS (
      SELECT t.id AS tenant_id, r.product_code AS sku, r.r_secco, r.r_totale,
             r.base_price, r.total_price, r.shipping_cost, r.n_comp
      FROM ranghi r
      JOIN merchant_map mm ON r.merchant ~* mm.rx
      JOIN tenants t ON t.name = mm.tenant_name AND t.status = 'active'
    ),
    con_coorte AS (
      SELECT n.*, ${CASE_COORTE} AS coorte FROM nostri n
    ),
    precedente AS (
      SELECT DISTINCT ON (c.tenant_id, c.sku)
             c.tenant_id, c.sku, s.coorte AS coorte_prec, s.r_totale AS rt_prec, s.r_secco AS rs_prec
      FROM con_coorte c
      JOIN coorti_posizione_sku s ON s.tenant_id = c.tenant_id AND s.sku = c.sku AND s.snap_date <= $1::date
      ORDER BY c.tenant_id, c.sku, s.snap_date DESC
    )
    INSERT INTO coorti_posizione_sku
      (tenant_id, sku, snap_date, coorte, r_secco, r_totale, base_price, total_price, spedizione, competitor_count)
    SELECT c.tenant_id, c.sku, $1::date, c.coorte, c.r_secco, c.r_totale,
           c.base_price, c.total_price, c.shipping_cost, c.n_comp
    FROM con_coorte c
    LEFT JOIN precedente p ON p.tenant_id = c.tenant_id AND p.sku = c.sku
    WHERE p.sku IS NULL                                    -- mai visto: primo gradino
       OR p.coorte_prec <> c.coorte                        -- ha cambiato coorte
       OR ABS(COALESCE(p.rt_prec, 999) - c.r_totale) >= $2 -- il totale si è mosso davvero
       OR ABS(COALESCE(p.rs_prec, 999) - c.r_secco)  >= $2
    ON CONFLICT (tenant_id, sku, snap_date) DO UPDATE SET
      coorte = EXCLUDED.coorte, r_secco = EXCLUDED.r_secco, r_totale = EXCLUDED.r_totale,
      base_price = EXCLUDED.base_price, total_price = EXCLUDED.total_price,
      spedizione = EXCLUDED.spedizione, competitor_count = EXCLUDED.competitor_count`,
    [dataIso, DELTA_RANGO]);

  return { saltato: false, gradini: rowCount, minsan: fresh.n };
}

/**
 * Il giorno è giudicabile per questo tenant? Tre motivi per dire di no:
 * stagione morta, budget TP esaurito, crollo di click sotto metà mediana.
 */
async function validitaGiorno(tenantId, dataIso) {
  const stagione = stagioneMorta(dataIso);
  if (stagione) return { valida: false, motivo: `stagione morta (${stagione})` };

  const { rows: [b] } = await pool.query(`
    SELECT 1 FROM health_config
    WHERE tenant_id = $1 AND config_key = 'tp_budget_exhausted' AND config_value = '1'
      AND (expires_at IS NULL OR expires_at > $2::date)
    LIMIT 1`, [tenantId, dataIso]);
  if (b) return { valida: false, motivo: 'budget TP esaurito' };

  const { rows: [c] } = await pool.query(`
    WITH giorni AS (
      SELECT fetch_date, SUM(clicks)::int AS click
      FROM zombie_clicks
      WHERE tenant_id = $1 AND fetch_date BETWEEN $2::date - $3::int AND $2::date
      GROUP BY 1
    )
    SELECT
      COALESCE((SELECT click FROM giorni WHERE fetch_date = $2::date), 0) AS oggi,
      COALESCE((SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY click)
                FROM giorni WHERE fetch_date < $2::date), 0)::numeric AS mediana`,
    [tenantId, dataIso, MEDIANA_GIORNI]);

  const mediana = parseFloat(c.mediana) || 0;
  const oggi = parseInt(c.oggi) || 0;
  // Senza storia non si può dire che sia anomalo: si tiene.
  if (mediana > 0 && oggi < mediana * CROLLO_CLICK_PCT) {
    return { valida: false, motivo: `crollo click (${oggi} vs mediana ${Math.round(mediana)})` };
  }
  return { valida: true, motivo: null };
}

/**
 * PASSO 2 — aggrega un giorno per coorte.
 * La coorte del giorno D è l'ultimo gradino con snap_date <= D: è così che i
 * gradini si rileggono. Se non c'è nessun gradino a quella data, il giorno non
 * esiste per noi (prima dell'accensione del loop) e si salta.
 */
async function aggregaGiorno(tenant, dataIso) {
  const cpcGross = await getTenantCpcGross(tenant.id);
  const { valida, motivo } = await validitaGiorno(tenant.id, dataIso);

  const { rows } = await pool.query(`
    WITH coorte_al AS (
      SELECT DISTINCT ON (tenant_id, sku) tenant_id, sku, coorte
      FROM coorti_posizione_sku
      WHERE tenant_id = $1 AND snap_date <= $2::date
      ORDER BY tenant_id, sku, snap_date DESC
    ),
    cl AS (
      SELECT product_code AS sku, SUM(clicks)::int AS click
      FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date = $2::date
      GROUP BY 1
    ),
    ord AS (
      SELECT oi.sku,
             COUNT(DISTINCT o.id)::int AS ordini,
             SUM(oi.qty_ordered)::numeric AS pezzi,
             SUM(COALESCE(oi.row_total_incl_tax, 0))::numeric AS fatturato
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1 AND o.order_status = ANY($3)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date = $2::date
      GROUP BY 1
    )
    SELECT c.coorte,
      COUNT(*)::int AS sku_totali,
      COUNT(*) FILTER (WHERE COALESCE(cl.click, 0) > 0)::int AS sku_cliccati,
      COALESCE(SUM(cl.click), 0)::int AS click,
      COALESCE(SUM(ord.ordini), 0)::int AS ordini,
      COALESCE(SUM(ord.pezzi), 0)::numeric AS pezzi,
      COALESCE(SUM(ord.fatturato), 0)::numeric AS fatturato
    FROM coorte_al c
    LEFT JOIN cl  ON cl.sku = c.sku
    LEFT JOIN ord ON ord.sku = c.sku
    GROUP BY c.coorte`, [tenant.id, dataIso, ORDER_OK]);

  if (!rows.length) return { scritte: 0, valida, motivo };

  for (const r of rows) {
    await pool.query(`
      INSERT INTO coorti_posizione_giorno
        (tenant_id, snap_date, coorte, sku_totali, sku_cliccati, click, costo,
         ordini, pezzi, fatturato, finestra_valida, motivo_esclusione, updated_at)
      VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (tenant_id, snap_date, coorte) DO UPDATE SET
        sku_totali = EXCLUDED.sku_totali, sku_cliccati = EXCLUDED.sku_cliccati,
        click = EXCLUDED.click, costo = EXCLUDED.costo, ordini = EXCLUDED.ordini,
        pezzi = EXCLUDED.pezzi, fatturato = EXCLUDED.fatturato,
        finestra_valida = EXCLUDED.finestra_valida,
        motivo_esclusione = EXCLUDED.motivo_esclusione, updated_at = NOW()`,
      [tenant.id, dataIso, r.coorte, r.sku_totali, r.sku_cliccati, r.click,
       +(r.click * cpcGross).toFixed(2), r.ordini, Math.round(r.pezzi), +(+r.fatturato).toFixed(2),
       valida, motivo]);
  }
  return { scritte: rows.length, valida, motivo };
}

/**
 * PASSO 3 — il verdetto. Non conclude niente finché non ci sono abbastanza
 * giorni validi e abbastanza click per coorte: dice cosa manca e si ferma.
 */
async function verdetto(opts = {}) {
  const minGiorni = opts.minGiorni || MIN_GIORNI_VALIDI;
  const minClick = opts.minClick || MIN_CLICK_COORTE;

  const { rows } = await pool.query(`
    SELECT t.name AS tenant, g.tenant_id, g.coorte, l.nome AS coorte_nome,
      COUNT(DISTINCT g.snap_date)::int AS giorni,
      SUM(g.click)::int AS click, SUM(g.costo)::numeric AS costo,
      SUM(g.ordini)::int AS ordini, SUM(g.fatturato)::numeric AS fatturato,
      ROUND(AVG(g.sku_totali))::int AS sku_medi
    FROM coorti_posizione_giorno g
    JOIN tenants t ON t.id = g.tenant_id
    JOIN coorti_posizione_legenda l ON l.coorte = g.coorte
    WHERE g.finestra_valida
      AND ($1::date IS NULL OR g.snap_date >= $1::date)
      AND ($2::date IS NULL OR g.snap_date <= $2::date)
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 3`, [opts.da || null, opts.a || null]);

  const giorniValidi = rows.length ? Math.max(...rows.map(r => r.giorni)) : 0;
  const righe = rows.map(r => {
    const costo = +(+r.costo).toFixed(2);
    const fatturato = +(+r.fatturato).toFixed(2);
    return {
      tenant: r.tenant, coorte: r.coorte, nome: r.coorte_nome, giorni: r.giorni,
      skuMedi: r.sku_medi, click: r.click, costo, ordini: r.ordini, fatturato,
      incidenza: fatturato > 0 ? +(costo / fatturato * 100).toFixed(2) : null,
      conversione: r.click > 0 ? +(r.ordini / r.click * 100).toFixed(2) : null,
      giudicabile: r.giorni >= minGiorni && r.click >= minClick,
    };
  });

  const pronte = righe.filter(r => r.giudicabile);
  const mancanti = [];
  if (giorniValidi < minGiorni) mancanti.push(`giorni validi ${giorniValidi}/${minGiorni}`);
  if (!pronte.length) mancanti.push(`nessuna coorte oltre ${minClick} click`);

  return {
    pronto: mancanti.length === 0,
    mancanti,
    giorniValidi,
    righe,
    // Le due coorti che decidono se il misuratore va corretto: la vetrina che
    // il sistema protegge (1) contro i fantasmi che crede di proteggere (2/3/4).
    confronto: pronte.length ? confrontoVetrinaFantasmi(pronte) : null,
  };
}

function confrontoVetrinaFantasmi(righe) {
  const agg = (filtro) => {
    const sel = righe.filter(filtro);
    const costo = sel.reduce((s, r) => s + r.costo, 0);
    const fatturato = sel.reduce((s, r) => s + r.fatturato, 0);
    const click = sel.reduce((s, r) => s + r.click, 0);
    const ordini = sel.reduce((s, r) => s + r.ordini, 0);
    return {
      sku: sel.reduce((s, r) => s + r.skuMedi, 0), click, ordini,
      costo: +costo.toFixed(2), fatturato: +fatturato.toFixed(2),
      incidenza: fatturato > 0 ? +(costo / fatturato * 100).toFixed(2) : null,
      conversione: click > 0 ? +(ordini / click * 100).toFixed(2) : null,
    };
  };
  return {
    vetrinaVera: agg(r => r.coorte === 1),
    fantasmi: agg(r => r.coorte >= 2 && r.coorte <= 4),
    regali: agg(r => r.coorte === 5),
  };
}

/** Un giro: classifica oggi, riaggrega l'ultima settimana. */
async function run(opts = {}) {
  const oggi = opts.data ? new Date(opts.data) : oggiRoma();
  const oggiIso = iso(oggi);

  const cls = await classificaOggi(oggiIso);
  console.log(cls.saltato
    ? `[CoortiPos] ${oggiIso}: classificazione saltata`
    : `[CoortiPos] ${oggiIso}: ${cls.gradini} gradini scritti su ${cls.minsan} MINSAN freschi`);

  const { rows: tenants } = await pool.query(
    `SELECT id, name FROM tenants WHERE status = 'active' ORDER BY name`);

  // Si riaggrega una settimana indietro: gli ordini arrivano con ritardo di
  // sync e un giorno chiuso ieri può cambiare fatturato oggi.
  const esiti = [];
  for (let k = 0; k < RIAGGREGA_GIORNI; k++) {
    const d = new Date(oggi); d.setDate(d.getDate() - k);
    const dIso = iso(d);
    for (const t of tenants) {
      try {
        const e = await aggregaGiorno(t, dIso);
        if (k === 0) esiti.push({ tenant: t.name, ...e });
      } catch (err) {
        console.error(`[CoortiPos] ${t.name} ${dIso}: ${err.message}`);
      }
    }
  }

  for (const e of esiti) {
    console.log(`[CoortiPos]   ${e.tenant}: ${e.scritte} coorti — giorno ${e.valida ? 'VALIDO' : `ESCLUSO (${e.motivo})`}`);
  }

  const v = await verdetto();
  console.log(v.pronto
    ? `[CoortiPos] VERDETTO PRONTO — ${v.giorniValidi} giorni validi accumulati`
    : `[CoortiPos] verdetto non ancora giudicabile: ${v.mancanti.join(' · ')}`);

  // Si avvisa una volta sola quando la finestra diventa giudicabile: da lì in
  // poi la decisione sul misuratore di posizione è del capo, non del cron.
  if (v.pronto && !opts.silenzioso) {
    const c = v.confronto;
    const riga = (n, x) => `${n}: ${x.sku} SKU · ${x.click} click · €${x.costo} · €${x.fatturato} · inc ${x.incidenza}% · conv ${x.conversione}%`;
    let msg = `📐 <b>Coorti posizione — finestra giudicabile</b>\n`;
    msg += `${v.giorniValidi} giorni di domanda normale accumulati.\n\n`;
    msg += `${riga('Vetrina vera', c.vetrinaVera)}\n${riga('Fantasmi 11+', c.fantasmi)}\n${riga('Regali', c.regali)}\n\n`;
    msg += `Ora si può decidere se il misuratore di posizione (rango sul secco) va corretto sul totale.`;
    try { await sendTelegram(msg, { key: 'coorti_posizione', parseMode: 'HTML', throttleMs: 7 * 24 * 3600 * 1000 }); } catch {}
  }

  return { data: oggiIso, classificazione: cls, esiti, verdetto: v };
}

// --- cron: una volta al giorno alle 10:30 italia. Il file click di TP arriva
// alle 05:01 e lo scraper del mattino è già dentro; positionLog gira alle 09:45.
let cronStarted = false;
let inCorso = false;

function startCoortiPosizioneMonitor() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const now = new Date();
    // 08:30 UTC = 10:30 italia in ora legale
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 30, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      if (!inCorso) {
        inCorso = true;
        try { await run(); } catch (e) { console.error('[CoortiPos] errore giro:', e.message); }
        finally { inCorso = false; }
      }
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[CoortiPos] loop attivo — giornaliero 08:30 UTC (10:30 italia), solo misura, non tocca niente');
}

module.exports = {
  run, classificaOggi, aggregaGiorno, validitaGiorno, verdetto, stagioneMorta,
  startCoortiPosizioneMonitor,
  MIN_GIORNI_VALIDI, MIN_CLICK_COORTE, STAGIONI_MORTE, DELTA_RANGO,
};
