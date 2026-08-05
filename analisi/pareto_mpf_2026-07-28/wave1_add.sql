\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
BEGIN;
SELECT set_config('xhp.writer','sessione_capo_28lug',true);
SELECT set_config('xhp.motivo','pareto_add_wave1_standalone_floorsafe_28lug',true);

CREATE TEMP TABLE w1 ON COMMIT DROP AS
WITH revenue_per_sku AS (
  SELECT oi.sku, SUM(oi.row_total) tr FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.order_status NOT IN ('canceled','closed','pending_payment') AND o.order_date>=NOW()-INTERVAL '90 days'
  GROUP BY 1 HAVING SUM(oi.row_total)>0),
ranked AS (SELECT sku,tr, SUM(tr) OVER (ORDER BY tr DESC,sku ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) cum, SUM(tr) OVER () gt FROM revenue_per_sku),
pareto AS (SELECT sku,tr FROM ranked WHERE cum/NULLIF(gt,0)*100<=80),
compext AS (SELECT sc.product_code sku, MIN(sc.total_price) comp_min FROM scraper_competitors sc
  WHERE sc.scraped_at>=NOW()-INTERVAL '48 hours' AND NOT EXISTS(SELECT 1 FROM tenant_merchant_rx r WHERE sc.merchant ILIKE '%'||r.rx||'%') GROUP BY 1)
SELECT p.sku, par.tr rev90, ce.comp_min,
  ROUND(costo_vero(:mpf,p.sku)::numeric,2) costo,
  ROUND(prezzo_vero(:mpf,p.sku)::numeric,2) prezzo,
  p.sell_price,
  ROUND((costo_vero(:mpf,p.sku)*(CASE WHEN costo_vero(:mpf,p.sku)<10 THEN 1.18 WHEN costo_vero(:mpf,p.sku)<=30 THEN 1.14 ELSE 1.12 END))::numeric,2) floor_price,
  p.erp_stock, p.supplier_stock
FROM products p JOIN pareto par ON par.sku=p.sku JOIN compext ce ON ce.sku=p.sku
WHERE p.tenant_id=:mpf
  AND (p.erp_stock>0 OR p.supplier_stock>0)
  AND COALESCE(p.sell_price,0)>0
  AND (p.is_civetta=false OR EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=:mpf AND q.sku=p.sku AND q.reactivated=false))
  -- STANDALONE: floor-safe E prezzo venduto gia sotto competitor
  AND (costo_vero(:mpf,p.sku)*(CASE WHEN costo_vero(:mpf,p.sku)<10 THEN 1.18 WHEN costo_vero(:mpf,p.sku)<=30 THEN 1.14 ELSE 1.12 END)) <= ce.comp_min-0.01
  AND prezzo_vero(:mpf,p.sku) > 0 AND prezzo_vero(:mpf,p.sku) <= ce.comp_min-0.01
  -- non in OBLIO attivo (salvo safety net magazzino o brand)
  AND (NOT EXISTS(SELECT 1 FROM cross_tenant_oblio o WHERE o.sku=p.sku AND o.status='active')
       OR (p.erp_stock>=5 AND COALESCE(p.margin_pct,0)>=20) OR is_brand_protected(:mpf,p.sku))
  -- non gia in quarantena bloccante
  AND NOT EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=:mpf AND q.sku=p.sku AND q.reactivated=false)
  -- non gia con ADD attivo
  AND NOT EXISTS(SELECT 1 FROM feed_actions fa WHERE fa.tenant_id=:mpf AND fa.sku=p.sku AND fa.action='ADD');

\echo '===== Wave-1 candidati puliti ====='
SELECT COUNT(*) sku, ROUND(SUM(rev90)) rev90,
  COUNT(*) FILTER (WHERE erp_stock>0) magazz, COUNT(*) FILTER (WHERE erp_stock=0) gross FROM w1;

INSERT INTO feed_actions
  (tenant_id, sku, action, action_reason, action_source, current_price, recommended_price, erp_stock, supplier_stock, status, computed_at, created_at)
SELECT :mpf, sku, 'ADD',
  'Pareto ADD Wave-1 28/7: venditore rete top80% fuori feed, disponibile, floor-safe (prezzo attuale gia sotto competitor esterno). Ordine capo.',
  'pareto_ai', prezzo, NULL, erp_stock, supplier_stock, 'pending', NOW(), NOW()
FROM w1
ON CONFLICT (tenant_id, sku) DO UPDATE SET
  action='ADD',
  action_reason=EXCLUDED.action_reason,
  action_source='pareto_ai',
  current_price=EXCLUDED.current_price,
  recommended_price=NULL,
  status='pending',
  computed_at=NOW()
WHERE feed_actions.action_source IS DISTINCT FROM 'manual_pepita'
  AND feed_actions.action_source IS DISTINCT FROM 'manual_review'
  AND feed_actions.action_source IS DISTINCT FROM 'margin_harvest_pilot';

\echo '===== inserito ====='
SELECT COUNT(*) FROM feed_actions WHERE tenant_id=:mpf AND action='ADD' AND action_source='pareto_ai' AND created_at>=NOW()-INTERVAL '2 min';
COMMIT;
