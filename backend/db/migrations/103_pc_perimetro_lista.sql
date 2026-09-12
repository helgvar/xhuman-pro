-- 103: perimetro price cut per lista nominale (ordine capo 17/08/2026)
--
-- Misura del 17/08 su Farmacia Procaccini: 144 SKU in posizione 4-5,
-- dentro il feed, 387 click e 127 EUR bruciati ogni 15 giorni, che con
-- un taglio <=10% resterebbero sopra il MOL 12%. Tutti respinti da
-- FUORI_PERIMETRO_CUT: sono a regola Ricarico e non hanno 2 ordini di
-- rete in 15 giorni. L'interruttore esistente 'pc_perimetro_esteso'
-- non li sblocca perche' pretende comunque >=1 ordine locale in 15gg.
--
-- Qui si aggiunge una terza via, volutamente STRETTA: una lista
-- nominale di SKU per tenant, in health_config.pc_perimetro_lista
-- (array JSON). Chi sta in lista e' dentro il perimetro.
--
-- Cosa NON cambia: muro e sconto restano veti assoluti e vengono prima
-- della lista, quindi un prodotto a regola Muro non e' sbloccabile
-- nemmeno mettendocelo dentro. Il floor sul costo
-- (trg_veto_sotto_costo e il passo 3 dell'igiene) resta identico.
-- La lista e' leggibile, contabile e si svuota con un UPDATE.

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
      SELECT 1 FROM health_config hc
      WHERE hc.tenant_id = p_tenant
        AND hc.config_key = 'pc_perimetro_lista'
        AND hc.config_value::jsonb ? p_sku)
    THEN true
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

INSERT INTO schema_migrations (filename) VALUES ('103_pc_perimetro_lista.sql')
ON CONFLICT DO NOTHING;
