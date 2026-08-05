-- 077: is_basket_protected — il carrello protegge SOLO se ripaga i click
-- Fix falla n_ord_90d>=2 (feedback_taglio_burner_solo_se_non_porta_carrelli):
--   PRIMA: n_ord_90d>=2 proteggeva INCONDIZIONATAMENTE, anche a margine risibile
--          (caso 978113405 Laevolac MPF: 5 ordini/€4,82 margine vs €97/30gg click bruciati).
--   DOPO:  protetto solo se basket_margin_90d >= click_cost_90d (il carrello DEVE ripagare).
-- Il gate recency per-tenant (basket_recency_15g) resta invariato.
CREATE OR REPLACE FUNCTION public.is_basket_protected(p_tenant uuid, p_sku text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM sku_basket_stats s
    WHERE s.tenant_id = p_tenant AND s.sku = p_sku
      AND s.n_ord_90d >= 1
      AND s.basket_margin_90d >= GREATEST(s.click_cost_90d, 1)  -- carrello deve ripagare i click
  )
  AND (
    -- gate recency per-tenant, opt-in via config non scaduta
    NOT EXISTS (
      SELECT 1 FROM health_config hc
      WHERE hc.tenant_id = p_tenant
        AND hc.config_key = 'basket_recency_15g'
        AND hc.config_value = '1'
        AND (hc.expires_at IS NULL OR hc.expires_at > NOW())
    )
    OR vende_su_tenant_15g(p_tenant, p_sku)
  );
$function$;
