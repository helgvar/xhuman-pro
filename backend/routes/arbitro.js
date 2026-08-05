/**
 * ⚖️ ARBITRO DELLE AZIONI — vista dashboard (13/7/2026, giornale n.19)
 * Espone il verbale azioni_touch_log (mig 058): chi tocca i prezzi
 * raccomandati, con quale motivo, cosa è stato bloccato (veto).
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');

// Tenant context (13/7, ordine capo: "ogni tenant vede le sue azioni"):
// col tenant selezionato in dashboard TUTTA la pagina è scopata su di lui.
router.use(authMiddleware, tenantMiddleware);

// GET /api/arbitro/summary?hours=24 — contatori + classifica scrittori + timeline
router.get('/summary', async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 30);
  const tid = req.tenantId || null;
  try {
    const [totali, scrittori, timeline, arsenale] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS tocchi,
          COUNT(*) FILTER (WHERE operazione='veto_arbitro')::int AS veti,
          COUNT(*) FILTER (WHERE operazione='neutralizza')::int AS neutralizzate,
          COUNT(*) FILTER (WHERE operazione='modifica')::int AS modifiche,
          COUNT(*) FILTER (WHERE operazione='delete')::int AS delete,
          COUNT(*) FILTER (WHERE writer='anonimo')::int AS anonimi
        FROM azioni_touch_log
        WHERE touched_at >= NOW() - ($1 || ' hours')::interval
          AND ($2::uuid IS NULL OR tenant_id = $2)`, [hours, tid]),
      pool.query(`
        SELECT writer, operazione, COUNT(*)::int AS n, MAX(touched_at) AS ultimo
        FROM azioni_touch_log
        WHERE touched_at >= NOW() - ($1 || ' hours')::interval
          AND ($2::uuid IS NULL OR tenant_id = $2)
        GROUP BY writer, operazione ORDER BY n DESC`, [hours, tid]),
      pool.query(`
        SELECT date_trunc('hour', touched_at) AS ora,
          COUNT(*) FILTER (WHERE operazione='veto_arbitro')::int AS veti,
          COUNT(*) FILTER (WHERE operazione='neutralizza')::int AS neutralizzate,
          COUNT(*) FILTER (WHERE operazione IN ('modifica','delete'))::int AS altri
        FROM azioni_touch_log
        WHERE touched_at >= NOW() - ($1 || ' hours')::interval
          AND ($2::uuid IS NULL OR tenant_id = $2)
        GROUP BY 1 ORDER BY 1`, [hours, tid]),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE recommended_price IS NOT NULL)::int AS pc_vivi,
          COUNT(*) FILTER (WHERE recommended_price IS NOT NULL
            AND action_source IN ('manual_pepita','manual','capo_pin'))::int AS pc_manuali,
          COUNT(*) FILTER (WHERE recommended_price IS NOT NULL
            AND action_source='muro_scavalco')::int AS scavalchi
        FROM feed_actions
        WHERE ($1::uuid IS NULL OR tenant_id = $1)`, [tid]),
    ]);
    res.json({
      hours,
      tenant: req.tenant ? req.tenant.name : null,
      totali: totali.rows[0],
      scrittori: scrittori.rows,
      timeline: timeline.rows,
      arsenale: arsenale.rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/arbitro/log?tenant_id=&writer=&operazione=&hours=48&limit=200 — il verbale.
// Il tenant selezionato in dashboard (req.tenantId) vince sul filtro in pagina.
router.get('/log', async (req, res) => {
  const { writer, operazione } = req.query;
  const tenant_id = req.tenantId || req.query.tenant_id;
  const hours = Math.min(parseInt(req.query.hours) || 48, 24 * 30);
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const cond = [`l.touched_at >= NOW() - ($1 || ' hours')::interval`];
  const params = [hours];
  if (tenant_id && tenant_id !== 'tutti') { params.push(tenant_id); cond.push(`l.tenant_id = $${params.length}`); }
  if (writer && writer !== 'tutti') { params.push(writer); cond.push(`l.writer = $${params.length}`); }
  if (operazione && operazione !== 'tutte') { params.push(operazione); cond.push(`l.operazione = $${params.length}`); }
  params.push(limit);
  try {
    const { rows } = await pool.query(`
      SELECT l.*, t.name AS tenant_name, p.product_name AS product_name
      FROM azioni_touch_log l
      LEFT JOIN tenants t ON t.id = l.tenant_id
      LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.sku = l.sku
      WHERE ${cond.join(' AND ')}
      ORDER BY l.touched_at DESC LIMIT $${params.length}`, params);
    res.json({ items: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/arbitro/writers — elenco scrittori visti (per filtro)
router.get('/writers', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT writer, COUNT(*)::int AS n FROM azioni_touch_log
      WHERE ($1::uuid IS NULL OR tenant_id = $1)
      GROUP BY writer ORDER BY n DESC LIMIT 50`, [req.tenantId || null]);
    res.json({ items: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
