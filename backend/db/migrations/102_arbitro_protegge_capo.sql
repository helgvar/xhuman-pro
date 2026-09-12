-- 102: l'arbitro deve proteggere anche le fonti 'capo_%' e 'sessione_%'
--
-- Difetto misurato il 17/08/2026: 1.008 REMOVE firmate
-- 'capo_taglio_bc_procaccini_1708' scese a 558 in quattro ore. Il ciclo
-- igiene (feedHygieneCycle.js righe 34/50/147) cancella le REMOVE con
-- query anonime, e trg_arbitro_delete_fn proteggeva solo
-- manual_pepita/manual/capo_pin/muro_scavalco/pulizia_%. Un ordine
-- esplicito del capo veniva quindi annullato in silenzio ogni ciclo,
-- e il feed Procaccini risaliva da 15.014 a 15.218.
--
-- Le stesse due famiglie hanno gia' il bypass sul cap delle condanne
-- (trg_cap_condanne_fn): qui si allinea la difesa in cancellazione.

CREATE OR REPLACE FUNCTION public.trg_arbitro_delete_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF v_writer = 'anonimo'
     AND (COALESCE(OLD.action_source,'') IN ('manual_pepita','manual','capo_pin','muro_scavalco')
          OR OLD.action_source LIKE 'pulizia_%'
          OR OLD.action_source LIKE 'capo_%'
          OR OLD.action_source LIKE 'sessione_%') THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (OLD.tenant_id, OLD.sku, 'veto_arbitro', 'delete',
            COALESCE(OLD.recommended_price::text, OLD.action), 'DELETE bloccato', v_writer,
            'L3: fonte protetta - i delete anonimi non toccano il lavoro di sessione/capo', OLD.action_source);
    RETURN NULL;  -- delete soppresso
  END IF;
  RETURN OLD;
END $function$;

INSERT INTO schema_migrations (filename) VALUES ('102_arbitro_protegge_capo.sql')
ON CONFLICT DO NOTHING;
