-- 069: DIETA DELIBERATA DI SESSIONE (ordine capo 17/7, caso Procaccini)
-- Il capo ha ordinato esplicitamente diete su SKU protetti (carrello-che-brucia:
-- il carrello 90g NON ripaga il costo click) e su vendenti-magri. Il veto mig 044
-- bloccava ANCHE la sessione firmata: 48/286 + 0/5 + 2/7 passati.
--
-- Coerenza col sistema di leggi esistente:
--   - L2 (mig 060) già consente il bypass con manual_override=true su feed_quarantine
--     ("dieta deliberata: la rete non ripaga i click locali")
--   - mig 064 già bypassa il cap-condanne per writer 'sessione_%'
-- Qui si estende la stessa dottrina al veto carrello/merito (mig 044):
--   writer 'sessione_%' + manual_override=true su feed_quarantine → passa,
--   CON tocco a verbale (azioni_touch_log). I motori restano bloccati come prima.
CREATE OR REPLACE FUNCTION trg_veto_basket_fn() RETURNS trigger AS $fn$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF TG_TABLE_NAME = 'feed_actions'
     AND (to_jsonb(NEW)->>'action') IS DISTINCT FROM 'REMOVE' THEN
    RETURN NEW;
  END IF;
  -- 069: dieta deliberata di sessione — il capo comanda, i motori no
  IF v_writer LIKE 'sessione\_%' ESCAPE '\'
     AND TG_TABLE_NAME = 'feed_quarantine'
     AND COALESCE((to_jsonb(NEW)->>'manual_override')::boolean, false) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'override_veto', 'feed_quarantine', NULL, 'dieta deliberata su SKU con segnali di merito',
            v_writer, COALESCE(NULLIF(current_setting('xhp.motivo', true), ''), 'dieta deliberata sessione'), NULL);
    RETURN NEW;
  END IF;
  IF is_feed_protected(NEW.tenant_id, NEW.sku)
     OR EXISTS (SELECT 1 FROM products p
                WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku
                  AND p.updated_at < NOW() - INTERVAL '12 hours') THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':' || TG_OP);
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename)
SELECT '069_dieta_deliberata_sessione.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename='069_dieta_deliberata_sessione.sql');
