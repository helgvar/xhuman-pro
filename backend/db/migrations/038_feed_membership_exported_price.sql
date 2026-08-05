-- 038: Isteresi feed + prezzo civetta FB + prezzo applicato Magento (4/7/2026)

-- Prezzo civetta esportato da FB verso TP (misura vera post-PC, tutti i tenant)
ALTER TABLE products ADD COLUMN IF NOT EXISTS exported_price NUMERIC(12,2);

-- Prezzo reale letto da Magento (special_price) per SKU con azioni prezzo
ALTER TABLE products ADD COLUMN IF NOT EXISTS applied_price NUMERIC(12,2);

-- Membership del feed per isteresi: chi passa lo strict aggiorna last_pass;
-- chi fallisce resta in grazia feed_exit_grace_hours (default 72h)
CREATE TABLE IF NOT EXISTS feed_membership (
  tenant_id UUID NOT NULL,
  sku VARCHAR(100) NOT NULL,
  last_pass TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_feed_membership_pass ON feed_membership(tenant_id, last_pass);
