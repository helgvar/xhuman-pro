/**
 * Hourly Battle Check — tabella operativa (dictat utente 10/7 sera)
 *
 * Ogni ora (08-22): per ogni tenant confronta il CUMULATO ordini di oggi
 * alla stessa ora con il pattern degli stessi giorni-settimana (3 settimane),
 * misura il ritmo dell'ULTIMA ora, l'applicazione dei prezzi del giorno e
 * i top seller fuori posizione dall'ultima slice scraper.
 * Telegram: tabella alle 9/13/17/21 + allarme immediato se un tenant viaggia
 * sotto il 60% del pattern per 2 ore consecutive (multi-evidenza).
 */

const { pool } = require('../db/pool');
const { sendTelegram, fmtEur } = require('./telegramNotifier');

const sottoRitmo = {}; // tenant → ore consecutive sotto soglia

async function runHourlyBattleCheck() {
  const { rows } = await pool.query(`
    WITH ita AS (SELECT NOW() AT TIME ZONE 'Europe/Rome' AS now_ita),
    base_days AS (
      SELECT ((SELECT now_ita FROM ita)::date - 7*k) AS d FROM generate_series(1,3) k),
    oggi AS (
      SELECT o.tenant_id, COUNT(*) n, COALESCE(SUM(o.subtotal_incl_tax),0) rev
      FROM orders o, ita
      WHERE o.order_date::date = ita.now_ita::date
        AND o.order_date::time <= ita.now_ita::time
        AND o.order_status NOT IN ('canceled','closed')
      GROUP BY 1),
    ultima_ora AS (
      SELECT o.tenant_id, COUNT(*) n FROM orders o, ita
      WHERE o.order_date::date = ita.now_ita::date
        AND o.order_date::time BETWEEN ita.now_ita::time - INTERVAL '1 hour' AND ita.now_ita::time
        AND o.order_status NOT IN ('canceled','closed')
      GROUP BY 1),
    pattern AS (
      SELECT o.tenant_id, COUNT(*)::numeric/3 n, COALESCE(SUM(o.subtotal_incl_tax),0)/3 rev
      FROM orders o, ita
      WHERE o.order_date::date IN (SELECT d FROM base_days)
        AND o.order_date::time <= ita.now_ita::time
        AND o.order_status NOT IN ('canceled','closed')
      GROUP BY 1),
    prezzi AS (
      SELECT fa.tenant_id, COUNT(*) tot,
        COUNT(*) FILTER (WHERE p.applied_price IS NOT NULL AND ABS(p.applied_price - fa.recommended_price) < 0.02) ok
      FROM feed_actions fa
      JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
      WHERE fa.recommended_price IS NOT NULL
        AND fa.computed_at >= (NOW() AT TIME ZONE 'Europe/Rome')::date
      GROUP BY 1)
    SELECT t.name, COALESCE(og.n,0) ord_oggi, ROUND(COALESCE(og.rev,0)) rev_oggi,
      ROUND(COALESCE(pa.n,0),1) ord_attesi, ROUND(COALESCE(pa.rev,0)) rev_attesi,
      COALESCE(uo.n,0) ultima_ora,
      COALESCE(pr.tot,0) pc_oggi, COALESCE(pr.ok,0) pc_applicati
    FROM tenants t
    LEFT JOIN oggi og ON og.tenant_id = t.id
    LEFT JOIN pattern pa ON pa.tenant_id = t.id
    LEFT JOIN ultima_ora uo ON uo.tenant_id = t.id
    LEFT JOIN prezzi pr ON pr.tenant_id = t.id
    WHERE t.status = 'active'
    ORDER BY COALESCE(og.rev,0) DESC`);

  const righe = [];
  const allarmi = [];
  for (const r of rows) {
    const attesi = parseFloat(r.ord_attesi);
    const pct = attesi > 0 ? Math.round(r.ord_oggi / attesi * 100) : 100;
    const flag = pct < 60 ? '🔴' : pct < 85 ? '🟡' : '🟢';
    righe.push(`${flag} ${r.name}: ${r.ord_oggi}/${r.ord_attesi} ord (${pct}%) | ${fmtEur(r.rev_oggi)} vs ${fmtEur(r.rev_attesi)} | h-1: ${r.ultima_ora} | PC ${r.pc_applicati}/${r.pc_oggi}`);
    if (pct < 60 && attesi >= 5) {
      sottoRitmo[r.name] = (sottoRitmo[r.name] || 0) + 1;
      if (sottoRitmo[r.name] >= 2) {
        // niente '<' nel testo: Telegram parseMode HTML lo legge come tag e fallisce
        allarmi.push(`🔴 ${r.name}: ${sottoRitmo[r.name]} ore consecutive sotto il 60 per cento del pattern (${r.ord_oggi} vs ${r.ord_attesi} attesi)`);
      }
    } else {
      sottoRitmo[r.name] = 0;
    }
  }

  const oraIta = parseInt(new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
  const msg = `⚔️ <b>TABELLA OPERATIVA h${oraIta}</b>\n\n${righe.join('\n')}`;
  console.log('[BattleCheck]', righe.join(' || '));

  if ([9, 13, 17, 21].includes(oraIta)) {
    try { await sendTelegram(msg, { key: 'battle_board', parseMode: 'HTML' }); } catch {}
  }
  if (allarmi.length > 0) {
    try { await sendTelegram(`🚨 <b>RITMO SOTTO SOGLIA</b>\n${allarmi.join('\n')}`, { key: 'battle_alarm', parseMode: 'HTML', throttleMs: 2 * 3600 * 1000 }); } catch {}
  }
  return msg;
}

let cronStarted = false;

function startHourlyBattleCheck() {
  if (cronStarted) return;
  cronStarted = true;
  const tick = () => {
    const h = parseInt(new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
    if (h >= 8 && h <= 22) {
      runHourlyBattleCheck().catch(e => console.error('[BattleCheck] err:', e.message));
    }
  };
  setTimeout(() => { tick(); setInterval(tick, 60 * 60 * 1000); }, 3 * 60 * 1000);
  console.log('[BattleCheck] attivo — tabella operativa ogni ora 08-22');
}

module.exports = { runHourlyBattleCheck, startHourlyBattleCheck };
