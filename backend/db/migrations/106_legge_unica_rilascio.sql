-- =====================================================================
-- 106_legge_unica_rilascio.sql — 26/08/2026
-- GO del capo (audit veti e bruciatori 26/8). UNA legge sola decide chi
-- esce dalla quarantena: merita_rilascio(). I due veti disgiunti
-- (burner_rule / incidenza_alta) diventano UN veto solo.
--
-- COME SI APPLICA: il file NON contiene BEGIN/COMMIT. Chi applica DEVE
-- avvolgerlo in UNA sola transazione: le set_config(..., true) della
-- bonifica sono transaction-local e senza transazione il trigger le
-- vedrebbe vuote.
--   psql -1 -U xhumanpro -d xhumanpro -f 106_legge_unica_rilascio.sql
--
-- ORDINE INTERNO VINCOLANTE: (1) funzioni e ALTER, (2) trigger nuovi,
-- (3) SOLO DOPO la bonifica: col WHEN vecchio la bonifica farebbe girare
-- vende_e_ripaga su ~9.700 righe (minuti di transazione).
--
-- VINCOLO DI DEPLOY: services/rilascioOrario.js deve calcolare l'atterraggio
-- con la STESSA formula della SEZIONE 3 (ultimo scrape entro 48h, non tutta
-- la finestra). Se il prefiltro JS resta sulla finestra, ordina l'ondata su
-- una posizione diversa da quella su cui la legge poi decide, e la
-- differenza non si vede nei log: si vede solo nei rilasci mancati.
-- =====================================================================

-- ---------------------------------------------------------------------
-- SEZIONE 1 — funzioni base
-- ---------------------------------------------------------------------

-- Whitelist canonica degli stati ordine. IMMUTABLE: il planner la piega
-- a costante. MAI usare NOT IN da nessuna parte.
CREATE OR REPLACE FUNCTION public.stati_ordine_validi()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY['complete','processing','pending','holded','payment_review',
               'fraud','ritiro_farmacia','Ritirato']
$fn$;

