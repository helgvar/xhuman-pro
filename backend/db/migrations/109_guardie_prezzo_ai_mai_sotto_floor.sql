-- =============================================================================
-- 109 — GUARDIE: UN PREZZO AI NON PUO' STARE SOTTO IL FLOOR. MAI.
--
-- Ordine capo 10/09 (secondo giro):
--   "devi avere la certezza che stai calcolando i prezzi con i costi giusti
--    farmacia o grossista. il prezzo ai va ricontrollato ad ogni loop per
--    valutare se e' cambiato il prezzo. Devi eseguire tutti i controlli e
--    assegnare piu' guardie che controllano questo aspetto. per niente al mondo
--    i prezzi ai possono andare sotto floor. non esiste nessun veto o nessun
--    ordine manuale che puo' bloccare il ricalcolo di un prezzo ai che va sotto
--    floor"
--
-- Cosa cambia rispetto alla 108:
--
-- 1) CERTEZZA SUL COSTO — costo_guardia().
--    costo_riacquisto() (108) fa una MEDIA PESATA fra scaffale e grossista
--    quando c'e' giacenza in farmacia. La media non e' certezza: su 731 PC con
--    scaffale, il grossista costa piu' della farmacia in 467 casi, e 354
--    scaffali hanno al massimo 2 pezzi (finzione contabile: il pezzo dopo lo
--    ricompri dal grossista). Misurato 10/09: passando al costo prudente
--    cambiano classe 14 PC di rete (Mandanici 8, SubitoFarma 8, Procaccini 3,
--    Farmainsieme 3, Papa 1). Costa poco, chiude il buco.
--    costo_guardia = il PIU' ALTO fra costo di scaffale e costo di riacquisto:
--    il prezzo deve reggere anche quando lo scaffale finisce.
--    costo_fonte() dice sempre da dove viene il numero (farmacia / grossista /
--    tutti e due / assente): la certezza si scrive nel log, non si assume.
--
-- 2) NESSUN VETO PUO' BLOCCARE LA RIPARAZIONE.
--    trg_veto_rialzi_universale lasciava passare il rialzo di riparazione solo
--    al writer 'sessione_pc_guardian'. Ora passa a CHIUNQUE, purche' sia una
--    riparazione vera: il margine al prezzo vivo e' sotto il minimo E il prezzo
--    proposto non supera il minimo. Ogni passaggio resta scritto in
--    azioni_touch_log.
--
-- 3) NESSUN ORDINE MANUALE PUO' BLOCCARLA.
--    manual / manual_review / capo_pin non sono piu' esenti: se un prezzo sta
--    sotto il floor viene riparato come tutti gli altri. Resta scritto nel log
--    (mano_umana = true) perche' il capo veda quali mani sono state toccate.
--
-- 4) COSTO NON VERIFICABILE = TAGLIO CANCELLATO.
--    Se il costo non esiste (nessuna delle tre fonti valorizzata: 126 PC di
--    rete al 10/09, tutti su prodotti senza giacenza da nessuna parte) il floor
--    non e' misurabile. Un taglio che non si puo' verificare non puo' restare
--    vivo: si cancella (copia integrale nel cestino). Prima veniva solo saltato.
--
-- 5) DATI STANTII = GUARDIA FERMA (fail-closed).
--    Se l'ultimo import prodotti del tenant e' piu' vecchio di 12h, il costo di
--    "adesso" non e' di adesso: il tenant viene saltato con esito dichiarato
--    'fermo_dati_stantii'. Mai riparare su un costo vecchio.
--
-- 6) LEGGE DEL COSTO (ordine capo 10/09 #3):
--      "non si calcolano prezzi di vendita se il costo non e' aggiornato e tutti
--       i pc vanno rivalutati ad ogni aggiornamento per valutare se il costo di
--       riferimento e' cambiato. Tutta la macchina si mantiene sul costo. se
--       sbagliamo a calcolare il prezzo perche' non vediamo il costo diventa
--       tutto vano."
--    Tradotta in macchina:
--      a) costo_fresco() misura la freschezza sul dato che si muove davvero:
--         products.updated_at, riscritto a OGNI import (misurato 10/09: tutte le
--         660.032 righe dei 7 tenant operativi aggiornate entro 2h). Soglia 12h.
--      b) nessun prezzo di vendita viene CALCOLATO su un costo vecchio: ne' dal
--         guardiano, ne' da nessun motore (la guardia G3 azzera in scrittura).
--      c) un taglio gia' sotto il floor con costo vecchio non si ricalcola ma si
--         CANCELLA: tornare al listino FB non richiede di calcolare niente, e
--         lasciarlo esposto violerebbe "mai sotto floor".
--      d) niente tetto: a ogni giro vengono rivalutati e riparati TUTTI i PC
--         vivi del tenant, non i primi N.
--
-- LE 5 GUARDIE (ordine capo: "assegnare piu' guardie"):
--   G1  productSync.js  — a ogni loop di dati, per tenant, subito dopo l'import
--   G2  pcGuardianCron  — rete di sicurezza di rete ogni 2h
--   G3  zz_trg_pc_mai_sotto_floor — trigger DB in SCRITTURA: nessun motore puo'
--       scrivere un PRICE_CUT sotto il floor, viene alzato al minimo o annullato
--   G4  pc_sotto_floor_adesso() — sentinella: conta i vivi sotto floor, deve
--       leggere ZERO; se non legge zero, ripara e avvisa
--   G5  pc_guardian_log — registro storico di ogni giudizio, con la fonte del
--       costo scritta accanto: la prova che il numero era misurato
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. COSTO CERTO
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION costo_guardia(p_tenant uuid, p_sku varchar)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT GREATEST(
    -- costo di scaffale: vale solo se lo scaffale esiste davvero
    CASE WHEN COALESCE(p.erp_stock,0) > 0
         THEN COALESCE(NULLIF(p.erp_purchase_cost,0), NULLIF(p.erp_cost,0), 0)
         ELSE 0 END,
    -- costo di riacquisto: quanto costa il pezzo DOPO quello che vendo adesso
    COALESCE(NULLIF(p.supplier_min_cost,0), NULLIF(p.erp_cost,0), 0)
  )
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku;
$$;

