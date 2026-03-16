-- xHUMANPRO - Products & Price Rules Schema
-- Imported from Farmabooster API per tenant

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  product_name VARCHAR(500),
  category VARCHAR(500),
  reference_price NUMERIC(12,2) DEFAULT 0,
  erp_cost NUMERIC(12,2) DEFAULT 0,
  sell_price NUMERIC(12,2) DEFAULT 0,
  markup NUMERIC(8,4) DEFAULT 0,
  margin NUMERIC(12,2) DEFAULT 0,
  margin_pct NUMERIC(8,2) DEFAULT 0,
  sales_30d_seller NUMERIC(10,2) DEFAULT 0,
  sales_30d_aggregated NUMERIC(10,2) DEFAULT 0,
  erp_stock INTEGER DEFAULT 0,
  supplier_stock INTEGER DEFAULT 0,
  unmanage_stock BOOLEAN DEFAULT FALSE,
  saleable BOOLEAN DEFAULT TRUE,
  export_status VARCHAR(10),
  is_civetta BOOLEAN DEFAULT FALSE,
  is_topsearch BOOLEAN DEFAULT FALSE,
  is_topkey BOOLEAN DEFAULT FALSE,
  brand VARCHAR(200),
  manufacturer VARCHAR(200),
  ean VARCHAR(50),
  scraper_position INTEGER,
  raw_data JSONB,
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, sku)
);

CREATE TABLE price_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id VARCHAR(100),
  rule_name VARCHAR(300),
  rule_type VARCHAR(50),
  rule_data JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  priority INTEGER DEFAULT 0,
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, rule_id)
);

-- Indexes
CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_products_tenant_sku ON products(tenant_id, sku);
CREATE INDEX idx_products_tenant_category ON products(tenant_id, category);
CREATE INDEX idx_products_tenant_civetta ON products(tenant_id, is_civetta) WHERE is_civetta = TRUE;
CREATE INDEX idx_products_tenant_topsearch ON products(tenant_id, is_topsearch) WHERE is_topsearch = TRUE;
CREATE INDEX idx_products_tenant_stock ON products(tenant_id, erp_stock);
CREATE INDEX idx_price_rules_tenant ON price_rules(tenant_id);
