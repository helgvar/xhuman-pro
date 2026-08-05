-- 039: GUARDIA CARRELLO (dictat utente 9/7/2026)
-- Un prodotto che porta ordini NON può essere tolto dal feed, mai, da nessuno
-- strumento. Valutazione sul MARGINE DI CARRELLO (l'intero ordine che contiene
-- lo SKU), non sul margine standalone: i traini (AOV 70-120€, 3-5 righe)
-- sembrano spreco visti da soli ma ripagano i click col carrello.
-- Protetto = >=2 ordini in 90g, oppure 1 ordine con margine carrello che copre
-- il costo click 90g. Veto a livello DB (lezione brand protetti: mai patch
-- per-strumento) su feed_quarantine, feed_killers e feed_actions REMOVE.

CREATE TABLE IF NOT EXISTS sku_basket_stats (
  tenant_id UUID NOT NULL,
  sku TEXT NOT NULL,
  n_ord_90d INT NOT NULL DEFAULT 0,
  basket_margin_90d NUMERIC(12,2) NOT NULL DEFAULT 0,
  click_cost_90d NUMERIC(12,2) NOT NULL DEFAULT 0,
  aov_90d NUMERIC(10,2),
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS basket_veto_log (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  sku TEXT NOT NULL,
  target_table TEXT NOT NULL,
  vetoed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Refresh giornaliero (chiamato da winbackMonitor 07:45 prima dei rilasci).
-- Costo click da zombie_clicks (fonte CARDINALE), CPC 0,27+22% IVA = 0,3294.
-- Margine riga: erp_cost, fallback imputed, fallback prudente 25% del row_total.
CREATE OR REPLACE FUNCTION refresh_sku_basket_stats() RETURNS void AS $fn$
BEGIN
  DELETE FROM sku_basket_stats;
  INSERT INTO sku_basket_stats (tenant_id, sku, n_ord_90d, basket_margin_90d, click_cost_90d, aov_90d, refreshed_at)
  WITH ord_marg AS (
    SELECT o.id, o.tenant_id,
      SUM(oi2.row_total - COALESCE(NULLIF(p2.erp_cost,0), p2.erp_cost_imputed, oi2.row_total*0.75) * oi2.qty_ordered) AS marg,
      SUM(oi2.row_total_incl_tax) AS val
    FROM orders o
    JOIN order_items oi2 ON oi2.order_id = o.id
    LEFT JOIN products p2 ON p2.tenant_id = o.tenant_id AND p2.sku = oi2.sku
    WHERE o.order_date >= NOW() - INTERVAL '90 days'
      AND o.order_status NOT IN ('canceled','closed')
    GROUP BY 1, 2
  ),
  basket AS (
    SELECT om.tenant_id, oi.sku, COUNT(DISTINCT om.id) AS n_ord,
           SUM(om.marg) AS marg, AVG(om.val) AS aov
    FROM order_items oi
    JOIN ord_marg om ON om.id = oi.order_id
    GROUP BY 1, 2
  ),
  clk AS (
    SELECT z.tenant_id, z.product_code AS sku, SUM(z.clicks) * 0.3294 AS cost
    FROM zombie_clicks z
    WHERE z.fetch_date >= NOW() - INTERVAL '90 days'
    GROUP BY 1, 2
  )
  SELECT COALESCE(b.tenant_id, c.tenant_id), COALESCE(b.sku, c.sku),
         COALESCE(b.n_ord, 0), ROUND(COALESCE(b.marg, 0), 2),
         ROUND(COALESCE(c.cost, 0), 2), ROUND(b.aov, 2), NOW()
  FROM basket b
  FULL OUTER JOIN clk c ON c.tenant_id = b.tenant_id AND c.sku = b.sku;
END;
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION is_basket_protected(p_tenant UUID, p_sku TEXT) RETURNS boolean AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM sku_basket_stats s
    WHERE s.tenant_id = p_tenant AND s.sku = p_sku
      AND (s.n_ord_90d >= 2
           OR (s.n_ord_90d = 1 AND s.basket_margin_90d >= GREATEST(s.click_cost_90d, 1)))
  );
$fn$ LANGUAGE sql STABLE;

-- Brand protetto (killer_protected_brands per tenant): la quadra Eucerin 8/7
-- copriva killer/quarantene ma NON i REMOVE — 379 blocchi residui trovati 9/7.
CREATE OR REPLACE FUNCTION is_brand_protected(p_tenant UUID, p_sku TEXT) RETURNS boolean AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM products p
    JOIN health_config hc ON hc.tenant_id = p.tenant_id
      AND hc.config_key = 'killer_protected_brands'
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
      AND (UPPER(COALESCE(p.brand, '')) = ANY(string_to_array(UPPER(hc.config_value), ','))
           OR UPPER(COALESCE(p.manufacturer, '')) = ANY(string_to_array(UPPER(hc.config_value), ',')))
  );