COMMENT ON FUNCTION costo_guardia(uuid, varchar) IS
  'Costo prudente per il floor: il piu'' alto fra scaffale farmacia (solo se erp_stock>0) e riacquisto grossista. Il prezzo deve reggere anche quando lo scaffale finisce. Ordine capo 10/09.';

CREATE OR REPLACE FUNCTION costo_fonte(p_tenant uuid, p_sku varchar)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p.sku IS NULL THEN 'prodotto_assente'
    WHEN COALESCE(NULLIF(p.erp_purchase_cost,0), NULLIF(p.erp_cost,0), NULLIF(p.supplier_min_cost,0), 0) <= 0
      THEN 'assente'
    WHEN COALESCE(p.erp_stock,0) > 0 AND COALESCE(p.supplier_stock,0) > 0 THEN 'farmacia+grossista'
    WHEN COALESCE(p.erp_stock,0) > 0 THEN 'farmacia'
    WHEN COALESCE(p.supplier_stock,0) > 0 THEN 'grossista'
    ELSE 'listino_senza_giacenza'
  END
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku;
$$;

-- ---------------------------------------------------------------------------
-- 2. FLOOR IN UN POSTO SOLO (la regola non si riscrive in 3 motori diversi)
-- ---------------------------------------------------------------------------
-- Freschezza del costo: si misura su products.updated_at, che l'import di
-- Farmabooster riscrive su OGNI riga a ogni giro. Non sul registro a gradini
-- (quello si muove solo quando il costo cambia: un costo fermo da 3 giorni ma
-- riletto 10 minuti fa e' fresco, e il registro non lo direbbe).
CREATE OR REPLACE FUNCTION costo_fresco(p_tenant uuid, p_sku varchar, p_ore numeric DEFAULT 12)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT p.updated_at > NOW() - (p_ore || ' hours')::interval
       FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku),
    false);
$$;

COMMENT ON FUNCTION costo_fresco(uuid, varchar, numeric) IS
  'Legge capo 10/09: non si calcolano prezzi di vendita se il costo non e'' aggiornato. Freschezza letta su products.updated_at (riscritto a ogni import), soglia 12h.';

