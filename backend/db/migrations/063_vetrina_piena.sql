-- 063: PATTERN "VETRINA PIENA, PROVA SCHIACCIANTE" (ordine capo 15/7, caso SAUGELLA)
-- "Approcciamo questo pattern per tutti e lo inseriamo nei burner. Stesso
--  pattern logico di incidenza (click / revenue / fatturato carrello)."
--
-- Il pattern: il prodotto HA la vetrina piena (pos fresca <= 3) e in 90 giorni
-- ha dato prova schiacciante che il canale click non lo vende:
--   click 90g >= 150  E  ordini di RETE 90g <= 1  E
--   incidenza > 50% (costo click > 50% del fatturato diretto, o fatturato 0)  E
--   il carrello non ripaga (basket_margin_90d < click_cost_90d)
-- Esclusi sempre: pin del capo, brand protetti, carrello protetto.
-- CARVE-OUT APPROVATO: per questi provati la protezione MAGAZZINO non vale
-- (lo stock resta in vendita su sito/altri canali: esce SOLO da Trovaprezzi).
-- USCITA per merito: al primo ordine di rete il pattern si rompe e L2/winback
-- lo riportano dentro (è posizionato, passa il cancello posizione).

CREATE TABLE IF NOT EXISTS vetrina_piena_provati (
  tenant_id UUID NOT NULL,
  sku TEXT NOT NULL,
  click_90g INT,
  costo_90g NUMERIC,
  ordini_rete_90g INT,
  fatt_90g NUMERIC,
  basket_margin_90g NUMERIC,
  pos INT,
  refreshed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku)
);

-- Ricalcolo giornaliero (chiamato dalla lima costante alle 06:15)
CREATE OR REPLACE FUNCTION refresh_vetrina_piena() RETURNS INT AS $$
DECLARE v_n INT;
BEGIN
  DELETE FROM vetrina_piena_provati;
  INSERT INTO vetrina_piena_provati
    (tenant_id, sku, click_90g, costo_90g, ordini_rete_90g, fatt_90g, basket_margin_90g, pos)
  WITH ck AS (
    SELECT z.tenant_id, z.product_code sku, SUM(z.clicks) click90,
      ROUND(SUM(z.clicks)*0.3294, 2) costo90
    FROM zombie_clicks z WHERE z.fetch_date >= CURRENT_DATE - 90
    GROUP BY 1,2 HAVING SUM(z.clicks) >= 150),
  rete AS (
    SELECT oi.sku, COUNT(DISTINCT o.id) ordn
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE o.order_date >= NOW()-INTERVAL '90 days'
      AND o.order_status NOT IN ('canceled','closed')
      AND oi.sku IN (SELECT sku FROM ck)
    GROUP BY 1),
  fatt AS (
    SELECT o.tenant_id, oi.sku, SUM(oi.row_total_incl_tax) f90
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE o.order_date >= NOW()-INTERVAL '90 days'
      AND o.order_status NOT IN ('canceled','closed')
      AND oi.sku IN (SELECT sku FROM ck)
    GROUP BY 1,2)
  SELECT c.tenant_id, c.sku, c.click90, c.costo90,
    COALESCE(r.ordn,0), COALESCE(f.f90,0),
    COALESCE(s.basket_margin_90d,0), pos_fresca(c.tenant_id, c.sku)
  FROM ck c
  JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
  LEFT JOIN rete r ON r.sku=c.sku
  LEFT JOIN fatt f ON f.tenant_id=c.tenant_id AND f.sku=c.sku
  LEFT JOIN sku_basket_stats s ON s.tenant_id=c.tenant_id AND s.sku=c.sku
  WHERE COALESCE(r.ordn,0) <= 1
    AND (COALESCE(f.f90,0) = 0 OR c.costo90 > 0.5 * f.f90)
    AND COALESCE(s.basket_margin_90d,0) < c.costo90
    AND pos_fresca(c.tenant_id, c.sku) <= 3
    AND NOT EXISTS (SELECT 1 FROM capo_pins cp
      WHERE cp.tenant_id=c.tenant_id AND cp.sku=c.sku AND cp.revoked_at IS NULL)
    AND NOT is_brand_protected(c.tenant_id, c.sku)
    AND NOT is_basket_protected(c.tenant_id, c.sku);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$ LANGUAGE plpgsql;

-- is_feed_protected: la classe MAGAZZINO non copre i provati-vetrina-piena
CREATE OR REPLACE FUNCTION public.is_feed_protected(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
      -- PIN DEL CAPO: ordine esplicito, vince su tutto finché non revocato
      EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id = p_tenant
                AND cp.sku = p_sku AND cp.revoked_at IS NULL)
      OR is_basket_protected(p_tenant, p_sku)
      OR is_brand_protected(p_tenant, p_sku)
      -- MAGAZZINO: protetto TRANNE i provati vetrina-piena (carve-out 15/7:
      -- pos<=3 per 90g, 150+ click, <=1 ordine magro -> il canale click non
      -- li vende; lo stock resta su sito/altri canali)
      OR (is_stock_protected(p_tenant, p_sku)
          AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v
                WHERE v.tenant_id = p_tenant AND v.sku = p_sku))
      OR EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku
                   AND COALESCE(p.sales_30d_seller, 0) > 0)
      OR EXISTS (SELECT 1 FROM product_health_scores h WHERE h.tenant_id = p_tenant AND h.sku = p_sku
                   AND h.scraper_position <= 10
                   AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v2
                         WHERE v2.tenant_id = p_tenant AND v2.sku = p_sku))
      OR EXISTS (SELECT 1 FROM activation_cohorts ac
                   WHERE ac.tenant_id = p_tenant AND ac.sku = p_sku
                     AND ac.activated_at >= NOW() - INTERVAL '72 hours');
$function$;

INSERT INTO schema_migrations (filename)
SELECT '063_vetrina_piena.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename='063_vetrina_piena.sql');
