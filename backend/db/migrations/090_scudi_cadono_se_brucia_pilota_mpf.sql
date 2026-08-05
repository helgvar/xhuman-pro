-- 090 — PILOTA MPF: TUTTI gli scudi cadono per chi vende bruciando margine
--
-- Ordine capo 5/8 notte: "se il cap non lo ferma va corretto... ci saranno
-- altri prodotti nella stessa condizione". Il caso 981647821 (30 click/gg,
-- margine 15g €9 vs €40 di click) ha mostrato che la mig 089 aveva corretto
-- UNO scudo (L2 locale) ma la catena ne ha ALTRI TRE, tutti binari
-- "vende -> intoccabile", che non chiedono mai se il click si ripaga:
--
--   1. L4 vende_e_ripaga (mig 085): finestra 30gg a INCIDENZA (click < 30% del
--      fatturato). Contraddice due leggi del capo: finestre max 15gg (29/7) e
--      margine-first (un prodotto venduto sotto costo "ripaga" per incidenza).
--      Fermava 904104193 e 989332895.
--   2. L2-rete (mig 060/061): vende in rete + pos fresca <= 10 -> veto.
--      Fermava proprio 981647821 (pos 1, il prodotto del capo).
--   3. Carve-out STOCK e TOP10 dentro is_feed_protected: proteggono il
--      magazzino e le posizioni top MAI passate per dieta/vetrina.
--      Fermavano 934424476, 984599769, 984651240 (via trg_veto_basket_fn).
--
-- PRINCIPIO UNICO (questa migrazione): dove l2_richiede_ripago=1, chi
-- vende_ma_brucia_margine() perde OGNI scudo. Restano intoccabili SOLO le
-- classi che il capo ha dichiarato per nome: brand protetti, pin del capo,
-- carrelli sani (gia' esclusi DENTRO vende_ma_brucia_margine), piu' la
-- guardia freschezza dati (updated_at < 12h) che non e' uno scudo ma una
-- legge ("prima i dati freschi").
--
-- Il criterio resta margine-first 15gg: costo_click > 1,5 x margine, click >= 5,
-- costo VERO (magazzino fisico -> erp_purchase_cost, mai il listino).
-- Nessun flag nuovo: governa l2_richiede_ripago (mig 089), acceso solo MPF.
-- Rollback = DELETE FROM health_config WHERE config_key='l2_richiede_ripago';

BEGIN;

-- 1) is_feed_protected: i carve-out STOCK e TOP10 cedono a chi brucia.
--    (La clausola seller aveva gia' preso la condizione con la 089.)
CREATE OR REPLACE FUNCTION is_feed_protected(p_tenant uuid, p_sku text)
RETURNS boolean AS $$
  SELECT
      EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id = p_tenant AND cp.sku = p_sku AND cp.revoked_at IS NULL)
      OR is_basket_protected(p_tenant, p_sku)
      OR is_brand_protected(p_tenant, p_sku)
      -- MAGAZZINO: carve-out vetrina + dieta (verificati fatturato-zero).
      -- Mig 090: dove l'interruttore e' acceso, il magazzino che vende
      -- BRUCIANDO margine non e' piu' protetto da qui (caso 981647821).
      OR (is_stock_protected(p_tenant, p_sku)
          AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v WHERE v.tenant_id=p_tenant AND v.sku=p_sku)
          AND NOT EXISTS (SELECT 1 FROM dieta_provati dp WHERE dp.tenant_id=p_tenant AND dp.sku=p_sku)
          AND NOT (l2_ripago_attivo(p_tenant) AND vende_ma_brucia_margine(p_tenant, p_sku)))
      -- VENDITE SELLER (finestra 15gg, mig 080). Mig 089: dove l'interruttore
      -- e' acceso, chi vende bruciando margine non e' piu' protetto da qui.
      OR (EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE oi.tenant_id = p_tenant AND oi.sku = p_sku
                     AND o.order_date >= NOW() - INTERVAL '15 days'
                     AND o.order_status NOT IN ('canceled','closed'))
          AND NOT (l2_ripago_attivo(p_tenant) AND vende_ma_brucia_margine(p_tenant, p_sku)))
      -- TOP10: carve-out vetrina + dieta, e (mig 084, ordine capo 4/8) NON
      -- protegge piu' chi riceve click e non vende da nessuna parte nella rete.
      -- Mig 090: e nemmeno chi vende bruciando margine, dove acceso.
      OR EXISTS (SELECT 1 FROM product_health_scores h WHERE h.tenant_id = p_tenant AND h.sku = p_sku
                   AND h.scraper_position <= 10
                   AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v2 WHERE v2.tenant_id=p_tenant AND v2.sku=p_sku)
                   AND NOT EXISTS (SELECT 1 FROM dieta_provati dp2 WHERE dp2.tenant_id=p_tenant AND dp2.sku=p_sku)
                   AND NOT (
                     EXISTS (SELECT 1 FROM health_config hc
                              WHERE hc.tenant_id = p_tenant
                                AND hc.config_key = 'top10_no_shield_zero_sales'
                                AND hc.config_value = '1')
                     AND ha_click_15g(p_tenant, p_sku)
                     AND NOT vende_in_rete_15g(p_sku))
                   AND NOT (l2_ripago_attivo(p_tenant) AND vende_ma_brucia_margine(p_tenant, p_sku)))
      OR EXISTS (SELECT 1 FROM activation_cohorts ac WHERE ac.tenant_id = p_tenant AND ac.sku = p_sku
                   AND ac.activated_at >= NOW() - INTERVAL '72 hours');
