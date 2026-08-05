-- tenant_configs aveva solo created_at: impossibile sapere quando una config
-- veniva aggiornata. Conseguenza: AlertMonitor cieco al disallineamento
-- stable_cache vs feed_actions. Aggiungiamo updated_at + trigger.

ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Inizializza per le righe esistenti = created_at (best-effort, non disponibile
-- la vera data dell'ultimo UPDATE).
UPDATE tenant_configs SET updated_at = created_at WHERE updated_at IS NULL;

-- Trigger di auto-update
CREATE OR REPLACE FUNCTION fn_tenant_configs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenant_configs_updated_at ON tenant_configs;
CREATE TRIGGER trg_tenant_configs_updated_at
  BEFORE UPDATE ON tenant_configs
  FOR EACH ROW
  EXECUTE FUNCTION fn_tenant_configs_set_updated_at();
