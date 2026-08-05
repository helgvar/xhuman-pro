-- 041: Stock Safety Net nel veto DB (caso NEXIUM 042922017, 9/7/2026)
-- Regola cardinale: SKU con magazzino FISICO + MOL alto MAI killer/quarantena/
-- REMOVE (investimento già fatto, regola aurea del magazzino farmacia).
-- Il killer bibbia-corretto (63 click, 0 vendite) l'aveva condannato comunque:
-- la soglia margine/click non basta quando c'è stock fisico da smaltire.
-- Soglia: erp_stock >= stock_safety_net_min_units (config, default 5)
--         AND margin_pct >= 20.

CREATE OR REPLACE FUNCTION is_stock_protected(p_tenant UUID, p_sku TEXT) RETURNS boolean AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
      AND COALESCE(p.erp_stock, 0) >= COALESCE((
        SELECT hc.config_value::int FROM health_config hc
        WHERE hc.tenant_id = p_tenant AND hc.config_key = 'stock_safety_net_min_units'), 5)
      AND COALESCE(p.margin_pct, 0) >= 20
  );
$fn$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_veto_basket_fn() RETURNS trigger AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'feed_actions'
     AND (to_jsonb(NEW)->>'action') IS DISTINCT FROM 'REMOVE' THEN
    RETURN NEW;
  END IF;
  IF is_basket_protected(NEW.tenant_id, NEW.sku)
     OR is_brand_protected(NEW.tenant_id, NEW.sku)
     OR is_stock_protected(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':' || TG_OP);
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
