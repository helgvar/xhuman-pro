/**
 * Quarantine Recovery — rilascia progressivamente SKU dalla quarantena per
 * ricostruire la breadth del catalogo TP dopo eventi di "mass quarantine".
 *
 * Strategia: rilascia in batch giornalieri (default 200/gg) gli SKU prioritizzati
 * per probabilita' di tornare utili:
 *  1. sales_30d_aggregated > 0 (vendono globalmente)
 *  2. is_civetta (erano gia' nel feed prima)
 *  3. margine alto (margine_pct DESC)
 *  4. quarantena piu' vecchia prima
 *
 * Caso d'uso: Farmacri 15/4/2026 ha quarantinato 4227 SKU low_click_no_conversion
 * causando -65% fatturato (breadth penalty TP).
 */

const { pool } = require('../db/pool');

/**
 * Rilascia un batch di SKU in quarantena per un tenant.
 * @param {string} tenantId
 * @param {object} opts - { batchSize, reason, dryRun }
 * @returns {{ released: number, candidates: Array }}
 */
async function releaseQuarantineBatch(tenantId, opts = {}) {
  const batchSize = opts.batchSize || 200;
  const reasonFilter = opts.reason || null; // optional filter on quarantine reason
  const dryRun = opts.dryRun === true;

  // Candidates: priorita' = sales_30d_aggregated DESC, civetta, margin DESC, quarantine_start ASC
  const params = [tenantId, batchSize];
  let where = `fq.tenant_id = $1 AND fq.reactivated = false`;
  if (reasonFilter) {
    params.push(reasonFilter);
    where += ` AND fq.reason = $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT fq.sku, fq.reason, fq.quarantine_start::date qs,
           p.is_civetta, p.margin_pct, p.sell_price,
           p.sales_30d_aggregated, p.sales_30d_seller,
           p.erp_stock + p.supplier_stock AS stock_tot
    FROM feed_quarantine fq
    LEFT JOIN products p ON p.tenant_id = fq.tenant_id AND p.sku = fq.sku
    WHERE ${where}
      AND (p.erp_stock > 0 OR p.supplier_stock > 0)
      AND COALESCE(p.sell_price, 0) > 0
    ORDER BY
      COALESCE(p.sales_30d_aggregated, 0) DESC,
      COALESCE(p.is_civetta::int, 0) DESC,
      COALESCE(p.margin_pct, 0) DESC,
      fq.quarantine_start ASC
    LIMIT $2
  `, params);

  if (dryRun) return { released: 0, candidates: rows, dryRun: true };

  if (rows.length === 0) return { released: 0, candidates: [] };

  const skus = rows.map(r => r.sku);
  await pool.query(`
    UPDATE feed_quarantine
    SET reactivated = true, reactivated_at = NOW()
    WHERE tenant_id = $1 AND sku = ANY($2) AND reactivated = false
  `, [tenantId, skus]);

  // Log into optimization_log per tracking
  await pool.query(`
    INSERT INTO optimization_log (tenant_id, action_type, description, products_affected, skus_affected, metadata)
    VALUES ($1, 'quarantine_recovery', $2, $3, $4, $5)
  `, [
    tenantId,
    `Recovery progressivo: rilasciati ${rows.length} SKU dalla quarantena per ricostruire breadth catalog`,
    rows.length, skus,
    JSON.stringify({ reason_filter: reasonFilter, batch_size: batchSize, priorities: 'sales_30d_aggregated, civetta, margin_pct, oldest first' })
  ]);

  return { released: rows.length, candidates: rows };
}

/**
 * Recovery scheduler: per ogni tenant che ha avuto un mass-quarantine event recente,
 * rilascia un batch giornaliero finche' il backlog non si esaurisce.
 * Da chiamare 1x al giorno.
 */
async function dailyRecoveryRun(opts = {}) {
  const batchSize = opts.batchSize || 200;
  // Trova tenant con > 1000 SKU in quarantena attiva (sintomo di mass quarantine)
  const { rows: tenants } = await pool.query(`
    SELECT t.id, t.name, COUNT(fq.id) AS in_quarantine
    FROM tenants t
    JOIN feed_quarantine fq ON fq.tenant_id = t.id AND fq.reactivated = false
    WHERE t.status = 'active'
    GROUP BY t.id, t.name
    HAVING COUNT(fq.id) >= 1000
    ORDER BY in_quarantine DESC
  `);
  const results = [];
  for (const t of tenants) {
    const r = await releaseQuarantineBatch(t.id, { batchSize });
    results.push({ tenant: t.name, in_quarantine: parseInt(t.in_quarantine), released: r.released });
    console.log(`[QuarantineRecovery] [${t.name}] released ${r.released}/${batchSize} (${t.in_quarantine} still in queue)`);
  }
  return results;
}

module.exports = { releaseQuarantineBatch, dailyRecoveryRun };
