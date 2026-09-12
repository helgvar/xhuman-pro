-- RECUPERO 121..128 — ricostruite dal database il 12/09/2026
--
-- Queste otto migrazioni risultano in schema_migrations ma il file non esiste
-- da nessuna parte: sono state applicate a mano, incollando SQL in psql, e il
-- testo non e' mai stato salvato. Il repo diceva 091 mentre il database era a
-- 131: e' lo stesso buco che il 12/09 ha fatto divergere backend/ dal
-- container.
--
--   121_legge_del_rilascio.sql                 2026-09-11 19:28:56
--   122_guardie_rilascio_legge_121.sql         2026-09-11 19:28:56
--   123_legge_del_mol.sql                      2026-09-11 21:13:05
--   124_cpc_non_stantio.sql                    2026-09-11 21:14:02
--   125_cpc_config_e_netto.sql                 2026-09-11 21:14:51
--   126_spedizione_saldo_non_solo_perdita.sql  2026-09-11 21:25:16
--   127_mol_dichiara_copertura_costo.sql       2026-09-11 21:27:20
--   128_copertura_costo_cumulata.sql           2026-09-11 21:28:27
--
-- Verificato sul database: quelle otto hanno creato SOLO le quattro funzioni
-- qui sotto. Nessuna vista, nessun trigger, nessuna colonna (cercati con
-- information_schema.views / pg_trigger / information_schema.columns su
-- 'mol|cpc|copertura|rilascio|spedizion': zero risultati veri, solo colonne di
-- tabelle di lavoro zz_/tmp_).
--
-- Questo file NON e' la storia: e' lo stato finale. Se due migrazioni hanno
-- toccato la stessa funzione, qui si vede solo l'ultima versione. Serve a
-- poter ricostruire il database, non a raccontare come ci si e' arrivati.
--
-- Non registrare questo file in schema_migrations: le otto righe ci sono gia'.
-- Nessun runner automatico legge questa cartella, si applica a mano.

