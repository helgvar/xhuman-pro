-- 051: LA VERITÀ SUI TIPI REGOLA (12/7/2026, correzione capo su Farmastelia)
--
-- Le funzioni di classificazione usavano EURISTICHE (nome regola ~* 'salva',
-- budgetsave_threshold>0): su Farmastelia TUTTE le regole Ricarico hanno la
-- soglia impostata → 32k prodotti classificati SB per errore, e 494 PC sono
-- finiti su prodotti NON-SB violando la regola aurea.
--
-- FB dichiara il tipo nel rule_data: type 1=Ricarico, 2=Sconto,
-- 3=Salva Bilancio, 4=Muro (validato: 45/47 type-3 si chiamano 'Salva
-- Bilancio', 9/9 type-4 si chiamano 'Muro'). Da ora fa fede SOLO il type.

CREATE OR REPLACE FUNCTION public.is_salva_bilancio_product(p_tenant uuid, p_sku text)
 RETURNS boolean LANGUAGE sql STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM products p JOIN price_rules pr
      ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
      AND pr.rule_data->>'type' = '3');
$function$;

CREATE OR REPLACE FUNCTION public.is_sconto_rule_product(p_tenant uuid, p_sku text)
 RETURNS boolean LANGUAGE sql STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM products p JOIN price_rules pr
      ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
      AND pr.rule_data->>'type' = '2');
$function$;

CREATE OR REPLACE FUNCTION public.is_muro_rule_product(p_tenant uuid, p_sku text)
 RETURNS boolean LANGUAGE sql STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM products p JOIN price_rules pr
      ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
      AND (pr.rule_data->>'type' = '4'
           OR COALESCE((pr.rule_data->>'wall_position')::numeric, 0) > 0));
$function$;
