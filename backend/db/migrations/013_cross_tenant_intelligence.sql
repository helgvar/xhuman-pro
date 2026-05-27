-- Cross-tenant product intelligence
-- Weekly analysis: identifies products that are consistently star or burner across tenants

CREATE TABLE IF NOT EXISTS cross_tenant_products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) NOT NULL UNIQUE,
  product_name TEXT,
  category VARCHAR(200),
  brand VARCHAR(200),

  -- Presence across tenants
  tenant_count INTEGER NOT NULL DEFAULT 0,          -- how many tenants have this product
  tenants_with_clicks INTEGER NOT NULL DEFAULT 0,   -- how many tenants got TP clicks for it
  tenants_with_orders INTEGER NOT NULL DEFAULT 0,   -- how many tenants got orders for it

  -- Aggregated classification
  star_count INTEGER NOT NULL DEFAULT 0,
  cash_cow_count INTEGER NOT NULL DEFAULT 0,
  burner_count INTEGER NOT NULL DEFAULT 0,
  zombie_count INTEGER NOT NULL DEFAULT 0,
  opportunity_count INTEGER NOT NULL DEFAULT 0,

  -- Cross-tenant verdict
  -- 'universal_star': star/cash_cow in majority of tenants
  -- 'universal_burner': burner in majority of tenants, 0 orders everywhere
  -- 'mixed': different classification across tenants
  -- 'insufficient_data': not enough tenants for verdict
  verdict VARCHAR(30) NOT NULL DEFAULT 'insufficient_data',

  -- Aggregated metrics (summed across tenants)
  total_clicks_30d INTEGER NOT NULL DEFAULT 0,
  total_orders_30d INTEGER NOT NULL DEFAULT 0,
  total_revenue_30d NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_click_cost_30d NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_cost_incidence NUMERIC(6,2),                  -- average incidence across converting tenants
  avg_margin_pct NUMERIC(6,2),

  -- Competitive snapshot (best across tenants)
  best_sell_price NUMERIC(10,2),
  worst_sell_price NUMERIC(10,2),
  scraper_best_price NUMERIC(10,2),
  avg_scraper_position NUMERIC(5,1),

  -- Timestamps
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cross_tenant_verdict ON cross_tenant_products(verdict);
CREATE INDEX IF NOT EXISTS idx_cross_tenant_sku ON cross_tenant_products(sku);

-- Detail table: per-tenant breakdown for each cross-tenant product
CREATE TABLE IF NOT EXISTS cross_tenant_product_details (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tenant_name VARCHAR(100),
  classification VARCHAR(20),
  clicks_30d INTEGER DEFAULT 0,
  orders_30d INTEGER DEFAULT 0,
  revenue_30d NUMERIC(12,2) DEFAULT 0,
  click_cost_30d NUMERIC(12,2) DEFAULT 0,
  cost_incidence NUMERIC(6,2),
  sell_price NUMERIC(10,2),
  margin_pct NUMERIC(6,2),
  scraper_position INTEGER,
  is_civetta BOOLEAN DEFAULT false,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(sku, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_cross_detail_sku ON cross_tenant_product_details(sku);
