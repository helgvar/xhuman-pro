-- 076: Recency-gate su is_basket_protected (dictat capo 27/7)
-- "non possiamo guardare oltre i 7/15gg altrimenti non tagliamo nulla"
--
-- La protezione carrello guarda una finestra di 90 giorni: da sola tiene accesi
-- i click su SKU che non vendono su questo tenant da settimane/mesi (basta 1-2
-- ordini nel trimestre). Questo gate, ATTIVO SOLO se il tenant ha una config
-- 'basket_recency_15g'='1' non scaduta, richiede IN PIU una vendita SU QUESTO
-- TENANT entro 15g. Le vendite solo-in-rete NON bastano piu (scelta capo 27/7:
-- tagliare anche la categoria B rete-only).
--
-- Retrocompatibile: senza config = comportamento storico 90g, INERTE per gli
-- altri 9 tenant. Auto-revert via health_config.expires_at (nessun cron).
-- Ambito test: solo Procaccini, 72h (28-30/7).
--
-- NB: il gate agisce solo sul VETO D'INSERIMENTO in quarantena
-- (trg_veto_basket_quar). La tenuta del taglio contro l'amnistia oraria e'
-- garantita a valle da is_burner_rule=true (trg_veto_release_burner_rule).

CREATE OR REPLACE FUNCTION public.is_basket_protected(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM sku_basket_stats s
    WHERE s.tenant_id = p_tenant AND s.sku = p_sku
      AND (s.n_ord_90d >= 2
           OR (s.n_ord_90d = 1 AND s.basket_margin_90d >= GREATEST(s.click_cost_90d, 1)))
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

INSERT INTO schema_migrations (filename)
SELECT '076_recency_gate_basket_15g.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename='076_recency_gate_basket_15g.sql');
