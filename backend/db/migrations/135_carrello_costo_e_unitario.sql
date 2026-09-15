-- 135: il costo di ripiego è per unità, non per riga
--
-- refresh_sku_basket_stats() usava row_total_incl_tax * 0.75 come costo UNITARIO
-- quando il costo ERP manca, e poi lo rimoltiplicava per qty_ordered.
-- row_total_incl_tax è già il totale della riga: la quantità veniva contata due volte
-- e ogni riga senza costo con qty > 1 spingeva il margine del carrello in negativo
-- di un fattore qty (esempio reale: 131,00 - 98,25*10 = -851,50 su una riga da 131 euro).
--
-- Misurato sulla rete, finestra 15 giorni: il margine dei carrelli era sottostimato
-- di 24.116 euro e 339 SKU risultavano senza scudo carrello a torto (nessuno lo perde
-- con la correzione).
--
-- Insieme al ripiego si correggono altri due punti della stessa funzione:
--  - il CPC lordo era fermo a 0,3294; il valore vero è 0,3383 (netto 0,2773 x 1,22)
--  - gli ordini erano filtrati con NOT IN ('canceled','closed'); la legge vuole la
--    whitelist esplicita degli stati validi, così un nuovo stato non entra da solo

CREATE OR REPLACE FUNCTION public.refresh_sku_basket_stats()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM sku_basket_stats;
  INSERT INTO sku_basket_stats (tenant_id, sku, n_ord_90d, basket_margin_90d, click_cost_90d, aov_90d, refreshed_at)
  WITH ord_marg AS (
    SELECT o.id, o.tenant_id,
      SUM(oi2.row_total_incl_tax - (CASE WHEN COALESCE(p2.erp_stock,0)>0
            THEN COALESCE(NULLIF(p2.erp_purchase_cost,0), NULLIF(p2.erp_cost,0), p2.erp_cost_imputed,
                          oi2.row_total_incl_tax / NULLIF(oi2.qty_ordered,0) * 0.75)
            ELSE COALESCE(NULLIF(p2.erp_cost,0), NULLIF(p2.erp_purchase_cost,0), p2.erp_cost_imputed,
                          oi2.row_total_incl_tax / NULLIF(oi2.qty_ordered,0) * 0.75) END) * oi2.qty_ordered) AS marg,
      SUM(oi2.row_total_incl_tax) AS val
    FROM orders o JOIN order_items oi2 ON oi2.order_id = o.id
    LEFT JOIN products p2 ON p2.tenant_id = o.tenant_id AND p2.sku = oi2.sku
    WHERE o.order_date >= NOW() - INTERVAL '15 days'
      AND o.order_status IN ('complete','processing','pending','holded','payment_review','fraud','ritiro_farmacia','Ritirato')
    GROUP BY 1, 2),
  basket AS (SELECT om.tenant_id, oi.sku, COUNT(DISTINCT om.id) AS n_ord, SUM(om.marg) AS marg, AVG(om.val) AS aov
    FROM order_items oi JOIN ord_marg om ON om.id = oi.order_id GROUP BY 1, 2),
  clk AS (SELECT z.tenant_id, z.product_code AS sku, SUM(z.clicks) * 0.3383 AS cost
    FROM zombie_clicks z WHERE z.fetch_date >= NOW() - INTERVAL '15 days' GROUP BY 1, 2)
  SELECT COALESCE(b.tenant_id, c.tenant_id), COALESCE(b.sku, c.sku),
    COALESCE(b.n_ord, 0), ROUND(COALESCE(b.marg, 0), 2), ROUND(COALESCE(c.cost, 0), 2), ROUND(b.aov, 2), NOW()
  FROM basket b FULL OUTER JOIN clk c ON c.tenant_id = b.tenant_id AND c.sku = b.sku;
END;
$function$;

INSERT INTO schema_migrations (filename, applied_at)
VALUES ('135_carrello_costo_e_unitario.sql', NOW())
ON CONFLICT (filename) DO NOTHING;
