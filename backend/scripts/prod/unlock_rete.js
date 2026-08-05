// SBLOCCO RETE (ordine capo 11/7): la liberazione fatta su SubitoFarma estesa
// a tutti i tenant. Dentro: civetta FB con stock>=1 e prezzo>=2, non in CSV,
// senza evidenza (la "dieta" era ingiusta: lo scraper FB era FERMO dal 9/7).
// FUORI restano: OBLIO, quarantene, REMOVE (spreco documentato).
const { pool } = require('/app/db/pool');
const { recalculateStableCache } = require('/app/routes/externalApi');

const INSERT_SQL = `
WITH csv AS (SELECT jsonb_array_elements_text(tc.config_value::jsonb->'codes') sku
  FROM tenant_configs tc WHERE tc.tenant_id=$1 AND tc.config_key='stable_feed_codes'),
cfg AS (SELECT
  (SELECT MAX((rule_data->>'scraper_position')::int) FROM price_rules pr WHERE pr.tenant_id=$1 AND (rule_data->>'scraper_position')::int > 0) AS max_pos,
  (SELECT COALESCE(config_value::int,0) FROM health_config hc WHERE hc.tenant_id=$1 AND config_key='strict_pos_target_min') AS pos_min),
ordini30 AS (SELECT DISTINCT oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.tenant_id=$1 AND o.order_status NOT IN ('canceled','closed','pending_payment') AND o.order_date >= NOW()-INTERVAL '30 days'),
base AS (
  SELECT p.tenant_id, p.sku, p.sell_price, p.erp_stock,
    EXISTS (SELECT 1 FROM csv WHERE csv.sku=p.sku) AS in_csv,
    EXISTS (SELECT 1 FROM cross_tenant_oblio o WHERE o.sku=p.sku AND o.status='active') AS oblio,
    EXISTS (SELECT 1 FROM feed_quarantine fq WHERE fq.tenant_id=$1 AND fq.sku=p.sku AND fq.reactivated=false) AS quar,
    EXISTS (SELECT 1 FROM feed_actions fa WHERE fa.tenant_id=$1 AND fa.sku=p.sku AND fa.action='REMOVE') AS remv,
    EXISTS (SELECT 1 FROM product_health_scores h, cfg
      WHERE h.tenant_id=$1 AND h.sku=p.sku
        AND h.scraper_position <= GREATEST(COALESCE(NULLIF((SELECT (pr2.rule_data->>'scraper_position')::int
          FROM price_rules pr2 WHERE pr2.tenant_id=p.tenant_id AND pr2.rule_id=p.price_rule_id),0), cfg.max_pos, 10), cfg.pos_min)) AS pos_ok,
    (EXISTS (SELECT 1 FROM ordini30 WHERE ordini30.sku=p.sku) OR COALESCE(p.sales_30d_seller,0)>0 OR COALESCE(p.sales_30d_aggregated,0)>=2) AS vende,
    EXISTS (SELECT 1 FROM activation_cohorts ac WHERE ac.tenant_id=$1 AND ac.sku=p.sku AND ac.activated_at >= NOW()-INTERVAL '14 days') AS coorte,
    EXISTS (SELECT 1 FROM order_items oi JOIN orders o2 ON o2.id=oi.order_id
      WHERE oi.sku=p.sku AND o2.order_date >= NOW()-INTERVAL '60 days' AND o2.order_status NOT IN ('canceled','closed')) AS rete60,
    (SELECT h2.scraper_position FROM product_health_scores h2 WHERE h2.tenant_id=$1 AND h2.sku=p.sku) AS pos
  FROM products p
  WHERE p.tenant_id=$1 AND p.is_civetta=true
    AND (COALESCE(p.erp_stock,0)+COALESCE(p.supplier_stock,0))>=1 AND COALESCE(p.sell_price,0)>=2)
INSERT INTO activation_cohorts (cohort_name, tenant_id, sku, sell_price, ricarico_pct, scraper_position, erp_stock, note)
SELECT 'gap_sblocco_capo_20260711', b.tenant_id, b.sku, b.sell_price, NULL, b.pos, b.erp_stock,
  CASE WHEN b.rete60 THEN 'sblocco capo 11/7: domanda di rete 60g'
       ELSE 'sblocco capo 11/7: liberazione rete (scraper FB fermo dal 9/7)' END
FROM base b
WHERE NOT b.in_csv AND NOT b.oblio AND NOT b.quar AND NOT b.remv
  AND NOT (b.pos_ok OR b.vende OR b.coorte)`;

const csvCount = async (tid) => {
  const { rows: [r] } = await pool.query(
    `SELECT jsonb_array_length(config_value::jsonb->'codes') n FROM tenant_configs
     WHERE tenant_id=$1 AND config_key='stable_feed_codes'`, [tid]);
  return r ? r.n : 0;
};

(async () => {
  const { rows: tenants } = await pool.query(
    "SELECT id, name FROM tenants WHERE status='active' ORDER BY name");
  let totIns = 0;
  for (const t of tenants) {
    try {
      const before = await csvCount(t.id);
      const { rowCount } = await pool.query(INSERT_SQL, [t.id]);
      totIns += rowCount;
      await recalculateStableCache(t.id);
      const after = await csvCount(t.id);
      console.log(`${t.name}: +${rowCount} sbloccati | CSV ${before} -> ${after}`);
    } catch (e) {
      console.error(`${t.name} ERR:`, e.message);
    }
  }
  console.log(`DONE sblocco rete: ${totIns} prodotti liberati in totale`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
