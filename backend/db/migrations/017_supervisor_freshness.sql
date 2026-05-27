-- 017: Aggiungi updated_at a product_health_scores per misurare freshness GA4 correttamente.
-- Senza questo, gli UPSERT mantengono il created_at originale e la freshness check del Supervisor
-- segna falsi positivi "GA4 stale" anche quando i dati vengono aggiornati ad ogni cron.

ALTER TABLE product_health_scores ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Trigger: aggiorna updated_at ad ogni UPDATE
CREATE OR REPLACE FUNCTION trg_phs_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_phs_updated_at_set ON product_health_scores;
CREATE TRIGGER trg_phs_updated_at_set
BEFORE UPDATE ON product_health_scores
FOR EACH ROW EXECUTE FUNCTION trg_phs_updated_at();

CREATE INDEX IF NOT EXISTS idx_phs_tenant_updated ON product_health_scores(tenant_id, updated_at DESC);

-- Bootstrap: per le righe esistenti, allinea updated_at a created_at (cosi' il check parte pulito)
UPDATE product_health_scores SET updated_at = created_at WHERE updated_at < created_at;
