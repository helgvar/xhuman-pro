-- 055: TETTO CONDANNE GIORNALIERO (capo 12/7 sera: "se continuiamo a
-- troncare i feed di Trovaprezzi qui andiamo in bancarotta")
--
-- Nessun motore può più condannare in massa: il totale giornaliero di
-- quarantene + killer + REMOVE per tenant è LIMITATO a max(150, 1% del feed).
-- Oltre il tetto: veto + log CAP_GIORNALIERO. Le condanne oltre soglia
-- aspettano il giorno dopo (o una decisione umana) — un burner vero non
-- scappa, un feed troncato non si recupera.

CREATE OR REPLACE FUNCTION public.trg_cap_condanne_fn()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_oggi INT; v_cap INT;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM feed_quarantine q WHERE q.tenant_id = NEW.tenant_id
       AND q.reactivated = false AND q.quarantine_start >= (NOW() AT TIME ZONE 'Europe/Rome')::date)
  + (SELECT COUNT(*) FROM feed_killers k WHERE k.tenant_id = NEW.tenant_id
       AND k.is_active AND k.detected_at >= (NOW() AT TIME ZONE 'Europe/Rome')::date)
  + (SELECT COUNT(*) FROM feed_actions a WHERE a.tenant_id = NEW.tenant_id
       AND a.action = 'REMOVE' AND a.computed_at >= (NOW() AT TIME ZONE 'Europe/Rome')::date)
  INTO v_oggi;

  SELECT GREATEST(150, ROUND(0.01 * COALESCE(jsonb_array_length(tc.config_value::jsonb->'codes'), 10000)))
  INTO v_cap
  FROM tenant_configs tc
  WHERE tc.tenant_id = NEW.tenant_id AND tc.config_key = 'stable_feed_codes';

  IF v_oggi >= COALESCE(v_cap, 150) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':CAP_GIORNALIERO');
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_cap_quarantine ON feed_quarantine;
CREATE TRIGGER trg_cap_quarantine BEFORE INSERT ON feed_quarantine
  FOR EACH ROW EXECUTE FUNCTION trg_cap_condanne_fn();

DROP TRIGGER IF EXISTS trg_cap_killer ON feed_killers;
CREATE TRIGGER trg_cap_killer BEFORE INSERT ON feed_killers
  FOR EACH ROW EXECUTE FUNCTION trg_cap_condanne_fn();

DROP TRIGGER IF EXISTS trg_cap_remove ON feed_actions;
CREATE TRIGGER trg_cap_remove BEFORE INSERT ON feed_actions
  FOR EACH ROW WHEN (NEW.action = 'REMOVE') EXECUTE FUNCTION trg_cap_condanne_fn();
