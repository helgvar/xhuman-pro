-- 071_riattivazione_margine_100.sql
-- ============================================================================
-- DICTAT capo 24/7 — "porta tutto a 100% di margine prodotto bruciato e
-- schedula le riattivazioni solo quando:
--   1) riprendono vendite da altri canali (vende in rete)
--   2) erano bloccati arrivando da suppliers e col restock in farmacia cambiano
--      prezzo di vendita e acquisto (magazzino: erp_stock>0 -> economia flippa)
--   3) se nessuna delle 2, un TEST di 5 giorni ogni 20gg per ri-testarli."
--
-- Le SOGLIE dei loop (lima/burner/killer) passano a 100% di margine unitario
-- VERO bruciato (coeff 1.0, non 1.5) via i rispettivi cron. Qui vive l'UNICA
-- autorita' di RIATTIVAZIONE per la classe "margine bruciato".
-- ============================================================================

-- Ledger della cadenza test (unica fonte di verita' del ciclo 20+5).
CREATE TABLE IF NOT EXISTS margin_block_tests (
  tenant_id     uuid        NOT NULL,
  sku           varchar     NOT NULL,
  block_source  text        NOT NULL,          -- 'lima' | 'burner' | 'killer'
  blocked_at    timestamptz NOT NULL DEFAULT NOW(),
  last_test_at  timestamptz,                   -- fine dell'ultimo test (no-sale)
  in_test       boolean     NOT NULL DEFAULT false,
  test_ends_at  timestamptz,
  cycles        int         NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_mbt_intest ON margin_block_tests (in_test, test_ends_at);

-- ----------------------------------------------------------------------------
-- reactivate_margin_blocks(p_dry) — governa R1/R2/R3 su lima+burner+killer.
--   p_dry = true  -> NON scrive, ritorna solo cosa FAREBBE.
--   ritorna (phase, src, n) per report.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reactivate_margin_blocks(p_dry boolean DEFAULT false)
RETURNS TABLE(phase text, src text, n bigint)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_rest interval := interval '20 days';   -- riposo tra un test e il successivo
  v_len  interval := interval '5 days';    -- durata finestra di test
BEGIN
  -- writer 'sessione_%' -> bypassa il veto incidenza sui rilasci legittimi
  PERFORM set_config('xhp.writer',  'sessione_riattiv_margine', true);
  PERFORM set_config('xhp.motivo',  'riattivazione margine (capo 24/7): R1 vende-rete / R2 restock magazzino / R3 test 5gg ogni 20gg', true);

  -- blocchi "margine bruciato" attivi, unificati dalle 3 tabelle native
  CREATE TEMP TABLE _ab ON COMMIT DROP AS
    SELECT tenant_id, sku, 'lima'::text src FROM feed_actions
      WHERE action='REMOVE' AND action_source='pulizia_lima_costante'
    UNION
    SELECT tenant_id, sku, 'burner' FROM feed_quarantine
      WHERE reactivated=false AND reason LIKE 'burner_incidenza%'
    UNION
    SELECT tenant_id, sku, 'killer' FROM feed_killers WHERE is_active;

  -- ---------- DRY-RUN: solo conteggi, nessuna scrittura ----------
  IF p_dry THEN
    RETURN QUERY
      SELECT 'register_new'::text, a.src, COUNT(*)::bigint
      FROM _ab a LEFT JOIN margin_block_tests m USING (tenant_id, sku)
      WHERE m.tenant_id IS NULL GROUP BY a.src;
    RETURN QUERY
      SELECT 'R1_vende_rete'::text, a.src, COUNT(*)::bigint
      FROM _ab a WHERE vende_in_rete_15g(a.sku) GROUP BY a.src;
    RETURN QUERY
      SELECT 'R2_restock_magazzino'::text, a.src, COUNT(*)::bigint
      FROM _ab a JOIN products p ON p.tenant_id=a.tenant_id AND p.sku=a.sku
      WHERE COALESCE(p.erp_stock,0)>0 AND NOT vende_in_rete_15g(a.sku)
      GROUP BY a.src;
    RETURN QUERY
      SELECT 'R3_test_apribili'::text, m.block_source, COUNT(*)::bigint
      FROM margin_block_tests m JOIN _ab a USING (tenant_id, sku)
      WHERE NOT m.in_test AND NOT vende_in_rete_15g(m.sku)
        AND NOW() - COALESCE(m.last_test_at, m.blocked_at) >= v_rest
      GROUP BY m.block_source;
    RETURN;
  END IF;

  -- ---------- 0. REGISTER nuovi blocchi nel ledger ----------
  INSERT INTO margin_block_tests (tenant_id, sku, block_source, blocked_at)
    SELECT _ab.tenant_id, _ab.sku, _ab.src, NOW() FROM _ab
    ON CONFLICT (tenant_id, sku) DO NOTHING;

  -- ---------- 1+2. R1 (vende in rete) + R2 (restock magazzino) ----------
  --   rilascio DEFINITIVO per merito: esce dal feed-block e dal ledger.
  CREATE TEMP TABLE _rel ON COMMIT DROP AS
    SELECT m.tenant_id, m.sku,
      CASE WHEN vende_in_rete_15g(m.sku) THEN 'R1_vende_rete' ELSE 'R2_restock' END motivo
    FROM margin_block_tests m
    LEFT JOIN products p ON p.tenant_id=m.tenant_id AND p.sku=m.sku
    WHERE vende_in_rete_15g(m.sku) OR COALESCE(p.erp_stock,0) > 0;

  DELETE FROM feed_actions fa USING _rel r
    WHERE fa.tenant_id=r.tenant_id AND fa.sku=r.sku
      AND fa.action='REMOVE' AND fa.action_source='pulizia_lima_costante';
  UPDATE feed_quarantine fq SET reactivated=true, reactivated_at=NOW()
    FROM _rel r WHERE fq.tenant_id=r.tenant_id AND fq.sku=r.sku
      AND fq.reactivated=false AND fq.reason LIKE 'burner_incidenza%';
  UPDATE feed_killers fk SET is_active=false
    FROM _rel r WHERE fk.tenant_id=r.tenant_id AND fk.sku=r.sku AND fk.is_active;
  DELETE FROM margin_block_tests m USING _rel r
    WHERE m.tenant_id=r.tenant_id AND m.sku=r.sku;

  RETURN QUERY SELECT 'released'::text, r.motivo, COUNT(*)::bigint FROM _rel r GROUP BY r.motivo;

  -- ---------- 3a. R3 CHIUSURA test scaduti ----------
  CREATE TEMP TABLE _closed ON COMMIT DROP AS
    SELECT m.tenant_id, m.sku,
      EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id=o.id
        WHERE oi.sku=m.sku AND o.order_date >= m.test_ends_at - v_len
          AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')) AS sold
    FROM margin_block_tests m
    WHERE m.in_test AND m.test_ends_at < NOW();
  -- venduto durante il test -> promosso: fuori dal ledger (resta nel feed)
  DELETE FROM margin_block_tests m USING _closed c
    WHERE m.tenant_id=c.tenant_id AND m.sku=c.sku AND c.sold;
  -- non venduto -> chiude test, resetta timer (i loop lo ri-bloccano al giro dopo)
  UPDATE margin_block_tests m SET in_test=false, last_test_at=NOW(), cycles=cycles+1
    FROM _closed c WHERE m.tenant_id=c.tenant_id AND m.sku=c.sku AND NOT c.sold;

  RETURN QUERY SELECT 'test_closed_sold'::text,   'promosso'::text, COUNT(*)::bigint FROM _closed WHERE sold;
  RETURN QUERY SELECT 'test_closed_nosale'::text, 'ri-blocco'::text, COUNT(*)::bigint FROM _closed WHERE NOT sold;

  -- ---------- 3b. R3 APERTURA nuovi test (riposo >= 20gg) ----------
  CREATE TEMP TABLE _open ON COMMIT DROP AS
    SELECT m.tenant_id, m.sku, m.block_source FROM margin_block_tests m
    WHERE NOT m.in_test
      AND NOW() - COALESCE(m.last_test_at, m.blocked_at) >= v_rest;
  UPDATE margin_block_tests m SET in_test=true, test_ends_at=NOW()+v_len
    FROM _open o WHERE m.tenant_id=o.tenant_id AND m.sku=o.sku;
  -- rilascio TEMPORANEO (5gg) nel feed; i loop non ri-bloccano (guardia in_test)
  DELETE FROM feed_actions fa USING _open o
    WHERE fa.tenant_id=o.tenant_id AND fa.sku=o.sku
      AND fa.action='REMOVE' AND fa.action_source='pulizia_lima_costante';
  UPDATE feed_quarantine fq SET reactivated=true, reactivated_at=NOW()
    FROM _open o WHERE fq.tenant_id=o.tenant_id AND fq.sku=o.sku
      AND fq.reactivated=false AND fq.reason LIKE 'burner_incidenza%';
  UPDATE feed_killers fk SET is_active=false
    FROM _open o WHERE fk.tenant_id=o.tenant_id AND fk.sku=o.sku AND fk.is_active;

  RETURN QUERY SELECT 'test_opened'::text, o.block_source, COUNT(*)::bigint FROM _open o GROUP BY o.block_source;

  RETURN;
END; $fn$;

-- registrazione in schema_migrations (idempotente)
INSERT INTO schema_migrations (filename) VALUES ('072_riattivazione_margine_100.sql')
  ON CONFLICT DO NOTHING;
