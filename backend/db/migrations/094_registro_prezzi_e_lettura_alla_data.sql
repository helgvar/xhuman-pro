-- 094 — Registro prezzi + lettura del valore ALLA DATA
--
-- 6/8/2026, ordine del capo: "non e' possibile lactoflorene ha sempre venduto
-- in utile rispetto al costo del momento. devi importare per tutti i tenant
-- l'history price e cost da farmabooster altrimenti non ne uscirai mai".
--
-- IL DANNO CHE CHIUDE
-- Il 13/7 LACTOFLORENE REPAIR IBS e' stato venduto a 8,85 ivati. Oggi il suo
-- costo e' 13,17, e ogni analisi di margine retroattiva lo dava a -4,32: un
-- prodotto che vende in perdita. Il grafico di Farmabooster dice altro — il
-- 13/7 quel costo era 7,667 (Winfarm) e il prezzo 9,54. Margine reale: +1,87.
-- Il costo e' salito a 12,01 il 15/7 e a 13,17 il 31/7, DOPO la vendita.
--
-- Su MPF, 30 giorni: 54 SKU dichiarati "sotto costo" per -460 EUR di margine.
-- Nessuno di quei numeri era una misura — erano tutti prezzi del passato
-- confrontati con il costo di adesso. La stessa lama girata su tutti i tenant
-- avrebbe tagliato prodotti sani.
--
-- COSA SERVE
-- Il costo da solo non basta. Un margine ha due gambe: quanto e' entrato e
-- quanto e' uscito, ENTRAMBI al momento della vendita. Il registro costi (093)
-- copre una gamba. Questa migrazione aggiunge l'altra e da' a tutte e due un
-- modo di essere lette a una data qualunque.
--
-- IL GRADINO
-- Stessa forma del registro costi: si scrive solo quando il valore CAMBIA.
-- Farmabooster manda una riga al giorno per codice anche quando il prezzo e'
-- fermo — 1,5 milioni di record per tenant che ripetono lo stesso numero. Il
-- valore di un giorno qualunque e' l'ultima riga con data <= quel giorno, che
-- e' identico e costa due ordini di grandezza in meno.
--
-- Conseguenza da non dimenticare quando si ruota la finestra: la prima riga di
-- un altopiano NON e' cancellabile, perche' e' quella che tiene il valore di
-- tutti i giorni che la seguono. La rotazione deve ri-ancorare prima di tagliare
-- (vedi ruotaRegistro in costHistoryCron.js).
--
-- IVA — verificato sul campo, non dedotto
-- FB scheda LACTOFLORENE: "Prezzo al Pubblico: Imponibile 14,723 / Prezzo
-- 16,195" e pricehistory del 6/8 dice 16,195. Il registro prezzi e' IVA
-- INCLUSA. Costi: la tabella fornitori dice "Farvima imponibile 9,21 / costo
-- 10,131" e costhistory dice 10,1310. Anche i costi sono IVA INCLUSA.
-- Entrambi si accoppiano a order_items.row_total_incl_tax senza conversioni.
--
-- PERCHE' TUTTE LE FONTI E NON SOLO IL MINIMO
-- costhistory porta una riga per grossista (CEF, Winfarm, Farvima, Sofarma,
-- Guacci). Sulla scheda FB "Costo Min Farmacia" (13,167 = Winfarm) e "Cost Min
-- Fornitori" (10,131 = Farvima) sono numeri diversi che rispondono a domande
-- diverse: quanto e' costato lo scaffale, e quanto costerebbe ricomprarlo. Si
-- salvano tutte le fonti grezze e si decide al momento della domanda, perche'
-- una scelta fatta qui sarebbe irreversibile.

