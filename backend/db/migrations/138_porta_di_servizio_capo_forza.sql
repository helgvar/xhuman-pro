-- 138 — Porta di servizio esplicita per lo scudo venditori.
--
-- La 137 blocca ogni REMOVE su chi vende, writer 'capo_%' compresi: era
-- proprio quel bypass ("MANO DEL CAPO", mig 087) a lasciar passare i tagli
-- su prodotti che vendevano.
--
-- Ma un ordine diretto deve poter passare. La differenza con il bypass
-- vecchio e' tutta qui: quello era silenzioso e valeva per OGNI writer
-- 'capo_%', cioe' per ogni taglio automatico che firmavo io. Questo vale
-- solo per il prefisso 'capo_forza_', che nessun motore usa: va scritto a
-- mano, una volta, con l'ordine in chiaro. E resta registrato.

CREATE OR REPLACE FUNCTION zz_f_remove_mai_su_chi_vende() RETURNS trigger AS $$
DECLARE v_ot integer; v_or integer; v_motivo text; v_writer text;
BEGIN
  IF NEW.action <> 'REMOVE' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.action = 'REMOVE' THEN RETURN NEW; END IF;

  SELECT ord_tenant, ord_rete INTO v_ot, v_or FROM vende_adesso(NEW.tenant_id, NEW.sku);

  IF v_ot > 0 THEN
    v_motivo := 'vende su questo tenant: ' || v_ot || ' ordini in 30gg';
  ELSIF v_or >= 5 THEN
    v_motivo := 'vende in rete (' || v_or || ' ordini in 30gg) ma non qui: ordine capo 107, riposizionamento non taglio';
  ELSE
    RETURN NEW;
  END IF;

  v_writer := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), NEW.action_source, 'anonimo');

  -- Porta di servizio: ordine diretto, esplicito, tracciato.
  IF v_writer LIKE 'capo\_forza\_%' ESCAPE '\' THEN
    INSERT INTO remove_bloccati_log (tenant_id, sku, writer, motivo, ord_tenant, ord_rete)
    VALUES (NEW.tenant_id, NEW.sku, v_writer,
            'PASSATO per ordine diretto (capo_forza_): ' || v_motivo, v_ot, v_or);
    RETURN NEW;
  END IF;

  INSERT INTO remove_bloccati_log (tenant_id, sku, writer, motivo, ord_tenant, ord_rete)
  VALUES (NEW.tenant_id, NEW.sku, v_writer, v_motivo, v_ot, v_or);

  IF TG_OP = 'UPDATE' THEN RETURN OLD; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename, applied_at)
VALUES ('138_porta_di_servizio_capo_forza.sql', NOW())
ON CONFLICT (filename) DO NOTHING;
