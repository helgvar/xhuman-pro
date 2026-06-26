/**
 * Cross-Tenant OBLIO
 * Sezione globale per SKU "burner cross-tenant": click su >2 tenant,
 * 0 vendite ovunque, bruciano budget seriale.
 *
 * Cron giovedì 02:00 UTC: popola top 50 nuovi burner.
 * Cron giornaliero 03:00 UTC: rilascia SKU che hanno venduto.
 * Engine usa la lista OBLIO active per forzare REMOVE su tutti i tenant.
 */

const { pool } = require('../db/pool');

const POPOLA_BATCH_SIZE = 50;

/**
 * Query "burner cross-tenant" reusabile:
 *  click su >2 tenant E 0 vendite (store, aggr, ord reali) ovunque.
 */
async function findCrossTenantBurners(limit = 50, excludeSkus = []) {
  const { rows } = await pool.query(`
    -- Ordini reali Magento 90g (qualunque tenant)
    WITH ord_reali_90d AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) AS ord_90d
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.order_status NOT IN ('canceled','closed','pending_payment')
        AND o.order_date >= NOW() - INTERVAL '90 days'
      GROUP BY oi.sku
    ),
    -- Sales seller/aggregated (FB fornisce 30d, fallback)
    sales_all AS (
      SELECT sku,
        SUM(COALESCE(sales_30d_seller,0)) AS store_tot,
        MAX(COALESCE(sales_30d_aggregated,0)) AS aggr_max
      FROM products GROUP BY sku
    ),
    -- Click e cost 90g aggregati da feed_daily_tracking (per tenant + sku)
    clicks_90d AS (
      SELECT sku, tenant_id,
        SUM(clicks) AS click_tot, SUM(click_cost) AS cost_tot
      FROM feed_daily_tracking
      WHERE track_date >= NOW() - INTERVAL '90 days'
      GROUP BY sku, tenant_id HAVING SUM(clicks) > 0
    ),
    -- Aggregazione cross-tenant: n_tenant distinti + click/cost totale
    cross_tenant AS (
      SELECT c.sku,
        COUNT(DISTINCT c.tenant_id) AS n_tenant,
        SUM(c.click_tot) AS click_tot,
        SUM(c.cost_tot) AS cost_tot
      FROM clicks_90d c
      GROUP BY c.sku
    )
    SELECT
      ct.sku,
      (SELECT MAX(product_name) FROM products WHERE sku=ct.sku) AS product_name,
      (SELECT MAX(brand) FROM products WHERE sku=ct.sku) AS brand,
      ct.n_tenant, ct.click_tot, ct.cost_tot
    FROM cross_tenant ct
    LEFT JOIN sales_all s ON s.sku = ct.sku
    LEFT JOIN ord_reali_90d o ON o.sku = ct.sku
    WHERE ct.n_tenant > 2
      AND COALESCE(s.store_tot,0) = 0
      AND COALESCE(s.aggr_max,0) = 0
      AND COALESCE(o.ord_90d,0) = 0
      AND ($2::text[] IS NULL OR NOT (ct.sku = ANY($2::text[])))
    ORDER BY ct.cost_tot DESC
    LIMIT $1
  `, [limit, excludeSkus.length > 0 ? excludeSkus : null]);
  return rows;
}

/**
 * Popola OBLIO con top N burner cross-tenant non già presenti.
 */
async function populateOblio(batchSize = POPOLA_BATCH_SIZE) {
  // Prendi SKU già attivi per non duplicare
  const { rows: active } = await pool.query(
    `SELECT sku FROM cross_tenant_oblio WHERE status='active'`
  );
  const activeSkus = active.map(r => r.sku);

  const burners = await findCrossTenantBurners(batchSize, activeSkus);

  let inserted = 0;
  for (const b of burners) {
    await pool.query(`
      INSERT INTO cross_tenant_oblio
        (sku, product_name, brand, added_reason, tenants_affected, click_at_add, cost_at_add, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
      ON CONFLICT DO NOTHING
    `, [
      b.sku, b.product_name, b.brand,
      `Burner cross-tenant: ${b.n_tenant} tenant, ${b.click_tot} click, €${parseFloat(b.cost_tot).toFixed(2)} cost 30g, 0 vendite ovunque`,
      b.n_tenant, b.click_tot, b.cost_tot,
    ]);
    inserted++;
  }
  console.log(`[OBLIO] Inserted ${inserted} new burners (excluded ${activeSkus.length} already active)`);
  return { inserted, alreadyActive: activeSkus.length };
}

