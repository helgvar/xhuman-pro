/**
 * Pareto Rule analysis — quale quota di prodotti genera l'80% del fatturato?
 *
 * Aggrega gli ordini per tenant (o cross-tenant se tenant_id non è passato).
 *
 * Output: lista degli SKU che compongono il top X% di revenue cumulata, con
 * prezzo min/max/medio across i tenant che vendono lo stesso SKU.
 *
 * REVISIONE 6/8/2026 — quattro difetti che rendevano la classifica inattendibile:
 *   1. row_total (IVA ESCLUSA) confrontato con erp_cost (IVA INCLUSA): il
 *      fatturato usciva sottostimato del 12,7%. Ora row_total_incl_tax.
 *   2. blacklist di stati (NOT IN canceled/closed/pending_payment): lasciava
 *      passare payment_review e gli stati temporanei. Ora WHITELIST esplicita,
 *      la stessa di tutti gli altri motori.
 *   3. NOW() è UTC ma order_date è Europe/Rome: la finestra scivolava di due
 *      ore, spostando ordini fra un giorno e l'altro. Ora AT TIME ZONE su
 *      entrambi i lati del confronto.
 *   4. finestra di default a 90 giorni. La legge di casa è max 30: su 90 il
 *      bacino si gonfia e la coda sembra più ricca di quello che è.
 *
 * La classifica sul FATTURATO risponde a "chi porta i soldi". Per decidere chi
 * tenere in vetrina serve il MARGINE al netto del costo click: quello lo dà
 * GET /tenant/:tenantId qui sotto.
 */

// Stati ordine validi — whitelist, mai blacklist (un nuovo stato inventato a
// valle non deve poter entrare di straforo nei conti).
const STATI_VALIDI = ['processing', 'pending', 'complete', 'ritiro_farmacia', 'Ritirato'];
const CPC = 0.3294;   // €0,27 + IVA 22%

const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { requireRole } = require('../middleware/acl');

const router = express.Router();
router.use(authMiddleware);

