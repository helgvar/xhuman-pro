-- Scraper competitors data (from Google Drive CSV)
-- Global data shared across all tenants

CREATE TABLE IF NOT EXISTS scraper_competitors (
  id BIGSERIAL PRIMARY KEY,
  product_code VARCHAR(20) NOT NULL,
  merchant VARCHAR(200) NOT NULL,
  position INTEGER DEFAULT 99,
  base_price NUMERIC(10,2) DEFAULT 0,
  shipping_cost NUMERIC(10,2) DEFAULT 0,
  total_price NUMERIC(10,2) DEFAULT 0,
  reviews INTEGER DEFAULT 0,
  source VARCHAR(100) DEFAULT '',
  scraped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scraper_comp_code_merchant
  ON scraper_competitors(product_code, merchant);

CREATE INDEX IF NOT EXISTS idx_scraper_comp_code
  ON scraper_competitors(product_code);

CREATE INDEX IF NOT EXISTS idx_scraper_comp_updated
  ON scraper_competitors(updated_at);

-- Scraper refresh log
CREATE TABLE IF NOT EXISTS scraper_refresh_log (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(20) DEFAULT 'drive',
  files_processed INTEGER DEFAULT 0,
  products_count INTEGER DEFAULT 0,
  entries_count INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'completed',
  error_message TEXT
);
