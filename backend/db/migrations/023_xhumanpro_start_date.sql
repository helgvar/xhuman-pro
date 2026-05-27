-- Track when each tenant started using xHumanPro (= day of first real action).
-- Used as baseline cutoff for "pre-xHumanPro" vs "post" margin comparisons.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS xhumanpro_start_date DATE;

-- Backfill from observed first actions (whichever happened earliest per tenant).
UPDATE tenants t SET xhumanpro_start_date = LEAST(
  COALESCE((SELECT MIN(quarantine_start)::date FROM feed_quarantine fq WHERE fq.tenant_id = t.id), '9999-01-01'::date),
  COALESCE((SELECT MIN(detected_at)::date    FROM feed_killers fk     WHERE fk.tenant_id = t.id), '9999-01-01'::date),
  COALESCE((SELECT MIN(applied_at)::date     FROM rule_recommendations rr WHERE rr.tenant_id = t.id AND rr.status='applied'), '9999-01-01'::date)
)
WHERE t.xhumanpro_start_date IS NULL;

-- Clear sentinel (9999-01-01) for tenants that had no action yet.
UPDATE tenants SET xhumanpro_start_date = NULL WHERE xhumanpro_start_date = '9999-01-01'::date;
