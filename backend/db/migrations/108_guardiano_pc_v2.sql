-- 108 — GUARDIANO PC v2 (ordine capo 10/09/2026)
--
-- "il problema è che è cambiato il costo di acquisto e non hai ricalcolato il
--  prezzo dopo il cambio. devi fissare che ad ogni loop di dati i pc vengono
--  ricontrollati in base al costo attuale e ricalcolati o cancellati."
-- "il rialzo è accettato solo se un cambio di costo fa andare la marginalità
--  sotto il minimo consentito."
--
-- IL CASO CHE HA APERTO LA PRATICA
-- MPF 987650557 BETOTAL ADVANCE. Tagliato il 20/08 (`capo_spinta_mpf_2008`) a
-- 23,88 su un costo di 20,31 — merce comprata bene, in magazzino. Poi lo
-- scaffale si è svuotato (erp_stock 0, supplier_stock 601), il costo è salito
-- al riacquisto grossista 23,716 e il prezzo è rimasto fermo. Margine oggi:
-- 0,16 € = 0,69%. Il floor di fascia per quel prezzo è 16%.
--
-- PERCHÉ IL GUARDIANO v1 NON L'HA VISTO — TRE BUCHI
--  1. PERIMETRO. `reconfirm_price_cuts` guardava solo 8 sorgenti AI. Le
--     sorgenti `capo_%` e `pulizia_%` — 1.243 PC vivi — erano fuori.
--  2. BASELINE CHE CONDONA. Scattava solo su `costo_now > baseline`, e la
--     baseline dei PC preesistenti veniva scritta UGUALE al costo del momento:
--     chi era già rotto quando la baseline è nata non sarebbe scattato mai.
--     1.303 rotti erano senza baseline, 401 avevano baseline ma "costo non
--     salito rispetto a quella".
--  3. IL RIALZO ERA VIETATO. `trg_veto_rialzi_universale` azzera qualunque
--     recommended_price sopra il prezzo vivo. Il floor-safe sta SEMPRE sopra
--     il prezzo vivo quando il taglio è rotto: il braccio REVISE del guardiano
--     era morto per costruzione. In un mese: 33 rialzi tentati, 27 vetati.
--     Il guardiano contava i "revised" PRIMA di scrivere, quindi il log diceva
--     che aveva lavorato mentre il veto glielo azzerava dietro.
--
-- COSA CAMBIA QUI
--  A. `costo_riacquisto()`: quando lo scaffale è vuoto il costo giusto è quello
--     per RIcomprare dal grossista (supplier_min_cost), non il min_blended che
--     si porta dietro il prezzo d'acquisto vecchio del magazzino.
--  B. Eccezione chirurgica al veto rialzi: passa SOLO la riparazione firmata
--     dal guardiano, SOLO se il prezzo vivo è davvero rotto sul costo di
--     adesso, e SOLO fino al minimo di fascia — mai un centesimo sopra.
--  C. `reconfirm_price_cuts_v2()`: nessuna baseline nel giudizio, tutte le
--     sorgenti tranne le mani umane, e tre esiti soli — ricalcola, rialza al
--     minimo, cancella.
--  D. Gira a ogni loop dati (fine sync prodotti del tenant), non ogni 2h.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. COSTO DI RIACQUISTO
-- ---------------------------------------------------------------------------
-- costo_vero() prende erp_cost (min blended) quando lo scaffale è vuoto. Il min
-- blended è il più basso fra tutte le sorgenti, magazzino compreso: su un
-- prodotto finito continua a dire il prezzo a cui l'avevamo comprato allora,
-- che non è più comprabile. Qui: se resta merce a scaffale si pesa fra quello
-- che è costato davvero e quello che costa ricomprarlo; se lo scaffale è vuoto
-- vale solo il riacquisto.
CREATE OR REPLACE FUNCTION costo_riacquisto(p_tenant uuid, p_sku character varying)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN COALESCE(p.erp_stock, 0) > 0 THEN
      ( COALESCE(p.erp_stock, 0)
          * COALESCE(NULLIF(p.erp_purchase_cost,0), NULLIF(p.erp_cost,0), NULLIF(p.supplier_min_cost,0), 0)
      + COALESCE(p.supplier_stock, 0)
          * COALESCE(NULLIF(p.supplier_min_cost,0), NULLIF(p.erp_cost,0), 0) )
      / NULLIF(COALESCE(p.erp_stock,0) + COALESCE(p.supplier_stock,0), 0)
    ELSE
      COALESCE(NULLIF(p.supplier_min_cost,0), NULLIF(p.erp_cost,0), 0)
  END
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku;
$$;

