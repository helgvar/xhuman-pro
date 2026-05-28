const { pool } = require('../db/pool');
const { decrypt } = require('./crypto');

const GLOBAL_KEYS = new Set([
  'google_service_account_json',
  'ga4_credentials_json',
  'scraper_drive_folder_id',
  'telegram_bot_token',
  'telegram_chat_id',
  'anthropic_api_key',
  'claude_api_key',
  'pepite_rules',
]);

const _cache = new Map();
const TTL_MS = 5 * 60 * 1000;

function tryDecrypt(v) {
  if (!v) return v;
  try { return decrypt(v); } catch { return v; }
}

async function getGlobal(key) {
  if (!GLOBAL_KEYS.has(key)) throw new Error(`getGlobal: '${key}' is not a global key`);
  const cached = _cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const { rows } = await pool.query(
    `SELECT config_value FROM global_config WHERE config_key = $1`, [key]
  );
  let value = rows[0]?.config_value;

  // Fallback: legacy tenant_configs entry (any tenant). Prefer the most common value.
  if (!value) {
    const { rows: legacy } = await pool.query(
      `SELECT config_value FROM tenant_configs
       WHERE config_key = $1 AND config_value IS NOT NULL AND config_value <> ''
       GROUP BY config_value ORDER BY COUNT(*) DESC LIMIT 1`,
      [key]
    );
    value = legacy[0]?.config_value;
  }
  value = tryDecrypt(value);
  _cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value || null;
}

async function getGlobals(keys) {
  const out = {};
  await Promise.all(keys.map(async k => { out[k] = await getGlobal(k); }));
  return out;
}

function invalidateGlobal(key) {
  if (key) _cache.delete(key); else _cache.clear();
}

module.exports = { getGlobal, getGlobals, invalidateGlobal, GLOBAL_KEYS };