CREATE OR REPLACE FUNCTION pc_floor_pct_tenant(p_tenant uuid, p_prezzo numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  -- SubitoFarma ha un floor suo, dichiarato dal titolare: 11% di ricarico sul
  -- costo. Per tutti gli altri vale il minimo di fascia (margine sul prezzo).
  SELECT CASE WHEN (SELECT t.name FROM tenants t WHERE t.id = p_tenant) = 'SubitoFarma'
              THEN 11 ELSE pc_floor_pct(p_prezzo) END;
$$;

CREATE OR REPLACE FUNCTION pc_floor_prezzo(p_tenant uuid, p_prezzo numeric, p_costo numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_costo IS NULL OR p_costo <= 0 THEN NULL
    WHEN (SELECT t.name FROM tenants t WHERE t.id = p_tenant) = 'SubitoFarma'
      THEN CEIL(p_costo * 1.11 * 100) / 100
    ELSE pc_floor_safe(p_costo, pc_floor_pct(p_prezzo))
  END;
$$;

-- ---------------------------------------------------------------------------
-- 3. NESSUN VETO BLOCCA LA RIPARAZIONE (ordine capo 10/09 #2)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_veto_rialzi_universale_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_vivo   NUMERIC;
  v_costo  NUMERIC;
  v_floor  NUMERIC;
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF NEW.recommended_price IS NOT NULL THEN
    SELECT COALESCE(p.applied_price, p.exported_price, p.sell_price) INTO v_vivo
    FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;

    IF v_vivo IS NOT NULL AND NEW.recommended_price > v_vivo + 0.005 THEN

      v_costo := costo_guardia(NEW.tenant_id, NEW.sku);
      v_floor := pc_floor_pct_tenant(NEW.tenant_id, v_vivo);

      -- ECCEZIONE UNICA alla regola aurea "niente rialzi", ordine capo 10/09:
      -- il rialzo passa SOLO se e' un cambio di costo ad aver portato il margine
      -- sotto il minimo consentito, e SOLO fino al minimo. Non e' una spinta di
      -- prezzo: e' la riparazione di un prezzo diventato illegale.
      -- Ordine capo 10/09 #2: vale per QUALSIASI writer, non solo il guardiano.
      IF NEW.action = 'PRICE_CUT'
         AND v_costo > 0
         AND v_vivo > 0
         AND (v_vivo - v_costo) / v_vivo * 100 < v_floor
         AND (NEW.recommended_price - v_costo) / NEW.recommended_price * 100
             <= pc_floor_pct_tenant(NEW.tenant_id, NEW.recommended_price) + 1.0
      THEN
        INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
        VALUES (NEW.tenant_id, NEW.sku, 'rialzo_riparazione', 'recommended_price',
                v_vivo::text || ' (vivo, margine ' || ROUND((v_vivo-v_costo)/v_vivo*100,2)::text || '%)',
                NEW.recommended_price::text || ' (minimo ' || v_floor::text || '%)',
                v_writer,
                'ordine capo 10/09: il rialzo passa solo se il costo ha portato il margine sotto il minimo, e solo fino al minimo. Nessun veto lo blocca.',
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
-- 4. GUARDIA G3 — IN SCRITTURA. L'ULTIMA PAROLA.
--    Nome 'zz_' apposta: i trigger BEFORE scattano in ordine alfabetico, questo
--    scatta DOPO tutti i veti. Qualunque cosa abbiano deciso gli altri, un
--    PRICE_CUT sotto il floor non esce da qui.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_pc_mai_sotto_floor_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_costo   NUMERIC;
  v_floorp  NUMERIC;
  v_safe    NUMERIC;
  v_listino NUMERIC;
  v_writer  TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF NEW.action IS DISTINCT FROM 'PRICE_CUT' OR NEW.recommended_price IS NULL THEN
    RETURN NEW;
  END IF;

  -- LEGGE DEL COSTO (capo 10/09): non si calcola un prezzo di vendita su un
  -- costo vecchio. Prima ancora di guardare il numero, si guarda la data.
  IF NOT costo_fresco(NEW.tenant_id, NEW.sku, 12) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'blocco_costo_vecchio', 'recommended_price',
            NEW.recommended_price::text, 'NULL (costo non aggiornato da oltre 12h)', v_writer,
            'legge capo 10/09: non si calcolano prezzi di vendita se il costo non e'' aggiornato',
            NEW.action_source);
    NEW.recommended_price := NULL;
    RETURN NEW;
  END IF;

  v_costo := costo_guardia(NEW.tenant_id, NEW.sku);

  -- costo non misurabile: il floor non e' verificabile, quindi il prezzo non si
  -- puo' garantire. Non si scrive.
  IF v_costo IS NULL OR v_costo <= 0 THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'blocco_sotto_floor', 'recommended_price',
            NEW.recommended_price::text, 'NULL (costo non misurabile)', v_writer,
            'guardia G3: senza costo il floor non e'' verificabile - nessun prezzo AI puo'' uscire non verificato',
            NEW.action_source);
    NEW.recommended_price := NULL;
    RETURN NEW;
  END IF;

  v_floorp := pc_floor_pct_tenant(NEW.tenant_id, NEW.recommended_price);
  v_safe   := pc_floor_prezzo(NEW.tenant_id, NEW.recommended_price, v_costo);

  IF v_safe IS NULL OR NEW.recommended_price >= v_safe - 0.005 THEN
    RETURN NEW;                    -- sopra il minimo: passa
  END IF;

  SELECT p.sell_price INTO v_listino
  FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;

  IF v_listino IS NOT NULL AND v_listino > 0 AND v_safe <= v_listino - 0.01 THEN
    -- il minimo sta ancora sotto il listino FB: il taglio esiste, ma al minimo
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'alzato_al_floor', 'recommended_price',
            NEW.recommended_price::text || ' (margine ' ||
              ROUND((NEW.recommended_price - v_costo)/NEW.recommended_price*100, 2)::text || '%)',
            v_safe::text || ' (minimo ' || v_floorp::text || '%)', v_writer,
            'guardia G3 (ordine capo 10/09): per niente al mondo un prezzo AI sotto il floor - costo ' || ROUND(v_costo,2)::text,
            NEW.action_source);
    NEW.recommended_price := v_safe;
  ELSE
    -- il minimo supera il listino: qui un taglio non puo' esistere
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'blocco_sotto_floor', 'recommended_price',
            NEW.recommended_price::text, 'NULL (minimo ' || v_safe::text || ' sopra il listino ' || COALESCE(v_listino,0)::text || ')',
            v_writer,
            'guardia G3 (ordine capo 10/09): costo ' || ROUND(v_costo,2)::text || ' - nessun taglio possibile sopra il floor, torna alla regola FB',
            NEW.action_source);
    NEW.recommended_price := NULL;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS zz_trg_pc_mai_sotto_floor ON feed_actions;
