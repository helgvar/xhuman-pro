-- =============================================================================
-- 117 — IL CANE DA GUARDIA DEI LOOP
--
-- Ordine capo 10/09: "crea un monitor che controlla ogni ora tutti i loop e
-- sblocca quelli bloccati."
--
-- Il fatto che l'ha provocato: 5 products_sync fermi in stato running/pending da
-- 14-25 giorni (Mandanici 612h, Farmacri 488h e 364h, Papa 340h, SubitoFarma
-- 339h). Nessuno li chiude: farmaboosterProducts.js e magentoOrders.js scrivono
-- 'completed'/'failed' solo dentro il proprio ciclo, e quei processi sono morti
-- col container settimane fa. La riga resta 'running' per sempre.
--
-- Misurato il 10/09: NON bloccavano i sync nuovi (tutti gli 8 tenant
-- sincronizzati entro l'ora). Ma avvelenano ogni lettura di "c'e' un sync in
-- volo?" — compresa quella che decide se si puo' fare un restart.
--
-- Durata sana misurata su 30 giorni:
--   products_sync : 3.523 giri, media 8,7 min, p95 10,8 min, max 45,4 min
--   orders_sync   : 7.000 giri, media 0,2 min, p95 1,2 min,  max  2,9 min
-- Da qui le soglie del cane da guardia: 90 min per products_sync (il doppio del
-- massimo mai visto), 30 min per orders_sync (dieci volte il massimo), 180 min
-- per un tipo sconosciuto. Larghe apposta: il cane morde solo i morti veri.
-- =============================================================================

-- 1) IL BATTITO — una riga per loop, scritta dal loop stesso mentre gira.
--    Riempita da services/loopHeartbeat.js, che avvolge setInterval/setTimeout
--    per ogni schedulazione da 60 secondi in su. Niente da patchare nei 102
--    file di services: il battito si attacca da solo.
CREATE TABLE IF NOT EXISTS loop_heartbeat (
  loop_name      text        PRIMARY KEY,
  ultimo_battito timestamptz NOT NULL DEFAULT NOW(),
  primo_battito  timestamptz NOT NULL DEFAULT NOW(),
  cadenza_ms     bigint,
  battiti        bigint      NOT NULL DEFAULT 0
);

COMMENT ON TABLE  loop_heartbeat IS 'Battito dei loop. cadenza_ms = ultimo ritardo schedulato. Un loop e'' fermo se ultimo_battito e'' piu'' vecchio di 3 cadenze.';
COMMENT ON COLUMN loop_heartbeat.cadenza_ms IS 'Ultimo ritardo passato a setInterval/setTimeout. Variabile per i loop che puntano a un orario fisso.';

-- 2) IL REGISTRO — cosa ha trovato il cane e cosa ha fatto. Sempre scritto:
--    uno sblocco senza motivo scritto e'' uno sblocco che nessuno puo'' verificare.
CREATE TABLE IF NOT EXISTS loop_watchdog_log (
  id          bigserial   PRIMARY KEY,
  rilevato_il timestamptz NOT NULL DEFAULT NOW(),
  tipo        text        NOT NULL,   -- job_zombie | loop_fermo | sessione_appesa
  bersaglio   text        NOT NULL,   -- id job | nome loop | pid
  dettaglio   text,
  azione      text        NOT NULL    -- sbloccato | segnalato
);

CREATE INDEX IF NOT EXISTS idx_loop_watchdog_log_quando
  ON loop_watchdog_log (rilevato_il DESC);
CREATE INDEX IF NOT EXISTS idx_loop_watchdog_log_tipo
  ON loop_watchdog_log (tipo, rilevato_il DESC);

COMMENT ON TABLE loop_watchdog_log IS 'Registro del cane da guardia (mig 117). Ordine capo 10/09.';

-- 3) LA VISTA DEL CAPO — un colpo d'occhio su chi batte e chi no.
CREATE OR REPLACE VIEW v_loop_stato AS
SELECT h.loop_name                                                       AS loop,
       round(h.cadenza_ms / 60000.0, 1)                                  AS cadenza_min,
       h.ultimo_battito AT TIME ZONE 'Europe/Rome'                       AS ultimo_battito,
       round(EXTRACT(EPOCH FROM (NOW() - h.ultimo_battito)) / 60.0)      AS fermo_da_min,
       h.battiti,
       CASE
         WHEN h.cadenza_ms IS NULL                                                    THEN 'cadenza ignota'
         WHEN h.ultimo_battito < NOW() - (h.cadenza_ms * 3 / 1000.0) * interval '1 second' THEN 'FERMO'
         ELSE 'vivo'
       END                                                               AS stato
FROM loop_heartbeat h
ORDER BY 6 DESC, 4 DESC;

COMMENT ON VIEW v_loop_stato IS 'Stato dei loop a colpo d''occhio. FERMO = nessun battito da oltre 3 cadenze.';

INSERT INTO schema_migrations (filename, applied_at)
SELECT '117_cane_da_guardia_dei_loop.sql', NOW()
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '117_cane_da_guardia_dei_loop.sql');
