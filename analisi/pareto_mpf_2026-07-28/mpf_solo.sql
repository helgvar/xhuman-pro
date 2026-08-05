\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
BEGIN;
CREATE TEMP TABLE nosell ON COMMIT DROP AS
WITH clk30 AS (
  SELECT product_code sku, SUM(clicks) clk FROM zombie_clicks
  WHERE tenant_id=:mpf AND fetch_date>='2026-06-28' GROUP BY 1),
mpf30 AS (
  SELECT oi.sku, COUNT(DISTINCT o.id) ord FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.tenant_id=:mpf AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
    AND o.order_date>=NOW()-INTERVAL '30 days' GROUP BY 1)
SELECT c.sku, c.clk, ROUND(c.clk*0.3294,2) costo, left(p.product_name,30) prod,
  p.erp_stock, p.supplier_stock, p.scraper_position pos,
  is_brand_protected(:mpf,c.sku) brand, is_sconto_rule_product(:mpf,c.sku) sconto,
  is_muro_rule_product(:mpf,c.sku) muro, is_basket_protected(:mpf,c.sku) carr,
  EXISTS(SELECT 1 FROM capo_pins cp WHERE cp.tenant_id=:mpf AND cp.sku=c.sku AND cp.revoked_at IS NULL) pin,
  EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=:mpf AND q.sku=c.sku AND q.reactivated=false) gia_tagl
FROM clk30 c JOIN products p ON p.tenant_id=:mpf AND p.sku=c.sku
LEFT JOIN mpf30 m ON m.sku=c.sku
WHERE m.ord IS NULL;

\echo '===== MPF: cliccato ma ZERO ordini QUI (30gg) ====='
SELECT COUNT(*) sku, SUM(clk) clk_30gg, ROUND(SUM(costo)) costo_30gg, ROUND(SUM(costo)/30,2) costo_gg,
  ROUND(SUM(costo)*12,0) costo_anno FROM nosell;
\echo ''
\echo '===== spacco per cosa BLOCCA il taglio (priorita: gia_tagl>pin>brand>sconto>muro>carr>LIBERO) ====='
SELECT CASE
  WHEN gia_tagl THEN '0_gia_tagliato'
  WHEN pin THEN '1_pin_capo'
  WHEN brand THEN '2_BRAND_cliente'
  WHEN sconto THEN '3_sconto_cliente'
  WHEN muro THEN '4_muro_cliente'
  WHEN carr THEN '5_carrello_90gg'
  ELSE '6_LIBERO_tagliabile' END blocco,
  COUNT(*) sku, SUM(clk) clk, ROUND(SUM(costo)) costo_30gg, ROUND(SUM(costo)/30,2) costo_gg
FROM nosell GROUP BY 1 ORDER BY 1;
\echo ''
\echo '===== LIBERI tagliabili subito (no veto) split magazzino vs grossista ====='
SELECT CASE WHEN erp_stock>0 THEN 'MAGAZZINO' ELSE 'grossista' END fonte,
  COUNT(*) sku, SUM(clk) clk, ROUND(SUM(costo)) costo_30gg
FROM nosell WHERE NOT gia_tagl AND NOT pin AND NOT brand AND NOT sconto AND NOT muro AND NOT carr
GROUP BY 1 ORDER BY 1;
\echo ''
\echo '===== TOP 30 LIBERI per click (spreco puro qui) ====='
SELECT sku, prod, clk, costo, erp_stock stk, supplier_stock sup, pos,
  CASE WHEN erp_stock>0 THEN 'MAGAZZ' ELSE 'gross' END fonte
FROM nosell WHERE NOT gia_tagl AND NOT pin AND NOT brand AND NOT sconto AND NOT muro AND NOT carr
ORDER BY clk DESC LIMIT 30;
COMMIT;