-- PERCHE' ANCHE I PREZZI HANNO UNA SOURCE
-- Verificato su LACTOFLORENE 988039778 (MPF, 6/8): sell_price 16,20 ed
-- exported_price 16,20 — che e' il 16,195 di pricehistory — ma applied_price
-- 8,85, ed 8,85 e' esattamente la cifra a cui il prodotto ha VENDUTO il 13/7.
-- Il registro di FB segue il LISTINO al pubblico, non la cifra applicata dentro
-- il feed. Sono due domande diverse ("a che prezzo eravamo esposti" contro "a
-- che prezzo abbiamo incassato") e un registro solo che le confondesse
-- rimetterebbe in circolo un errore della stessa famiglia di quello che questa
-- migrazione chiude. Quindi stessa forma del registro costi: la source dice
-- quale prezzo e', e chi legge sceglie.
--   fb_pubblico -> Prezzo al Pubblico di FB (backfill /pricehistory + sell_price)
--   applicato   -> applied_price, la cifra applicata dentro il feed
--   esportato   -> exported_price, quella che parte verso Trovaprezzi
-- La tabella su produzione esiste gia': era stata creata a mano, fuori dalle
-- migrazioni, da un test di luglio (336 righe su 21 SKU di MPF, 9-24/7) che il
-- codice non scrive piu' — `costPriceHistorySync`, citato nel commento di
-- routes/products.js, non esiste in repo. Quelle righe sono comunque prezzi FB
-- veri, quindi si tengono e si marcano `fb_pubblico`. Il CREATE serve solo agli
-- ambienti dove la tabella non c'e'; gli ALTER sotto portano quella esistente
-- alla forma nuova e non fanno nulla se e' gia' cosi'.
CREATE TABLE IF NOT EXISTS product_price_history (
  tenant_id  uuid          NOT NULL,
  sku        text          NOT NULL,
  data       date          NOT NULL,
  source     text          NOT NULL DEFAULT 'fb_pubblico',
  prezzo     numeric(12,4) NOT NULL,
  updated_at timestamptz   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku, data, source)
);

ALTER TABLE product_price_history
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'fb_pubblico';

-- La chiave vecchia era (tenant_id, sku, data): senza la source due prezzi
-- diversi dello stesso giorno si sovrascriverebbero a vicenda, e il gradino
-- dell'`applicato` cancellerebbe quello del listino.
DO $$
DECLARE v_pk text;
BEGIN
  SELECT c.conname INTO v_pk
  FROM pg_constraint c
  WHERE c.conrelid = 'product_price_history'::regclass AND c.contype = 'p';
  IF v_pk IS NOT NULL AND (
       SELECT COUNT(*) FROM pg_constraint c2,
              LATERAL unnest(c2.conkey) k
       WHERE c2.conname = v_pk AND c2.conrelid = 'product_price_history'::regclass
     ) < 4 THEN
    EXECUTE format('ALTER TABLE product_price_history DROP CONSTRAINT %I', v_pk);
    v_pk := NULL;
  END IF;
  IF v_pk IS NULL THEN
    ALTER TABLE product_price_history
      ADD PRIMARY KEY (tenant_id, sku, data, source);
  END IF;
END $$;

-- Stesso motivo dell'indice 093: la chiave primaria ha la data in terza
-- posizione e in ASC, quindi non serve a cercare l'ultimo gradino. Questo la
-- mette in DESC, con la source prima, cosi' il gradino attivo di una fonte e'
-- la prima riga letta.
-- DROP e non IF NOT EXISTS: un indice con questo nome puo' gia' esistere con le
-- colonne vecchie, e CREATE INDEX IF NOT EXISTS lo lascerebbe li' — indice
-- sbagliato, nessun errore, nessun modo di accorgersene.
DROP INDEX IF EXISTS idx_pph_gradino;
CREATE INDEX idx_pph_gradino
  ON product_price_history (tenant_id, sku, source, data DESC);

-- L'indice del registro costi c'e' gia' (093) ma serve anche la strada senza
-- source: "il costo minimo di questo sku a questa data" attraversa tutte le
-- fonti insieme, e con l'indice di 093 la source viene prima della data.
CREATE INDEX IF NOT EXISTS idx_pch_sku_data
  ON product_cost_history (tenant_id, sku, data DESC);

