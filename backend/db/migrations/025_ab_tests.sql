-- A/B Test infrastructure per il pricing TP.
--
-- Idea: per SKU in posizione TP 1 con alta CPA (= click/ord rapporto alto),
-- alzare leggermente il prezzo per spostarli a pos 2/3. Se le vendite tengono
-- (≥50% baseline in 24-48h), lo spostamento e' confermato. Altrimenti rollback.

CREATE TABLE IF NOT EXISTS ab_tests (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  product_name TEXT,

  -- Test setup
  test_type VARCHAR(40) NOT NULL DEFAULT 'price_lift_position',
  hypothesis TEXT,

  original_price NUMERIC(10,4) NOT NULL,
  target_price NUMERIC(10,4) NOT NULL,
  original_position INT,
  target_position INT,
  next_competitor_name TEXT,
  next_competitor_price NUMERIC(10,4),

  -- Baseline (snapshot pre-test, 7-14g pre)
  baseline_window_days INT NOT NULL DEFAULT 14,
  baseline_clicks INT NOT NULL DEFAULT 0,
  baseline_orders INT NOT NULL DEFAULT 0,
  baseline_revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  baseline_cpa NUMERIC(8,2),  -- click per order

  -- Test execution
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluation_at TIMESTAMPTZ NOT NULL,        -- when evaluator should check
  expected_end_at TIMESTAMPTZ NOT NULL,      -- max test duration

  -- Test result (popolato dall'evaluator)
  test_clicks INT,
  test_orders INT,
  test_revenue NUMERIC(12,2),
  test_cpa NUMERIC(8,2),

  -- Decision
  status VARCHAR(20) NOT NULL DEFAULT 'pending_apply',
  -- pending_apply = test creato, attende che utente applichi prezzo su Farmabooster
  -- running = prezzo applicato, in test
  -- successful = vendite tenute, test confermato (mantieni prezzo)
  -- rolled_back = vendite cadute, rollback al prezzo originale
  -- inconclusive = dati insufficienti dopo finestra
  -- cancelled = annullato manualmente

  decision_reason TEXT,
  decided_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,  -- quando l'utente ha confermato applicazione FB
  rolled_back_at TIMESTAMPTZ,

  created_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ab_tests_tenant_status ON ab_tests(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_ab_tests_evaluation ON ab_tests(evaluation_at) WHERE status IN ('running', 'pending_apply');
CREATE INDEX IF NOT EXISTS idx_ab_tests_sku ON ab_tests(tenant_id, sku);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ab_tests_active ON ab_tests(tenant_id, sku) WHERE status IN ('pending_apply', 'running');

-- Audit log: ogni evento (start, applied, evaluation_check, rollback_request, confirmed)
CREATE TABLE IF NOT EXISTS ab_test_events (
  id BIGSERIAL PRIMARY KEY,
  test_id BIGINT NOT NULL REFERENCES ab_tests(id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  -- created | applied | checkpoint_24h | rollback_decided | success_decided | rollback_applied | manual_override
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot JSONB,  -- clicks/orders/revenue dell'evento
  note TEXT,
  actor VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_ab_test_events_test ON ab_test_events(test_id, event_at);
