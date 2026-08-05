\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
BEGIN;
CREATE TEMP TABLE res ON COMMIT DROP AS
WITH revenue_per_sku AS (
  SELECT oi.sku, SUM(oi.row_total) tr
  FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.order_status NOT IN ('canceled','closed','pending_payment')
    AND o.order_date>=NOW()-INTERVAL '90 days'
  GROUP BY 1 HAVING SUM(oi.row_total)>0),
ranked AS (
  SELECT sku, tr,
    SUM(tr) OVER (ORDER BY tr DESC, sku ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) cum,
    SUM(tr) OVER () gt
  FROM revenue_per_sku),
pareto AS (SELECT sku, tr FROM ranked WHERE cum/NULLIF(gt,0)*100 <= 80),
compext AS (
  SELECT sc.product_code sku, MIN(sc.total_price) comp_min, COUNT(*) n_comp
  FROM scraper_competitors sc
  WHERE sc.scraped_at>=NOW()-INTERVAL '48 hours'
    AND NOT EXISTS (SELECT 1 FROM tenant_merchant_rx r WHERE sc.merchant ILIKE '%'||r.rx||'%')
  GROUP BY 1)
SELECT p.sku, left(p.product_name,32) prod, p.brand,
  par.tr rev_rete_90g, p.erp_stock, p.supplier_stock, p.scraper_position pos,
  ROUND(costo_vero(:mpf,p.sku)::numeric,2) costo,
  ROUND(prezzo_vero(:mpf,p.sku)::numeric,2) prezzo,
  ce.comp_min, ce.n_comp,
  CASE WHEN p.erp_stock>0 THEN 'MAGAZZINO' ELSE 'grossista' END fonte,
  -- floor ricarico per fascia costo
  CASE WHEN costo_vero(:mpf,p.sku)<10 THEN 0.18 WHEN costo_vero(:mpf,p.sku)<=30 THEN 0.14 ELSE 0.12 END floor_pct,
  ROUND((costo_vero(:mpf,p.sku)*(CASE WHEN costo_vero(:mpf,p.sku)<10 THEN 1.18 WHEN costo_vero(:mpf,p.sku)<=30 THEN 1.14 ELSE 1.12 END))::numeric,2) floor_price
FROM products p
JOIN pareto par ON par.sku=p.sku
LEFT JOIN compext ce ON ce.sku=p.sku
WHERE p.tenant_id=:mpf
  AND (p.erp_stock>0 OR p.supplier_stock>0)
  AND (p.is_civetta=false OR EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=:mpf AND q.sku=p.sku AND q.reactivated=false));

-- classificazione posizionabilita
ALTER TABLE res ADD COLUMN verdetto text;
UPDATE res SET verdetto = CASE
  WHEN comp_min IS NULL THEN 'NO_SCRAPER_48h'
  WHEN floor_price <= comp_min - 0.01 AND prezzo <= comp_min - 0.01 THEN 'STANDALONE'
  WHEN floor_price <= comp_min - 0.01 THEN 'VIA_PC'
  ELSE 'NON_POSIZIONABILE_deserto' END;

\echo '===== PARETO ∩ MPF disponibile ∩ FUORI FEED — riepilogo ====='
SELECT verdetto, COUNT(*) sku,
  COUNT(*) FILTER (WHERE fonte='MAGAZZINO') magazz,
  COUNT(*) FILTER (WHERE fonte='grossista') gross,
  ROUND(SUM(rev_rete_90g)) rev_rete_90g
FROM res GROUP BY 1 ORDER BY 2 DESC;
\echo ''
\echo '===== STANDALONE (reinserisci subito, gia sotto competitor, floor-safe) — top 25 per rev rete ====='
SELECT sku, prod, fonte, erp_stock stk, supplier_stock sup, costo, prezzo, comp_min, floor_price, pos, ROUND(rev_rete_90g) rev90
FROM res WHERE verdetto='STANDALONE' ORDER BY rev_rete_90g DESC LIMIT 25;
\echo ''
\echo '===== VIA_PC (serve cut ma resta floor-safe) — top 25 per rev rete ====='
SELECT sku, prod, fonte, erp_stock stk, supplier_stock sup, costo, prezzo, comp_min, floor_price,
  ROUND((prezzo-comp_min)::numeric,2) gap_da_tagliare, ROUND(rev_rete_90g) rev90
FROM res WHERE verdetto='VIA_PC' ORDER BY rev_rete_90g DESC LIMIT 25;
COMMIT;
