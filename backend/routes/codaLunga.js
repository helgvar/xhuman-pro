/**
 * 🔁 LOOP CODA LUNGA — vista dashboard (ordine capo 12/8/2026)
 * Espone il registro coda_lunga_log (mig 097): ogni taglio, retest,
 * promozione, rientro a evento e paracadute del loop, più lo stato
 * corrente (esiliati / in test / promossi / gruppo di controllo).
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');

router.use(authMiddleware, tenantMiddleware);

const LOOP_REASON = 'loop_coda_lunga_zero_conv';
const STATUS_WHITELIST = ['processing', 'pending', 'complete', 'ritiro_farmacia', 'Ritirato', 'ritiro_sede_tmp'];

// GET /api/coda-lunga/summary?hours=168 — interruttori, stato loop, controllo, contatori eventi
router.get('/summary', async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 168, 24 * 60);
  const tid = req.tenantId || null;
  try {
    const [interruttori, stato, controllo, eventi] = await Promise.all([
      pool.query(`
        SELECT t.name AS tenant_name, hc.tenant_id, hc.config_value, hc.expires_at,
          (SELECT h2.config_value FROM health_config h2
            WHERE h2.tenant_id = hc.tenant_id AND h2.config_key = 'coda_lunga_v2_since') AS since,
          EXISTS (SELECT 1 FROM health_config h3
            WHERE h3.tenant_id = hc.tenant_id AND h3.config_key = 'coda_lunga_holdout'
              AND h3.config_value = '1'
              AND (h3.expires_at IS NULL OR h3.expires_at > NOW())) AS holdout
        FROM health_config hc
        JOIN tenants t ON t.id = hc.tenant_id
        WHERE hc.config_key = 'coda_lunga_on'
          AND ($1::uuid IS NULL OR hc.tenant_id = $1)
        ORDER BY t.name`, [tid]),
      pool.query(`
        SELECT t.name AS tenant_name, fq.tenant_id,
          COUNT(*) FILTER (WHERE fq.reason = $2 AND fq.reactivated = false AND fq.observation_start IS NULL)::int AS in_esilio,
          COUNT(*) FILTER (WHERE fq.reason = $2 AND fq.observation_start IS NOT NULL)::int AS in_test,
          COUNT(*) FILTER (WHERE fq.reason = 'loop_coda_lunga_promosso')::int AS promossi
        FROM feed_quarantine fq
        JOIN tenants t ON t.id = fq.tenant_id
        WHERE fq.reason IN ($2, 'loop_coda_lunga_promosso')
          AND ($1::uuid IS NULL OR fq.tenant_id = $1)
        GROUP BY t.name, fq.tenant_id ORDER BY t.name`, [tid, LOOP_REASON]),
      pool.query(`
        SELECT t.name AS tenant_name, x.tenant_id,
          COUNT(*)::int AS n,
          COUNT(*) FILTER (WHERE x.venduto)::int AS venduti,
          ROUND(COALESCE(SUM(x.rev), 0))::int AS rev,
          COUNT(*) FILTER (WHERE x.quarantenato)::int AS contaminati
        FROM (
          SELECT c.tenant_id, c.sku,
            EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
              WHERE oi.sku = c.sku AND o.order_status = ANY($2)
                AND o.order_date >= c.listed_at) AS venduto,
            (SELECT COALESCE(SUM(oi.row_total_incl_tax), 0)
              FROM orders o JOIN order_items oi ON oi.order_id = o.id
              WHERE oi.sku = c.sku AND o.order_status = ANY($2)
                AND o.order_date >= c.listed_at) AS rev,
            EXISTS (SELECT 1 FROM feed_quarantine fq
              WHERE fq.tenant_id = c.tenant_id AND fq.sku = c.sku AND fq.reactivated = false) AS quarantenato
          FROM coda_lunga_controllo c
          WHERE ($1::uuid IS NULL OR c.tenant_id = $1)
        ) x
        JOIN tenants t ON t.id = x.tenant_id
        GROUP BY t.name, x.tenant_id ORDER BY t.name`, [tid, STATUS_WHITELIST]),
      pool.query(`
        SELECT evento, COUNT(*)::int AS n, MAX(created_at) AS ultimo
        FROM coda_lunga_log
        WHERE created_at >= NOW() - ($1 || ' hours')::interval
          AND ($2::uuid IS NULL OR tenant_id = $2)
        GROUP BY evento ORDER BY n DESC`, [hours, tid]),
    ]);
    res.json({
      hours,
      tenant: req.tenant ? req.tenant.name : null,
      interruttori: interruttori.rows,
      stato: stato.rows,
      controllo: controllo.rows,
      eventi: eventi.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/coda-lunga/log?evento=&hours=168&limit=300&sku= — il registro operazioni
router.get('/log', async (req, res) => {
  const { evento, sku } = req.query;
  const tenant_id = req.tenantId || req.query.tenant_id;
  const hours = Math.min(parseInt(req.query.hours) || 168, 24 * 60);
  const limit = Math.min(parseInt(req.query.limit) || 300, 1000);
  const cond = [`l.created_at >= NOW() - ($1 || ' hours')::interval`];
  const params = [hours];
  if (tenant_id && tenant_id !== 'tutti') { params.push(tenant_id); cond.push(`l.tenant_id = $${params.length}`); }
  if (evento && evento !== 'tutti') { params.push(evento); cond.push(`l.evento = $${params.length}`); }
  if (sku) { params.push(`%${sku}%`); cond.push(`l.sku ILIKE $${params.length}`); }
  params.push(limit);
  try {
    const { rows } = await pool.query(`
      SELECT l.*, t.name AS tenant_name, p.product_name
      FROM coda_lunga_log l
      LEFT JOIN tenants t ON t.id = l.tenant_id
      LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.sku = l.sku
      WHERE ${cond.join(' AND ')}
      ORDER BY l.created_at DESC LIMIT $${params.length}`, params);
    res.json({ items: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
