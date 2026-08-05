-- 070: LOOP DEL MANTRA (ordine capo 19/7: "un loop che porti soluzioni nuove
-- almeno una volta al giorno — AUMENTA IL FATTURATO e ABBASSA I COSTI")
-- Memoria delle soluzioni proposte: il loop non si ripete mai.
CREATE TABLE IF NOT EXISTS mantra_soluzioni (
  id SERIAL PRIMARY KEY,
  proposta_at DATE NOT NULL DEFAULT CURRENT_DATE,
  titolo TEXT NOT NULL,
  tipo TEXT NOT NULL,              -- fatturato | costo | misto
  tenant TEXT,                     -- tenant target o 'rete'
  descrizione TEXT NOT NULL,       -- azione concreta: cosa fare e come
  stima_eur_g NUMERIC,             -- impatto stimato €/giorno
  status TEXT NOT NULL DEFAULT 'proposta',  -- proposta | applicata | scartata
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_mantra_sol_date ON mantra_soluzioni (proposta_at DESC);

INSERT INTO schema_migrations (filename)
SELECT '070_mantra_soluzioni.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename='070_mantra_soluzioni.sql');
