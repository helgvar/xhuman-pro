-- 105 — VERDETTO SUI TAGLI (ordine capo 21/8: "controlla che dopo i tagli il
-- fatturato non scenda insieme alla spesa")
--
-- Il mantra è costo GIÙ *e* fatturato SU. Un taglio che porta via anche il
-- fatturato non è un risparmio, è una potatura del ramo che dà i frutti.
--
-- Due tabelle perché la misura ha due tempi:
--   taglio_coorti  — il PRIMA, congelato il giorno stesso del taglio. Se lo
--                    misurassimo fra una settimana la finestra "prima" sarebbe
--                    già inquinata dal taglio stesso.
--   taglio_verdetti — il DOPO, scritto 7 giorni dopo, con il confronto.

CREATE TABLE IF NOT EXISTS taglio_coorti (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku            VARCHAR(100) NOT NULL,
  giorno_taglio  DATE NOT NULL,
  action_source  VARCHAR(40),
  product_name   TEXT,
  -- il PRIMA, 7 giorni chiusi prima del taglio
  pre_click      INTEGER      NOT NULL DEFAULT 0,
  pre_costo      NUMERIC(12,2) NOT NULL DEFAULT 0,   -- click x CPC lordo del tenant
  pre_qta        INTEGER      NOT NULL DEFAULT 0,
  pre_fatturato  NUMERIC(12,2) NOT NULL DEFAULT 0,   -- righe sue, IVA inclusa
  pre_margine    NUMERIC(12,2) NOT NULL DEFAULT 0,   -- con costo_al(): retroattivo, NULL = non lo so
  pre_ordini     INTEGER      NOT NULL DEFAULT 0,    -- quanti ordini lo contenevano
  pre_carrello   NUMERIC(12,2) NOT NULL DEFAULT 0,   -- valore NETTO pieno di quegli ordini
  -- il DOPO, 7 giorni chiusi dopo il taglio (NULL finché non si giudica)
  post_click     INTEGER,
  post_costo     NUMERIC(12,2),
  post_qta       INTEGER,
  post_fatturato NUMERIC(12,2),
  post_ordini    INTEGER,
  post_carrello  NUMERIC(12,2),
  esito          VARCHAR(20),   -- pulito | costa_fatturato | carrello_perso | rientrato
  giudicato_al   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_taglio_coorte UNIQUE (tenant_id, sku, giorno_taglio)
);

CREATE INDEX IF NOT EXISTS idx_taglio_coorti_da_giudicare
  ON taglio_coorti (tenant_id, giorno_taglio) WHERE giudicato_al IS NULL;
CREATE INDEX IF NOT EXISTS idx_taglio_coorti_esito
  ON taglio_coorti (tenant_id, esito, giorno_taglio DESC);

-- Il verdetto d'insieme: una riga per tenant e giorno di taglio.
-- Il controfattuale è la RETE: agosto scende da solo (Procaccini -36% ordini,
-- ma Ospedale -49%, Farmainsieme -43%). Senza un termine di paragone esterno
-- si condanna il taglio per una stagione.
CREATE TABLE IF NOT EXISTS taglio_verdetti (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  giorno_taglio     DATE NOT NULL,
  sku_tagliati      INTEGER NOT NULL,
  -- effetto sulla coorte
  risparmio_click   NUMERIC(12,2),   -- costo TP che non spendiamo più
  fatturato_perso   NUMERIC(12,2),   -- fatturato delle righe tagliate, sparito
  margine_perso     NUMERIC(12,2),
  carrelli_persi    INTEGER,         -- ordini che passavano da quegli SKU e non ci sono più
  carrello_perso_eur NUMERIC(12,2),
  -- effetto sul tenant, 7gg dopo vs 7gg prima
  tenant_fatt_pre   NUMERIC(12,2),
  tenant_fatt_post  NUMERIC(12,2),
  tenant_delta_pct  NUMERIC(6,2),
  tenant_costo_pre  NUMERIC(12,2),
  tenant_costo_post NUMERIC(12,2),
  -- il controfattuale: mediana della stessa variazione sugli altri operativi
  rete_delta_pct    NUMERIC(6,2),
  scarto_da_rete    NUMERIC(6,2),    -- tenant - rete: negativo = peggio della rete
  verdetto          VARCHAR(20) NOT NULL,  -- sano | sorvegliato | allarme | dati_insufficienti
  nota              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_taglio_verdetto UNIQUE (tenant_id, giorno_taglio)
);

CREATE INDEX IF NOT EXISTS idx_taglio_verdetti_tenant
  ON taglio_verdetti (tenant_id, giorno_taglio DESC);

INSERT INTO schema_migrations (filename) VALUES ('105_taglio_coorti_verdetto.sql')
ON CONFLICT (filename) DO NOTHING;
