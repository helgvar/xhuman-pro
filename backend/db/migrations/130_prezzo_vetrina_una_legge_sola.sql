-- 130_prezzo_vetrina_una_legge_sola.sql
--
-- ORDINE DEL CAPO 12/09/2026:
--   "dobbiamo risolvere subito la logica con la quale tu leggi i prezzi e
--    applichi i tagli e deve essere definitiva"
--
-- IL GUASTO. products.applied_price e' lo specchio del prezzo vivo su Magento
-- (appliedPriceMirror.js, ogni 2h). Ma il mirror aggiorna SOLO gli SKU che hanno
-- una feed_actions con recommended_price NOT NULL. Quando l'azione muore, il
-- campo resta congelato PER SEMPRE. Non e' piu' uno specchio: e' un fossile.
--
--   Procaccini 930960113 BETOTAL BODY PLUS: applied_price 9,97 - prezzo vero 16,44.
--   Procaccini 034738017 ACICLOVIR:         applied_price 2,11 - prezzo vero  5,47.
--
-- MISURA. SKU in feed con applied_price scritto ma NESSUNA azione viva che lo
-- tenga aggiornato: SubitoFarma 2.826 - Farmainsieme 2.505 - Papa 2.184 -
-- Farmacri 2.091 - Procaccini 1.845 - MPF 1.096 - Mandanici 1.059 -
-- Farmastelia 720 = 12.326 fossili in feed, 1.754 con scarto oltre il 15%.
--
-- DANNO. Il fossile sta SEMPRE sotto il prezzo vero (era il prezzo di quando il
-- taglio era vivo), quindi:
--   1) margine calcolato negativo su merce in utile - 287 SKU in feed con
--      margin_pct negativo, 270 falsi (ACICLOVIR: DB -110,62%, vero +18,8%);
--   2) pc_sotto_floor_adesso() leggeva
--      COALESCE(applied_price, exported_price, sell_price) - il fossile per primo -
--      e condannava prezzi sani: 105 falsi allarmi su 570 (Procaccini 39,
--      Farmacri 26, Mandanici 23, Papa 9, MPF 7, Farmainsieme 1). Su quelli il
--      guardiano ALZAVA il prezzo per rispettare un pavimento inesistente,
--      esattamente il male che la mig 120 aveva curato dal lato del costo.
--
-- LA LEGGE, UNA SOLA, DA QUI IN POI:
--   PREZZO DI VETRINA = applied_price SOLO se lo specchio e' vivo (esiste
--                       un'azione che lo fa aggiornare), altrimenti
--                       exported_price, altrimenti sell_price.
--   COSTO             = costo_guardia() (mig 120, legge della giacenza del capo:
--                       "se il prodotto esiste in farmacia vale sempre prima
--                        quello. Quando finisce passa al best price del grossista
--                        che lo ha disponibile").
--
-- Questa migrazione NON scrive dati: crea la funzione e rifa' il guardiano
-- perche' la usi. La bonifica dei 12.326 fossili gia' scritti in products e'
-- nella 131, che resta ferma finche' il capo non da' il GO.

-- ---------------------------------------------------------------- la legge sola
CREATE OR REPLACE FUNCTION public.prezzo_vetrina(p_tenant uuid, p_sku character varying)
RETURNS numeric LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(
           -- lo specchio Magento vale solo se qualcuno lo sta ancora aggiornando
           CASE WHEN EXISTS (SELECT 1 FROM feed_actions a
                             WHERE a.tenant_id = p.tenant_id AND a.sku = p.sku
                               AND a.recommended_price IS NOT NULL)
                THEN NULLIF(p.applied_price, 0) END,
           NULLIF(p.exported_price, 0),
           NULLIF(p.sell_price, 0))
  FROM products p
  WHERE p.tenant_id = p_tenant AND p.sku = p_sku
$function$;

COMMENT ON FUNCTION public.prezzo_vetrina(uuid, character varying) IS
  'Prezzo di vetrina: applied_price solo se lo specchio Magento e vivo, altrimenti exported_price, altrimenti sell_price. Il costo che gli sta di fronte e costo_guardia(). Mig 130, ordine del capo 12/09/2026.';

-- --------------------------------------------- il guardiano usa la legge sola
CREATE OR REPLACE FUNCTION public.pc_sotto_floor_adesso(p_tenant uuid DEFAULT NULL::uuid)
RETURNS TABLE(tenant text, sku character varying, action_source text, prezzo_vivo numeric,
              costo numeric, fonte_costo text, costo_fresco boolean, margine_pct numeric,
              floor_pct numeric, floor_safe numeric, sell_price numeric)
LANGUAGE sql STABLE AS $function$
  SELECT t.name::text,
         fa.sku,
         fa.action_source::text,
         prezzo_vetrina(fa.tenant_id, fa.sku)                       AS prezzo_vivo,
         costo_guardia(fa.tenant_id, fa.sku)                        AS costo,
         costo_fonte(fa.tenant_id, fa.sku)                          AS fonte_costo,
         costo_fresco(fa.tenant_id, fa.sku, 12)                     AS costo_fresco,
         ROUND(100.0 * (prezzo_vetrina(fa.tenant_id, fa.sku) - costo_guardia(fa.tenant_id, fa.sku))
               / NULLIF(prezzo_vetrina(fa.tenant_id, fa.sku), 0), 2) AS margine_pct,
         pc_floor_pct_tenant(fa.tenant_id, prezzo_vetrina(fa.tenant_id, fa.sku)) AS floor_pct,
         pc_floor_safe(costo_guardia(fa.tenant_id, fa.sku),
                       pc_floor_pct_tenant(fa.tenant_id, prezzo_vetrina(fa.tenant_id, fa.sku))) AS floor_safe,
         p.sell_price
  FROM feed_actions fa
  JOIN tenants  t ON t.id = fa.tenant_id
  JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
  WHERE fa.action = 'PRICE_CUT'
    AND fa.status IN ('active','dispatched')
    AND (p_tenant IS NULL OR fa.tenant_id = p_tenant)
    AND prezzo_vetrina(fa.tenant_id, fa.sku) > 0
    AND costo_guardia(fa.tenant_id, fa.sku)  > 0
    AND 100.0 * (prezzo_vetrina(fa.tenant_id, fa.sku) - costo_guardia(fa.tenant_id, fa.sku))
        / NULLIF(prezzo_vetrina(fa.tenant_id, fa.sku), 0)
        < pc_floor_pct_tenant(fa.tenant_id, prezzo_vetrina(fa.tenant_id, fa.sku))
$function$;
