-- Google Ads schema (campaigns, daily metrics, sync runs).
-- In attesa del developer token Basic Access da Google.
-- Quando il token arriva, valorizzato in global_config.google_ads_developer_token,
-- e configurato google_ads_customer_id per ciascun tenant in tenant_configs,
-- il servizio backend/services/googleAds.js (scheletro) si attiva.

-- Anagrafica campagne. Una row per campaign_id (rimpiazza in upsert).
CREATE TABLE IF NOT EXISTS google_ads_campaigns (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      VARCHAR(20) NOT NULL,            -- Google Ads customer (CID, senza '-')
  campaign_id      VARCHAR(30) NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  campaign_type    VARCHAR(30) NOT NULL DEFAULT '', -- SHOPPING | PERFORMANCE_MAX | SEARCH | DISPLAY | VIDEO
  channel_subtype  VARCHAR(30) DEFAULT '',          -- SHOPPING_SMART_ADS etc
  status           VARCHAR(20) NOT NULL DEFAULT '', -- ENABLED | PAUSED | REMOVED
  bidding_strategy VARCHAR(40) DEFAULT '',          -- MAXIMIZE_CONVERSION_VALUE | TARGET_ROAS | MANUAL_CPC | ...
  target_roas      NUMERIC(8,4),                    -- es. 4.0 = 400%
  target_cpa_micros BIGINT,                         -- micros (1/1.000.000 EUR)
  budget_micros    BIGINT,                          -- daily budget in micros
  start_date       DATE,
  end_date         DATE,
  raw_data         JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, customer_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_ga_campaigns_tenant_status
  ON google_ads_campaigns (tenant_id, status);

-- Performance giornaliera per campagna (serie storica).
CREATE TABLE IF NOT EXISTS google_ads_campaign_daily (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      VARCHAR(20) NOT NULL,
  campaign_id      VARCHAR(30) NOT NULL,
  report_date      DATE NOT NULL,
  impressions      INTEGER NOT NULL DEFAULT 0,
  clicks           INTEGER NOT NULL DEFAULT 0,
  cost_micros      BIGINT NOT NULL DEFAULT 0,
  conversions      NUMERIC(10,2) NOT NULL DEFAULT 0,
  conversion_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  view_through_conv NUMERIC(10,2) NOT NULL DEFAULT 0,
  search_impression_share NUMERIC(8,6),  -- 0..1, NULL se non disponibile
  search_top_impression_share NUMERIC(8,6),
  search_budget_lost_is NUMERIC(8,6),    -- impression share persa per budget
  search_rank_lost_is NUMERIC(8,6),      -- impression share persa per rank/bid
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, customer_id, campaign_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_ga_campaign_daily_lookup
  ON google_ads_campaign_daily (tenant_id, report_date DESC);

-- Performance giornaliera per SKU (shopping_performance_view-style).
-- offer_id = SKU del feed Merchant Center.
CREATE TABLE IF NOT EXISTS google_ads_product_daily (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      VARCHAR(20) NOT NULL,
  campaign_id      VARCHAR(30) NOT NULL,
  offer_id         VARCHAR(50) NOT NULL,            -- = SKU
  report_date      DATE NOT NULL,
  impressions      INTEGER NOT NULL DEFAULT 0,
  clicks           INTEGER NOT NULL DEFAULT 0,
  cost_micros      BIGINT NOT NULL DEFAULT 0,
  conversions      NUMERIC(10,2) NOT NULL DEFAULT 0,
  conversion_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, customer_id, campaign_id, offer_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_ga_product_daily_sku
  ON google_ads_product_daily (tenant_id, offer_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_ga_product_daily_campaign
  ON google_ads_product_daily (tenant_id, campaign_id, report_date DESC);

-- Log run del sync (analogo a merchant_center_runs).
CREATE TABLE IF NOT EXISTS google_ads_runs (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_type         VARCHAR(30) NOT NULL DEFAULT 'full', -- full | incremental
  status           VARCHAR(20) NOT NULL DEFAULT 'pending', -- running | completed | failed | skipped_no_token
  campaigns_count  INTEGER DEFAULT 0,
  campaign_days    INTEGER DEFAULT 0,
  product_rows     INTEGER DEFAULT 0,
  error_message    TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ga_runs_tenant_started
  ON google_ads_runs (tenant_id, started_at DESC);
