-- 014: Optimization Modules
-- 4 moduli indipendenti attivabili per tenant:
-- 1. Category Rules (regole per categoria TP)
-- 2. Feed Cap (limite prodotti nel feed con priorita)
-- 5. Competitor Gap Analysis (snapshot competitor giornaliero)
-- 8. Optimal Position Analysis (posizione ottimale per ROI)

-- Module 5: Competitor daily snapshots
CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_code VARCHAR(50) NOT NULL,
  snapshot_date DATE NOT NULL,
  merchant_count INTEGER DEFAULT 0,
  best_price NUMERIC(10,2),
  avg_price NUMERIC(10,2),
  our_position INTEGER,
  our_price NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, product_code, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_comp_snap_tenant_date ON competitor_snapshots(tenant_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_comp_snap_product ON competitor_snapshots(tenant_id, product_code);

-- Module 8: Position performance analysis
CREATE TABLE IF NOT EXISTS position_performance (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_code VARCHAR(50) NOT NULL,
  analysis_date DATE NOT NULL,
  -- Per-bracket data (bracket 1=pos1, 2=pos2, 3=pos3, 4=pos4-5, 5=pos6+)
  pos1_days INTEGER DEFAULT 0,
  pos1_clicks INTEGER DEFAULT 0,
  pos2_days INTEGER DEFAULT 0,
  pos2_clicks INTEGER DEFAULT 0,
  pos3_days INTEGER DEFAULT 0,
  pos3_clicks INTEGER DEFAULT 0,
  pos4_days INTEGER DEFAULT 0,
  pos4_clicks INTEGER DEFAULT 0,
  pos5_days INTEGER DEFAULT 0,
  pos5_clicks INTEGER DEFAULT 0,
  -- Conversion data (from health scores, not per-bracket)
  total_orders INTEGER DEFAULT 0,
  total_revenue NUMERIC(12,2) DEFAULT 0,
  total_click_cost NUMERIC(12,2) DEFAULT 0,
  -- Result
  optimal_position INTEGER,
  optimal_reason TEXT,
  recommended_price NUMERIC(10,2),
  current_position INTEGER,
  current_price NUMERIC(10,2),
  potential_savings NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, product_code, analysis_date)
);
CREATE INDEX IF NOT EXISTS idx_pos_perf_tenant ON position_performance(tenant_id, analysis_date DESC);

-- Seed config flags (disabled by default) for all existing tenants
INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, cfg.key, cfg.value, NOW()
FROM tenants t
CROSS JOIN (VALUES
  ('feed_category_rules_enabled', 'false'),
  ('feed_category_rules', '{}'),
  ('feed_cap_enabled', 'false'),
  ('feed_cap_max', '25000'),
  ('feed_competitor_analysis_enabled', 'false'),
  ('feed_position_analysis_enabled', 'false')
) AS cfg(key, value)
WHERE EXISTS (SELECT 1 FROM products WHERE tenant_id = t.id)
ON CONFLICT (tenant_id, config_key) DO NOTHING;
