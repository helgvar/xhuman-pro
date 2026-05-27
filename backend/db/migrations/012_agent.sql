-- Agent: sessioni chat, messaggi, azioni, regole per tenant

-- Sessioni di conversazione (recuperabili per 90gg)
CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  title VARCHAR(200),
  status VARCHAR(20) DEFAULT 'active',
  messages_count INTEGER DEFAULT 0,
  actions_executed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_tenant ON agent_sessions(tenant_id, last_message_at DESC);

-- Messaggi dentro le sessioni
CREATE TABLE IF NOT EXISTS agent_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_results JSONB,
  actions_taken JSONB,
  tokens_used INTEGER,
  model VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, created_at);

-- Log di TUTTE le azioni eseguite dall'agent
CREATE TABLE IF NOT EXISTS agent_actions_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id UUID REFERENCES agent_sessions(id),
  user_id INTEGER,
  action_type VARCHAR(50) NOT NULL,
  action_data JSONB NOT NULL,
  safety_level VARCHAR(20) NOT NULL DEFAULT 'safe',
  password_required BOOLEAN DEFAULT false,
  status VARCHAR(20) DEFAULT 'pending',
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  executed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_tenant ON agent_actions_log(tenant_id, created_at DESC);

-- Regole permanenti per tenant (rispettate dal feed engine ad ogni ciclo)
CREATE TABLE IF NOT EXISTS agent_tenant_rules (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_type VARCHAR(50) NOT NULL,
  rule_config JSONB NOT NULL,
  reason TEXT,
  created_by INTEGER,
  session_id UUID REFERENCES agent_sessions(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_rules_tenant ON agent_tenant_rules(tenant_id, is_active);

-- Pending actions (azioni in attesa di conferma/password)
CREATE TABLE IF NOT EXISTS agent_pending_actions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id UUID REFERENCES agent_sessions(id),
  action_type VARCHAR(50) NOT NULL,
  action_data JSONB NOT NULL,
  safety_level VARCHAR(20) NOT NULL,
  reason TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  confirmed_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_pending_tenant ON agent_pending_actions(tenant_id, status);
