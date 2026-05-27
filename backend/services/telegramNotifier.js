const { getGlobals } = require('./globalConfig');

// In-memory dedup so repeated alerts (same `key`) don't spam the channel.
const _lastSent = new Map();
const DEFAULT_THROTTLE_MS = 4 * 60 * 60 * 1000; // 4h

async function sendTelegram(text, opts = {}) {
  const { key = null, throttleMs = DEFAULT_THROTTLE_MS, parseMode = 'HTML' } = opts;

  if (key) {
    const last = _lastSent.get(key);
    if (last && Date.now() - last < throttleMs) return { ok: false, reason: 'throttled' };
  }

  try {
    const g = await getGlobals(['telegram_bot_token', 'telegram_chat_id']);
    if (!g.telegram_bot_token || !g.telegram_chat_id) return { ok: false, reason: 'not_configured' };

    const url = `https://api.telegram.org/bot${g.telegram_bot_token}/sendMessage`;
    // Telegram caps messages at 4096 chars
    const body = {
      chat_id: g.telegram_chat_id,
      text: text.length > 4000 ? text.slice(0, 3990) + '\n…[truncato]' : text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) {
      console.error('[Telegram] send failed:', JSON.stringify(j).slice(0, 200));
      return { ok: false, reason: 'api_error', detail: j };
    }
    if (key) _lastSent.set(key, Date.now());
    return { ok: true, messageId: j.result.message_id };
  } catch (err) {
    console.error('[Telegram] exception:', err.message);
    return { ok: false, reason: 'exception', error: err.message };
  }
}

function fmtEur(v) { return '€' + Math.round(Number(v) || 0).toLocaleString('it-IT'); }
function fmtPct(v, d = 1) { return (Number(v) || 0).toFixed(d) + '%'; }

module.exports = { sendTelegram, fmtEur, fmtPct };
