// Elenco venduti-senza-click con ultima visita scraper per MINSAN
const { pool } = require('/app/db/pool');
const { runClickLossMonitor } = require('/app/services/clickLossMonitor');

(async () => {
  const rows = await runClickLossMonitor({ notify: false });
  const per = { alta: [], media: [], bassa: [] };
  for (const r of rows) { if (per[r.freq]) per[r.freq].push(r); }
  const sel = [...per.alta, ...per.media.slice(0, 25), ...per.bassa.slice(0, 15)];
  for (const r of sel) {
    const { rows: [s] } = await pool.query(
      "SELECT TO_CHAR(MAX(scraped_at), 'DD/MM HH24:MI') u FROM scraper_competitors WHERE product_code = $1", [r.sku]);
    const { rows: [m] } = await pool.query(
      "SELECT TO_CHAR(last_seen, 'DD/MM HH24:MI') u FROM scraper_listing_map WHERE product_code = $1", [r.sku]);
    console.log([
      r.freq.toUpperCase().padEnd(5),
      r.tenant.replace('Farmacia ', '').padEnd(12),
      r.sku,
      String(r.nome).padEnd(27),
      (r.ord90 + 'ord').padStart(6),
      (r.click_prima + '>' + r.click_dopo).padStart(7),
      r.diagnosi.padEnd(30),
      'scrape:' + (s && s.u ? s.u : 'MAI'),
      'listing:' + (m && m.u ? m.u : 'MAI'),
    ].join(' | '));
  }
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
