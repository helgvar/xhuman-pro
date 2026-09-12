-- =====================================================================
-- 111 — La deroga al rialzo si misura sul floor della fascia VIOLATA
-- =====================================================================
-- Ordine capo 10/09 #2: "il rialzo è accettato solo se un cambio di costo
--   fa andare la marginalità sotto il minimo consentito"
-- Ordine capo 10/09 #3: "per niente al mondo i prezzi ai possono andare
--   sotto floor. non esiste nessun veto o nessun ordine manuale che può
--   bloccare il ricalcolo di un prezzo ai che va sotto floor"
--
-- DIFETTO MISURATO (mig 109): la deroga controllava il tetto del rialzo con
-- pc_floor_pct_tenant(tenant, NEW.recommended_price) — cioè la fascia del
-- prezzo GIA' RIPARATO. Ma i floor scendono al salire del prezzo
-- (<5€ 25% · <10 19% · <30 16% · <50 13% · oltre 11%): riparare un prezzo
-- fa spesso cambiare fascia verso l'alto, quindi la riparazione risultava
-- "troppo grassa" per la fascia nuova e veniva azzerata come L1.
--
-- Esempio reale: costo 8,50 · vivo 9,80 (margine 13,3%, fascia <10 = 19%)
--   floor_safe = 10,50 · fascia nuova <30 = 16% · (10,50-8,50)/10,50 = 19,05%
--   19,05 > 16+1 -> VETO. Il taglio restava rotto e senza prezzo.
--
-- Misura sul campo (test in transazione, 400 tagli sotto floor):
--   400 riparazioni tentate -> 365 azzerate da L1, 0 passate.
--
-- CORREZIONE: il tetto è il floor della fascia VIOLATA (prezzo vivo), non
-- quello della fascia di arrivo. GREATEST fra le due per prudenza: se mai
-- la fascia di arrivo chiedesse di più, vince la più severa.
-- Il rialzo resta comunque limitato dal costo: max = costo/(1-floor/100).
-- =====================================================================

CREATE OR REPLACE FUNCTION trg_veto_rialzi_universale_fn() RETURNS trigger AS $$
DECLARE
  v_vivo   NUMERIC;
  v_costo  NUMERIC;
  v_floor  NUMERIC;
  v_tetto  NUMERIC;
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  IF NEW.recommended_price IS NOT NULL THEN
    SELECT COALESCE(p.applied_price, p.exported_price, p.sell_price) INTO v_vivo
    FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku;

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
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename, applied_at)
SELECT '111_deroga_rialzo_floor_di_fascia.sql', NOW()
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '111_deroga_rialzo_floor_di_fascia.sql');
