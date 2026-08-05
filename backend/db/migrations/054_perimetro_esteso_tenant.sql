-- 054: PERIMETRO CUT ESTESO PER-TENANT (capo 12/7 sera, per Farmastelia:
-- "non possiamo applicare PC per far salire un po' di prodotti venditori?")
--
-- Regola base (mig. 052): cut su SB sempre + Ricarico con >=2 ordini di RETE 30g.
-- Estensione: i tenant con health_config.pc_perimetro_esteso='1' accettano
-- cut anche su Ricarico con >=1 ordine LOCALE 30g (tenant in riscossa:
-- una vendita locale è prova di domanda sufficiente).
-- Attivata su Farmastelia. Sconto/Muro/rialzi: invariati, MAI.

CREATE OR REPLACE FUNCTION public.is_price_cut_allowed(p_tenant uuid, p_sku text)
 RETURNS boolean LANGUAGE sql STABLE
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
      -- >=2 ordini di RETE 30g (regola base)...
      (SELECT COUNT(DISTINCT o.id) >= 2
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.sku = p_sku
         AND o.order_date >= NOW() - INTERVAL '30 days'
         AND o.order_status NOT IN ('canceled','closed','pending_payment'))
      OR
      -- ...oppure perimetro esteso del tenant: >=1 ordine LOCALE 30g
      (EXISTS (SELECT 1 FROM health_config hc
         WHERE hc.tenant_id = p_tenant AND hc.config_key = 'pc_perimetro_esteso'
           AND hc.config_value = '1')
       AND EXISTS (
         SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE o.tenant_id = p_tenant AND oi.sku = p_sku
           AND o.order_date >= NOW() - INTERVAL '30 days'
           AND o.order_status NOT IN ('canceled','closed','pending_payment')))
    )
    ELSE false
  END;
$function$;
