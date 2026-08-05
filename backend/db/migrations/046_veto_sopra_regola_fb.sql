-- 046: VETO "SOPRA REGOLA FB" (caso TIOBEC 952110029, 10/7/2026 notte)
-- La regola FB (Grossista 11% + muro) teneva TIOBEC PRIMO a 25,46, un
-- centesimo sotto il muro dei fotocopia a 25,47. Il nostro rialzo harvest
-- (7-9/7, cieco ai muri) l'ha spinto a 29,22 buttandolo in posizione 8.
-- Trovate 2.664 raccomandazioni attive SOPRA il prezzo regola FB in rete.
--
-- Legge: il nostro overlay prezzi esiste per MIGLIORARE il prezzo della
-- regola FB, mai per peggiorarlo. Qualsiasi recommended_price sopra
-- l'exported_price (prezzo pubblico regola FB) viene neutralizzato.
-- (La funzione integra il veto sotto-costo della migrazione 042.)

CREATE OR REPLACE FUNCTION trg_veto_sotto_costo_fn() RETURNS trigger AS $fn$
DECLARE v_floor NUMERIC; v_export NUMERIC;
BEGIN
  IF NEW.recommended_price IS NULL THEN RETURN NEW; END IF;
  SELECT GREATEST(
      COALESCE(NULLIF(p.erp_cost, 0), 0),
      CASE WHEN COALESCE(p.erp_stock, 0) > 0 THEN COALESCE(p.erp_purchase_cost, 0) ELSE 0 END),
    COALESCE(p.exported_price, 0)
    INTO v_floor, v_export
  FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;
  IF v_floor IS NOT NULL AND v_floor > 0 AND NEW.recommended_price < v_floor THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOTTO_COSTO');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  IF v_export > 0 AND NEW.recommended_price > v_export + 0.02 THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOPRA_REGOLA_FB');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
