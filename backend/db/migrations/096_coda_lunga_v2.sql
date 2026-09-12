-- ============================================================
-- 096: LOOP CODA LUNGA v2 (ordine capo 12/8) — pilota su 1 tenant (MPF)
--
-- Estende il loop retest della mig 078/079:
--   1. Perimetro a interruttore: health_config 'coda_lunga_on' per tenant
--      (con expires_at), non più UUID hardcoded.
--   2. Selezione allargata: 1-14 click/15gg (era esattamente 1) —
--      il giacimento vero della coda lunga. Sempre 0 vendite su TUTTA
--      la rete 15gg + disponibile + guardie brand/carrello.
--   3. Holdout A/B: con health_config 'coda_lunga_holdout'='1' si taglia
--      solo metà dei candidati (hash pari); l'altra metà resta nel feed
--      come GRUPPO DI CONTROLLO, registrata in coda_lunga_controllo.
--      Le vendite del controllo = misura VERA del fatturato che i tagli
--      avrebbero perso. Split deterministico: hashtext(tenant||sku).
--   4. Fail-closed freschezza: un tenant senza file click di IERI non
--      subisce NESSUN nuovo taglio quel giorno (retest/rilasci continuano).
--   5. Cap: il taglio è ordinato per click DESC, così il budget del cap
--      giornaliero (trg_cap_condanne, mig 091) si spende sui più costosi.
--   6. Whitelist status ordini allineata alla canonica (aggiunto
--      'ritiro_sede_tmp'): più prove di vendita = più protezione.
--
-- Il ciclo retest resta identico: esilio 7gg -> test 3gg in feed ->
-- vende in rete = PROMOSSO per sempre, altrimenti ri-esilio (mai permanente).
-- Il rilascio a evento vendita (~1h) è nel servizio orderSync (hook JS).
-- ============================================================

-- Il check "venduto in rete" cerca per sku SENZA tenant: serve indice globale
-- (in produzione creato CONCURRENTLY il 12/8; qui per ambienti nuovi).
CREATE INDEX IF NOT EXISTS idx_order_items_sku_global ON order_items (sku);

-- Gruppo di controllo holdout: append-only, un SKU entra una volta sola.
CREATE TABLE IF NOT EXISTS coda_lunga_controllo (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku        varchar NOT NULL,
  clicks_15g integer NOT NULL DEFAULT 0,
  listed_at  timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku)
);

CREATE OR REPLACE FUNCTION public.codalunga_retest_loop(p_dry boolean DEFAULT false)
RETURNS TABLE(phase text, n bigint)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rest interval := interval '7 days';
  v_len  interval := interval '3 days';
  v_reason text := 'loop_coda_lunga_zero_conv';
