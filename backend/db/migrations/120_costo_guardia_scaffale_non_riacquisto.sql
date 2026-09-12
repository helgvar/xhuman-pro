-- 120_costo_guardia_scaffale_non_riacquisto.sql
--
-- ORDINE DEL CAPO 11/09/2026:
--   "i prezzi di farmabooster non possono essere sotto costo.
--    l'unico che non controllava il costo di acquisto eri tu."
--
-- Il pavimento di un prezzo si misura sul costo della merce CHE STO VENDENDO:
-- se c'e' scaffale, il costo e' quello dello scaffale, perche' quei pezzi li ho
-- gia' pagati. Il costo di RIACQUISTO vale solo quando lo scaffale e' vuoto, e
-- serve a CONDANNARE o a RIORDINARE, non ad alzare il pavimento di merce pagata.
--
-- Prima di questa migrazione costo_guardia() prendeva GREATEST(scaffale, riacquisto).
-- MISURA su 8.978 SKU di feed con giacenza dove riacquisto > scaffale: gonfiaggio
-- medio SubitoFarma +1.504,7% · Farmastelia +757,1% · Procaccini +496,3% ·
-- Papa +111,1% · Farmacri +92,3% · MPF +47,4% · Mandanici +32,2% · FI +26,1% ·
-- San Vito +21,8% · Ospedale +15,3%. Conseguenza: merce in utile risultava in
-- perdita, e il guardiano (pcGuardianCron, ogni 2h) ALZAVA i prezzi al floor
-- per rispettare un pavimento che non esisteva.
--
-- MISURA del cambio sui PC vivi (6.430 righe): sotto floor 997 -> 879.
-- 118 erano falsi allarmi (San Vito 24, Ospedale 62, Procaccini 26, Farmacri 5, MPF 1).
--
-- Guardia dato sporco: un costo sotto 0,05 EUR non e' un costo, e' un campo non
-- compilato (CERULICONO 921812020 a 0,0122; SubitoFarma 035618026 e 913769511 a 0,01).
-- Non puo' fare da pavimento: si ripiega sull'altra misura.
--
-- Fail-closed invariato: 0 = non misurabile. I guardiani che consumano questa
-- funzione (trg_pc_mai_sotto_floor_fn, trg_pc_serve_costo_misurato_fn,
-- trg_veto_rialzi_universale_fn, reconfirm_price_cuts_v2, pc_sotto_floor_adesso,
-- cambi_costo_su_pc) bloccano su NULL o <= 0. Nessun JS chiama questa funzione:
-- il cambio non richiede deploy ne' restart.

CREATE OR REPLACE FUNCTION public.costo_guardia(p_tenant uuid, p_sku character varying)
RETURNS numeric LANGUAGE sql STABLE AS $function$
  WITH c AS (
    SELECT
      -- costo di scaffale: vale solo se lo scaffale esiste davvero
      CASE WHEN COALESCE(p.erp_stock,0) > 0
           THEN COALESCE(NULLIF(p.erp_purchase_cost,0), NULLIF(p.erp_cost,0))
           END AS scaffale,
      -- costo di riacquisto: quanto costa il pezzo DOPO quello che vendo adesso
      COALESCE(NULLIF(p.supplier_min_cost,0), NULLIF(p.erp_cost,0)) AS riacquisto
    FROM products p
    WHERE p.tenant_id = p_tenant AND p.sku = p_sku
  )
  SELECT COALESCE(
           CASE WHEN c.scaffale   > 0.05 THEN c.scaffale   END,
           CASE WHEN c.riacquisto > 0.05 THEN c.riacquisto END,
           0)
  FROM c;
$function$;

COMMENT ON FUNCTION public.costo_guardia(uuid, varchar) IS
'Costo di riferimento per il PAVIMENTO di un prezzo (mig 120, ordine capo 11/09/2026).
Scaffale se erp_stock > 0 (quei pezzi li ho gia'' pagati), altrimenti riacquisto.
MAI GREATEST dei due: il riacquisto gonfiava il pavimento fino a +1.505% e il
guardiano alzava i prezzi per rispettarlo. Costi <= 0,05 EUR = dato sporco, si
ripiega sull''altra misura. Ritorna 0 se non misurabile: fail-closed, i guardiani
bloccano. Per CONDANNARE o RIORDINARE serve il costo di riacquisto, non questo.';
