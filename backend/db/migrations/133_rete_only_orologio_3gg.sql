-- ============================================================================
-- 133 — L'OROLOGIO DEL "VENDE IN RETE, NON QUI" (ordine capo 13/09)
--
-- "Se vende nella rete e non sul singolo tenant, o va riposizionato e
--  monitorato per massimo 3 giorni o va staccato subito. Se dopo i 3 giorni
--  comunque non vende o non ha un'incidenza giusta deve essere tagliato."
--
-- Fino a oggi questo caso NON aveva un loop: aveva solo SCUDI, e nessun
-- orologio. Misurato su Procaccini il 13/09: 546 SKU vivi, 293,08 EUR/30gg.
--   - PASS 4 lima (tetto rete-only 80 EUR/mese PER SKU): 0 su 546 lo superano,
--     lo SKU piu' caro del bucket costa 4,61 EUR/mese. Tetto 17x fuori scala.
--   - PASS 2 lima (banco di test PC): guarda solo SKU gia' BLOCCATI. Questi
--     sono ATTIVI nel feed. Eleggibili: 0 su 546.
--   - Scudo L2-rete in trg_veto_condanna_vendente_fn: nessun orologio, nessun
--     verdetto. Scudo eterno.
--   - is_feed_protected: la sola POSIZIONE top-10 protegge. 406 su 546 la
--     hanno. Il veto basket li scarta in SILENZIO (RETURN NULL).
--
-- Questa migrazione mette l'orologio e apre la porta al solo writer che ha
-- gia' pagato i 3 giorni di osservazione. Non tocca PASS 4, non tocca gli
-- altri scudi: L2 (vende su QUESTO tenant) e L4 (vende e ripaga) restano in
-- piedi e sono la rete di sicurezza del verdetto.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. IL REGISTRO DELL'OSSERVAZIONE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rete_only_osservazioni (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku               TEXT NOT NULL,
  fase              TEXT NOT NULL DEFAULT 'riposizionato',
  prezzo_prima      NUMERIC,
  prezzo_dopo       NUMERIC,
  costo_prima       NUMERIC,
  ricarico_post_pct NUMERIC,
  pos_prima         INT,
  click_prima_30g   INT,
  spesa_prima_30g   NUMERIC,
  activated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  osservazione_giorni INT NOT NULL DEFAULT 3,
  osservazione_end  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '3 days',
  -- misure del verdetto
  pezzi_dopo        INT,
  netto_dopo        NUMERIC,
  click_dopo        INT,
  spesa_dopo        NUMERIC,
  incidenza_dopo    NUMERIC,
  esito             TEXT,          -- 'promosso' | 'bocciato' | 'annullato'
  motivo_esito      TEXT,
  closed_at         TIMESTAMPTZ,
  CONSTRAINT uq_rete_only_oss UNIQUE (tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_rete_only_oss_aperte
  ON rete_only_osservazioni (osservazione_end) WHERE esito IS NULL;

COMMENT ON TABLE rete_only_osservazioni IS
  'Orologio a 3 giorni sui riposizionamenti "vende in rete, non qui" (ordine capo 13/09). '
  'Fase A apre la riga col PC, fase B la chiude col verdetto: vende + incidenza sana = promosso, '
  'altrimenti bocciato e tagliato.';

-- ---------------------------------------------------------------------------
-- 2. IL TETTO DEL BUCKET, NON DEL SINGOLO SKU
--    Il PASS 4 della lima resta com'e' (tetto 80 EUR/mese per SKU: prende i
--    singoli grandi bruciatori). Questo e' il tetto AGGREGATO sulla spesa che
--    puo' stare in osservazione aperta contemporaneamente su un tenant.
-- ---------------------------------------------------------------------------
INSERT INTO global_config (config_key, config_value)
VALUES ('rete_only_bucket_cap_eur', '60')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO global_config (config_key, config_value)
VALUES ('rete_only_incidenza_max', '8')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. LO SCUDO L2-RETE ORA HA UNA PORTA: SOLO CHI HA FATTO I 3 GIORNI
--    Cambia SOLO il ramo L2-rete. L2 (vende su questo tenant) e L4 (vende e
--    ripaga) NON si toccano: se durante l'osservazione lo SKU ha iniziato a
--    vendere qui, il verdetto e' 'promosso' e il REMOVE non parte mai; se
--    partisse per errore, L2 lo blocca. E' la rete di sicurezza.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_veto_condanna_vendente_fn() RETURNS trigger AS $fn$
DECLARE
  v_pos INT;
  v_pos_max INT;
  v_brucia BOOLEAN := false;
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  -- MANO DEL CAPO (mig 087): comanda su tutte le tabelle, non solo quarantena.
  IF v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%' THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'override_umano', TG_TABLE_NAME, NULL, 'condanna permessa',
            v_writer, 'mig 087: mano umana, guardia venditore scavalcata di proposito', NULL);
    RETURN NEW;
  END IF;

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

  -- Mig 090: il giudizio margine-first e' UNO e governa tutti gli scudi.
  v_brucia := l2_ripago_attivo(NEW.tenant_id)
              AND vende_ma_brucia_margine(NEW.tenant_id, NEW.sku);

  -- L2 — vende su questo tenant. Lo scudo NON vale piu' per chi vende
  -- bruciando margine, dove il tenant ha l'interruttore acceso (mig 089).
  IF vende_su_tenant_15g(NEW.tenant_id, NEW.sku) THEN
    IF v_brucia THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'scudo_caduto', TG_TABLE_NAME, 'L2 vendente', 'condanna permessa',
              v_writer, 'mig 089: vende ma il click costa piu del margine (margine-first)', NULL);
    ELSE
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
              v_writer, 'L2: vende su QUESTO tenant 15g', NULL);
      RETURN NULL;
    END IF;
  END IF;

  -- L4 (mig 085): chi vende e ripaga il click non si tocca. Mig 090: la sua
  -- finestra 30gg a incidenza NON salva piu' chi brucia margine su 15gg
  -- (leggi capo: finestre max 15gg + margine-first).
  IF vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
    IF v_brucia THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'scudo_caduto', TG_TABLE_NAME, 'L4 ripaga 30g', 'condanna permessa',
              v_writer, 'mig 090: incidenza 30g ok ma margine 15g bruciato (margine-first vince)', NULL);
    ELSE
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
              v_writer, 'L4 (mig 085): vende 30g e il click si ripaga', NULL);
      RETURN NULL;
    END IF;
  END IF;

  -- L2-rete (mig 060/061): vende in rete + posizione fresca buona. Mig 090:
  -- la posizione non salva chi brucia (era il caso 981647821, pos 1).
  -- MIG 133: e non salva nemmeno chi ha gia' scontato i 3 giorni di
  -- osservazione con verdetto BOCCIATO. Lo scudo non ha mai avuto un orologio:
  -- ora ce l'ha, e l'unico writer che puo' passare e' quello del verdetto.
  IF vende_in_rete_15g(NEW.sku) THEN
    v_pos := pos_fresca(NEW.tenant_id, NEW.sku);
    SELECT COALESCE((SELECT hc.config_value::int FROM health_config hc
      WHERE hc.tenant_id = NEW.tenant_id AND hc.config_key = 'release_pos_max'), 10)
    INTO v_pos_max;
    IF v_pos IS NOT NULL AND v_pos <= v_pos_max THEN
      IF v_brucia THEN
        INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
        VALUES (NEW.tenant_id, NEW.sku, 'scudo_caduto', TG_TABLE_NAME, 'L2-rete pos ' || v_pos, 'condanna permessa',
                v_writer, 'mig 090: vende in rete a pos ' || v_pos || ' ma qui brucia margine (margine-first vince)', NULL);
      ELSIF v_writer LIKE 'sessione\_rete\_only%' ESCAPE '\' THEN
        INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
        VALUES (NEW.tenant_id, NEW.sku, 'scudo_caduto', TG_TABLE_NAME, 'L2-rete pos ' || v_pos, 'condanna permessa',
                v_writer, COALESCE(NULLIF(current_setting('xhp.motivo', true), ''),
                  'mig 133: orologio 3gg scaduto — vende in rete ma non qui, verdetto bocciato'), NULL);
      ELSE
        INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
        VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
                v_writer, 'L2: vende in rete E pos fresca ' || v_pos || ' <= ' || v_pos_max || ' su questo tenant', NULL);
        RETURN NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 4. IL VETO BASKET: STESSA PORTA, STESSE CHIAVI
