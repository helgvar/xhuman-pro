-- 132 — LA LEGGE DEL PREZZO, UNA VOLTA SOLA (12/09/2026)
--
-- Mig 131 ha messo la legge in prezzo_vero(tenant, sku). Ma la legge e' gia'
-- scritta DUE volte: una nella funzione, una inlineata dentro
-- trg_margin_vero_fn() (un BEFORE trigger non puo' chiamare prezzo_vero:
-- leggerebbe la riga vecchia, non NEW).
--
-- Ora servono altri 8 punti di chiamata dentro i servizi JS, tutti in query
-- che scandiscono products a decine di migliaia di righe. Chiamare
-- prezzo_vero(p.tenant_id, p.sku) li' costerebbe DUE lookup per riga: uno su
-- feed_actions e uno per rileggere products, la tabella che la query sta gia'
-- scandendo. Inlineare la legge una terza (e nona) volta e' peggio: e' cosi'
-- che nascono le divergenze.
--
-- Quindi la legge scende di un piano. prezzo_vero_row() la contiene e prende
-- i tre prezzi gia' letti dal chiamante: un solo lookup, quello su
-- feed_actions, sull'indice uq_feed_action_tenant_sku. prezzo_vero() diventa
-- il suo involucro per chi ha solo la chiave.
--
-- Da qui in poi: nessun motore legge applied_price da solo. Chi ha la riga usa
-- prezzo_vero_row(), chi ha la chiave usa prezzo_vero(). Unica eccezione
-- legittima: leggere applied_price DENTRO una CTE gia' filtrata su
-- fa.recommended_price IS NOT NULL — li' lo specchio e' vivo per costruzione
-- (hourlyBattleCheck, conformityMonitor, il CLAMP del governor).

CREATE OR REPLACE FUNCTION public.prezzo_vero_row(
  p_tenant   uuid,
  p_sku      text,
  p_applied  numeric,
  p_exported numeric,
  p_sell     numeric)
RETURNS numeric LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(
           -- lo specchio Magento vale SOLO se qualcuno lo sta ancora
           -- aggiornando: appliedPriceMirror rinfresca solo chi ha un
           -- recommended_price vivo. Morta l'azione, il numero si fossilizza.
           CASE WHEN EXISTS (SELECT 1 FROM feed_actions a
                             WHERE a.tenant_id = p_tenant AND a.sku = p_sku
                               AND a.recommended_price IS NOT NULL)
                THEN NULLIF(p_applied, 0) END,
           NULLIF(p_exported, 0),
           NULLIF(p_sell, 0),
           0)
$function$;

COMMENT ON FUNCTION public.prezzo_vero_row(uuid, text, numeric, numeric, numeric) IS
  'Legge del prezzo (mig 131/132) applicata a una riga products gia'' letta. Un solo lookup su feed_actions. Chi ha solo la chiave usa prezzo_vero().';

-- prezzo_vero() resta l'entrata per chiave, ma smette di avere un corpo suo:
-- delega. Cosi' la legge e' provabilmente una sola. Comportamento invariato,
-- NULL compreso quando la riga products non esiste.
CREATE OR REPLACE FUNCTION public.prezzo_vero(p_tenant uuid, p_sku text)
RETURNS numeric LANGUAGE sql STABLE AS $function$
  SELECT prezzo_vero_row(p.tenant_id, p.sku, p.applied_price, p.exported_price, p.sell_price)
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku
$function$;
