-- AI in modalita' "audit only": Claude analizza ogni run del feed engine
-- e propone suggerimenti senza agire automaticamente. L'utente revisiona
-- e approva/rigetta manualmente. Step 1 verso AI actionable.
CREATE TABLE IF NOT EXISTS ai_audit_suggestions (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity      VARCHAR(10) NOT NULL CHECK (severity IN ('low','medium','high')),
  category      VARCHAR(50),         -- spesa, fatturato, conversion, killer, magazzino, briglie
  title         TEXT NOT NULL,
  description   TEXT,
  suggested_actions JSONB,           -- array di { type, target, params, reasoning }
  context_snapshot JSONB,            -- snapshot KPI passato a Claude
  ai_model      VARCHAR(50),         -- es. claude-sonnet-4-5
  ai_tokens_in  INT,
  ai_tokens_out INT,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','applied','expired')),
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   VARCHAR(100),
  applied_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_tenant_status ON ai_audit_suggestions(tenant_id, status, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_audit_severity_pending ON ai_audit_suggestions(severity, run_at DESC) WHERE status='pending';
