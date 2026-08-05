-- 044: L'ORDINE DEI RAGIONAMENTI (dictat utente 10/7 pomeriggio)
-- "Devi ragionare su come fare i ragionamenti: cosa aggiornare prima e cosa
-- aggiornare dopo. Se ogni volta blocchi i prodotti e poi ti accorgi che non
-- andavano bloccati, andiamo a mare con tutti i panni."
--
-- Principio: PRIMA i dati freschi, POI il giudizio, POI (per ultima) la
-- condanna. Le azioni che AGGIUNGONO possono girare su dati imperfetti
-- (errore = qualche click); le azioni che TOLGONO esigono dati freschi e
-- merito assente su TUTTI i segnali (errore = fatturato e fiducia).
--
-- Enforcement fisico, non promessa:
-- 1. is_feed_protected() unifica TUTTI i segnali di merito, incluso il
--    venduto seller FB (sales_30d_seller — il buco trovato oggi su SF).
-- 2. FAIL-CLOSED sulla freschezza: prodotto con dati più vecchi di 12h =
--    NESSUNA condanna possibile. Dati stantii → si aggiorna prima, si
--    giudica poi.

CREATE OR REPLACE FUNCTION is_feed_protected(p_tenant UUID, p_sku TEXT) RETURNS boolean AS $fn$
  SELECT is_basket_protected(p_tenant, p_sku)
      OR is_brand_protected(p_tenant, p_sku)
      OR is_stock_protected(p_tenant, p_sku)
      OR EXISTS (SELECT 1 FROM products p
                 WHERE p.tenant_id = p_tenant AND p.sku = p_sku
                   AND COALESCE(p.sales_30d_seller, 0) > 0);
$fn$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_veto_basket_fn() RETURNS trigger AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'feed_actions'
     AND (to_jsonb(NEW)->>'action') IS DISTINCT FROM 'REMOVE' THEN
    RETURN NEW;
  END IF;
  IF is_feed_protected(NEW.tenant_id, NEW.sku)
     OR EXISTS (SELECT 1 FROM products p
                WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku
                  AND p.updated_at < NOW() - INTERVAL '12 hours') THEN
    INSERT INTO basket_veto_log (tenant_id, sku, target_table)
    VALUES (NEW.tenant_id, NEW.sku, TG_TABLE_NAME || ':' || TG_OP);
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
