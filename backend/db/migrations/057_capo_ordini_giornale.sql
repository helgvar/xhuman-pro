-- 057: LIBRO GIORNALE DEGLI ORDINI DEL CAPO (13/7, testuale: "mantieni un
-- libro giornale degli ordini che ti impartisco per singolo tenant con data
-- e ora, così quando ti chiedo qualcosa capisci se sono state già fatte
-- azioni del genere").
--
-- Ogni ordine del capo → una riga QUI, PRIMA di eseguire. La sessione
-- consulta il giornale per rispondere "è già stato fatto?" e per non
-- ripetere/contraddire ordini precedenti.

CREATE TABLE IF NOT EXISTS capo_ordini (
  id BIGSERIAL PRIMARY KEY,
  ordinato_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id UUID,                       -- NULL = ordine di rete/globale
  categoria TEXT,                       -- feed | prezzi | blocchi | config | infra | monitor
  ordine TEXT NOT NULL,                 -- le parole del capo (sintesi fedele)
  azione_eseguita TEXT,                 -- cosa è stato fatto nel sistema
  esito TEXT,                           -- numeri/risultato
  riferimenti JSONB,                    -- migrazioni, flag, coorti, pin coinvolti
  attivo BOOLEAN NOT NULL DEFAULT true  -- false quando revocato/superato
);
CREATE INDEX IF NOT EXISTS idx_capo_ordini_tenant ON capo_ordini (tenant_id, ordinato_at DESC);
