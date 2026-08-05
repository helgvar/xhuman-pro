-- 085: ORDINE CAPO 4/8 — "annulliamo tutti i veti che bloccano prodotti che
--      vendono. Il taglio deve essere solo sui prodotti che non vendono o che
--      hanno incidenza alta; l'incidenza alta nel momento in cui prendono
--      vendite da altri canali scende e quindi vanno riabilitati."
--
-- DIAGNOSI 4/8 h14. Misurato sui bloccati attuali (quarantena non riattivata,
-- killer attivi, feed_actions REMOVE, dieta_provati, vetrina_piena_provati),
-- incrociati con ordini reali Magento 30gg (whitelist) e click 30gg x 0,3294:
--   1.172 SKU vendono E ripagano il click: EUR 49.628 di fatturato 30gg
--   tenuti fuori dal feed per EUR 2.242 di click. Incidenza media 4,3% — SANA.
--   La sola dieta_provati ne blocca 789.
-- Il taglio corretto invece regge: 33.325 SKU a zero vendite 30gg restano
-- fuori (EUR 17.219 di click risparmiati), piu' 135 che vendono ma bruciano
-- (incidenza 57-108%), che restano fuori per merito.
--
-- CAUSA RADICE — la guardia c'era e non ha mai sparato:
--   trg_veto_condanna_vendente_fn apriva con
--     IF TG_TABLE_NAME='feed_quarantine' AND manual_override THEN RETURN NEW
--   e i due motori che riempiono la quarantena scrivono manual_override=true
--   (burnerIncidenceCron.js:99, limaCostanteCron.js:255). Il bypass pensato per
--   la mano umana veniva usato dai loop automatici: 27.568 righe di quarantena
--   inserite senza mai passare dal controllo vendite.
-- Secondo buco: dieta_provati e vetrina_piena_provati non avevano NESSUNA
--   guardia. Non sono condanne, sono strip di protezione, e nessun trigger le
--   guardava: 23.722 + 1.248 righe scritte a occhi chiusi.
-- Terzo buco: le finestre. vende_su_tenant_15g/vende_in_rete_15g a 15gg,
--   veto_release_burner_rule a 7gg. Un prodotto a rotazione mensile e'
--   invisibile a tutte e tre e viene condannato come se fosse morto.
--
-- MODIFICA — un solo criterio in tutto il sistema, vende_e_ripaga():
--   vende sul PROPRIO tenant negli ultimi 30gg (ordini reali, whitelist)
--   E costo click 30gg < 30% del fatturato.
-- Usato in DUE direzioni opposte, cosi' i motori non possono contraddirsi:
--   - VIETA la condanna (feed_actions REMOVE, feed_quarantine, feed_killers,
--     dieta_provati, vetrina_piena_provati)
--   - CONCEDE il rilascio per merito (veto_release_incidenza_alta,
--     veto_release_burner_rule) senza bisogno di bypass di writer.
-- Il fatturato al numeratore e' quello di TUTTI i canali, non solo TP: e'
-- esattamente il meccanismo che il capo descrive — chi prende vendite altrove
-- vede scendere l'incidenza e rientra da solo.
--
-- FINESTRA 30gg: aggiorna consapevolmente l'ordine 29/7 (max 15gg per tenere
-- dentro). L'ordine di oggi e' esplicito — il taglio solo su chi NON vende — e
-- a 15gg un prodotto a rotazione mensile risulta morto quando non lo e'.
-- Soglia e finestra restano configurabili per tenant via health_config
-- ('rilascio_incidenza_max', 'rilascio_finestra_gg') senza altre migrazioni.
--
-- ROLLBACK:
--   DROP TRIGGER trg_veto_dieta_vendente ON dieta_provati;
--   DROP TRIGGER trg_veto_vetrina_vendente ON vetrina_piena_provati;
--   e ripristino delle 3 funzioni dalla versione precedente (git).

