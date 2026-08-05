-- 049: Mappa dei listing TP visitati dallo scraper FB (da top_results.csv).
-- Scoperta 11/7/2026: il file top_results.csv (~23k listing/passaggio, ogni 4-5h)
-- veniva SCARTATO dal driveScraper: eravamo ciechi sulla copertura reale dello
-- scrape e classificavamo "mai scrappato" ciò che semplicemente non era ancora
-- passato nella rotazione del dettaglio (results.csv, ~7.7k prodotti/file).
CREATE TABLE IF NOT EXISTS scraper_listing_map (
  product_code TEXT PRIMARY KEY,
  tp_url TEXT,
  tp_name TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scraper_listing_map_last_seen ON scraper_listing_map (last_seen);
