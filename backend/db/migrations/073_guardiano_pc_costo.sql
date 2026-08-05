-- 073_guardiano_pc_costo.sql
-- ============================================================================
-- DICTAT capo 24/7 — "quando fai un PC su un prodotto da farmacia, va monitorato
-- lo switch verso il grossista: se finisce in farmacia e va comprato da grossista
-- il costo aumenta e non ci stai più con il margine. Ogni PC va CONFERMATO a
-- ogni loop." Ambito scelto: SOLO aumento-costo (protezione pura, zero rischio
-- fatturato) — non tocca i PC sotto-floor per scelta di altri motori.
--
-- Floor margine (= (prezzo-costo)/prezzo, sul costo del momento):
--   0-5€→25% · 5-10€→19% · 10-30€→16% · 30-50€→13% · >50€→11%
-- SubitoFarma escluso dal floor (eccezione cliente documentata); il sotto-costo
-- resta comunque coperto da trg_veto_sotto_costo.
-- ============================================================================

-- Baseline del costo al momento della nascita del PC: serve a distinguere
-- "sotto floor perché il COSTO è SALITO" (agire) da "sotto floor per scelta di
-- un altro motore" (non toccare).
CREATE TABLE IF NOT EXISTS pc_cost_baseline (
  tenant_id    uuid        NOT NULL,
  sku          varchar     NOT NULL,
  baseline_cost numeric    NOT NULL,
  baseline_at  timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku)
);

-- floor% per fascia di prezzo (helper immutabile)
CREATE OR REPLACE FUNCTION pc_floor_pct(p_price numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_price < 5 THEN 25 WHEN p_price < 10 THEN 19
              WHEN p_price < 30 THEN 16 WHEN p_price < 50 THEN 13 ELSE 11 END::numeric;
$$;

-- ----------------------------------------------------------------------------
-- reconfirm_price_cuts(p_dry) — ri-conferma OGNI PC attivo sul costo del momento.
-- Agisce SOLO se il costo è salito oltre la baseline E il margine sfonda il floor.
--   revise   -> rialza il PC al prezzo floor-safe se resta competitivo (<= best ext)
--   withdraw -> se floor-safe supererebbe il mercato, ritira il PC (torna a regola FB)
-- Ritorna (azione, tenant, n) per report. p_dry=true non scrive.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reconfirm_price_cuts(p_dry boolean DEFAULT false)
RETURNS TABLE(azione text, tenant text, n bigint)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_op text[] := ARRAY['Papa','Farmacia Procaccini','MPF','Farmainsieme','Farmastelia','Farmacia Mandanici'];
  -- SubitoFarma volutamente FUORI (eccezione floor cliente); il sotto-costo lo
  -- protegge comunque il trigger dedicato.
  v_ai_sources text[] := ARRAY['competitive_price_cut','zero_click_demand','potenziale_price_cut',
    'convertitore_costoso','margin_harvest_pilot','pulizia_seller_guard','manual_pepita','pareto_positioning'];
BEGIN
  PERFORM set_config('xhp.writer', 'sessione_pc_guardian', true);
  PERFORM set_config('xhp.motivo', 'guardiano PC (capo 24/7): ri-conferma a ogni loop, costo salito sfonda il floor -> rialza floor-safe o ritira', true);

  -- snapshot valutazione (una volta)
  CREATE TEMP TABLE _pc ON COMMIT DROP AS
    SELECT fa.id, fa.tenant_id, t.name::text tname, fa.sku, fa.action_source, fa.recommended_price rp,
      costo_vero(fa.tenant_id, fa.sku) costo_now,
      b.baseline_cost base,
      (SELECT MIN(sc.base_price) FROM scraper_competitors sc
        WHERE sc.product_code=fa.sku
          AND sc.scraped_at >= (NOW() AT TIME ZONE 'Europe/Rome') - INTERVAL '24 hours'
          AND sc.base_price>0
          AND sc.merchant !~* 'personal farma|subitofarma|san vito|procaccini|farmacri|mandanici|farmainsieme|ospedale|farmacia papa|farmastelia'
      ) best_ext
    FROM feed_actions fa
    JOIN tenants t ON t.id=fa.tenant_id AND t.name = ANY(v_op)
    LEFT JOIN pc_cost_baseline b ON b.tenant_id=fa.tenant_id AND b.sku=fa.sku
    WHERE fa.action='PRICE_CUT' AND fa.status IN ('pending','dispatched','active')
      AND fa.recommended_price > 0 AND fa.action_source = ANY(v_ai_sources);

  -- registra baseline mancanti (PC preesistenti): baseline = costo di ORA, così
  -- solo gli aumenti FUTURI faranno scattare il guardiano.
  IF NOT p_dry THEN
    INSERT INTO pc_cost_baseline (tenant_id, sku, baseline_cost)
      SELECT DISTINCT tenant_id, sku, costo_now FROM _pc
      WHERE base IS NULL AND costo_now > 0
      ON CONFLICT (tenant_id, sku) DO NOTHING;
  END IF;

  -- classifica i "rotti da aumento-costo"
  CREATE TEMP TABLE _broken ON COMMIT DROP AS
    SELECT *,
      ROUND(costo_now / (1 - pc_floor_pct(rp)/100.0), 2) floor_safe
    FROM _pc
    WHERE base IS NOT NULL AND costo_now > base
      AND (rp - costo_now)/NULLIF(rp,0)*100 < pc_floor_pct(rp);

  IF p_dry THEN
    RETURN QUERY
      SELECT (CASE WHEN _broken.best_ext IS NULL OR _broken.floor_safe <= _broken.best_ext - 0.01 THEN 'revise_floor_safe' ELSE 'withdraw' END)::text,
             _broken.tname, COUNT(*)::bigint
      FROM _broken GROUP BY 1, _broken.tname;
    RETURN;
  END IF;

  -- conteggi PRIMA di applicare (classificazione deterministica da _broken)
  RETURN QUERY SELECT 'revised'::text, b.tname, COUNT(*)::bigint
    FROM _broken b
    WHERE (b.best_ext IS NULL OR b.floor_safe <= b.best_ext - 0.01) AND b.floor_safe > 0
    GROUP BY b.tname;
  RETURN QUERY SELECT 'withdrawn'::text, b.tname, COUNT(*)::bigint
    FROM _broken b
    WHERE b.best_ext IS NOT NULL AND b.floor_safe > b.best_ext - 0.01
    GROUP BY b.tname;

  -- REVISE: rialza al floor-safe (resta competitivo, o nessun riferimento -> margine prima)
  UPDATE feed_actions fa SET
    recommended_price = b.floor_safe,
    action_reason = 'guardiano PC (costo salito): rialzo floor-safe ' || b.floor_safe || ' (costo ' || ROUND(b.costo_now,2) || ')',
    computed_at = NOW()
  FROM _broken b
  WHERE fa.id = b.id AND (b.best_ext IS NULL OR b.floor_safe <= b.best_ext - 0.01)
    AND b.floor_safe > 0 AND b.floor_safe <> fa.recommended_price;

  -- WITHDRAW: floor-safe supererebbe il mercato -> ritira il PC (torna a regola FB)
  DELETE FROM feed_actions fa USING _broken b
  WHERE fa.id = b.id AND b.best_ext IS NOT NULL AND b.floor_safe > b.best_ext - 0.01;

  RETURN;
END; $fn$;

INSERT INTO schema_migrations (filename) VALUES ('073_guardiano_pc_costo.sql')
  ON CONFLICT DO NOTHING;
