-- 089 — L2 non assolve più chi vende in perdita (PILOTA: solo MPF)
--
-- ORDINE CAPO 4/8 sera: "inverti l'ordine, tutto quello che fai ora fino a mio
-- nuovo ordine lo fai solo su MPF".
--
-- COSA NON ANDAVA
-- In trg_veto_condanna_vendente_fn i controlli girano in quest'ordine:
--   1. mano del capo            -> passa
--   2. L2  vende_su_tenant_15g  -> VETO INCONDIZIONATO
--   3. L4  vende_e_ripaga       -> mai raggiunta per chi vende
-- L'ordine del capo del 4/8 ("chi vende e ripaga il click non si tocca") era
-- entrato come SCUDO IN PIU', non come CRITERIO: chi vende e NON ripaga non
-- veniva mai giudicato. Un solo ordine comprava 15 giorni di immunità totale.
-- Caso di scuola, MENOPAUSA ACT 30CPR (981647821): 1 ordine da €30 il 26/7,
-- 121 click e €39,86 di TP bruciati nei 15gg successivi, 99 condanne respinte
-- dalla guardia e 142 dal cap. Stessa falla nella clausola seller-15gg di
-- is_feed_protected (mig 080), anch'essa binaria.
--
-- COSA CAMBIA
-- Lo scudo "ha venduto" resta pieno per default. Solo dove il tenant ha il flag
-- l2_richiede_ripago=1 lo scudo cade per chi vende BRUCIANDO margine, secondo
-- il criterio della Bibbia margine-first (costo click > 1,5 x margine).
--
-- MISURA MPF 4/8, 15gg, CSV che esce a TP:
--   363 SKU venditori cliccati: costo €1.317 / margine €1.985 -> ripagano, intoccati
--    16 bruciatori veri (click>=5): costo €251,66 / margine -€28,48
--       = €280,14/15gg = €18,68/gg recuperati, €433 di fatturato esposto
--   ESCLUSI di proposito i 53 SKU sotto costo con 1-4 click (€1.596 di
--   fatturato, margine -€180): lì il difetto è il PREZZO, non il feed.
--   Toglierli risparmierebbe €2,26/gg mettendo a rischio €1.596: vietato da
--   revenue-first. Vanno riprezzati, non rimossi.
--
-- Restano intatte tutte le altre protezioni: brand protetti, pin del capo,
-- carrelli sani, e la soglia click>=5 (sotto, il click non è il problema).

BEGIN;

-- 1) Interruttore per-tenant. Assente = comportamento pre-089 (fail-safe).
CREATE OR REPLACE FUNCTION l2_ripago_attivo(p_tenant uuid) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM health_config hc
                  WHERE hc.tenant_id = p_tenant
                    AND hc.config_key = 'l2_richiede_ripago'
                    AND hc.config_value = '1');
$$ LANGUAGE sql STABLE;

-- 2) Criterio margine-first: vende, ma il click gli costa più del margine che
--    produce. Costo VERO: se c'è magazzino fisico si usa il prezzo d'acquisto,
--    altrimenti il min-cost grossista (mai il listino).
CREATE OR REPLACE FUNCTION vende_ma_brucia_margine(p_tenant uuid, p_sku text)
RETURNS boolean AS $$
  WITH cfg AS (
    SELECT COALESCE((SELECT hc.config_value::numeric FROM health_config hc
                      WHERE hc.tenant_id = p_tenant AND hc.config_key = 'l2_ripago_k'), 1.5) AS k,
           COALESCE((SELECT hc.config_value::int FROM health_config hc
                      WHERE hc.tenant_id = p_tenant AND hc.config_key = 'l2_ripago_click_min'), 5) AS click_min
  ),
  cl AS (
    SELECT COALESCE(SUM(z.clicks), 0) AS n
    FROM zombie_clicks z
    WHERE z.tenant_id = p_tenant AND z.product_code = p_sku
      AND z.fetch_date >= (NOW() AT TIME ZONE 'Europe/Rome')::date - 15
  ),
  m AS (
    SELECT COALESCE(SUM(oi.row_total_incl_tax), 0) AS rev,
           COALESCE(SUM(oi.qty_ordered * (oi.price - CASE WHEN p.erp_stock > 0
             THEN LEAST(COALESCE(p.erp_purchase_cost, p.erp_cost), p.erp_cost)
             ELSE p.erp_cost END)), 0) AS marg
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.tenant_id = oi.tenant_id AND p.sku = oi.sku
    WHERE oi.tenant_id = p_tenant AND oi.sku = p_sku
      AND o.order_date >= NOW() - INTERVAL '15 days'
      AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
  )
  SELECT cl.n >= cfg.click_min
     AND m.rev > 0
     AND cl.n * 0.3294 > cfg.k * m.marg
     -- Le classi protette del capo non perdono MAI lo scudo per questa via.
     AND NOT porta_carrelli_sani(p_tenant, p_sku)
     AND NOT is_brand_protected(p_tenant, p_sku)
     AND NOT EXISTS (SELECT 1 FROM capo_pins cp
                      WHERE cp.tenant_id = p_tenant AND cp.sku = p_sku AND cp.revoked_at IS NULL)
  FROM cfg, cl, m;