// GET /api/pareto/products?days=30&cumulative_pct=80&tenant_id=<uuid>
// query params:
//   - days: finestra in giorni (default 30 — la legge di casa)
//   - cumulative_pct: soglia di revenue cumulato (default 80)
//   - tenant_id: se assente aggrega tutta la rete
router.get('/products', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || 30), 1), 365);
    const cumulativePct = Math.min(Math.max(parseFloat(req.query.cumulative_pct || 80), 1), 100);
    const tenantId = req.query.tenant_id || null;

    const { rows: aggregate } = await pool.query(`
      WITH revenue_per_sku AS (
        SELECT oi.sku,
               SUM(oi.row_total_incl_tax) AS total_revenue,
               SUM(oi.qty_ordered) AS total_qty,
               COUNT(DISTINCT o.tenant_id) AS n_tenants,
               COUNT(DISTINCT o.id) AS n_orders
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.order_status = ANY($3)
          AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
              >= ((NOW() AT TIME ZONE 'Europe/Rome')::date - $1::int)
          AND ($4::uuid IS NULL OR o.tenant_id = $4::uuid)
        GROUP BY oi.sku
        HAVING SUM(oi.row_total_incl_tax) > 0
      ),
      ranked AS (
        SELECT sku, total_revenue, total_qty, n_tenants, n_orders,
               SUM(total_revenue) OVER (ORDER BY total_revenue DESC, sku ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_revenue,
               SUM(total_revenue) OVER () AS grand_total,
               ROW_NUMBER() OVER (ORDER BY total_revenue DESC, sku ASC) AS rn,
               COUNT(*) OVER () AS total_skus
        FROM revenue_per_sku
      ),
      pareto AS (
        SELECT *, ROUND((cum_revenue / NULLIF(grand_total, 0) * 100)::numeric, 2) AS cum_pct
        FROM ranked
        WHERE (cum_revenue / NULLIF(grand_total, 0) * 100) <= $2
      ),
      tenant_prices AS (
        SELECT p.sku, p.tenant_id, t.name AS tenant_name, p.sell_price
        FROM products p
        JOIN tenants t ON t.id = p.tenant_id
        WHERE p.sku IN (SELECT sku FROM pareto) AND p.sell_price > 0 AND t.status = 'active'
      ),
      prices AS (
        SELECT tp.sku,
               MIN(tp.sell_price) AS price_min,
               MAX(tp.sell_price) AS price_max,
               ROUND(AVG(tp.sell_price)::numeric, 2) AS price_avg,
               (array_agg(tp.tenant_name ORDER BY tp.sell_price ASC, tp.tenant_name ASC))[1] AS tenant_min,
               (array_agg(tp.tenant_name ORDER BY tp.sell_price DESC, tp.tenant_name ASC))[1] AS tenant_max,
               COUNT(*) AS n_tenant_prices,
               jsonb_agg(jsonb_build_object('tenant', tp.tenant_name, 'price', tp.sell_price) ORDER BY tp.sell_price ASC) AS tenant_prices
        FROM tenant_prices tp
        GROUP BY tp.sku
      ),
      product_meta AS (
        SELECT p.sku,
               (array_agg(DISTINCT p.product_name) FILTER (WHERE p.product_name IS NOT NULL AND p.product_name != ''))[1] AS product_name,
               (array_agg(DISTINCT p.brand) FILTER (WHERE p.brand IS NOT NULL AND p.brand != ''))[1] AS brand
        FROM products p
        WHERE p.sku IN (SELECT sku FROM pareto)
        GROUP BY p.sku
      )
      SELECT par.sku,
             pm.product_name,
             pm.brand,
             ROUND(par.total_revenue::numeric, 2) AS total_revenue,
             par.total_qty,
             par.n_tenants,
             par.n_orders,
             pri.price_min,
             pri.price_max,
             pri.price_avg,
             pri.tenant_min,
             pri.tenant_max,
             pri.tenant_prices,
             ROUND(((pri.price_max - pri.price_min) / NULLIF(pri.price_min, 0) * 100)::numeric, 1) AS spread_pct,
             par.cum_pct,
             par.rn,
             par.total_skus
      FROM pareto par
      LEFT JOIN prices pri USING (sku)
      LEFT JOIN product_meta pm USING (sku)
      ORDER BY par.rn
    `, [days, cumulativePct, STATI_VALIDI, tenantId]);

    // Tenant leaderboard: chi vende piu' prodotti che sono nei top N della Pareto
    const topN = Math.min(Math.max(parseInt(req.query.top_n || 50), 1), 500);
    const topSkus = aggregate.slice(0, topN).map(r => r.sku);
    let tenantLeaderboard = [];
    if (topSkus.length > 0) {
      const { rows: leaderboard } = await pool.query(`
        SELECT t.id AS tenant_id, t.name AS tenant_name,
               COUNT(DISTINCT oi.sku) AS skus_in_top,
               COALESCE(SUM(oi.qty_ordered), 0) AS qty_in_top,
               ROUND(COALESCE(SUM(oi.row_total_incl_tax), 0)::numeric, 2) AS revenue_in_top
        FROM tenants t
        LEFT JOIN orders o ON o.tenant_id = t.id
          AND o.order_status = ANY($3)
          AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
              >= ((NOW() AT TIME ZONE 'Europe/Rome')::date - $1::int)
        LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.sku = ANY($2)
        WHERE t.status = 'active'
        GROUP BY t.id, t.name
        ORDER BY skus_in_top DESC, revenue_in_top DESC
      `, [days, topSkus, STATI_VALIDI]);
      tenantLeaderboard = leaderboard.map(r => ({
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name,
        skus_in_top: parseInt(r.skus_in_top) || 0,
        qty_in_top: parseInt(r.qty_in_top) || 0,
        revenue_in_top: parseFloat(r.revenue_in_top) || 0,
        coverage_pct: topN > 0 ? +((parseInt(r.skus_in_top) / topN) * 100).toFixed(1) : 0,
      }));
    }

    // Stats globali
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(DISTINCT oi.sku) AS unique_skus,
        ROUND(SUM(oi.row_total_incl_tax)::numeric, 2) AS grand_total_revenue,
        SUM(oi.qty_ordered) AS total_qty,
        COUNT(DISTINCT o.id) AS total_orders,
        COUNT(DISTINCT o.tenant_id) AS active_tenants
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_status = ANY($2)
        AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
            >= ((NOW() AT TIME ZONE 'Europe/Rome')::date - $1::int)
        AND ($3::uuid IS NULL OR o.tenant_id = $3::uuid)
    `, [days, STATI_VALIDI, tenantId]);

    const totalSkus = parseInt(stats.unique_skus) || 0;
    const paretoSkus = aggregate.length;
    const paretoRevenue = aggregate.reduce((s, r) => s + parseFloat(r.total_revenue || 0), 0);
    const paretoPctSkus = totalSkus > 0 ? (paretoSkus / totalSkus) * 100 : 0;
    const paretoPctRevenue = stats.grand_total_revenue > 0
      ? (paretoRevenue / parseFloat(stats.grand_total_revenue)) * 100
      : 0;

    res.json({
      window_days: days,
      cumulative_pct_target: cumulativePct,
      stats: {
        total_unique_skus: totalSkus,
        total_revenue: parseFloat(stats.grand_total_revenue || 0),
        total_qty: parseInt(stats.total_qty || 0),
        total_orders: parseInt(stats.total_orders || 0),
        active_tenants: parseInt(stats.active_tenants || 0),
      },
      pareto: {
        skus_in_pareto: paretoSkus,
        skus_pct_of_total: +paretoPctSkus.toFixed(2),
        revenue_in_pareto: +paretoRevenue.toFixed(2),
        revenue_pct_of_total: +paretoPctRevenue.toFixed(2),
        ratio: paretoPctSkus > 0 ? +(paretoPctRevenue / paretoPctSkus).toFixed(2) : 0,
      },
      tenant_leaderboard: tenantLeaderboard,
      tenant_leaderboard_top_n: topN,
      products: aggregate,
    });
  } catch (err) {
    console.error('[Pareto] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pareto/tenant/:tenantId?windows=30,60,90&cumulative_pct=80
//
// La Pareto operativa: non basta sapere chi porta il fatturato, serve sapere
// chi lo porta al netto di quello che costa tenerlo in vetrina.
//
// Tre differenze dalla /products qui sopra:
//   - il margine viene da costo_vero() (mig 066), non da margin_pct;
//   - gli SKU con costo_vero = 0 NON entrano nel margine. Costo zero significa
//     scaffale vuoto E grossista vuoto: il costo non lo sappiamo, non e' zero.
//     Sommarli farebbe passare il fatturato pieno per margine (su MPF erano 73
//     SKU e 3.473 EUR, che gonfiavano di 75x il bacino delle pepite). Restano
//     contati a parte in sku_costo_ignoto, cosi' il buco si vede;
//   - accanto a testa e coda c'e' il FUORI CURVA: gli SKU che stanno nel feed e
//     nella finestra non hanno venduto niente. Su MPF sono la massa piu' grande
//     di tutte, e la Pareto da sola non li vedrebbe.
router.get('/tenant/:tenantId', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const tenantId = req.params.tenantId;
    const cumulativePct = Math.min(Math.max(parseFloat(req.query.cumulative_pct || 80), 1), 100);
    const windows = String(req.query.windows || '30,60,90')
      .split(',')
      .map(d => Math.min(Math.max(parseInt(d, 10) || 0, 1), 365))
      .filter((d, i, a) => a.indexOf(d) === i)
      .sort((a, b) => a - b)
      .slice(0, 5);

    const { rows: [tenant] } = await pool.query('SELECT id, name FROM tenants WHERE id = $1', [tenantId]);
    if (!tenant) return res.status(404).json({ error: 'tenant non trovato' });

    const BANDE = `
      WITH vend AS (
        SELECT oi.sku,
               SUM(oi.qty_ordered)                    AS pezzi,
               SUM(oi.row_total_incl_tax)             AS fatturato,
               SUM(oi.row_total_incl_tax - oi.qty_ordered * costo_vero($1::uuid, oi.sku)) AS margine,
               MAX(costo_vero($1::uuid, oi.sku)) > 0  AS costo_noto,
               COUNT(DISTINCT o.id)                   AS ordini
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.tenant_id = $1::uuid
          AND o.order_status = ANY($3)
          AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
              >= ((NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int)
        GROUP BY oi.sku
        HAVING SUM(oi.row_total_incl_tax) > 0
      ),
      clic AS (
        SELECT z.product_code AS sku, SUM(z.clicks) AS click
        FROM zombie_clicks z
        WHERE z.tenant_id = $1::uuid
          AND z.fetch_date >= ((NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int)
        GROUP BY z.product_code
      ),
      feed AS (
        SELECT jsonb_array_elements_text(config_value::jsonb->'codes') AS sku
        FROM tenant_configs
        WHERE tenant_id = $1::uuid AND config_key = 'stable_feed_codes'
      ),
      par AS (
        SELECT v.*, COALESCE(c.click, 0) AS click,
               COALESCE(c.click, 0) * $4::numeric AS costo,
               SUM(v.fatturato) OVER (ORDER BY v.fatturato DESC, v.sku)
                 / NULLIF(SUM(v.fatturato) OVER (), 0) AS cum
        FROM vend v LEFT JOIN clic c ON c.sku = v.sku
      )
      SELECT CASE WHEN cum <= $5::numeric / 100 THEN 'testa' ELSE 'coda' END AS fascia,
             COUNT(*)::bigint                                        AS sku,
             COALESCE(SUM(pezzi), 0)::numeric                        AS pezzi,
             COALESCE(SUM(ordini), 0)::bigint                        AS ordini,
             COALESCE(SUM(fatturato), 0)::numeric                    AS fatturato,
             COALESCE(SUM(margine) FILTER (WHERE costo_noto), 0)::numeric AS margine,
             COUNT(*) FILTER (WHERE NOT costo_noto)::bigint          AS sku_costo_ignoto,
             COALESCE(SUM(click), 0)::bigint                         AS click,
             COALESCE(SUM(costo), 0)::numeric                        AS costo_tp
      FROM par GROUP BY 1
      UNION ALL
      SELECT 'fuori_curva',
             COUNT(*)::bigint, 0::numeric, 0::bigint, 0::numeric, 0::numeric, 0::bigint,
             COALESCE(SUM(c.click), 0)::bigint,
             (COALESCE(SUM(c.click), 0) * $4::numeric)
      FROM feed f
      LEFT JOIN par p ON p.sku = f.sku
      LEFT JOIN clic c ON c.sku = f.sku
      WHERE p.sku IS NULL
    `;

    const finestre = [];
    for (const days of windows) {
      const { rows } = await pool.query(BANDE, [tenantId, days, STATI_VALIDI, CPC, cumulativePct]);
      const banda = (nome) => {
        const r = rows.find(x => x.fascia === nome);
        if (!r) return { sku: 0, pezzi: 0, ordini: 0, fatturato: 0, margine: 0, sku_costo_ignoto: 0, click: 0, costo_tp: 0, netto: 0, incidenza_pct: null };
        const fatturato = +parseFloat(r.fatturato).toFixed(2);
        const margine = +parseFloat(r.margine).toFixed(2);
        const costoTp = +parseFloat(r.costo_tp).toFixed(2);
        return {
          sku: parseInt(r.sku),
          pezzi: +parseFloat(r.pezzi).toFixed(0),
          ordini: parseInt(r.ordini),
          fatturato,
          margine,
          sku_costo_ignoto: parseInt(r.sku_costo_ignoto),
          click: parseInt(r.click),
          costo_tp: costoTp,
          netto: +(margine - costoTp).toFixed(2),
          incidenza_pct: fatturato > 0 ? +((costoTp / fatturato) * 100).toFixed(2) : null,
        };
      };
      const testa = banda('testa');
      const coda = banda('coda');
      const fuori = banda('fuori_curva');
      const skuVenditori = testa.sku + coda.sku;
      finestre.push({
        days,
        sku_che_vendono: skuVenditori,
        fatturato_totale: +(testa.fatturato + coda.fatturato).toFixed(2),
        // quota di venditori che serve per fare l'80%: il vero indice di
        // concentrazione. Il 20/80 da manuale sta a 20; piu' sale, piu' la
        // testa e' grassa e meno la Pareto e' una leva.
        quota_testa_pct: skuVenditori > 0 ? +((testa.sku / skuVenditori) * 100).toFixed(1) : 0,
        testa, coda, fuori_curva: fuori,
      });
    }

    // Dettaglio per SKU sulla finestra piu' corta — quella su cui si decide.
    const primaria = windows[0];
    const limit = Math.min(Math.max(parseInt(req.query.limit || 500), 1), 5000);
    const { rows: products } = await pool.query(`
      WITH vend AS (
        SELECT oi.sku,
               SUM(oi.qty_ordered)        AS pezzi,
               SUM(oi.row_total_incl_tax) AS fatturato,
               SUM(oi.row_total_incl_tax - oi.qty_ordered * costo_vero($1::uuid, oi.sku)) AS margine,
               MAX(costo_vero($1::uuid, oi.sku)) AS costo_unitario,
               COUNT(DISTINCT o.id)       AS ordini
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.tenant_id = $1::uuid
          AND o.order_status = ANY($3)
          AND (o.order_date AT TIME ZONE 'Europe/Rome')::date
              >= ((NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int)
        GROUP BY oi.sku
        HAVING SUM(oi.row_total_incl_tax) > 0
      ),
      clic AS (
        SELECT z.product_code AS sku, SUM(z.clicks) AS click
        FROM zombie_clicks z
        WHERE z.tenant_id = $1::uuid
          AND z.fetch_date >= ((NOW() AT TIME ZONE 'Europe/Rome')::date - $2::int)
        GROUP BY z.product_code
      ),
      feed AS (
        SELECT jsonb_array_elements_text(config_value::jsonb->'codes') AS sku
        FROM tenant_configs
        WHERE tenant_id = $1::uuid AND config_key = 'stable_feed_codes'
      )
      SELECT v.sku, p.product_name, p.brand,
             v.pezzi::numeric, v.ordini::bigint,
             ROUND(v.fatturato::numeric, 2) AS fatturato,
             CASE WHEN v.costo_unitario > 0 THEN ROUND(v.margine::numeric, 2) END AS margine,
             (v.costo_unitario > 0) AS costo_noto,
             COALESCE(c.click, 0)::bigint AS click,
             ROUND((COALESCE(c.click, 0) * $4::numeric), 2) AS costo_tp,
             CASE WHEN v.costo_unitario > 0
                  THEN ROUND((v.margine - COALESCE(c.click, 0) * $4::numeric)::numeric, 2) END AS netto,
             (f.sku IS NOT NULL) AS in_feed,
             p.erp_stock, p.supplier_stock, phs.scraper_position,
             ROW_NUMBER() OVER (ORDER BY v.fatturato DESC, v.sku) AS rn,
             ROUND((SUM(v.fatturato) OVER (ORDER BY v.fatturato DESC, v.sku)
                    / NULLIF(SUM(v.fatturato) OVER (), 0) * 100)::numeric, 2) AS cum_pct
      FROM vend v
      LEFT JOIN clic c ON c.sku = v.sku
      LEFT JOIN feed f ON f.sku = v.sku
      LEFT JOIN products p ON p.tenant_id = $1::uuid AND p.sku = v.sku
      LEFT JOIN product_health_scores phs ON phs.tenant_id = $1::uuid AND phs.sku = v.sku
      ORDER BY v.fatturato DESC, v.sku
      LIMIT $5
    `, [tenantId, primaria, STATI_VALIDI, CPC, limit]);

    res.json({
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      cumulative_pct_target: cumulativePct,
      cpc: CPC,
      window_primary_days: primaria,
      windows: finestre,
      products,
    });
  } catch (err) {
    console.error('[Pareto tenant] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pareto/sku/:sku/cross-tenant-prices — prezzi per uno SKU su tutti i tenant
router.get('/sku/:sku/cross-tenant-prices', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.name AS tenant_name, p.sell_price, p.erp_cost, p.margin_pct, p.is_civetta
      FROM products p
      JOIN tenants t ON t.id = p.tenant_id
      WHERE p.sku = $1 AND p.sell_price > 0 AND t.status = 'active'
      ORDER BY p.sell_price ASC, t.name ASC
    `, [req.params.sku]);
    if (rows.length === 0) return res.json({ sku: req.params.sku, prices: [], stats: null });
    const prices = rows.map(r => parseFloat(r.sell_price));
    const stats = {
      n_tenants: rows.length,
      price_min: Math.min(...prices),
      price_max: Math.max(...prices),
      price_avg: +(prices.reduce((s, p) => s + p, 0) / prices.length).toFixed(2),
      spread_pct: +(((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100).toFixed(1),
    };
    res.json({ sku: req.params.sku, prices: rows, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
