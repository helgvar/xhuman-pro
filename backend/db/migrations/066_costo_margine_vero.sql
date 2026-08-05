-- 066: COSTO E MARGINE VERO ALLA SORGENTE (ordine capo 16/7 — scolpito nella pietra)
-- "Il costo/sorgente di un prodotto cambia infinite volte al giorno: ora lo
--  vende il magazzino ERP farmacia, ora il grossista/supplier. Ogni ciclo di
--  ottimizzazione DEVE sapere, IN QUEL PRECISO ISTANTE, dov'è posizionato,
--  chi lo vende e qual è il margine REALE."
--
-- erp_cost = MIN_COST del grossista economico (NON il costo-acquisto farmacia).
-- erp_purchase_cost = costo-acquisto vero della farmacia.
-- La SORGENTE del momento la dice lo stock (aggiornato a ogni sync = il più
-- fresco disponibile): erp_stock>0 → la farmacia vende dal suo magazzino al
-- SUO costo; erp_stock=0 & supplier>0 → drop-ship dal grossista al MIN_COST.
-- Queste funzioni leggono products LIVE: nessun margine pre-calcolato stantio.

-- COSTO VERO: il costo della sorgente che sta vendendo ADESSO
CREATE OR REPLACE FUNCTION costo_vero(p_tenant uuid, p_sku text) RETURNS numeric AS $$
  SELECT CASE
    WHEN COALESCE(p.erp_stock,0) > 0
      THEN COALESCE(NULLIF(p.erp_purchase_cost,0), NULLIF(p.erp_cost,0), 0)   -- magazzino farmacia
    ELSE COALESCE(NULLIF(p.erp_cost,0), NULLIF(p.erp_purchase_cost,0), 0)     -- grossista MIN_COST
  END
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku
$$ LANGUAGE sql STABLE;

-- SORGENTE: chi lo vende adesso (per log/diagnosi)
CREATE OR REPLACE FUNCTION sorgente_vendita(p_tenant uuid, p_sku text) RETURNS text AS $$
  SELECT CASE
    WHEN COALESCE(p.erp_stock,0) > 0 THEN 'magazzino_farmacia'
    WHEN COALESCE(p.supplier_stock,0) > 0 THEN 'grossista'
    ELSE 'nessuna' END
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku
$$ LANGUAGE sql STABLE;

-- PREZZO VERO: il prezzo applicato che il cliente paga davvero (non il listino FB)
CREATE OR REPLACE FUNCTION prezzo_vero(p_tenant uuid, p_sku text) RETURNS numeric AS $$
  SELECT COALESCE(NULLIF(p.applied_price,0), NULLIF(p.exported_price,0), NULLIF(p.sell_price,0), 0)
  FROM products p WHERE p.tenant_id = p_tenant AND p.sku = p_sku
$$ LANGUAGE sql STABLE;

-- MARGINE UNITARIO VERO: prezzo vero - costo della sorgente attuale
CREATE OR REPLACE FUNCTION margine_unitario_vero(p_tenant uuid, p_sku text) RETURNS numeric AS $$
  SELECT prezzo_vero(p_tenant, p_sku) - costo_vero(p_tenant, p_sku)
$$ LANGUAGE sql STABLE;

INSERT INTO schema_migrations (filename)
SELECT '066_costo_margine_vero.sql'
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename='066_costo_margine_vero.sql');
