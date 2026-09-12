-- =====================================================================
-- 114 — Guardia G7: nessun PC nasce su Muro o Sconto
-- =====================================================================
-- Ordine capo 10/09 #6: "non vengono emessi pc per prodotti che sono in
--   sconto o in muro. e se un prodotto non era in muro e aveva un PC nel
--   momento in cui entra nella regola muro il pc viene annullato".
--
-- La 113 fa la seconda meta' (il guardiano annulla i PC finiti su muro/sconto
-- a ogni giro). Questa fa la prima: il PC non nasce proprio.
--
-- Prima c'era solo trg_veto_sotto_costo, che azzerava il PREZZO ma lasciava
-- viva la riga: un'azione morta che restava nei conteggi e nei motori.
-- Ora l'INSERT viene soppresso in partenza.
--
-- Le ADD non si sopprimono (butterebbero il prodotto fuori dal feed): perdono
-- solo il prezzo, e restano a prezzo di regola FB.
-- =====================================================================

CREATE OR REPLACE FUNCTION trg_niente_pc_su_muro_sconto_fn() RETURNS trigger AS $$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
  v_regola TEXT;
BEGIN
  IF NEW.action NOT IN ('PRICE_CUT','ADD') THEN RETURN NEW; END IF;
  IF NEW.action = 'ADD' AND NEW.recommended_price IS NULL THEN RETURN NEW; END IF;

  IF is_muro_rule_product(NEW.tenant_id, NEW.sku) THEN
    v_regola := 'MURO';
  ELSIF is_sconto_rule_product(NEW.tenant_id, NEW.sku) THEN
    v_regola := 'SCONTO';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.action = 'PRICE_CUT' AND TG_OP = 'INSERT' THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'blocco_regola_fb', 'action',
            NULL, 'PRICE_CUT non emesso', v_writer,
            'guardia G7 (ordine capo 10/09): regola ' || v_regola || ' - su muro e sconto non si emettono price cut',
            NEW.action_source);
    RETURN NULL;  -- il PC non nasce
  END IF;

  -- UPDATE su PC gia' esistente, o ADD con prezzo: resta la riga, esce il prezzo.
  IF NEW.recommended_price IS NOT NULL THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'blocco_regola_fb', 'recommended_price',
            NEW.recommended_price::text, 'NULL', v_writer,
            'guardia G7 (ordine capo 10/09): regola ' || v_regola || ' - il prezzo lo fa Farmabooster, non noi',
            NEW.action_source);
    NEW.recommended_price := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zz_trg_pc_niente_muro_sconto ON feed_actions;
CREATE TRIGGER zz_trg_pc_niente_muro_sconto
  BEFORE INSERT OR UPDATE ON feed_actions
  FOR EACH ROW EXECUTE FUNCTION trg_niente_pc_su_muro_sconto_fn();

INSERT INTO schema_migrations (filename, applied_at)
SELECT '114_niente_pc_su_muro_e_sconto.sql', NOW()
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '114_niente_pc_su_muro_e_sconto.sql');
