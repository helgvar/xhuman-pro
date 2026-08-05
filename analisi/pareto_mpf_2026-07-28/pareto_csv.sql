\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
COPY (
WITH revenue_per_sku AS (
  SELECT oi.sku, SUM(oi.row_total) tr, COUNT(DISTINCT o.tenant_id) n_ten, COUNT(DISTINCT o.id) n_ord
  FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.order_status NOT IN ('canceled','closed','pending_payment') AND o.order_date>=NOW()-INTERVAL '90 days'
  GROUP BY 1 HAVING SUM(oi.row_total)>0),
ranked AS (SELECT sku,tr,n_ten,n_ord, SUM(tr) OVER (ORDER BY tr DESC,sku ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) cum, SUM(tr) OVER () gt FROM revenue_per_sku),
pareto AS (SELECT sku,tr,n_ten,n_ord FROM ranked WHERE cum/NULLIF(gt,0)*100<=80),
compext AS (SELECT sc.product_code sku, MIN(sc.total_price) comp_min, COUNT(*) n_comp
  FROM scraper_competitors sc WHERE sc.scraped_at>=NOW()-INTERVAL '48 hours'
    AND NOT EXISTS(SELECT 1 FROM tenant_merchant_rx r WHERE sc.merchant ILIKE '%'||r.rx||'%') GROUP BY 1),
base AS (
SELECT p.sku, p.product_name prod, p.brand, par.tr rev90, par.n_ten, par.n_ord,
  p.erp_stock, p.supplier_stock, p.scraper_position pos,
  ROUND(costo_vero(:mpf,p.sku)::numeric,2) costo, ROUND(prezzo_vero(:mpf,p.sku)::numeric,2) prezzo,
  ce.comp_min, ce.n_comp,
  CASE WHEN p.erp_stock>0 THEN 'MAGAZZINO' ELSE 'grossista' END fonte,
  ROUND((costo_vero(:mpf,p.sku)*(CASE WHEN costo_vero(:mpf,p.sku)<10 THEN 1.18 WHEN costo_vero(:mpf,p.sku)<=30 THEN 1.14 ELSE 1.12 END))::numeric,2) floor_price
FROM products p JOIN pareto par ON par.sku=p.sku
LEFT JOIN compext ce ON ce.sku=p.sku
WHERE p.tenant_id=:mpf AND (p.erp_stock>0 OR p.supplier_stock>0)
  AND (p.is_civetta=false OR EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=:mpf AND q.sku=p.sku AND q.reactivated=false)))
SELECT sku, prod, brand, rev90, n_ten, n_ord, fonte, erp_stock, supplier_stock, pos, costo, prezzo, comp_min, n_comp, floor_price,
  ROUND((comp_min-0.01)::numeric,2) target_price,
  ROUND((((comp_min-0.01)-costo)/NULLIF(costo,0)*100)::numeric,1) ricarico_target_pct,
  CASE WHEN comp_min IS NULL THEN 'NO_SCRAPER_48h'
    WHEN floor_price > comp_min-0.01 THEN 'NON_POSIZIONABILE'
    WHEN prezzo>0 AND prezzo<=comp_min-0.01 THEN 'STANDALONE'
    WHEN prezzo=0 THEN 'REINSERISCI_prezzo_fb'
    ELSE 'VIA_PC' END verdetto,
  CASE WHEN comp_min IS NOT NULL AND prezzo>comp_min-0.01 AND floor_price<=comp_min-0.01 THEN ROUND((prezzo-(comp_min-0.01))::numeric,2) ELSE 0 END cut_needed
FROM base ORDER BY rev90 DESC
) TO STDOUT WITH CSV HEADER;
