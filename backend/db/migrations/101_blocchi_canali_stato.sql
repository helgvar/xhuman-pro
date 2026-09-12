-- 101_blocchi_canali_stato.sql — ordine capo 16/08/2026
--
-- «metti un loop di controllo che mi avvisa se ci sono altri blocchi».
--
-- Il caso Farmabooster è passato inosservato per tre giorni: i job fallivano in
-- silenzio, nessuno guardava. Qui si tiene lo stato di ogni canale di ingresso
-- dati (Farmabooster, Magento, scraper, click TP, costi) e si avvisa quando lo
-- stato CAMBIA — non ogni ora, altrimenti il canale diventa rumore e il
-- prossimo blocco vero passa di nuovo inosservato.
--
-- Lo stato sta nel DB e non in memoria perché un restart del backend non deve
-- far ripartire la sirena da zero (o peggio, far ridichiarare "risolto" un
-- blocco che è ancora lì).

BEGIN;

CREATE TABLE IF NOT EXISTS blocchi_canali_stato (
  canale          text NOT NULL,          -- farmabooster | magento_ordini | scraper | click_tp | costi
  tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = canale globale
  stato           text NOT NULL,          -- ok | bloccato
  eta_ore         numeric(8,1),           -- quanto è vecchio il dato più fresco
  dettaglio       text,
  dal             timestamptz NOT NULL DEFAULT NOW(),   -- da quando dura lo stato attuale
  ultimo_avviso_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocchi_canali_chiave
  ON blocchi_canali_stato (canale, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_blocchi_canali_rotti
  ON blocchi_canali_stato (canale, dal) WHERE stato = 'bloccato';

INSERT INTO schema_migrations (filename) VALUES ('101_blocchi_canali_stato.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
