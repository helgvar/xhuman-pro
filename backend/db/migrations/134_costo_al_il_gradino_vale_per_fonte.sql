-- 134_costo_al_il_gradino_vale_per_fonte.sql
--
-- ORDINE DEL CAPO 15/09/2026:
--   "prima di tagliare devi essere sicuro di cosa stai leggendo questo difetto
--    e' molto grave per i conteggi. ripara, rileggi e dopo taglia"
--
-- COSA E' SUCCESSO
-- Mig 129 (12/09) riparava il bug opposto: costo_al() prendeva il MIN fra i
-- fornitori e usciva troppo BASSO (BETOTAL 930960113 a 8,5140 invece di 13,82).
-- La riparazione fu "vince la riga piu' fresca": ORDER BY data DESC, poi fonte.
-- Ha chiuso quel buco e ne ha aperto uno simmetrico.
--
-- IL DIFETTO CHE RESTA
-- product_cost_history e' un registro A GRADINI **per fonte**: si scrive una riga
-- solo quando quella fonte cambia (farmaboosterProducts.js:373-397). Quindi ogni
-- fonte ha la sua serie e ognuna e' in vigore contemporaneamente: la data ordina
-- DENTRO una fonte, non FRA fonti. Ordinando per data si mescolano serie diverse
-- e una fonte che oscilla spesso scavalca sempre quella che sta ferma perche'
-- non e' cambiata -- non perche' sia vecchia.
--
-- min_blended = products.erp_cost = il costo di riferimento con cui Farmabooster
-- calcola il markup, ed e' la fonte che rispetta la legge della giacenza. E' anche
-- quella che cambia di meno. Risultato: perdeva quasi sempre contro grossista_min.
--
-- CASO CHE HA FATTO SCOPPIARE IL BUBBONE - Procaccini 000590051 RINAZINA SPRAY:
--   min_blended    6,3700  08/09   <- in vigore, = erp_purchase_cost
--   erp_acquisto   6,3700  08/09
--   grossista_min  8,6600  11/09   <- piu' fresca, ma e' un listino grossista
--   giacenza farmacia 316 pezzi.
--   costo_al() rendeva 8,66: prodotto dichiarato SOTTOCOSTO a 7,79. Falso.
--   Margine vero 1,42 EUR/pezzo. Violava la legge del capo del 12/09: "se il
--   prodotto esiste in farmacia vale sempre prima quello".
--
-- MISURA DEL DANNO (15/09, righe con prezzo vivo e costo > 0,10):
--   costo_al piu' ALTO di costo_guardia oltre il 3%:
--     MPF 1.905 · Ospedale 1.420 · Procaccini 1.321 · Mandanici 1.310 ·
--     Farmainsieme 949 · San Vito 686 · Farmacri 683 · Papa 595 ·
--     Farmastelia 486 · SubitoFarma 429  = 9.784 SKU
--   costo_al piu' BASSO oltre il 3%: 2.096 SKU (residuo di mig 129)
--   Gonfiaggio medio del costo +21/45% a seconda del tenant, punte oltre 100x.
--   Conseguenza: margine sottostimato, MOL sottostimato, prodotti sani
--   dichiarati perdenti e candidati al taglio.
--
-- LA RIPARAZIONE: una riga sola cambiata -- i due termini dell'ORDER BY si
-- invertono. Prima si sceglie la FONTE, poi dentro quella fonte si prende il
-- gradino in vigore (data DESC). Cioe': il valore in vigore di min_blended alla
-- data richiesta; se quella fonte non ha nessuna riga si scende a grossista_min
-- e poi a erp_acquisto, nell'ordine di prudenza gia' fissato da mig 129.
-- L'interrogazione con p_source esplicito non cambia: li' la fonte e' una sola
-- e decide la data, come prima.
--
-- COLLAUDO PRIMA DI APPLICARE (misurato, non supposto):
--   BETOTAL 930960113 -> 13,8200. Il caso di mig 129 resta riparato.
--   min_blended vs costo_vero su 406.801 righe con prezzo vivo:
--     identico (<0,5 cent) su tutte tranne 410, che stanno mezzo centesimo SOPRA
--     (arrotondamento del registro). Mai sotto il costo vero: nessun prezzo puo'
--     scendere per effetto di questa migrazione.
--   costo_al riparato vs costo_guardia: 1 sopra il 3% e 17 sotto, su 406.801.
--     Oggi sono 9.784 e 2.096.
--
-- Consumatori: margine_al(), mol_tenant(), primo_giorno_costo_coperto(),
-- kpiAlerts.js, verdettoTagliCron.js, costHistoryCron.js.
-- Per una decisione su OGGI resta giusto costo_guardia(), che legge la giacenza
-- live. costo_al() serve alla serie storica, dove la giacenza di allora non e'
-- registrata e il costo di riferimento del giorno e' la miglior misura possibile.

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
  -- Il gradino vale PER FONTE: prima si sceglie la fonte, poi dentro quella
  -- fonte il gradino in vigore alla data. Invertire i due termini fa vincere
  -- la fonte che oscilla di piu', non quella giusta (vedi RINAZINA sopra).
  ORDER BY CASE h.source
             WHEN 'min_blended'   THEN 1
             WHEN 'grossista_min' THEN 2
             WHEN 'erp_acquisto'  THEN 3
             ELSE 4
           END,
           h.data DESC
  LIMIT 1
$function$;

COMMENT ON FUNCTION public.costo_al(uuid, text, date, text) IS
  'Costo di riferimento del giorno. Il registro e a gradini PER FONTE: si sceglie prima la fonte (min_blended, poi grossista_min, poi erp_acquisto), poi il gradino in vigore alla data. Per decisioni su OGGI usare costo_guardia(), che conosce la giacenza. Mig 134 corregge lordine di mig 129, ordine del capo 15/09/2026.';
