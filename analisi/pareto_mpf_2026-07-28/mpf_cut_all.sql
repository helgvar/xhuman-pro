\pset pager off
\set mpf '''d581c087-6b92-4050-b52a-5bd5c087553a'''
BEGIN;
SELECT set_config('xhp.writer','sessione_capo_28lug',true);
SELECT set_config('xhp.motivo','taglio_no_vendita_mpf_ignora_rete_ordine_capo_28lug',true);

CREATE TEMP TABLE tocut ON COMMIT DROP AS
WITH clk30 AS (
  SELECT product_code sku, SUM(clicks) clk FROM zombie_clicks
  WHERE tenant_id=:mpf AND fetch_date>='2026-06-28' GROUP BY 1),
mpf30 AS (
  SELECT oi.sku FROM orders o JOIN order_items oi ON oi.order_id=o.id
  WHERE o.tenant_id=:mpf AND o.order_status IN ('processing','pending','complete','ritiro_farmacia','Ritirato')
    AND o.order_date>=NOW()-INTERVAL '30 days' GROUP BY 1)
SELECT c.sku, c.clk, ROUND(c.clk*0.3294,2) costo
FROM clk30 c JOIN products p ON p.tenant_id=:mpf AND p.sku=c.sku
WHERE c.sku NOT IN (SELECT sku FROM mpf30)
  AND NOT is_brand_protected(:mpf,c.sku)
  AND NOT is_sconto_rule_product(:mpf,c.sku)
  AND NOT is_muro_rule_product(:mpf,c.sku)
  AND NOT EXISTS(SELECT 1 FROM capo_pins cp WHERE cp.tenant_id=:mpf AND cp.sku=c.sku AND cp.revoked_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM feed_quarantine q WHERE q.tenant_id=:mpf AND q.sku=c.sku AND q.reactivated=false);

\echo '===== candidati taglio ====='
SELECT COUNT(*) sku, SUM(clk) clk, ROUND(SUM(costo)) costo_30gg FROM tocut;

INSERT INTO feed_quarantine
  (tenant_id, sku, reason, quarantine_start, quarantine_end, quarantine_level,
   reactivated, is_permanent, is_burner_rule, manual_override, observation_clicks, observation_orders, created_at)
SELECT :mpf, sku, 'Taglio capo 28/7 no-vendita-MPF (ignora rete, ordine capo)',
   NOW(), NOW()+INTERVAL '14 days', 1, false, false, false, false, 0, 0, NOW()
FROM tocut
ON CONFLICT (tenant_id, sku) DO UPDATE SET
  reason=EXCLUDED.reason, quarantine_start=EXCLUDED.quarantine_start,
  quarantine_end=EXCLUDED.quarantine_end, reactivated=false;
COMMIT;
