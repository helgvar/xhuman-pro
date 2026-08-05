-- 078: Loop coda-lunga zero-conversione — taglio + retest 7gg/3gg (ordine capo 29/7)
--
-- Colma il GAP [[project_gap_coda_lunga_zero_conversione]]: i motori per-SKU
-- (killer margine-first) non sommano il bleed collettivo dei micro-burner.
--
-- Definizione MORTO (coda lunga): disponibile ORA, cliccato ESATTAMENTE 1 volta
-- negli ultimi 15gg su MPF, ZERO vendite rete 90gg, non brand-protetto, non
-- basket-protetto. Target iniziale = MPF (estendibile: aggiungere righe a _targets).
--
-- Ciclo (ledger = colonne native observation_* su feed_quarantine, reason tag):
--   CUT   -> reactivated=false, out del feed, reactivation_check_at = now()+7gg.
--            Writer 'loop_coda_lunga' (NON sessione_): rispetta il CAP anti-strage.
--   OPEN  -> dopo 7gg riapre nel feed per 3gg (observation window).
--            Writer 'sessione_loop_codalunga': bypassa veto-incidenza sul rilascio
--            supervisionato (stesso pattern di reactivate_margin_blocks R3).
--   CLOSE -> a fine 3gg: se ha venduto (rete, whitelist) -> PROMOSSO (resta nel feed,
--            esce dal loop). Se no -> RI-TAGLIO, altri 7gg, cycle++.
--
-- I 567 morti attuali di MPF sono tagliati a parte con ordine esplicito del capo
-- (sessione_capo, bypass cap lecito) col medesimo reason: il loop li retesta a 7gg.

CREATE OR REPLACE FUNCTION public.codalunga_retest_loop(p_dry boolean DEFAULT false)
RETURNS TABLE(phase text, n bigint)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rest interval := interval '7 days';   -- riposo in quarantena prima del retest
  v_len  interval := interval '3 days';   -- durata finestra di test nel feed
  v_reason text := 'loop_coda_lunga_zero_conv';
BEGIN
  -- Target tenant del CUT (estendibile). Solo MPF per ora (ordine capo 29/7).
  CREATE TEMP TABLE _targets ON COMMIT DROP AS
    SELECT 'd581c087-6b92-4050-b52a-5bd5c087553a'::uuid AS tenant_id;

  -- ===================== DRY-RUN: solo conteggi =====================
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
                 AND o.order_date >= NOW() - INTERVAL '90 days')
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

  -- ===================== 1. CUT (nuovi morti) — CAPPATO =====================
  PERFORM set_config('xhp.writer', 'loop_coda_lunga', true);
  PERFORM set_config('xhp.motivo', 'coda lunga zero-conversione: cliccato 1x/15gg, 0 vendite rete 90gg, disponibile', true);

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
               AND o.order_date >= NOW() - INTERVAL '90 days')
      AND NOT is_brand_protected(t.tenant_id, p.sku)
      AND NOT is_basket_protected(t.tenant_id, p.sku)
      AND NOT EXISTS (SELECT 1 FROM feed_quarantine fq
             WHERE fq.tenant_id = t.tenant_id AND fq.sku = p.sku)
    ON CONFLICT (tenant_id, sku) DO NOTHING
    RETURNING 1)
  SELECT 'cut'::text, COUNT(*)::bigint FROM ins INTO phase, n;
  RETURN NEXT;

  -- ===================== 2. CLOSE (finestra test scaduta) =====================
  -- venduto in rete durante la finestra -> promosso; altrimenti ri-taglio.
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

  -- venduto -> PROMOSSO: resta nel feed, esce dal loop (reason cambiato)
  UPDATE feed_quarantine fq
    SET reactivated = true, reactivated_at = COALESCE(fq.reactivated_at, NOW()),
        reason = 'loop_coda_lunga_promosso',
        observation_start = NULL, observation_end = NULL,
        observation_orders = 1, reactivation_check_at = NULL
    FROM _closed c
    WHERE fq.tenant_id = c.tenant_id AND fq.sku = c.sku AND c.sold;
  RETURN QUERY SELECT 'promosso'::text, COUNT(*)::bigint FROM _closed WHERE sold;

  -- non venduto -> RI-TAGLIO: fuori feed, altri 7gg, cycle++
  UPDATE feed_quarantine fq
    SET reactivated = false,
        observation_start = NULL, observation_end = NULL,
        quarantine_start = NOW(), quarantine_end = NOW()+v_rest,
        reactivation_check_at = NOW()+v_rest,
        quarantine_level = COALESCE(fq.quarantine_level,1) + 1
    FROM _closed c
    WHERE fq.tenant_id = c.tenant_id AND fq.sku = c.sku AND NOT c.sold;
  RETURN QUERY SELECT 'ritagliato'::text, COUNT(*)::bigint FROM _closed WHERE NOT sold;

  -- ===================== 3. OPEN (riposo >= 7gg -> retest 3gg) =====================
  -- writer sessione_ resta attivo: bypassa veto-incidenza sul rilascio supervisionato
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
