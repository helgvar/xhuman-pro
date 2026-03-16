-- Migration 005: Zombie module (Trovaprezzi click downloads)

-- Click data downloaded from Trovaprezzi analytics portal (per-tenant, per-day)
CREATE TABLE IF NOT EXISTS zombie_clicks (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fetch_date DATE NOT NULL,
  product_code VARCHAR(50) NOT NULL,
  product_name TEXT DEFAULT '',
  trovaprezzi_category VARCHAR(200) DEFAULT '',
  clicks INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zombie_clicks_tdp
  ON zombie_clicks(tenant_id, fetch_date, product_code);
CREATE INDEX IF NOT EXISTS idx_zombie_clicks_td
  ON zombie_clicks(tenant_id, fetch_date);

-- Zombie run log (track each execution)
CREATE TABLE IF NOT EXISTS zombie_runs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  products_count INTEGER DEFAULT 0,
  total_clicks INTEGER DEFAULT 0,
  ftp_uploaded BOOLEAN DEFAULT FALSE,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