CREATE TRIGGER zz_trg_pc_mai_sotto_floor
  BEFORE INSERT OR UPDATE ON feed_actions
  FOR EACH ROW EXECUTE FUNCTION trg_pc_mai_sotto_floor_fn();

-- ---------------------------------------------------------------------------
-- 5. GUARDIA G4 — SENTINELLA. Deve leggere zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pc_sotto_floor_adesso(p_tenant uuid DEFAULT NULL)
RETURNS TABLE(tenant text, sku varchar, action_source text, prezzo_vivo numeric,
              costo numeric, fonte_costo text, costo_fresco boolean, margine_pct numeric,
              floor_pct numeric, floor_safe numeric, sell_price numeric)
LANGUAGE sql STABLE AS $$
  SELECT t.name::text, fa.sku, fa.action_source::text,
         COALESCE(p.applied_price, p.exported_price, p.sell_price) AS prezzo_vivo,
         costo_guardia(fa.tenant_id, fa.sku) AS costo,
         costo_fonte(fa.tenant_id, fa.sku) AS fonte_costo,
         costo_fresco(fa.tenant_id, fa.sku, 12) AS costo_fresco,
         ROUND((COALESCE(p.applied_price,p.exported_price,p.sell_price) - costo_guardia(fa.tenant_id,fa.sku))
               / NULLIF(COALESCE(p.applied_price,p.exported_price,p.sell_price),0) * 100, 2) AS margine_pct,
         pc_floor_pct_tenant(fa.tenant_id, COALESCE(p.applied_price,p.exported_price,p.sell_price)) AS floor_pct,
         pc_floor_prezzo(fa.tenant_id, COALESCE(p.applied_price,p.exported_price,p.sell_price),
                         costo_guardia(fa.tenant_id, fa.sku)) AS floor_safe,
         p.sell_price
    FROM feed_actions fa
    JOIN tenants t  ON t.id = fa.tenant_id
    JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
   WHERE fa.action = 'PRICE_CUT'
     AND fa.status IN ('pending','dispatched','active')
     AND t.name IN ('Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmastelia','Farmacia Mandanici','SubitoFarma')
     AND (p_tenant IS NULL OR fa.tenant_id = p_tenant)
     AND COALESCE(p.applied_price, p.exported_price, p.sell_price) > 0
     AND costo_guardia(fa.tenant_id, fa.sku) > 0
     AND (COALESCE(p.applied_price,p.exported_price,p.sell_price) - costo_guardia(fa.tenant_id,fa.sku))
         / COALESCE(p.applied_price,p.exported_price,p.sell_price) * 100
         < pc_floor_pct_tenant(fa.tenant_id, COALESCE(p.applied_price,p.exported_price,p.sell_price));
