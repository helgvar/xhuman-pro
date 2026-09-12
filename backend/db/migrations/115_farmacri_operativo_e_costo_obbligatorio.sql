-- 115_farmacri_operativo_e_costo_obbligatorio.sql
-- Due ordini del capo del 10/09:
--   1) "farmacri e' operativo"  -> il perimetro delle guardie prezzo passa da 7 a 8 tenant.
--   2) "se non puoi misurare il pc non puo' essere fatto mai" -> finora un taglio
--      su costo non misurabile veniva CANCELLATO DOPO dal guardiano. Ora non nasce
--      proprio: guardia G8 in BEFORE INSERT/UPDATE su feed_actions.
-- Nota: refresh_gap_incolmabile ha la stessa lista cablata ma NON e' una guardia
-- (produce decisioni, non le blocca): resta a 7 in attesa dell'ordine del capo.

-- ---- 1) reconfirm_price_cuts_v2: Farmacri dentro ----
CREATE OR REPLACE FUNCTION public.reconfirm_price_cuts_v2(p_dry boolean DEFAULT true, p_tenant uuid DEFAULT NULL::uuid, p_cap integer DEFAULT NULL::integer)
 RETURNS TABLE(esito text, tenant text, n bigint)
 LANGUAGE plpgsql
AS $function$
#variable_conflict use_column
DECLARE
  v_op   text[] := ARRAY['Papa','Farmacia Procaccini','MPF','Farmainsieme',
                         'Farmastelia','Farmacia Mandanici','SubitoFarma',
                         'Farmacri'];  -- capo 10/09: "farmacri e' operativo"
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
         (fa.action::text = 'ADD') AS e_add,
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
  WHERE (fa.action = 'PRICE_CUT'
         OR (fa.action = 'ADD' AND fa.recommended_price IS NOT NULL))
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


  -- ---- ORDINE CAPO 10/09 #5 -------------------------------------------------
  -- "i prodotti che sono in regola muro o sconto non vanno toccati".
  -- Muro e Sconto sono territorio Farmabooster: li' il prezzo lo fa la regola.
  -- Ordine capo 10/09 #6: "non vengono emessi pc per prodotti che sono in
  -- sconto o in muro. e se un prodotto non era in muro e aveva un PC nel
  -- momento in cui entra nella regola muro il pc viene annullato".
  -- Quindi: PRICE_CUT su muro/sconto = ANNULLATO (cestino + delete).
  -- ADD su muro/sconto = resta nel feed, ma senza prezzo nostro.
  UPDATE _g SET esito = CASE WHEN e_add THEN 'prezzo_add_annullato'
                            ELSE 'cancellato_regola_fb' END
  WHERE is_muro_rule_product(tenant_id, sku)
     OR is_sconto_rule_product(tenant_id, sku);

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

  -- Una ADD non si cancella mai: toglierla vorrebbe dire buttare il prodotto
  -- fuori dal feed. Quando il suo prezzo non e' riparabile, si toglie il
  -- PREZZO e la ADD resta viva a prezzo di regola FB (mig 113).
  UPDATE _g SET esito = 'prezzo_add_annullato'
  WHERE e_add
    AND esito IN ('cancellato','cancellato_veto','cancellato_dato_assente',
                  'cancellato_costo_vecchio','cancellato_regola_fb');

  UPDATE feed_actions fa SET recommended_price = NULL,
    action_reason = 'guardiano PC (mig 113): prezzo tolto, il floor non e'' rispettabile - resta la regola FB',
    computed_at = NOW()
  FROM _g g
  WHERE fa.id = g.action_id AND g.esito = 'prezzo_add_annullato'
    AND fa.recommended_price IS NOT NULL;

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
  WHERE g.esito IN ('cancellato','cancellato_veto','cancellato_dato_assente','cancellato_costo_vecchio','cancellato_regola_fb');

  DELETE FROM feed_actions fa USING _g g
  WHERE fa.id = g.action_id
    AND g.esito IN ('cancellato','cancellato_veto','cancellato_dato_assente','cancellato_costo_vecchio','cancellato_regola_fb');

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
END $function$;

