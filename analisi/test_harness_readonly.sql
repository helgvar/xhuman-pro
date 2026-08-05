-- ============================================================
-- HARNESS READ-ONLY / TEST — algoritmi TP adattati alla dottrina
-- Nessuna scrittura. Nessuna azione operativa. Solo SELECT.
-- A2 = step_map floor-safe (esterni, floor costo, no rete)
-- A3 = rule_of_three zombie dry-run (ordini REALI Magento)
-- ============================================================

\set cpc 0.3294

-- mappa tenant operativi -> merchant scraper
WITH tmap(tenant_id, merchant) AS (VALUES
  ('15c1ccef-1c92-4d6c-9783-bcec866d79e0'::uuid,'Farmacia Mandanici'),
  ('fc7b3a98-7494-4beb-9a78-f0c71e29722b'::uuid,'Farmacia Procaccini'),
  ('a65865ad-212a-4eff-a249-f56a6e19243b'::uuid,'Farmainsieme'),
  ('ab7353a4-5916-4ef2-874b-3058430a53ee'::uuid,'Farmastelia'),
  ('d581c087-6b92-4050-b52a-5bd5c087553a'::uuid,'My Personal Farma'),
  ('6a1217ad-b605-4517-a630-a40bb24eaf9d'::uuid,'Farmacia Papa'),
  ('af00239a-3775-4c8b-8f56-61f05442ec2e'::uuid,'Subitofarma')),
sib(m) AS (VALUES ('Subitofarma'),('Farmastelia'),('My Personal Farma'),
  ('Farmacia Papa'),('Farmacia Procaccini'),('Farmacia Mandanici'),
  ('Farmainsieme'),('Farmacia San Vito'),('Farmacia dell''Ospedale')),
ours AS (
  SELECT tm.tenant_id, tm.merchant, sc.product_code,
         sc.base_price my_price, COALESCE(sc.shipping_cost,0) my_ship,
         sc.base_price+COALESCE(sc.shipping_cost,0) my_total
  FROM tmap tm JOIN scraper_competitors sc ON sc.merchant=tm.merchant),
ext AS (  -- concorrente ESTERNO piu' vicino sotto di noi (total)
  SELECT o.tenant_id, o.merchant, o.product_code, o.my_price, o.my_ship, o.my_total,
         MAX(sc.base_price+COALESCE(sc.shipping_cost,0)) nearest_ext_total
  FROM ours o JOIN scraper_competitors sc ON sc.product_code=o.product_code
  WHERE sc.merchant NOT IN (SELECT m FROM sib)
    AND sc.base_price+COALESCE(sc.shipping_cost,0) < o.my_total
  GROUP BY 1,2,3,4,5,6),
gated AS (
  SELECT e.*, p.erp_stock,
    CASE WHEN p.erp_stock>0 AND p.erp_purchase_cost>0 THEN p.erp_purchase_cost ELSE p.erp_cost END cost,
    (e.nearest_ext_total-0.01-e.my_ship) needed_price
  FROM ext e JOIN products p ON p.sku=e.product_code AND p.tenant_id=e.tenant_id
  WHERE (CASE WHEN p.erp_stock>0 AND p.erp_purchase_cost>0 THEN p.erp_purchase_cost ELSE p.erp_cost END) > 0),
scored AS (
  SELECT *, cost*(1+CASE WHEN cost<10 THEN 0.18 WHEN cost<=30 THEN 0.14 ELSE 0.12 END) floor_price
  FROM gated)
SELECT (SELECT merchant FROM tmap WHERE tenant_id=s.tenant_id) tenant,
  COUNT(*) sku_ext_below,
  COUNT(*) FILTER (WHERE needed_price>=floor_price) floor_safe,
  COUNT(*) FILTER (WHERE needed_price>=floor_price AND erp_stock>0) floor_safe_stock
FROM scored s GROUP BY s.tenant_id ORDER BY floor_safe DESC;

-- ============================================================
-- A3 = rule_of_three zombie DRY-RUN (read-only)
-- clicks: zombie_clicks 30gg | orders: order_items x orders whitelist 30gg
-- candidato SUSPEND = clicks>=60 (ceil(3/0.05)) AND orders_reali=0 AND NOT protetto
-- NB test economico pieno (3/n)*AOV*margine<CPC -> soglia ~156 click: ancora meno
-- ============================================================
WITH tmap(tenant_id,name) AS (VALUES
  ('15c1ccef-1c92-4d6c-9783-bcec866d79e0'::uuid,'Mandanici'),
  ('fc7b3a98-7494-4beb-9a78-f0c71e29722b'::uuid,'Procaccini'),
  ('a65865ad-212a-4eff-a249-f56a6e19243b'::uuid,'Farmainsieme'),
  ('ab7353a4-5916-4ef2-874b-3058430a53ee'::uuid,'Farmastelia'),
  ('d581c087-6b92-4050-b52a-5bd5c087553a'::uuid,'MPF'),
  ('6a1217ad-b605-4517-a630-a40bb24eaf9d'::uuid,'Papa'),
  ('af00239a-3775-4c8b-8f56-61f05442ec2e'::uuid,'SubitoFarma')),
clk AS (SELECT tenant_id,product_code,SUM(clicks) clicks FROM zombie_clicks
  WHERE fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 30 GROUP BY 1,2),
ord AS (SELECT o.tenant_id,oi.sku,SUM(oi.qty_ordered) qty
  FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
    AND (o.order_date AT TIME ZONE 'Europe/Rome')::date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 30
  GROUP BY 1,2),
cand AS (SELECT c.tenant_id,c.product_code,c.clicks,COALESCE(o.qty,0) orders
  FROM clk c LEFT JOIN ord o ON o.tenant_id=c.tenant_id AND o.sku=c.product_code)
SELECT tm.name tenant,
  COUNT(*) FILTER (WHERE clicks>=60 AND orders=0) zombie_60,
  ROUND(SUM(clicks*0.3294) FILTER (WHERE clicks>=60 AND orders=0)) spreco_eur_30gg,
  COUNT(*) FILTER (WHERE clicks>=60 AND orders=0 AND NOT is_feed_protected(tm.tenant_id,product_code)) zombie_non_protetti
FROM cand JOIN tmap tm ON tm.tenant_id=cand.tenant_id
GROUP BY tm.name ORDER BY spreco_eur_30gg DESC NULLS LAST;
