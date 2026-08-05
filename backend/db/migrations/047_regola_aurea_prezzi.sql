-- 047: REGOLA AUREA PREZZI (dictat utente 10/7/2026 notte — scolpito ovunque)
--
--   1. Le REGOLE MURO non si toccano MAI. Nessuna azione prezzo, in nessuna
--      direzione, sui prodotti di regole muro (nome/tipo 'muro' o
--      rule_data.wall_position > 0). Unica eccezione: il ripristino esatto
--      del prezzo regola (riportare le cose come stavano).
--   2. VETO TOTALE SUI RIALZI: nessun recommended_price sopra il prezzo
--      regola FB (sell_price), su nessuna regola, mai.
--   3. Permessi SOLO i CUT sulle pepite SALVA BILANCIO (regole salva
--      bilancio / budgetsave). Su ogni altra regola l'unico prezzo
--      ammesso è quello della regola stessa (ripristino).
--   4. Sotto il costo d'acquisto vero: MAI (invariato, allarme rosso 9/7).
--
-- Caso scatenante: TIOBEC 952110029 — la regola FB lo teneva primo a 25,46
-- sotto il muro dei fotocopia; il rialzo harvest a 29,22 l'ha sprofondato.

CREATE OR REPLACE FUNCTION is_muro_rule_product(p_tenant UUID, p_sku TEXT) RETURNS boolean AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM products p
    JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
      AND (pr.rule_name ~* 'muro' OR COALESCE(pr.rule_type,'') ~* 'muro'
           OR COALESCE((pr.rule_data->>'wall_position')::numeric, 0) > 0)
  );
$fn$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_salva_bilancio_product(p_tenant UUID, p_sku TEXT) RETURNS boolean AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM products p
    JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
      AND (pr.rule_name ~* 'salva|bilancio' OR COALESCE(pr.rule_type,'') ~* 'salva|bilancio'
           OR COALESCE((pr.rule_data->>'budgetsave_threshold')::numeric, 0) > 0)
  );
$fn$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_veto_sotto_costo_fn() RETURNS trigger AS $fn$
DECLARE v_floor NUMERIC; v_regola NUMERIC;
BEGIN
  IF NEW.recommended_price IS NULL THEN RETURN NEW; END IF;
  SELECT GREATEST(
      COALESCE(NULLIF(p.erp_cost, 0), 0),
      CASE WHEN COALESCE(p.erp_stock, 0) > 0 THEN COALESCE(p.erp_purchase_cost, 0) ELSE 0 END),
    COALESCE(p.sell_price, 0)
    INTO v_floor, v_regola
  FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;

  -- 4. Mai sotto il costo vero
  IF v_floor IS NOT NULL AND v_floor > 0 AND NEW.recommended_price < v_floor THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOTTO_COSTO');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  -- 2. Mai sopra il prezzo regola FB (veto rialzi totale)
  IF v_regola > 0 AND NEW.recommended_price > v_regola + 0.02 THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOPRA_REGOLA_FB');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  -- 1. Regole MURO: territorio FB al 100% — NESSUN prezzo AI, MAI, in nessuna
  --    direzione (correzione utente 10/7: 'se c'è un muro lascia fare a FB,
  --    non mandare nessun prezzo AI'). NB: v2 — il check va fatto PRIMA di
  --    tutto, vedi funzione live (il muro vince su ogni altra considerazione).
  IF is_muro_rule_product(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:REGOLA_MURO');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  -- 3. Cut sotto il prezzo regola: SOLO su Salva Bilancio
  IF v_regola > 0 AND NEW.recommended_price < v_regola - 0.02
     AND NOT is_salva_bilancio_product(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table) VALUES (NEW.tenant_id, NEW.sku, 'feed_actions:SOLO_SB_PEPITE');
    NEW.recommended_price := NULL; RETURN NEW;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
