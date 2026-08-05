-- 050: COORTE FRESCA = OSSERVAZIONE PROTETTA 72h (12/7/2026)
--
-- La notte dopo lo sblocco capo (103k liberati l'11/7), i motori click-based
-- hanno condannato 781 prodotti della coorte dopo POCHE ORE di esposizione
-- con 3-4 click e 0 ordini — contro la regola dell'osservazione minima
-- (5-7gg, caso Farmacri 26/5) e della soglia dinamica margine/CPC (bibbia).
--
-- Un prodotto attivato da una coorte ha diritto a 72 ORE di osservazione
-- prima di qualunque condanna: la settima classe protetta.
-- L'amnistia oraria (scraperPoller) e i trigger di veto usano is_feed_protected:
-- questa modifica libera automaticamente i bloccati-troppo-presto e impedisce
-- nuovi blocchi prematuri.

CREATE OR REPLACE FUNCTION public.is_feed_protected(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT is_basket_protected(p_tenant, p_sku)
      OR is_brand_protected(p_tenant, p_sku)
      OR is_stock_protected(p_tenant, p_sku)
      OR EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku
                   AND COALESCE(p.sales_30d_seller, 0) > 0)
      -- TOP10 (11/7: 'perché ancora bloccati in top10?' — la visibilità è sacra):
      -- un prodotto in posizione <=10 non si blocca e, se bloccato, decade
      OR EXISTS (SELECT 1 FROM product_health_scores h WHERE h.tenant_id = p_tenant AND h.sku = p_sku
                   AND h.scraper_position <= 10)
      -- COORTE FRESCA (12/7): 72h di osservazione garantita dall'attivazione —
      -- niente condanne su chi è appena entrato (3 click in poche ore non
      -- sono un verdetto; la soglia vera è dinamica: margine_eur/CPC x 1.5)
      OR EXISTS (SELECT 1 FROM activation_cohorts ac
                   WHERE ac.tenant_id = p_tenant AND ac.sku = p_sku
                     AND ac.activated_at >= NOW() - INTERVAL '72 hours');
$function$;
