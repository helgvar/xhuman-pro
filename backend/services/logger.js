/**
 * Structured Logger — log persistenti in tabella log_events.
 *
 * Caratteristiche:
 *  - Buffer in-memory con flush ogni 5s (batch INSERT, no blocking)
 *  - Mantiene console.log/warn/error originali (visibili in docker logs)
 *  - Intercetta automaticamente console.error per catturare i log esistenti
 *    senza migrare ogni file uno per uno
 *  - Bind context (source, tenantId, traceId) per logger figli
 *  - Telegram alert su level=fatal (best effort, non blocca log)
 *
 * Uso:
 *   const log = require('./services/logger');
 *   log.info('Backend running', { port: 3001 });
 *   log.error('Order sync failed', { tenantId }, err);
 *
 *   const childLog = log.with({ source: 'healthCron', tenantId });
 *   childLog.warn('Loop slow', { duration: 30000 });
 */

const os = require('os');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const HOSTNAME = os.hostname();
const PROCESS_START = Date.now();

const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER = 200;
const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 5000;
const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'];

let _buffer = [];
let _flushTimer = null;
let _flushing = false;
let _telegramConfig = null;
let _telegramConfigCheckedAt = 0;
const _telegramDedup = new Map();   // key -> ts
const TELEGRAM_DEDUP_MS = 30 * 60 * 1000;  // 30 min same fatal class

function uptimeSec() {
  return Math.floor((Date.now() - PROCESS_START) / 1000);
}

function truncate(s, max) {
  if (s == null) return null;
  if (typeof s !== 'string') s = String(s);
  return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

function safeStringify(obj) {
  if (obj == null) return null;
  try {
    return JSON.parse(JSON.stringify(obj, (k, v) => {
      if (v instanceof Error) return { message: v.message, stack: v.stack, code: v.code };
      if (typeof v === 'bigint') return v.toString();
      return v;
    }));
  } catch {
    return { _stringify_error: true, raw: String(obj).slice(0, 500) };
  }
}

async function flushNow() {
  if (_flushing || _buffer.length === 0) return;
  _flushing = true;
  const batch = _buffer.splice(0, _buffer.length);
  try {
    // Multi-row insert
    const values = [];
    const params = [];
    let p = 1;
    for (const r of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        r.ts,
        r.level,
        r.source || null,
        r.tenant_id || null,
        r.trace_id || null,
        r.message,
        r.payload ? JSON.stringify(r.payload) : null,
        r.stack || null,
        HOSTNAME,
        r.uptime_sec
      );
    }
    const sql = `INSERT INTO log_events
      (ts, level, source, tenant_id, trace_id, message, payload, stack, hostname, process_uptime_sec)
      VALUES ${values.join(', ')}`;
    await pool.query(sql, params);
  } catch (err) {
    // FALLBACK: se non riusciamo a scrivere su DB, almeno emettiamo a stderr
    process.stderr.write(`[logger] FLUSH FAILED: ${err.message}\n`);
    // Non rimettiamo nel buffer per non gonfiarlo indefinitamente in caso di DB giù
  } finally {
    _flushing = false;
  }
}