-- ---------------------------------------------------------------------------
-- LETTURA ALLA DATA
--
-- Queste due funzioni sono il punto di tutta la migrazione. Senza, ogni query
-- di analisi si riscrive da sola il LATERAL con l'ORDER BY data DESC LIMIT 1,
-- e basta sbagliarlo una volta per rimettere in circolo lo stesso errore che
-- ha prodotto i 54 falsi sotto-costo.
--
-- Restituiscono NULL quando il registro non arriva a coprire quella data —
-- NULL e' "non lo so", ed e' un risultato onesto che si propaga e si vede.
-- Non ripiegano MAI sul valore di oggi: quello e' esattamente il bug.
-- ---------------------------------------------------------------------------

-- Prezzo (IVA inclusa) in quel giorno.
-- Default 'fb_pubblico' perche' e' l'unica fonte che il backfill di FB copre
-- all'indietro: le altre due partono dal giorno in cui il gradino del sync ha
-- cominciato a scriverle, e chiederle prima restituisce NULL.
CREATE OR REPLACE FUNCTION prezzo_al(p_tenant uuid, p_sku text, p_data date,
                                     p_source text DEFAULT 'fb_pubblico')
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT h.prezzo
  FROM product_price_history h
  WHERE h.tenant_id = p_tenant AND h.sku = p_sku AND h.data <= p_data
    AND h.source = p_source
  ORDER BY h.data DESC
  LIMIT 1
$$;

-- Costo (IVA inclusa) in quel giorno.
--   p_source NULL  -> il minimo fra tutte le fonti attive quel giorno
--                     (= "Cost Min Fornitori" di FB, il costo di riacquisto)
--   p_source dato  -> quella fonte sola ('erp_acquisto', 'grossista_min',
--                     'min_blended', o il nome del grossista: 'Winfarm', ...)
--
-- Il minimo si prende DOPO aver risolto il gradino di ogni fonte: prima l'ultimo
-- valore noto di ciascuna a quella data, poi il minimo fra quelli. L'ordine
-- inverso — minimo su tutte le righe fino a quel giorno — pescherebbe un costo
-- vecchio di una fonte che nel frattempo e' rincarata.
CREATE OR REPLACE FUNCTION costo_al(p_tenant uuid, p_sku text, p_data date,
                                    p_source text DEFAULT NULL)
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT MIN(v.costo)
  FROM (
    SELECT DISTINCT ON (h.source) h.costo
    FROM product_cost_history h
    WHERE h.tenant_id = p_tenant AND h.sku = p_sku AND h.data <= p_data
      AND (p_source IS NULL OR h.source = p_source)
    ORDER BY h.source, h.data DESC
  ) v
$$;

-- Margine unitario alla data: prezzo di quel giorno meno costo di quel giorno.
-- NULL se manca una delle due gambe — meglio un buco dichiarato di un numero
-- che sembra una misura e non lo e'.
--
-- QUANDO NON USARLA
-- Su una riga d'ordine NO: li' il prezzo vero e' gia' in
-- order_items.row_total_incl_tax, che e' quanto e' stato incassato davvero, e
-- non ha bisogno di essere ricostruito. Su LACTOFLORENE il 13/7 il registro
-- prezzi dice 9,54 (listino FB) ma l'incasso e' stato 8,85: il margine della
-- vendita si fa con 8,85. La forma giusta su una vendita e'
--   row_total_incl_tax - qty * costo_al(tenant, sku, giorno_ordine)
-- Questa funzione serve alle domande senza vendita: che margine avrebbe reso
-- quel prodotto quel giorno, con quello che c'era esposto.
CREATE OR REPLACE FUNCTION margine_al(p_tenant uuid, p_sku text, p_data date,
                                      p_source_costo  text DEFAULT NULL,
                                      p_source_prezzo text DEFAULT 'fb_pubblico')
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT prezzo_al(p_tenant, p_sku, p_data, p_source_prezzo)
       - costo_al(p_tenant, p_sku, p_data, p_source_costo)
$$;

INSERT INTO schema_migrations (filename)
VALUES ('094_registro_prezzi_e_lettura_alla_data.sql')
ON CONFLICT DO NOTHING;
