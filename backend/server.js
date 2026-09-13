const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
}

const { initDB } = require('./db/pool');

// 💓 Battito dei loop (mig 117, ordine capo 10/09: un monitor che ogni ora
// controlla tutti i loop e sblocca quelli bloccati). Va per PRIMO: avvolge
// setInterval/setTimeout, quindi deve essere in piedi prima che un servizio ne
// schedule uno. Registra ogni schedulazione da 60s in su in loop_heartbeat.
const { startLoopHeartbeat } = require('./services/loopHeartbeat');
startLoopHeartbeat();

// Defensive: log unhandled rejections instead of crashing the process.
// A single tenant misconfiguration (e.g. missing API permission) must not take down
// the entire backend and bring all crons to a halt.
//
// Pattern noti rumorosi che NON spammiamo su Telegram (restano in stdout/log):
// - apiQueue timeout race (innocuo, Promise.race del modulo)
// - 401 Magento per tenant senza permessi corretti (allertato gia' dal cron specifico)
// - Step TIMEOUT healthCron per tenant grossi
const TELEGRAM_EXCLUDE_PATTERNS = [
  /Timeout after \d+ms \(avg: \d+ms\)/i,
  /Step TIMEOUT: (health_scores|mc_sync|civetta_sync) on /i,
  /Magento API error 401/i,
  /The operation was aborted due to timeout/i,
  // Magento 5xx (Cloudflare origin down/timeout): retry gestito da apiQueue,
  // l'alert via AlertMonitor lo raggruppa già per tenant. Inutile spam.
  /Magento API error 5\d\d/i,
];

process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  console.error('[UnhandledRejection]', msg, reason?.stack?.split('\n').slice(0, 4).join(' | '));
  for (const re of TELEGRAM_EXCLUDE_PATTERNS) {
    if (re.test(msg)) return; // rumore noto, niente Telegram
  }
  try {
    const { sendTelegram } = require('./services/telegramNotifier');
    sendTelegram(`🚨 <b>xHumanPro unhandledRejection</b>\n<code>${msg.slice(0, 500)}</code>`, {
      key: 'unhandled:' + msg.slice(0, 80),
      throttleMs: 30 * 60 * 1000,
    }).catch(() => {});
  } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message, err.stack?.split('\n').slice(0, 4).join(' | '));
  try {
    const { sendTelegram } = require('./services/telegramNotifier');
    sendTelegram(`🔥 <b>xHumanPro uncaughtException</b>\n<code>${err.message.slice(0, 500)}</code>`, {
      key: 'uncaught:' + err.message.slice(0, 80),
      throttleMs: 30 * 60 * 1000,
    }).catch(() => {});
  } catch {}
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'xHUMANPRO', version: '1.0.0' });
});

// API Queue status (monitor circuit breaker + load)
app.get('/api/queue-status', (req, res) => {
  const { getQueueStatus } = require('./services/apiQueue');
  res.json(getQueueStatus());
});

