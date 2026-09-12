-- ============================================================
-- 097: LOG OPERAZIONI LOOP CODA LUNGA (ordine capo 12/8)
--
-- "costruisci una sezione log di questo loop dove poter visualizzare
--  tutte le operazioni fatte."
--
-- Registro eventi append-only: ogni taglio, ingresso nel gruppo di
-- controllo, apertura/chiusura retest, promozione, rientro a evento
-- vendita, scatto del paracadute. La funzione codalunga_retest_loop
-- scrive qui per-SKU; il servizio JS logga rientri a evento e paracadute.
-- feed_quarantine resta lo STATO, questa tabella è la STORIA.
-- ============================================================

CREATE TABLE IF NOT EXISTS coda_lunga_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  sku TEXT,                          -- NULL per eventi tenant-wide (paracadute)
  evento TEXT NOT NULL,              -- taglio | controllo | test_aperto | promosso |
                                     -- ritagliato | rientro_evento | paracadute_off |
                                     -- rilascio_paracadute
  dettaglio TEXT,
  clicks_15g INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cll_tenant_data ON coda_lunga_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cll_evento ON coda_lunga_log (evento, created_at DESC);

-- Funzione v2 riscritta con logging per-SKU (logica identica alla 096).
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

  -- Registro del gruppo di controllo (solo tenant in holdout) + log dei nuovi
  WITH ctl AS (
    INSERT INTO coda_lunga_controllo (tenant_id, sku, clicks_15g)
    SELECT c.tenant_id, c.sku, c.ck FROM _cand c
    WHERE c.holdout AND NOT c.lato_taglio
    ON CONFLICT (tenant_id, sku) DO NOTHING
    RETURNING tenant_id, sku, clicks_15g)
  INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio, clicks_15g)
  SELECT tenant_id, sku, 'controllo', 'entrato nel gruppo di controllo holdout (resta in feed)', clicks_15g
  FROM ctl;

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
    RETURNING tenant_id, sku),
  lg AS (
    INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio, clicks_15g)
    SELECT i.tenant_id, i.sku, 'taglio', 'esilio 7gg: 1-14 click/15gg, 0 vendite rete, disponibile', c.ck
    FROM ins i JOIN _cand c ON c.tenant_id = i.tenant_id AND c.sku = i.sku
    RETURNING 1)
  SELECT 'cut'::text, COUNT(*)::bigint FROM ins INTO phase, n;
  RETURN NEXT;

  CREATE TEMP TABLE _closed ON COMMIT DROP AS
    SELECT fq.tenant_id, fq.sku, fq.quarantine_level,
      EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id=o.id
        WHERE oi.sku = fq.sku
          AND o.order_status IN ('processing','pending','complete',
                                 'ritiro_farmacia','Ritirato','ritiro_sede_tmp')
          AND o.order_date >= fq.observation_start) AS sold
    FROM feed_quarantine fq
    WHERE fq.reason = v_reason AND fq.observation_start IS NOT NULL AND fq.observation_end < NOW();

  PERFORM set_config('xhp.writer', 'sessione_loop_codalunga', true);
  PERFORM set_config('xhp.motivo', 'loop coda lunga: chiusura finestra retest 3gg', true);

  WITH prom AS (
    UPDATE feed_quarantine fq
      SET reactivated = true, reactivated_at = COALESCE(fq.reactivated_at, NOW()),
          reason = 'loop_coda_lunga_promosso',
          observation_start = NULL, observation_end = NULL,
          observation_orders = 1, reactivation_check_at = NULL
      FROM _closed c
      WHERE fq.tenant_id = c.tenant_id AND fq.sku = c.sku AND c.sold
      RETURNING fq.tenant_id, fq.sku)
  INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio)
  SELECT tenant_id, sku, 'promosso', 'venduto in rete durante il retest 3gg: resta in feed, fuori dal loop'
  FROM prom;
  RETURN QUERY SELECT 'promosso'::text, COUNT(*)::bigint FROM _closed WHERE sold;

  WITH ritag AS (
    UPDATE feed_quarantine fq
      SET reactivated = false,
          observation_start = NULL, observation_end = NULL,
          quarantine_start = NOW(), quarantine_end = NOW()+v_rest,
          reactivation_check_at = NOW()+v_rest,
          quarantine_level = COALESCE(fq.quarantine_level,1) + 1
      FROM _closed c
      WHERE fq.tenant_id = c.tenant_id AND fq.sku = c.sku AND NOT c.sold
      RETURNING fq.tenant_id, fq.sku, fq.quarantine_level)
  INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio)
  SELECT tenant_id, sku, 'ritagliato', 'retest 3gg senza vendite: ri-esilio 7gg (livello ' || quarantine_level || ')'
  FROM ritag;
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
      RETURNING fq.tenant_id, fq.sku),
  lg2 AS (
    INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio)
    SELECT tenant_id, sku, 'test_aperto', 'fine esilio 7gg: rientra in feed per retest 3gg'
    FROM opn
    RETURNING 1)
  SELECT 'test_aperto'::text, COUNT(*)::bigint FROM opn INTO phase, n;
  RETURN NEXT;

  RETURN;
END;
$function$;

-- Backfill: i rientri a evento già avvenuti oggi (prima del log) e il gruppo
-- di controllo già registrato entrano nella storia.
INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio, created_at)
SELECT fq.tenant_id, fq.sku, 'rientro_evento',
       'venduto in rete: rilascio immediato (backfill pre-log)', fq.reactivated_at
FROM feed_quarantine fq
WHERE fq.reason = 'loop_coda_lunga_promosso'
  AND fq.reactivated_at >= (NOW() AT TIME ZONE 'Europe/Rome')::date
  AND NOT EXISTS (SELECT 1 FROM coda_lunga_log l
    WHERE l.tenant_id = fq.tenant_id AND l.sku = fq.sku AND l.evento = 'rientro_evento');

INSERT INTO coda_lunga_log (tenant_id, sku, evento, dettaglio, clicks_15g, created_at)
SELECT c.tenant_id, c.sku, 'controllo',
       'entrato nel gruppo di controllo holdout (backfill pre-log)', c.clicks_15g, c.listed_at
FROM coda_lunga_controllo c
WHERE NOT EXISTS (SELECT 1 FROM coda_lunga_log l
  WHERE l.tenant_id = c.tenant_id AND l.sku = c.sku AND l.evento = 'controllo');

INSERT INTO schema_migrations (filename)
VALUES ('097_coda_lunga_log.sql')
ON CONFLICT DO NOTHING;
