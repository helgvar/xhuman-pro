-- 095 — Registro dei file scraper gia' ingeriti (ordine capo 11/08/2026 sera).
--
-- Cambio di scarico: il fornitore non consegna piu' un file gigante ogni 4-5
-- ore ma file piccoli (~2.000 prodotti) ogni 15 minuti, e ha aggiunto due nomi
-- nuovi (hot_results.csv, hot_changes.csv). Il poller vecchio prendeva "gli
-- ultimi 2 file per tipo" a ogni giro: con una consegna ogni 15 minuti e un
-- giro ogni ora, i file in mezzo non li vedeva NESSUNO.
--
-- Da qui in poi si ragiona per FILE, non per finestra: ogni file visto una
-- volta sola, e nessuno saltato. La chiave e' l'id Drive; se il fornitore
-- sovrascrive lo stesso file (stesso id, modified_time nuovo) va rielaborato,
-- quindi il confronto e' su (file_id, modified_time).

CREATE TABLE IF NOT EXISTS scraper_files_seen (
  file_id       TEXT PRIMARY KEY,
  file_name     TEXT        NOT NULL,
  created_time  TIMESTAMPTZ,
  modified_time TIMESTAMPTZ,
  size_bytes    BIGINT,
  rows_parsed   INTEGER,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scraper_files_seen_processed
  ON scraper_files_seen (processed_at DESC);

-- Correzione una tantum del fuso: i timestamp gia' in tabella sono ora di
-- Bucarest salvata come UTC, quindi 3 ore avanti (319.426 righe risultavano
-- addirittura nel FUTURO). Tutto lo storico in retention (dall'11/07) viene
-- dalla stessa sorgente e cade in ora legale, quindi lo scarto e' costante.
-- Va fatto PRIMA che il codice nuovo inizi a scrivere ore giuste: senza,
-- la guardia anti-regressione (EXCLUDED.scraped_at >= attuale) scarterebbe
-- per tre ore i dati freschi credendoli vecchi.
UPDATE scraper_competitors SET scraped_at = scraped_at - INTERVAL '3 hours';
UPDATE scraper_listing_map
   SET first_seen = first_seen - INTERVAL '3 hours',
       last_seen  = last_seen  - INTERVAL '3 hours';

INSERT INTO schema_migrations (filename)
VALUES ('095_scraper_files_seen.sql')
ON CONFLICT DO NOTHING;
