-- 129_costo_al_segue_la_legge_della_giacenza.sql
--
-- ORDINE DEL CAPO 12/09/2026:
--   "il costo cambia in base alla giacenza e cambia piu' volte al giorno.
--    La regola e': Se il prodotto esiste in farmacia vale sempre prima quello.
--    Quando finisce passa al best price del grossista che lo ha disponibile"
--
-- costo_guardia() (mig 120) gia' applica questa legge sul PRESENTE e i guardiani
-- dei prezzi la usano. costo_al() -- la versione retroattiva -- no: faceva
-- MIN(costo) sull'ultima riga di OGNI fonte, quindi
--   1) prendeva il fornitore piu' economico anche se non e' quello da cui compri,
--   2) non guardava la data: una riga di un mese fa batteva quella di ieri.
--
-- CASO CHE HA FATTO SCOPPIARE IL BUBBONE - Procaccini 930960113 BETOTAL BODY PLUS:
--   storia:  11/09 min_blended 13,8200   <- fresco, e' il costo vero
--            10/08 Heron        8,5140   <- un mese fa, fornitore non usato
--            06/08 erp_acquisto 8,5140
--   costo_al() rendeva 8,5140. Pannello Farmabooster: 13,816. Giacenza farmacia 0,
--   grossista 100 -> vale il best price del grossista disponibile = 13,816.
--   Margine vero 16,0%, non 48,2%.
--
-- MISURA del danno su tutte le righe in feed (costo_al piu' basso di costo_guardia
-- oltre il 3%): SubitoFarma 2.761 · Farmacri 2.547 · MPF 2.174 · Farmainsieme 2.002 ·
-- Farmastelia 1.594 · Papa 1.119 · Procaccini 495 · Mandanici 247 = 12.939 SKU,
-- gonfiaggio medio del margine +9,1% / +17,6% a seconda del tenant, 136 casi oltre 2x.
-- Conseguenza: MOL gonfiato e tagli calcolati su un margine che non esiste.
--
-- LA RIPARAZIONE: la riga piu' FRESCA <= data, mai il MIN fra fornitori. A parita'
-- di giorno vince la fonte che Farmabooster usa come costo di riferimento
-- (min_blended, poi grossista_min, poi erp_acquisto). Le righe di singolo
-- fornitore (Heron, Guacci, ...) restano interrogabili con p_source esplicito ma
-- non concorrono piu' da sole: sono listini, non il costo della merce che vendo.
--
-- Guardia dato sporco allineata a mig 120: sotto 0,05 EUR non e' un costo, e' un
-- campo vuoto. Fail-closed invariato: NULL = non misurabile.
--
-- NOTA PER CHI LEGGE: per una decisione su OGGI si usa costo_guardia(), che sa la
-- giacenza. costo_al() serve solo alla serie storica, dove la giacenza di allora
-- non e' registrata: li' il costo di riferimento del giorno e' la miglior misura
-- disponibile.
--
-- Consumatori: margine_al(), mol_tenant(), primo_giorno_costo_coperto(),
-- kpiAlerts.js, rilascioOrario.js, verdettoTagliCron.js, costHistoryCron.js.
-- Il cambio alza i costi, quindi puo' solo rendere i giudizi piu' prudenti:
-- nessun prezzo puo' scendere per effetto di questa migrazione.

CREATE OR REPLACE FUNCTION public.costo_al(
  p_tenant uuid, p_sku text, p_data date, p_source text DEFAULT NULL::text
) RETURNS numeric LANGUAGE sql STABLE AS $function$
  SELECT h.costo
  FROM product_cost_history h
  WHERE h.tenant_id = p_tenant
    AND h.sku = p_sku
    AND h.data <= p_data
    AND h.costo > 0.05
    AND (
      -- interrogazione mirata su una fonte: si rende quella, e basta
      (p_source IS NOT NULL AND h.source = p_source)
      -- interrogazione generica: solo le fonti che sono un COSTO DELLA MERCE,
      -- non un listino di singolo grossista
      OR (p_source IS NULL AND h.source IN ('min_blended','grossista_min','erp_acquisto'))
    )
  ORDER BY h.data DESC,
           CASE h.source
             WHEN 'min_blended'   THEN 1
             WHEN 'grossista_min' THEN 2
             WHEN 'erp_acquisto'  THEN 3
             ELSE 4
           END
  LIMIT 1
$function$;

COMMENT ON FUNCTION public.costo_al(uuid, text, date, text) IS
  'Costo di riferimento del giorno: riga piu fresca <= data, mai MIN fra fornitori. Per decisioni su OGGI usare costo_guardia(), che conosce la giacenza. Mig 129, ordine del capo 12/09/2026.';
