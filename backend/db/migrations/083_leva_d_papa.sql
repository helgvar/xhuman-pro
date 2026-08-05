-- 083: LEVA D estesa a PAPA (capo 4/8: "tagliare spese su PAPA, MPF e FARMASTELIA")
--
-- La 082 ha reso 'vetrina_click_min' sovrascrivibile per tenant e l'ha messo a 2
-- su MPF e Farmastelia. Papa era rimasto sul globale 8 e per questo la sua coda
-- lunga non veniva mai vista: analisi 4/8 h12 su click reali 15gg
--   Papa: 597 SKU morti ovunque ancora nel feed = EUR 21,82/gg, di cui
--         405 SKU (EUR 14,65/gg) trattenuti dalla SOLA protezione top10.
-- Stessa identica firma di MPF/Farmastelia: rotazione a 1-3 click, mai vicino
-- alla soglia 8.
--
-- Nessuna modifica di codice: la funzione refresh_vetrina_piena() della 082 legge
-- gia' health_config. Questa e' solo la riga di config.
--
-- Simulazione BEGIN/ROLLBACK 4/8 h12:
--   Papa 17 -> 301 SKU, EUR 353,24 di click su 15gg.
--   ordini diretti = 0, fatturato = 0, vendite di rete = 0 su TUTTE le righe
--   (la guardia rete della 082 vale anche qui).
--   Risparmio stimato: EUR 23,55/gg.
--
-- ROLLBACK: DELETE FROM health_config
--             WHERE config_key='vetrina_click_min'
--               AND tenant_id=(SELECT id FROM tenants WHERE name='Papa');

INSERT INTO health_config (tenant_id, config_key, config_value)
SELECT id, 'vetrina_click_min', '2' FROM tenants WHERE name = 'Papa'
ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = '2';

INSERT INTO schema_migrations (filename) VALUES ('083_leva_d_papa.sql')
ON CONFLICT (filename) DO NOTHING;
