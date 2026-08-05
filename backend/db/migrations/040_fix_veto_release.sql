-- 040: FIX trigger quadra brand protetti (bug scoperto 9/7/2026)
-- Il veto_kill_brand_protetti faceva RETURN OLD su OGNI UPDATE di righe con
-- brand protetto: annullava silenziosamente anche i RILASCI (is_active=false,
-- reactivated=true). Risultato: 136 blocchi su brand protetti impossibili da
-- sciogliere — le amnistie riportavano "UPDATE n" ma i valori restavano vecchi.
-- Regola corretta: vieta l'ARMA (attivazione), permetti sempre il rilascio.
-- Aggiunto anche il match su manufacturer (coerenza con il resto del sistema).

CREATE OR REPLACE FUNCTION veto_kill_brand_protetti()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM products p
    JOIN health_config hc ON hc.tenant_id = p.tenant_id AND hc.config_key = 'killer_protected_brands'
    WHERE p.tenant_id = NEW.tenant_id AND p.sku = NEW.sku
      AND (UPPER(COALESCE(p.brand,'')) IN (SELECT BTRIM(UPPER(x)) FROM unnest(STRING_TO_ARRAY(hc.config_value, ',')) x)
           OR UPPER(COALESCE(p.manufacturer,'')) IN (SELECT BTRIM(UPPER(x)) FROM unnest(STRING_TO_ARRAY(hc.config_value, ',')) x))
  ) THEN
    IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;
    -- UPDATE: veto SOLO se arma il blocco; il rilascio passa sempre
    IF (TG_TABLE_NAME = 'feed_killers' AND (to_jsonb(NEW)->>'is_active')::boolean IS TRUE)
       OR (TG_TABLE_NAME = 'feed_quarantine' AND (to_jsonb(NEW)->>'reactivated')::boolean IS FALSE) THEN
      RETURN OLD;
    END IF;
  END IF;
  RETURN NEW;
END; $function$;
