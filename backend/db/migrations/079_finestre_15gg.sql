-- 079: TETTO 15 GIORNI (ordine capo 29/7)
-- "Via tutti i ragionamenti a 90gg. Il massimo che possiamo valutare per tenere
--  dentro un prodotto e 15gg. Ripescaggi di test piu brevi, ma buttati fuori se
--  non vendono o non sono sani." Vale per TUTTI i tenant.
--
-- Gruppo 1 (KEEP-IN / protezione): ogni finestra 90gg/30gg -> 15gg.
--   Le colonne _90d di sku_basket_stats MANTENGONO il nome (6 lettori) ma da ora
--   contengono dati a 15gg: is_basket_protected e porta_carrelli_sani si stringono
--   automaticamente senza toccarne il codice.
-- Gruppo 2 (esilio/retest): gestito nei servizi -> 7gg + 3gg test.
-- Gruppo 3 (TTL/purge): NON toccato.
-- Gruppo 4 (analytics): portato a 15gg nei servizi.

-- ===== 1. sku_basket_stats: finestra 90 -> 15gg (colonne invariate) =====
CREATE OR REPLACE FUNCTION public.refresh_sku_basket_stats()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM sku_basket_stats;
  INSERT INTO sku_basket_stats (tenant_id, sku, n_ord_90d, basket_margin_90d, click_cost_90d, aov_90d, refreshed_at)
  WITH ord_marg AS (
    SELECT o.id, o.tenant_id,
      SUM(oi2.row_total_incl_tax - (CASE WHEN COALESCE(p2.erp_stock,0)>0
            THEN COALESCE(NULLIF(p2.erp_purchase_cost,0), NULLIF(p2.erp_cost,0), p2.erp_cost_imputed, oi2.row_total_incl_tax*0.75)
            ELSE COALESCE(NULLIF(p2.erp_cost,0), NULLIF(p2.erp_purchase_cost,0), p2.erp_cost_imputed, oi2.row_total_incl_tax*0.75) END) * oi2.qty_ordered) AS marg,
      SUM(oi2.row_total_incl_tax) AS val
    FROM orders o JOIN order_items oi2 ON oi2.order_id = o.id
    LEFT JOIN products p2 ON p2.tenant_id = o.tenant_id AND p2.sku = oi2.sku
    WHERE o.order_date >= NOW() - INTERVAL '15 days' AND o.order_status NOT IN ('canceled','closed')
    GROUP BY 1, 2),
  basket AS (SELECT om.tenant_id, oi.sku, COUNT(DISTINCT om.id) AS n_ord, SUM(om.marg) AS marg, AVG(om.val) AS aov
    FROM order_items oi JOIN ord_marg om ON om.id = oi.order_id GROUP BY 1, 2),
  clk AS (SELECT z.tenant_id, z.product_code AS sku, SUM(z.clicks) * 0.3294 AS cost
    FROM zombie_clicks z WHERE z.fetch_date >= NOW() - INTERVAL '15 days' GROUP BY 1, 2)
  SELECT COALESCE(b.tenant_id, c.tenant_id), COALESCE(b.sku, c.sku),
    COALESCE(b.n_ord, 0), ROUND(COALESCE(b.marg, 0), 2), ROUND(COALESCE(c.cost, 0), 2), ROUND(b.aov, 2), NOW()
  FROM basket b FULL OUTER JOIN clk c ON c.tenant_id = b.tenant_id AND c.sku = b.sku;
END;
$function$;