$$;

COMMENT ON FUNCTION pc_sotto_floor_adesso(uuid) IS
  'Sentinella G4: price cut vivi il cui prezzo esposto sta sotto il minimo consentito sul costo di adesso. Dopo un giro del guardiano deve tornare ZERO.';

-- ---------------------------------------------------------------------------
-- 6. LOG: scriviamo anche DA DOVE viene il costo (certezza, non assunzione)
-- ---------------------------------------------------------------------------
ALTER TABLE pc_guardian_log ADD COLUMN IF NOT EXISTS fonte_costo text;
ALTER TABLE pc_guardian_log ADD COLUMN IF NOT EXISTS mano_umana boolean DEFAULT false;
ALTER TABLE pc_guardian_log ADD COLUMN IF NOT EXISTS costo_fresco boolean;
ALTER TABLE pc_guardian_log ADD COLUMN IF NOT EXISTS costo_letto_il timestamptz;

-- ---------------------------------------------------------------------------
-- 7. IL GUARDIANO, seconda stesura
-- ---------------------------------------------------------------------------
-- p_cap NULL di default: legge capo 10/09, a ogni aggiornamento vengono
-- rivalutati e riparati TUTTI i price cut vivi, non i primi N. Il parametro
-- resta solo come freno d'emergenza.
CREATE OR REPLACE FUNCTION reconfirm_price_cuts_v2(
  p_dry boolean DEFAULT true,
  p_tenant uuid DEFAULT NULL,
  p_cap integer DEFAULT NULL
) RETURNS TABLE(esito text, tenant text, n bigint)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_op   text[] := ARRAY['Papa','Farmacia Procaccini','MPF','Farmainsieme',
                         'Farmastelia','Farmacia Mandanici','SubitoFarma'];
  v_mano text[] := ARRAY['manual','manual_review','capo_pin'];
