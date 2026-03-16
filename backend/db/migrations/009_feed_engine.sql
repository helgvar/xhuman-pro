-- Migration 009: Feed Decision Engine
-- Tables for feed actions, predictions, quarantine, tracking

-- Feed Actions: current decisions (1 row per product, upserted each cycle)
CREATE TABLE IF NOT EXISTS feed_actions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,

  -- Decision
  action VARCHAR(20) NOT NULL,
  action_reason TEXT NOT NULL DEFAULT '',
  action_source VARCHAR(30) DEFAULT 'engine',

  -- Budget evaluation (Valutazione 1)
  max_click_budget NUMERIC(10,2) DEFAULT 0,
  clicks_consumed INTEGER DEFAULT 0,
  cost_consumed NUMERIC(10,2) DEFAULT 0,
  budget_pct_used NUMERIC(5,2) DEFAULT 0,
  has_conversions BOOLEAN DEFAULT false,
  direct_revenue NUMERIC(12,2) DEFAULT 0,
  indirect_revenue NUMERIC(12,2) DEFAULT 0,

  -- Competitive evaluation (Valutazione 2)
  tp_position INTEGER,
  competitor_count INTEGER DEFAULT 0,
  above_big_players INTEGER DEFAULT 0,
  above_small INTEGER DEFAULT 0,
  shipping_impact NUMERIC(5,2) DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  competitive_viable BOOLEAN DEFAULT true,

  -- Price optimization
  current_price NUMERIC(12,2),
  recommended_price NUMERIC(12,2),
  price_cut_pct NUMERIC(5,2) DEFAULT 0,
  erp_cost NUMERIC(12,2),
  cost_source VARCHAR(10) DEFAULT 'erp',
  new_margin NUMERIC(12,2),
  new_margin_pct NUMERIC(5,2),

  -- Stock & Seasonality
  erp_stock INTEGER DEFAULT 0,
  supplier_stock INTEGER DEFAULT 0,
  stock_source VARCHAR(10) DEFAULT 'none',
  is_seasonal BOOLEAN DEFAULT false,
  season_active BOOLEAN DEFAULT true,

  -- Status
  status VARCHAR(20) DEFAULT 'pending',
  dispatched_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_feed_action_tenant_sku UNIQUE(tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_feed_actions_status ON feed_actions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_feed_actions_action ON feed_actions(tenant_id, action);

-- Feed Action History: every action ever taken, for outcome tracking
CREATE TABLE IF NOT EXISTS feed_action_history (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  action VARCHAR(20) NOT NULL,
  action_reason TEXT,
  action_source VARCHAR(30),
  recommended_price NUMERIC(12,2),
  health_score NUMERIC(5,2),
  classification VARCHAR(20),

  -- Outcome (filled 7 days post-dispatch)
  outcome_status VARCHAR(20) DEFAULT 'pending',
  outcome_clicks_7d INTEGER,
  outcome_orders_7d INTEGER,
  outcome_revenue_7d NUMERIC(12,2),
  outcome_evaluated_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feed_history_sku ON feed_action_history(tenant_id, sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_history_outcome ON feed_action_history(tenant_id, outcome_status);

-- Feed Quarantine: products in cooldown
CREATE TABLE IF NOT EXISTS feed_quarantine (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  reason VARCHAR(50) NOT NULL,
  quarantine_start TIMESTAMPTZ DEFAULT NOW(),
  quarantine_end TIMESTAMPTZ NOT NULL,
  reactivation_check_at TIMESTAMPTZ,
  reactivation_score NUMERIC(5,2),
  reactivated BOOLEAN DEFAULT false,
  reactivated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_quarantine_tenant_sku UNIQUE(tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_quarantine_end ON feed_quarantine(tenant_id, quarantine_end) WHERE reactivated = false;

-- Feed Predictions: AI self-evaluation
CREATE TABLE IF NOT EXISTS feed_predictions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  action VARCHAR(20) NOT NULL,

  -- Predicted values
  predicted_clicks_7d NUMERIC(10,2) DEFAULT 0,
  predicted_orders_7d NUMERIC(10,2) DEFAULT 0,
  predicted_revenue_7d NUMERIC(12,2) DEFAULT 0,
  predicted_savings_7d NUMERIC(12,2) DEFAULT 0,
  confidence NUMERIC(3,2) DEFAULT 0.5,

  -- Timing
  prediction_created_at TIMESTAMPTZ DEFAULT NOW(),
  export_dispatched_at TIMESTAMPTZ,
  prediction_window_days INTEGER DEFAULT 7,
  prediction_expires_at TIMESTAMPTZ,

  -- Actuals (updated every 2h)
  actual_clicks INTEGER DEFAULT 0,
  actual_orders INTEGER DEFAULT 0,
  actual_revenue NUMERIC(12,2) DEFAULT 0,
  actual_savings NUMERIC(12,2) DEFAULT 0,

  -- Status
  status VARCHAR(20) DEFAULT 'active',
  deviation_pct NUMERIC(8,2) DEFAULT 0,

  -- AI correction
  correction_action VARCHAR(20),
  correction_reason TEXT,
  corrected_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_prediction_tenant_sku UNIQUE(tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_predictions_status ON feed_predictions(tenant_id, status);

-- Feed Dispatch Log: external API calls
CREATE TABLE IF NOT EXISTS feed_dispatch_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint VARCHAR(50) NOT NULL,
  products_served INTEGER DEFAULT 0,
  request_ip INET,
  dispatched_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default feed config for existing tenants
INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_monthly_budget', '3500', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_monthly_budget'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_margin_brackets', '[{"min":0,"max":1,"maxClicks":1},{"min":1,"max":3,"maxClicks":2},{"min":3,"max":5,"maxClicks":3},{"min":5,"max":10,"maxClicks":4},{"min":10,"max":15,"maxClicks":5},{"min":15,"max":25,"maxClicks":8},{"min":25,"max":50,"maxClicks":13},{"min":50,"max":999,"maxClicks":18}]', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_margin_brackets'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_big_player_merchants', '["Amazon","DocPeter","Farmacia Loreto","1000Farmacie","Farmacia Fatigato","Amicafarmacia","Dr. Max","Farmaè"]', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_big_player_merchants'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_pepite_pct', '0.80', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_pepite_pct'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_reactivation_interval_days', '3', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_reactivation_interval_days'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_reactivation_min_demand_score', '3', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_reactivation_min_demand_score'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_min_margin_pct', '8', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_min_margin_pct'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_min_margin_eur', '0.50', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_min_margin_eur'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_quarantine_days_budget', '30', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_quarantine_days_budget'
);

INSERT INTO health_config (tenant_id, config_key, config_value, updated_at)
SELECT t.id, 'feed_quarantine_days_stock', '7', NOW()
FROM tenants t WHERE NOT EXISTS (
  SELECT 1 FROM health_config WHERE tenant_id = t.id AND config_key = 'feed_quarantine_days_stock'
);