$$ LANGUAGE sql STABLE;

-- 2) Guardia venditore: L4 (30gg incidenza) e L2-rete (pos<=10) cedono a chi
--    brucia. v_brucia calcolato UNA volta e riusato.
CREATE OR REPLACE FUNCTION trg_veto_condanna_vendente_fn() RETURNS TRIGGER AS $$
DECLARE
  v_pos INT;
  v_pos_max INT;
  v_brucia BOOLEAN := false;
  v_writer text := COALESCE(NULLIF(current_setting('xhp.writer', true), ''), 'anonimo');
BEGIN
  -- MANO DEL CAPO (mig 087): comanda su tutte le tabelle, non solo quarantena.
  IF v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%' THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'override_umano', TG_TABLE_NAME, NULL, 'condanna permessa',
            v_writer, 'mig 087: mano umana, guardia venditore scavalcata di proposito', NULL);
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'feed_quarantine'
     AND COALESCE((row_to_json(NEW)->>'manual_override')::boolean, false)
     AND (v_writer LIKE 'capo\_%' ESCAPE '\' OR v_writer LIKE 'manual%'
          OR v_writer LIKE 'sessione\_%' ESCAPE '\') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'feed_actions'
     AND COALESCE(row_to_json(NEW)->>'action','') <> 'REMOVE' THEN
    RETURN NEW;
  END IF;

  -- Mig 090: il giudizio margine-first e' UNO e governa tutti gli scudi.
  v_brucia := l2_ripago_attivo(NEW.tenant_id)
              AND vende_ma_brucia_margine(NEW.tenant_id, NEW.sku);

  -- L2 — vende su questo tenant. Lo scudo NON vale piu' per chi vende
  -- bruciando margine, dove il tenant ha l'interruttore acceso (mig 089).
  IF vende_su_tenant_15g(NEW.tenant_id, NEW.sku) THEN
    IF v_brucia THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'scudo_caduto', TG_TABLE_NAME, 'L2 vendente', 'condanna permessa',
              v_writer, 'mig 089: vende ma il click costa piu del margine (margine-first)', NULL);
    ELSE
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
              v_writer, 'L2: vende su QUESTO tenant 15g', NULL);
      RETURN NULL;
    END IF;
  END IF;

  -- L4 (mig 085): chi vende e ripaga il click non si tocca. Mig 090: la sua
  -- finestra 30gg a incidenza NON salva piu' chi brucia margine su 15gg
  -- (leggi capo: finestre max 15gg + margine-first).
  IF vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
    IF v_brucia THEN
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'scudo_caduto', TG_TABLE_NAME, 'L4 ripaga 30g', 'condanna permessa',
              v_writer, 'mig 090: incidenza 30g ok ma margine 15g bruciato (margine-first vince)', NULL);
    ELSE
      INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
      VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
              v_writer, 'L4 (mig 085): vende 30g e il click si ripaga', NULL);
      RETURN NULL;
    END IF;
  END IF;

  -- L2-rete (mig 060/061): vende in rete + posizione fresca buona. Mig 090:
  -- la posizione non salva chi brucia (era il caso 981647821, pos 1).
  IF vende_in_rete_15g(NEW.sku) THEN
    v_pos := pos_fresca(NEW.tenant_id, NEW.sku);
    SELECT COALESCE((SELECT hc.config_value::int FROM health_config hc
      WHERE hc.tenant_id = NEW.tenant_id AND hc.config_key = 'release_pos_max'), 10)
    INTO v_pos_max;
    IF v_pos IS NOT NULL AND v_pos <= v_pos_max THEN
      IF v_brucia THEN
        INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
        VALUES (NEW.tenant_id, NEW.sku, 'scudo_caduto', TG_TABLE_NAME, 'L2-rete pos ' || v_pos, 'condanna permessa',
                v_writer, 'mig 090: vende in rete a pos ' || v_pos || ' ma qui brucia margine (margine-first vince)', NULL);
      ELSE
        INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
        VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
                v_writer, 'L2: vende in rete E pos fresca ' || v_pos || ' <= ' || v_pos_max || ' su questo tenant', NULL);
        RETURN NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename) VALUES ('090_scudi_cadono_se_brucia_pilota_mpf.sql')
ON CONFLICT DO NOTHING;

COMMIT;

-- ROLLBACK pilota intero: DELETE FROM health_config WHERE config_key='l2_richiede_ripago';
-- (le funzioni restano ma senza flag il comportamento e' identico a prima)
