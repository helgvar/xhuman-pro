-- 099 — Monitor coorti di posizione (ordine capo 15/08/2026)
--
-- "lasciala così ma crea un loop di monitoraggio per valutare tutti questi sku
--  in momenti più giusti dell'anno."
--
-- Contesto: il misuratore di posizione (scraper_competitors.position) è il rango
-- sul PREZZO SECCO, non sul totale con spedizione. Il capo ha deciso di NON
-- correggerlo: la misura del 15/8 dice che i "fantasmi" (top10 sul secco, fuori
-- vetrina sul totale) rendono meglio della vetrina vera (6,0% vs 6,8% di
-- incidenza). Ma quella misura è stata presa a Ferragosto, la settimana meno
-- rappresentativa dell'anno. Queste due tabelle tengono il registro finché non
-- arriva un periodo giudicabile.
--
-- NON TOCCANO NIENTE. Sono solo un registro: nessun motore le legge per agire.

-- 1) Storia per SKU, scritta A GRADINI (come il registro costi della 093):
--    una riga solo quando la coorte cambia o il rango si muove di >= 3 posizioni.
--    Serve perché scraper_competitors ha retention 7 giorni: senza questo,
--    a settembre la storia di agosto non esiste più.
CREATE TABLE IF NOT EXISTS coorti_posizione_sku (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku              varchar(20) NOT NULL,
  snap_date        date NOT NULL,
  coorte           smallint NOT NULL,   -- 1..6, vedi coorti_posizione_legenda
  r_secco          int,                 -- rango sul base_price (quello che vede il sistema)
  r_totale         int,                 -- rango sul total_price (quello che vede il cliente)
  base_price       numeric(10,2),
  total_price      numeric(10,2),
  spedizione       numeric(10,2),
  competitor_count int,
  PRIMARY KEY (tenant_id, sku, snap_date)
);

CREATE INDEX IF NOT EXISTS idx_coorti_sku_storia
  ON coorti_posizione_sku (tenant_id, sku, snap_date DESC);
CREATE INDEX IF NOT EXISTS idx_coorti_sku_giorno
  ON coorti_posizione_sku (snap_date, coorte);

-- 2) Aggregato giornaliero per tenant x coorte: click, costo, ordini, fatturato.
--    36 righe al giorno. `finestra_valida` marca se il giorno è giudicabile:
--    Ferragosto, Natale, budget TP esaurito e crolli di click sotto la metà
--    della mediana NON entrano nel verdetto.
CREATE TABLE IF NOT EXISTS coorti_posizione_giorno (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snap_date         date NOT NULL,
  coorte            smallint NOT NULL,
  sku_totali        int NOT NULL DEFAULT 0,
  sku_cliccati      int NOT NULL DEFAULT 0,
  click             int NOT NULL DEFAULT 0,
  costo             numeric(12,2) NOT NULL DEFAULT 0,
  ordini            int NOT NULL DEFAULT 0,
  pezzi             int NOT NULL DEFAULT 0,
  fatturato         numeric(12,2) NOT NULL DEFAULT 0,
  finestra_valida   boolean NOT NULL DEFAULT true,
  motivo_esclusione text,
  updated_at        timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, snap_date, coorte)
);

CREATE INDEX IF NOT EXISTS idx_coorti_giorno_valide
  ON coorti_posizione_giorno (tenant_id, coorte, snap_date) WHERE finestra_valida;

-- 3) Legenda delle coorti, così la tabella si legge senza avere il codice sotto mano
CREATE TABLE IF NOT EXISTS coorti_posizione_legenda (
  coorte      smallint PRIMARY KEY,
  nome        text NOT NULL,
  descrizione text NOT NULL
);

INSERT INTO coorti_posizione_legenda (coorte, nome, descrizione) VALUES
  (1, 'VETRINA VERA',    'top10 sul secco E top10 sul totale: il sistema la vede e il cliente pure'),
  (2, 'FANTASMA 11-20',  'top10 sul secco, 11-20 sul totale: la spedizione ci butta appena fuori'),
  (3, 'FANTASMA 21-30',  'top10 sul secco, 21-30 sul totale'),
  (4, 'FANTASMA >30',    'top10 sul secco, oltre la 30esima sul totale: invisibile al cliente'),
  (5, 'REGALO',          'fuori top10 sul secco ma top10 sul totale: vetrina vera che il sistema non vede'),
  (6, 'FUORI VETRINA',   'fuori dai primi 10 su entrambe le misure')
ON CONFLICT (coorte) DO UPDATE SET nome = EXCLUDED.nome, descrizione = EXCLUDED.descrizione;

INSERT INTO schema_migrations (filename) VALUES ('099_coorti_posizione_monitor.sql')
ON CONFLICT (filename) DO NOTHING;