--    Per il writer del verdetto cadono SOLO due scudi: la posizione top-10 e
--    "vende in rete" (dentro is_feed_protected). Restano in piedi, e sono
--    invalicabili anche qui:
--      - brand protetto (mig 091: l'unico veto che il capo ha lasciato)
--      - carrello sano (dictat guardia carrello 9/7)
--      - pin del capo
--      - dati stantii > 12h (legge del costo, ordine capo 25/08)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_veto_basket_fn() RETURNS trigger AS $fn$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF TG_TABLE_NAME = 'feed_actions'
     AND (to_jsonb(NEW)->>'action') IS DISTINCT FROM 'REMOVE' THEN
    RETURN NEW;
  END IF;

  -- MIG 133 — verdetto rete-only: ha gia' pagato 3 giorni di osservazione.
  -- Cadono la posizione top-10 e "vende in rete"; brand, carrello, pin e
  -- freschezza dei dati restano.
  IF v_writer LIKE 'sessione\_rete\_only%' ESCAPE '\' THEN
    IF is_brand_protected(NEW.tenant_id, NEW.sku) THEN
      INSERT INTO basket_veto_log (tenant_id, sku, target_table)
      VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':BRAND_PROTETTO');
      RETURN NULL;
    END IF;
    IF is_basket_protected(NEW.tenant_id, NEW.sku) THEN
      INSERT INTO basket_veto_log (tenant_id, sku, target_table)
      VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':CARRELLO_SANO');
      RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM capo_pins cp
               WHERE cp.tenant_id = NEW.tenant_id AND cp.sku = NEW.sku AND cp.revoked_at IS NULL) THEN
      INSERT INTO basket_veto_log (tenant_id, sku, target_table)
      VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':PIN_DEL_CAPO');
      RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM products p
               WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku
                 AND p.updated_at < NOW() - INTERVAL '12 hours') THEN
      INSERT INTO basket_veto_log (tenant_id, sku, target_table)
      VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':DATI_STANTII');
      RETURN NULL;
    END IF;
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'override_veto', TG_TABLE_NAME, 'is_feed_protected (top10 / vende in rete)',
            'condanna permessa', v_writer,
            COALESCE(NULLIF(current_setting('xhp.motivo', true), ''),
                     'mig 133: orologio 3gg scaduto sul bucket rete-only'), NULL);
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

  -- 091 — MANO DEL CAPO: un solo veto in piedi, il brand.
  IF v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%' THEN
    IF is_brand_protected(NEW.tenant_id, NEW.sku) THEN
      INSERT INTO basket_veto_log (tenant_id, sku, target_table)
      VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':BRAND_PROTETTO');
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, 'brand protetto', 'condanna bloccata',
              v_writer, 'mig 091: brand protetto — unico veto che il capo ha lasciato in piedi', NULL);
      RETURN NULL;
    END IF;
    -- Freschezza dati: legge del capo, non scudo di prodotto.
    IF EXISTS (SELECT 1 FROM products p
               WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku
                 AND p.updated_at < NOW() - INTERVAL '12 hours') THEN
      INSERT INTO basket_veto_log (tenant_id, sku, target_table)
      VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':DATI_STANTII');
      RETURN NULL;
    END IF;
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'override_veto', TG_TABLE_NAME, 'is_feed_protected', 'condanna permessa',
            v_writer, COALESCE(NULLIF(current_setting('xhp.motivo', true), ''),
                               'mig 091: ordine capo — veti annullati tranne brand'), NULL);
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

INSERT INTO schema_migrations (filename) VALUES ('133_rete_only_orologio_3gg.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
