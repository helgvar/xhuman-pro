-- 084: ORDINE CAPO 4/8 — "se un prodotto viene cliccato e non vende non viene
--      protetto solo perche' e' in top 10. Taglia su tutti."
--
-- Fino a oggi is_feed_protected() proteggeva CHIUNQUE stesse in posizione <= 10,
-- con l'unico carve-out di vetrina/dieta. La posizione buona misura la VETRINA,
-- non la vendita: un prodotto che sta in top 10, incassa click e non converte
-- non e' un asset, e' una perdita con la vetrina bella.
--
-- MISURA 4/8 h12 (simulazione set-based su click reali 15gg, SKU nel feed,
-- top10 attivo, zero vendite su TUTTA la rete, nessun'altra protezione attiva):
--   SubitoFarma  1343 SKU  EUR 55,25/gg   drop feed 6,26%  paracadute disarmato
--   Procaccini    434 SKU  EUR 16,01/gg   drop feed 2,67%  paracadute disarmato
--   Papa          393 SKU  EUR 13,35/gg   drop feed 1,56%  paracadute disarmato
--   Farmastelia   566 SKU  EUR 13,24/gg   drop feed 2,12%  paracadute ARMATO
--   MPF           405 SKU  EUR  9,07/gg   drop feed 1,62%  paracadute disarmato
--   Farmainsieme   89 SKU  EUR  3,18/gg   drop feed 0,59%  paracadute disarmato
--   TOTALE operational: EUR 110,10/gg
-- Rischio fatturato misurato: 0 ordini, EUR 0,00 (per costruzione: nessuna
-- vendita in rete a 15gg su nessuna di queste righe).
-- Nessun tenant sfiora il -10% del paracadute, e l'unico ARMATO (Farmastelia)
-- sta al 2,12%. Il drenaggio reale e' comunque piu' lento del massimo teorico:
-- il filtro CSV rimuove via feed_actions/quarantena/killer, tutti soggetti al
-- CAP ANTI-STRAGE giornaliero (mig 064).
--
-- MODIFICA: la clausola top10 non protegge piu' quando lo SKU ha click negli
-- ultimi 15gg E non ha venduto da nessuna parte nella rete nello stesso periodo.
--
-- Cosa NON cambia (le altre protezioni restano tutte intere):
--   - capo_pins, brand protetti, carrello, magazzino, cohorts 72h
--   - chi vende sul proprio tenant (clausola seller 15gg, mig 080)
--   - chi vende in RETE ma non qui: vende_in_rete_15g() lo tiene protetto.
--     Per lui la strada resta il PC riposizionamento, non il taglio
--     (feedback_vende_in_rete_non_qui_pc_riposizionamento + legge L2 mig 060).
--   - chi NON ha click: nessun costo, nessun motivo di toccarlo (inerti).
--
-- PERIMETRO: attiva via health_config 'top10_no_shield_zero_sales' = '1' sui 7
-- operational + Farmacri, cioe' esattamente la lista su cui il lima PASS 3 e'
-- gia' autorizzato a scrivere REMOVE (ordine capo 15/7). San Vito e Ospedale
-- restano fuori: il loro feed e' dominio Farmabooster. Per includerli basta una
-- riga di config, non un'altra migrazione.
--
-- ROLLBACK: DELETE FROM health_config WHERE config_key='top10_no_shield_zero_sales';
--           (la funzione torna al comportamento precedente per tutti)

-- indice mirato: la clausola nuova cerca per (tenant, sku) su finestra di date,
-- l'indice esistente e' (tenant_id, fetch_date, product_code) e non serve bene
CREATE INDEX IF NOT EXISTS idx_zombie_clicks_tenant_prod_date
  ON public.zombie_clicks (tenant_id, product_code, fetch_date);

CREATE OR REPLACE FUNCTION public.ha_click_15g(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM zombie_clicks z
    WHERE z.tenant_id = p_tenant AND z.product_code = p_sku
      AND z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 15
      AND z.clicks > 0)
$function$;

CREATE OR REPLACE FUNCTION public.is_feed_protected(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
      EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id = p_tenant AND cp.sku = p_sku AND cp.revoked_at IS NULL)
      OR is_basket_protected(p_tenant, p_sku)
      OR is_brand_protected(p_tenant, p_sku)
      -- MAGAZZINO: carve-out vetrina + dieta (verificati fatturato-zero)
      OR (is_stock_protected(p_tenant, p_sku)
          AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v WHERE v.tenant_id=p_tenant AND v.sku=p_sku)
          AND NOT EXISTS (SELECT 1 FROM dieta_provati dp WHERE dp.tenant_id=p_tenant AND dp.sku=p_sku))
      -- VENDITE SELLER: chi vende resta protetto (finestra 15gg, mig 080)
      OR EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE oi.tenant_id = p_tenant AND oi.sku = p_sku
                     AND o.order_date >= NOW() - INTERVAL '15 days'
                     AND o.order_status NOT IN ('canceled','closed'))
      -- TOP10: carve-out vetrina + dieta, e (mig 084, ordine capo 4/8) NON
      -- protegge piu' chi riceve click e non vende da nessuna parte nella rete
      OR EXISTS (SELECT 1 FROM product_health_scores h WHERE h.tenant_id = p_tenant AND h.sku = p_sku
                   AND h.scraper_position <= 10
                   AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v2 WHERE v2.tenant_id=p_tenant AND v2.sku=p_sku)
                   AND NOT EXISTS (SELECT 1 FROM dieta_provati dp2 WHERE dp2.tenant_id=p_tenant AND dp2.sku=p_sku)
                   AND NOT (
                     EXISTS (SELECT 1 FROM health_config hc
                              WHERE hc.tenant_id = p_tenant
                                AND hc.config_key = 'top10_no_shield_zero_sales'
                                AND hc.config_value = '1')
                     AND ha_click_15g(p_tenant, p_sku)
                     AND NOT vende_in_rete_15g(p_sku)))
      OR EXISTS (SELECT 1 FROM activation_cohorts ac WHERE ac.tenant_id = p_tenant AND ac.sku = p_sku
                   AND ac.activated_at >= NOW() - INTERVAL '72 hours');
$function$;

-- 7 operational + Farmacri (stessa lista del lima PASS 3, ordine capo 15/7)
INSERT INTO health_config (tenant_id, config_key, config_value)
SELECT id, 'top10_no_shield_zero_sales', '1' FROM tenants
WHERE name IN ('SubitoFarma','Farmacia Papa','Papa','Farmacia Procaccini','MPF',
               'Farmainsieme','Farmastelia','Farmacia Mandanici','Farmacri')
ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = '1';

INSERT INTO schema_migrations (filename) VALUES ('084_top10_non_protegge_chi_non_vende.sql')
ON CONFLICT (filename) DO NOTHING;
