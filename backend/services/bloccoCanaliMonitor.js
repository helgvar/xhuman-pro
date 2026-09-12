/**
 * bloccoCanaliMonitor.js — sentinella sui canali di ingresso dati.
 * Ordine capo 16/08/2026: «metti un loop di controllo che mi avvisa se ci sono
 * altri blocchi».
 *
 * PERCHE'. L'import Farmabooster è morto il 13/08 alle 20:31 (403 «CSRF token
 * non valido» dopo un loro rilascio) ed è rimasto morto TRE GIORNI senza che
 * nessuno se ne accorgesse: i job fallivano, la coda cresceva, e i motori
 * continuavano a tagliare prezzi su costi vecchi. Nessun canale gridava.
 *
 * COSA GUARDA (cinque canali, ognuno con la sua soglia):
 *   farmabooster    — import prodotti/costi/prezzi   (per tenant)
 *   magento_ordini  — la sola verità sulle vendite   (per tenant)
 *   scraper         — prezzi competitor Trovaprezzi  (globale)
 *   click_tp        — i click giornalieri            (per tenant)
 *   costi           — freschezza registro costi      (per tenant)
 *
 * QUANDO PARLA. Solo sui CAMBI di stato: ok→bloccato (sirena) e bloccato→ok
 * (rientro). Se un blocco dura, ripete al massimo ogni RIPETI_ORE. Un monitor
 * che parla ogni ora diventa rumore, e il prossimo blocco vero passa di nuovo
 * inosservato — che è esattamente come ci siamo persi Farmabooster.
 *
 * SOLO MISURA: legge, scrive il proprio stato, manda Telegram. Non tocca
 * feed, prezzi o azioni.
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

// Soglie di allarme in ore. Tarate sul ritmo reale di ogni canale, con
// margine: l'import prodotti gira ogni ora, gli ordini ogni 15 minuti, lo
// scraper consegna file ogni 15 minuti, i click arrivano una volta al giorno.
const SOGLIE = {
  farmabooster:   6,
  magento_ordini: 3,
  scraper:        6,
  click_tp:       36,   // il file dei click di ieri arriva alle 05:01
  costi:          24,
};

const RIPETI_ORE = 12;        // un blocco che dura si ripete due volte al giorno
const OGNI_MS = 30 * 60 * 1000;

let cronStarted = false;
let inCorso = false;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const eta = (h) => (h == null ? 'mai' : h >= 48 ? `${Math.floor(h / 24)}gg` : `${h.toFixed(1)}h`);

/**
 * Misura l'età del dato più fresco per ogni canale/tenant.
 * Ritorna righe { canale, tenant_id, tenant, eta_ore, dettaglio }.
 * eta_ore NULL = quel canale non ha MAI portato dati (o il tenant non lo usa).
 */
