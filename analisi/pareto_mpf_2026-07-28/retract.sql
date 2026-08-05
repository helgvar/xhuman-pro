\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
BEGIN;
SELECT set_config('xhp.writer','sessione_capo_28lug',true);
SELECT set_config('xhp.motivo','ritiro_pareto_add_sotto_floor_guardiano_costo_28lug',true);

CREATE TEMP TABLE bad ON COMMIT DROP AS
SELECT fa.sku,
  ROUND(costo_vero(:mpf,fa.sku)::numeric,2) costo, ROUND(prezzo_vero(:mpf,fa.sku)::numeric,2) prezzo,
  ROUND(((prezzo_vero(:mpf,fa.sku)-costo_vero(:mpf,fa.sku))/NULLIF(costo_vero(:mpf,fa.sku),0)*100)::numeric,1) ric,
  CASE WHEN costo_vero(:mpf,fa.sku)<10 THEN 18 WHEN costo_vero(:mpf,fa.sku)<=30 THEN 14 ELSE 12 END floor_pct
FROM feed_actions fa
WHERE fa.tenant_id=:mpf AND fa.action='ADD' AND fa.action_source='pareto_ai'
  AND ((prezzo_vero(:mpf,fa.sku)-costo_vero(:mpf,fa.sku))/NULLIF(costo_vero(:mpf,fa.sku),0)*100)
      < (CASE WHEN costo_vero(:mpf,fa.sku)<10 THEN 18 WHEN costo_vero(:mpf,fa.sku)<=30 THEN 14 ELSE 12 END);

\echo '===== ritiro questi ====='
SELECT * FROM bad ORDER BY ric;

DELETE FROM feed_actions fa USING bad WHERE fa.tenant_id=:mpf AND fa.sku=bad.sku AND fa.action_source='pareto_ai';

\echo '===== ADD pareto rimasti (puliti) ====='
SELECT COUNT(*) FROM feed_actions WHERE tenant_id=:mpf AND action='ADD' AND action_source='pareto_ai';
COMMIT;
