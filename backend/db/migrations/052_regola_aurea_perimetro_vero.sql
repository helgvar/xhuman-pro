-- 052: IL PERIMETRO VERO DELLA REGOLA AUREA (correzione capo 12/7, testuale):
-- "La mia regola aurea è: niente price cut sugli SCONTI. I Price Cut vanno
--  sui SALVA BILANCIO e sui prodotti RICARICO con vendite consolidate sulla
--  rete negli ultimi 30gg. Il concetto è NON ALZARE i prezzi su prodotti
--  già ben posizionati, come è successo in passato."
--
-- Quindi: MURO=mai / SCONTO=mai / RIALZI=mai / CUT ok su:
--   type-3 (Salva Bilancio) SEMPRE
--   type-1 (Ricarico) SOLO con vendite di RETE consolidate (>=2 ordini/30g su
--          qualunque tenant — la rete intera è la prova di domanda)

CREATE OR REPLACE FUNCTION public.is_price_cut_allowed(p_tenant uuid, p_sku text)
 RETURNS boolean LANGUAGE sql STABLE
AS $function$
  SELECT CASE
    -- Muro: territorio FB, nessun prezzo AI
    WHEN is_muro_rule_product(p_tenant, p_sku) THEN false
    -- Sconto: promozioni del cliente, intoccabili
    WHEN is_sconto_rule_product(p_tenant, p_sku) THEN false
    -- Salva Bilancio: sempre
    WHEN is_salva_bilancio_product(p_tenant, p_sku) THEN true
    -- Ricarico: solo con vendite di rete consolidate (>=2 ordini 30g)
    WHEN EXISTS (
      SELECT 1 FROM products p JOIN price_rules pr
        ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
      WHERE p.tenant_id = p_tenant AND p.sku = p_sku
        AND pr.rule_data->>'type' = '1')
    THEN (
      SELECT COUNT(DISTINCT o.id) >= 2
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE oi.sku = p_sku
        AND o.order_date >= NOW() - INTERVAL '30 days'
        AND o.order_status NOT IN ('canceled','closed','pending_payment'))
    ELSE false
  END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_veto_sotto_costo_fn()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_floor NUMERIC; v_regola NUMERIC;
BEGIN
  IF NEW.recommended_price IS NULL THEN RETURN NEW; END IF;
  -- REGOLA MURO: territorio FB al 100%
  IF is_muro_rule_product(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:REGOLA_MURO');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  -- PERIMETRO CUT (capo 12/7): SB sempre; Ricarico solo con vendite di rete
  -- 30g consolidate; Sconto MAI. Fuori perimetro = nessun prezzo AI.
  IF NOT is_price_cut_allowed(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:FUORI_PERIMETRO_CUT');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  SELECT GREATEST(
      COALESCE(NULLIF(p.erp_cost, 0), 0),
      CASE WHEN COALESCE(p.erp_stock, 0) > 0 THEN COALESCE(p.erp_purchase_cost, 0) ELSE 0 END),
    COALESCE(p.sell_price, 0)
    INTO v_floor, v_regola
  FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;
  -- Mai sotto il costo vero
  IF v_floor IS NOT NULL AND v_floor > 0 AND NEW.recommended_price < v_floor THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOTTO_COSTO');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  -- Mai sopra o uguale al prezzo regola: solo CUT veri (almeno -1 centesimo).
  -- IL concetto cardine: mai alzare i prezzi (TIOBEC/harvest docet)
  IF v_regola > 0 AND NEW.recommended_price > v_regola - 0.01 THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOPRA_REGOLA_FB');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  RETURN NEW;
END;
$function$;
