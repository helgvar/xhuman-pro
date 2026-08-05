\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
\echo '===== dei 277 no-vend30 che prendono click oggi: costo per protezione ====='
WITH z AS (SELECT product_code sku, SUM(clicks) clk FROM zombie_clicks WHERE tenant_id=:mpf AND fetch_date='2026-07-28' GROUP BY 1),
sold30 AS (SELECT DISTINCT oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.tenant_id=:mpf AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato') AND o.order_date>=NOW()-INTERVAL '30 days'),
nv AS (SELECT z.sku, z.clk FROM z LEFT JOIN sold30 s ON s.sku=z.sku WHERE s.sku IS NULL)
SELECT
  ROUND(SUM(clk) FILTER (WHERE is_brand_protected(:mpf,sku))*0.3294) c_brand,
  COUNT(*) FILTER (WHERE is_brand_protected(:mpf,sku)) n_brand,
  ROUND(SUM(clk) FILTER (WHERE NOT is_brand_protected(:mpf,sku) AND is_basket_protected(:mpf,sku))*0.3294) c_carr,
  COUNT(*) FILTER (WHERE NOT is_brand_protected(:mpf,sku) AND is_basket_protected(:mpf,sku)) n_carr,
  ROUND(SUM(clk) FILTER (WHERE NOT is_brand_protected(:mpf,sku) AND NOT is_basket_protected(:mpf,sku) AND vende_in_rete_15g(sku))*0.3294) c_rete,
  COUNT(*) FILTER (WHERE NOT is_brand_protected(:mpf,sku) AND NOT is_basket_protected(:mpf,sku) AND vende_in_rete_15g(sku)) n_rete,
  ROUND(SUM(clk) FILTER (WHERE NOT is_brand_protected(:mpf,sku) AND NOT is_basket_protected(:mpf,sku) AND NOT vende_in_rete_15g(sku) AND COALESCE((SELECT erp_stock FROM products p WHERE p.tenant_id=:mpf AND p.sku=nv.sku),0)>0)*0.3294) c_magaz,
  COUNT(*) FILTER (WHERE NOT is_brand_protected(:mpf,sku) AND NOT is_basket_protected(:mpf,sku) AND NOT vende_in_rete_15g(sku) AND COALESCE((SELECT erp_stock FROM products p WHERE p.tenant_id=:mpf AND p.sku=nv.sku),0)>0) n_magaz,
  ROUND(SUM(clk) FILTER (WHERE NOT is_brand_protected(:mpf,sku) AND NOT is_basket_protected(:mpf,sku) AND NOT vende_in_rete_15g(sku) AND COALESCE((SELECT erp_stock FROM products p WHERE p.tenant_id=:mpf AND p.sku=nv.sku),0)=0)*0.3294) c_libero,
  COUNT(*) FILTER (WHERE NOT is_brand_protected(:mpf,sku) AND NOT is_basket_protected(:mpf,sku) AND NOT vende_in_rete_15g(sku) AND COALESCE((SELECT erp_stock FROM products p WHERE p.tenant_id=:mpf AND p.sku=nv.sku),0)=0) n_libero
FROM nv;
