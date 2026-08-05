-- 088 — Il cap anti-strage non si brucia più a vuoto
--
-- MISURA 4/8: le condanne effettivamente SCRITTE oggi erano su prodotti
-- che erano GIA' FUORI dal feed:
--   MPF          249 scritte -> 0 sul feed  (100% sprecato, cap = 249 = saturo)
--   SubitoFarma  147 scritte -> 1 sul feed  (99,3% sprecato)
--   Farmastelia  159 scritte -> 5 sul feed  (96,9% sprecato)
-- Il budget giornaliero (mig 064) si consumava tutto in ri-condanne di prodotti
-- gia' rimossi, e i tagli veri non passavano MAI. I motori di pulizia della rete
-- giravano a vuoto ogni giorno.
--
-- Il cap resta IDENTICO nella soglia (150 o 1% del feed): questa migrazione non
-- allarga il permesso di condannare, sposta solo il budget su cio' che e'
-- davvero nel feed. Una condanna su uno SKU gia' fuori e' un no-op: non toglie
-- niente a nessuno, quindi non deve costare budget ne' gonfiare le tabelle.
--
-- PILOTA (ordine capo 4/8 sera: "fai solo su MPF"): il nuovo comportamento e'
-- dietro l'interruttore per-tenant health_config.cap_solo_feed=1, acceso solo
-- su MPF. Tutti gli altri tenant restano identici a prima. Serve perche' senza
-- questo il cap MPF e' saturo (249/249 alle 20:45 del 4/8, tutto in ri-condanne
-- a vuoto) e la mig 089 non avrebbe nessun budget per passare.

BEGIN;

-- 1) Specchio indicizzato del CSV che esce a TP.
--    Serve perche' il controllo va fatto ad ogni INSERT e scandire un jsonb da
--    25k elementi per riga sarebbe insostenibile (234.308 codici sulla rete).
CREATE TABLE IF NOT EXISTS feed_stable_sku (
  tenant_id uuid NOT NULL,
  sku       text NOT NULL,
  PRIMARY KEY (tenant_id, sku)
);

COMMENT ON TABLE feed_stable_sku IS
  'Specchio di tenant_configs.stable_feed_codes, mantenuto dal trigger '
  'trg_sync_feed_stable_sku. Sola lettura per i motori: non scriverci a mano.';

-- 2) Sincronizzazione automatica: nessun servizio Node va modificato, la tabella
--    si riallinea da sola ogni volta che lo stable cache viene rigenerato.
CREATE OR REPLACE FUNCTION trg_sync_feed_stable_sku_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.config_key <> 'stable_feed_codes' THEN RETURN NEW; END IF;

  DELETE FROM feed_stable_sku WHERE tenant_id = NEW.tenant_id;

  INSERT INTO feed_stable_sku (tenant_id, sku)
  SELECT NEW.tenant_id, jsonb_array_elements_text(NEW.config_value::jsonb->'codes')
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_feed_stable_sku ON tenant_configs;
CREATE TRIGGER trg_sync_feed_stable_sku
  AFTER INSERT OR UPDATE ON tenant_configs
  FOR EACH ROW EXECUTE FUNCTION trg_sync_feed_stable_sku_fn();

-- 3) Popolamento iniziale.
INSERT INTO feed_stable_sku (tenant_id, sku)
SELECT tc.tenant_id, jsonb_array_elements_text(tc.config_value::jsonb->'codes')
FROM tenant_configs tc
WHERE tc.config_key = 'stable_feed_codes'
ON CONFLICT DO NOTHING;