$$ LANGUAGE sql STABLE COST 500;

-- 3) Lo scudo L2 diventa condizionato. Tutto il resto della funzione invariato.
CREATE OR REPLACE FUNCTION trg_veto_condanna_vendente_fn() RETURNS TRIGGER AS $$
DECLARE
  v_pos INT;
  v_pos_max INT;
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

  -- L2 — vende su questo tenant. Lo scudo NON vale più per chi vende bruciando
  -- margine, dove il tenant ha l'interruttore acceso (mig 089, ordine capo 4/8).
  IF vende_su_tenant_15g(NEW.tenant_id, NEW.sku) THEN
    IF l2_ripago_attivo(NEW.tenant_id)
       AND vende_ma_brucia_margine(NEW.tenant_id, NEW.sku) THEN
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

  -- L4 (mig 085): chi vende e ripaga il click non si tocca, punto.
  IF vende_e_ripaga(NEW.tenant_id, NEW.sku) THEN
    INSERT INTO azioni_touch_log(tenant_id, sku, operazione, campo, old_value, new_value, writer, motivo, action_source)
    VALUES (NEW.tenant_id, NEW.sku, 'veto_arbitro', TG_TABLE_NAME, NULL, 'condanna bloccata',
            v_writer, 'L4 (mig 085): vende 30g e il click si ripaga', NULL);
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
              v_writer, 'L2: vende in rete E pos fresca ' || v_pos || ' <= ' || v_pos_max || ' su questo tenant', NULL);
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 4) Stessa condizione nella clausola seller-15gg di is_feed_protected (mig 080):
--    altrimenti lo scudo cade nel trigger ma i motori non candidano nemmeno lo
--    SKU, e l'effetto dipenderebbe da quale motore arriva primo.
CREATE OR REPLACE FUNCTION is_feed_protected(p_tenant uuid, p_sku text)
RETURNS boolean AS $$
  SELECT
      EXISTS (SELECT 1 FROM capo_pins cp WHERE cp.tenant_id = p_tenant AND cp.sku = p_sku AND cp.revoked_at IS NULL)
      OR is_basket_protected(p_tenant, p_sku)
      OR is_brand_protected(p_tenant, p_sku)
      -- MAGAZZINO: carve-out vetrina + dieta (verificati fatturato-zero)
      OR (is_stock_protected(p_tenant, p_sku)
          AND NOT EXISTS (SELECT 1 FROM vetrina_piena_provati v WHERE v.tenant_id=p_tenant AND v.sku=p_sku)
          AND NOT EXISTS (SELECT 1 FROM dieta_provati dp WHERE dp.tenant_id=p_tenant AND dp.sku=p_sku))
      -- VENDITE SELLER (finestra 15gg, mig 080). Mig 089: dove l'interruttore
      -- e' acceso, chi vende bruciando margine non e' piu' protetto da qui.
      OR (EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE oi.tenant_id = p_tenant AND oi.sku = p_sku
                     AND o.order_date >= NOW() - INTERVAL '15 days'
                     AND o.order_status NOT IN ('canceled','closed'))
          AND NOT (l2_ripago_attivo(p_tenant) AND vende_ma_brucia_margine(p_tenant, p_sku)))
      -- TOP10: carve-out vetrina + dieta, e (mig 084, ordine capo 4/8) NON
      -- protegge piu' chi riceve click e non vende da nessuna parte nella rete
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
                     AND NOT vende_in_rete_15g(p_sku)))
      OR EXISTS (SELECT 1 FROM activation_cohorts ac WHERE ac.tenant_id = p_tenant AND ac.sku = p_sku
                   AND ac.activated_at >= NOW() - INTERVAL '72 hours');
$$ LANGUAGE sql STABLE;

-- 5) PILOTA: interruttore acceso SOLO su MPF.
INSERT INTO health_config (tenant_id, config_key, config_value)
VALUES ('d581c087-6b92-4050-b52a-5bd5c087553a', 'l2_richiede_ripago', '1')
ON CONFLICT (tenant_id, config_key) DO UPDATE SET config_value = '1';

INSERT INTO schema_migrations (filename) VALUES ('089_l2_richiede_ripago_pilota_mpf.sql')
ON CONFLICT DO NOTHING;

COMMIT;

-- ROLLBACK:
--   DELETE FROM health_config WHERE config_key = 'l2_richiede_ripago';
-- (spegne il pilota senza toccare il codice: entrambe le funzioni tornano al
--  comportamento pre-089 per tutti i tenant)
