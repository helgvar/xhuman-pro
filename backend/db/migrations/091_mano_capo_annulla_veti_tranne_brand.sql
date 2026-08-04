-- 091 — ORDINE CAPO 5/8: "annulla tutti i veti che hai sul taglio prodotti
-- ad esclusione di quelli brand"
--
-- Stato prima di questa migrazione: il writer `capo_%` scavalcava gia' la
-- guardia venditore (mig 087) e la ri-condanna (mig 086), ma NON:
--   1. trg_veto_basket_fn -> is_feed_protected(): carrelli, pin, stock,
--      top10, seller-15gg, coorti di attivazione. Blocca in silenzio
--      (traccia solo in basket_veto_log).
--   2. trg_cap_condanne_fn: il cap giornaliero bypassa solo `sessione_%`.
--      Un taglio di massa firmato dal capo si sarebbe fermato a 150-250 righe.
--
-- Dopo: sulle REMOVE firmate dalla mano del capo resta in piedi UN SOLO veto,
-- quello che il capo ha nominato — **brand protetti** (is_brand_protected).
-- Piu' la guardia freschezza dati (products.updated_at < 12h), che non e' un
-- veto ma una legge del capo stesso ("prima i dati freschi, poi il giudizio"):
-- su un dato vecchio non si condanna, si aspetta il sync.
--
-- Ogni scavalco e' a verbale in azioni_touch_log come 'override_veto' con lo
-- scudo caduto, cosi' il conto di cosa e' stato tolto e perche' resta leggibile.
--
-- NON tocca: i motori automatici (writer diversi da capo_%/manual%) continuano
-- a subire tutti gli scudi come prima. Nessun flag per-tenant: la mano del capo
-- e' la mano del capo ovunque, ma scrive solo dove gliela facciamo scrivere.

BEGIN;

-- 1) Basket guard: per la mano del capo resta solo il brand.
CREATE OR REPLACE FUNCTION trg_veto_basket_fn() RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

-- 2) Cap anti-strage: frena i motori, non gli ordini firmati del capo.
CREATE OR REPLACE FUNCTION trg_cap_condanne_fn() RETURNS TRIGGER AS $$
DECLARE
  v_oggi INT;
  v_cap INT;
  v_ha_csv BOOLEAN;
  v_pilota BOOLEAN;
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  -- Le azioni di SESSIONE e la mano del capo (mig 091) sono verificate caso per
  -- caso e a verbale: il cap-anti-strage frena i motori automatici, non gli
  -- ordini espliciti. Bypass governato (mig 064, capo 15/7).
  IF v_writer LIKE 'sessione\_%' ESCAPE '\'
     OR v_writer LIKE 'capo\_%' ESCAPE '\'
     OR v_writer LIKE 'manual%' THEN
    RETURN NEW;
  END IF;

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
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':NOOP_GIA_FUORI');
    RETURN NULL;
  END IF;

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

INSERT INTO schema_migrations (filename) VALUES ('091_mano_capo_annulla_veti_tranne_brand.sql')
ON CONFLICT DO NOTHING;

COMMIT;

-- ROLLBACK: rieseguire le definizioni pre-091 (mig 088 per il cap, mig 039/090
-- per il basket guard). Nessun dato modificato, solo due funzioni.
