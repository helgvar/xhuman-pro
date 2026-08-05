\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
\echo '===== click/ordine benchmark oggi ====='
SELECT t.name,
  (SELECT SUM(clicks) FROM zombie_clicks z WHERE z.tenant_id=t.id AND fetch_date='2026-07-28') clk,
  (SELECT COUNT(DISTINCT o.id) FROM orders o WHERE o.tenant_id=t.id AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato') AND (o.order_date AT TIME ZONE 'Europe/Rome')::date='2026-07-28') ord
FROM tenants t WHERE t.name IN ('MPF','SubitoFarma','Farmacia Procaccini','Papa','Farmastelia');
\echo ''
\echo '===== MPF concentrazione: quanti SKU fanno il costo, quanti vendono ====='
WITH z AS (SELECT product_code sku, SUM(clicks) clk FROM zombie_clicks WHERE tenant_id=:mpf AND fetch_date='2026-07-28' GROUP BY 1),
sold30 AS (SELECT DISTINCT oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.tenant_id=:mpf AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato') AND o.order_date>=NOW()-INTERVAL '30 days')
SELECT COUNT(*) sku_cliccati_oggi, SUM(clk) click_tot,
  COUNT(*) FILTER (WHERE s.sku IS NULL) sku_NO_vend30, ROUND(SUM(clk) FILTER (WHERE s.sku IS NULL)*0.3294) costo_NO_vend30,
  COUNT(*) FILTER (WHERE s.sku IS NOT NULL) sku_vend30, ROUND(SUM(clk) FILTER (WHERE s.sku IS NOT NULL)*0.3294) costo_vend30
FROM z LEFT JOIN sold30 s ON s.sku=z.sku;
\echo ''
\echo '===== MPF top 25 click oggi: dove va il budget ====='
WITH z AS (SELECT product_code sku, SUM(clicks) clk FROM zombie_clicks WHERE tenant_id=:mpf AND fetch_date='2026-07-28' GROUP BY 1),
sold30 AS (SELECT oi.sku, SUM(oi.row_total_incl_tax) rev, COUNT(DISTINCT o.id) ord FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.tenant_id=:mpf AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato') AND o.order_date>=NOW()-INTERVAL '30 days' GROUP BY 1)
SELECT z.clk, ROUND(z.clk*0.3294,1) costo, left(p.product_name,30) prod,
  ROUND(COALESCE(p.applied_price,p.exported_price,p.sell_price)::numeric,2) prezzo,
  COALESCE(p.scraper_position::text,'—') pos, COALESCE(p.erp_stock,0) stk,
  COALESCE(ROUND(s.rev),0) rev30, COALESCE(s.ord,0) ord30,
  CASE WHEN is_brand_protected(:mpf,z.sku) THEN 'BRAND' WHEN is_basket_protected(:mpf,z.sku) THEN 'carrello'
       WHEN EXISTS(SELECT 1 FROM capo_pins cp WHERE cp.tenant_id=:mpf AND cp.sku=z.sku AND cp.revoked_at IS NULL) THEN 'PIN' ELSE '' END prot
FROM z JOIN products p ON p.tenant_id=:mpf AND p.sku=z.sku
LEFT JOIN sold30 s ON s.sku=z.sku
ORDER BY z.clk DESC LIMIT 25;
\echo ''
\echo '===== MPF click per categoria trovaprezzi oggi ====='
SELECT COALESCE(NULLIF(trovaprezzi_category,''),'(vuota)') categoria, SUM(clicks) clk, ROUND(SUM(clicks)*0.3294) costo, COUNT(DISTINCT product_code) sku
FROM zombie_clicks WHERE tenant_id=:mpf AND fetch_date='2026-07-28' GROUP BY 1 ORDER BY clk DESC LIMIT 12;