CREATE OR REPLACE FUNCTION public.cpc_tenant(p_tenant uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
  SELECT COALESCE(
    (SELECT ROUND(NULLIF(hc.config_value,'')::numeric * 1.22, 4)
       FROM health_config hc
      WHERE hc.tenant_id = p_tenant
        AND hc.config_key = 'avg_tp_cpc'
        AND hc.updated_at > NOW() - INTERVAL '90 days'),
    0.3294);
$function$
;

CREATE OR REPLACE FUNCTION public.merita_rilascio(p_tenant uuid, p_sku text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE COST 800
AS $function$
DECLARE
  v_prezzo numeric; v_costo numeric; v_stock int; v_sup int;
  v_pos int; v_bers int;
BEGIN
  -- (b) DISPONIBILE + prezzo vivo. mig 131: legge unica del prezzo — prima
  --     prendeva il fossile, lo trovava sotto il pavimento e non rilasciava mai.
  v_prezzo := NULLIF(prezzo_vero(p_tenant, p_sku), 0);
  SELECT COALESCE(p.erp_stock,0), COALESCE(p.supplier_stock,0)
    INTO v_stock, v_sup
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku;

  IF v_prezzo IS NULL OR v_prezzo <= 0 THEN RETURN false; END IF;   -- prezzo 0 = dato ASSENTE
  IF v_stock <= 0 AND v_sup <= 0 THEN RETURN false; END IF;          -- non disponibile

  -- (c) COSTO MISURATO. Niente costo, niente giudizio: la macchina si tiene sul costo.
  v_costo := costo_guardia(p_tenant, p_sku);
  IF v_costo IS NULL OR v_costo <= 0 THEN RETURN false; END IF;

  -- (d) MARGINE sopra il floor di fascia. Mai sottocosto, mai sotto floor.
  IF v_prezzo <= pc_floor_prezzo(p_tenant, v_prezzo, v_costo) THEN RETURN false; END IF;

  -- (a) VENDE negli ultimi 30gg: qui OPPURE in rete. Il locale da solo non si puo'
  --     usare — chi e' in quarantena e' fuori vetrina e ha zero per costruzione.
  IF NOT EXISTS (
    SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.sku = p_sku
       AND o.order_date >= NOW() - INTERVAL '30 days'
       AND o.order_status = ANY (stati_ordine_validi())
     LIMIT 1) THEN RETURN false; END IF;

  -- (e) POSIZIONABILE sul secco, entro il bersaglio della REGOLA del tenant.
  v_pos  := posizione_secco_fresca(p_sku, v_prezzo);
  IF v_pos IS NULL THEN RETURN false; END IF;             -- non misurabile = non si rilascia
  v_bers := COALESCE(posizione_bersaglio(p_tenant, p_sku), 10);
  IF v_pos > v_bers THEN RETURN false; END IF;

  RETURN true;
END $function$
;

CREATE OR REPLACE FUNCTION public.mol_tenant(p_tenant uuid, p_da date, p_a date)
 RETURNS TABLE(ordini integer, ricavo numeric, costo_prodotto numeric, margine_lordo numeric, margine_pct numeric, spesa_tp numeric, incidenza_pct numeric, spedizione_negozio numeric, mol_eur numeric, mol_pct numeric, righe integer, righe_senza_costo integer, ricavo_senza_costo numeric, copertura_costo_pct numeric)
 LANGUAGE sql
 STABLE COST 2000
AS $function$
  WITH o AS (
    SELECT o.id, o.order_status, o.shipping_incl_tax
    FROM orders o
    WHERE o.tenant_id = p_tenant
      AND o.order_status = ANY (stati_ordine_validi())
      AND (o.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN p_da AND p_a),
  r AS (
    SELECT oi.sku, oi.qty_ordered, oi.row_total_incl_tax,
           costo_al(p_tenant, oi.sku,
                    (ord.order_date AT TIME ZONE 'Europe/Rome')::date) AS costo
    FROM orders ord JOIN order_items oi ON oi.order_id = ord.id
    WHERE ord.tenant_id = p_tenant
      AND ord.order_status = ANY (stati_ordine_validi())
      AND (ord.order_date AT TIME ZONE 'Europe/Rome')::date BETWEEN p_da AND p_a),
  t AS (
    SELECT COALESCE(SUM(z.clicks),0) * cpc_tenant(p_tenant) AS tp
    FROM zombie_clicks z
    WHERE z.tenant_id = p_tenant AND z.fetch_date BETWEEN p_da AND p_a),
  s AS (
    SELECT COALESCE(SUM(spedizione_a_carico_negozio(p_tenant, o.order_status, o.shipping_incl_tax)),0) AS sped,
           COUNT(*)::int AS ord
    FROM o)
  SELECT s.ord,
         ROUND(SUM(r.row_total_incl_tax),2),
         ROUND(SUM(COALESCE(r.costo,0) * r.qty_ordered),2),
         ROUND(SUM(r.row_total_incl_tax) - SUM(COALESCE(r.costo,0)*r.qty_ordered),2),
         ROUND((SUM(r.row_total_incl_tax) - SUM(COALESCE(r.costo,0)*r.qty_ordered))
               / NULLIF(SUM(r.row_total_incl_tax),0) * 100, 1),
         ROUND(t.tp,2),
         ROUND(t.tp / NULLIF(SUM(r.row_total_incl_tax),0) * 100, 2),
         ROUND(s.sped,2),
         ROUND(SUM(r.row_total_incl_tax) - SUM(COALESCE(r.costo,0)*r.qty_ordered) - t.tp - s.sped, 2),
         ROUND((SUM(r.row_total_incl_tax) - SUM(COALESCE(r.costo,0)*r.qty_ordered) - t.tp - s.sped)
               / NULLIF(SUM(r.row_total_incl_tax),0) * 100, 1),
         COUNT(*)::int,
         COUNT(*) FILTER (WHERE r.costo IS NULL)::int,
         ROUND(COALESCE(SUM(r.row_total_incl_tax) FILTER (WHERE r.costo IS NULL),0),2),
         ROUND(100 - COALESCE(SUM(r.row_total_incl_tax) FILTER (WHERE r.costo IS NULL),0)
               / NULLIF(SUM(r.row_total_incl_tax),0) * 100, 2)
  FROM r, t, s
  GROUP BY t.tp, s.sped, s.ord;
$function$
;

CREATE OR REPLACE FUNCTION public.spedizione_a_carico_negozio(p_tenant uuid, p_order_status text, p_shipping_incl_tax numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN p_order_status IN ('ritiro_farmacia','Ritirato') THEN 0
    ELSE costo_corriere(p_tenant) - COALESCE(p_shipping_incl_tax,0)
  END;
$function$
;