-- ---------------------------------------------------------------------------
-- 1) IL CRITERIO UNICO
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vende_e_ripaga(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 COST 500          -- misurato ~29ms: dice al planner di valutarla PER ULTIMA
AS $function$
  WITH cfg AS (
    SELECT COALESCE((SELECT hc.config_value::numeric FROM health_config hc
                      WHERE hc.tenant_id = p_tenant
                        AND hc.config_key = 'rilascio_incidenza_max'), 0.30) AS incid_max,
           COALESCE((SELECT hc.config_value::int FROM health_config hc
                      WHERE hc.tenant_id = p_tenant
                        AND hc.config_key = 'rilascio_finestra_gg'), 30) AS gg
  ),
  r AS (
    SELECT COALESCE(SUM(oi.row_total_incl_tax), 0) AS rev
    FROM order_items oi JOIN orders o ON o.id = oi.order_id, cfg
    WHERE oi.tenant_id = p_tenant AND oi.sku = p_sku AND o.tenant_id = p_tenant
      AND o.order_date >= NOW() - (cfg.gg || ' days')::interval
      AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
  ),
  c AS (
    SELECT COALESCE(SUM(z.clicks), 0) * 0.3294 AS cc
    FROM zombie_clicks z, cfg
    WHERE z.tenant_id = p_tenant AND z.product_code = p_sku
      AND z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - cfg.gg
  )
  SELECT r.rev > 0 AND c.cc < cfg.incid_max * r.rev FROM r, c, cfg;
$function$;

-- ---------------------------------------------------------------------------
-- 2) GUARDIA CONDANNA: bypass manual_override solo alla mano UMANA
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_veto_condanna_vendente_fn()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_pos INT;
  v_pos_max INT;
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  -- manual_override bypassa SOLO se lo scrive una mano umana. I loop
  -- automatici lo settavano a true e saltavano il controllo vendite (mig 085).
  IF TG_TABLE_NAME = 'feed_quarantine'
     AND COALESCE((row_to_json(NEW)->>'manual_override')::boolean, false)
     AND (v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%'
          OR v_writer LIKE 'sessione\_%' ESCAPE '\') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'feed_actions'
     AND COALESCE(row_to_json(NEW)->>'action','') <> 'REMOVE' THEN
    RETURN NEW;
  END IF;

  IF vende_su_tenant_15g(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
            v_writer, 'L2: vende su QUESTO tenant 15g', NULL);
    RETURN NULL;
  END IF;

  -- ORDINE CAPO 4/8: chi vende e ripaga il click non si tocca, punto.
  -- Copre la rotazione mensile che la finestra 15gg dichiarava morta.
  IF vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
            v_writer, 'L4 (mig 085): vende 30g e il click si ripaga', NULL);
    RETURN NULL;
  END IF;

  IF vende_in_rete_15g(NEW.sku) THEN
    v_pos := pos_fresca(NEW.tenant_id, NEW.sku);
    SELECT COALESCE((SELECT hc.config_value::int FROM health_config hc
      WHERE hc.tenant_id = NEW.tenant_id AND hc.config_key = 'release_pos_max'), 10)
    INTO v_pos_max;
    IF v_pos IS NOT NULL AND v_pos <= v_pos_max THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
              v_writer, 'L2: vende in rete E pos fresca ' || v_pos || ' <= ' || v_pos_max || ' su questo tenant', NULL);
      RETURN NULL;
    END IF;
    -- vende in rete ma qui non è posizionato: condanna PERMESSA (ordine 15/7)
  END IF;
  RETURN NEW;
END $function$;

-- ---------------------------------------------------------------------------
-- 3) GUARDIA sulle due tabelle che strippano protezione senza controlli
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_veto_strip_vendente_fn()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'strip protezione bloccata',
            COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo'),
            'L4 (mig 085): vende 30g e il click si ripaga', NULL);
    RETURN NULL;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_veto_dieta_vendente ON public.dieta_provati;
CREATE TRIGGER trg_veto_dieta_vendente
  BEFORE INSERT ON public.dieta_provati
  FOR EACH ROW EXECUTE FUNCTION public.trg_veto_strip_vendente_fn();

DROP TRIGGER IF EXISTS trg_veto_vetrina_vendente ON public.vetrina_piena_provati;
CREATE TRIGGER trg_veto_vetrina_vendente
  BEFORE INSERT ON public.vetrina_piena_provati
  FOR EACH ROW EXECUTE FUNCTION public.trg_veto_strip_vendente_fn();