-- Classe di chi scrive: capo | sessione | motore | anonimo.
-- I due veti disgiunti (capo_% passava solo il burner, sessione_% solo
-- l'incidenza) diventano una classificazione sola.
-- ATTENZIONE: sempre ESCAPE sull'underscore — 'sessione_%' senza ESCAPE
-- accettava anche 'sessioneX' (buco del vecchio veto incidenza).
CREATE OR REPLACE FUNCTION public.writer_classe()
RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    -- SOLO 'capo\_%': il GO del capo elenca due prefissi, capo_% e
    -- sessione_%. 'manual%' era un'aggiunta del costruttore e apriva una
    -- porta piu' larga di quella ordinata (un writer 'manual_qualsiasi'
    -- scavalcava il veto anche su manual_override/is_burner_rule e la R2
    -- dell'arbitro DELETE). Misurato 26/8: nessuno dei writer vivi inizia
    -- per 'manual' (log 30gg: anonimo, sessione_*, rilascio_vendenti,
    -- lima_costante_test), quindi la stretta non tocca nulla di vivo.
    -- 'manual'/'manual_pepita' restano fonti UMANE (fonte_umana): li'
    -- parliamo di action_source, non di chi scrive.
    WHEN w LIKE 'capo\_%' ESCAPE '\'                             THEN 'capo'
    WHEN w LIKE 'sessione\_%' ESCAPE '\'                         THEN 'sessione'
    WHEN w LIKE 'pulizia\_%' ESCAPE '\'
      OR w LIKE 'motore\_%' ESCAPE '\'
      OR w LIKE 'rilascio\_%' ESCAPE '\'                         THEN 'motore'
    ELSE 'anonimo'
  END
  FROM (SELECT COALESCE(NULLIF(current_setting('xhp.writer', true), ''), '') AS w) s
$fn$;

-- Fonti di feed_actions che nessun writer anonimo puo' toccare (stessa
-- lista dell'arbitro mig 058/102, con 'manual%' al posto del solo 'manual').
CREATE OR REPLACE FUNCTION public.fonte_protetta(p_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE(
       p_source IN ('capo_pin','muro_scavalco')
    OR p_source LIKE 'manual%'
    OR p_source LIKE 'capo\_%' ESCAPE '\'
    OR p_source LIKE 'sessione\_%' ESCAPE '\'
    OR p_source LIKE 'pulizia\_%' ESCAPE '\'
  , false)
$fn$;

-- Sottoinsieme UMANO delle fonti protette: il lavoro del capo e della
-- sessione. 'manual_review' e 'pulizia_%' NON sono umane (le scrivono i
-- motori), 'muro_scavalco' neppure (la cancella la sentinella dei muri).
CREATE OR REPLACE FUNCTION public.fonte_umana(p_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE(
       p_source IN ('manual','manual_pepita','capo_pin')
    OR p_source LIKE 'capo\_%' ESCAPE '\'
    OR p_source LIKE 'sessione\_%' ESCAPE '\'
  , false)
$fn$;

-- Riallineata alla whitelist: prima passava qualunque stato diverso da
-- 'canceled'/'closed' (pending_payment compreso). Delta misurato sulla
-- quarantena viva il 26/8: 0 SKU (2.749 true con la vecchia definizione,
-- 2.749 con la nuova, nessun flip nei due sensi — negli ultimi 15gg in
-- tabella ci sono solo complete/processing/canceled/pending/Ritirato/
-- ritiro_farmacia). Firma e semantica invariate.
CREATE OR REPLACE FUNCTION public.vende_in_rete_15g(p_sku text)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE oi.sku = p_sku
      AND o.order_date >= NOW() - INTERVAL '15 days'
      AND o.order_status = ANY (stati_ordine_validi())
  )
$fn$;

-- ---------------------------------------------------------------------
-- SEZIONE 2 — colonne mancanti (nessun indice nuovo: EXPLAIN 26/8 dice
-- che ogni gamba di merita_rilascio sta su indici gia' esistenti)
-- ---------------------------------------------------------------------

-- ATTENZIONE (segnalato al coordinatore il 26/8): oggi questa colonna ha
-- uno SCRITTORE e nessun LETTORE. Il budget in euro lo consuma
-- budgetConsumptionCron, ma solo su feed_actions.max_click_budget
-- (feedEngine 912/967/1034/1070/1147/1230/1243). Finche' non si aggancia
-- il consumo anche a feed_quarantine, questo campo e' FORENSE: dice quanto
-- valeva il rilascio, non spegne nulla.
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS max_click_budget numeric;
COMMENT ON COLUMN feed_quarantine.max_click_budget IS
  'EURO (margine unitario x 1,5), scritto dal veto sul rilascio ammesso. NULL = costo ignoto, mai 0. Oggi nessun lettore: forense finche'' budgetConsumptionCron non lo aggancia.';

-- Contatori del veto sulla riga stessa. Sono GRATIS: il veto e' BEFORE
-- UPDATE, la riga si sta gia' riscrivendo. Servono a non perdere il
-- conteggio ora che le respinte anonime non si scrivono piu' una per una
-- (vedi SEZIONE 4): questi sono numeri ESATTI, il log e' campionato.
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS veti_contatore integer;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS ultimo_veto_at timestamptz;
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS ultimo_veto_log_at timestamptz;
COMMENT ON COLUMN feed_quarantine.veti_contatore IS
  'Quante volte il veto unificato ha respinto un rilascio su questa riga (conteggio esatto, non campionato).';
COMMENT ON COLUMN feed_quarantine.ultimo_veto_at IS
  'Ultimo tentativo di rilascio respinto. Serve al POST-1h: se resta fermo, nessuno bussa piu''.';
COMMENT ON COLUMN feed_quarantine.ultimo_veto_log_at IS
  'Ultima respinta ANONIMA finita in burner_rule_reactivation_log. Governa il campionamento a 24h.';

ALTER TABLE capo_pins ADD COLUMN IF NOT EXISTS expires_at timestamptz;
COMMENT ON COLUMN capo_pins.expires_at IS
  'Scadenza del pin. NULL = non scade (comportamento storico mig 056: revoca solo esplicita).';

-- ---------------------------------------------------------------------
-- SEZIONE 3 — LA LEGGE: merita_rilascio()
--   (a) vende: >=1 ordine locale 30gg OPPURE rete 15gg OPPURE pin attivo
--   (b) disponibile: erp_stock>0 OR supplier_stock>0
--   (c) atterraggio <= 8 (<= 10 se vende in locale 30gg) sul PREZZO SECCO,
--       contato sull'ULTIMO scrape entro 48h; nessuno scrape fresco in 48h
--       = landing IGNOTA = false
-- Controlli dal piu' economico al piu' caro: la stragrande maggioranza
-- delle righe esce alla (b) con una sola lettura di products.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merita_rilascio(p_tenant uuid, p_sku text)
RETURNS boolean LANGUAGE plpgsql STABLE COST 1000 AS $fn$
DECLARE
  v_vivo          numeric;
  v_disp          boolean;
  v_vende_locale  boolean;
  v_pin           boolean;
  v_last          timestamptz;
  v_landing       integer;
BEGIN
  -- (b) disponibile + prezzo vivo FUORI dal feed (exported_price, non applied_price)
  SELECT COALESCE(p.exported_price, p.sell_price),
         (COALESCE(p.erp_stock, 0) > 0 OR COALESCE(p.supplier_stock, 0) > 0)
    INTO v_vivo, v_disp
  FROM products p
  WHERE p.tenant_id = p_tenant AND p.sku = p_sku;

  IF NOT COALESCE(v_disp, false) OR COALESCE(v_vivo, 0) <= 0 THEN
    RETURN false;
  END IF;

  -- (a) vende qui, o in rete, o il capo lo ha appuntato
  v_vende_locale := EXISTS (
    SELECT 1 FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.tenant_id = p_tenant AND oi.sku = p_sku
      AND o.tenant_id = p_tenant
      AND o.order_date >= NOW() - INTERVAL '30 days'
      AND o.order_status = ANY (stati_ordine_validi()));

  v_pin := EXISTS (
    SELECT 1 FROM capo_pins cp
    WHERE cp.tenant_id = p_tenant AND cp.sku = p_sku
      AND cp.revoked_at IS NULL
      AND (cp.expires_at IS NULL OR cp.expires_at > NOW()));

  -- il pin e' un INPUT della legge (soddisfa SOLO la (a)), non un bypass
  IF NOT (v_vende_locale OR v_pin OR vende_in_rete_15g(p_sku)) THEN
    RETURN false;
  END IF;

  -- (c) atterraggio sul prezzo secco, contato sull'ULTIMO scrape del
  -- product_code entro 48h — NON su tutta la finestra. scraper_competitors
  -- ha UNIQUE (product_code, merchant) e ogni merchant porta il proprio
  -- scraped_at: i concorrenti usciti dal listing nei cicli precedenti
  -- restano in tabella con un istante piu' vecchio e gonfiano il conteggio.
  -- Misurato 26/8: 59.118 product_code su 111.498 hanno >=2 istanti di
  -- scrape distinti in 48h (fino a 10). Sulla quarantena viva di rete che
  -- gia' passa (a) e (b) con scrape fresco — platea 847 — la finestra
  -- promuoveva 412 SKU contro i 523 dell'ultimo scrape: 111 respinti
  -- (-21,2%) per un conteggio sbagliato, non per demerito.
  -- NOW() liscio: scraped_at e' timestamptz (NON copiare il pattern
  -- AT TIME ZONE di pos_fresca: li' la finestra e' ~50h).
  SELECT MAX(sc.scraped_at) INTO v_last
  FROM scraper_competitors sc
  WHERE sc.product_code = p_sku
    AND sc.scraped_at >= NOW() - INTERVAL '48 hours';

  IF v_last IS NULL THEN
    RETURN false;   -- nessuno scrape fresco: landing IGNOTA, non 1
  END IF;

  SELECT 1 + COUNT(*) INTO v_landing
  FROM scraper_competitors sc
  WHERE sc.product_code = p_sku
    AND sc.scraped_at = v_last
    AND sc.base_price > 0
    AND sc.base_price < v_vivo;

  RETURN v_landing <= CASE WHEN v_vende_locale THEN 10 ELSE 8 END;
END
$fn$;

COMMENT ON FUNCTION public.merita_rilascio(uuid, text) IS
  'Legge unica del rilascio (GO capo 26/8): vende (locale 30gg / rete 15gg / pin) + disponibile + landing<=8 (10 se vende locale) contato sull''ULTIMO scrape entro 48h.';

-- ---------------------------------------------------------------------
-- SEZIONE 4 — VETO UNIFICATO sul rilascio
-- Sostituisce trg_veto_release_burner_rule e trg_veto_release_incidenza_alta
-- (le funzioni vecchie restano in DB, non referenziate, per rollback).
-- Regole:
--  * capo e sessione passano ENTRAMBI (bypass unificato, P1)
--  * tutti gli altri passano solo se merita_rilascio()
--  * sul rilascio ammesso: observation_start=NOW() e max_click_budget in EURO
--  * sulla respinta: observation_* RIPRISTINATI (fine delle scadenze avvelenate)
--  * log: sempre sui rilasci e sulle respinte FIRMATE; le respinte anonime
--    si scrivono al massimo UNA volta per SKU ogni 24h (misurato 26/8:
--    182.197 tentativi anonimi in 24h da sole 2.253 coppie tenant/sku:
--    -98,8% di righe, segnale intatto). Il conteggio esatto non si perde:
--    sta sulla riga, in veti_contatore/ultimo_veto_at.
--  * niente aggregate 30gg sulle respinte: seller_rev_7g/click_cost_7g = NULL
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.veto_release_unificato_fn()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
  v_classe text := writer_classe();
  v_vivo   numeric;
  v_costo  numeric;
BEGIN
  IF v_classe IN ('capo', 'sessione') OR merita_rilascio(NEW.tenant_id, NEW.sku) THEN
    SELECT COALESCE(p.exported_price, p.sell_price) INTO v_vivo
    FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;
    v_costo := costo_al(NEW.tenant_id, NEW.sku, CURRENT_DATE);

    -- L'osservazione la impone il trigger SOLO ai rilasci per merito. Se a
    -- rilasciare e' il capo o una sessione, gli observation_* restano come li
    -- ha scritti chi comanda (il paracadute di codaLungaLoop li azzera
    -- APPOSTA: rilascio integrale, nessun retest).
    IF v_classe NOT IN ('capo', 'sessione') THEN
      NEW.observation_start := NOW();
    END IF;
    NEW.max_click_budget := COALESCE(NEW.max_click_budget, CASE
      WHEN v_costo IS NULL OR v_vivo IS NULL THEN NULL          -- mai 0: NULL = non lo so
      ELSE ROUND(GREATEST(0, v_vivo - v_costo) * 1.5, 2) END);

    INSERT INTO burner_rule_reactivation_log(tenant_id, sku, writer, esito)
    VALUES (NEW.tenant_id, NEW.sku, v_writer,
            CASE WHEN v_classe IN ('capo','sessione') THEN 'rilasciato_writer'
                 ELSE 'rilasciato_merito' END);
    RETURN NEW;
  END IF;

  -- RESPINTA. Prima i contatori sulla riga: costano zero (siamo in BEFORE
  -- UPDATE, la riga si sta gia' riscrivendo) e sono ESATTI. Senza di loro il
  -- campionamento sotto trasformerebbe "tutto rumore" in "zero segnale": il
  -- POST-1h non saprebbe distinguere "nessuno bussa piu'" da "bussano e non
  -- li vediamo".
  NEW.veti_contatore := COALESCE(OLD.veti_contatore, 0) + 1;
  NEW.ultimo_veto_at := NOW();

  -- Log: per intero se il writer e' firmato (sono pochi e vanno visti tutti),
  -- campionato a 24h per SKU se e' anonimo (le amnistie di scraperPoller
  -- bussano ogni 5 minuti: erano ~172k righe/gg su 2.253 SKU).
  IF v_writer <> 'anonimo'
     OR OLD.ultimo_veto_log_at IS NULL
     OR OLD.ultimo_veto_log_at < NOW() - INTERVAL '24 hours' THEN
    INSERT INTO burner_rule_reactivation_log(tenant_id, sku, writer, esito)
    VALUES (NEW.tenant_id, NEW.sku, v_writer, 'ribloccato');
    NEW.ultimo_veto_log_at := NOW();
  END IF;

  NEW.reactivated          := false;
  NEW.reactivated_at       := OLD.reactivated_at;
  NEW.observation_start    := OLD.observation_start;
  NEW.observation_end      := OLD.observation_end;
  NEW.observation_clicks   := OLD.observation_clicks;
  NEW.observation_orders   := OLD.observation_orders;
  NEW.reactivation_check_at := OLD.reactivation_check_at;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_veto_release_burner_rule   ON feed_quarantine;
DROP TRIGGER IF EXISTS trg_veto_release_incidenza_alta ON feed_quarantine;
DROP TRIGGER IF EXISTS trg_veto_release_unificato      ON feed_quarantine;

CREATE TRIGGER trg_veto_release_unificato
  BEFORE UPDATE ON feed_quarantine
  FOR EACH ROW
  WHEN (NEW.reactivated IS TRUE AND OLD.reactivated IS DISTINCT FROM NEW.reactivated)
  EXECUTE FUNCTION veto_release_unificato_fn();

-- ---------------------------------------------------------------------
-- SEZIONE 5 — WHEN sul cambio VERO anche per la ricondanna
-- (prima trg_veto_ricondanna_q girava su ogni UPDATE con reactivated NOT TRUE,
--  cioe' anche false->false: vende_e_ripaga ~29ms a ogni tocco)
-- feed_actions (_r) NON si tocca: il rinfresco di un REMOVE esistente via
-- ON CONFLICT E' la ricondanna che quella guardia deve vedere.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_veto_ricondanna_q ON feed_quarantine;
CREATE TRIGGER trg_veto_ricondanna_q
  BEFORE UPDATE ON feed_quarantine
  FOR EACH ROW
  WHEN (OLD.reactivated IS TRUE AND NEW.reactivated IS NOT TRUE)
  EXECUTE FUNCTION trg_veto_ricondanna_fn();

DROP TRIGGER IF EXISTS trg_veto_ricondanna_k ON feed_killers;
CREATE TRIGGER trg_veto_ricondanna_k
  BEFORE UPDATE ON feed_killers
  FOR EACH ROW
  WHEN (OLD.is_active IS NOT TRUE AND NEW.is_active IS TRUE)
  EXECUTE FUNCTION trg_veto_ricondanna_fn();

-- ---------------------------------------------------------------------
-- SEZIONE 6 — C08: l'arbitro dei DELETE guarda la RIGA, non solo la firma
-- R1 invariata (058/102): il writer non firmato non tocca le fonti protette.
-- R2 nuova: nessun MOTORE, per quanto firmato, cancella una riga UMANA
--    (capo_pin, capo_%, sessione_%, manual, manual_pepita) che non sia sua.
--    'muro_scavalco' e 'manual_review' restano fuori dalla R2 apposta:
--    li cancellano i motori che li hanno scritti (sentinella muri, pricejump).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_arbitro_delete_fn()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
  v_classe TEXT := writer_classe();
BEGIN
  IF v_writer = 'anonimo' AND fonte_protetta(OLD.action_source) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value,
                                 writer, motivo, action_source)
    VALUES (OLD.tenant_id, OLD.sku, 'veto_arbitro', 'delete',
            COALESCE(OLD.recommended_price::text, OLD.action), 'DELETE bloccato', v_writer,
            'L3: fonte protetta - i delete anonimi non toccano il lavoro di sessione/capo',
            OLD.action_source);
    RETURN NULL;
  END IF;

  IF v_classe NOT IN ('capo','sessione')
     AND fonte_umana(OLD.action_source)
     AND COALESCE(OLD.action_source, '') <> v_writer THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value,
                                 writer, motivo, action_source)
    VALUES (OLD.tenant_id, OLD.sku, 'veto_arbitro', 'delete',
            COALESCE(OLD.recommended_price::text, OLD.action), 'DELETE bloccato', v_writer,
            'L3/C08: un motore firmato non cancella una riga umana',
            OLD.action_source);
    RETURN NULL;
  END IF;

  RETURN OLD;
END
$fn$;

-- ---------------------------------------------------------------------
-- SEZIONE 7 — BONIFICA delle scadenze avvelenate (SOLO DOPO i trigger)
-- Righe rimaste con observation_start scritto da un rilascio che il veto
-- ha respinto: checkReactivations filtra observation_start IS NULL, quindi
-- non sono MAI piu' state ritentate. Misurate 9.714 il 26/8 (erano 8.795
-- all'audit: crescono di ~300/gg finche' il P0 non e' deployato).
-- 0 righe brand-protette nella platea: veto_kill_brand_protetti non morde.
-- ---------------------------------------------------------------------
SELECT set_config('xhp.writer', 'sessione_bonifica_106', true),
       set_config('xhp.motivo', '106: azzero gli observation_* avvelenati dai rilasci respinti (audit 26/8)', true);

UPDATE feed_quarantine
SET observation_start  = NULL,
    observation_end    = NULL,
    observation_clicks = 0,
    observation_orders = 0
WHERE reactivated = false
  AND observation_start IS NOT NULL
  AND reactivated_at IS NULL;

-- ---------------------------------------------------------------------
INSERT INTO schema_migrations (filename) VALUES ('106_legge_unica_rilascio.sql')
ON CONFLICT (filename) DO NOTHING;
