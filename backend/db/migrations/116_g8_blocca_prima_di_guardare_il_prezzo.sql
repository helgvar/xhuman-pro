-- 116_g8_blocca_prima_di_guardare_il_prezzo.sql
-- Difetto trovato al collaudo della 115: l'ordine di sparo dei trigger su
-- feed_actions e' ALFABETICO. 'trg_veto_rialzi_universale' viene prima di
-- 'zz_trg_pc_serve_costo_misurato' e azzera recommended_price; G8 vedeva quindi
-- una riga senza prezzo e la lasciava passare. Risultato misurato: il PRICE_CUT
-- su prodotto senza costo NASCEVA lo stesso, vuoto.
-- Ordine capo 10/09: "se non puoi misurare il pc non puo' essere fatto mai".
-- Un PRICE_CUT senza costo misurato non deve esistere nemmeno vuoto: il costo si
-- controlla PRIMA e INDIPENDENTEMENTE dal prezzo che la riga porta ancora.
CREATE OR REPLACE FUNCTION trg_pc_serve_costo_misurato_fn() RETURNS trigger AS $g8$
DECLARE
  v_writer TEXT := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
  v_costo  NUMERIC;
  v_causa  TEXT;
BEGIN
  IF NEW.action NOT IN ('PRICE_CUT','ADD') THEN RETURN NEW; END IF;

  -- 1) La misura del COSTO si fa sempre, anche se un veto precedente ha gia'
  --    tolto il prezzo: e' il costo che autorizza il taglio, non il prezzo.
  v_costo := costo_guardia(NEW.tenant_id, NEW.sku);
  IF v_costo IS NULL OR v_costo <= 0 THEN
    v_causa := 'costo non misurabile: ' || costo_fonte(NEW.tenant_id, NEW.sku);
  ELSIF NOT costo_fresco(NEW.tenant_id, NEW.sku, 12) THEN
    v_causa := 'costo non aggiornato da oltre 12h';
  ELSIF NEW.recommended_price IS NOT NULL AND NEW.recommended_price <= 0 THEN
    v_causa := 'prezzo non misurabile (0 = dato assente, mai un prezzo)';
  ELSE
    RETURN NEW;
  END IF;

  -- 2) Un PRICE_CUT senza misura non nasce. Mai. Nemmeno svuotato.
  IF NEW.action = 'PRICE_CUT' AND TG_OP = 'INSERT' THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'blocco_costo_non_misurato', 'action',
            NULL, 'PRICE_CUT non emesso', v_writer,
            'guardia G8 (ordine capo 10/09): ' || v_causa || ' - senza misura non si calcola nessun prezzo',
            NEW.action_source);
    RETURN NULL;
  END IF;

  -- 3) Una ADD non si cancella mai (uscirebbe dal feed): perde solo il prezzo.
  --    Stessa cosa per un UPDATE su un PC gia' esistente.
  IF NEW.recommended_price IS NOT NULL THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'blocco_costo_non_misurato', 'recommended_price',
            NEW.recommended_price::text, 'NULL', v_writer,
            'guardia G8 (ordine capo 10/09): ' || v_causa || ' - il prezzo esce, la riga resta',
            NEW.action_source);
    NEW.recommended_price := NULL;
  END IF;
  RETURN NEW;
END;
$g8$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename, applied_at)
SELECT '116_g8_blocca_prima_di_guardare_il_prezzo.sql', NOW()
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '116_g8_blocca_prima_di_guardare_il_prezzo.sql');
