-- Migration 006: Google Merchant Center data

-- Product-level Merchant Center data (per-tenant)
CREATE TABLE IF NOT EXISTS merchant_center_products (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offer_id VARCHAR(50) NOT NULL,
  -- Product info from MC
  mc_title TEXT DEFAULT '',
  mc_brand VARCHAR(200) DEFAULT '',
  mc_gtin VARCHAR(50) DEFAULT '',
  mc_availability VARCHAR(30) DEFAULT '',
  mc_condition VARCHAR(20) DEFAULT '',
  mc_channel VARCHAR(20) DEFAULT 'ONLINE',
  mc_price NUMERIC(10,2) DEFAULT 0,
  mc_sale_price NUMERIC(10,2) DEFAULT 0,
  mc_currency VARCHAR(5) DEFAULT 'EUR',
  google_product_category TEXT DEFAULT '',
  custom_label0 VARCHAR(100) DEFAULT '',
  custom_label1 VARCHAR(100) DEFAULT '',
  custom_label2 VARCHAR(100) DEFAULT '',
  custom_label3 VARCHAR(100) DEFAULT '',
  custom_label4 VARCHAR(100) DEFAULT '',
  excluded_destinations TEXT[] DEFAULT '{}',
  -- Approval status
  approval_status VARCHAR(30) DEFAULT '',
  item_issues_count INTEGER DEFAULT 0,
  -- Price competitiveness (benchmark from Google)
  benchmark_price NUMERIC(10,2),
  -- Price insights (Google suggested price)
  suggested_price NUMERIC(10,2),
  predicted_impressions_change NUMERIC(8,4),
  predicted_clicks_change NUMERIC(8,4),
  -- Click potential
  click_potential VARCHAR(20) DEFAULT '',
  click_potential_rank INTEGER,
  -- Dates
  mc_creation_date TIMESTAMPTZ,
  mc_expiration_date DATE,
  mc_last_update TIMESTAMPTZ,
  -- Performance (aggregated last 14 days)
  clicks_14d INTEGER DEFAULT 0,
  impressions_14d INTEGER DEFAULT 0,
  ctr_14d NUMERIC(8,6) DEFAULT 0,
  conversions_14d NUMERIC(8,2) DEFAULT 0,
  conversion_value_14d NUMERIC(10,2) DEFAULT 0,
  -- Timestamps
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mc_products_tenant_offer
  ON merchant_center_products(tenant_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_mc_products_tenant
  ON merchant_center_products(tenant_id);

-- Daily performance snapshots (for trend analysis)
CREATE TABLE IF NOT EXISTS merchant_center_daily (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  offer_id VARCHAR(50) NOT NULL,
  clicks INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  ctr NUMERIC(8,6) DEFAULT 0,
  conversions NUMERIC(8,2) DEFAULT 0,
  conversion_value NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mc_daily_tdo
  ON merchant_center_daily(tenant_id, report_date, offer_id);
CREATE INDEX IF NOT EXISTS idx_mc_daily_td
  ON merchant_center_daily(tenant_id, report_date);

-- Merchant Center import runs
CREATE TABLE IF NOT EXISTS merchant_center_runs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_type VARCHAR(30) DEFAULT 'full',
  status VARCHAR(20) DEFAULT 'pending',
  products_count INTEGER DEFAULT 0,
  benchmark_count INTEGER DEFAULT 0,
  insights_count INTEGER DEFAULT 0,
  performance_count INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
