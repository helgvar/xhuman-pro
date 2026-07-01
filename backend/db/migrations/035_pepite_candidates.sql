CREATE TABLE IF NOT EXISTS pepite_candidates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  product_name VARCHAR(500),
  brand VARCHAR(200),
  found_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- Snapshot al momento del rilevamento
  sales_30d_seller INT DEFAULT 0,
  sales_30d_aggregated INT DEFAULT 0,
  erp_stock INT DEFAULT 0,
  scraper_position INT,
  target_position INT,
  sell_price NUMERIC(10,2),
  erp_cost NUMERIC(10,2),
  ricarico_ora NUMERIC(6,2),
  scraper_best_price NUMERIC(10,2),
  suggested_cut_price NUMERIC(10,2),
  ricarico_post_cut NUMERIC(6,2),
  ricarico_min_richiesto NUMERIC(6,2),
  matched_rule_name VARCHAR(300),
  -- Stato
  status VARCHAR(20) DEFAULT 'active',
  applied_at TIMESTAMP WITH TIME ZONE,
  dismissed_at TIMESTAMP WITH TIME ZONE,
  dismissed_reason TEXT,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pepite_tenant_status ON pepite_candidates(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pepite_sku ON pepite_candidates(sku);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pepite_tenant_sku_active ON pepite_candidates(tenant_id, sku) WHERE status='active';
