-- 080: is_feed_protected — finestra seller 30 -> 15gg (dottrina finestre 15gg, mig 079)
--
-- La protezione "chi vende resta dentro" usava products.sales_30d_seller
-- (campo precomputato a 30gg): unica finestra keep-in rimasta a 30gg dopo la
-- mig 079. Burn misurato 1/8: SKU zero-conv 15gg tenuti dentro solo da vendite
-- vecchie 15-30gg = MPF ~€409/15gg + Farmastelia ~€259/15gg.
--
-- Fix: EXISTS su ordini REALI del tenant negli ultimi 15 giorni (stesso
-- pattern di is_price_cut_allowed, mig 079). Chi vende resta protetto: cambia
-- solo la definizione di "vende" (15gg, non 30). Indici: idx_order_items_sku
-- (tenant_id, sku) + orders pkey.

CREATE OR REPLACE FUNCTION public.is_feed_protected(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
      EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id = p_tenant AND cp.sku = p_sku AND cp.revoked_at IS NULL)
      OR is_basket_protected(p_tenant, p_sku)
      OR is_brand_protected(p_tenant, p_sku)
      -- MAGAZZINO: carve-out vetrina + dieta (verificati fatturato-zero)
      OR (is_stock_protected(p_tenant, p_sku)
          AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v WHERE v.tenant_id=p_tenant AND v.sku=p_sku)
          AND NOT EXISTS (SELECT 1 FROM dieta_provati dp WHERE dp.tenant_id=p_tenant AND dp.sku=p_sku))
      -- VENDITE SELLER: chi vende resta protetto (finestra 15gg, mig 080)
      OR EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE oi.tenant_id = p_tenant AND oi.sku = p_sku
                     AND o.order_date >= NOW() - INTERVAL '15 days'
                     AND o.order_status NOT IN ('canceled','closed'))
      -- TOP10: carve-out vetrina + dieta
      OR EXISTS (SELECT 1 FROM product_health_scores h WHERE h.tenant_id = p_tenant AND h.sku = p_sku
                   AND h.scraper_position <= 10
                   AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v2 WHERE v2.tenant_id=p_tenant AND v2.sku=p_sku)
                   AND NOT EXISTS (SELECT 1 FROM dieta_provati dp2 WHERE dp2.tenant_id=p_tenant AND dp2.sku=p_sku))
      OR EXISTS (SELECT 1 FROM activation_cohorts ac WHERE ac.tenant_id = p_tenant AND ac.sku = p_sku
                   AND ac.activated_at >= NOW() - INTERVAL '72 hours');
$function$;

INSERT INTO schema_migrations (filename) VALUES ('080_seller_window_15gg.sql')
ON CONFLICT (filename) DO NOTHING;