-- 4) Il cap nuovo.
CREATE OR REPLACE FUNCTION trg_cap_condanne_fn() RETURNS TRIGGER AS $$
DECLARE
  v_oggi INT;
  v_cap INT;
  v_ha_csv BOOLEAN;
  v_pilota BOOLEAN;
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  -- Le azioni di SESSIONE del capo (writer 'sessione_%') sono verificate caso
  -- per caso e a verbale: il cap-anti-strage frena i motori automatici, non
  -- gli ordini espliciti. Bypass governato (mig 064, capo 15/7).
  IF v_writer LIKE 'sessione_%' THEN RETURN NEW; END IF;

  -- PILOTA per-tenant: senza interruttore, comportamento identico a mig 064.
  SELECT EXISTS (SELECT 1 FROM health_config hc
                  WHERE hc.tenant_id = NEW.tenant_id
                    AND hc.config_key = 'cap_solo_feed'
                    AND hc.config_value = '1')
  INTO v_pilota;

  -- Fail-safe: se per questo tenant non conosciamo il feed (CSV mai generato,
  -- specchio vuoto) ci comportiamo come prima della 088 e NON blocchiamo nulla
  -- sulla base di un'informazione che non abbiamo.
  SELECT v_pilota AND EXISTS (SELECT 1 FROM feed_stable_sku f WHERE f.tenant_id = NEW.tenant_id)
  INTO v_ha_csv;

  IF v_ha_csv AND NOT EXISTS (
    SELECT 1 FROM feed_stable_sku f
    WHERE f.tenant_id = NEW.tenant_id AND f.sku = NEW.sku
  ) THEN
    -- Gia' fuori dal feed: condannarlo di nuovo non toglie niente a nessuno.
    -- Non consuma budget e non gonfia le tabelle. Tracciato per misurare il rumore.
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':NOOP_GIA_FUORI');
    RETURN NULL;
  END IF;

  -- Budget speso solo su prodotti che sono DAVVERO nel feed (dove il pilota e'
  -- acceso; altrove si contano tutte le righe come in mig 064).
  SELECT
    (SELECT COUNT(*) FROM feed_quarantine q
       WHERE q.tenant_id = NEW.tenant_id AND q.reactivated = false
         AND q.quarantine_start >= (NOW() AT TIME ZONE 'Europe/Rome')::date
         AND (NOT v_ha_csv OR EXISTS (SELECT 1 FROM feed_stable_sku f
                WHERE f.tenant_id = q.tenant_id AND f.sku = q.sku)))
  + (SELECT COUNT(*) FROM feed_killers k
       WHERE k.tenant_id = NEW.tenant_id AND k.is_active
         AND k.detected_at >= (NOW() AT TIME ZONE 'Europe/Rome')::date
         AND (NOT v_ha_csv OR EXISTS (SELECT 1 FROM feed_stable_sku f
                WHERE f.tenant_id = k.tenant_id AND f.sku = k.sku)))
  + (SELECT COUNT(*) FROM feed_actions a
       WHERE a.tenant_id = NEW.tenant_id AND a.action = 'REMOVE'
         AND a.computed_at >= (NOW() AT TIME ZONE 'Europe/Rome')::date
         AND (NOT v_ha_csv OR EXISTS (SELECT 1 FROM feed_stable_sku f
                WHERE f.tenant_id = a.tenant_id AND f.sku = a.sku)))
  INTO v_oggi;

  SELECT GREATEST(150, ROUND(0.01 * COALESCE(jsonb_array_length(tc.config_value::jsonb->'codes'), 10000)))
  INTO v_cap FROM tenant_configs tc
  WHERE tc.tenant_id = NEW.tenant_id AND tc.config_key = 'stable_feed_codes';

  IF v_oggi >= COALESCE(v_cap, 150) THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':CAP_GIORNALIERO');
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5) PILOTA: interruttore acceso SOLO su MPF.
INSERT INTO health_config (tenant_id, config_key, config_value)
VALUES ('d581c087-6b92-4050-b52a-5bd5c087553a', 'cap_solo_feed', '1')
ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = '1';

INSERT INTO schema_migrations (filename) VALUES ('088_cap_non_si_brucia_a_vuoto.sql')
ON CONFLICT DO NOTHING;

COMMIT;

-- ROLLBACK: DELETE FROM health_config WHERE config_key = 'cap_solo_feed';
-- (spegne il pilota; la tabella-specchio resta, e' sola lettura e innocua)
