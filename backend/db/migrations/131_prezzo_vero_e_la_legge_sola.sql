-- 131_prezzo_vero_e_la_legge_sola.sql
--
-- ORDINE DEL CAPO 12/09/2026:
--   "dobbiamo risolvere subito la logica con la quale tu leggi i prezzi e
--    applichi i tagli e deve essere definitiva"
--
-- La mig 130 ha scritto la legge in prezzo_vetrina() e l'ha data al rapporto
-- pc_sotto_floor_adesso(). Ma la legge non puo' stare in due funzioni: nel DB
-- esisteva gia' prezzo_vero(tenant, sku), l'astrazione giusta, solo che dentro
-- era sbagliata e non la usava nessuno. Qui la legge torna UNA: sta in
-- prezzo_vero(), e tutti i motori la chiamano. prezzo_vetrina() sparisce.
--
-- IL GUASTO (vedi mig 130 per la misura completa). products.applied_price e' lo
-- specchio del prezzo Magento, ma appliedPriceMirror.js aggiorna solo gli SKU con
-- una feed_actions.recommended_price NOT NULL. Morta l'azione, il valore resta
-- congelato per sempre: 12.326 fossili in feed. Il fossile sta SEMPRE sotto il
-- prezzo vero, perche' era il prezzo di quando il taglio era vivo.
--
-- DOVE FACEVA MALE, misurato:
--
--  1. trg_veto_rialzi_universale_fn - legge il vivo come
--     COALESCE(applied_price, exported_price, sell_price). Col fossile a 9,97
--     invece di 16,44, ogni taglio legittimo fra i due sembra un RIALZO e viene
--     azzerato in silenzio (NEW.recommended_price := NULL).
--     30gg, SKU distinti con un taglio ucciso a torto: Farmainsieme 896,
--     Papa 863, Procaccini 599, SubitoFarma 519, Mandanici 353, Farmacri 206,
--     MPF 180, Farmastelia 103 = 3.719 sui tenant operativi.
--     Stesso campo apre anche l'eccezione "rialzo_riparazione" su una falsa
--     emergenza: 34.361 rialzi in 30gg concessi su un prezzo morto.
--
--  2. merita_rilascio() - prende il fossile come prezzo, lo confronta con
--     pc_floor_prezzo() e lo trova sotto il pavimento: la quarantena non viene
--     MAI rilasciata. E' la causa dei 251/251 bocciati dell'11/09.
--
--  3. cambi_costo_su_pc() e pc_sotto_floor_adesso() - condannavano prezzi sani.
--
--  4. trg_margin_vero_fn - scrive products.margin/margin_pct partendo dal
--     fossile: 287 SKU in feed con margine negativo, 270 falsi.
--
-- NON TOCCATA: reconfirm_price_cuts(), il guardiano che pcGuardianCron chiama
-- ogni 2h. Verificato: lavora su recommended_price e costo_vero(), non legge
-- applied_price. Era pulito.
-- NON TOCCATA: reconfirm_price_cuts_v2(), che legge il fossile ma non e'
-- chiamata da nessun motore (verificato su services/ e routes/).
--
-- Questa migrazione NON scrive dati. I 12.326 fossili gia' in products restano
-- li' e restano visibili agli 11 servizi JS che leggono il campo diretto: quella
-- bonifica e' la 132, ferma in attesa del GO del capo.

-- ============================================================== 1. LA LEGGE
CREATE OR REPLACE FUNCTION public.prezzo_vero(p_tenant uuid, p_sku text)
RETURNS numeric LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(
           -- lo specchio Magento vale SOLO se qualcuno lo sta ancora aggiornando:
           -- appliedPriceMirror.js rinfresca solo chi ha un recommended_price vivo.
           CASE WHEN EXISTS (SELECT 1 FROM feed_actions a
                             WHERE a.tenant_id = p.tenant_id AND a.sku = p.sku
                               AND a.recommended_price IS NOT NULL)
                THEN NULLIF(p.applied_price, 0) END,
           NULLIF(p.exported_price, 0),
           NULLIF(p.sell_price, 0),
           0)
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku
$function$;

COMMENT ON FUNCTION public.prezzo_vero(uuid, text) IS
  'LEGGE UNICA DEL PREZZO (mig 131, ordine capo 12/09/2026): applied_price solo se lo specchio Magento e vivo, altrimenti exported_price, altrimenti sell_price, altrimenti 0 (= dato assente). Il costo che gli sta di fronte e costo_guardia() (mig 120).';

-- ==================================================== 2. IL RAPPORTO FLOOR
CREATE OR REPLACE FUNCTION public.pc_sotto_floor_adesso(p_tenant uuid DEFAULT NULL::uuid)
RETURNS TABLE(tenant text, sku character varying, action_source text, prezzo_vivo numeric,
              costo numeric, fonte_costo text, costo_fresco boolean, margine_pct numeric,
              floor_pct numeric, floor_safe numeric, sell_price numeric)
