const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const oblioService = require('../services/crossTenantOblio');

router.use(authMiddleware);

// GET /api/oblio — lista SKU in OBLIO (filtri opzionali ?status=active|released)
router.get('/', async (req, res) => {
  const status = req.query.status || 'active';
  try {
    const { rows } = await pool.query(`
      SELECT id, sku, product_name, brand, added_at, added_reason,
        tenants_affected, click_at_add, cost_at_add, status,
        released_at, released_reason, last_check_at
      FROM cross_tenant_oblio
      WHERE status = $1
      ORDER BY cost_at_add DESC
    `, [status]);

    const summary = {
      total: rows.length,
      total_cost_30d: rows.reduce((s, r) => s + parseFloat(r.cost_at_add || 0), 0),
      total_clicks_30d: rows.reduce((s, r) => s + parseInt(r.click_at_add || 0), 0),
    };
    summary.cost_per_day = +(summary.total_cost_30d / 30).toFixed(2);

    res.json({ items: rows, summary });
  } catch (err) {
    console.error('[Oblio] list error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/oblio/export.csv — esporta CSV
router.get('/export.csv', async (req, res) => {
  const status = req.query.status || 'active';
  try {
    const { rows } = await pool.query(`
      SELECT sku, product_name, brand, added_at, tenants_affected,
        click_at_add, cost_at_add, status, released_at, released_reason
      FROM cross_tenant_oblio WHERE status = $1
      ORDER BY cost_at_add DESC
    `, [status]);

    const headers = ['sku','product_name','brand','added_at','tenants','clicks_30d','cost_30d','status','released_at','released_reason'];
    const escape = v => v == null ? '' : (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n')) ? `"${v.replace(/"/g,'""')}"` : v);
    const csv = [
      headers.join(','),
      ...rows.map(r => [
        r.sku, r.product_name, r.brand,
        r.added_at ? new Date(r.added_at).toISOString() : '',
        r.tenants_affected, r.click_at_add, r.cost_at_add, r.status,
        r.released_at ? new Date(r.released_at).toISOString() : '',
        r.released_reason || '',
      ].map(escape).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="oblio_${status}_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[Oblio] export error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/oblio/populate — popola manualmente N nuovi (admin)
router.post('/populate', async (req, res) => {
  if (!['superadmin','admin'].includes(req.user?.role)) return res.status(403).json({ error: 'forbidden' });
  const batchSize = Math.min(parseInt(req.body?.batchSize) || 50, 200);
  try {
    const r = await oblioService.populateOblio(batchSize);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/oblio/check — forza check vendite (admin)
router.post('/check', async (req, res) => {
  if (!['superadmin','admin'].includes(req.user?.role)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await oblioService.checkAndReleaseOblio();
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/oblio/:id/release — rilascio manuale singolo SKU
router.post('/:id/release', async (req, res) => {
  if (!['superadmin','admin'].includes(req.user?.role)) return res.status(403).json({ error: 'forbidden' });
  try {
    await pool.query(
      `UPDATE cross_tenant_oblio SET status='released', released_at=NOW(),
       released_reason='Rilascio manuale da admin' WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
