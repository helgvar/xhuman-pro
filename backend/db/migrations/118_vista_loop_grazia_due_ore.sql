-- 118: la vista dei loop non deve condannare un loop appena nato.
-- Alla partenza ogni loop registra la PRIMA attesa (spesso 1-4 min), non la
-- cadenza di regime: 3 cadenze dopo il boot sono passate prima che il loop
-- abbia avuto modo di battere una seconda volta. Il watchdog (mig 117, job 3)
-- gia' pretende primo_battito piu' vecchio di 2h; la vista no, e mostrava
-- FERMO su loop sani. Stessa grazia, stesso verdetto.

CREATE OR REPLACE VIEW v_loop_stato AS
SELECT h.loop_name AS loop,
       round(h.cadenza_ms / 60000.0, 1) AS cadenza_min,
       h.ultimo_battito AT TIME ZONE 'Europe/Rome' AS ultimo_battito,
       round(EXTRACT(EPOCH FROM (NOW() - h.ultimo_battito)) / 60.0) AS fermo_da_min,
       h.battiti,
       CASE
         WHEN h.cadenza_ms IS NULL THEN 'cadenza ignota'
         WHEN h.primo_battito > NOW() - interval '2 hours' THEN 'appena nato'
         WHEN h.ultimo_battito < NOW() - (h.cadenza_ms * 3 / 1000.0) * interval '1 second' THEN 'FERMO'
         ELSE 'vivo'
       END AS stato
FROM loop_heartbeat h
ORDER BY 6 DESC, 4 DESC;

INSERT INTO schema_migrations (filename, applied_at)
SELECT '118_vista_loop_grazia_due_ore.sql', NOW()
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '118_vista_loop_grazia_due_ore.sql');

SELECT stato, count(*) FROM v_loop_stato GROUP BY 1 ORDER BY 2 DESC;