/**
 * Check daily: rilascia SKU OBLIO che ora hanno vendite.
 */
async function checkAndReleaseOblio() {
  const { rows: oblioSkus } = await pool.query(
    `SELECT id, sku FROM cross_tenant_oblio WHERE status='active'`
  );

  if (oblioSkus.length === 0) return { checked: 0, released: 0 };

  const skuList = oblioSkus.map(o => o.sku);

  // Verifica vendite (store/aggregated 30d + ord reali 90g) per ogni SKU
  const { rows: stillBurner } = await pool.query(`
    WITH ord_reali_90d AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) AS ord_90d
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.order_status NOT IN ('canceled','closed','pending_payment')
        AND o.order_date >= NOW() - INTERVAL '90 days'
      GROUP BY oi.sku
    ),
    sales_all AS (
      SELECT sku,
        SUM(COALESCE(sales_30d_seller,0)) AS store_tot,
        MAX(COALESCE(sales_30d_aggregated,0)) AS aggr_max
      FROM products WHERE sku = ANY($1)
      GROUP BY sku
    )
    SELECT s.sku
    FROM sales_all s LEFT JOIN ord_reali_90d o ON o.sku = s.sku
    WHERE COALESCE(s.store_tot,0) = 0
      AND COALESCE(s.aggr_max,0) = 0
      AND COALESCE(o.ord_90d,0) = 0
  `, [skuList]);

  const stillBurnerSet = new Set(stillBurner.map(r => r.sku));
  const toRelease = oblioSkus.filter(o => !stillBurnerSet.has(o.sku));

  for (const r of toRelease) {
    await pool.query(`
      UPDATE cross_tenant_oblio
      SET status='released', released_at=NOW(),
          released_reason='Ha venduto: store/aggregated/ord reali > 0',
          last_check_at=NOW()
      WHERE id=$1
    `, [r.id]);
  }

  // Update last_check_at su tutti
  await pool.query(
    `UPDATE cross_tenant_oblio SET last_check_at=NOW() WHERE status='active'`
  );

  console.log(`[OBLIO] Checked ${oblioSkus.length}, released ${toRelease.length} (have sales)`);
  return { checked: oblioSkus.length, released: toRelease.length };
}

/**
 * Ritorna lista SKU attualmente in OBLIO (per integrazione engine).
 */
async function getActiveOblioSkus() {
  const { rows } = await pool.query(
    `SELECT sku FROM cross_tenant_oblio WHERE status='active'`
  );
  return rows.map(r => r.sku);
}

// ─── CRON SCHEDULING ──────────────────────────────────────

let cronStarted = false;

function startOblioCron() {
  if (cronStarted) return;
  cronStarted = true;

  // Check vendite ogni 6h (00:30, 06:30, 12:30, 18:30 UTC) per rilasciare
  // SKU che iniziano a vendere
  scheduleEveryHours(6, 30, async () => {
    try { await checkAndReleaseOblio(); }
    catch (e) { console.error('[OBLIO] 6h check error:', e.message); }
  });

  // Weekly populate giovedì 02:00 UTC (getDay()=4)
  scheduleWeekly(4, 2, 0, async () => {
    try { await populateOblio(POPOLA_BATCH_SIZE); }
    catch (e) { console.error('[OBLIO] weekly populate error:', e.message); }
  });

  console.log('[OBLIO] Cron started: 6h release check, weekly populate Thu 02:00 UTC');
}

function scheduleEveryHours(hours, minuteOffset, fn) {
  const intervalMs = hours * 3600 * 1000;
  // Trova prossimo slot allineato (es. 00:30, 06:30, 12:30, 18:30)
  const now = new Date();
  const slotMinutes = minuteOffset;
  const currentMs = now.getUTCHours() * 3600000 + now.getUTCMinutes() * 60000 + now.getUTCSeconds() * 1000;
  const slotAlignMs = (Math.floor(currentMs / intervalMs) + 1) * intervalMs + slotMinutes * 60000;
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const firstFire = dayStartMs + slotAlignMs;
  setTimeout(() => {
    fn();
    setInterval(fn, intervalMs);
  }, firstFire - now.getTime());
}

function scheduleWeekly(dayUTC, hourUTC, minuteUTC, fn) {
  const tick = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, minuteUTC, 0));
    while (next.getUTCDay() !== dayUTC || next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    setTimeout(async () => {
      await fn();
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
}

module.exports = {
  findCrossTenantBurners,
  populateOblio,
  checkAndReleaseOblio,
  getActiveOblioSkus,
  startOblioCron,
};
