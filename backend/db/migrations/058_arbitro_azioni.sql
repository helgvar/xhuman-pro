-- 058: ARBITRO DELLE AZIONI (ordine capo 13/7, giornale n.19)
-- "Le logiche si sovrappongono: una mette e l'altra leva, e nessun orchestratore
--  capisce quali operazioni non vanno toccate."
--
-- Principio: L'ULTIMO CHE SCRIVE NON VINCE PIÙ.
--  1) Ogni tocco a recommended_price (neutralizzazione, modifica, delete) è
--     LOGGATO in azioni_touch_log: chi, cosa, prima/dopo, con quale motivo.
--  2) Le azioni MANUALI/di sessione (manual_pepita, manual, capo_pin) non
--     possono essere neutralizzate da scrittori ANONIMI: il tocco viene
--     bloccato (veto) e loggato. Per toccarle bisogna dichiararsi con
--     set_config('xhp.writer', '<nome>', true) e motivare con xhp.motivo.
--  3) I DELETE sono sempre permessi ma sempre loggati (la sentinella riallineo
--     muri deve poter ritirare gli scavalchi senza attriti).
-- Il fuoco amico del 13/7 (igiene con legge vecchia: ~1.100 PC legali falciati
-- in silenzio in 2 giri) con questo arbitro sarebbe stato: bloccato sui manuali
-- e visibile in log su tutto il resto entro un'ora.

CREATE TABLE IF NOT EXISTS azioni_touch_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID,
  sku TEXT,
  operazione TEXT NOT NULL,      -- neutralizza | modifica | delete | veto_arbitro
  campo TEXT,
  old_value TEXT,
  new_value TEXT,
  writer TEXT NOT NULL,          -- da xhp.writer, altrimenti 'anonimo'
  motivo TEXT,                   -- da xhp.motivo (la legge che giustifica)
  action_source TEXT,
  touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_touch_log_tenant_sku ON azioni_touch_log(tenant_id, sku, touched_at DESC);
CREATE INDEX IF NOT EXISTS idx_touch_log_writer ON azioni_touch_log(writer, touched_at DESC);
-- Retention: purge >30g agganciato al ciclo igiene (lato codice).

CREATE OR REPLACE FUNCTION trg_arbitro_azioni_fn() RETURNS TRIGGER AS $$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
  v_motivo TEXT := NULLIF(current_setting('xhp.motivo', true), '');
  v_manuale BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.recommended_price IS NOT NULL THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (OLD.tenant_id, OLD.sku, 'delete', 'row', OLD.recommended_price::text, NULL, v_writer, v_motivo, OLD.action_source);
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.recommended_price IS DISTINCT FROM OLD.recommended_price THEN
    v_manuale := COALESCE(OLD.action_source, '') IN ('manual_pepita', 'manual', 'capo_pin');

    IF OLD.recommended_price IS NOT NULL AND NEW.recommended_price IS NULL
       AND v_manuale AND v_writer = 'anonimo' THEN
      -- VETO ARBITRO: nessuno spegne un'azione manuale senza firmarsi
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', 'recommended_price',
              OLD.recommended_price::text, 'NULL (bloccato)', v_writer, v_motivo, OLD.action_source);
      NEW.recommended_price := OLD.recommended_price;
      NEW.action_reason := OLD.action_reason;
      NEW.status := OLD.status;
      RETURN NEW;
    END IF;

    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku,
            CASE WHEN NEW.recommended_price IS NULL THEN 'neutralizza' ELSE 'modifica' END,
            'recommended_price', OLD.recommended_price::text, NEW.recommended_price::text,
            v_writer, v_motivo, OLD.action_source);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_arbitro_azioni ON feed_actions;
CREATE TRIGGER trg_arbitro_azioni BEFORE UPDATE OR DELETE ON feed_actions
FOR EACH ROW EXECUTE FUNCTION trg_arbitro_azioni_fn();

INSERT INTO schema_migrations (filename)
SELECT '058_arbitro_azioni.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '058_arbitro_azioni.sql');