LANGUAGE sql STABLE AS $function$
  SELECT t.name::text, fa.sku, fa.action_source::text,
         prezzo_vero(fa.tenant_id, fa.sku)                          AS prezzo_vivo,
         costo_guardia(fa.tenant_id, fa.sku)                        AS costo,
         costo_fonte(fa.tenant_id, fa.sku)                          AS fonte_costo,
         costo_fresco(fa.tenant_id, fa.sku, 12)                     AS costo_fresco,
         ROUND(100.0 * (prezzo_vero(fa.tenant_id, fa.sku) - costo_guardia(fa.tenant_id, fa.sku))
               / NULLIF(prezzo_vero(fa.tenant_id, fa.sku), 0), 2)   AS margine_pct,
         pc_floor_pct_tenant(fa.tenant_id, prezzo_vero(fa.tenant_id, fa.sku)) AS floor_pct,
         pc_floor_safe(costo_guardia(fa.tenant_id, fa.sku),
                       pc_floor_pct_tenant(fa.tenant_id, prezzo_vero(fa.tenant_id, fa.sku))) AS floor_safe,
         p.sell_price
  FROM feed_actions fa
  JOIN tenants  t ON t.id = fa.tenant_id
  JOIN products p ON p.tenant_id = fa.tenant_id AND p.sku = fa.sku
  WHERE fa.action = 'PRICE_CUT'
    AND fa.status IN ('active','dispatched')
    AND (p_tenant IS NULL OR fa.tenant_id = p_tenant)
    AND prezzo_vero(fa.tenant_id, fa.sku)   > 0
    AND costo_guardia(fa.tenant_id, fa.sku) > 0
    AND 100.0 * (prezzo_vero(fa.tenant_id, fa.sku) - costo_guardia(fa.tenant_id, fa.sku))
        / NULLIF(prezzo_vero(fa.tenant_id, fa.sku), 0)
        < pc_floor_pct_tenant(fa.tenant_id, prezzo_vero(fa.tenant_id, fa.sku))
$function$;

DROP FUNCTION IF EXISTS public.prezzo_vetrina(uuid, character varying);

-- ======================================== 3. IL VETO SUI RIALZI (il killer)
CREATE OR REPLACE FUNCTION public.trg_veto_rialzi_universale_fn()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  v_vivo   NUMERIC;
  v_costo  NUMERIC;
  v_floor  NUMERIC;
  v_tetto  NUMERIC;
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF NEW.recommended_price IS NOT NULL THEN
    -- mig 131: legge unica del prezzo. Prima leggeva applied_price per primo
    -- anche quando era un fossile, e azzerava tagli legittimi.
    v_vivo := NULLIF(prezzo_vero(NEW.tenant_id, NEW.sku), 0);

    IF v_vivo IS NOT NULL AND NEW.recommended_price > v_vivo + 0.005 THEN

      v_costo := costo_guardia(NEW.tenant_id, NEW.sku);
      v_floor := pc_floor_pct_tenant(NEW.tenant_id, v_vivo);
      -- tetto = floor della fascia violata, o quello della fascia di arrivo
      -- se più severo. Mai la sola fascia di arrivo (mig 111).
      v_tetto := GREATEST(v_floor, pc_floor_pct_tenant(NEW.tenant_id, NEW.recommended_price));

      -- ECCEZIONE UNICA alla regola aurea "niente rialzi", ordine capo 10/09:
      -- il rialzo passa SOLO se e' un cambio di costo ad aver portato il margine
      -- sotto il minimo consentito, e SOLO fino al minimo. Non e' una spinta di
      -- prezzo: e' la riparazione di un prezzo diventato illegale.
      -- Ordine capo 10/09 #2: vale per QUALSIASI writer, non solo il guardiano.
      IF NEW.action = 'PRICE_CUT'
         AND v_costo > 0
         AND v_vivo > 0
         AND (v_vivo - v_costo) / v_vivo * 100 < v_floor
         AND (NEW.recommended_price - v_costo) / NEW.recommended_price * 100
             <= v_tetto + 1.0
      THEN
        INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
        VALUES (NEW.tenant_id, NEW.sku, 'rialzo_riparazione', 'recommended_price',
                v_vivo::text || ' (vivo, margine ' || ROUND((v_vivo-v_costo)/v_vivo*100,2)::text || '%)',
                NEW.recommended_price::text || ' (minimo ' || v_floor::text || '%)',
                v_writer,
                'ordine capo 10/09: il rialzo passa solo se il costo ha portato il margine sotto il minimo, e solo fino al minimo. Nessun veto lo blocca.',
                NEW.action_source);
        RETURN NEW;
      END IF;

      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', 'recommended_price',
              v_vivo::text || ' (prezzo vivo)', NEW.recommended_price::text || ' (RIALZO bloccato)',
              v_writer,
              'L1 regola aurea: mai raccomandare sopra il prezzo vivo', NEW.action_source);
      NEW.recommended_price := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ==================================================== 4. IL RILASCIO QUARANTENE
