-- Coorti di attivazione: ogni batch di SKU attivati (ADD/pepite/transfer)
-- viene registrato qui al momento dell'attivazione, così la misurazione
-- a 24-48h (regola gradualità) non dipende da products.updated_at che
-- viene toccato dai sync. Cfr. lezione coorte 215 Procaccini del 2/7.
CREATE TABLE IF NOT EXISTS activation_cohorts (
  id BIGSERIAL PRIMARY KEY,
  cohort_name VARCHAR(100) NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  activated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- snapshot al momento dell'attivazione per confronti puliti
  sell_price NUMERIC(10,2),
  ricarico_pct NUMERIC(10,2),
  scraper_position INT,
  erp_stock INT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_cohorts_name ON activation_cohorts(cohort_name);
CREATE INDEX IF NOT EXISTS idx_cohorts_tenant_sku ON activation_cohorts(tenant_id, sku);
