\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
BEGIN;
SELECT set_config('xhp.writer','sessione_capo_28lug',true);
SELECT set_config('xhp.motivo','pareto_pc_wave2_floorsafe_guardiano_28lug',true);

CREATE TEMP TABLE cand ON COMMIT DROP AS
WITH revenue_per_sku AS (
  SELECT oi.sku, SUM(oi.row_total) tr FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.order_status NOT IN ('canceled','closed','pending_payment') AND o.order_date>=NOW()-INTERVAL '90 days'
  GROUP BY 1 HAVING SUM(oi.row_total)>0),
ranked AS (SELECT sku,tr, SUM(tr) OVER (ORDER BY tr DESC,sku ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) cum, SUM(tr) OVER () gt FROM revenue_per_sku),
pareto AS (SELECT sku,tr FROM ranked WHERE cum/NULLIF(gt,0)*100<=80),
compext AS (SELECT sc.product_code sku, MIN(sc.total_price) comp_min, ROUND(EXTRACT(EPOCH FROM(NOW()-MAX(sc.scraped_at)))/3600,1) age_h
  FROM scraper_competitors sc WHERE sc.scraped_at>=NOW()-INTERVAL '48 hours'
    AND NOT EXISTS(SELECT 1 FROM tenant_merchant_rx r WHERE sc.merchant ILIKE '%'||r.rx||'%') GROUP BY 1)
SELECT p.sku, par.tr rev90,
  ROUND(costo_vero(:mpf,p.sku)::numeric,2) costo,
  ROUND(prezzo_vero(:mpf,p.sku)::numeric,2) px_now,
  ce.comp_min, ce.age_h scr_age,
  ROUND(EXTRACT(EPOCH FROM(NOW()-p.updated_at))/3600,1) sync_age,
  ROUND((ce.comp_min-0.01)::numeric,2) target,
  ROUND((costo_vero(:mpf,p.sku)*(CASE WHEN costo_vero(:mpf,p.sku)<10 THEN 1.18 WHEN costo_vero(:mpf,p.sku)<=30 THEN 1.14 ELSE 1.12 END))::numeric,2) floor_price,
  ROUND((((ce.comp_min-0.01)-costo_vero(:mpf,p.sku))/NULLIF(costo_vero(:mpf,p.sku),0)*100)::numeric,1) ric_target,
  p.scraper_position pos, (pr.rule_data->>'type') rule_type, p.erp_stock, p.supplier_stock,
  p.erp_purchase_cost
FROM products p
JOIN pareto par ON par.sku=p.sku
JOIN compext ce ON ce.sku=p.sku
LEFT JOIN price_rules pr ON pr.tenant_id=p.tenant_id AND pr.rule_id=p.price_rule_id
WHERE p.tenant_id=:mpf
  AND (p.erp_stock>0 OR p.supplier_stock>0)
  AND COALESCE(p.sell_price,0)>0
  AND (p.is_civetta=false OR EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=:mpf AND q.sku=p.sku AND q.reactivated=false))
  -- freschezza dura
  AND p.updated_at>=NOW()-INTERVAL '4 hours'
  AND ce.age_h<=4
  -- VIA_PC: prezzo attuale SOPRA il target (serve cut), e floor raggiungibile
  AND prezzo_vero(:mpf,p.sku) > ce.comp_min-0.01
  AND (costo_vero(:mpf,p.sku)*(CASE WHEN costo_vero(:mpf,p.sku)<10 THEN 1.18 WHEN costo_vero(:mpf,p.sku)<=30 THEN 1.14 ELSE 1.12 END)) <= ce.comp_min-0.01
  -- GUARDIANO: target >= floor al costo di adesso, mai sotto costo, mai sotto costo acquisto se stock fisico
  AND (ce.comp_min-0.01) >= costo_vero(:mpf,p.sku)*(CASE WHEN costo_vero(:mpf,p.sku)<10 THEN 1.18 WHEN costo_vero(:mpf,p.sku)<=30 THEN 1.14 ELSE 1.12 END)
  AND (ce.comp_min-0.01) > costo_vero(:mpf,p.sku)
  AND (p.erp_stock=0 OR (ce.comp_min-0.01) >= COALESCE(NULLIF(p.erp_purchase_cost,0),0))
  -- dottrina prezzi: SOLO SB(3) o Ricarico(1) pos>4; MAI Sconto(2)/Muro(4)
  AND ( (pr.rule_data->>'type')='3'
        OR ((pr.rule_data->>'type')='1' AND COALESCE(p.scraper_position,99)>4) )
  -- veti cliente/capo
  AND NOT is_brand_protected(:mpf,p.sku) AND NOT is_sconto_rule_product(:mpf,p.sku) AND NOT is_muro_rule_product(:mpf,p.sku)
  AND NOT EXISTS(SELECT 1 FROM capo_pins cp WHERE cp.tenant_id=:mpf AND cp.sku=p.sku AND cp.revoked_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM cross_tenant_oblio o WHERE o.sku=p.sku AND o.status='active')
  AND NOT EXISTS(SELECT 1 FROM feed_actions fa WHERE fa.tenant_id=:mpf AND fa.sku=p.sku AND fa.action_source IN ('manual_pepita','manual_review','margin_harvest_pilot'));

\echo '===== Wave-2 candidati PC (post guardiano) ====='
SELECT COUNT(*) sku, ROUND(SUM(rev90)) rev90, ROUND(AVG(ric_target),1) ric_medio,
  ROUND(AVG(px_now-target),2) cut_medio, ROUND(MAX(px_now-target),2) cut_max,
  COUNT(*) FILTER (WHERE rule_type='3') sb, COUNT(*) FILTER (WHERE rule_type='1') ricarico FROM cand;

INSERT INTO feed_actions
  (tenant_id, sku, action, action_reason, action_source, current_price, recommended_price,
   price_cut_pct, erp_cost, new_margin, new_margin_pct, erp_stock, supplier_stock, status, computed_at, created_at)
SELECT :mpf, sku, 'PRICE_CUT',
  'Pareto PC Wave-2 28/7: venditore rete top80% fuori feed, cut floor-safe a comp-1c (pos1). Guardiano-costo live: ric_target '||ric_target||'% >= floor. Ordine capo.',
  'pareto_ai', px_now, target,
  ROUND(((px_now-target)/NULLIF(px_now,0)*100)::numeric,1), costo, ROUND((target-costo)::numeric,2), ric_target,
  erp_stock, supplier_stock, 'pending', NOW(), NOW()
FROM cand
ON CONFLICT (tenant_id, sku) DO UPDATE SET
  action='PRICE_CUT', action_reason=EXCLUDED.action_reason, action_source='pareto_ai',
  current_price=EXCLUDED.current_price, recommended_price=EXCLUDED.recommended_price,
  price_cut_pct=EXCLUDED.price_cut_pct, erp_cost=EXCLUDED.erp_cost,
  new_margin=EXCLUDED.new_margin, new_margin_pct=EXCLUDED.new_margin_pct, status='pending', computed_at=NOW()
WHERE feed_actions.action_source IS DISTINCT FROM 'manual_pepita'
  AND feed_actions.action_source IS DISTINCT FROM 'manual_review'
  AND feed_actions.action_source IS DISTINCT FROM 'margin_harvest_pilot';

\echo '===== PC pareto totali ====='
SELECT COUNT(*) FROM feed_actions WHERE tenant_id=:mpf AND action='PRICE_CUT' AND action_source='pareto_ai';
COMMIT;
