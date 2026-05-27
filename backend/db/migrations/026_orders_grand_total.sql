-- Add Magento grand_total (full order incl. shipping + tax) to orders
-- Reason: magentoOrders.js INSERTs grand_total, productHealth.js SELECTs SUM(grand_total).
-- Without this column OrderSync crashes on every order import.
-- Idempotent: safe on environments where this column was added manually.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS grand_total NUMERIC(12,2);
