-- 082: LEVA D — coda lunga rotante (capo 3/8: "la spesa e' troppo alta ancora")
--
-- Diagnosi 3/8 su click reali: il 70% della spesa TP di MPF e Farmastelia sta
-- in SKU da 1-2 click/giorno, ~400 codici per tenant. Di questi, ~€105/gg per
-- tenant sono a ZERO ordini 15gg e restano dentro per la SOLA protezione
-- top10 di is_feed_protected. Il carve-out vetrina esiste gia' per questo
-- caso, ma non li vede mai: la vetrina pretende 8 click su 15gg e loro ne
-- fanno 2,4-3,0 su 1,8-2,0 giorni attivi. RUOTANO: codici diversi ogni
-- settimana, nessuno raggiunge mai la soglia. E' il gap coda-lunga.
--
-- Due modifiche a refresh_vetrina_piena():
--
-- 1) SOGLIA CLICK PER-TENANT. v_click_min (global_config, oggi 8) diventa
--    sovrascrivibile per tenant via health_config 'vetrina_click_min'.
--    Settata a 2 SOLO su MPF e Farmastelia: gli altri tenant non cambiano di
--    una riga. Chirurgico e reversibile (DELETE della riga health_config).
--
-- 2) GUARDIA RETE. La vetrina non guardava le vendite di RETE: poteva
--    candidare SKU che vendono su un tenant sorella. Il REMOVE sarebbe stato
--    vetato da L2 (mig 060) alla scrittura, MA l'appartenenza a
--    vetrina_piena_provati toglie la protezione top10/stock in
--    is_feed_protected, e il filtro strict puo' far cadere lo SKU dal CSV
--    senza mai passare da feed_actions — quindi senza mai incontrare L2.
--    La guardia chiude quella scorciatoia: chi vende in rete non entra
--    nemmeno tra i candidati. Per lui la strada resta il PC riposizionamento
--    (vedi feedback_vende_in_rete_non_qui_pc_riposizionamento).
--
-- Simulazione BEGIN/ROLLBACK 3/8 h21: 1.305 righe totali, di cui
--   MPF 82->403 SKU, Farmastelia 63->534.
--   ordini diretti = 0, fatturato = 0, vendite di rete = 0 su TUTTE le righe.
--   Risparmio sui click di oggi: Farmastelia €36,56/gg, MPF €30,30/gg.
-- La guardia rete toglie dai candidati 243 SKU di rete (€12.661 fatturato
-- 15gg) che il REMOVE non avrebbe comunque potuto toccare.
--
-- ROLLBACK: DELETE FROM health_config WHERE config_key='vetrina_click_min';
--           + ripristino funzione da 081_vetrina_solo_zero_vendite.sql

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
  v_ord_max INT := COALESCE((SELECT config_value::int FROM global_config WHERE config_key='vetrina_ord_max'), 2);
BEGIN
  DELETE FROM vetrina_piena_provati;
  INSERT INTO vetrina_piena_provati
    (tenant_id, sku, click_90g, costo_90g, ordini_rete_90g, fatt_90g, basket_margin_90g, pos)
  WITH ck AS (
    SELECT z.tenant_id, z.product_code sku, SUM(z.clicks) click90, ROUND(SUM(z.clicks)*0.3294, 2) costo90
    FROM zombie_clicks z WHERE z.fetch_date >= CURRENT_DATE - 15
    GROUP BY 1,2
    -- soglia click per-tenant (mig 082): health_config vince su global_config
    HAVING SUM(z.clicks) >= COALESCE(
      (SELECT hc.config_value::int FROM health_config hc
        WHERE hc.tenant_id = z.tenant_id AND hc.config_key = 'vetrina_click_min'), v_click_min)),
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
    WHERE COALESCE(d.ordn,0) <= v_ord_max
      -- GUARDIA RETE (mig 082): chi vende su una sorella non e' candidato
      AND COALESCE(rt.n,0) = 0
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

-- soglia 2 click/15gg SOLO su MPF e Farmastelia (mandato incidenza 7%)
INSERT INTO health_config (tenant_id, config_key, config_value)
VALUES ('d581c087-6b92-4050-b52a-5bd5c087553a','vetrina_click_min','2'),
       ('ab7353a4-5916-4ef2-874b-3058430a53ee','vetrina_click_min','2')
ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value='2';

INSERT INTO schema_migrations (filename) VALUES ('082_coda_lunga_soglia_per_tenant.sql')
ON CONFLICT (filename) DO NOTHING;
