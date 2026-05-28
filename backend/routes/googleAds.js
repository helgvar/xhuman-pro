const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { pool } = require('../db/pool');
const ads = require('../services/googleAds');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

// GET /api/google-ads/diagnose - cosa manca per attivare?
router.get('/diagnose', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    res.json(await ads.diagnoseConfig(req.tenantId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/google-ads/test - prova connessione (1 query elementare)
router.get('/test', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    res.json(await ads.testConnection(req.tenantId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/google-ads/sync - sync manuale per il tenant attivo
router.post('/sync', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.body?.days) || 30, 90);
    res.json(await ads.syncTenant(req.tenantId, { days }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/google-ads/runs - storico dei sync per il tenant
router.get('/runs', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, run_type, status, campaigns_count, campaign_days, product_rows,
             error_message, started_at, completed_at,
             EXTRACT(EPOCH FROM (completed_at - started_at))::int AS duration_sec
      FROM google_ads_runs
      WHERE tenant_id=$1
      ORDER BY started_at DESC LIMIT 20
    `, [req.tenantId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