// Auth routes (public)
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Protected routes
const tenantsRoutes = require('./routes/tenants');
const usersRoutes = require('./routes/users');
const ordersRoutes = require('./routes/orders');
const productsRoutes = require('./routes/products');
const scraperRoutes = require('./routes/scraper');
const trovaprezziRoutes = require('./routes/trovaprezzi');
const merchantCenterRoutes = require('./routes/merchantCenter');
const optimizationRoutes = require('./routes/optimization');
const ga4Routes = require('./routes/ga4');
const externalApiRoutes = require('./routes/externalApi');
const onboardingRoutes = require('./routes/onboarding');
const agentRoutes = require('./routes/agent');
const supervisorRoutes = require('./routes/supervisor');
const paretoRoutes = require('./routes/pareto');
const ruleOptimizerRoutes = require('./routes/ruleOptimizer');
const abTestsRoutes = require('./routes/abTests');
const crossChannelRoutes = require('./routes/crossChannel');
const shoppingRoutes = require('./routes/shopping');
const googleAdsRoutes = require('./routes/googleAds');
const logsRoutes = require('./routes/logs');
const aiAuditRoutes = require('./routes/aiAudit');
app.use('/api/tenants', tenantsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/scraper', scraperRoutes);
app.use('/api/trovaprezzi', trovaprezziRoutes);
app.use('/api/merchant-center', merchantCenterRoutes);
app.use('/api/optimization', optimizationRoutes);
app.use('/api/ga4', ga4Routes);
app.use('/api/external/v1', externalApiRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/supervisor', supervisorRoutes);
app.use('/api/pareto', paretoRoutes);
app.use('/api/rule-optimizer', ruleOptimizerRoutes);
app.use('/api/ab-tests', abTestsRoutes);
app.use('/api/cross-channel', crossChannelRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/google-ads', googleAdsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/ai-audit', aiAuditRoutes);
app.use('/api/oblio', require('./routes/oblio'));
app.use('/api/capo-ordini', require('./routes/capoOrdini'));
app.use('/api/arbitro', require('./routes/arbitro'));
app.use('/api/coda-lunga', require('./routes/codaLunga'));

// Start server
async function start() {
  try {
    await initDB();
    console.log('[DB] Database initialized');

    // Start order sync cron
    const { startOrderSync } = require('./services/orderSync');
    startOrderSync();

    // Start product sync cron (every 2h, offset 1h from startup)
    const { startProductSync } = require('./services/productSync');
    startProductSync();

    // Start zombie Trovaprezzi cron (daily at 00:05)
    const { startZombieCron } = require('./services/zombieCron');
    startZombieCron();

    // ⚡ Zombie intra-day (idea capo 25/7): parziale click di OGGI ogni 2h in
    // fascia 08:35-20:35 IT, solo DB (no FTP) — correzioni infragiornaliere.
    const { startZombieIntradayCron } = require('./services/zombieIntradayCron');
    startZombieIntradayCron();

    // Start product health enrichment cron (every 4h)
    const { startHealthCron } = require('./services/healthCron');
    startHealthCron();

    // Start alert monitor (every 2h, email on failures)
    const { startAlertMonitor } = require('./services/alertMonitor');
    startAlertMonitor();

    // Start magento-sync cron (every 2h at :30, only operational tenants)
    const { startMagentoSyncCron } = require('./services/magentoSyncCron');
    startMagentoSyncCron();

    // Start spend monitor cron (every 3h, alert su incidenza alta / spesa
    // anomala / calo ordini per tenant operational)
    const { startSpendMonitorCron } = require('./services/spendMonitorCron');
    startSpendMonitorCron();

    // Google Ads sync cron (1x/giorno, tenant con google_ads_customer_id).
    // Read-only: pull dati Ads nel DB locale, NON tocca le campagne.
    const { startGoogleAdsSyncCron } = require('./services/googleAds');
    startGoogleAdsSyncCron();

    // Start stable cache cron (ogni 30 min, indipendente da healthCron).
    // healthCron step stable_cache era ULTIMO della pipeline: se uno step
    // precedente timeout-ava per un tenant, la cache di /feed/civetta e
    // /feed/prices non veniva mai aggiornata. Loop autonomo risolve.
    const { startStableCacheCron } = require('./services/stableCacheCron');
    startStableCacheCron();

    // AI audit cron: digest UTC 09:00 + auto-apply UTC 04:00, 16:00
    const { start: startAiAuditCron } = require('./services/aiAuditCron');
    startAiAuditCron();

    // 🔔 Sirena di conformità (14/7): ogni mattina 07:00 IT ricontrolla che
    // nessuna legge sia violata nello stato reale del DB — Telegram se sgarra
    const { start: startConformityMonitor } = require('./services/conformityMonitor');
    startConformityMonitor();

    // 🔬 Test feed 24h su Papa (ordine capo 5/8): giovedì 6/8 dalle 00:00 alle
    // 00:15 del 7 il feed civetta=1 di Papa contiene SOLO i venditori 90gg.
    // Riconciliatore a tempo, un solo tenant, si spegne e si pulisce da solo.
    const { start: startFeedTestPapa } = require('./services/feedTestPapa');
    startFeedTestPapa();

    // ♻️ Refresh SOLO-ADD delle whitelist forzate: chi vende negli ultimi 7
    // giorni rientra in vetrina da solo. Misurato l'11/8 su Papa: 81 SKU fuori
    // whitelist avevano fatto 1.909 EUR in 5 giorni. Non rimuove mai nessuno.
    const { start: startWhitelistRefresh } = require('./services/whitelistRefresh');
    startWhitelistRefresh();

    // ✂️ Lima costante (ordine permanente capo 15/7): ogni mattina 06:15 IT
    // pochi burner cliccati zero-vendite fuori dal feed — poco ma costante
    const { start: startLimaCostante } = require('./services/limaCostanteCron');
    startLimaCostante();

    // 🔁 Decadimento PC (requisito capo 16/7): ogni notte 05:30 IT stacca i
    // price cut che consumano budget-click senza convertire (dieta + retest 21g,
    // no sovrapposizione loop). Ripristina il gate low_click_no_conversion.
    const { startPcDecayCron } = require('./services/pcDecayCron');
    startPcDecayCron();

    // 🔥 Loop burner incidenza>100% (ordine capo 17/7): ogni notte 05:45 IT
    // stacca i burner fatturato-zero (spesa click 15g > fatturato, 0 diretto +
    // 0 carrello), cap 80/tenant "poco-ma-costante", retest 21g. Stesso
    // meccanismo dieta+arbitro del pcDecay. Freno anti-9/7 sui portatori.
    const { startBurnerIncidenceCron } = require('./services/burnerIncidenceCron');
    startBurnerIncidenceCron();

    // 🔁 Riattivazione margine (ordine capo 24/7): UNICA autorita' di rilascio
    // per la classe "margine 100% bruciato" (lima+burner+killer). Ogni mattina
    // 05:00 IT, PRIMA di burner/lima: R1 vende-in-rete, R2 restock magazzino,
    // R3 test 5gg ogni 20gg. Mig 071 (funzione DB reactivate_margin_blocks).
    const { startMarginBlockReactivation } = require('./services/marginBlockReactivation');
    startMarginBlockReactivation();

    // 🔁 Loop coda lunga zero-conversione (ordine capo 29/7): taglia i micro-burner
    // sotto la soglia killer per-SKU (1 click/15gg, 0 vendite rete 90gg, disponibili)
    // e li ritesta 3gg ogni 7gg. Vende nel test -> promosso; no-sale -> ri-taglio.
    // Mig 078 (funzione DB codalunga_retest_loop). Gira 03:20 UTC / 05:20 IT.
    const { startCodaLungaLoop } = require('./services/codaLungaLoop');
    startCodaLungaLoop();

    // 🔁 Loop rete-only (ordine capo 13/09): "se vende nella rete e non sul
    // singolo tenant, o va riposizionato e monitorato per massimo 3 giorni o va
    // staccato subito. Se dopo i 3 giorni comunque non vende o non ha
    // un'incidenza giusta deve essere tagliato". Copre il buco misurato il
    // 13/09 (546 SKU Procaccini, 293 EUR/30gg, zero pezzi che li toccavano:
    // tetto lima per-SKU 80 EUR, banco di test solo per i gia' bloccati, scudo
    // L2-rete senza orologio). Gira 04:45 UTC / 06:45 IT, dopo la lima.
    // Tetto sul BUCKET, non per SKU: il PASS 4 della lima resta dov'e'. Mig 133.
    const { start: startReteOnly } = require('./services/reteOnlyLoop');
    startReteOnly();

    // 🔇 Loop rumore (ordine capo 13/09): "1/4 click e 0 vendite ovunque vanno
    // in oblio". Settimanale lunedi' 05:15 UTC / 07:15 IT, tetto 400/tenant.
    // Chi fa rumore su 2+ tenant finisce nell'OBLIO globale, gli altri in
    // REMOVE locale. Tre cancelli fail-closed: ordini freschi, click freschi,
    // e nessun conflitto con i dati vendita di Farmabooster.
    const { start: startRumore } = require('./services/rumoreLoop');
    startRumore();

    // 🛡️ Guardiano PC (ordine capo 24/7): "ogni PC va confermato a ogni loop".
    // Ogni 2h ricalcola costo_vero del momento su ogni PC attivo; se il costo è
    // salito (tipico switch magazzino→grossista) e il margine sfonda il floor,
    // rialza al floor-safe (se resta competitivo) o ritira il PC. Mig 073.
    const { startPcGuardian } = require('./services/pcGuardianCron');
    startPcGuardian();

    // 💰 Guardia G6 sui CAMBI COSTO (ordine capo 10/09): "io farei un loop
    // supplementare sul controllo dei costi che monitora i cambi costo".
    // Ogni 20 min legge product_cost_history, trova i costi cambiati davvero
    // nell'ultima ora e mezza sotto un PC vivo, li registra in
    // cambio_costo_allarme e, se il cambio ha portato il taglio sotto il floor,
    // lancia subito la riconferma su quel tenant. Mig 110.
    const { startCostChangeWatch } = require('./services/costChangeWatchCron');
    startCostChangeWatch();

    // 🐕 CANE DA GUARDIA DEI LOOP (ordine capo 10/09). Mig 117: sblocca i job
    // zombie, termina le sessioni appese, segnala i loop senza battito.
    const { startLoopWatchdog } = require('./services/loopWatchdogCron');
    startLoopWatchdog();

    // 🔬 Monitor supplementare TEST Pareto Positioning (ordine capo 24/7): ogni
    // 30 min fotografa costo/PC/margine/posizione dei PC 'pareto_positioning' in
    // pareto_test_snapshots + Telegram (heartbeat 3h, alert su anomalia costo). Mig 074.
    const { startParetoTestMonitor } = require('./services/paretoTestMonitor');
    startParetoTestMonitor();

    // 🔥 Regola burner ufficiale (dictat capo 25/7, mig 075): blocco giornaliero
    // dei prodotti che in 7gg hanno bruciato budget con incidenza >100%; rilascio
    // SOLO se il seller ricomincia a vendere + incidenza <50% (veto DB). Monitor
    // orario: se un loop tenta la riabilitazione, riblocca e avvisa.
    const { startBurnerRule } = require('./services/burnerRuleCron');
    startBurnerRule();

    // 🛡️ Guardia Venditori (18/7, "perché non te ne sei accorto da solo?"):
    // ogni mattina 07:10 IT visita i top seller — fantasmi TP, sopra-best
    // (con PC auto floor-safe), stock-out. Sorveglia il fatturato MANCANTE,
    // non solo il danno.
    const { startSellerGuardCron } = require('./services/sellerGuardCron');
    startSellerGuardCron();

    // 🌊 Nuovi nel traffico (ordine capo 21/8 "STACCHIAMOLI", dopo 84 tagli a
    // mano il 20/8 e 17 il 21/8): ogni giorno alle 14:00 IT stacca chi ha
    // debuttato nel traffico, non vende da 30gg/90gg e non ha stock fisico.
    // Chi vende va al guinzaglio (MONITOR), non al taglio. Dopo il motore feed
    // di proposito: prende gli avanzi del cap condanne, non li ruba. Per tenant.
    const { startNuoviTrafficoCron } = require('./services/nuoviTrafficoCron');
    startNuoviTrafficoCron();

    // ⚖️ Verdetto sui tagli (ordine capo 21/8: "controlla che dopo i tagli il
    // fatturato non scenda insieme alla spesa"). Ogni mattina 08:30 IT:
    // FASE A congela il PRIMA dei tagli di ieri il giorno stesso (fra una
    // settimana la finestra "prima" sarebbe già sporca del taglio). FASE B a
    // 7 giorni giudica, col controfattuale della RETE — agosto scende da solo,
    // senza paragone esterno si condanna il taglio per una stagione.
    const { startVerdettoTagliCron } = require('./services/verdettoTagliCron');
    startVerdettoTagliCron();

    // 🧭 Loop del Mantra (ordine capo 19/7): ogni mattina 07:50 IT lo stratega
    // AI legge il quadro fresco e propone 3-5 soluzioni NUOVE (mai ripetute,
    // memoria in mantra_soluzioni) per il mantra: fatturato SU + costi GIÙ.
    // Propone su Telegram, non applica (auto-apply narrowing vietato).
    const { startMantraLoop } = require('./services/mantraLoop');
    startMantraLoop();

    // AI health monitor: ogni 4h verifica che l'AI Audit stia girando
    // (MAX(run_at) < 8h) e che applichi (no flood pending senza applied)
    const { startAiHealthMonitor } = require('./services/aiHealthMonitor');
    startAiHealthMonitor();

    // OBLIO cron: populate giovedì 02:00 + daily release check 03:00
    const { startOblioCron } = require('./services/crossTenantOblio');
    startOblioCron();

    // Weekend Learning: analisi lunedì 30/6 23:00 italia
    const { startWeekendLearningCron } = require('./services/weekendLearning');
    startWeekendLearningCron();

    // Pepite Monitor: ogni 4h scova SKU in Salva Bilancio attivabili in top competitiva
    const { startPepiteCron } = require('./services/pepiteMonitor');
    startPepiteCron();

    // Winner Stock Alert (Master Plan L6): giornaliero 09:30 italia — winner
    // con vendite reali >= 5/30gg e stock in esaurimento senza backup fornitore
    const { startWinnerStockAlert } = require('./services/winnerStockAlert');
    startWinnerStockAlert();

    // Winback Monitor: giornaliero 07:45 italia — SKU fuori CSV che vendono
    // su altri canali rientrano (diretti se landing top10, con PC se serve)
    const { startWinbackMonitor } = require('./services/winbackMonitor');
    startWinbackMonitor();

    // Applied Price Mirror: ogni 2h legge da Magento il prezzo REALE
    // (special_price) degli SKU con azioni prezzo — sell_price è il listino
    // FB e non vede i PC applicati
    const { startAppliedPriceMirror } = require('./services/appliedPriceMirror');
    startAppliedPriceMirror();

    // Push Monitor "Spinta Luglio": scoreboard giornaliero 08:15 italia —
    // mese corrente vs passo mese precedente per tenant (rev/ordini/spesa/incid)
    const { startPushMonitor } = require('./services/pushMonitor');
    startPushMonitor();

    // SB Visible Sweep: ogni 4h attiva i Salva Bilancio in posizione visibile
    // (top10, ricarico >= floor, stock) rimasti fuori dal CSV — in continuo,
    // non a batch manuali. L'OUT lo gestiscono strict + isteresi + killer
    const { startSbSweep } = require('./services/sbVisibleSweep');
    startSbSweep();

    // Sales Anomaly Monitor: ogni 2h — andamento vendite intraday vs stesso
    // giorno/ora delle 3 settimane prec. + anomalie spesa/fatturato di ieri
    // per i tenant operational (health_config sales_monitor='on')
    const { startSalesAnomalyMonitor } = require('./services/salesAnomalyMonitor');
    startSalesAnomalyMonitor();

    // Position Log: snapshot giornaliero 09:45 delle posizioni dei venditori
    // + alert sui cali (competitor aggressivi weekend) — direttiva 5/7
    const { startPositionLog } = require('./services/positionLog');
    startPositionLog();

    // Cost Diet Monitor: giornaliero 10:10 — post-taglio dieta costi valuta
    // ordini vs baseline pre-taglio (multi-evidenza) + efficacia taglio,
    // avvisa su Telegram — direttiva 9/7
    const { startCostDietMonitor } = require('./services/costDietMonitor');
    startCostDietMonitor();

    // Registro Costi: spazzata /costhistory di Farmabooster ogni 4h (1 tenant,
    // il più stantio) + guardia oraria che avvisa su Telegram se il registro
    // non si aggiorna da 4 ore. Il passato lo dà FB, il presente lo fissa il
    // gradino dentro il sync prodotti — ordine capo 6/8 "avere i costi precisi
    // cambia tutto"
    const { startCostHistoryCron } = require('./services/costHistoryCron');
    startCostHistoryCron();

    // Guardiano consumo budget: ogni 4h rinfresca clicks_consumed /
    // cost_consumed / max_click_budget / budget_pct_used su feed_actions.
    // Prima del 15/8 nessuno li scriveva mai dopo la nascita della riga: erano
    // 0 su tutte le righe e nessuno SKU e' mai stato marcato bruciatore. Non
    // rimuove niente, e un cancello duro ferma il giro se un candidato ha
    // fatturato > 0 — ordine capo "il rischio fatturato deve restare 0"
    const { startBudgetGuardCron } = require('./services/budgetConsumptionCron');
    startBudgetGuardCron();

    // Monitor coorti di posizione (ordine capo 15/8): il rango salvato e' sul
    // prezzo SECCO, il cliente ordina sul TOTALE. Il capo ha deciso di non
    // correggere il misuratore — i fantasmi rendono piu' della vetrina vera —
    // ma la misura e' di Ferragosto. Questo loop tiene il registro (scraper
    // retention 7gg) e giudica solo nei periodi di domanda normale.
    // SOLO MISURA: nessun motore legge queste tabelle per agire.
    const { startCoortiPosizioneMonitor } = require('./services/coortiPosizioneMonitor');
    startCoortiPosizioneMonitor();

    // Sentinella blocchi canali (ordine capo 16/8): l'import Farmabooster e'
    // morto il 13/8 alle 20:31 ed e' rimasto morto TRE GIORNI in silenzio,
    // mentre i motori tagliavano prezzi su costi stantii. Questo loop guarda
    // ogni 30 minuti i cinque canali di ingresso (FB, ordini Magento, scraper,
    // click TP, costi) e avvisa sui CAMBI di stato — non ogni ora, o diventa
    // rumore e il prossimo blocco passa di nuovo inosservato.
    const { startBloccoCanaliMonitor } = require('./services/bloccoCanaliMonitor');
    startBloccoCanaliMonitor();

    // Midnight Briefing: ogni notte 00:05 — piano di battaglia del giorno
    // (consuntivo ieri, posizioni, guardie, scadenze, sorvegliati) — direttiva 9/7
    const { startMidnightBriefing } = require('./services/midnightBriefing');
    startMidnightBriefing();

    // Scraper Poller: import orario della cartella scraper + riprezzo intraday
    // su slice nuova (i file arrivano ogni ~5h, mai più 6h di ritardo) — 10/7
    const { startScraperPoller } = require('./services/scraperPoller');
    startScraperPoller();

    // Battle Check: tabella operativa ogni ora 08-22 (cumulato vs pattern,
    // ritmo ultima ora, applicazione PC) + allarme 2h sotto ritmo — 10/7
    const { startHourlyBattleCheck } = require('./services/hourlyBattleCheck');
    startHourlyBattleCheck();

    // Pareto Positioner AI: 4x/giorno (06:10, 11:10, 14:10, 18:10) — Opus
    // sceglie sul Pareto-set SB la posizione più alta raggiungibile in modo
    // SANO (scala 1°-4°, banda d'oro, mai muri). Via libera capo 11/7.
    const { startParetoPositioner } = require('./services/paretoPositioner');
    startParetoPositioner();

    // Feed Hygiene Cycle: 4x/giorno (06:00, 11:00, 14:00, 18:00) — amnistia
    // completa + oblio + prezzi derivati + rebuild TOTALE, sincronizzato coi
    // passaggi Trovaprezzi così Magento si aggiorna in tempo — direttiva 11/7
    const { startFeedHygieneCycle } = require('./services/feedHygieneCycle');
    startFeedHygieneCycle();

    // Civetta Gap Monitor: ogni 3h — compara civetta FB vs civettaAI, recupera
    // chi ha domanda e manda in ESPLORAZIONE i senza-evidenza (uovo-gallina
    // dello scraper: mai esposti = mai scrappati = mai giudicabili) — 11/7
    const { startCivettaGapMonitor } = require('./services/civettaGapMonitor');
    startCivettaGapMonitor();

    // 📱 Telegram Commander: canale mobile del capo (11/7) — il bot delle
    // sirene ora ASCOLTA: domande dal telefono → agente AI con SQL read-only
    const { startTelegramCommander } = require('./services/telegramCommander');
    startTelegramCommander();

    // 💾 Disk Monitor (11/7 sera: DB crashato con disco 100% durante ingest
    // scraper): sorveglianza oraria, avviso >92%, critico >95%. Il capo
    // aumenterà il disco; fino ad allora questa è la rete di sicurezza
    const { startDiskMonitor } = require('./services/diskMonitor');
    startDiskMonitor();

    // 📦 Scraper Delivery Watch (ordine capo 11/7): check orario "lo scraper
    // ha consegnato?" — conferma consegne piene, allarme su decimate o silenzio
    const { startScraperDeliveryWatch } = require('./services/scraperDeliveryWatch');
    startScraperDeliveryWatch();

    // 🔍 Click Loss Monitor (idea capo 12/7): ogni giorno 08:40 — chi VENDE
    // e ha smesso di ricevere click, con la DIAGNOSI del perché (fuori feed /
    // senza prezzo / senza stock / prezzo salito / posizione persa / invisibile)
    const { startClickLossMonitor } = require('./services/clickLossMonitor');
    startClickLossMonitor();

    // Price Jump Monitor: giornaliero 10:15 — le regole che seguono i
    // competitor IN SU (scoperta tragica 26/6) vengono rilevate dal prezzo
    // venduto e auto-corrette sui tenant con pipe prezzi. Direttiva 6/7
    const { startPriceJumpMonitor } = require('./services/priceJumpMonitor');
    startPriceJumpMonitor();

    // AI Margin Calibrator (regola aurea posizionale 7/7): 2x/giorno l'AI
    // pesa vicino-sotto/vicino-sopra e calibra i rialzi sugli altorotanti
    // — massimo margine senza perdere appetibilità. Guardrail hard post-AI.
    // SOSPESO 11/7 (regola aurea prezzi): i rialzi sono vietati — il
    // calibratore produrrebbe solo tentativi vetati bruciando chiamate Opus.
    // Riattivare SOLO su ordine esplicito del capo.
    // const { startAiMarginCalibrator } = require('./services/aiMarginCalibrator');
    // startAiMarginCalibrator();

    // Position Economics (FONDAMENTALE 7/7): giornaliero 08:45 — per ogni
    // altorotante calcola la banda di posizione più redditizia (margine/g
    // dallo storico) e segnala i mal posizionati. Il calibrator la usa.
    const { startPositionEconomics } = require('./services/positionEconomics');
    startPositionEconomics();

    // Demand Trends (Margin Intelligence, strato 1 — 7/7): giornaliero 08:50,
    // rileva l'interesse in accelerazione (SKU e categoria) dai click di rete.
    // Trend entrante = domanda che paga = margini più coraggiosi (calibrator)
    const { startDemandTrends } = require('./services/demandTrends');
    startDemandTrends();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[xHUMANPRO] Backend running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('[xHUMANPRO] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
