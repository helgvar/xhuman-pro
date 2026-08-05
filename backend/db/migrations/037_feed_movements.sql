-- 037: Log entrata/uscita dal feed per ogni prodotto (direttiva utente 3/7/2026)
-- Trigger su products.is_civetta: cattura OGNI movimento indipendentemente
-- da chi lo esegue (engine, winback, pepite monitor, script manuali, sync).
-- Reason: settabile dal chiamante via GUC "SET xhp.movement_reason='...'",
-- altrimenti auto-rilevata (killer/quarantine/oblio attivi) o 'unattributed'.

CREATE TABLE IF NOT EXISTS feed_movements (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  sku VARCHAR(100) NOT NULL,
  direction VARCHAR(3) NOT NULL CHECK (direction IN ('IN','OUT')),
  reason TEXT NOT NULL DEFAULT 'unattributed',
  sell_price NUMERIC(10,2),
  ricarico_pct NUMERIC(8,2),
  erp_stock INTEGER,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feed_movements_tsku ON feed_movements(tenant_id, sku, moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_movements_time ON feed_movements(moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_movements_reason ON feed_movements(reason, moved_at DESC);

CREATE OR REPLACE FUNCTION log_feed_movement() RETURNS TRIGGER AS $$
DECLARE
  v_reason TEXT;
  v_dir TEXT;
BEGIN
  v_dir := CASE WHEN COALESCE(NEW.is_civetta, false) THEN 'IN' ELSE 'OUT' END;
  v_reason := NULLIF(current_setting('xhp.movement_reason', true), '');
  IF v_reason IS NULL THEN
    IF v_dir = 'OUT' THEN
      IF EXISTS (SELECT 1 FROM feed_killers fk
                 WHERE fk.tenant_id = NEW.tenant_id AND fk.sku = NEW.sku AND fk.is_active = true) THEN
        v_reason := 'killer';
      ELSIF EXISTS (SELECT 1 FROM feed_quarantine fq
                    WHERE fq.tenant_id = NEW.tenant_id AND fq.sku = NEW.sku AND fq.reactivated = false) THEN
        v_reason := 'quarantine';
      ELSIF EXISTS (SELECT 1 FROM cross_tenant_oblio ob
                    WHERE ob.sku = NEW.sku AND ob.status = 'active') THEN
        v_reason := 'oblio';
      ELSE
        v_reason := 'unattributed';
      END IF;
    ELSE
      -- IN: se c'è una coorte registrata nelle ultime 24h usala come firma
      SELECT 'cohort:' || ac.cohort_name INTO v_reason
      FROM activation_cohorts ac
      WHERE ac.tenant_id = NEW.tenant_id AND ac.sku = NEW.sku
        AND ac.activated_at >= NOW() - INTERVAL '24 hours'
      ORDER BY ac.activated_at DESC LIMIT 1;
      v_reason := COALESCE(v_reason, 'unattributed');
    END IF;
  END IF;
  INSERT INTO feed_movements (tenant_id, sku, direction, reason, sell_price, ricarico_pct, erp_stock)
  VALUES (NEW.tenant_id, NEW.sku, v_dir, v_reason,
    NEW.sell_price,
    CASE WHEN COALESCE(NEW.erp_cost, 0) > 0
         THEN ROUND(((NEW.sell_price - NEW.erp_cost) / NEW.erp_cost * 100)::numeric, 2) END,
    NEW.erp_stock);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feed_movement ON products;
CREATE TRIGGER trg_feed_movement
AFTER UPDATE OF is_civetta ON products
FOR EACH ROW
WHEN (COALESCE(OLD.is_civetta, false) IS DISTINCT FROM COALESCE(NEW.is_civetta, false))
EXECUTE FUNCTION log_feed_movement();

-- Prodotti nuovi che nascono già nel feed
CREATE OR REPLACE FUNCTION log_feed_movement_insert() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO feed_movements (tenant_id, sku, direction, reason, sell_price, ricarico_pct, erp_stock)
  VALUES (NEW.tenant_id, NEW.sku, 'IN',
    COALESCE(NULLIF(current_setting('xhp.movement_reason', true), ''), 'new_product'),
    NEW.sell_price,
    CASE WHEN COALESCE(NEW.erp_cost, 0) > 0
         THEN ROUND(((NEW.sell_price - NEW.erp_cost) / NEW.erp_cost * 100)::numeric, 2) END,
    NEW.erp_stock);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feed_movement_ins ON products;
CREATE TRIGGER trg_feed_movement_ins
AFTER INSERT ON products
FOR EACH ROW
WHEN (COALESCE(NEW.is_civetta, false) = true)
EXECUTE FUNCTION log_feed_movement_insert();
