-- Log Events: log strutturato persistente per debug post-mortem.
-- Sostituisce/affianca console.log/error che spariscono al restart container.

CREATE TABLE IF NOT EXISTS log_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level VARCHAR(10) NOT NULL,
  source VARCHAR(80),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  trace_id UUID,
  message TEXT NOT NULL,
  payload JSONB,
  stack TEXT,
  hostname VARCHAR(80),
  process_uptime_sec INTEGER
);

CREATE INDEX IF NOT EXISTS idx_log_events_ts ON log_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_log_events_level_ts ON log_events(level, ts DESC);
CREATE INDEX IF NOT EXISTS idx_log_events_source_ts ON log_events(source, ts DESC);
CREATE INDEX IF NOT EXISTS idx_log_events_tenant_ts ON log_events(tenant_id, ts DESC) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_log_events_trace ON log_events(trace_id) WHERE trace_id IS NOT NULL;

-- Auto-cleanup table function: cancella log > retention_days (default 30gg)
-- Chiamato dal cron daily nella pipeline.
CREATE OR REPLACE FUNCTION prune_log_events(retention_days INT DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM log_events WHERE ts < NOW() - (retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;
