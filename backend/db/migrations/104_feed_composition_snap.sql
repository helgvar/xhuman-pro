-- 104: snapshot giornaliero della composizione del feed servito
--
-- Buco misurato il 18/08/2026 su MPF: il capo chiede "cosa e' cambiato nel
-- feed da ieri" e la risposta non esiste. monitor_feed_snap e' fermo al
-- 05/08 e registra solo la DIMENSIONE (feed_size), non CHI c'e' dentro.
-- feed_membership tiene un solo last_pass per SKU: sovrascritto a ogni
-- passaggio, quindi nessuno storico.
--
-- Con feed_cap_max saturo (MPF: 39.626 candidati per 19.500 posti) ogni
-- ricostruzione rimescola chi occupa i posti. Senza snapshot il churn non
-- e' ne' provabile ne' smentibile: il 17/08 il feed e' stato ricostruito
-- quattro volte e l'effetto resta ignoto.
--
-- Qui si registra la VERITA' di cosa e' stato servito, non una replica
-- della ladder di priorita' in SQL (che divergerebbe dal codice JS al
-- primo cambio). La scrittura sta dentro l'endpoint, una volta al giorno
-- per tenant: 20k righe/tenant/giorno, ritenzione 30 giorni.

CREATE TABLE IF NOT EXISTS feed_composition_snap (
  tenant_id  uuid NOT NULL,
  snap_date  date NOT NULL,
  sku        text NOT NULL,
  in_feed    boolean NOT NULL,           -- true = servito, false = tagliato dal cap
  prio       numeric,                    -- priority_score al momento del taglio
  PRIMARY KEY (tenant_id, snap_date, sku)
);

CREATE INDEX IF NOT EXISTS idx_fcs_tenant_date ON feed_composition_snap (tenant_id, snap_date DESC);
CREATE INDEX IF NOT EXISTS idx_fcs_sku ON feed_composition_snap (tenant_id, sku, snap_date DESC);

-- chi e' entrato e chi e' uscito tra due giorni
CREATE OR REPLACE FUNCTION public.feed_diff_giorni(p_tenant uuid, p_da date, p_a date)
RETURNS TABLE (movimento text, sku text, prio_da numeric, prio_a numeric)
LANGUAGE sql STABLE AS $function$
  SELECT CASE WHEN a.sku IS NULL THEN 'USCITO' ELSE 'ENTRATO' END,
         COALESCE(a.sku, b.sku), b.prio, a.prio
  FROM (SELECT sku, prio FROM feed_composition_snap
        WHERE tenant_id = p_tenant AND snap_date = p_a AND in_feed) a
  FULL OUTER JOIN (SELECT sku, prio FROM feed_composition_snap
        WHERE tenant_id = p_tenant AND snap_date = p_da AND in_feed) b
    ON b.sku = a.sku
  WHERE a.sku IS NULL OR b.sku IS NULL;
$function$;

INSERT INTO schema_migrations (filename) VALUES ('104_feed_composition_snap.sql')
ON CONFLICT DO NOTHING;
