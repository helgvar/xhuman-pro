/**
 * Applied Price Mirror (direttiva utente 4/7/2026)
 *
 * products.sell_price è il LISTINO FB, non il prezzo speciale applicato su
 * Magento: quando FB esporta i nostri PC, noi eravamo ciechi (ROVIGON: sito
 * €10,70, DB €10,89). Questo mirror legge ogni 2h il prezzo REALE da Magento
 * (special_price, fallback price) per gli SKU con azioni prezzo attive e lo
 * salva in products.applied_price. Le analisi su "cosa vende davvero il
 * tenant" usano COALESCE(applied_price, sell_price).
 */

const { pool } = require('../db/pool');

// Lettura batch autonoma e indistruttibile: chunk piccoli (12 SKU: URL corto,
// meno inviso ai WAF), ogni chunk in try/catch (un 403 non affonda il run),
// pausa tra i chunk (courtesy). Il batchFetchProducts condiviso crashava il
// processo su 403 (6/7/2026).
async function fetchPricesSafe(cfg, skus) {
  // NIENTE coda condivisa (il suo retry interno rilanciava il 403 come
  // unhandled rejection) e NIENTE throw: ogni esito è gestito inline.
  const result = new Map();
  let errConsec = 0, err403 = 0;
  for (let i = 0; i < skus.length; i += 10) {
    const batch = skus.slice(i, i + 10);
    const filters = batch.map((sku, idx) =>
      `searchCriteria[filterGroups][0][filters][${idx}][field]=sku&searchCriteria[filterGroups][0][filters][${idx}][value]=${encodeURIComponent(sku)}&searchCriteria[filterGroups][0][filters][${idx}][conditionType]=eq`
    ).join('&');
    const url = `${cfg.baseUrl}/rest/V1/products?${filters}&fields=items[sku,price,custom_attributes]&searchCriteria[pageSize]=${batch.length}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!resp || !resp.ok) {
      errConsec++;
      if (resp && resp.status === 403) err403++;
      if (errConsec >= 5) {
        console.log(`[AppliedPrice] ${cfg.baseUrl.slice(8, 30)}: stop dopo 5 errori consecutivi (403: ${err403})`);
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    errConsec = 0;
    const data = await resp.json().catch(() => null);
    for (const item of (data && data.items || [])) {
      const attrs = {};
      for (const ca of (item.custom_attributes || [])) attrs[ca.attribute_code] = ca.value;
      result.set(item.sku, {
        price: parseFloat(item.price) || 0,
        specialPrice: parseFloat(attrs.special_price) || null,
      });
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return result;
}

async function runAppliedPriceMirror() {
  const { getMagentoConfig } = require('./magentoSync');

  const { rows: tenants } = await pool.query(`
    SELECT t.id, t.name, COUNT(*) AS n
    FROM feed_actions fa JOIN tenants t ON t.id = fa.tenant_id
    WHERE fa.recommended_price IS NOT NULL AND t.status = 'active'
    GROUP BY t.id, t.name ORDER BY n DESC`);

  const summary = [];
  for (const t of tenants) {
    try {
      const cfg = await getMagentoConfig(t.id);
      const { rows: acts } = await pool.query(
        `SELECT sku, recommended_price FROM feed_actions
         WHERE tenant_id = $1 AND recommended_price IS NOT NULL`, [t.id]);
      const magento = await fetchPricesSafe(cfg, acts.map(a => a.sku));

      let applied = 0, read = 0;
      for (const a of acts) {
        const m = magento.get(a.sku);
        if (!m) continue;
        // Prezzo effettivo: special_price se presente e sensato, altrimenti price
        const eff = (m.specialPrice && m.specialPrice > 0 && (!m.price || m.specialPrice <= m.price))
          ? m.specialPrice : (m.price || null);
        if (eff == null) continue;
        await pool.query(
          `UPDATE products SET applied_price = $3 WHERE tenant_id = $1 AND sku = $2`,
          [t.id, a.sku, Math.round(eff * 100) / 100]);
        read++;
        if (Math.abs(eff - parseFloat(a.recommended_price)) < 0.02) applied++;
      }
      summary.push(`${t.name}: ${applied}/${acts.length} applicati (letti ${read})`);
      console.log(`[AppliedPrice] ${t.name}: ${applied}/${acts.length} applicati su Magento (letti ${read})`);
    } catch (e) {
      console.log(`[AppliedPrice] ${t.name} skip: ${e.message}`);
    }
  }
  return summary;
}

let cronStarted = false;

function startAppliedPriceMirror() {
  if (cronStarted) return;
  cronStarted = true;
  // Ogni 2h al minuto :40 (fuori fase da healthCron :00 e magentoSyncCron :30)
  setTimeout(() => {
    runAppliedPriceMirror().catch(e => console.error('[AppliedPrice] err:', e.message));
    setInterval(() => {
      runAppliedPriceMirror().catch(e => console.error('[AppliedPrice] err:', e.message));
    }, 2 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);
  console.log('[AppliedPrice] Cron started — ogni 2h, primo run tra 10 min');
}

module.exports = { runAppliedPriceMirror, startAppliedPriceMirror };
