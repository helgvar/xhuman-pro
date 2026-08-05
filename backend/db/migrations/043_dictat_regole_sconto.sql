-- 043: DICTAT REGOLE SCONTO (utente, 9/7/2026 sera)
-- "I prodotti in sconto non vanno toccati" — i prodotti agganciati a regole
-- prezzo Sconto (dinamiche/competitor del cliente) sono TERRITORIO INTOCCABILE
-- per qualsiasi azione prezzo xHumanPro. Il caso 940037625 FI: regola dinamica
-- del cliente + PC nostro sopra = sotto costo. Mai più.
-- Stesso pattern delle altre guardie: veto a livello DB, neutralizza
-- recommended_price e logga in basket_veto_log ('feed_actions:REGOLA_SCONTO').

CREATE OR REPLACE FUNCTION is_sconto_rule_product(p_tenant UUID, p_sku TEXT) RETURNS boolean AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM products p
    JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
      AND (pr.rule_name ~* 'sconto' OR COALESCE(pr.rule_type, '') ~* 'sconto')
  );
$fn$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_veto_regola_sconto_fn() RETURNS trigger AS $fn$
BEGIN
  IF NEW.recommended_price IS NULL THEN RETURN NEW; END IF;
  IF is_sconto_rule_product(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:REGOLA_SCONTO');
    NEW.recommended_price := NULL;  -- l'azione sopravvive, il prezzo NO
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_veto_regola_sconto ON feed_actions;
CREATE TRIGGER trg_veto_regola_sconto
  BEFORE INSERT OR UPDATE OF recommended_price ON feed_actions
  FOR EACH ROW EXECUTE FUNCTION trg_veto_regola_sconto_fn();
