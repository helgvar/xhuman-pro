-- 098: indice su scraper_competitors(scraped_at)
--
-- Dal 11/8 lo scraper consegna file piccoli a flusso quasi continuo e la
-- sentinella consegne (scraperDeliveryWatch v2) giudica sulle finestre di
-- data: MAX(scraped_at) e copertura rotante 24h, ogni ora. Senza indice su
-- scraped_at da solo ogni check era una scansione completa della tabella
-- (~1,5M righe). Creato CONCURRENTLY a mano in produzione il 12/8/2026;
-- qui la forma idempotente per gli altri ambienti.

CREATE INDEX IF NOT EXISTS idx_scraper_comp_scraped
  ON scraper_competitors (scraped_at);

INSERT INTO schema_migrations (filename)
VALUES ('098_scraper_scraped_at_indice.sql')
ON CONFLICT DO NOTHING;