-- ---------------------------------------------------------------------------
-- 4) I VETI DI RILASCIO parlano la stessa lingua: merito, non writer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.veto_release_incidenza_alta()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.reactivated = true AND COALESCE(OLD.reactivated,false) = false THEN
    IF COALESCE(current_setting('xhp.writer', true),'') LIKE 'sessione_%' THEN
      RETURN NEW;
    END IF;
    -- mig 085: stesso criterio della condanna. Se vende e il click si ripaga
    -- (fatturato di TUTTI i canali), rientra per merito.
    IF NOT vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
      NEW.reactivated := false;
      NEW.reactivated_at := OLD.reactivated_at;
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.veto_release_burner_rule()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
  v_rev numeric; v_cc numeric;
BEGIN
  IF COALESCE(OLD.is_burner_rule, false) = true
     AND NEW.reactivated = true AND COALESCE(OLD.reactivated, false) = false THEN

    IF v_writer LIKE 'capo\_%' ESCAPE '\' THEN
      RETURN NEW;
    END IF;

    SELECT COALESCE(SUM(oi.row_total_incl_tax),0) INTO v_rev
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.sku = NEW.sku AND o.tenant_id = NEW.tenant_id
        AND o.order_date >= NOW() - INTERVAL '30 days'
        AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato');
    SELECT COALESCE(SUM(z.clicks),0) * 0.3294 INTO v_cc
      FROM zombie_clicks z
      WHERE z.tenant_id = NEW.tenant_id AND z.product_code = NEW.sku
        AND z.fetch_date >= CURRENT_DATE - 30;

    -- mig 085: finestra 7gg -> 30gg e criterio unico vende_e_ripaga
    IF vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
      INSERT INTO burner_rule_reactivation_log(tenant_id, sku, writer, seller_rev_7g, click_cost_7g, esito)
        VALUES (NEW.tenant_id, NEW.sku, v_writer, v_rev, v_cc, 'rilasciato_merito');
      RETURN NEW;
    END IF;

    INSERT INTO burner_rule_reactivation_log(tenant_id, sku, writer, seller_rev_7g, click_cost_7g, esito)
      VALUES (NEW.tenant_id, NEW.sku, v_writer, v_rev, v_cc, 'ribloccato');
    NEW.reactivated := false;
    NEW.reactivated_at := OLD.reactivated_at;
  END IF;
  RETURN NEW;
END; $function$;

-- ---------------------------------------------------------------------------
-- 5) IL RILASCIO, come motore permanente (non SQL one-shot risovrascritto)
-- ---------------------------------------------------------------------------
-- Tabella PERMANENTE, non TEMP: una temp table dentro plpgsql cambia OID a ogni
-- transazione e manda in errore i piani in cache della funzione. In piu' tiene
-- lo storico di cosa e' stato rilasciato e quando.
CREATE TABLE IF NOT EXISTS public.rilascio_vendenti_batch (
  run_at    timestamptz NOT NULL,
  tenant_id uuid NOT NULL,
  sku       text NOT NULL,
  rev30     numeric,
  cc30      numeric
);
CREATE INDEX IF NOT EXISTS idx_rilascio_batch_run ON public.rilascio_vendenti_batch (run_at);
CREATE INDEX IF NOT EXISTS idx_rilascio_batch_ts  ON public.rilascio_vendenti_batch (tenant_id, sku);

