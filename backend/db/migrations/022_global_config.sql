-- Global system configuration: credentials shared across ALL tenants.
-- Drive service account, scraper folder id, Telegram bot, Claude API key, etc.
-- Per-tenant configs (Magento, Farmabooster, GA4 property_id) stay in tenant_configs.

CREATE TABLE IF NOT EXISTS global_config (
  config_key TEXT PRIMARY KEY,
  config_value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One-shot data migration: copy known global keys from the tenant_configs entry
-- that currently holds them. Prefer the most-frequent value across tenants.
-- Safe to re-run thanks to ON CONFLICT.
INSERT INTO global_config (config_key, config_value, description)
SELECT
  config_key,
  (array_agg(config_value ORDER BY n DESC))[1] AS most_common_value,
  'auto-migrated from tenant_configs'
FROM (
  SELECT config_key, config_value, COUNT(*) AS n
  FROM tenant_configs
  WHERE config_key IN (
    'google_service_account_json',
    'ga4_credentials_json',
    'scraper_drive_folder_id',
    'telegram_bot_token',
    'telegram_chat_id',
    'anthropic_api_key',
    'claude_api_key'
  )
  GROUP BY config_key, config_value
) freq
GROUP BY config_key
ON CONFLICT (config_key) DO NOTHING;
