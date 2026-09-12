-- =============================================================================
-- 110 — GUARDIA G6: IL LOOP CHE STA ADDOSSO AI CAMBI DI COSTO
--
-- Ordine capo 10/09 #4: "io farei un loop supplementare sul controllo dei costi
-- che monitora i cambi costo".
--
-- Perche' serve anche se il guardiano gira gia' a ogni sync:
--   a) il registro dei costi (product_cost_history) si riempie anche FUORI dal
--      product sync — la spazzata notturna di costHistoryCron gira 01-06 e
--      cambia i costi mentre nessun sync prodotti sta girando;
--   b) il guardiano dice COSA fare adesso, non COSA E' CAMBIATO: senza questo
--      loop il cambio di costo resta invisibile finche' non ha gia' fatto danno;
--   c) un salto di costo grosso e' una notizia per il capo, non solo un lavoro
--      per la macchina.
--
-- Misurato 10/09 21:20: 27.142 gradini di costo VERI in 6h di rete, di cui 133
-- su SKU con un price cut vivo (Farmastelia 42, MPF 41, SubitoFarma 25, Papa 11,
-- Farmainsieme 7, Mandanici 4, Procaccini 2). Numeri piccoli: il loop e' leggero
-- e mirato, non una seconda passata cieca su tutto.
--
-- Le fonti guardate sono le tre che formano il costo del guardiano:
--   erp_acquisto  -> erp_purchase_cost (quanto la farmacia ha pagato)
--   grossista_min -> supplier_min_cost (quanto costa ricomprarlo)
--   min_blended   -> erp_cost          (minimo miscelato)
-- =============================================================================

CREATE TABLE IF NOT EXISTS cambio_costo_allarme (
  id            bigserial PRIMARY KEY,
  rilevato_il   timestamptz NOT NULL DEFAULT NOW(),
  giorno        date        NOT NULL DEFAULT CURRENT_DATE,
  tenant_id     uuid        NOT NULL,
  tenant        text,
  sku           varchar(64) NOT NULL,
  source        varchar(64),
  costo_prima   numeric,
  costo_dopo    numeric,
  delta_pct     numeric,
  prezzo_vivo   numeric,
  margine_pct   numeric,
  floor_pct     numeric,
  sotto_floor   boolean     NOT NULL DEFAULT false,
  azione        text
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cambio_costo_allarme
  ON cambio_costo_allarme (tenant_id, sku, source, costo_dopo, giorno);
CREATE INDEX IF NOT EXISTS ix_cambio_costo_allarme_giorno
  ON cambio_costo_allarme (giorno DESC, sotto_floor);

COMMENT ON TABLE cambio_costo_allarme IS
  'Guardia G6 (ordine capo 10/09): ogni cambio di costo che tocca un price cut vivo, con il verdetto sul floor. Una riga per SKU/fonte/costo/giorno.';

-- ---------------------------------------------------------------------------
-- Cosa e' cambiato nelle ultime p_ore, solo su SKU con un taglio vivo
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cambi_costo_su_pc(p_ore numeric DEFAULT 6)
RETURNS TABLE(tenant_id uuid, tenant text, sku varchar, source varchar,
              costo_prima numeric, costo_dopo numeric, delta_pct numeric,
              prezzo_vivo numeric, margine_pct numeric, floor_pct numeric,
              sotto_floor boolean)
LANGUAGE sql STABLE AS $$
  WITH r AS (
    SELECT h.tenant_id, h.sku, h.source, h.costo, h.data, h.updated_at,
           LAG(h.costo) OVER (PARTITION BY h.tenant_id, h.sku, h.source ORDER BY h.data) AS costo_prima
      FROM product_cost_history h
     WHERE h.source IN ('erp_acquisto','grossista_min','min_blended')
       AND h.data >= CURRENT_DATE - 30
  ), c AS (
    SELECT r.tenant_id, r.sku, r.source, r.costo AS costo_dopo, r.costo_prima
      FROM r
     WHERE r.updated_at > NOW() - (p_ore || ' hours')::interval
       AND r.costo_prima IS NOT NULL
       AND ABS(r.costo - r.costo_prima) > 0.005
  )
  SELECT c.tenant_id, t.name::text, c.sku, c.source,
         c.costo_prima, c.costo_dopo,
         ROUND((c.costo_dopo - c.costo_prima) / NULLIF(c.costo_prima,0) * 100, 1) AS delta_pct,
         COALESCE(p.applied_price, p.exported_price, p.sell_price) AS prezzo_vivo,
         ROUND((COALESCE(p.applied_price,p.exported_price,p.sell_price) - costo_guardia(c.tenant_id, c.sku))
               / NULLIF(COALESCE(p.applied_price,p.exported_price,p.sell_price),0) * 100, 2) AS margine_pct,
         pc_floor_pct_tenant(c.tenant_id, COALESCE(p.applied_price,p.exported_price,p.sell_price)) AS floor_pct,
         (   costo_guardia(c.tenant_id, c.sku) > 0
         AND COALESCE(p.applied_price,p.exported_price,p.sell_price) > 0
         AND (COALESCE(p.applied_price,p.exported_price,p.sell_price) - costo_guardia(c.tenant_id, c.sku))
             / COALESCE(p.applied_price,p.exported_price,p.sell_price) * 100
             < pc_floor_pct_tenant(c.tenant_id, COALESCE(p.applied_price,p.exported_price,p.sell_price))
         ) AS sotto_floor
    FROM c
    JOIN tenants t  ON t.id = c.tenant_id
    JOIN products p ON p.tenant_id = c.tenant_id AND p.sku = c.sku
   WHERE EXISTS (SELECT 1 FROM feed_actions fa
                  WHERE fa.tenant_id = c.tenant_id AND fa.sku = c.sku
                    AND fa.action = 'PRICE_CUT'
                    AND fa.status IN ('pending','dispatched','active'));
$$;

COMMENT ON FUNCTION cambi_costo_su_pc(numeric) IS
  'Guardia G6: gradini di costo VERI (non ristampe) delle ultime p_ore su SKU con price cut vivo, con margine e floor di adesso.';

INSERT INTO schema_migrations (filename)
SELECT '110_guardia_cambi_costo.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '110_guardia_cambi_costo.sql');
