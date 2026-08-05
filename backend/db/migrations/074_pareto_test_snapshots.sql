-- 074_pareto_test_snapshots.sql
-- Monitor supplementare del TEST Pareto Positioning (capo 24/7): fotografa a ogni
-- giro costo vero, baseline, prezzo-PC, margine, posizione e flag di rischio per
-- ogni PC pareto_positioning attivo. Serve a capire, su 2 giorni, cosa succede ai
-- COSTI (switch magazzino→grossista) e alla tenuta del margine.
CREATE TABLE IF NOT EXISTS pareto_test_snapshots (
  id            bigserial PRIMARY KEY,
  captured_at   timestamptz NOT NULL DEFAULT NOW(),
  tenant_id     uuid    NOT NULL,
  sku           varchar NOT NULL,
  costo_now     numeric,
  baseline_cost numeric,
  recommended_price numeric,
  margin_pct    numeric,
  floor_pct     numeric,
  scraper_position int,
  fonte         text,
  sotto_costo   boolean,
  sotto_floor   boolean,
  cost_rise     boolean
);
CREATE INDEX IF NOT EXISTS idx_pts_sku_ts ON pareto_test_snapshots (sku, captured_at);
CREATE INDEX IF NOT EXISTS idx_pts_ts ON pareto_test_snapshots (captured_at);

INSERT INTO schema_migrations (filename) VALUES ('074_pareto_test_snapshots.sql')
  ON CONFLICT DO NOTHING;
