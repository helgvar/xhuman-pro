-- =====================================================================
-- 112 — Muro e Sconto: il guardiano non li tocca
-- =====================================================================
-- Ordine capo 10/09 #5: "i prodotti che sono in regola muro o sconto non
--   vanno toccati".
--
-- Prima della 112 il guardiano li classificava 'da_riparare', tentava la
-- riparazione, il veto sotto-costo (REGOLA_MURO / REGOLA_SCONTO) azzerava il
-- prezzo e la riga finiva 'cancellato_veto' -> DELETE. Cioe' il guardiano
-- CANCELLAVA tagli su prodotti di territorio FB. Ora li salta.
--
-- Nuovo esito: 'saltato_regola_fb'. Non entra ne' nel cestino ne' nel DELETE.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.reconfirm_price_cuts_v2(p_dry boolean DEFAULT true, p_tenant uuid DEFAULT NULL::uuid, p_cap integer DEFAULT NULL::integer)
 RETURNS TABLE(esito text, tenant text, n bigint)
 LANGUAGE plpgsql
AS $function$
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


  -- ---- ORDINE CAPO 10/09 #5 -------------------------------------------------
  -- "i prodotti che sono in regola muro o sconto non vanno toccati".
  -- Muro e Sconto sono territorio Farmabooster: il prezzo li' lo fa la regola,
  -- non noi. Il guardiano non ripara e non cancella: li dichiara e passa oltre.
  -- Non e' un buco nella legge del floor: su queste righe il veto sotto-costo
  -- azzera comunque ogni prezzo AI in scrittura, quindi nessun prezzo nostro
  -- puo' uscire sotto il floor da li'.
  UPDATE _g SET esito = 'saltato_regola_fb'
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
END $function$;



INSERT INTO schema_migrations (filename, applied_at)
SELECT '112_muro_e_sconto_non_si_toccano.sql', NOW()
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '112_muro_e_sconto_non_si_toccano.sql');