-- ===== 2. is_price_cut_allowed: vendite rete 30 -> 15gg =====
CREATE OR REPLACE FUNCTION public.is_price_cut_allowed(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE
    WHEN is_muro_rule_product(p_tenant, p_sku) THEN false
    WHEN is_sconto_rule_product(p_tenant, p_sku) THEN false
    WHEN is_salva_bilancio_product(p_tenant, p_sku) THEN true
    WHEN EXISTS (
      SELECT 1 FROM products p JOIN price_rules pr
        ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
      WHERE p.tenant_id = p_tenant AND p.sku = p_sku
        AND pr.rule_data->>'type' = '1')
    THEN (
      (SELECT COUNT(DISTINCT o.id) >= 2
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.sku = p_sku
         AND o.order_date >= NOW() - INTERVAL '15 days'
         AND o.order_status NOT IN ('canceled','closed','pending_payment'))
      OR
      (EXISTS (SELECT 1 FROM health_config hc
         WHERE hc.tenant_id = p_tenant AND hc.config_key = 'pc_perimetro_esteso'
           AND hc.config_value = '1')
       AND EXISTS (
         SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE o.tenant_id = p_tenant AND oi.sku = p_sku
           AND o.order_date >= NOW() - INTERVAL '15 days'
           AND o.order_status NOT IN ('canceled','closed','pending_payment')))
    )
    ELSE false
  END;
$function$;

-- ===== 3. veto_release_incidenza_alta: fatturato+click 30 -> 15gg (click inline) =====
CREATE OR REPLACE FUNCTION public.veto_release_incidenza_alta()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE rev numeric; cc numeric;
BEGIN
  IF NEW.reactivated = true AND COALESCE(OLD.reactivated,false) = false THEN
    IF COALESCE(current_setting('xhp.writer', true),'') LIKE 'sessione_%' THEN
      RETURN NEW;
    END IF;
    SELECT COALESCE(SUM(oi.row_total_incl_tax),0) INTO rev
      FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE oi.sku=NEW.sku AND o.tenant_id=NEW.tenant_id
        AND o.order_date>=NOW()-INTERVAL '15 days'
        AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato');
    -- click 15g ivati (0.3294), coerente col fatturato ivato
    SELECT COALESCE(SUM(z.clicks),0) * 0.3294 INTO cc
      FROM zombie_clicks z
      WHERE z.tenant_id=NEW.tenant_id AND z.product_code=NEW.sku
        AND z.fetch_date >= CURRENT_DATE - 15;
    IF cc >= 0.30 * rev THEN
      NEW.reactivated := false;
      NEW.reactivated_at := OLD.reactivated_at;
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

-- ===== 4. codalunga_retest_loop: prova "morto" 90 -> 15gg =====
CREATE OR REPLACE FUNCTION public.codalunga_retest_loop(p_dry boolean DEFAULT false)
RETURNS TABLE(phase text, n bigint)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rest interval := interval '7 days';
  v_len  interval := interval '3 days';
  v_reason text := 'loop_coda_lunga_zero_conv';
BEGIN
  CREATE TEMP TABLE _targets ON COMMIT DROP AS
    SELECT 'd581c087-6b92-4050-b52a-5bd5c087553a'::uuid AS tenant_id;

  IF p_dry THEN
    RETURN QUERY
      SELECT 'cut_candidati'::text, COUNT(*)::bigint
      FROM _targets t
      JOIN products p ON p.tenant_id = t.tenant_id
      WHERE COALESCE(p.export_status,'1') <> '0'
        AND (COALESCE(p.erp_stock,0) > 0 OR COALESCE(p.supplier_stock,0) > 0)
        AND (SELECT COALESCE(SUM(z.clicks),0) FROM zombie_clicks z
               WHERE z.tenant_id = t.tenant_id AND z.product_code = p.sku
                 AND z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 14) = 1
        AND NOT EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id=o.id
               WHERE oi.sku = p.sku
                 AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
                 AND o.order_date >= NOW() - INTERVAL '15 days')
        AND NOT is_brand_protected(t.tenant_id, p.sku)
        AND NOT is_basket_protected(t.tenant_id, p.sku)
        AND NOT EXISTS (SELECT 1 FROM feed_quarantine fq
               WHERE fq.tenant_id = t.tenant_id AND fq.sku = p.sku);
    RETURN QUERY
      SELECT 'open_apribili'::text, COUNT(*)::bigint FROM feed_quarantine
      WHERE reason = v_reason AND reactivated = false AND observation_start IS NULL
        AND reactivation_check_at IS NOT NULL AND reactivation_check_at <= NOW();
    RETURN QUERY
      SELECT 'close_da_valutare'::text, COUNT(*)::bigint FROM feed_quarantine
      WHERE reason = v_reason AND observation_start IS NOT NULL AND observation_end < NOW();
    RETURN;
  END IF;

  PERFORM set_config('xhp.writer', 'loop_coda_lunga', true);
  PERFORM set_config('xhp.motivo', 'coda lunga zero-conversione: cliccato 1x/15gg, 0 vendite rete 15gg, disponibile', true);

  WITH ins AS (
    INSERT INTO feed_quarantine
      (tenant_id, sku, reason, quarantine_start, quarantine_end, reactivation_check_at,
       quarantine_level, manual_override, is_burner_rule, is_permanent)
    SELECT t.tenant_id, p.sku, v_reason, NOW(), NOW()+v_rest, NOW()+v_rest,
           1, true, false, false
    FROM _targets t
    JOIN products p ON p.tenant_id = t.tenant_id
    WHERE COALESCE(p.export_status,'1') <> '0'
      AND (COALESCE(p.erp_stock,0) > 0 OR COALESCE(p.supplier_stock,0) > 0)
      AND (SELECT COALESCE(SUM(z.clicks),0) FROM zombie_clicks z
             WHERE z.tenant_id = t.tenant_id AND z.product_code = p.sku
               AND z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 14) = 1
      AND NOT EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id=o.id
             WHERE oi.sku = p.sku
               AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
               AND o.order_date >= NOW() - INTERVAL '15 days')
      AND NOT is_brand_protected(t.tenant_id, p.sku)
      AND NOT is_basket_protected(t.tenant_id, p.sku)
      AND NOT EXISTS (SELECT 1 FROM feed_quarantine fq
             WHERE fq.tenant_id = t.tenant_id AND fq.sku = p.sku)
    ON CONFLICT (tenant_id, sku) DO NOTHING
    RETURNING 1)
  SELECT 'cut'::text, COUNT(*)::bigint FROM ins INTO phase, n;
  RETURN NEXT;

  CREATE TEMP TABLE _closed ON COMMIT DROP AS
    SELECT fq.tenant_id, fq.sku,
      EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id=o.id
        WHERE oi.sku = fq.sku
          AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
          AND o.order_date >= fq.observation_start) AS sold
    FROM feed_quarantine fq
    WHERE fq.reason = v_reason AND fq.observation_start IS NOT NULL AND fq.observation_end < NOW();

  PERFORM set_config('xhp.writer', 'sessione_loop_codalunga', true);
  PERFORM set_config('xhp.motivo', 'loop coda lunga: chiusura finestra retest 3gg', true);

  UPDATE feed_quarantine fq
    SET reactivated = true, reactivated_at = COALESCE(fq.reactivated_at, NOW()),
        reason = 'loop_coda_lunga_promosso',
        observation_start = NULL, observation_end = NULL,
        observation_orders = 1, reactivation_check_at = NULL
    FROM _closed c
    WHERE fq.tenant_id = c.tenant_id AND fq.sku = c.sku AND c.sold;
  RETURN QUERY SELECT 'promosso'::text, COUNT(*)::bigint FROM _closed WHERE sold;

  UPDATE feed_quarantine fq
    SET reactivated = false,
        observation_start = NULL, observation_end = NULL,
        quarantine_start = NOW(), quarantine_end = NOW()+v_rest,
        reactivation_check_at = NOW()+v_rest,
        quarantine_level = COALESCE(fq.quarantine_level,1) + 1
    FROM _closed c
    WHERE fq.tenant_id = c.tenant_id AND fq.sku = c.sku AND NOT c.sold;
  RETURN QUERY SELECT 'ritagliato'::text, COUNT(*)::bigint FROM _closed WHERE NOT sold;

  WITH opn AS (
    UPDATE feed_quarantine fq
      SET reactivated = true, reactivated_at = NOW(),
          observation_start = NOW(), observation_end = NOW()+v_len,
          observation_clicks = 0, observation_orders = 0,
          reactivation_check_at = NULL
      WHERE fq.reason = v_reason AND fq.reactivated = false
        AND fq.observation_start IS NULL
        AND fq.reactivation_check_at IS NOT NULL AND fq.reactivation_check_at <= NOW()
      RETURNING 1)
  SELECT 'test_aperto'::text, COUNT(*)::bigint FROM opn INTO phase, n;
  RETURN NEXT;

  RETURN;
