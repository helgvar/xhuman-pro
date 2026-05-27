-- Add IVA-inclusive columns to order_items and orders for correct MOL calculation
-- Reason: Magento item.row_total is VAT-excluded, but products.erp_cost (from Farmabooster
-- min_cost) is VAT-included. Without normalization MOL is systematically underestimated by
-- ~10-22% per item.

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS row_total_incl_tax NUMERIC(12,2);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS subtotal_incl_tax NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS shipping_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS shipping_incl_tax NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2);
