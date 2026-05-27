-- Feedback loop sulle recommendation applied: verifica post-apply se l'impatto
-- predetto (expected_impact: cost_delta, revenue_delta) si e' realmente verificato.

ALTER TABLE rule_recommendations
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30),
    -- NULL (non applicabile) | 'pending' (applied <3gg fa, aspetta) | 'on_track' | 'success'
    -- 'deviating' (impatto reale 50-100% peggiore del predetto) | 'failed' (impatto opposto / >100% peggio)
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_impact JSONB,
    -- {cost_delta_eur, revenue_delta_eur, incidence_delta_pp, clicks_delta_pct, orders_delta_pct,
    --  window_pre: {from,to,n_days}, window_post: {from,to,n_days}}
  ADD COLUMN IF NOT EXISTS deviation_pct NUMERIC(8,2),
    -- Quanto l'impatto reale si discosta dal predetto. 0 = on track. >50 = deviazione. 100+ = fallimento.
  ADD COLUMN IF NOT EXISTS correction_proposed TEXT;
    -- Testo libero con suggerimento di azione correttiva (rollback, nuova proposta, monitor)

CREATE INDEX IF NOT EXISTS idx_rule_reco_verif ON rule_recommendations(tenant_id, verification_status)
  WHERE status = 'applied' AND verification_status IS NOT NULL;
