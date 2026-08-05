// Check DIRETTO da Farmabooster: quanti civetta=1 su SubitoFarma (tag product_civetta)
const { pool } = require('/app/db/pool');
const { getFarmaboosterConfig, fetchAllPages } = require('/app/services/farmaboosterClient');

(async () => {
  const { rows: [t] } = await pool.query("SELECT id FROM tenants WHERE name='SubitoFarma'");
  const config = await getFarmaboosterConfig(t.id);
  console.log(new Date().toISOString(), 'fetch API FB SubitoFarma...');
  const data = await fetchAllPages(t.id, config, 'products', 500, (d, tot) => {
    if (d % 25 === 0 || d === tot) console.log(`pagine ${d}/${tot}`);
  });

  let c1 = 0;
  const setFB = new Set();
  let c1_stock_prezzo = 0; // il filtro Magento dell'utente: giacenza>=1 e prezzo>=2
  for (const p of data) {
    const civ = p.product_civetta === '1' || p.product_civetta === 1;
    if (!civ) continue;
    c1++;
    setFB.add(p.product_code);
    const stock = (parseInt(p.product_erp_stock || 0) + parseInt(p.product_supplier_stock || 0));
    const price = parseFloat(p.product_price) || parseFloat(p.product_exported_price) || 0;
    if (stock >= 1 && price >= 2) c1_stock_prezzo++;
  }
  console.log(`\n=== CHECK DIRETTO FARMABOOSTER (${new Date().toISOString()}) ===`);
  console.log(`prodotti totali API: ${data.length}`);
  console.log(`civetta=1 (tag FB): ${c1}`);
  console.log(`civetta=1 con stock>=1 e prezzo>=2: ${c1_stock_prezzo}`);

  const { rows: dbRows } = await pool.query(
    'SELECT sku FROM products WHERE tenant_id=$1 AND is_civetta=true', [t.id]);
  const dbCiv = new Set(dbRows.map(r => r.sku));
  let both = 0, fbOnly = 0, magOnly = 0;
  for (const sku of setFB) { if (dbCiv.has(sku)) both++; else fbOnly++; }
  for (const sku of dbCiv) { if (!setFB.has(sku)) magOnly++; }
  console.log(`\n=== CONFRONTO CON DB (fonte attuale: Magento, ultimo sync) ===`);
  console.log(`DB is_civetta=true: ${dbCiv.size}`);
  console.log(`accordo FB=1 e DB=1: ${both}`);
  console.log(`DISACCORDO — FB dice 1, DB/Magento dice 0: ${fbOnly}`);
  console.log(`DISACCORDO — DB/Magento dice 1, FB dice 0: ${magOnly}`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
