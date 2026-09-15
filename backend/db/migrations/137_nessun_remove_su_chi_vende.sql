-- 137 — Nessun REMOVE puo' colpire chi vende. Regola strutturale, non disciplina.
--
-- Ordine capo 15/09: "non devi aspettare la mia domanda, deve essere il tuo
-- vangelo". Il controllo "questo taglio tocca il fatturato?" non puo' restare
-- nella testa di chi scrive la query: va nel motore, cosi' vale per OGNI writer
-- (capo, feedDailyEngine, burnerRuleCron, rumoreLoop, agente) e per sempre.
--
-- Due scudi, misurati sugli ordini reali Magento:
--   1) ha venduto su QUESTO tenant negli ultimi 30 giorni  -> niente REMOVE
--   2) vende in RETE (>=5 ordini in 30gg) ma non qui       -> niente REMOVE,
--      e' un caso da ordine 107 (riposizionamento + orologio 3 giorni)
--
-- Il trigger NON solleva eccezioni: salta la riga e la registra. Un'eccezione
-- romperebbe i loop in mezzo a una scrittura di massa; saltare no.
--
-- Freschezza: se il dato vendite e' piu' vecchio di 12h il taglio si blocca
-- lo stesso (legge capo 48: non si giudica su dati stantii).

CREATE TABLE IF NOT EXISTS sku_vendite_30d (
  tenant_id     uuid    NOT NULL,
  sku           text    NOT NULL,
  ord_tenant    integer NOT NULL DEFAULT 0,
  ord_rete      integer NOT NULL DEFAULT 0,
  refreshed_at  timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_sku_vendite_30d_fresh ON sku_vendite_30d (refreshed_at);

CREATE TABLE IF NOT EXISTS remove_bloccati_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  sku         text NOT NULL,
  writer      text,
  motivo      text NOT NULL,
  ord_tenant  integer,
  ord_rete    integer,
  bloccato_il timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_remove_bloccati_quando ON remove_bloccati_log (bloccato_il DESC);

-- Rinfresca la fotografia delle vendite a 30 giorni per tutta la rete.
CREATE OR REPLACE FUNCTION refresh_sku_vendite_30d() RETURNS integer AS $$
DECLARE v_n integer;
BEGIN
  CREATE TEMP TABLE _v30 ON COMMIT DROP AS
  WITH t AS (
    SELECT o.tenant_id, oi.sku, COUNT(DISTINCT o.id) n
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.order_date >= NOW() - INTERVAL '30 days'
       AND o.order_status IN ('complete','processing','pending','holded',
                              'payment_review','fraud','ritiro_farmacia','Ritirato')
     GROUP BY 1,2),
  r AS (
    SELECT sku, SUM(n)::int n FROM t GROUP BY 1)
  SELECT t.tenant_id, t.sku, t.n::int ord_tenant, r.n ord_rete
    FROM t JOIN r ON r.sku = t.sku;

  -- gli SKU che vendono in rete ma non su un tenant servono lo stesso:
  -- li aggiungiamo con ord_tenant = 0 sui tenant dove sono a catalogo
  INSERT INTO _v30 (tenant_id, sku, ord_tenant, ord_rete)
  SELECT p.tenant_id, p.sku, 0, r.n
    FROM (SELECT sku, SUM(ord_tenant)::int n FROM _v30 GROUP BY 1) r
    JOIN products p ON p.sku = r.sku
   WHERE NOT EXISTS (SELECT 1 FROM _v30 v WHERE v.tenant_id = p.tenant_id AND v.sku = p.sku)
     AND r.n >= 5;

  TRUNCATE sku_vendite_30d;
  INSERT INTO sku_vendite_30d (tenant_id, sku, ord_tenant, ord_rete, refreshed_at)
  SELECT tenant_id, sku, ord_tenant, ord_rete, NOW() FROM _v30;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$ LANGUAGE plpgsql;

-- Verdetto per un singolo SKU. Via veloce sulla fotografia se fresca,
-- via lenta sugli ordini se la fotografia manca o e' vecchia.
CREATE OR REPLACE FUNCTION vende_adesso(p_tenant uuid, p_sku text,
                                        OUT ord_tenant integer, OUT ord_rete integer)
AS $$
DECLARE v_fresh timestamptz;
BEGIN
  SELECT MAX(refreshed_at) INTO v_fresh FROM sku_vendite_30d;
  IF v_fresh IS NOT NULL AND v_fresh > NOW() - INTERVAL '12 hours' THEN
    SELECT COALESCE(v.ord_tenant,0), COALESCE(v.ord_rete,0)
      INTO ord_tenant, ord_rete
      FROM sku_vendite_30d v WHERE v.tenant_id = p_tenant AND v.sku = p_sku;
    ord_tenant := COALESCE(ord_tenant, 0);
    ord_rete   := COALESCE(ord_rete, 0);
    RETURN;
  END IF;
  SELECT COUNT(DISTINCT o.id) FILTER (WHERE o.tenant_id = p_tenant),
         COUNT(DISTINCT o.id)
    INTO ord_tenant, ord_rete
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
   WHERE oi.sku = p_sku
     AND o.order_date >= NOW() - INTERVAL '30 days'
     AND o.order_status IN ('complete','processing','pending','holded',
                            'payment_review','fraud','ritiro_farmacia','Ritirato');
  ord_tenant := COALESCE(ord_tenant, 0);
  ord_rete   := COALESCE(ord_rete, 0);
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION zz_f_remove_mai_su_chi_vende() RETURNS trigger AS $$
DECLARE v_ot integer; v_or integer; v_motivo text;
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

  INSERT INTO remove_bloccati_log (tenant_id, sku, writer, motivo, ord_tenant, ord_rete)
  VALUES (NEW.tenant_id, NEW.sku,
          COALESCE(current_setting('xhp.writer', true), NEW.action_source),
          v_motivo, v_ot, v_or);

  IF TG_OP = 'UPDATE' THEN RETURN OLD; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zz_trg_remove_mai_su_chi_vende ON feed_actions;
CREATE TRIGGER zz_trg_remove_mai_su_chi_vende
  BEFORE INSERT OR UPDATE ON feed_actions
  FOR EACH ROW EXECUTE FUNCTION zz_f_remove_mai_su_chi_vende();

SELECT refresh_sku_vendite_30d();

INSERT INTO schema_migrations (filename, applied_at)
VALUES ('137_nessun_remove_su_chi_vende.sql', NOW())
ON CONFLICT (filename) DO NOTHING;
