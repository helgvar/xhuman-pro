-- 018: Rule Optimizer
-- Audit settimanale delle regole prezzo Farmabooster per ogni tenant.
-- Salva snapshot KPI per regola + raccomandazioni di modifica (markup, finestra, tolleranza, ecc.).
-- Solo analisi: l'applicazione delle modifiche resta manuale (lato pannello FB) finche'
-- non sara' abilitata l'operativita' diretta.

CREATE TABLE IF NOT EXISTS rule_optimization_runs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  rules_analyzed INTEGER DEFAULT 0,
  recommendations_count INTEGER DEFAULT 0,
  red_count INTEGER DEFAULT 0,
  yellow_count INTEGER DEFAULT 0,
  green_count INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'completed',
  error_message TEXT,
  duration_ms INTEGER,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_runs_tenant_date ON rule_optimization_runs(tenant_id, run_date);
CREATE INDEX IF NOT EXISTS idx_rule_runs_started ON rule_optimization_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS rule_recommendations (
  id BIGSERIAL PRIMARY KEY,
  run_id INTEGER REFERENCES rule_optimization_runs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id VARCHAR(100) NOT NULL,
  rule_name VARCHAR(300),
  rule_type VARCHAR(50),
  severity VARCHAR(10) NOT NULL,           -- red | yellow | green
  category VARCHAR(40),                     -- high_incidence | threshold_risk | low_conversion | low_visibility | top_search_underperform | etc.
  metrics JSONB,                            -- { skus, clicks, cost, revenue, orders, incidence_pct, avg_position, skus_at_threshold, skus_in_quarantine, topsearch_count, ...}
  title TEXT,                               -- Titolo conciso
  recommendation TEXT,                      -- Spiegazione + azione consigliata
  proposed_changes JSONB,                   -- { markup_from, markup_to, window_to, tolerance_to, ... }
  expected_impact JSONB,                    -- { cost_delta_eur, revenue_delta_eur, incidence_delta_pct }
  status VARCHAR(20) DEFAULT 'pending',     -- pending | applied | dismissed | superseded
  applied_at TIMESTAMPTZ,
  applied_by VARCHAR(100),
  dismissed_at TIMESTAMPTZ,
  dismiss_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rule_recs_tenant_status ON rule_recommendations(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_recs_run ON rule_recommendations(run_id);
CREATE INDEX IF NOT EXISTS idx_rule_recs_severity ON rule_recommendations(tenant_id, severity, status) WHERE status = 'pending';
