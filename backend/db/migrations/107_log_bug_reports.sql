-- =====================================================================
-- 107_log_bug_reports.sql — 26/08/2026
-- Registro dei bug visti nei log: una riga per FIRMA (errore normalizzato),
-- non una per occorrenza. La diagnosi AI (DeepSeek) si scrive una volta
-- sola, alla prima comparsa; poi si aggiornano occorrenze e ultimo_visto.
-- Nessun Telegram per firme gia' note.
-- Applicare in transazione: psql -1 -f 107_log_bug_reports.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS log_bug_reports (
  id            bigserial PRIMARY KEY,
  firma         text        NOT NULL UNIQUE,   -- sha1 del messaggio normalizzato
  messaggio_norm text,                          -- il messaggio normalizzato (leggibile)
  primo_visto   timestamptz NOT NULL DEFAULT NOW(),
  ultimo_visto  timestamptz NOT NULL DEFAULT NOW(),
  occorrenze    integer     NOT NULL DEFAULT 1,
  esempio       text,                           -- riga grezza mascherata (max 2000 char)
  servizio      text,                           -- log_events.source
  diagnosi_ai   text,
  stato         text        NOT NULL DEFAULT 'aperto',  -- aperto | in_lavorazione | chiuso | ignorato
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_log_bug_reports_stato
  ON log_bug_reports (stato, ultimo_visto DESC);
CREATE INDEX IF NOT EXISTS idx_log_bug_reports_servizio
  ON log_bug_reports (servizio, ultimo_visto DESC);

COMMENT ON TABLE log_bug_reports IS
  'Un bug = una firma. Alimentata da services/logSentinel.js ogni 30 min (P3, 26/8).';

-- Cursore del sentinella: ultimo log_events.id gia' letto. '0' = dall inizio.
INSERT INTO global_config (config_key, config_value, description)
VALUES ('log_sentinel_cursor', '0', 'Ultimo log_events.id processato da logSentinel')
ON CONFLICT (config_key) DO NOTHING;

-- Interruttore dell auditor AI: '0' lo spegne senza deploy.
INSERT INTO global_config (config_key, config_value, description)
VALUES ('ai_auditor_enabled', '1', 'aiAuditor acceso (1) o spento (0). Spento = nessuna chiamata AI, log chiaro.')
ON CONFLICT (config_key) DO NOTHING;

-- Routing AI per servizio: auditor e logsentinel su DeepSeek (credito
-- Anthropic esaurito). La chiave 'ai_provider' NON esiste: il default
-- resta 'anthropic' per tutti gli altri servizi.
-- La chiave ESISTE gia' in produzione (verificato 26/8: contiene 'agent',
-- '_banco_deepseek', '_banco_anthropic'). Per questo si fonde con `||` e
-- non si sovrascrive: le tre voci gia' li' restano, si aggiungono solo
-- 'auditor' e 'logsentinel'.
INSERT INTO global_config (config_key, config_value, description)
VALUES ('ai_provider_overrides', '{"auditor":"deepseek","logsentinel":"deepseek"}',
        'Provider AI per singolo servizio (JSON)')
ON CONFLICT (config_key) DO UPDATE
SET config_value = (
      COALESCE(NULLIF(global_config.config_value, '')::jsonb, '{}'::jsonb)
      || '{"auditor":"deepseek","logsentinel":"deepseek"}'::jsonb
    )::text,
    updated_at = NOW();

INSERT INTO schema_migrations (filename) VALUES ('107_log_bug_reports.sql')
ON CONFLICT (filename) DO NOTHING;