COMMENT ON FUNCTION costo_riacquisto(uuid, character varying) IS
  'Costo per rimettere il pezzo sullo scaffale. Scaffale pieno: media pesata fra costo pagato e riacquisto. Scaffale vuoto: solo riacquisto grossista.';

-- prezzo minimo che regge il floor di fascia, arrotondato SEMPRE per eccesso
CREATE OR REPLACE FUNCTION pc_floor_safe(p_costo numeric, p_floor_pct numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_costo > 0 AND p_floor_pct < 100
              THEN CEIL(p_costo / (1 - p_floor_pct/100.0) * 100) / 100 END;
$$;

-- ---------------------------------------------------------------------------
-- B. ECCEZIONE AL VETO RIALZI — solo riparazione da aumento-costo
-- ---------------------------------------------------------------------------
-- La regola aurea resta: nessun motore raccomanda sopra il prezzo vivo. L'unico
-- varco è questo, e ha quattro chiavi che devono girare tutte insieme:
--   1. la firma è del guardiano PC;
--   2. l'azione è un PRICE_CUT;
--   3. il prezzo VIVO è davvero sotto il minimo di fascia sul costo di ADESSO
--      (se il prezzo vivo è sano, non c'è niente da riparare e il veto resta);
--   4. il prezzo nuovo non supera il minimo di fascia — si sale FINO al floor,
--      mai oltre. Il controllo è sulla fascia del prezzo NUOVO, così un rialzo
--      che scavalca il confine di fascia non si autoassolve.
CREATE OR REPLACE FUNCTION trg_veto_rialzi_universale_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_vivo   NUMERIC;
  v_costo  NUMERIC;
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF NEW.recommended_price IS NOT NULL THEN
    SELECT COALESCE(p.applied_price, p.exported_price, p.sell_price) INTO v_vivo
    FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;

    IF v_vivo IS NOT NULL AND NEW.recommended_price > v_vivo + 0.005 THEN

      v_costo := costo_riacquisto(NEW.tenant_id, NEW.sku);

      IF v_writer = 'sessione_pc_guardian'
         AND NEW.action = 'PRICE_CUT'
         AND v_costo > 0
         AND v_vivo > 0
         AND (v_vivo - v_costo) / v_vivo * 100 < pc_floor_pct(v_vivo)
         AND (NEW.recommended_price - v_costo) / NEW.recommended_price * 100
             <= pc_floor_pct(NEW.recommended_price) + 1.0
      THEN
        INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
        VALUES (NEW.tenant_id, NEW.sku, 'rialzo_riparazione', 'recommended_price',
                v_vivo::text || ' (vivo, margine ' || ROUND((v_vivo-v_costo)/v_vivo*100,2)::text || '%)',
                NEW.recommended_price::text || ' (floor ' || pc_floor_pct(NEW.recommended_price)::text || '%)',
                v_writer,
                'eccezione capo 10/09: il rialzo passa solo se il costo ha portato il margine sotto il minimo',
                NEW.action_source);
        RETURN NEW;
      END IF;

      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', 'recommended_price',
              v_vivo::text || ' (prezzo vivo)', NEW.recommended_price::text || ' (RIALZO bloccato)',
              v_writer,
              'L1 regola aurea: mai raccomandare sopra il prezzo vivo', NEW.action_source);
      NEW.recommended_price := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- C. REGISTRI
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pc_guardian_log (
  id            bigserial PRIMARY KEY,
  girato_il     timestamptz NOT NULL DEFAULT NOW(),
  tenant_id     uuid,
  tenant        text,
  sku           character varying,
  action_id     bigint,
  action_source character varying,
  esito         text,
  prezzo_vivo   numeric,
  prezzo_esposto numeric,
  costo         numeric,
  margine_pct   numeric,
  floor_pct     numeric,
  floor_safe    numeric,
  sell_price    numeric,
  best_ext      numeric,
  motivo        text
);
CREATE INDEX IF NOT EXISTS pc_guardian_log_giro ON pc_guardian_log(girato_il DESC);
CREATE INDEX IF NOT EXISTS pc_guardian_log_sku  ON pc_guardian_log(tenant_id, sku);

-- Il cestino: ogni PC cancellato dal guardiano ci finisce intero. Un taglio
-- ritirato per costo salito è reversibile finché la riga esiste.
CREATE TABLE IF NOT EXISTS pc_guardian_cestino (
  id          bigserial PRIMARY KEY,
  cestinato_il timestamptz NOT NULL DEFAULT NOW(),
  tenant_id   uuid,
  sku         character varying,
  motivo      text,
  riga        jsonb
);
CREATE INDEX IF NOT EXISTS pc_guardian_cestino_q ON pc_guardian_cestino(tenant_id, sku, cestinato_il DESC);

-- ---------------------------------------------------------------------------
-- D. IL GUARDIANO v2
-- ---------------------------------------------------------------------------
-- p_dry   : true = misura e scrive solo il registro, nessun tocco alle azioni
-- p_tenant: NULL = tutta la rete; valorizzato = solo quel tenant (loop dati)
-- p_cap   : quanti PC riparare al massimo per tenant in un giro, i peggiori
--           prima. Il resto resta in coda e lo prende il giro dopo.
CREATE OR REPLACE FUNCTION reconfirm_price_cuts_v2(
  p_dry     boolean DEFAULT true,
  p_tenant  uuid    DEFAULT NULL,
  p_cap     integer DEFAULT 250
) RETURNS TABLE(esito text, tenant text, n bigint)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_op    text[] := ARRAY['Papa','Farmacia Procaccini','MPF','Farmainsieme',
                          'Farmastelia','Farmacia Mandanici','SubitoFarma'];
  -- mani umane vere: l'arbitro dice che non si spengono da soli. Le tocchiamo
  -- solo se il prezzo è finito SOTTO il costo, che non è una decisione ma un
  -- difetto.
  v_mano  text[] := ARRAY['manual','manual_review','capo_pin'];
BEGIN
  PERFORM set_config('xhp.writer', 'sessione_pc_guardian', true);
  PERFORM set_config('xhp.motivo',
    'guardiano PC v2 (capo 10/09): ricontrollo su costo di adesso a ogni loop dati - ricalcola, rialza al minimo di fascia, o cancella', true);

  DROP TABLE IF EXISTS _g;
  CREATE TEMP TABLE _g ON COMMIT DROP AS
  SELECT fa.id AS action_id, fa.tenant_id, t.name::text AS tname, fa.sku,
         fa.action_source::text AS action_source,
         fa.recommended_price AS rp,
         COALESCE(p.applied_price, p.exported_price, p.sell_price) AS prezzo_vivo,
         p.sell_price,
         costo_riacquisto(fa.tenant_id, fa.sku) AS costo,
         (SELECT MIN(sc.base_price) FROM scraper_competitors sc
           WHERE sc.product_code = fa.sku
             AND sc.scraped_at > NOW() - INTERVAL '48 hours'
             AND sc.base_price > 0
             AND sc.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'
         ) AS best_ext
  FROM feed_actions fa
  JOIN tenants t  ON t.id = fa.tenant_id AND t.name = ANY(v_op)
  JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
  WHERE fa.action = 'PRICE_CUT'
    AND fa.status IN ('pending','dispatched','active')
    AND (p_tenant IS NULL OR fa.tenant_id = p_tenant);

  -- prezzo esposto = il più basso fra quello che la raccomandazione chiede e
  -- quello che il negozio mostra: è quello il pezzo che perde.
  ALTER TABLE _g ADD COLUMN p_esposto numeric,
                 ADD COLUMN margine_pct numeric,
                 ADD COLUMN floor_pct numeric,
                 ADD COLUMN floor_safe numeric,
                 ADD COLUMN esito text;

  UPDATE _g SET p_esposto = LEAST(COALESCE(NULLIF(rp,0), prezzo_vivo),
                                  COALESCE(prezzo_vivo, NULLIF(rp,0)));
  UPDATE _g SET
    margine_pct = CASE WHEN p_esposto > 0 AND costo > 0
                       THEN ROUND((p_esposto - costo) / p_esposto * 100, 2) END,
    -- SubitoFarma ha un floor suo, dichiarato dal titolare: 11% di ricarico sul
    -- costo, non il minimo di fascia. Lo rispettiamo.
    floor_pct   = CASE WHEN tname = 'SubitoFarma' THEN 11 ELSE pc_floor_pct(p_esposto) END
  WHERE p_esposto > 0;
  UPDATE _g SET floor_safe = CASE
      WHEN tname = 'SubitoFarma' THEN CEIL(costo * 1.11 * 100) / 100
      ELSE pc_floor_safe(costo, floor_pct) END
  WHERE costo > 0 AND p_esposto > 0;

  -- ---- classificazione ----------------------------------------------------
  UPDATE _g SET esito = CASE
    WHEN p_esposto IS NULL OR p_esposto <= 0 OR costo IS NULL OR costo <= 0
      THEN 'saltato_dato_assente'
    -- sotto costo secco: nessuna eccezione lo copre, è un difetto
    WHEN margine_pct <= 0 THEN 'da_riparare'
    WHEN action_source = ANY(v_mano) THEN 'segnalato_mano_umana'
    WHEN margine_pct >= floor_pct THEN 'sano'
    ELSE 'da_riparare'
  END;

  -- cap per tenant: i peggiori prima, il resto in coda al giro dopo
  IF p_cap IS NOT NULL AND p_cap > 0 THEN
    UPDATE _g g SET esito = 'in_coda'
    FROM (SELECT action_id, ROW_NUMBER() OVER (PARTITION BY tname ORDER BY margine_pct ASC) AS rn
          FROM _g WHERE esito = 'da_riparare') r
    WHERE g.action_id = r.action_id AND r.rn > p_cap;
  END IF;

  -- ---- che riparazione ----------------------------------------------------
  UPDATE _g SET esito = CASE
    -- il costo è SCESO: si abbassa. Nessun veto da chiedere.
    WHEN floor_safe <= prezzo_vivo - 0.005 THEN 'ricalcolato_giu'
    -- il costo è SALITO: si sale fino al minimo, ma solo se sotto il listino FB
    -- (sopra il listino un "taglio" non è più un taglio, e trg_veto_sotto_costo
    -- lo azzererebbe comunque).
    WHEN sell_price > 0 AND floor_safe <= sell_price - 0.01 THEN 'rialzo_riparazione'
    ELSE 'cancellato'
  END
  WHERE esito = 'da_riparare';

  IF p_dry THEN
    INSERT INTO pc_guardian_log (tenant_id, tenant, sku, action_id, action_source, esito,
        prezzo_vivo, prezzo_esposto, costo, margine_pct, floor_pct, floor_safe, sell_price, best_ext, motivo)
    SELECT tenant_id, tname, sku, action_id, action_source, esito || ' (prova)',
           prezzo_vivo, p_esposto, costo, margine_pct, floor_pct, floor_safe, sell_price, best_ext,
           'giro a vuoto'
    FROM _g WHERE esito NOT IN ('sano','in_coda');
    RETURN QUERY SELECT g.esito, g.tname, COUNT(*)::bigint FROM _g g GROUP BY 1,2;
    RETURN;
  END IF;

  -- ---- scrittura ----------------------------------------------------------
  -- 1) i due rami che cambiano il prezzo raccomandato
  UPDATE feed_actions fa SET
    recommended_price = g.floor_safe,
    action_reason = CASE WHEN g.esito = 'rialzo_riparazione'
      THEN 'guardiano PC: costo salito a ' || ROUND(g.costo,2) || ', margine ' || g.margine_pct
           || '% sotto il minimo ' || g.floor_pct || '% - riportato al minimo ' || g.floor_safe
      ELSE 'guardiano PC: costo sceso a ' || ROUND(g.costo,2) || ' - ricalcolato a ' || g.floor_safe END,
    computed_at = NOW()
  FROM _g g
  WHERE fa.id = g.action_id
    AND g.esito IN ('rialzo_riparazione','ricalcolato_giu')
    AND g.floor_safe > 0
    AND g.floor_safe IS DISTINCT FROM fa.recommended_price;

  -- 2) se un veto a monte (muro, perimetro cut, sconto) ha azzerato la
  --    riparazione, il taglio resta rotto e senza prezzo: si cancella.
  UPDATE _g g SET esito = 'cancellato_veto'
  FROM feed_actions fa
  WHERE fa.id = g.action_id
    AND g.esito IN ('rialzo_riparazione','ricalcolato_giu')
    AND fa.recommended_price IS NULL;

  -- 3) cestino prima di cancellare
  INSERT INTO pc_guardian_cestino (tenant_id, sku, motivo, riga)
  SELECT fa.tenant_id, fa.sku,
         'guardiano PC: costo ' || ROUND(g.costo,2) || ', margine ' || COALESCE(g.margine_pct,0)
         || '% sotto il minimo ' || COALESCE(g.floor_pct,0) || '%, minimo ' || COALESCE(g.floor_safe,0)
         || ' non sta sotto il listino ' || COALESCE(g.sell_price,0),
         to_jsonb(fa)
  FROM feed_actions fa JOIN _g g ON g.action_id = fa.id
  WHERE g.esito IN ('cancellato','cancellato_veto');

  DELETE FROM feed_actions fa USING _g g
  WHERE fa.id = g.action_id AND g.esito IN ('cancellato','cancellato_veto');

  INSERT INTO pc_guardian_log (tenant_id, tenant, sku, action_id, action_source, esito,
      prezzo_vivo, prezzo_esposto, costo, margine_pct, floor_pct, floor_safe, sell_price, best_ext, motivo)
  SELECT tenant_id, tname, sku, action_id, action_source, esito,
         prezzo_vivo, p_esposto, costo, margine_pct, floor_pct, floor_safe, sell_price, best_ext,
         'giro applicato'
  FROM _g WHERE esito NOT IN ('sano','in_coda');

  RETURN QUERY SELECT g.esito, g.tname, COUNT(*)::bigint FROM _g g GROUP BY 1,2;
END $$;

COMMENT ON FUNCTION reconfirm_price_cuts_v2(boolean, uuid, integer) IS
  'Guardiano PC v2 (capo 10/09): a ogni loop dati ricontrolla ogni PC vivo sul costo di riacquisto di adesso. Ricalcola, rialza fino al minimo di fascia, o cancella. Niente baseline, tutte le sorgenti tranne le mani umane.';

INSERT INTO schema_migrations (filename)
SELECT '108_guardiano_pc_v2.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '108_guardiano_pc_v2.sql');

COMMIT;
