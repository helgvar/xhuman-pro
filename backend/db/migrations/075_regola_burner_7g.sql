-- 075_regola_burner_7g.sql
-- ============================================================================
-- REGOLA BURNER UFFICIALE (dictat capo 25/7)
--  BLOCCO:   prodotto che ha BRUCIATO negli ultimi 7gg e ha SFORATO l'incidenza
--            (costo click 7g > fatturato 7g del seller, cioè incidenza >100%),
--            con spesa reale (>= 5 click/7g). 0 vendite 7g => incidenza infinita.
--  RILASCIO: SOLO se il SINGOLO SELLER ricomincia a vendere E l'incidenza scende
--            sotto il 50% (costo click 7g < 0,5 x fatturato 7g del seller).
--  NESSUN LOOP puo' riabilitarli: veto DB su qualsiasi writer tranne 'capo_%'.
-- ============================================================================

-- marcatore durevole della classe
ALTER TABLE feed_quarantine ADD COLUMN IF NOT EXISTS is_burner_rule boolean NOT NULL DEFAULT false;

-- tag dei blocchi di oggi (taglio 7g / incidenza capo 25/7) come regola burner
UPDATE feed_quarantine
   SET is_burner_rule = true
 WHERE reactivated = false
   AND (reason LIKE 'taglio 7g%(capo 25/7)%' OR reason LIKE 'taglio incidenza (capo 25/7)%');

-- log dei tentativi di riabilitazione non autorizzati (per monitor/alert)
CREATE TABLE IF NOT EXISTS burner_rule_reactivation_log (
  id          bigserial PRIMARY KEY,
  detected_at timestamptz NOT NULL DEFAULT NOW(),
  tenant_id   uuid,
  sku         varchar,
  writer      text,
  seller_rev_7g numeric,
  click_cost_7g numeric,
  esito       text          -- 'ribloccato' | 'rilasciato_merito'
);

-- ----------------------------------------------------------------------------
-- veto_release_burner_rule: un blocco burner-rule si riabilita SOLO per merito
-- (seller vende 7g E incidenza <50%). Qualsiasi loop che tenti reactivated=true
-- viene ribloccato e loggato. Override reale solo per il capo (writer 'capo_%').
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION veto_release_burner_rule()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
  v_rev numeric; v_cc numeric;
BEGIN
  IF COALESCE(OLD.is_burner_rule, false) = true
     AND NEW.reactivated = true AND COALESCE(OLD.reactivated, false) = false THEN

    -- override esplicito del capo (mai i loop)
    IF v_writer LIKE 'capo\_%' ESCAPE '\' THEN
      RETURN NEW;
    END IF;

    -- fatturato reale 7g del SINGOLO seller (whitelist)
    SELECT COALESCE(SUM(oi.row_total_incl_tax),0) INTO v_rev
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.sku = NEW.sku AND o.tenant_id = NEW.tenant_id
        AND o.order_date >= NOW() - INTERVAL '7 days'
        AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato');
    -- costo click 7g (ivato 0,3294)
    SELECT COALESCE(SUM(z.clicks),0) * 0.3294 INTO v_cc
      FROM zombie_clicks z
      WHERE z.tenant_id = NEW.tenant_id AND z.product_code = NEW.sku
        AND z.fetch_date >= CURRENT_DATE - 7;

    -- MERITO: vende sul seller E incidenza < 50%
    IF v_rev > 0 AND v_cc < 0.5 * v_rev THEN
      INSERT INTO burner_rule_reactivation_log(tenant_id, sku, writer, seller_rev_7g, click_cost_7g, esito)
        VALUES (NEW.tenant_id, NEW.sku, v_writer, v_rev, v_cc, 'rilasciato_merito');
      RETURN NEW;
    END IF;

    -- altrimenti: RIBLOCCA + logga il loop colpevole
    INSERT INTO burner_rule_reactivation_log(tenant_id, sku, writer, seller_rev_7g, click_cost_7g, esito)
      VALUES (NEW.tenant_id, NEW.sku, v_writer, v_rev, v_cc, 'ribloccato');
    NEW.reactivated := false;
    NEW.reactivated_at := OLD.reactivated_at;
  END IF;
  RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_veto_release_burner_rule ON feed_quarantine;
CREATE TRIGGER trg_veto_release_burner_rule
  BEFORE UPDATE ON feed_quarantine
  FOR EACH ROW EXECUTE FUNCTION veto_release_burner_rule();

INSERT INTO schema_migrations (filename) VALUES ('075_regola_burner_7g.sql')
  ON CONFLICT DO NOTHING;