$fn$ LANGUAGE sql STABLE;

-- Veto silenzioso (RETURN NULL, non eccezione: i cicli bulk dell'engine non
-- devono abortire). Ogni veto è tracciato in basket_veto_log.
CREATE OR REPLACE FUNCTION trg_veto_basket_fn() RETURNS trigger AS $fn$
BEGIN
  -- NEW.action esiste solo su feed_actions: via jsonb per non rompere le altre
  IF TG_TABLE_NAME = 'feed_actions'
     AND (to_jsonb(NEW)->>'action') IS DISTINCT FROM 'REMOVE' THEN
    RETURN NEW;
  END IF;
  IF is_basket_protected(NEW.tenant_id, NEW.sku)
     OR is_brand_protected(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':' || TG_OP);
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_veto_basket_quar ON feed_quarantine;
CREATE TRIGGER trg_veto_basket_quar
  BEFORE INSERT ON feed_quarantine
  FOR EACH ROW EXECUTE FUNCTION trg_veto_basket_fn();

-- Ri-arming di una quarantena riattivata = nuova rimozione: stesso veto
DROP TRIGGER IF EXISTS trg_veto_basket_quar_upd ON feed_quarantine;
CREATE TRIGGER trg_veto_basket_quar_upd
  BEFORE UPDATE ON feed_quarantine
  FOR EACH ROW
  WHEN (OLD.reactivated = true AND NEW.reactivated = false)
  EXECUTE FUNCTION trg_veto_basket_fn();

DROP TRIGGER IF EXISTS trg_veto_basket_kill ON feed_killers;
CREATE TRIGGER trg_veto_basket_kill
  BEFORE INSERT ON feed_killers
  FOR EACH ROW EXECUTE FUNCTION trg_veto_basket_fn();

DROP TRIGGER IF EXISTS trg_veto_basket_kill_upd ON feed_killers;
CREATE TRIGGER trg_veto_basket_kill_upd
  BEFORE UPDATE ON feed_killers
  FOR EACH ROW
  WHEN (OLD.is_active = false AND NEW.is_active = true)
  EXECUTE FUNCTION trg_veto_basket_fn();

DROP TRIGGER IF EXISTS trg_veto_basket_remove ON feed_actions;
CREATE TRIGGER trg_veto_basket_remove
  BEFORE INSERT ON feed_actions
  FOR EACH ROW EXECUTE FUNCTION trg_veto_basket_fn();

DROP TRIGGER IF EXISTS trg_veto_basket_remove_upd ON feed_actions;
CREATE TRIGGER trg_veto_basket_remove_upd
  BEFORE UPDATE ON feed_actions
  FOR EACH ROW
  WHEN (NEW.action = 'REMOVE' AND OLD.action IS DISTINCT FROM 'REMOVE')
  EXECUTE FUNCTION trg_veto_basket_fn();
