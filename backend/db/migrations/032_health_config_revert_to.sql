-- Briglie temporanee con auto-revert al valore precedente alla scadenza.
-- Use case: "abbassa quarantine_release a 1 fino a venerdi prossimo, poi torna
-- a 2". Senza expired_revert_to, dopo la scadenza loadConfig ignora la riga e
-- ritorna al default codice (0=disattivata), perdendo il valore "precedente".
--
-- Comportamento:
--  - expires_at IS NULL OR expires_at > NOW(): usa config_value (come prima)
--  - expires_at <= NOW() AND expired_revert_to IS NOT NULL: usa expired_revert_to
--  - expires_at <= NOW() AND expired_revert_to IS NULL: ignora la riga (come prima)
ALTER TABLE health_config ADD COLUMN IF NOT EXISTS expired_revert_to TEXT;