-- ---- 2) pc_sotto_floor_adesso: Farmacri dentro ----
CREATE OR REPLACE FUNCTION public.pc_sotto_floor_adesso(p_tenant uuid DEFAULT NULL::uuid)
 RETURNS TABLE(tenant text, sku character varying, action_source text, prezzo_vivo numeric, costo numeric, fonte_costo text, costo_fresco boolean, margine_pct numeric, floor_pct numeric, floor_safe numeric, sell_price numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
     AND t.name IN ('Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmastelia','Farmacia Mandanici','SubitoFarma','Farmacri')
     AND (p_tenant IS NULL OR fa.tenant_id = p_tenant)
     AND COALESCE(p.applied_price, p.exported_price, p.sell_price) > 0
     AND costo_guardia(fa.tenant_id, fa.sku) > 0
     AND (COALESCE(p.applied_price,p.exported_price,p.sell_price) - costo_guardia(fa.tenant_id,fa.sku))
         / COALESCE(p.applied_price,p.exported_price,p.sell_price) * 100
         < pc_floor_pct_tenant(fa.tenant_id, COALESCE(p.applied_price,p.exported_price,p.sell_price));
$function$;

-- ---- 3) reconfirm_price_cuts (v1 legacy): Farmacri e SubitoFarma dentro ----
CREATE OR REPLACE FUNCTION public.reconfirm_price_cuts(p_dry boolean DEFAULT false)
 RETURNS TABLE(azione text, tenant text, n bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_op text[] := ARRAY['Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmastelia','Farmacia Mandanici','SubitoFarma','Farmacri'];
  -- SubitoFarma volutamente FUORI (eccezione floor cliente); il sotto-costo lo
  -- protegge comunque il trigger dedicato.
  v_ai_sources text[] := ARRAY['competitive_price_cut','zero_click_demand','potenziale_price_cut',
    'convertitore_costoso','margin_harvest_pilot','pulizia_seller_guard','manual_pepita','pareto_positioning'];
BEGIN
  PERFORM set_config('xhp.writer', 'sessione_pc_guardian', true);
  PERFORM set_config('xhp.motivo', 'guardiano PC (capo 24/7): ri-conferma a ogni loop, costo salito sfonda il floor -> rialza floor-safe o ritira', true);

  -- snapshot valutazione (una volta)
  CREATE TEMP TABLE _pc ON COMMIT DROP AS
    SELECT fa.id, fa.tenant_id, t.name::text tname, fa.sku, fa.action_source, fa.recommended_price rp,
      costo_vero(fa.tenant_id, fa.sku) costo_now,
      b.baseline_cost base,
      (SELECT MIN(sc.base_price) FROM scraper_competitors sc
        WHERE sc.product_code=fa.sku
          AND sc.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '24 hours'
          AND sc.base_price>0
          AND sc.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'
      ) best_ext
    FROM feed_actions fa
    JOIN tenants t ON t.id=fa.tenant_id AND t.name = ANY(v_op)
    LEFT JOIN pc_cost_baseline b ON b.tenant_id=fa.tenant_id AND b.sku=fa.sku
    WHERE fa.action='PRICE_CUT' AND fa.status IN ('pending','dispatched','active')
      AND fa.recommended_price > 0 AND fa.action_source = ANY(v_ai_sources);

  -- registra baseline mancanti (PC preesistenti): baseline = costo di ORA, così
  -- solo gli aumenti FUTURI faranno scattare il guardiano.
  IF NOT p_dry THEN
    INSERT INTO pc_cost_baseline (tenant_id, sku, baseline_cost)
      SELECT DISTINCT tenant_id, sku, costo_now FROM _pc
      WHERE base IS NULL AND costo_now > 0
      ON CONFLICT (tenant_id, sku) DO NOTHING;
  END IF;

  -- classifica i "rotti da aumento-costo"
  CREATE TEMP TABLE _broken ON COMMIT DROP AS
    SELECT *,
      ROUND(costo_now / (1 - pc_floor_pct(rp)/100.0), 2) floor_safe
    FROM _pc
    WHERE base IS NOT NULL AND costo_now > base
      AND (rp - costo_now)/NULLIF(rp,0)*100 < pc_floor_pct(rp);

  IF p_dry THEN
    RETURN QUERY
      SELECT (CASE WHEN _broken.best_ext IS NULL OR _broken.floor_safe <= _broken.best_ext - 0.01 THEN 'revise_floor_safe' ELSE 'withdraw' END)::text,
             _broken.tname, COUNT(*)::bigint
      FROM _broken GROUP BY 1, _broken.tname;
    RETURN;
  END IF;

  -- conteggi PRIMA di applicare (classificazione deterministica da _broken)
  RETURN QUERY SELECT 'revised'::text, b.tname, COUNT(*)::bigint
    FROM _broken b
    WHERE (b.best_ext IS NULL OR b.floor_safe <= b.best_ext - 0.01) AND b.floor_safe > 0
    GROUP BY b.tname;
  RETURN QUERY SELECT 'withdrawn'::text, b.tname, COUNT(*)::bigint
    FROM _broken b
    WHERE b.best_ext IS NOT NULL AND b.floor_safe > b.best_ext - 0.01
    GROUP BY b.tname;

  -- REVISE: rialza al floor-safe (resta competitivo, o nessun riferimento -> margine prima)
  UPDATE feed_actions fa SET
    recommended_price = b.floor_safe,
    action_reason = 'guardiano PC (costo salito): rialzo floor-safe ' || b.floor_safe || ' (costo ' || ROUND(b.costo_now,2) || ')',
    computed_at = NOW()
  FROM _broken b
  WHERE fa.id = b.id AND (b.best_ext IS NULL OR b.floor_safe <= b.best_ext - 0.01)
    AND b.floor_safe > 0 AND b.floor_safe <> fa.recommended_price;

  -- WITHDRAW: floor-safe supererebbe il mercato -> ritira il PC (torna a regola FB)
  DELETE FROM feed_actions fa USING _broken b
  WHERE fa.id = b.id AND b.best_ext IS NOT NULL AND b.floor_safe > b.best_ext - 0.01;

  RETURN;
END; $function$;

-- ---- 4) GUARDIA G8: senza costo misurato non si fa nessun prezzo ----
-- Ordine capo 10/09: "se non puoi misurare il pc non puo' essere fatto mai".
-- Legge dell'08: "non si calcolano prezzi di vendita se il costo non e' aggiornato".
-- Regola:
--   * riga senza prezzo (ADD nuda, o PC gia' azzerato da un altro veto) -> passa,
--     non sta calcolando niente.
--   * costo non misurabile (costo_guardia <= 0) oppure costo non aggiornato
--     (costo_fresco false, 12h):
--       - PRICE_CUT in INSERT  -> non nasce (RETURN NULL)
--       - ADD con prezzo o UPDATE -> la riga resta, il PREZZO esce
--         (una ADD non si cancella mai: uscirebbe il prodotto dal feed)
CREATE OR REPLACE FUNCTION trg_pc_serve_costo_misurato_fn() RETURNS trigger AS $g8$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
  v_costo  NUMERIC;
  v_causa  TEXT;
BEGIN
  IF NEW.action NOT IN ('PRICE_CUT','ADD') THEN RETURN NEW; END IF;
  IF NEW.recommended_price IS NULL THEN RETURN NEW; END IF;
  IF NEW.recommended_price <= 0 THEN
    v_causa := 'prezzo non misurabile (0 = dato assente, mai un prezzo)';
  ELSE
    v_costo := costo_guardia(NEW.tenant_id, NEW.sku);
    IF v_costo IS NULL OR v_costo <= 0 THEN
      v_causa := 'costo non misurabile: ' || costo_fonte(NEW.tenant_id, NEW.sku);
    ELSIF NOT costo_fresco(NEW.tenant_id, NEW.sku, 12) THEN
      v_causa := 'costo non aggiornato da oltre 12h';
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.action = 'PRICE_CUT' AND TG_OP = 'INSERT' THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'blocco_costo_non_misurato', 'action',
            NULL, 'PRICE_CUT non emesso', v_writer,
            'guardia G8 (ordine capo 10/09): ' || v_causa || ' - senza misura non si calcola nessun prezzo',
            NEW.action_source);
    RETURN NULL;  -- il PC non nasce
  END IF;

  INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
  VALUES (NEW.tenant_id, NEW.sku, 'blocco_costo_non_misurato', 'recommended_price',
          NEW.recommended_price::text, 'NULL', v_writer,
          'guardia G8 (ordine capo 10/09): ' || v_causa || ' - il prezzo esce, la riga resta',
          NEW.action_source);
  NEW.recommended_price := NULL;
  RETURN NEW;
END;
$g8$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zz_trg_pc_serve_costo_misurato ON feed_actions;
CREATE TRIGGER zz_trg_pc_serve_costo_misurato
  BEFORE INSERT OR UPDATE ON feed_actions
  FOR EACH ROW EXECUTE FUNCTION trg_pc_serve_costo_misurato_fn();

INSERT INTO schema_migrations (filename, applied_at)
SELECT '115_farmacri_operativo_e_costo_obbligatorio.sql', NOW()
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '115_farmacri_operativo_e_costo_obbligatorio.sql');
