\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
\echo '===== TAGLIATO stasera con questo motivo ====='
SELECT COUNT(*) sku, ROUND(SUM(z.c*0.3294)) costo_30gg FROM feed_quarantine q
JOIN (SELECT product_code sku, SUM(clicks) c FROM zombie_clicks WHERE tenant_id=:mpf AND fetch_date>='2026-06-28' GROUP BY 1) z
  ON z.sku=q.sku
WHERE q.tenant_id=:mpf AND q.reason='Taglio capo 28/7 no-vendita-MPF (ignora rete, ordine capo)';
\echo ''
\echo '===== BLOCCATI dai trigger: perche (basket vs vendente-rete) ====='
WITH clk30 AS (SELECT product_code sku, SUM(clicks) clk FROM zombie_clicks WHERE tenant_id=:mpf AND fetch_date>='2026-06-28' GROUP BY 1),
mpf30 AS (SELECT oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.tenant_id=:mpf AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato') AND o.order_date>=NOW()-INTERVAL '30 days'),
cand AS (
  SELECT c.sku, c.clk FROM clk30 c JOIN products p ON p.tenant_id=:mpf AND p.sku=c.sku
  WHERE c.sku NOT IN (SELECT sku FROM mpf30)
    AND NOT is_brand_protected(:mpf,c.sku) AND NOT is_sconto_rule_product(:mpf,c.sku) AND NOT is_muro_rule_product(:mpf,c.sku)
    AND NOT EXISTS(SELECT 1 FROM capo_pins cp WHERE cp.tenant_id=:mpf AND cp.sku=c.sku AND cp.revoked_at IS NULL)),
blocked AS (
  SELECT cand.sku, cand.clk FROM cand
  WHERE NOT EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=:mpf AND q.sku=cand.sku AND q.reactivated=false))
SELECT CASE
  WHEN is_basket_protected(:mpf,sku) THEN 'basket_carrello'
  WHEN vende_in_rete_15g(sku) THEN 'vendente_rete'
  ELSE 'altro_trigger' END motivo,
  COUNT(*) sku, SUM(clk) clk, ROUND(SUM(clk*0.3294)) costo_30gg
FROM blocked GROUP BY 1 ORDER BY 3 DESC;
