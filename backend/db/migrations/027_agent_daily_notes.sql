-- Agent Daily Notes — note quotidiane scritte da Claude per tenant
-- Toggle per-tenant via tenant_configs.config_key='claude_optimizer_enabled'
-- (valore 'true' o 'false'; default è disattivo se chiave assente)

CREATE TABLE IF NOT EXISTS agent_daily_notes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  note_date DATE NOT NULL,
  model VARCHAR(50) NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd_estimated NUMERIC(8,4),
  kpi_snapshot JSONB,
  note_text TEXT NOT NULL,
  telegram_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, note_date)
);

CREATE INDEX IF NOT EXISTS idx_agent_daily_notes_tenant_date
  ON agent_daily_notes(tenant_id, note_date DESC);