CREATE OR REPLACE FUNCTION public.merita_rilascio(p_tenant uuid, p_sku text)
RETURNS boolean LANGUAGE plpgsql STABLE COST 800 AS $function$
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
END $function$;

-- ==================================================== 5. IL WATCH SUI CAMBI COSTO
CREATE OR REPLACE FUNCTION public.cambi_costo_su_pc(p_ore numeric DEFAULT 6)
RETURNS TABLE(tenant_id uuid, tenant text, sku character varying, source character varying,
              costo_prima numeric, costo_dopo numeric, delta_pct numeric, prezzo_vivo numeric,
              margine_pct numeric, floor_pct numeric, sotto_floor boolean)
LANGUAGE sql STABLE AS $function$
  WITH r AS (
    SELECT h.tenant_id, h.sku, h.source, h.costo, h.data, h.updated_at,
           LAG(h.costo) OVER (PARTITION BY h.tenant_id, h.sku, h.source ORDER BY h.data) AS costo_prima
      FROM product_cost_history h
     WHERE h.source IN ('erp_acquisto','grossista_min','min_blended')
       AND h.data >= CURRENT_DATE - 30
  ), c AS (
    SELECT r.tenant_id, r.sku, r.source, r.costo AS costo_dopo, r.costo_prima
      FROM r
     WHERE r.updated_at > NOW() - (p_ore || ' hours')::interval
       AND r.costo_prima IS NOT NULL
       AND ABS(r.costo - r.costo_prima) > 0.005
  ), v AS (
    SELECT c.*, t.name::text AS tname,
           -- mig 131: legge unica del prezzo, non piu' il fossile
           prezzo_vero(c.tenant_id, c.sku) AS vivo,
           costo_guardia(c.tenant_id, c.sku) AS cg
      FROM c JOIN tenants t ON t.id = c.tenant_id
     WHERE EXISTS (SELECT 1 FROM feed_actions fa
                    WHERE fa.tenant_id = c.tenant_id AND fa.sku = c.sku
                      AND fa.action = 'PRICE_CUT'
                      AND fa.status IN ('pending','dispatched','active'))
  )
  SELECT v.tenant_id, v.tname, v.sku, v.source, v.costo_prima, v.costo_dopo,
         ROUND((v.costo_dopo - v.costo_prima) / NULLIF(v.costo_prima,0) * 100, 1) AS delta_pct,
         v.vivo AS prezzo_vivo,
         ROUND((v.vivo - v.cg) / NULLIF(v.vivo,0) * 100, 2) AS margine_pct,
         pc_floor_pct_tenant(v.tenant_id, v.vivo) AS floor_pct,
         (v.cg > 0 AND v.vivo > 0
          AND (v.vivo - v.cg) / v.vivo * 100 < pc_floor_pct_tenant(v.tenant_id, v.vivo)) AS sotto_floor
    FROM v;
$function$;

-- ============================================= 6. IL MARGINE SCRITTO IN products
-- Trigger BEFORE su products: non puo' chiamare prezzo_vero() (leggerebbe la riga
-- vecchia, non NEW), quindi la legge e' scritta a mano sugli stessi campi.
CREATE OR REPLACE FUNCTION public.trg_margin_vero_fn()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_prezzo NUMERIC; v_costo NUMERIC;
BEGIN
  -- mig 131: applied_price vale solo se lo specchio Magento e' vivo, cioe' se
  -- esiste ancora un'azione che lo fa aggiornare. Altrimenti e' un fossile e
  -- produceva margini negativi falsi (270 su 287 in feed).
  v_prezzo := COALESCE(
    CASE WHEN EXISTS (SELECT 1 FROM feed_actions a
                      WHERE a.tenant_id = NEW.tenant_id AND a.sku = NEW.sku
                        AND a.recommended_price IS NOT NULL)
         THEN NULLIF(NEW.applied_price,0) END,
    NULLIF(NEW.exported_price,0), NULLIF(NEW.sell_price,0), 0);
  v_costo := CASE WHEN COALESCE(NEW.erp_stock,0) > 0
    THEN COALESCE(NULLIF(NEW.erp_purchase_cost,0), NULLIF(NEW.erp_cost,0), 0)   -- magazzino farmacia
    ELSE COALESCE(NULLIF(NEW.erp_cost,0), NULLIF(NEW.erp_purchase_cost,0), 0) END; -- grossista
  IF v_prezzo > 0 AND v_costo > 0 THEN
    NEW.margin := ROUND((v_prezzo - v_costo)::numeric, 2);
    NEW.margin_pct := ROUND(((v_prezzo - v_costo)/v_prezzo*100)::numeric, 2);
  END IF;
  RETURN NEW;
END $function$;
