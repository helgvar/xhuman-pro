-- 100_price_cut_freeze.sql — ordine capo 16/08/2026
--
-- CONTESTO. L'import Farmabooster è morto il 13/08 sera (403 «CSRF token non
-- valido» su POST /api/login, su tutte e 10 le istanze). Da allora costi e
-- prezzi di listino non si aggiornano più: i motori tagliano prezzi su costi
-- vecchi di giorni. Un costo salito il 14/08 noi non lo vediamo, e continuiamo
-- a scontare sopra un costo che non esiste più.
--
-- ORDINE: annullare tutti i price cut, tenerne il registro per riattivarli
-- quando Farmabooster torna.
--
-- Qui si costruiscono tre cose:
--   1. price_cut_sospesi     — registro di ripristino, riga per riga
--   2. global_config.price_cut_freeze — il rubinetto
--   3. trigger sul feed_actions — perché senza rubinetto i motori riscrivono
--      i tagli al primo giro (sellerGuardCron, feedHygieneCycle,
--      aiMarginCalibrator, agente AI: sono 4+ punti di scrittura, il trigger
--      li copre tutti in un colpo invece di toccare sei file)
--
-- Il trigger NON solleva eccezioni: azzera il prezzo e conta il tentativo.
-- Sollevare avrebbe fatto fallire interi cicli di motore per una riga.

BEGIN;

-- 1. REGISTRO DI RIPRISTINO ------------------------------------------------
-- Copia integrale della riga com'era prima della sospensione. Al ritorno di
-- Farmabooster si rimette esattamente questo, non una ricostruzione.
CREATE TABLE IF NOT EXISTS price_cut_sospesi (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku               varchar(20) NOT NULL,
  action_source     varchar(100),
  action_reason     text,
  current_price     numeric(10,2),
  recommended_price numeric(10,2) NOT NULL,   -- il taglio che stiamo togliendo
  price_cut_pct     numeric(6,2),
  erp_cost          numeric(10,2),
  cost_source       varchar(50),
  new_margin        numeric(10,2),
  new_margin_pct    numeric(6,2),
  status_prec       varchar(30),
  computed_at       timestamptz,
  expires_at        timestamptz,
  era_in_feed       boolean,                  -- is_civetta al momento della sospensione:
                                              -- false = stava in vetrina SOLO grazie al PC
  motivo            text NOT NULL,
  sospeso_at        timestamptz NOT NULL DEFAULT NOW(),
  ripristinato_at   timestamptz               -- NULL = ancora sospeso
);

CREATE INDEX IF NOT EXISTS idx_pc_sospesi_da_ripristinare
  ON price_cut_sospesi (tenant_id, sku) WHERE ripristinato_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pc_sospesi_quando
  ON price_cut_sospesi (sospeso_at DESC);

-- 2. IL RUBINETTO -----------------------------------------------------------
-- '1' = nessun price cut può avere un prezzo. Si spegne con un UPDATE.
INSERT INTO global_config (config_key, config_value, description)
VALUES ('price_cut_freeze', '1',
        'Ordine capo 16/08/2026: nessun price cut finche'' l''import Farmabooster e'' fermo (costi stantii). Spegnere con config_value=0 e poi ripristinare da price_cut_sospesi.')
ON CONFLICT (config_key) DO UPDATE SET config_value = '1', updated_at = NOW();

-- 3. CONTATORE DEI TENTATIVI BLOCCATI ---------------------------------------
-- Una riga per tenant/sku/giorno con un contatore: i motori girano ogni ora,
-- una riga per tentativo avrebbe fatto milioni di righe inutili.
CREATE TABLE IF NOT EXISTS price_cut_freeze_log (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku           varchar(20) NOT NULL,
  giorno        date NOT NULL,
  action_source varchar(100),
  tentativi     int NOT NULL DEFAULT 1,
  ultimo_prezzo numeric(10,2),
  ultimo_at     timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku, giorno)
);

CREATE INDEX IF NOT EXISTS idx_pc_freeze_log_giorno ON price_cut_freeze_log (giorno DESC);

-- 4. IL TRIGGER -------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_price_cut_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attivo boolean;
BEGIN
  IF NEW.action <> 'PRICE_CUT' OR NEW.recommended_price IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT config_value = '1' INTO attivo
    FROM global_config WHERE config_key = 'price_cut_freeze';

  IF NOT COALESCE(attivo, false) THEN
    RETURN NEW;
  END IF;

  -- Congelato: il taglio non passa. Si conta e si lascia la riga senza prezzo,
  -- cosi' i motori non si rompono a meta' ciclo.
  INSERT INTO price_cut_freeze_log AS l
    (tenant_id, sku, giorno, action_source, tentativi, ultimo_prezzo, ultimo_at)
  VALUES (NEW.tenant_id, NEW.sku, CURRENT_DATE, NEW.action_source, 1,
          NEW.recommended_price, NOW())
  ON CONFLICT (tenant_id, sku, giorno) DO UPDATE
    SET tentativi = l.tentativi + 1,
        action_source = EXCLUDED.action_source,
        ultimo_prezzo = EXCLUDED.ultimo_prezzo,
        ultimo_at = NOW();

  NEW.recommended_price := NULL;
  NEW.price_cut_pct := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS price_cut_freeze_guard ON feed_actions;
CREATE TRIGGER price_cut_freeze_guard
  BEFORE INSERT OR UPDATE OF action, recommended_price ON feed_actions
  FOR EACH ROW EXECUTE FUNCTION trg_price_cut_freeze();

INSERT INTO schema_migrations (filename) VALUES ('100_price_cut_freeze.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