END;
$function$;

-- ===== 5. refresh_vetrina_piena: click+ordini 90 -> 15gg (colonne _90g invariate) =====
CREATE OR REPLACE FUNCTION public.refresh_vetrina_piena()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_n INT;
  v_click_min INT := COALESCE((SELECT config_value::int FROM global_config WHERE config_key='vetrina_click_min'), 60);
  v_pos_max INT := COALESCE((SELECT config_value::int FROM global_config WHERE config_key='vetrina_pos_max'), 3);
  v_inc_min NUMERIC := COALESCE((SELECT config_value::numeric FROM global_config WHERE config_key='vetrina_inc_min'), 0.5);
  v_gap_max NUMERIC := COALESCE((SELECT config_value::numeric FROM global_config WHERE config_key='vetrina_gap_max'), 0.15);
BEGIN
  DELETE FROM vetrina_piena_provati;
  INSERT INTO vetrina_piena_provati
    (tenant_id, sku, click_90g, costo_90g, ordini_rete_90g, fatt_90g, basket_margin_90g, pos)
  WITH ck AS (
    SELECT z.tenant_id, z.product_code sku, SUM(z.clicks) click90, ROUND(SUM(z.clicks)*0.3294, 2) costo90
    FROM zombie_clicks z WHERE z.fetch_date >= CURRENT_DATE - 15
    GROUP BY 1,2 HAVING SUM(z.clicks) >= v_click_min),
  dirette AS (
    SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) ordn, SUM(oi.row_total_incl_tax) f90
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE o.order_date >= NOW()-INTERVAL '15 days' AND o.order_status NOT IN ('canceled','closed')
      AND oi.sku IN (SELECT sku FROM ck) GROUP BY 1,2),
  rete AS (
    SELECT oi.sku, COUNT(DISTINCT o.id) n FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE o.order_date >= NOW()-INTERVAL '15 days' AND o.order_status NOT IN ('canceled','closed')
      AND oi.sku IN (SELECT sku FROM ck) GROUP BY 1),
  cand AS (
    SELECT c.tenant_id, c.sku, c.click90, c.costo90, COALESCE(d.ordn,0) ordn, COALESCE(d.f90,0) f90,
      COALESCE(s.basket_margin_90d,0) marg, pos_fresca(c.tenant_id, c.sku) pos, p.sell_price,
      COALESCE(p.erp_stock,0) erp_stock, COALESCE(p.supplier_stock,0) sup_stock, COALESCE(rt.n,0) rete_n,
      GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
        CASE WHEN COALESCE(p.erp_stock,0)>0 THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END)
        * (1 + COALESCE((SELECT hc.config_value::numeric FROM health_config hc
            WHERE hc.tenant_id=c.tenant_id AND hc.config_key='ricarico_floor_pct'),
            CASE WHEN p.sell_price < 10 THEN 18 WHEN p.sell_price <= 30 THEN 14 ELSE 12 END)/100) floorx,
      (SELECT MIN(sc.base_price) FROM scraper_competitors sc
       WHERE sc.product_code = c.sku AND sc.base_price > 0
         AND sc.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '48 hours'
         AND sc.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia') best_ext
    FROM ck c
    JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
    JOIN products p ON p.tenant_id=c.tenant_id AND p.sku=c.sku
    LEFT JOIN dirette d ON d.tenant_id=c.tenant_id AND d.sku=c.sku
    LEFT JOIN rete rt ON rt.sku=c.sku
    LEFT JOIN sku_basket_stats s ON s.tenant_id=c.tenant_id AND s.sku=c.sku
    WHERE COALESCE(d.ordn,0) <= 2
      AND (COALESCE(d.f90,0) = 0 OR c.costo90 > v_inc_min * d.f90)
      AND COALESCE(s.basket_margin_90d,0) < c.costo90
      AND COALESCE(p.sell_price,0) > 0
      AND NOT (COALESCE(p.erp_stock,0)=0 AND COALESCE(p.supplier_stock,0)>0 AND COALESCE(rt.n,0) >= 3)
      AND NOT EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id=c.tenant_id AND cp.sku=c.sku AND cp.revoked_at IS NULL)
      AND NOT is_brand_protected(c.tenant_id, c.sku) AND NOT is_basket_protected(c.tenant_id, c.sku))
  SELECT tenant_id, sku, click90, costo90, ordn, f90, marg, pos FROM cand
  WHERE
    pos <= v_pos_max
    OR NOT is_price_cut_allowed(tenant_id, sku)
    OR NOT EXISTS (
      SELECT 1 FROM scraper_competitors ext
      JOIN tenant_merchant_rx mrx ON mrx.tenant_id = cand.tenant_id
      WHERE ext.product_code = cand.sku AND ext.base_price > 0
        AND ext.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '48 hours'
        AND ext.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'
        AND ext.base_price - 0.01 >= cand.floorx
        AND ext.base_price < COALESCE(
          (SELECT MIN(noi.base_price) FROM scraper_competitors noi
           WHERE noi.product_code = cand.sku AND noi.merchant ~* mrx.rx
             AND noi.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '48 hours'), cand.sell_price))
    OR (best_ext IS NOT NULL AND floorx > best_ext * (1 + v_gap_max) AND erp_stock > 0);
  GET DIAGNOSTICS v_n = ROW_COUNT; RETURN v_n;
