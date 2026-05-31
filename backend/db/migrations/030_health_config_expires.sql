-- health_config: aggiungiamo scadenza opzionale per parametri "temporanei"
-- (es. boost commerciale del ponte 2/6, rollback automatico al timestamp).
-- I lookup esistenti (feedDailyEngine.loadConfig, loadPepiteRules) filtrano
-- WHERE expires_at IS NULL OR expires_at > NOW() — quindi un valore scaduto
-- viene ignorato senza dover fare cleanup.
ALTER TABLE health_config ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_health_config_expires
  ON health_config (tenant_id, expires_at) WHERE expires_at IS NOT NULL;
