-- 053: ECCEZIONE MURO-SCAVALCO (ordine capo 12/7 sera):
-- "Recuperiamole per il momento, e al prossimo import dello scraper
--  ricontrolla: se il prezzo di Farmabooster su quei muri si è riallineato,
--  non ripassarglielo."
--
-- I muri restano territorio FB (veto totale) con UNA sola eccezione
-- chirurgica: azioni con action_source='muro_scavalco' — il micro-taglio
-- (max 3 centesimi sotto la regola FB) che scavalca un muro di fotocopie
-- a distanza <=2 cent. Vincoli: cut <= 0.03 dal prezzo regola, mai sotto
-- il costo vero + ricarico minimo della regola muro stessa.
-- Il ritiro automatico al riallineamento FB vive nello scraperPoller.

CREATE OR REPLACE FUNCTION public.trg_veto_sotto_costo_fn()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_floor NUMERIC; v_regola NUMERIC; v_muro_min NUMERIC;
BEGIN
  IF NEW.recommended_price IS NULL THEN RETURN NEW; END IF;

  SELECT GREATEST(
      COALESCE(NULLIF(p.erp_cost, 0), 0),
      CASE WHEN COALESCE(p.erp_stock, 0) > 0 THEN COALESCE(p.erp_purchase_cost, 0) ELSE 0 END),
    COALESCE(p.sell_price, 0),
    COALESCE((pr.rule_data->>'recharge_pct')::numeric, 12)
    INTO v_floor, v_regola, v_muro_min
  FROM products p
  LEFT JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
  WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;

  -- REGOLA MURO: territorio FB — unica eccezione il muro_scavalco chirurgico
  IF is_muro_rule_product(NEW.tenant_id, NEW.sku) THEN
    IF NEW.action_source = 'muro_scavalco'
       AND v_regola > 0
       AND NEW.recommended_price >= v_regola - 0.03
       AND NEW.recommended_price < v_regola - 0.005
       AND NEW.recommended_price >= v_floor * (1 + v_muro_min / 100) THEN
      RETURN NEW; -- scavalco autorizzato dal capo (12/7), max 3 cent
    END IF;
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:REGOLA_MURO');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;

  -- PERIMETRO CUT (capo 12/7): SB sempre; Ricarico solo con vendite di rete
  -- 30g consolidate; Sconto MAI.
  IF NOT is_price_cut_allowed(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:FUORI_PERIMETRO_CUT');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  -- Mai sotto il costo vero
  IF v_floor IS NOT NULL AND v_floor > 0 AND NEW.recommended_price < v_floor THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOTTO_COSTO');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  -- Mai sopra o uguale al prezzo regola: solo CUT veri. Mai rialzi.
  IF v_regola > 0 AND NEW.recommended_price > v_regola - 0.01 THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOPRA_REGOLA_FB');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  RETURN NEW;
END;
$function$;