BEGIN
  -- Perimetro: tenant attivi con interruttore acceso e non scaduto
  CREATE TEMP TABLE _targets ON COMMIT DROP AS
    SELECT hc.tenant_id,
           EXISTS (SELECT 1 FROM health_config h2
                   WHERE h2.tenant_id = hc.tenant_id
                     AND h2.config_key = 'coda_lunga_holdout' AND h2.config_value = '1'
                     AND (h2.expires_at IS NULL OR h2.expires_at > NOW())) AS holdout
    FROM health_config hc
    JOIN tenants t ON t.id = hc.tenant_id AND t.status = 'active'
    WHERE hc.config_key = 'coda_lunga_on' AND hc.config_value = '1'
      AND (hc.expires_at IS NULL OR hc.expires_at > NOW());

  -- Candidati al taglio. Fail-closed: senza file click di IERI, zero tagli.
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
    SELECT t.tenant_id, p.sku, z.ck, t.holdout,
           (abs(hashtext(t.tenant_id::text || p.sku)::bigint) % 2 = 0) AS lato_taglio
    FROM _targets t
    JOIN products p ON p.tenant_id = t.tenant_id
    JOIN (SELECT tenant_id, product_code, SUM(clicks) AS ck
          FROM zombie_clicks
          WHERE fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 14
            AND tenant_id IN (SELECT tenant_id FROM _targets)
          GROUP BY 1, 2
          HAVING SUM(clicks) BETWEEN 1 AND 14) z
      ON z.tenant_id = t.tenant_id AND z.product_code = p.sku
    WHERE COALESCE(p.export_status,'1') <> '0'
      AND (COALESCE(p.erp_stock,0) > 0 OR COALESCE(p.supplier_stock,0) > 0)
      AND EXISTS (SELECT 1 FROM zombie_clicks zf
             WHERE zf.tenant_id = t.tenant_id
               AND zf.fetch_date = (NOW() AT TIME ZONE 'Europe/Rome')::date - 1)
      AND NOT EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
             WHERE oi.sku = p.sku
               AND o.order_status IN ('processing','pending','complete',
                                      'ritiro_farmacia','Ritirato','ritiro_sede_tmp')
               AND o.order_date >= NOW() - INTERVAL '15 days')
      AND NOT is_brand_protected(t.tenant_id, p.sku)
      AND NOT is_basket_protected(t.tenant_id, p.sku)
      AND NOT EXISTS (SELECT 1 FROM feed_quarantine fq
             WHERE fq.tenant_id = t.tenant_id AND fq.sku = p.sku);

  IF p_dry THEN
    RETURN QUERY
      SELECT 'cut_candidati'::text, COUNT(*)::bigint FROM _cand
      WHERE NOT holdout OR lato_taglio;
    RETURN QUERY
      SELECT 'cut_controllo'::text, COUNT(*)::bigint FROM _cand
      WHERE holdout AND NOT lato_taglio;
    RETURN QUERY
      SELECT 'open_apribili'::text, COUNT(*)::bigint FROM feed_quarantine
      WHERE reason = v_reason AND reactivated = false AND observation_start IS NULL
        AND reactivation_check_at IS NOT NULL AND reactivation_check_at <= NOW();
    RETURN QUERY
      SELECT 'close_da_valutare'::text, COUNT(*)::bigint FROM feed_quarantine
      WHERE reason = v_reason AND observation_start IS NOT NULL AND observation_end < NOW();
    RETURN;
  END IF;

  -- Registro del gruppo di controllo (solo tenant in holdout)
  INSERT INTO coda_lunga_controllo (tenant_id, sku, clicks_15g)
  SELECT c.tenant_id, c.sku, c.ck FROM _cand c
  WHERE c.holdout AND NOT c.lato_taglio
  ON CONFLICT (tenant_id, sku) DO NOTHING;

  PERFORM set_config('xhp.writer', 'loop_coda_lunga', true);
  PERFORM set_config('xhp.motivo', 'coda lunga zero-conversione v2: 1-14 click/15gg, 0 vendite rete 15gg, disponibile', true);

  WITH ins AS (
    INSERT INTO feed_quarantine
      (tenant_id, sku, reason, quarantine_start, quarantine_end, reactivation_check_at,
       quarantine_level, manual_override, is_burner_rule, is_permanent)
    SELECT c.tenant_id, c.sku, v_reason, NOW(), NOW()+v_rest, NOW()+v_rest,
           1, true, false, false
    FROM _cand c
    WHERE NOT c.holdout OR c.lato_taglio
    ORDER BY c.ck DESC
    ON CONFLICT (tenant_id, sku) DO NOTHING
    RETURNING 1)
  SELECT 'cut'::text, COUNT(*)::bigint FROM ins INTO phase, n;
  RETURN NEXT;

  CREATE TEMP TABLE _closed ON COMMIT DROP AS
    SELECT fq.tenant_id, fq.sku,
      EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id=o.id
        WHERE oi.sku = fq.sku
          AND o.order_status IN ('processing','pending','complete',
                                 'ritiro_farmacia','Ritirato','ritiro_sede_tmp')
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

-- Pilota: SOLO MPF, 30 giorni, con holdout A/B acceso.
-- 'coda_lunga_v2_since' = data attivazione, baseline del paracadute fatturato.
INSERT INTO health_config (tenant_id, config_key, config_value, expires_at)
VALUES
  ('d581c087-6b92-4050-b52a-5bd5c087553a', 'coda_lunga_on', '1', NOW() + interval '30 days'),
  ('d581c087-6b92-4050-b52a-5bd5c087553a', 'coda_lunga_holdout', '1', NOW() + interval '30 days'),
  ('d581c087-6b92-4050-b52a-5bd5c087553a', 'coda_lunga_v2_since',
   to_char((NOW() AT TIME ZONE 'Europe/Rome')::date, 'YYYY-MM-DD'), NULL)
ON CONFLICT (tenant_id, config_key)
DO UPDATE SET config_value = EXCLUDED.config_value,
              expires_at = EXCLUDED.expires_at,
              updated_at = NOW();

INSERT INTO schema_migrations (filename)
VALUES ('096_coda_lunga_v2.sql')
ON CONFLICT DO NOTHING;
