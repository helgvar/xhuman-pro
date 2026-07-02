/**
 * Winner Stock-Out Alert (Master Plan Leva 6)
 *
 * I "winner" (SKU con vendite reali Magento >= 5/30gg) che stanno esaurendo
 * il magazzino sono revenue a rischio: se lo stock va a zero, TP li esclude
 * e le vendite si fermano. Numeri verificati 2/7/2026: 741 SKU winner a
 * rischio in rete = €184.848 rev/30gg esposta, di cui €10.145/mese senza
 * alcun backup fornitore.
 *
 * Cron giornaliero 07:30 UTC (09:30 italia): alert Telegram con i top winner
 * a rischio per tenant. Solo lettura + notifica, nessuna azione automatica —
 * il riassortimento è una decisione del farmacista.
 */

const { pool } = require('../db/pool');
const { sendTelegram } = require('./telegramNotifier');

async function checkWinnersAtRisk() {
  const { rows } = await pool.query(`
    WITH winner_sales AS (
      SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) AS ord_30d,
             SUM(oi.row_total) AS rev_30d
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_date >= NOW() - INTERVAL '30 days'
        AND o.order_status NOT IN ('canceled','closed','pending_payment')
      GROUP BY o.tenant_id, oi.sku
      HAVING COUNT(DISTINCT o.id) >= 5
    )
    SELECT t.name AS tenant, w.sku, p.product_name, p.brand,
           w.ord_30d, ROUND(w.rev_30d::numeric, 0) AS rev_30d,
           COALESCE(p.erp_stock, 0) AS erp_stock,
           COALESCE(p.supplier_stock, 0) AS supplier_stock
    FROM winner_sales w
    JOIN products p ON p.tenant_id = w.tenant_id AND p.sku = w.sku
    JOIN tenants t ON t.id = w.tenant_id
    WHERE t.status = 'active'
      AND COALESCE(p.erp_stock, 0) <= 2
      -- backup fornitore insufficiente: meno di 2 settimane di vendite
      AND COALESCE(p.supplier_stock, 0) < (w.ord_30d / 2.0)
    ORDER BY w.rev_30d DESC
  `);
  return rows;
}

async function runAlert() {
  try {
    const atRisk = await checkWinnersAtRisk();
    if (atRisk.length === 0) {
      console.log('[WinnerStockAlert] Nessun winner a rischio stock-out');
      return { atRisk: 0 };
    }

    const totRev = atRisk.reduce((s, r) => s + parseFloat(r.rev_30d), 0);
    const byTenant = {};
    for (const r of atRisk) {
      (byTenant[r.tenant] = byTenant[r.tenant] || []).push(r);
    }

    let msg = `📦 <b>Winner a rischio stock-out</b>\n`;
    msg += `${atRisk.length} SKU winner (ord≥5/30gg) con stock≤2 e backup fornitore insufficiente\n`;
    msg += `Revenue 30gg esposta: <b>€${Math.round(totRev).toLocaleString('it-IT')}</b>\n\n`;
    for (const [tenant, rows] of Object.entries(byTenant)) {
      const tenantRev = rows.reduce((s, r) => s + parseFloat(r.rev_30d), 0);
      msg += `<b>${tenant}</b> (${rows.length} SKU, €${Math.round(tenantRev).toLocaleString('it-IT')}):\n`;
      for (const r of rows.slice(0, 5)) {
        msg += `  • ${r.sku} ${(r.product_name || '').slice(0, 28)} — ${r.ord_30d} ord, €${r.rev_30d}, stock ${r.erp_stock}+${r.supplier_stock}\n`;
      }
      if (rows.length > 5) msg += `  … +${rows.length - 5} altri\n`;
    }
    msg += `\n➡️ Riassortire per non perdere vendite (TP esclude stock=0).`;

    await sendTelegram(msg, { key: 'winner_stock_alert', parseMode: 'HTML', throttleMs: 20 * 3600 * 1000 });
    console.log(`[WinnerStockAlert] ${atRisk.length} winner a rischio, €${Math.round(totRev)} esposti — alert inviato`);
    return { atRisk: atRisk.length, revExposed: totRev };
  } catch (e) {
    console.error('[WinnerStockAlert] error:', e.message);
    return { error: e.message };
  }
}

let cronStarted = false;

function startWinnerStockAlert() {
  if (cronStarted) return;
  cronStarted = true;

  // Giornaliero 07:30 UTC (09:30 italia) — il farmacista lo legge a inizio giornata
  const tick = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 30, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      await runAlert();
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
  console.log('[WinnerStockAlert] Cron started — giornaliero 07:30 UTC (09:30 italia)');
}

module.exports = { runAlert, checkWinnersAtRisk, startWinnerStockAlert };
