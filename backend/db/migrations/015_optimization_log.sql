-- 015: Optimization Change Log
-- Traccia ogni modifica applicata al feed con snapshot KPI del momento

CREATE TABLE IF NOT EXISTS optimization_log (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action_type VARCHAR(50) NOT NULL, -- push_converter, category_rule, quarantine_reset, price_cut_gold, etc.
  description TEXT NOT NULL,
  -- Snapshot KPI al momento della modifica
  snapshot_clicks INTEGER,
  snapshot_click_cost NUMERIC(12,2),
  snapshot_revenue NUMERIC(12,2),
  snapshot_orders INTEGER,
  snapshot_incidence NUMERIC(8,2),
  snapshot_avg_daily_cost NUMERIC(10,2),
  snapshot_products_in_feed INTEGER,
  snapshot_products_removed INTEGER,
  snapshot_price_cuts INTEGER,
  -- Dettaglio modifica
  products_affected INTEGER DEFAULT 0,
  skus_affected TEXT[], -- array di SKU coinvolti
  metadata JSONB, -- dati extra specifici per tipo azione
  created_by VARCHAR(100) DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_opt_log_tenant_date ON optimization_log(tenant_id, action_date DESC);