function startFlushTimer() {
  if (_flushTimer) return;
  _flushTimer = setInterval(flushNow, FLUSH_INTERVAL_MS);
  if (typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

// Riduce variabili numeriche per dedup ("Timeout after 30000ms (avg: 2575ms)" -> "Timeout after Nms (avg: Nms)")
function _dedupKey(record) {
  const normMsg = (record.message || '').replace(/\d+/g, 'N').slice(0, 120);
  return `${record.source || ''}|${normMsg}`;
}

// Pattern di fatal che NON spammiamo su Telegram (sono rumore noto, restano in DB per debug)
const TELEGRAM_EXCLUDE_PATTERNS = [
  // apiQueue timeout: causa nota (Farmabooster API lenta + race condition timer);
  // i fix applicati a Promise.race non hanno chiuso l'unhandled, ma e' inocuo
  // (process.on cattura, backend non crasha). Telegram qui sarebbe puro rumore.
  /UNHANDLED REJECTION: Timeout after \d+ms \(avg:/,
];

async function maybeTelegramAlert(record) {
  if (record.level !== 'fatal') return;
  // Skip Telegram per pattern noti rumorosi
  for (const re of TELEGRAM_EXCLUDE_PATTERNS) {
    if (re.test(record.message)) return;
  }
  // Dedup: stesso fatal pattern entro 30min -> niente Telegram
  const key = _dedupKey(record);
  const last = _telegramDedup.get(key) || 0;
  if (Date.now() - last < TELEGRAM_DEDUP_MS) return;
  _telegramDedup.set(key, Date.now());
  // Cache config 5 min
  if (Date.now() - _telegramConfigCheckedAt > 5 * 60 * 1000) {
    _telegramConfigCheckedAt = Date.now();
    try {
      const { rows } = await pool.query(
        `SELECT config_key, config_value FROM global_config
         WHERE config_key IN ('telegram_bot_token','telegram_chat_id')`
      );
      const m = {};
      for (const r of rows) {
        try { m[r.config_key] = decrypt(r.config_value); }
        catch { m[r.config_key] = r.config_value; }
      }
      _telegramConfig = (m.telegram_bot_token && m.telegram_chat_id) ? m : null;
    } catch { _telegramConfig = null; }
  }
  if (!_telegramConfig) return;
  try {
    const text = `<b>🔥 FATAL</b> ${record.source || ''}\n${truncate(record.message, 500)}\n<i>${HOSTNAME}</i>`;
    await fetch(`https://api.telegram.org/bot${_telegramConfig.telegram_bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: _telegramConfig.telegram_chat_id, text, parse_mode: 'HTML' }),
    });
  } catch { /* best effort */ }
}

function emit(level, source, tenantId, traceId, message, payload, stack) {
  const ts = new Date();
  // Estrae tenantId/source dal payload se non passati esplicitamente via context.
  // Cosi log.info('msg', { source: 'healthCron', tenantId: 'xyz' }) popola correttamente
  // le colonne DB indicizzate, non solo il payload JSON.
  if (!tenantId && payload && typeof payload === 'object' && payload.tenantId) {
    tenantId = payload.tenantId;
  }
  if (!source && payload && typeof payload === 'object' && payload.source) {
    source = payload.source;
  }
  const record = {
    ts,
    level,
    source,
    tenant_id: tenantId || null,
    trace_id: traceId || null,
    message: truncate(message || '(empty)', MAX_MESSAGE_LEN),
    payload: safeStringify(payload),
    stack: truncate(stack, MAX_STACK_LEN),
    uptime_sec: uptimeSec(),
  };

  _buffer.push(record);
  if (_buffer.length > MAX_BUFFER) {
    flushNow();
  }
  // Telegram async, non blocca
  maybeTelegramAlert(record).catch(() => {});

  startFlushTimer();
}

function makeLogger(context = {}) {
  const { source, tenantId, traceId } = context;
  const fns = {};
  for (const lvl of LEVELS) {
    fns[lvl] = function (message, payload, errOrStack) {
      let stack = null;
      if (errOrStack instanceof Error) {
        stack = errOrStack.stack;
        if (!payload) payload = {};
        if (typeof payload === 'object' && payload !== null) {
          payload.error_message = errOrStack.message;
          if (errOrStack.code) payload.error_code = errOrStack.code;
        }
      } else if (typeof errOrStack === 'string') {
        stack = errOrStack;
      }
      emit(lvl, source, tenantId, traceId, message, payload, stack);
    };
  }
  fns.with = (extra) => makeLogger({ ...context, ...extra });
  fns.flush = flushNow;
  fns.newTrace = () => crypto.randomUUID();
  return fns;
}

const rootLogger = makeLogger();

/**
 * Aggancia console.error per intercettare tutti i log preesistenti
 * senza dover migrare ogni file. console.log/warn restano puri.
 * Catture chiamate come console.error(err) o console.error('msg', err)
 */
function installConsoleHook() {
  const origError = console.error;
  console.error = function (...args) {
    origError(...args);
    try {
      let message = '';
      let stack = null;
      let payload = null;
      for (const a of args) {
        if (a instanceof Error) {
          message = message ? message + ' | ' + a.message : a.message;
          stack = a.stack;
        } else if (typeof a === 'object') {
          payload = payload || {};
          Object.assign(payload, safeStringify(a) || {});
        } else {
          message = message ? message + ' ' + String(a) : String(a);
        }
      }
      // Tag source = "console" per distinguere
      emit('error', 'console', null, null, message || '(empty)', payload, stack);
    } catch { /* never throw from hook */ }
  };
}

/**
 * Aggancia process.on('unhandledRejection') + ('uncaughtException')
 * per catturare TUTTO ciò che oggi crashava il backend.
 * Va chiamato il prima possibile in server.js.
 */
function installProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    const message = reason && reason.message ? reason.message : String(reason);
    const stack = reason && reason.stack ? reason.stack : null;
    process.stderr.write(`[Process] UNHANDLED REJECTION: ${message}\n`);
    emit('fatal', 'process', null, null, `UNHANDLED REJECTION: ${message}`, null, stack);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[Process] UNCAUGHT EXCEPTION: ${err.message}\n`);
    emit('fatal', 'process', null, null, `UNCAUGHT EXCEPTION: ${err.message}`, null, err.stack);
  });
}

/**
 * Cleanup vecchi log (chiamato giornalmente da healthCron).
 */
async function pruneOldLogs(retentionDays = 30) {
  try {
    const { rows: [r] } = await pool.query(`SELECT prune_log_events($1) AS deleted`, [retentionDays]);
    rootLogger.info(`Log retention: pruned ${r.deleted} rows older than ${retentionDays}d`, { source: 'logger', deleted: r.deleted });
    return r.deleted;
  } catch (err) {
    rootLogger.error('Log prune failed', null, err);
    return -1;
  }
}

// Flush al shutdown del processo (best effort, ha solo 200ms)
process.on('SIGTERM', () => { flushNow().catch(() => {}); });
process.on('SIGINT', () => { flushNow().catch(() => {}); });

module.exports = Object.assign(rootLogger, {
  installConsoleHook,
  installProcessHandlers,
  pruneOldLogs,
});
