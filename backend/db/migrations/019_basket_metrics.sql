-- 019: Basket metrics per SKU
-- Cattura il ruolo di ogni SKU come traino di carrelli grandi (>= €90).
-- Usato dal ruleOptimizer per non penalizzare SKU che da soli sembrano in perdita
-- ma sostengono carrelli ad alto valore con altri prodotti a buon margine.

CREATE TABLE IF NOT EXISTS product_basket_metrics (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  -- Window di riferimento (es. ultimi 90gg)
  window_days INTEGER NOT NULL DEFAULT 90,
  -- Metriche basket (calcolate sugli ordini in cui lo SKU appare)
  n_orders INTEGER DEFAULT 0,                  -- numero ordini con questo SKU
  total_revenue NUMERIC(12,2) DEFAULT 0,       -- fatturato di questo SKU
  avg_cart_value NUMERIC(10,2),                -- valore medio carrello in cui appare
  median_cart_value NUMERIC(10,2),             -- mediana
  pct_in_large_carts NUMERIC(5,2),             -- % ordini con cart >= €90
  avg_margin_co_purchased NUMERIC(6,2),        -- margine medio degli ALTRI prodotti nei suoi carrelli
  avg_co_purchased_count NUMERIC(5,1),         -- # medio di altri SKU nello stesso carrello
  top_co_purchased_skus JSONB,                 -- top 5 SKU co-acquistati [{sku, n}]
  -- Classificazione automatica
  traino_score NUMERIC(5,2),                   -- 0-100, piu' alto = piu' "traino" di carrelli grandi
  traino_role VARCHAR(30),                     -- 'standalone' | 'carrello_grande' | 'cross_sell' | 'occasional'
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, sku, window_days)
);
CREATE INDEX IF NOT EXISTS idx_basket_tenant_sku ON product_basket_metrics(tenant_id, sku);
CREATE INDEX IF NOT EXISTS idx_basket_traino ON product_basket_metrics(tenant_id, traino_score DESC);
CREATE INDEX IF NOT EXISTS idx_basket_role ON product_basket_metrics(tenant_id, traino_role);

-- Default: 59.90 free-shipping threshold per tutti i tenant attivi (override per tenant via UI/SQL)
INSERT INTO health_config (tenant_id, config_key, config_value)
SELECT id, 'free_shipping_threshold_eur', '59.90'
FROM tenants WHERE status = 'active'
ON CONFLICT (tenant_id, config_key) DO NOTHING;

-- Soglia universale "carrello interessante" (fissa €90, ma override-abile per tenant)
INSERT INTO health_config (tenant_id, config_key, config_value)
SELECT id, 'large_cart_threshold_eur', '90.00'
FROM tenants WHERE status = 'active'
ON CONFLICT (tenant_id, config_key) DO NOTHING;
