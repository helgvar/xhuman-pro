/**
 * Test feed 24h — Papa, giovedì 6 agosto 2026.
 *
 * Ordine del capo (5/8, testuale): "alle 00:00 di Giovedì 6 agosto solo ed
 * esclusivamente su papa inviamo nel feed solo i 4.393 prodotti che generano
 * il fatturato degli ultimi 90gg [...] il feed va resettato alle 00:15 del
 * giorno 7 agosto."
 *
 * Cosa fa questo servizio, e nient'altro:
 *   1. Alle 00:00 del 6/8 accende su Papa il flag health_config
 *      feed_forced_whitelist = TEST_LABEL, e il bypass del paracadute feed.
 *      Prima di accenderlo salva una copia del feed corrente.
 *   2. Ogni 2 ore scrive una riga in feed_test_log: click e ordini cumulati
 *      del giorno, con i cumulati degli 8 giovedì precedenti alla stessa ora.
 *   3. Alle 00:00 del 1/9 spegne tutto e rigenera il feed normale.
 *
 * È un RICONCILIATORE, non una sveglia: a ogni giro confronta lo stato voluto
 * con lo stato reale del DB e corregge. Se il container riparte a metà test,
 * al giro dopo lo stato è di nuovo quello giusto — e se riparte dopo la fine,
 * trova il flag già scaduto e ripulisce comunque.
 *
 * PERIMETRO: un solo tenant, scritto in chiaro qui sotto. Nessun altro tenant
 * viene letto né scritto da questo file.
 */

const { pool } = require('../db/pool');
const { recalculateStableCache } = require('../routes/externalApi');
const rootLogger = require('./logger');
const logger = rootLogger.with({ source: 'feedTestPapa' });

const TENANT_ID = '6a1217ad-b605-4517-a630-a40bb24eaf9d';   // Papa — e nessun altro
const TEST_LABEL = 'papa_90gg_0608';

// Confini del test in UTC (il DB è in UTC, l'ordine del capo è in ora italiana).
// 6/8 00:00 ITA = 5/8 22:00 UTC · fine 1/9 00:00 ITA = 31/8 22:00 UTC
// Prorogato dal capo il 6/8: da una giornata sola a una settimana piena, così
// il confronto prende sette giorni interi e non un mercoledì contro un giovedì.
// Prorogato di nuovo l'11/8 fino a fine mese: il test regge il budget di Papa
// (111 EUR/giorno, proiezione 3.455 contro un tetto di ~4.900) e ha ucciso il
// 97,8% dei click di spreco. Questa data è la verità: il riconciliatore
// riscrive expires_at a ogni accensione, quindi cambiare la riga in
// health_config senza toccare questa costante non proroga niente.
const START_UTC = new Date('2026-08-05T22:00:00Z');
const END_UTC   = new Date('2026-08-31T22:00:00Z');

const TICK_MS = 60 * 1000;
const LOG_EVERY_HOURS = 2;
const WHITELIST_STATI_ORDINE = ['processing', 'pending', 'complete', 'ritiro_farmacia', 'Ritirato'];

let timer = null;
let lastLoggedSlot = null;   // 'YYYY-MM-DD HH' dell'ultimo log scritto
let abortito = false;        // salvavita scattato: non si ritenta ogni 60s

async function notify(msg) {
  try {
    const { sendTelegram } = require('./telegramNotifier');
    await sendTelegram(msg);
  } catch (e) { console.error('[FeedTestPapa] telegram:', e.message); }
}

// ─── Stato ───────────────────────────────────────────────

