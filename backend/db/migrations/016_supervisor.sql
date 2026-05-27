-- 016: Supervisor Agent
-- Audit periodico (ogni 2h) della salute operativa del feed per ogni tenant.
-- Fast path SQL → Slow path LLM (Sonnet 4.6) → Weekly deep review (Opus 4.7).

-- Esecuzioni del supervisor (una riga per ogni run, per ogni tenant)
CREATE TABLE IF NOT EXISTS supervisor_runs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_type VARCHAR(20) NOT NULL,           -- 'fast', 'slow', 'weekly'
  model_used VARCHAR(60),                   -- 'sonnet-4-6' / 'opus-4-7' / null per fast
  trigger_reason TEXT,                      -- perche e' partito (es. "fast_path_flagged: 2 yellow, 1 red")
  fast_path_signals JSONB,                  -- output strutturato delle SQL check
  llm_summary TEXT,                         -- riassunto del verdict LLM
  findings_count INTEGER DEFAULT 0,
  red_count INTEGER DEFAULT 0,
  yellow_count INTEGER DEFAULT 0,
  tokens_input INTEGER DEFAULT 0,
  tokens_cached INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  cost_usd NUMERIC(10,5) DEFAULT 0,
  duration_ms INTEGER,
  status VARCHAR(20) DEFAULT 'completed',   -- 'completed' | 'failed' | 'running'
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_supervisor_runs_tenant_started ON supervisor_runs(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervisor_runs_type ON supervisor_runs(run_type, started_at DESC);

-- Findings (problemi rilevati). Anti-rumore: un finding aperto per (tenant, fingerprint).
CREATE TABLE IF NOT EXISTS supervisor_findings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id BIGINT REFERENCES supervisor_runs(id) ON DELETE SET NULL,
  fingerprint VARCHAR(120) NOT NULL,        -- hash di category+key (per dedup)
  severity VARCHAR(10) NOT NULL,            -- 'red' | 'yellow' | 'green'
  category VARCHAR(40) NOT NULL,            -- 'cron_loop' | 'kpi_anomaly' | 'data_health' | 'action_followup' | 'budget_pacing' | 'business'
  title TEXT NOT NULL,
  description TEXT,
  evidence JSONB,                           -- dati strutturati a sostegno
  recommended_action TEXT,
  auto_remediable BOOLEAN DEFAULT false,
  occurrence_count INTEGER DEFAULT 1,       -- aumenta se viene flaggato in run successivi
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(100),
  resolution_note TEXT,
  silenced_until TIMESTAMPTZ                -- per anti-rumore: nascondi fino a data
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supervisor_findings_open ON supervisor_findings(tenant_id, fingerprint) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_supervisor_findings_tenant_sev ON supervisor_findings(tenant_id, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervisor_findings_open ON supervisor_findings(tenant_id, last_seen_at DESC) WHERE resolved_at IS NULL;

-- Follow-up sulle azioni del feedEngine (REMOVE / PRICE_CUT) per misurarne l'efficacia.
CREATE TABLE IF NOT EXISTS supervisor_action_followups (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  action_type VARCHAR(40) NOT NULL,         -- 'REMOVE' | 'PRICE_CUT' | 'ADD'
  action_taken_at TIMESTAMPTZ NOT NULL,
  action_reason TEXT,
  baseline_clicks_7d INTEGER,
  baseline_cost_7d NUMERIC(10,2),
  baseline_orders_7d INTEGER,
  baseline_revenue_7d NUMERIC(10,2),
  followup_clicks_7d INTEGER,
  followup_cost_7d NUMERIC(10,2),
  followup_orders_7d INTEGER,
  followup_revenue_7d NUMERIC(10,2),
  outcome VARCHAR(20),                       -- 'effective' | 'noop' | 'reverted' | 'pending'
  outcome_note TEXT,
  evaluated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_supervisor_followups_tenant ON supervisor_action_followups(tenant_id, action_taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_supervisor_followups_pending ON supervisor_action_followups(tenant_id, evaluated_at) WHERE evaluated_at IS NULL;