async function misura() {
  const out = [];

  // 1. FARMABOOSTER — ultimo import prodotti riuscito, più l'errore corrente
  const { rows: fb } = await pool.query(`
    SELECT t.id, t.name,
      ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(j.completed_at) FILTER (WHERE j.status='completed')))/3600.0, 1) AS ore,
      COUNT(*) FILTER (WHERE j.status='failed'  AND j.created_at > NOW()-INTERVAL '6 hours') AS falliti,
      COUNT(*) FILTER (WHERE j.status='pending') AS in_coda,
      (SELECT LEFT(REGEXP_REPLACE(j2.error_message, '\\s+', ' ', 'g'), 90)
         FROM import_jobs j2
        WHERE j2.tenant_id=t.id AND j2.job_type='products_sync' AND j2.status='failed'
        ORDER BY j2.created_at DESC LIMIT 1) AS errore
    FROM tenants t LEFT JOIN import_jobs j
      ON j.tenant_id=t.id AND j.job_type='products_sync'
    WHERE t.status='active'
    GROUP BY t.id, t.name`);
  for (const r of fb) {
    const pezzi = [];
    if (r.falliti > 0) pezzi.push(`${r.falliti} falliti/6h`);
    if (r.in_coda > 0) pezzi.push(`${r.in_coda} in coda`);
    if (r.errore) pezzi.push(r.errore);
    out.push({ canale: 'farmabooster', tenant_id: r.id, tenant: r.name,
               eta_ore: r.ore == null ? null : Number(r.ore), dettaglio: pezzi.join(' · ') || null });
  }

  // 2. MAGENTO ORDINI — la sola verità sulle vendite
  const { rows: mg } = await pool.query(`
    SELECT t.id, t.name,
      ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(j.completed_at) FILTER (WHERE j.status='completed')))/3600.0, 1) AS ore,
      COUNT(*) FILTER (WHERE j.status='failed' AND j.created_at > NOW()-INTERVAL '6 hours') AS falliti
    FROM tenants t LEFT JOIN import_jobs j
      ON j.tenant_id=t.id AND j.job_type='orders_sync'
    WHERE t.status='active'
    GROUP BY t.id, t.name`);
  for (const r of mg) {
    out.push({ canale: 'magento_ordini', tenant_id: r.id, tenant: r.name,
               eta_ore: r.ore == null ? null : Number(r.ore),
               dettaglio: r.falliti > 0 ? `${r.falliti} falliti/6h` : null });
  }

  // 3. SCRAPER — canale globale: il file più fresco vale per tutti
  const { rows: sc } = await pool.query(`
    SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(scraped_at)))/3600.0, 1) AS ore,
           COUNT(*) FILTER (WHERE scraped_at > NOW()-INTERVAL '24 hours') AS righe_24h
    FROM scraper_competitors`);
  out.push({ canale: 'scraper', tenant_id: null, tenant: 'rete',
             eta_ore: sc[0].ore == null ? null : Number(sc[0].ore),
             dettaglio: `${Number(sc[0].righe_24h).toLocaleString('it-IT')} righe/24h` });

  // 4. CLICK TP — i tenant col budget esaurito non ricevono click: non è un
  //    guasto, è una scelta. Si escludono (bypass scaduti vanno ignorati).
  const { rows: ck } = await pool.query(`
    SELECT t.id, t.name,
      ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(z.fetch_date::timestamptz)))/3600.0, 1) AS ore,
      EXISTS (SELECT 1 FROM health_config hc
               WHERE hc.tenant_id=t.id AND hc.config_key='tp_budget_exhausted'
                 AND hc.config_value='1') AS budget_finito
    FROM tenants t LEFT JOIN zombie_clicks z ON z.tenant_id=t.id
    WHERE t.status='active'
    GROUP BY t.id, t.name`);
  for (const r of ck) {
    if (r.budget_finito) continue;   // fermo per budget, non per guasto
    out.push({ canale: 'click_tp', tenant_id: r.id, tenant: r.name,
               eta_ore: r.ore == null ? null : Number(r.ore), dettaglio: null });
  }

  // 5. COSTI — quando è entrato l'ultimo listino.
  //    NON si misura su product_cost_history: quello è un registro a GRADINI,
  //    scrive solo quando il costo cambia (mig 093). Un catalogo con i costi
  //    fermi da due giorni non scrive niente pur essendo importato ogni ora —
  //    letto come heartbeat dava 10 tenant "fermi" il 16/08 mentre l'import
  //    girava. La verità sull'ingresso dei costi è l'ultimo products_sync
  //    andato a buon fine: lì dentro i costi passano, cambino o no.
  const { rows: co } = await pool.query(`
    SELECT t.id, t.name,
      ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(j.completed_at)))/3600.0, 1) AS ore
    FROM tenants t
    LEFT JOIN import_jobs j ON j.tenant_id=t.id
         AND j.job_type='products_sync' AND j.status='completed'
    WHERE t.status='active'
    GROUP BY t.id, t.name`);
  for (const r of co) {
    out.push({ canale: 'costi', tenant_id: r.id, tenant: r.name,
               eta_ore: r.ore == null ? null : Number(r.ore), dettaglio: null });
  }

  return out;
}

/**
 * Confronta la misura con lo stato salvato e ritorna solo ciò che è cambiato
 * (o che è rotto da abbastanza tempo da meritare una ripetizione).
 */
async function aggiornaStato(righe) {
  const nuoviBlocchi = [], rientri = [], insistenti = [];

  for (const r of righe) {
    const soglia = SOGLIE[r.canale];
    // eta NULL = nessun dato mai. Per farmabooster/costi su un tenant nuovo
    // sarebbe un falso allarme, ma su un tenant attivo è un blocco vero.
    const bloccato = r.eta_ore == null || r.eta_ore > soglia;
    const stato = bloccato ? 'bloccato' : 'ok';

    const { rows: prec } = await pool.query(
      `SELECT stato, dal, ultimo_avviso_at FROM blocchi_canali_stato
        WHERE canale=$1 AND COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid)
                          = COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`,
      [r.canale, r.tenant_id]);
    const p = prec[0];
    const cambiato = !p || p.stato !== stato;

    let avvisa = false;
    if (cambiato && bloccato) { nuoviBlocchi.push(r); avvisa = true; }
    else if (cambiato && !bloccato && p) { rientri.push({ ...r, da: p.dal }); avvisa = true; }
    else if (bloccato && p && (!p.ultimo_avviso_at ||
             Date.now() - new Date(p.ultimo_avviso_at).getTime() > RIPETI_ORE * 3600 * 1000)) {
      insistenti.push({ ...r, da: p.dal }); avvisa = true;
    }

    await pool.query(`
      INSERT INTO blocchi_canali_stato (canale, tenant_id, stato, eta_ore, dettaglio, dal, ultimo_avviso_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW(),$6,NOW())
      ON CONFLICT (canale, COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET
        stato = EXCLUDED.stato,
        eta_ore = EXCLUDED.eta_ore,
        dettaglio = EXCLUDED.dettaglio,
        dal = CASE WHEN blocchi_canali_stato.stato <> EXCLUDED.stato THEN NOW() ELSE blocchi_canali_stato.dal END,
        ultimo_avviso_at = CASE WHEN $6::timestamptz IS NOT NULL THEN $6 ELSE blocchi_canali_stato.ultimo_avviso_at END,
        updated_at = NOW()`,
      [r.canale, r.tenant_id, stato, r.eta_ore, r.dettaglio, avvisa ? new Date() : null]);
  }

  return { nuoviBlocchi, rientri, insistenti };
}

