-- 056: PIN DEL CAPO (13/7, testuale: "la tua sessione deve COMANDARE
-- xHumanPro, non sostituirlo. Se ti dico attiva un prodotto, xHumanPro deve
-- recepire e NON staccarlo di nuovo — altrimenti giriamo in tondo").
--
-- Gli ordini del capo diventano STATO PERSISTENTE del sistema:
--  - capo_pins(tenant_id, sku, azione, motivo): finché il pin è attivo,
--    NESSUN motore può condannare (killer/quarantena/REMOVE) il prodotto
--    e la build CSV lo include sempre (salvo stock/prezzo zero).
--  - Revoca SOLO esplicita (revoked_at) — niente scadenze automatiche.
-- La sessione Claude ESEGUE gli ordini creando pin; i motori OBBEDISCONO
-- tramite is_feed_protected (veti DB + amnistia oraria + ciclo igiene).

CREATE TABLE IF NOT EXISTS capo_pins (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  sku TEXT NOT NULL,
  azione TEXT NOT NULL DEFAULT 'attivo',   -- 'attivo' = in feed e intoccabile
  motivo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (tenant_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_capo_pins_attivi ON capo_pins (tenant_id, sku) WHERE revoked_at IS NULL;

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
      OR is_stock_protected(p_tenant, p_sku)
      OR EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku
                   AND COALESCE(p.sales_30d_seller, 0) > 0)
      OR EXISTS (SELECT 1 FROM product_health_scores h WHERE h.tenant_id = p_tenant AND h.sku = p_sku
                   AND h.scraper_position <= 10)
      OR EXISTS (SELECT 1 FROM activation_cohorts ac
                   WHERE ac.tenant_id = p_tenant AND ac.sku = p_sku
                     AND ac.activated_at >= NOW() - INTERVAL '72 hours');
$function$;
