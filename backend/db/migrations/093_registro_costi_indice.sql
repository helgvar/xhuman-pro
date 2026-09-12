-- 093 — Registro costi: indice per il confronto col gradino precedente
--
-- 6/8/2026. Da oggi ogni sync prodotti fissa in product_cost_history il costo
-- del giorno, ma SOLO quando cambia (funzione a gradini). Per decidere se e'
-- cambiato serve leggere l'ultimo gradino di ogni (sku, source): un DISTINCT ON
-- ordinato per data DESC.
--
-- La chiave primaria e' (tenant_id, sku, data, source): la data viene prima
-- della source, quindi non serve a quell'ordinamento e Postgres finirebbe a
-- ordinare in memoria l'intera storia del tenant a ogni sync.
--
-- Questo indice mette le colonne nell'ordine giusto e la data in DESC, cosi'
-- l'ultimo gradino e' la prima riga letta.

CREATE INDEX IF NOT EXISTS idx_pch_gradino
  ON product_cost_history (tenant_id, sku, source, data DESC);

INSERT INTO schema_migrations (filename)
VALUES ('093_registro_costi_indice.sql')
ON CONFLICT DO NOTHING;
