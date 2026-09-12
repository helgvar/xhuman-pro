-- 119 — La posizione bersaglio sta nella REGOLA, non nelle costanti dei loop
--
-- Legge del capo, 11/09/2026:
--   "se sono in salvabilancio non possono essere in top3. La regola di salvabilancio
--    viene attivata quando i prodotti non rientrano nelle posizioni di classifica
--    indicate nella regola."
--
-- Misurato lo stesso giorno su price_rules (310 regole, 4 tipi):
--   tipo 1 Ricarico  : 201 su 210 regole portano scraper_position > 0 (la classifica
--                      che Farmabooster prova a raggiungere col ricarico basso)
--   tipo 2 Sconto    : 0 su 90  — nessuna posizione
--   tipo 3 SalvaBil. : 0 su 47  — nessuna posizione, e ricarico PIU' ALTO
--                      (Procaccini: Ricarico 15-22% con bersaglio pos.5,
--                       Salva Bilancio 23-31% senza bersaglio)
--   tipo 4 Muro      : 0 su 9
--
-- Conseguenza, da qui in avanti e senza ridirlo ogni volta:
--  1. Salva Bilancio NON e' una fascia di prezzo: e' il RIPIEGO. FB ci mette i
--     prodotti che non arrivano alla posizione indicata nella regola di Ricarico.
--     Essere in SB e' la prova che il prodotto NON e' posizionato.
--  2. Per un prodotto in SB non si dice mai "e' gia' in posizione". Se una misura
--     lo dice, la misura e' sbagliata — quasi sempre perche' lo snapshot scraper
--     e' povero (3-4 concorrenti: li' la terza posizione e' l'ultima) oppure perche'
--     contiene la NOSTRA stessa offerta.
--  3. La posizione bersaglio non e' 3, non e' 6 e non e' 10: e' quella scritta nella
--     regola di Ricarico del tenant. Misurata oggi: Procaccini 5, Farmainsieme 7,
--     Papa 8, MPF/Mandanici/Ospedale/Farmastelia 10, SubitoFarma 12, Farmacri 15.
--  4. Un taglio su un SB e' legittimo proprio perche' scende SOTTO il prezzo di
--     ripiego di FB — ma il pavimento resta il nostro (costo di scaffale se c'e'
--     scaffale, pc_floor_prezzo sulla fascia), mai il prezzo del ripiego.

CREATE OR REPLACE FUNCTION public.posizione_bersaglio(p_tenant uuid, p_sku varchar DEFAULT NULL)
RETURNS int LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(
    -- 1. la regola del prodotto, se e' Ricarico e indica una classifica
    (SELECT NULLIF(pr.rule_data->>'scraper_position','0')::int
       FROM products p
       JOIN price_rules pr ON pr.tenant_id = p.tenant_id AND pr.rule_id = p.price_rule_id
      WHERE p_sku IS NOT NULL
        AND p.tenant_id = p_tenant AND p.sku = p_sku
        AND (pr.rule_data->>'type')::int = 1
      LIMIT 1),
    -- 2. la classifica tipica delle regole Ricarico del tenant
    (SELECT mode() WITHIN GROUP (ORDER BY NULLIF(pr.rule_data->>'scraper_position','0')::int)
       FROM price_rules pr
      WHERE pr.tenant_id = p_tenant
        AND (pr.rule_data->>'type')::int = 1
        AND NULLIF(pr.rule_data->>'scraper_position','0') IS NOT NULL),
    -- 3. ultima spiaggia: le prime 10, le uniche che Trovaprezzi mostra
    10);
$function$;

COMMENT ON FUNCTION public.posizione_bersaglio(uuid, varchar) IS
'Posizione di classifica che Farmabooster prova a raggiungere, letta dalla regola di Ricarico (rule_data->>scraper_position) del prodotto, altrimenti la tipica del tenant, altrimenti 10. Le regole Salva Bilancio / Sconto / Muro NON portano posizione: il Salva Bilancio e'' il ripiego per chi non arriva a questa posizione. Nessun loop deve usare una costante 3/6/10 al posto di questa funzione. Migrazione 119, legge del capo 11/09/2026.';

CREATE OR REPLACE VIEW public.v_posizione_bersaglio AS
SELECT t.id AS tenant_id, t.name AS tenant,
       posizione_bersaglio(t.id, NULL) AS pos_bersaglio,
       count(*) FILTER (WHERE (pr.rule_data->>'type')::int = 1) AS regole_ricarico,
       count(*) FILTER (WHERE (pr.rule_data->>'type')::int = 3) AS regole_salva_bilancio
FROM tenants t LEFT JOIN price_rules pr ON pr.tenant_id = t.id
GROUP BY 1,2;

COMMENT ON VIEW public.v_posizione_bersaglio IS
'Una riga per tenant: la classifica bersaglio scritta nelle sue regole di Ricarico. Da leggere prima di qualunque discorso di posizione. Migrazione 119.';

-- La stessa legge scritta sulla colonna che i loop confondevano: la posizione
-- MISURATA (product_health_scores.scraper_position) non e'' la posizione VOLUTA.
COMMENT ON COLUMN public.product_health_scores.scraper_position IS
'Posizione MISURATA dallo scraper (NULL = non lo so, mai "posizione cattiva"). La posizione VOLUTA e'' un''altra cosa e sta nella regola di Ricarico: usa posizione_bersaglio(tenant, sku). Migrazione 119.';