BEGIN
  PERFORM set_config('xhp.writer', 'sessione_pc_guardian', true);
  PERFORM set_config('xhp.motivo',
    'guardiano PC (capo 10/09): nessun prezzo AI sotto il floor - ricontrollo a ogni loop dati sul costo prudente di adesso', true);

  -- Fotografia della freschezza per tenant: serve al referto, non a escludere.
  -- L'esclusione avviene per RIGA (costo_fresco), cosi' un tenant con l'import
  -- indietro non lascia comunque un taglio rotto esposto: quello si cancella.
  DROP TABLE IF EXISTS _fresh;
  CREATE TEMP TABLE _fresh ON COMMIT DROP AS
  SELECT t.id AS tenant_id, t.name::text AS tname,
         (SELECT MAX(ij.completed_at) FROM import_jobs ij
           WHERE ij.tenant_id = t.id
             AND ij.job_type IN ('products_sync','products_import')
             AND ij.status = 'completed') AS ultimo_import
    FROM tenants t WHERE t.name = ANY(v_op);

  DROP TABLE IF EXISTS _g;
  CREATE TEMP TABLE _g ON COMMIT DROP AS
  SELECT fa.id AS action_id, fa.tenant_id, f.tname, fa.sku,
         fa.action_source::text AS action_source,
         (fa.action_source::text = ANY(v_mano)) AS mano_umana,
         fa.recommended_price AS rp,
         COALESCE(p.applied_price, p.exported_price, p.sell_price) AS prezzo_vivo,
         p.sell_price,
         costo_guardia(fa.tenant_id, fa.sku) AS costo,
         costo_fonte(fa.tenant_id, fa.sku)   AS fonte_costo,
         costo_fresco(fa.tenant_id, fa.sku, 12) AS costo_fresco,
         p.updated_at AS costo_letto_il,
         (SELECT MIN(sc.base_price) FROM scraper_competitors sc
           WHERE sc.product_code = fa.sku
             AND sc.scraped_at > NOW() - INTERVAL '48 hours'
             AND sc.base_price > 0
             AND sc.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'
         ) AS best_ext
  FROM feed_actions fa
  JOIN _fresh f   ON f.tenant_id = fa.tenant_id
  JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
  WHERE fa.action = 'PRICE_CUT'
    AND fa.status IN ('pending','dispatched','active')
    AND (p_tenant IS NULL OR fa.tenant_id = p_tenant);

  ALTER TABLE _g ADD COLUMN p_esposto numeric,
                 ADD COLUMN margine_pct numeric,
                 ADD COLUMN floor_pct numeric,
                 ADD COLUMN floor_safe numeric,
                 ADD COLUMN esito text;

  -- il pezzo che perde e' quello esposto: il piu' basso fra prezzo vivo e
  -- prezzo raccomandato.
  UPDATE _g SET p_esposto = LEAST(COALESCE(NULLIF(rp,0), prezzo_vivo),
                                  COALESCE(prezzo_vivo, NULLIF(rp,0)));
  UPDATE _g SET
    margine_pct = CASE WHEN p_esposto > 0 AND costo > 0
                       THEN ROUND((p_esposto - costo) / p_esposto * 100, 2) END,
    floor_pct   = pc_floor_pct_tenant(tenant_id, p_esposto)
  WHERE p_esposto > 0;
  UPDATE _g SET floor_safe = pc_floor_prezzo(tenant_id, p_esposto, costo)
  WHERE costo > 0 AND p_esposto > 0;

  -- ---- classificazione ----------------------------------------------------
  -- Ordine capo 10/09 #2: la mano umana NON e' piu' esente. Un prezzo sotto il
  -- floor e' un difetto, non una decisione, e nessun ordine manuale lo protegge.
  UPDATE _g SET esito = CASE
    -- costo che non esiste: il floor non e' verificabile, il taglio esce
    WHEN p_esposto IS NULL OR p_esposto <= 0 OR costo IS NULL OR costo <= 0
      THEN 'cancellato_dato_assente'
    -- costo vecchio E gia' sotto il minimo: non si CALCOLA niente (legge del
    -- costo), ma non puo' nemmeno restare esposto (mai sotto floor): si cancella
    -- e torna alla regola FB, che non richiede alcun calcolo nostro.
    WHEN NOT costo_fresco AND margine_pct < floor_pct THEN 'cancellato_costo_vecchio'
    -- costo vecchio ma sopra il minimo: si dichiara, non si tocca
    WHEN NOT costo_fresco THEN 'fermo_costo_vecchio'
    WHEN margine_pct < floor_pct THEN 'da_riparare'
    ELSE 'sano'
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
    WHEN floor_safe <= prezzo_vivo - 0.005 THEN 'ricalcolato_giu'
    WHEN sell_price > 0 AND floor_safe <= sell_price - 0.01 THEN 'rialzo_riparazione'
    ELSE 'cancellato'
  END
  WHERE esito = 'da_riparare';

  IF p_dry THEN
    INSERT INTO pc_guardian_log (tenant_id, tenant, sku, action_id, action_source, esito,
        prezzo_vivo, prezzo_esposto, costo, margine_pct, floor_pct, floor_safe, sell_price,
        best_ext, motivo, fonte_costo, mano_umana, costo_fresco, costo_letto_il)
    SELECT tenant_id, tname, sku, action_id, action_source, esito || ' (prova)',
           prezzo_vivo, p_esposto, costo, margine_pct, floor_pct, floor_safe, sell_price,
           best_ext, 'giro a vuoto', fonte_costo, mano_umana, costo_fresco, costo_letto_il
    FROM _g WHERE esito NOT IN ('sano','in_coda');
    RETURN QUERY SELECT g.esito, g.tname, COUNT(*)::bigint FROM _g g GROUP BY 1,2
                 UNION ALL
                 SELECT 'fermo_dati_stantii', f.tname, 0::bigint FROM _fresh f
                  WHERE f.ultimo_import IS NULL OR f.ultimo_import <= NOW() - INTERVAL '12 hours';
    RETURN;
  END IF;

  -- ---- scrittura ----------------------------------------------------------
  UPDATE feed_actions fa SET
    recommended_price = g.floor_safe,
    action_reason = CASE WHEN g.esito = 'rialzo_riparazione'
      THEN 'guardiano PC: costo ' || ROUND(g.costo,2) || ' (' || g.fonte_costo || '), margine ' || g.margine_pct
           || '% sotto il minimo ' || g.floor_pct || '% - riportato al minimo ' || g.floor_safe
      ELSE 'guardiano PC: costo ' || ROUND(g.costo,2) || ' (' || g.fonte_costo || ') - ricalcolato a ' || g.floor_safe END,
    computed_at = NOW()
  FROM _g g
  WHERE fa.id = g.action_id
    AND g.esito IN ('rialzo_riparazione','ricalcolato_giu')
    AND g.floor_safe > 0
    AND g.floor_safe IS DISTINCT FROM fa.recommended_price;

  -- se un veto a monte ha azzerato la riparazione, il taglio resta rotto e
  -- senza prezzo: si cancella. Nessun taglio non verificabile resta vivo.
  UPDATE _g g SET esito = 'cancellato_veto'
  FROM feed_actions fa
  WHERE fa.id = g.action_id
    AND g.esito IN ('rialzo_riparazione','ricalcolato_giu')
    AND fa.recommended_price IS NULL;

  INSERT INTO pc_guardian_cestino (tenant_id, sku, motivo, riga)
  SELECT fa.tenant_id, fa.sku,
         CASE WHEN g.esito = 'cancellato_dato_assente'
           THEN 'guardiano PC: costo non misurabile (' || COALESCE(g.fonte_costo,'?')
                || ') - taglio non verificabile, tolto'
           WHEN g.esito = 'cancellato_costo_vecchio'
           THEN 'guardiano PC: costo letto il ' || COALESCE(g.costo_letto_il::text,'?')
                || ' (vecchio) e margine ' || COALESCE(g.margine_pct,0) || '% sotto il minimo '
                || COALESCE(g.floor_pct,0) || '% - non si calcola su costo vecchio, torna alla regola FB'
           ELSE 'guardiano PC: costo ' || ROUND(COALESCE(g.costo,0),2) || ' (' || COALESCE(g.fonte_costo,'?')
                || '), margine ' || COALESCE(g.margine_pct,0) || '% sotto il minimo ' || COALESCE(g.floor_pct,0)
                || '%, minimo ' || COALESCE(g.floor_safe,0) || ' non sta sotto il listino ' || COALESCE(g.sell_price,0)
         END,
         to_jsonb(fa)
  FROM feed_actions fa JOIN _g g ON g.action_id = fa.id
  WHERE g.esito IN ('cancellato','cancellato_veto','cancellato_dato_assente','cancellato_costo_vecchio');

  DELETE FROM feed_actions fa USING _g g
  WHERE fa.id = g.action_id
    AND g.esito IN ('cancellato','cancellato_veto','cancellato_dato_assente','cancellato_costo_vecchio');

  INSERT INTO pc_guardian_log (tenant_id, tenant, sku, action_id, action_source, esito,
      prezzo_vivo, prezzo_esposto, costo, margine_pct, floor_pct, floor_safe, sell_price,
      best_ext, motivo, fonte_costo, mano_umana, costo_fresco, costo_letto_il)
  SELECT tenant_id, tname, sku, action_id, action_source, esito,
         prezzo_vivo, p_esposto, costo, margine_pct, floor_pct, floor_safe, sell_price,
         best_ext, 'giro applicato', fonte_costo, mano_umana, costo_fresco, costo_letto_il
  FROM _g WHERE esito NOT IN ('sano','in_coda');

  RETURN QUERY SELECT g.esito, g.tname, COUNT(*)::bigint FROM _g g GROUP BY 1,2
               UNION ALL
               SELECT 'fermo_dati_stantii', f.tname, 0::bigint FROM _fresh f
                WHERE f.ultimo_import IS NULL OR f.ultimo_import <= NOW() - INTERVAL '12 hours';
END $$;

INSERT INTO schema_migrations (filename)
SELECT '109_guardie_prezzo_ai_mai_sotto_floor.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '109_guardie_prezzo_ai_mai_sotto_floor.sql');
