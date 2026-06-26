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
    WITH ord_reali AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) AS ord_30d
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.order_status NOT IN ('canceled','closed','pending_payment')
        AND o.order_date >= NOW() - INTERVAL '30 days'
      GROUP BY oi.sku
    ),
    sales_all AS (
      SELECT sku,
        SUM(COALESCE(sales_30d_seller,0)) AS store_tot,
        MAX(COALESCE(sales_30d_aggregated,0)) AS aggr_max
      FROM products GROUP BY sku
    ),
    clicks_civetta AS (
      SELECT p.sku,
        MAX(p.product_name) AS product_name,
        MAX(p.brand) AS brand,
        COUNT(DISTINCT p.tenant_id) FILTER (WHERE phs.tp_clicks_30d>0) AS n_tenant,
        SUM(phs.tp_clicks_30d) AS click_tot,
        SUM(phs.tp_click_cost_30d) AS cost_tot
      FROM products p
      JOIN product_health_scores phs ON phs.tenant_id=p.tenant_id AND phs.sku=p.sku
      WHERE p.is_civetta=true
      GROUP BY p.sku
    )
    SELECT c.sku, c.product_name, c.brand, c.n_tenant, c.click_tot, c.cost_tot
    FROM clicks_civetta c
    LEFT JOIN sales_all s ON s.sku = c.sku
    LEFT JOIN ord_reali o ON o.sku = c.sku
    WHERE c.n_tenant > 2
      AND COALESCE(s.store_tot,0) = 0
      AND COALESCE(s.aggr_max,0) = 0
      AND COALESCE(o.ord_30d,0) = 0
      AND ($2::text[] IS NULL OR NOT (c.sku = ANY($2::text[])))
    ORDER BY c.cost_tot DESC
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

  // Verifica vendite (store, aggregated, reali) per ogni SKU
  const { rows: stillBurner } = await pool.query(`
    WITH ord_reali AS (
      SELECT oi.sku, COUNT(DISTINCT o.id) AS ord_30d
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.order_status NOT IN ('canceled','closed','pending_payment')
        AND o.order_date >= NOW() - INTERVAL '30 days'
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
    FROM sales_all s LEFT JOIN ord_reali o ON o.sku = s.sku
    WHERE COALESCE(s.store_tot,0) = 0
      AND COALESCE(s.aggr_max,0) = 0
      AND COALESCE(o.ord_30d,0) = 0
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

  // Daily check ore 03:00 UTC
  scheduleDaily(3, 0, async () => {
    try { await checkAndReleaseOblio(); }
    catch (e) { console.error('[OBLIO] daily check error:', e.message); }
  });

  // Weekly populate giovedì 02:00 UTC (getDay()=4)
  scheduleWeekly(4, 2, 0, async () => {
    try { await populateOblio(POPOLA_BATCH_SIZE); }
    catch (e) { console.error('[OBLIO] weekly populate error:', e.message); }
  });

  console.log('[OBLIO] Cron started: daily check 03:00 UTC, weekly populate Thu 02:00 UTC');
}

function scheduleDaily(hourUTC, minuteUTC, fn) {
  const tick = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, minuteUTC, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      await fn();
      tick();
    }, next.getTime() - now.getTime());
  };
  tick();
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
