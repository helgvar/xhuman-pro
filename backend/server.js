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

    // Start stable cache cron (ogni 30 min, indipendente da healthCron).
    // healthCron step stable_cache era ULTIMO della pipeline: se uno step
    // precedente timeout-ava per un tenant, la cache di /feed/civetta e
    // /feed/prices non veniva mai aggiornata. Loop autonomo risolve.
    const { startStableCacheCron } = require('./services/stableCacheCron');
    startStableCacheCron();

    // AI audit cron: digest UTC 09:00 + auto-apply UTC 04:00, 16:00
    const { start: startAiAuditCron } = require('./services/aiAuditCron');
    startAiAuditCron();

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

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[xHUMANPRO] Backend running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('[xHUMANPRO] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
