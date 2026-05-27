-- Migration 010: Progressive Quarantine System
-- Escalating quarantine: Q1 (7d) → Q2 (15d) → Q3 (30d) → Q4 (permanent)

-- Add escalation columns to feed_quarantine
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS quarantine_level INTEGER DEFAULT 1;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS observation_start TIMESTAMPTZ;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS observation_end TIMESTAMPTZ;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS observation_clicks INTEGER DEFAULT 0;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS observation_orders INTEGER DEFAULT 0;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS is_permanent BOOLEAN DEFAULT FALSE;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS manual_override BOOLEAN DEFAULT FALSE;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS manual_override_at TIMESTAMPTZ;

-- History table for every quarantine cycle
CREATE TABLE IF NOT EXISTS feed_quarantine_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  quarantine_level INTEGER NOT NULL,
  reason VARCHAR(50) NOT NULL,
  quarantine_start TIMESTAMPTZ,
  quarantine_end TIMESTAMPTZ,
  reactivated_at TIMESTAMPTZ,
  observation_start TIMESTAMPTZ,
  observation_end TIMESTAMPTZ,
  observation_clicks INTEGER DEFAULT 0,
  observation_orders INTEGER DEFAULT 0,
  recidivism_detected BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quarantine_history_sku ON feed_quarantine_history(tenant_id, sku, created_at DESC);

-- Quarantine config defaults
INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'quarantine_q1_days', '7', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'quarantine_q1_days'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'quarantine_q2_days', '15', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'quarantine_q2_days'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'quarantine_q3_days', '30', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'quarantine_q3_days'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'quarantine_observation_days', '3', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'quarantine_observation_days'
);
