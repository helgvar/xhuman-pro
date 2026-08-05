-- 086: chiude il percorso UPDATE della condanna. Completa la 085.
--
-- SCOPERTO applicando la 085: feed_quarantine, feed_actions e feed_killers
-- hanno tutte UNIQUE (tenant_id, sku), e i motori condannano con
-- INSERT ... ON CONFLICT (tenant_id, sku) DO UPDATE.
-- Le guardie venditore (trg_veto_condanna_vendente_*, mig 060 + 085) sono
-- tutte BEFORE INSERT. Su ON CONFLICT DO UPDATE Postgres esegue i trigger
-- BEFORE UPDATE, non i BEFORE INSERT: quindi la guardia vede solo la PRIMA
-- condanna di uno SKU. Dalla seconda in poi — cioe' praticamente sempre, le
-- righe restano — la condanna passa senza controlli.
-- Effetto pratico senza questa migrazione: gli SKU rilasciati oggi dalla 085
-- verrebbero ri-condannati dal primo cron utile, in silenzio.
--
-- MODIFICA: guardia BEFORE UPDATE sulle tre tabelle, stesso criterio unico
-- vende_e_ripaga(). Non annulla l'intero UPDATE: neutralizza il solo campo che
-- blocca, cosi' gli altri aggiornamenti del motore (reason, date, contatori)
-- restano. La mano umana (capo_/manual/sessione_) continua a poter condannare.
-- Il WHEN sul trigger fa si' che la funzione giri solo sugli UPDATE che
-- bloccano davvero: zero costo su tutti gli altri.
--
-- ROLLBACK:
--   DROP TRIGGER trg_veto_ricondanna_q ON feed_quarantine;
--   DROP TRIGGER trg_veto_ricondanna_r ON feed_actions;
--   DROP TRIGGER trg_veto_ricondanna_k ON feed_killers;

CREATE OR REPLACE FUNCTION public.trg_veto_ricondanna_fn()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  -- mano umana: passa (stessa regola della 085)
  IF v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%'
     OR v_writer LIKE 'sessione\_%' ESCAPE '\' THEN
    RETURN NEW;
  END IF;

  IF NOT vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
    RETURN NEW;
  END IF;

  INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
  VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 're-condanna via UPDATE bloccata',
          v_writer, 'L4 (mig 086): vende 30g e il click si ripaga', NULL);

  IF TG_TABLE_NAME = 'feed_quarantine' THEN
    NEW.reactivated := true;
    NEW.reactivated_at := COALESCE(OLD.reactivated_at, NOW());
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'feed_killers' THEN
    NEW.is_active := false;
    RETURN NEW;
  ELSE
    -- feed_actions: 'REMOVE' non e' neutralizzabile campo per campo, si salta
    RETURN NULL;
  END IF;
END $function$;

DROP TRIGGER IF EXISTS trg_veto_ricondanna_q ON public.feed_quarantine;
CREATE TRIGGER trg_veto_ricondanna_q
  BEFORE UPDATE ON public.feed_quarantine
  FOR EACH ROW WHEN (NEW.reactivated IS NOT TRUE)
  EXECUTE FUNCTION public.trg_veto_ricondanna_fn();

DROP TRIGGER IF EXISTS trg_veto_ricondanna_r ON public.feed_actions;
CREATE TRIGGER trg_veto_ricondanna_r
  BEFORE UPDATE ON public.feed_actions
  FOR EACH ROW WHEN (NEW.action = 'REMOVE')
  EXECUTE FUNCTION public.trg_veto_ricondanna_fn();

DROP TRIGGER IF EXISTS trg_veto_ricondanna_k ON public.feed_killers;
CREATE TRIGGER trg_veto_ricondanna_k
  BEFORE UPDATE ON public.feed_killers
  FOR EACH ROW WHEN (NEW.is_active IS TRUE)
  EXECUTE FUNCTION public.trg_veto_ricondanna_fn();

INSERT INTO schema_migrations (filename) VALUES ('086_ricondanna_via_update.sql')
ON CONFLICT (filename) DO NOTHING;