async function flagAcceso() {
  const { rows } = await pool.query(
    `SELECT 1 FROM health_config
     WHERE tenant_id = $1 AND config_key = 'feed_forced_whitelist'
       AND config_value = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
    [TENANT_ID, TEST_LABEL]);
  return rows.length > 0;
}

async function accendi() {
  const { rows: [wl] } = await pool.query(
    `SELECT count(*)::int AS n FROM feed_test_whitelist
     WHERE tenant_id = $1 AND test_label = $2`, [TENANT_ID, TEST_LABEL]);
  if (!wl || wl.n === 0) {
    console.error('[FeedTestPapa] whitelist vuota — test NON avviato');
    await notify('🔬 <b>Test feed Papa</b>: whitelist vuota, test NON avviato.');
    return;
  }

  // Copia di sicurezza del feed corrente: la scadenza del flag basta a
  // tornare indietro, ma se qualcosa va storto questa è la via dura.
  await pool.query(
    `INSERT INTO tenant_configs (tenant_id, config_key, config_value)
     SELECT tenant_id, 'stable_feed_codes_backup_' || $2, config_value
     FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'stable_feed_codes'
     ON CONFLICT (tenant_id, config_key) DO NOTHING`,
    [TENANT_ID, TEST_LABEL]);

  const expires = END_UTC.toISOString();

  // Il flag della whitelist.
  await pool.query(
    `INSERT INTO health_config (tenant_id, config_key, config_value, expires_at)
     VALUES ($1, 'feed_forced_whitelist', $2, $3)
     ON CONFLICT (tenant_id, config_key)
     DO UPDATE SET config_value = $2, expires_at = $3, updated_at = NOW()`,
    [TENANT_ID, TEST_LABEL, expires]);

  // Il paracadute feed blocca ogni build che restringe il CSV oltre il 10%:
  // qui la restrizione è voluta ed è dell'ordine dell'80%. Il bypass scade
  // con il test, così il paracadute torna armato da solo il 12.
  await pool.query(
    `INSERT INTO health_config (tenant_id, config_key, config_value, expires_at)
     VALUES ($1, 'feed_drop_guard_off', '1', $2)
     ON CONFLICT (tenant_id, config_key)
     DO UPDATE SET config_value = '1', expires_at = $2, updated_at = NOW()`,
    [TENANT_ID, expires]);

  const prima = await feedSize();
  const r = await recalculateStableCache(TENANT_ID);
  const dopo = r.feedCodes?.length || 0;

  // Salvavita: l'accensione avviene a mezzanotte, senza nessuno a guardare.
  // La whitelist vale ~4.200 vendibili su 4.393 congelati; se ne uscissero
  // meno di mille vuol dire che qualcosa si è rotto (stock azzerato, join a
  // vuoto, lista sbagliata) e Papa resterebbe in vetrina con quattro gatti
  // per una settimana. In quel caso si torna indietro subito e si sveglia il capo.
  if (dopo < 1000) {
    await pool.query(
      `DELETE FROM health_config WHERE tenant_id = $1
       AND config_key IN ('feed_forced_whitelist', 'feed_drop_guard_off')`, [TENANT_ID]);
    abortito = true;
    const rb = await recalculateStableCache(TENANT_ID);
    console.error(`[FeedTestPapa] 🚨 ABORTITO: la build ha dato ${dopo} prodotti (attesi ~4.200) — feed ripristinato a ${rb.feedCodes?.length || 0}`);
    await notify(
      `🚨 <b>TEST FEED PAPA ABORTITO</b>\n` +
      `La build ha dato solo <b>${dopo}</b> prodotti (attesi ~4.200).\n` +
      `Feed ripristinato a ${rb.feedCodes?.length || 0}. Test NON partito.`);
    return;
  }

  console.log(`[FeedTestPapa] ▶ TEST ACCESO: feed ${prima} -> ${dopo} (whitelist ${wl.n} SKU)`);
  logger.info(`Test acceso: feed ${prima} -> ${dopo}`, { tenantId: TENANT_ID });
  await notify(
    `🔬 <b>TEST FEED PAPA ACCESO</b>\n` +
    `Feed civetta=1: <b>${prima} → ${dopo}</b> (whitelist ${wl.n} SKU venditori 90gg)\n` +
    `Reset automatico: 1/9 alle 00:00. Log ogni 2 ore.\n` +
    `Nessun altro tenant toccato.`);
  await scriviLog('test', dopo, 'accensione');
}

async function spegni() {
  await pool.query(
    `DELETE FROM health_config WHERE tenant_id = $1
     AND config_key IN ('feed_forced_whitelist', 'feed_drop_guard_off')`,
    [TENANT_ID]);

  const prima = await feedSize();
  const r = await recalculateStableCache(TENANT_ID);
  const dopo = r.feedCodes?.length || 0;

  console.log(`[FeedTestPapa] ⏹ TEST SPENTO: feed ${prima} -> ${dopo}`);
  logger.info(`Test spento: feed ${prima} -> ${dopo}`, { tenantId: TENANT_ID });
  await notify(
    `🔬 <b>TEST FEED PAPA CHIUSO</b>\n` +
    `Feed civetta=1: <b>${prima} → ${dopo}</b> — regole normali ripristinate.\n` +
    `Paracadute feed di nuovo armato.`);
  await scriviLog('post', dopo, 'spegnimento');
}

async function feedSize() {
  const { rows: [r] } = await pool.query(
    `SELECT jsonb_array_length(config_value::jsonb->'codes') AS n
     FROM tenant_configs WHERE tenant_id = $1 AND config_key = 'stable_feed_codes'`,
    [TENANT_ID]);
  return r?.n || 0;
}

// ─── Log ogni 2 ore ──────────────────────────────────────

/**
 * I click di Trovaprezzi arrivano in zombie_clicks una volta al giorno, alle
 * 05:01, e riguardano il giorno PRIMA. Per avere la curva oraria durante il
 * test bisogna innescare il fetch a mano: persistToDb riscrive la riga del
 * giorno, quindi ogni fetch dà il cumulato aggiornato. Lo snapshot in
 * feed_test_log è l'unico posto dove quella curva sopravvive.
 * skipFtp=true: leggiamo i click, non tocchiamo l'export.
 */
async function aggiornaClick(giornoIta) {
  try {
    const zombieService = require('./zombieService');
    await zombieService.runForTenant(TENANT_ID, giornoIta, true);
    return true;
  } catch (e) {
    console.error('[FeedTestPapa] fetch click fallito:', e.message);
    return false;
  }
}

async function scriviLog(phase, feedSizeNow, nota) {
  const { rows: [now] } = await pool.query(
    `SELECT (NOW() AT TIME ZONE 'Europe/Rome')::date AS oggi,
            extract(hour FROM (NOW() AT TIME ZONE 'Europe/Rome'))::int AS ora`);
  const oggi = now.oggi.toISOString ? now.oggi.toISOString().slice(0, 10) : String(now.oggi).slice(0, 10);
  const ora = now.ora;

  const clickFresco = await aggiornaClick(oggi);

  // Click cumulati del giorno (una riga per SKU, sovrascritta a ogni fetch).
  const { rows: [cl] } = await pool.query(
    `SELECT COALESCE(sum(clicks), 0)::int AS click
     FROM zombie_clicks WHERE tenant_id = $1 AND fetch_date = $2::date`,
    [TENANT_ID, oggi]);

  // Ordini cumulati di oggi fino a quest'ora.
  const { rows: [od] } = await pool.query(
    `SELECT count(*)::int AS ordini, COALESCE(sum(o.grand_total), 0)::numeric(12,2) AS fatt
     FROM orders o
     WHERE o.tenant_id = $1 AND o.order_status = ANY($2)
       AND (o.order_date AT TIME ZONE 'Europe/Rome')::date = $3::date
       AND extract(hour FROM (o.order_date AT TIME ZONE 'Europe/Rome')) < $4`,
    [TENANT_ID, WHITELIST_STATI_ORDINE, oggi, ora + 1]);

  // Baseline: gli 8 stessi-giorni-della-settimana precedenti, stessi cumulati
  // alla stessa ora. Il giorno NON è inchiodato al giovedì: il test dura una
  // settimana, e un martedì va confrontato con i martedì, non col giorno in cui
  // il test è cominciato.
  // Sui click il confronto è onesto solo a giornata chiusa: lo storico ha il
  // totale del giorno, non la curva oraria — qui sta il totale, marcato.
  const { rows: base } = await pool.query(
    `WITH giovedi AS (
       SELECT DISTINCT (o.order_date AT TIME ZONE 'Europe/Rome')::date AS g
       FROM orders o
       WHERE o.tenant_id = $1
         AND extract(dow FROM (o.order_date AT TIME ZONE 'Europe/Rome'))
             = extract(dow FROM $3::date)
         AND (o.order_date AT TIME ZONE 'Europe/Rome')::date < $3::date
       ORDER BY 1 DESC LIMIT 8)
     SELECT g.g::text AS giovedi,
            count(o.id)::int AS ordini,
            COALESCE(sum(o.grand_total), 0)::numeric(12,2) AS fatt,
            COALESCE((SELECT sum(z.clicks) FROM zombie_clicks z
                      WHERE z.tenant_id = $1 AND z.fetch_date = g.g), 0)::int AS click_giorno_intero
     FROM giovedi g
     LEFT JOIN orders o ON o.tenant_id = $1 AND o.order_status = ANY($2)
       AND (o.order_date AT TIME ZONE 'Europe/Rome')::date = g.g
       AND extract(hour FROM (o.order_date AT TIME ZONE 'Europe/Rome')) < $4
     GROUP BY g.g ORDER BY g.g DESC`,
    [TENANT_ID, WHITELIST_STATI_ORDINE, oggi, ora + 1]);

  const mediaOrdini = base.length ? base.reduce((s, b) => s + b.ordini, 0) / base.length : 0;
  const mediaFatt = base.length ? base.reduce((s, b) => s + parseFloat(b.fatt), 0) / base.length : 0;

  const baseline = {
    ora_taglio: ora,
    giovedi: base,
    media_ordini_a_quest_ora: Math.round(mediaOrdini * 10) / 10,
    media_fatturato_a_quest_ora: Math.round(mediaFatt * 100) / 100,
    nota_click: 'lo storico ha solo il totale di giornata: sui click il confronto vale a giornata chiusa',
    click_freschi: clickFresco,
  };

  await pool.query(
    `INSERT INTO feed_test_log
       (tenant_id, test_label, phase, feed_size, clicks_cum, orders_cum, revenue_cum, baseline, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [TENANT_ID, TEST_LABEL, phase, feedSizeNow, cl.click, od.ordini, od.fatt,
     JSON.stringify(baseline), nota || null]);

  const dOrd = mediaOrdini > 0 ? ((od.ordini - mediaOrdini) / mediaOrdini * 100) : 0;
  const dFat = mediaFatt > 0 ? ((parseFloat(od.fatt) - mediaFatt) / mediaFatt * 100) : 0;
  const riga =
    `[FeedTestPapa] ${oggi} h${String(ora).padStart(2, '0')} | feed ${feedSizeNow} | ` +
    `click ${cl.click} | ordini ${od.ordini} (media 8 giovedì ${baseline.media_ordini_a_quest_ora}, ${dOrd >= 0 ? '+' : ''}${dOrd.toFixed(1)}%) | ` +
    `fatt ${od.fatt} (media ${baseline.media_fatturato_a_quest_ora}, ${dFat >= 0 ? '+' : ''}${dFat.toFixed(1)}%)`;
  console.log(riga);

  await notify(
    `🔬 <b>Test Papa · h${String(ora).padStart(2, '0')}</b>\n` +
    `Feed civetta=1: <b>${feedSizeNow}</b>\n` +
    `Click giorno: <b>${cl.click}</b>${clickFresco ? '' : ' ⚠️ fetch fallito, dato non fresco'}\n` +
    `Ordini: <b>${od.ordini}</b> vs ${baseline.media_ordini_a_quest_ora} media 8 giovedì (<b>${dOrd >= 0 ? '+' : ''}${dOrd.toFixed(1)}%</b>)\n` +
    `Fatturato: <b>€${od.fatt}</b> vs €${baseline.media_fatturato_a_quest_ora} (<b>${dFat >= 0 ? '+' : ''}${dFat.toFixed(1)}%</b>)`);
}

// ─── Riconciliatore ──────────────────────────────────────

async function tick() {
  try {
    const ora = new Date();
    const dentro = ora >= START_UTC && ora < END_UTC;
    const acceso = await flagAcceso();

    if (dentro && !acceso && !abortito) { await accendi(); return; }
    if (dentro && abortito) return;   // salvavita scattato: si resta fermi
    if (!dentro && acceso) { await spegni(); return; }
    if (!dentro) return;

    // Dentro la finestra: log ogni 2 ore, una sola volta per fascia.
    const { rows: [t] } = await pool.query(
      `SELECT to_char(NOW() AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD HH24') AS slot,
              extract(hour FROM (NOW() AT TIME ZONE 'Europe/Rome'))::int AS ora,
              extract(minute FROM (NOW() AT TIME ZONE 'Europe/Rome'))::int AS minuto`);
    if (t.ora % LOG_EVERY_HOURS === 0 && t.minuto < 5 && lastLoggedSlot !== t.slot) {
      lastLoggedSlot = t.slot;
      await scriviLog('test', await feedSize(), null);
    }
  } catch (e) {
    console.error('[FeedTestPapa] tick:', e.message);
    logger.error(`tick: ${e.message}`, { tenantId: TENANT_ID }, e);
  }
}

function start() {
  if (new Date() >= END_UTC) {
    // Test finito: un giro solo, per ripulire se il flag fosse rimasto.
    console.log('[FeedTestPapa] finestra chiusa — controllo di pulizia');
    tick().catch(() => {});
    return;
  }
  console.log(`[FeedTestPapa] Armato — Papa, ${START_UTC.toISOString()} → ${END_UTC.toISOString()} UTC, controllo ogni 60s`);
  tick().catch(() => {});
  timer = setInterval(() => tick().catch(() => {}), TICK_MS);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, TENANT_ID, TEST_LABEL, START_UTC, END_UTC };
