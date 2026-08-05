-- 042: VETO SOTTO-COSTO sul costo d'acquisto VERO (allarme rosso 9/7/2026)
-- Il sync salvava in erp_cost il product_min_cost (fonte più economica, di
-- solito il grossista): i floor calcolati su quel numero producevano prezzi
-- sotto il costo d'acquisto REALE della farmacia (product_erp_min_cost).
-- Caso: 940037625 FI venduto a €19,73 con costo d'acquisto €21,96.
-- Fix: colonne per i costi grezzi + trigger che NEUTRALIZZA qualsiasi
-- recommended_price sotto il costo (min_cost, e costo d'acquisto se c'è
-- stock fisico) — vale per engine, calibratore, azioni manuali, tutto.

ALTER TABLE products ADD COLUMN IF NOT EXISTS erp_purchase_cost NUMERIC(12,4);
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_min_cost NUMERIC(12,4);

CREATE OR REPLACE FUNCTION trg_veto_sotto_costo_fn() RETURNS trigger AS $fn$
DECLARE v_floor NUMERIC;
BEGIN
  IF NEW.recommended_price IS NULL THEN RETURN NEW; END IF;
  SELECT GREATEST(
      COALESCE(NULLIF(p.erp_cost, 0), 0),
      CASE WHEN COALESCE(p.erp_stock, 0) > 0 THEN COALESCE(p.erp_purchase_cost, 0) ELSE 0 END)
    INTO v_floor
  FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;
  IF v_floor IS NOT NULL AND v_floor > 0 AND NEW.recommended_price < v_floor THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOTTO_COSTO');
    NEW.recommended_price := NULL;  -- neutralizza il prezzo, l'azione sopravvive
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_veto_sotto_costo ON feed_actions;
CREATE TRIGGER trg_veto_sotto_costo
  BEFORE INSERT OR UPDATE OF recommended_price ON feed_actions
  FOR EACH ROW EXECUTE FUNCTION trg_veto_sotto_costo_fn();
