const express = require('express');
const { pool } = require('../db/pool');
const { requireRole } = require('../middleware/acl');
const ab = require('../services/abTestService');

const router = express.Router();

// GET /api/ab-tests/candidates - SKU candidati per A/B test sul tenant corrente
router.get('/candidates', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const opts = {
      windowDays: parseInt(req.query.windowDays) || 14,
      minClicks: parseInt(req.query.minClicks) || 20,
      minCPA: parseInt(req.query.minCPA) || 10,
      minMolPct: parseFloat(req.query.minMolPct) || 15,
    };
    const rows = await ab.identifyCandidates(req.tenantId, opts);
    res.json({ candidates: rows, count: rows.length, opts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ab-tests - lista test del tenant
router.get('/', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const status = req.query.status;
    const where = status ? 'AND status = $2' : '';
    const params = status ? [req.tenantId, status] : [req.tenantId];
    const { rows } = await pool.query(
      `SELECT * FROM ab_tests WHERE tenant_id = $1 ${where} ORDER BY created_at DESC LIMIT 100`, params);
    res.json({ tests: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ab-tests/:id - dettaglio + eventi
router.get('/:id', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows: [test] } = await pool.query(
      'SELECT * FROM ab_tests WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const { rows: events } = await pool.query(
      'SELECT * FROM ab_test_events WHERE test_id = $1 ORDER BY event_at', [test.id]);
    res.json({ test, events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ab-tests - crea test
router.post('/', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { sku, targetPosition, baselineDays, testHours } = req.body;
    if (!sku) return res.status(400).json({ error: 'sku required' });
    const test = await ab.createTest(req.tenantId, sku, {
      targetPosition: targetPosition || 2,
      baselineDays, testHours,
      createdBy: req.user?.email || 'api'
    });
    res.json({ test });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/ab-tests/:id/apply - utente conferma applicazione prezzo
router.post('/:id/apply', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const test = await ab.markApplied(req.params.id, req.user?.email || 'manual');
    res.json({ test });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/ab-tests/:id/cancel - annulla test
router.post('/:id/cancel', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE ab_tests SET status='cancelled', decided_at=NOW(), decision_reason=$1 WHERE id=$2 AND tenant_id=$3`,
      [req.body.reason || 'cancelled by user', req.params.id, req.tenantId]);
    await pool.query(
      `INSERT INTO ab_test_events (test_id, event_type, note, actor) VALUES ($1, 'cancelled', $2, $3)`,
      [req.params.id, req.body.reason || 'cancelled', req.user?.email || 'manual']);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/ab-tests/evaluate-now - trigger manuale evaluator
router.post('/evaluate-now', requireRole('superadmin'), async (req, res) => {
  try {
    const results = await ab.evaluateRunningTests();
    res.json({ evaluated: results.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