END $function$;

-- ===== 6. refresh_gap_incolmabile: click+ordini 90 -> 15gg =====
CREATE OR REPLACE FUNCTION public.refresh_gap_incolmabile()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE v_n INT;
BEGIN
  DELETE FROM gap_incolmabile_watch;
  INSERT INTO gap_incolmabile_watch
  WITH ck AS (SELECT z.tenant_id, z.product_code sku, SUM(z.clicks) c90 FROM zombie_clicks z
    WHERE z.fetch_date >= CURRENT_DATE-15 GROUP BY 1,2 HAVING SUM(z.clicks)>=60),
  dirette AS (SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) n FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE o.order_date >= NOW()-INTERVAL '15 days' AND o.order_status NOT IN ('canceled','closed') GROUP BY 1,2),
  rete AS (SELECT oi.sku, COUNT(DISTINCT o.id) n FROM orders o JOIN order_items oi ON oi.order_id=o.id
    WHERE o.order_date >= NOW()-INTERVAL '15 days' AND o.order_status NOT IN ('canceled','closed') GROUP BY 1),
  best AS (SELECT sc.product_code, MIN(sc.base_price) b FROM scraper_competitors sc
    WHERE sc.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '48 hours' AND sc.base_price>0
      AND sc.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia' GROUP BY 1)
  SELECT c.tenant_id, c.sku, c.c90, COALESCE(d.n,0), COALESCE(r.n,0),
    ROUND(fl.floorx,2), b.b, ROUND(100*(fl.floorx/NULLIF(b.b,0)-1))::int,
    COALESCE(p.erp_stock,0), COALESCE(p.supplier_stock,0),
    CASE WHEN COALESCE(p.erp_stock,0) > 0 THEN 'strutturale' ELSE 'restock' END,
    (COALESCE(r.n,0) >= 3)
  FROM ck c
  JOIN tenants t ON t.id=c.tenant_id AND t.status='active'
    AND t.name IN ('SubitoFarma','Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmastelia','Farmacia Mandanici')
  JOIN products p ON p.tenant_id=c.tenant_id AND p.sku=c.sku
  JOIN best b ON b.product_code=c.sku
  LEFT JOIN dirette d ON d.tenant_id=c.tenant_id AND d.sku=c.sku
  LEFT JOIN rete r ON r.sku=c.sku
  CROSS JOIN LATERAL (SELECT GREATEST(COALESCE(NULLIF(p.erp_cost,0),0),
    CASE WHEN COALESCE(p.erp_stock,0)>0 THEN COALESCE(p.erp_purchase_cost,0) ELSE 0 END)
    * (1 + CASE WHEN p.sell_price<10 THEN 18 WHEN p.sell_price<=30 THEN 14 ELSE 12 END/100.0) floorx) fl
  WHERE COALESCE(d.n,0) <= 2 AND is_price_cut_allowed(c.tenant_id, c.sku)
    AND fl.floorx > b.b * 1.15
    AND NOT is_brand_protected(c.tenant_id,c.sku) AND NOT is_basket_protected(c.tenant_id,c.sku)
    AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati vp WHERE vp.tenant_id=c.tenant_id AND vp.sku=c.sku);
  GET DIAGNOSTICS v_n = ROW_COUNT; RETURN v_n;
END $function$;

