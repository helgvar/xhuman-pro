-- Migration 007: Product Health Scoring & P&L Engine

-- Per-product enriched health data (recomputed every 4h)
CREATE TABLE IF NOT EXISTS product_health_scores (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,

  -- P&L fields
  tp_clicks_30d INTEGER DEFAULT 0,
  tp_click_cost_30d NUMERIC(10,2) DEFAULT 0,
  tp_attributed_revenue NUMERIC(12,2) DEFAULT 0,
  tp_attributed_orders INTEGER DEFAULT 0,
  tp_cogs NUMERIC(12,2) DEFAULT 0,
  tp_gross_margin NUMERIC(12,2) DEFAULT 0,
  tp_cost_incidence NUMERIC(8,4) DEFAULT 0,

  -- Merchant Center data snapshot
  mc_benchmark_price NUMERIC(10,2),
  mc_suggested_price NUMERIC(10,2),
  mc_click_potential VARCHAR(20) DEFAULT '',
  mc_click_potential_rank NUMERIC(10,2),
  mc_clicks_14d INTEGER DEFAULT 0,
  mc_impressions_14d INTEGER DEFAULT 0,
  mc_ctr_14d NUMERIC(8,4) DEFAULT 0,
  mc_predicted_clicks_change NUMERIC(8,4),
  mc_predicted_impressions_change NUMERIC(8,4),

  -- Scraper data snapshot
  scraper_position INTEGER,
  scraper_competitor_count INTEGER DEFAULT 0,
  scraper_best_price NUMERIC(10,2),
  scraper_price_gap_pct NUMERIC(8,2) DEFAULT 0,

  -- Score components (0-100 each)
  revenue_score NUMERIC(5,2) DEFAULT 0,
  efficiency_score NUMERIC(5,2) DEFAULT 0,
  competitive_score NUMERIC(5,2) DEFAULT 0,
  growth_score NUMERIC(5,2) DEFAULT 0,
  seasonal_score NUMERIC(5,2) DEFAULT 0,
  indirect_score NUMERIC(5,2) DEFAULT 0,

  -- Composite score
  health_score NUMERIC(5,2) DEFAULT 0,
  data_confidence NUMERIC(3,2) DEFAULT 0,

  -- Classification
  classification VARCHAR(20) DEFAULT 'question_mark',

  -- Recommendation
  rec_civetta BOOLEAN,
  rec_price_action VARCHAR(20) DEFAULT 'none',
  rec_price NUMERIC(12,2),
  rec_priority VARCHAR(10) DEFAULT 'low',
  rec_reasoning TEXT DEFAULT '',

  -- Seasonality
  is_seasonal BOOLEAN DEFAULT FALSE,
  season_id VARCHAR(30) DEFAULT '',

  -- GA4 indirect attribution (Phase 5)
  ga4_indirect_revenue NUMERIC(12,2) DEFAULT 0,
  ga4_indirect_orders INTEGER DEFAULT 0,

  -- Timestamps
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_health_tenant_sku UNIQUE(tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_health_tenant ON product_health_scores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_health_classification ON product_health_scores(tenant_id, classification);
CREATE INDEX IF NOT EXISTS idx_health_score ON product_health_scores(tenant_id, health_score DESC);
CREATE INDEX IF NOT EXISTS idx_health_incidence ON product_health_scores(tenant_id, tp_cost_incidence DESC);
CREATE INDEX IF NOT EXISTS idx_health_burner ON product_health_scores(tenant_id, classification, tp_click_cost_30d DESC)
  WHERE classification = 'burner';

-- Daily snapshots for trend analysis
CREATE TABLE IF NOT EXISTS product_health_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  snapshot_date DATE NOT NULL,
  health_score NUMERIC(5,2) DEFAULT 0,
  classification VARCHAR(20) DEFAULT '',
  tp_cost_incidence NUMERIC(8,4) DEFAULT 0,
  tp_attributed_revenue NUMERIC(12,2) DEFAULT 0,
  tp_clicks_30d INTEGER DEFAULT 0,
  tp_click_cost_30d NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_health_history UNIQUE(tenant_id, sku, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_health_history_tenant_date ON product_health_history(tenant_id, snapshot_date DESC);

-- Configurable weights and parameters per tenant
CREATE TABLE IF NOT EXISTS health_config (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  config_key VARCHAR(50) NOT NULL,
  config_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_health_config UNIQUE(tenant_id, config_key)
);

-- Insert default config for all existing tenants
INSERT INTO health_config (tenant_id, config_key, config_value)
SELECT t.id, cfg.key, cfg.value
FROM tenants t
CROSS JOIN (VALUES
  ('weight_revenue', '0.30'),
  ('weight_efficiency', '0.25'),
  ('weight_competitive', '0.15'),
  ('weight_growth', '0.10'),
  ('weight_seasonal', '0.10'),
  ('weight_indirect', '0.10'),
  ('avg_tp_cpc', '0.15'),
  ('tp_target_incidence_min', '3'),
  ('tp_target_incidence_max', '5')
) AS cfg(key, value)
ON CONFLICT DO NOTHING;
