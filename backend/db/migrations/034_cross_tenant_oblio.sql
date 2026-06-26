-- OBLIO: prodotti burner cross-tenant (click >2 tenant + 0 vendite ovunque).
-- Cron giovedì popola top 50, daily check rilascia SKU che hanno venduto.
CREATE TABLE IF NOT EXISTS cross_tenant_oblio (
  id BIGSERIAL PRIMARY KEY,
  sku VARCHAR(100) NOT NULL,
  product_name VARCHAR(500),
  brand VARCHAR(200),
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  added_reason TEXT,
  tenants_affected INT DEFAULT 0,
  click_at_add INT DEFAULT 0,
  cost_at_add NUMERIC(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active', -- active, released
  released_at TIMESTAMP WITH TIME ZONE,
  released_reason TEXT,
  last_check_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (sku, status) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_oblio_status ON cross_tenant_oblio(status);
CREATE INDEX IF NOT EXISTS idx_oblio_sku ON cross_tenant_oblio(sku);
