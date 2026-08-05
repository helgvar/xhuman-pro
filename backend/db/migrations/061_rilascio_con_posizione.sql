-- 061: RILASCIO CON POSIZIONE (ordine capo 15/7)
-- "Se un MINSAN vende in rete ma su un tenant no, su quel tenant va controllata
--  la POSIZIONE prima di liberarlo: troppo bassa = non venderebbe comunque e
--  rischiamo click. A monitor: se sale di posizione o ha margine per PC, si testa."
--
-- La vendita di RETE resta il biglietto d'ingresso; il cancello per-tenant è:
--   1) vende su QUESTO tenant 15g -> libero/protetto sempre
--   2) vende in rete E posizione fresca <= release_pos_max (default 10) -> libero/protetto
--   3) vende in rete ma posizione bassa/assente -> RESTA bloccato, a monitor
--      (il test con PC lo gestisce la lima costante, max 20/tenant/giorno)

-- Mappa merchant TP per tenant (finora duplicata in ogni query: ora è UNA)
CREATE TABLE IF NOT EXISTS tenant_merchant_rx (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
  rx TEXT NOT NULL
);
INSERT INTO tenant_merchant_rx (tenant_id, rx)
SELECT t.id, v.rx FROM (VALUES
  ('SubitoFarma','subitofarma'), ('MPF','personal farma'), ('Papa','farmacia papa'),
  ('Farmacia Procaccini','procaccini'), ('Farmacri','farmacri'), ('Farmainsieme','farmainsieme'),
  ('Farmacia Mandanici','mandanici'), ('Farmastelia','farmastelia'),
  ('Farmacia San Vito','san vito'), ('Farmacia Ospedale','ospedale')) v(tn, rx)
JOIN tenants t ON t.name = v.tn
ON CONFLICT (tenant_id) DO UPDATE SET rx = EXCLUDED.rx;

-- Posizione fresca del tenant su un MINSAN (scraper <=48h, ora italiana)
CREATE OR REPLACE FUNCTION pos_fresca(p_tenant UUID, p_sku TEXT) RETURNS INT AS $$
  SELECT MIN(sc.position)::int
  FROM scraper_competitors sc
  JOIN tenant_merchant_rx m ON m.tenant_id = p_tenant
  WHERE sc.product_code = p_sku AND sc.merchant ~* m.rx
    AND sc.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '48 hours'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION vende_su_tenant_15g(p_tenant UUID, p_sku TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.tenant_id = p_tenant AND oi.sku = p_sku
      AND o.order_date >= NOW() - INTERVAL '15 days'
      AND o.order_status NOT IN ('canceled','closed'))
$$ LANGUAGE sql STABLE;

-- L2 aggiornata: il veto sulla condanna scatta per (1) vendite locali, o
-- (2) vendite di rete + POSIZIONE raggiungibile su questo tenant.
-- Vendite di rete con posizione bassa: la condanna È permessa (ordine 15/7).
CREATE OR REPLACE FUNCTION trg_veto_condanna_vendente_fn() RETURNS TRIGGER AS $$
DECLARE
  v_pos INT;
  v_pos_max INT;
BEGIN
  IF TG_TABLE_NAME = 'feed_quarantine'
     AND COALESCE((row_to_json(NEW)->>'manual_override')::boolean, false) THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'feed_actions'
     AND COALESCE(row_to_json(NEW)->>'action','') <> 'REMOVE' THEN
    RETURN NEW;
  END IF;

  IF vende_su_tenant_15g(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
            COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo'),
            'L2: vende su QUESTO tenant 15g', NULL);
    RETURN NULL;
  END IF;

  IF vende_in_rete_15g(NEW.sku) THEN
    v_pos := pos_fresca(NEW.tenant_id, NEW.sku);
    SELECT COALESCE((SELECT hc.config_value::int FROM health_config hc
      WHERE hc.tenant_id = NEW.tenant_id AND hc.config_key = 'release_pos_max'), 10)
    INTO v_pos_max;
    IF v_pos IS NOT NULL AND v_pos <= v_pos_max THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
              COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo'),
              'L2: vende in rete E pos fresca ' || v_pos || ' <= ' || v_pos_max || ' su questo tenant', NULL);
      RETURN NULL;
    END IF;
    -- vende in rete ma qui non è posizionato: condanna PERMESSA (ordine 15/7)
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename)
SELECT '061_rilascio_con_posizione.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename='061_rilascio_con_posizione.sql');
