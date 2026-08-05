-- 087: la mano del capo deve poter condannare anche su feed_actions e feed_killers.
--
-- SCOPERTO col dry run del 4/8 (prova P5): il capo (writer capo_stefano) prova
-- un REMOVE su uno SKU vendente e viene bloccato. Non dalla 086 — dalla 085.
--
-- Perche': su INSERT ... ON CONFLICT DO UPDATE Postgres esegue PRIMA i trigger
-- BEFORE INSERT, poi tenta l'inserimento, e solo allora rileva il conflitto e
-- passa all'UPDATE. Se un BEFORE INSERT ritorna NULL la riga viene saltata e
-- l'UPDATE non avviene mai: il bypass "mano umana" della 086 (BEFORE UPDATE)
-- non veniva mai raggiunto. Nella 085 il bypass writer esisteva solo nel ramo
-- feed_quarantine + manual_override, quindi su feed_actions e feed_killers
-- l'ordine del capo moriva contro la guardia venditore.
-- Sintomo esatto: "INSERT 0 0" e in azioni_touch_log
-- 'L4 (mig 085): vende 30g e il click si ripaga' con writer capo_stefano.
--
-- MODIFICA: bypass mano umana in testa, valido per TUTTE le tabelle guardate.
-- Solo capo_% e manual% — NON sessione_%: 'sessione_pc_guardian' e' un motore
-- automatico, non la mano del capo, e non deve poter scavalcare la guardia.
-- Il ramo storico feed_quarantine + manual_override resta invariato sotto.
-- Ogni scavalco umano lascia traccia in azioni_touch_log: comandare si', in
-- silenzio no.
--
-- ROLLBACK: riapplicare la 085 (contiene la versione precedente della funzione).

CREATE OR REPLACE FUNCTION public.trg_veto_condanna_vendente_fn()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_pos INT;
  v_pos_max INT;
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  -- MANO DEL CAPO (mig 087): comanda su tutte le tabelle, non solo quarantena.
  -- I BEFORE INSERT girano anche dentro ON CONFLICT DO UPDATE: se qui non passa,
  -- la guardia BEFORE UPDATE della 086 non viene mai raggiunta.
  IF v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%' THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'override_umano', TG_TABLE_NAME, NULL, 'condanna permessa',
            v_writer, 'mig 087: mano umana, guardia venditore scavalcata di proposito', NULL);
    RETURN NEW;
  END IF;

  -- manual_override bypassa SOLO se lo scrive una mano umana. I loop
  -- automatici lo settavano a true e saltavano il controllo vendite (mig 085).
  IF TG_TABLE_NAME = 'feed_quarantine'
     AND COALESCE((row_to_json(NEW)->>'manual_override')::boolean, false)
     AND (v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%'
          OR v_writer LIKE 'sessione\_%' ESCAPE '\') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'feed_actions'
     AND COALESCE(row_to_json(NEW)->>'action','') <> 'REMOVE' THEN
    RETURN NEW;
  END IF;

  IF vende_su_tenant_15g(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
            v_writer, 'L2: vende su QUESTO tenant 15g', NULL);
    RETURN NULL;
  END IF;

  -- ORDINE CAPO 4/8: chi vende e ripaga il click non si tocca, punto.
  -- Copre la rotazione mensile che la finestra 15gg dichiarava morta.
  IF vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
            v_writer, 'L4 (mig 085): vende 30g e il click si ripaga', NULL);
    RETURN NULL;
  END IF;

  IF vende_in_rete_15g(NEW.sku) THEN
    v_pos := pos_fresca(NEW.tenant_id, NEW.sku);
    SELECT COALESCE((SELECT hc.config_value::int FROM health_config hc
      WHERE hc.tenant_id = NEW.tenant_id AND hc.config_key = 'release_pos_max'), 10)
    INTO v_pos_max;
    IF v_pos IS NOT NULL AND v_pos <= v_pos_max THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
              v_writer, 'L2: vende in rete E pos fresca ' || v_pos || ' <= ' || v_pos_max || ' su questo tenant', NULL);
      RETURN NULL;
    END IF;
    -- vende in rete ma qui non è posizionato: condanna PERMESSA (ordine 15/7)
  END IF;
  RETURN NEW;
END $function$;

-- Stessa correzione sulle strip (dieta / vetrina): la mano umana passa.
CREATE OR REPLACE FUNCTION public.trg_veto_strip_vendente_fn()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%' THEN
    RETURN NEW;
  END IF;

  IF vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'strip protezione bloccata',
            v_writer, 'L4 (mig 085): vende 30g e il click si ripaga', NULL);
    RETURN NULL;
  END IF;
  RETURN NEW;
END $function$;

INSERT INTO schema_migrations (filename) VALUES ('087_mano_del_capo_passa_sempre.sql')
ON CONFLICT (filename) DO NOTHING;