/** Quanti tagli i motori stanno ancora tentando contro il freeze. */
async function tentativiCongelati() {
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(tentativi),0) AS n, COUNT(DISTINCT sku) AS sku
    FROM price_cut_freeze_log WHERE giorno >= CURRENT_DATE - 1`);
  const { rows: freeze } = await pool.query(
    `SELECT config_value FROM global_config WHERE config_key='price_cut_freeze'`);
  return { attivo: freeze[0]?.config_value === '1', n: Number(rows[0].n), sku: Number(rows[0].sku) };
}

function raggruppa(righe) {
  const per = new Map();
  for (const r of righe) {
    if (!per.has(r.canale)) per.set(r.canale, []);
    per.get(r.canale).push(r);
  }
  return per;
}

function componiMessaggio({ nuoviBlocchi, rientri, insistenti }, freeze) {
  const parti = [];

  if (nuoviBlocchi.length) {
    parti.push('🚨 <b>BLOCCO NUOVO</b>');
    for (const [canale, rr] of raggruppa(nuoviBlocchi)) {
      const nomi = rr.map(r => `${esc(r.tenant)} (${eta(r.eta_ore)})`).join(', ');
      parti.push(`<b>${esc(canale)}</b>: ${nomi}`);
      const det = rr.map(r => r.dettaglio).filter(Boolean)[0];
      if (det) parti.push(`  ${esc(det)}`);
    }
  }

  if (insistenti.length) {
    if (parti.length) parti.push('');
    parti.push('⏳ <b>ancora fermo</b>');
    for (const [canale, rr] of raggruppa(insistenti)) {
      const da = rr[0].da ? new Date(rr[0].da).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?';
      parti.push(`<b>${esc(canale)}</b>: ${rr.length} tenant, dal ${esc(da)}`);
      const det = rr.map(r => r.dettaglio).filter(Boolean)[0];
      if (det) parti.push(`  ${esc(det)}`);
    }
  }

  if (rientri.length) {
    if (parti.length) parti.push('');
    parti.push('✅ <b>rientrati</b>');
    for (const [canale, rr] of raggruppa(rientri)) {
      parti.push(`<b>${esc(canale)}</b>: ${rr.map(r => esc(r.tenant)).join(', ')}`);
    }
  }

  if (parti.length && freeze.attivo) {
    parti.push('');
    parti.push(`🧊 price cut congelati: i motori hanno ritentato ${freeze.n} volte su ${freeze.sku} SKU nelle ultime 24h`);
  }

  return parti.length ? parti.join('\n') : null;
}

async function run(opts = {}) {
  const { silenzioso = false } = opts;
  const righe = await misura();
  const cambi = await aggiornaStato(righe);
  const freeze = await tentativiCongelati();

  const rotti = righe.filter(r => r.eta_ore == null || r.eta_ore > SOGLIE[r.canale]);
  console.log(`[BloccoCanali] ${righe.length} controlli · ${rotti.length} fermi · ` +
    `nuovi ${cambi.nuoviBlocchi.length} · rientri ${cambi.rientri.length} · insistenti ${cambi.insistenti.length}`);
  for (const r of rotti) console.log(`  FERMO ${r.canale}/${r.tenant}: ${eta(r.eta_ore)}${r.dettaglio ? ' — ' + r.dettaglio : ''}`);

  const msg = componiMessaggio(cambi, freeze);
  if (msg && !silenzioso) {
    // Niente key/throttle: la ripetizione è già governata da RIPETI_ORE nello
    // stato persistente. Un throttle in memoria si azzererebbe al restart.
    await sendTelegram(msg, { throttleMs: 0 });
  }
  return { righe, ...cambi, freeze, messaggio: msg };
}

function startBloccoCanaliMonitor() {
  if (cronStarted) return;
  cronStarted = true;

  const giro = async () => {
    if (inCorso) return;
    inCorso = true;
    try { await run(); }
    catch (e) { console.error('[BloccoCanali] errore:', e.message); }
    finally { inCorso = false; }
  };

  setTimeout(giro, 3 * 60 * 1000);   // primo giro 3 minuti dopo l'avvio
  setInterval(giro, OGNI_MS);
  console.log('[BloccoCanali] sentinella attiva — ogni 30 minuti, 5 canali, avvisa sui cambi di stato');
}

module.exports = { startBloccoCanaliMonitor, run, misura, SOGLIE };
