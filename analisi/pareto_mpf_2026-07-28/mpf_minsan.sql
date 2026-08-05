\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
BEGIN;
CREATE TEMP TABLE cp ON COMMIT DROP AS
WITH z AS (SELECT product_code sku, SUM(clicks) clk FROM zombie_clicks WHERE tenant_id=:mpf AND fetch_date='2026-07-28' GROUP BY 1),
net30 AS (
  SELECT oi.sku, SUM(oi.row_total_incl_tax) eur, COUNT(DISTINCT o.id) ord, COUNT(DISTINCT o.tenant_id) n_ten
  FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.tenant_id<>:mpf AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
    AND o.order_date>=NOW()-INTERVAL '30 days' GROUP BY 1),
mpf30 AS (
  SELECT oi.sku, SUM(oi.row_total_incl_tax) eur, COUNT(DISTINCT o.id) ord
  FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.tenant_id=:mpf AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
    AND o.order_date>=NOW()-INTERVAL '30 days' GROUP BY 1)
SELECT z.sku, z.clk, ROUND(z.clk*0.3294,2) costo, left(p.product_name,28) prod,
  is_brand_protected(:mpf,z.sku) brand, is_basket_protected(:mpf,z.sku) carr,
  COALESCE(ROUND(n.eur),0) eur_rete, COALESCE(n.ord,0) ord_rete, COALESCE(n.n_ten,0) ten_rete,
  COALESCE(ROUND(m.eur),0) eur_mpf, COALESCE(m.ord,0) ord_mpf
FROM z JOIN products p ON p.tenant_id=:mpf AND p.sku=z.sku
LEFT JOIN net30 n ON n.sku=z.sku LEFT JOIN mpf30 m ON m.sku=z.sku
WHERE is_brand_protected(:mpf,z.sku) OR is_basket_protected(:mpf,z.sku);

\echo '===== SKU cliccati oggi + PROTETTI: portano vendite reali? ====='
SELECT COUNT(*) sku_protetti, SUM(clk) clk, ROUND(SUM(costo)) costo_oggi,
  COUNT(*) FILTER (WHERE ord_rete>0 OR ord_mpf>0) portano_ordini,
  COUNT(*) FILTER (WHERE ord_rete=0 AND ord_mpf=0) zero_ordini_30gg,
  ROUND(SUM(costo) FILTER (WHERE ord_rete=0 AND ord_mpf=0)) costo_zero,
  ROUND(SUM(eur_rete+eur_mpf)) eur_generato_30gg
FROM cp;
\echo ''
\echo '===== PROTETTI che NON portano NULLA in 30gg (rete+mpf) — protezione fantasma ====='
SELECT sku, prod, clk, costo, CASE WHEN brand THEN 'BRAND' ELSE 'carrello' END prot
FROM cp WHERE ord_rete=0 AND ord_mpf=0 ORDER BY clk DESC LIMIT 20;
\echo ''
\echo '===== PROTETTI che PORTANO (top per eur rete+mpf) — protezione giusta ====='
SELECT sku, prod, clk, costo, eur_rete, ord_rete, ten_rete, eur_mpf, ord_mpf,
  CASE WHEN brand THEN 'BRAND' ELSE 'carr' END prot
FROM cp WHERE ord_rete>0 OR ord_mpf>0 ORDER BY (eur_rete+eur_mpf) DESC LIMIT 15;
COMMIT;