CREATE OR REPLACE FUNCTION public.rilascia_vendenti()
 RETURNS TABLE(classe text, righe bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_run timestamptz := clock_timestamp();
  n_d bigint; n_v bigint; n_q bigint; n_k bigint; n_r bigint;
BEGIN
  PERFORM set_config('xhp.writer', 'rilascio_vendenti', true);
  PERFORM set_config('xhp.motivo',
    'ordine capo 4/8: mai bloccare chi vende e ripaga il click', true);

  -- Insieme dei bloccati che vendono e ripagano.
  -- Due passaggi di proposito: vende_e_ripaga() costa ~29ms a chiamata e i
  -- bloccati sono ~35k (17 minuti di transazione aperta sulle tabelle calde).
  -- Il prefiltro set-based e' una sola aggregata e scarta i ~33k a zero
  -- vendite; la funzione — unica autorita' sul criterio, config per tenant
  -- compresa — decide sui ~1.3k superstiti.
  INSERT INTO rilascio_vendenti_batch (run_at, tenant_id, sku, rev30, cc30)
  -- PERIMETRO (ordine capo 15/7): il rilascio agisce solo dove ho mandato.
  -- Fuori perimetro togliere un nostro blocco vuol dire rimettere lo SKU a
  -- spendere su TP di un tenant che non guidiamo: resta al capo dire quando.
  WITH perim AS (
      SELECT hc.tenant_id FROM health_config hc
      WHERE hc.config_key = 'rilascio_vendenti_on' AND hc.config_value = '1'
  ),
  bloccati AS (
      SELECT tenant_id, sku FROM feed_quarantine WHERE reactivated = false
      UNION SELECT tenant_id, sku FROM feed_killers WHERE is_active
      UNION SELECT tenant_id, sku FROM feed_actions WHERE action = 'REMOVE'
      UNION SELECT tenant_id, sku FROM dieta_provati
      UNION SELECT tenant_id, sku FROM vetrina_piena_provati
  ),
  rev AS (
      SELECT oi.tenant_id, oi.sku, SUM(oi.row_total_incl_tax) AS rev30
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.order_date >= NOW() - INTERVAL '30 days'
        AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
      GROUP BY 1,2
  ),
  cc AS (
      SELECT z.tenant_id, z.product_code AS sku, SUM(z.clicks)*0.3294 AS cc30
      FROM zombie_clicks z
      WHERE z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 30
      GROUP BY 1,2
  )
  SELECT v_run, b.tenant_id, b.sku, r.rev30, COALESCE(c.cc30, 0)
  FROM bloccati b
  JOIN perim p ON p.tenant_id = b.tenant_id
  JOIN rev r ON r.tenant_id = b.tenant_id AND r.sku = b.sku AND r.rev30 > 0
  LEFT JOIN cc c ON c.tenant_id = b.tenant_id AND c.sku = b.sku
  WHERE vende_e_ripaga(b.tenant_id, b.sku);

  DELETE FROM dieta_provati d
   USING rilascio_vendenti_batch r
   WHERE r.run_at = v_run AND d.tenant_id = r.tenant_id AND d.sku = r.sku;
  GET DIAGNOSTICS n_d = ROW_COUNT;

  DELETE FROM vetrina_piena_provati v
   USING rilascio_vendenti_batch r
   WHERE r.run_at = v_run AND v.tenant_id = r.tenant_id AND v.sku = r.sku;
  GET DIAGNOSTICS n_v = ROW_COUNT;

  UPDATE feed_quarantine q SET reactivated = true, reactivated_at = NOW()
   FROM rilascio_vendenti_batch r
   WHERE r.run_at = v_run AND q.tenant_id = r.tenant_id AND q.sku = r.sku
     AND q.reactivated = false;
  GET DIAGNOSTICS n_q = ROW_COUNT;

  UPDATE feed_killers k SET is_active = false
   FROM rilascio_vendenti_batch r
   WHERE r.run_at = v_run AND k.tenant_id = r.tenant_id AND k.sku = r.sku
     AND k.is_active;
  GET DIAGNOSTICS n_k = ROW_COUNT;

  DELETE FROM feed_actions f
   USING rilascio_vendenti_batch r
   WHERE r.run_at = v_run AND f.tenant_id = r.tenant_id AND f.sku = r.sku
     AND f.action = 'REMOVE';
  GET DIAGNOSTICS n_r = ROW_COUNT;

  RETURN QUERY SELECT 'dieta'::text, n_d
    UNION ALL SELECT 'vetrina', n_v
    UNION ALL SELECT 'quarantena', n_q
    UNION ALL SELECT 'killer', n_k
    UNION ALL SELECT 'remove', n_r;
END $function$;

-- Perimetro operativo 15/7. Per estendere a un tenant basta una riga qui,
-- nessuna migrazione nuova.
INSERT INTO health_config (tenant_id, config_key, config_value)
SELECT t.id, 'rilascio_vendenti_on', '1' FROM tenants t
WHERE t.name IN ('SubitoFarma','Papa','Farmacia Procaccini','MPF',
                 'Farmainsieme','Farmastelia','Farmacia Mandanici')
ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = '1';

INSERT INTO schema_migrations (filename) VALUES ('085_mai_bloccare_chi_vende.sql')
ON CONFLICT (filename) DO NOTHING;
