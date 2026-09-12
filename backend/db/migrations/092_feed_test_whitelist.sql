-- 092: whitelist forzata + log per i test di feed a tempo.
--
-- Ordine capo 5/8/2026: giovedì 6 agosto, dalle 00:00 alle 00:15 del 7,
-- SOLO su Papa il feed civetta=1 deve contenere unicamente i prodotti che
-- hanno generato fatturato negli ultimi 90 giorni. Nessun altro tenant va
-- toccato. Alle 00:15 del 7 si torna esattamente com'era.
--
-- Meccanica: health_config.feed_forced_whitelist = <test_label> con expires_at.
-- recalculateStableCache legge il flag e RESTRINGE feedCodes alla whitelist.
-- Alla scadenza il flag muore da solo e il feed torna alle regole normali.
-- La lista è congelata qui dentro: non si ricalcola a ogni build, così il
-- test misura sempre lo stesso insieme e resta verificabile a posteriori.

CREATE TABLE IF NOT EXISTS feed_test_whitelist (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  test_label  VARCHAR(64) NOT NULL,
  sku         VARCHAR(50) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, test_label, sku)
);

CREATE INDEX IF NOT EXISTS idx_ftw_tenant_label
  ON feed_test_whitelist (tenant_id, test_label);

-- Log del test: una riga ogni 2 ore con click e ordini CUMULATI del giorno.
-- I click di zombie_clicks vengono sovrascritti a ogni fetch (UPSERT sulla
-- coppia tenant+fetch_date): senza questo snapshot la curva oraria si perde.
CREATE TABLE IF NOT EXISTS feed_test_log (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  test_label   VARCHAR(64) NOT NULL,
  logged_at    TIMESTAMPTZ DEFAULT NOW(),
  phase        VARCHAR(20),          -- 'pre' | 'test' | 'post'
  feed_size    INTEGER,              -- civetta=1 serviti in quel momento
  clicks_cum   INTEGER,              -- click del giorno fino a quell'ora
  orders_cum   INTEGER,
  revenue_cum  NUMERIC(12,2),
  baseline     JSONB,                -- stessi cumulati sui giovedì precedenti
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_ftl_tenant_label
  ON feed_test_log (tenant_id, test_label, logged_at);

INSERT INTO schema_migrations (filename)
VALUES ('092_feed_test_whitelist.sql')
ON CONFLICT DO NOTHING;
