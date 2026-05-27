-- Imputed erp_cost for products missing real cost.
--
-- 29% del catalogo civetta non ha erp_cost real → il MOL aggregato è
-- sistematicamente gonfiato (cogs=0 su quelle righe). Aggiungiamo una
-- colonna shadow `erp_cost_imputed` che viene popolata dalla media del
-- brand (stesso tenant). NON sovrascriviamo erp_cost reale: il pricing
-- engine continua a vedere NULL se non sappiamo davvero il costo
-- (= non rischia di prezzare male). Solo gli aggregati MOL/incidenza
-- useranno COALESCE(erp_cost, erp_cost_imputed).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS erp_cost_imputed         NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS erp_cost_imputed_source  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS erp_cost_imputed_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_products_cost_coalesce
  ON products (tenant_id) WHERE erp_cost IS NULL OR erp_cost = 0;
