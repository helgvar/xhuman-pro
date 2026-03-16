-- Migration 008: GA4 Attribution Support
-- Adds entity_id mapping for GA4 itemId → SKU conversion
-- Adds GA4 attribution columns to product_health_scores
-- Adds ga4_runs tracking table

-- Products: add Magento entity_id for GA4 mapping
ALTER TABLE products ADD COLUMN IF NOT EXISTS magento_entity_id VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_products_entity_id ON products(magento_entity_id) WHERE magento_entity_id IS NOT NULL;

-- Product health scores: add GA4 attribution fields
ALTER TABLE product_health_scores ADD COLUMN IF NOT EXISTS ga4_tp_purchases INTEGER DEFAULT 0;
ALTER TABLE product_health_scores ADD COLUMN IF NOT EXISTS ga4_tp_revenue NUMERIC(12,2) DEFAULT 0;
ALTER TABLE product_health_scores ADD COLUMN IF NOT EXISTS ga4_assisted_sales INTEGER DEFAULT 0;
ALTER TABLE product_health_scores ADD COLUMN IF NOT EXISTS ga4_assisted_revenue NUMERIC(12,2) DEFAULT 0;
ALTER TABLE product_health_scores ADD COLUMN IF NOT EXISTS ga4_total_tp_value NUMERIC(12,2) DEFAULT 0;
ALTER TABLE product_health_scores ADD COLUMN IF NOT EXISTS ga4_is_assist_product BOOLEAN DEFAULT false;

-- GA4 channel snapshot (daily)
CREATE TABLE IF NOT EXISTS ga4_channel_daily (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  channel VARCHAR(100) NOT NULL,
  sessions INTEGER DEFAULT 0,
  transactions INTEGER DEFAULT 0,
  revenue NUMERIC(12,2) DEFAULT 0,
  avg_basket NUMERIC(10,2) DEFAULT 0,
  conv_rate NUMERIC(6,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, snapshot_date, channel)
);

-- GA4 source/medium snapshot (daily)
CREATE TABLE IF NOT EXISTS ga4_source_daily (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  source VARCHAR(200) NOT NULL,
  medium VARCHAR(100) NOT NULL,
  sessions INTEGER DEFAULT 0,
  transactions INTEGER DEFAULT 0,
  revenue NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, snapshot_date, source, medium)
);

-- GA4 execution log
CREATE TABLE IF NOT EXISTS ga4_runs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'running',
  products_attributed INTEGER DEFAULT 0,
  tp_revenue NUMERIC(12,2) DEFAULT 0,
  tp_transactions INTEGER DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
