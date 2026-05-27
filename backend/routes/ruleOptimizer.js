const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { analyzeTenant, runWeeklyForAllTenants } = require('../services/ruleOptimizer');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

// GET /api/rule-optimizer/runs — storico run del tenant corrente
router.get('/runs', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, run_date, rules_analyzed, recommendations_count,
             red_count, yellow_count, green_count, status, started_at, completed_at, duration_ms
      FROM rule_optimization_runs
      WHERE tenant_id = $1
      ORDER BY started_at DESC LIMIT 30
    `, [req.tenantId]);
    res.json({ runs: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rule-optimizer/runs/:id — dettaglio run con tutte le raccomandazioni
router.get('/runs/:id', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows: [run] } = await pool.query(
      `SELECT * FROM rule_optimization_runs WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (!run) return res.status(404).json({ error: 'not_found' });
    // Default: solo 'pending' (azioni da fare). Per vedere anche storico (applied/dismissed)
    // passare ?include_history=1. 'superseded' sono sempre nascoste salvo include_superseded=1.
    const includeSuperseded = req.query.include_superseded === '1';
    const includeHistory = req.query.include_history === '1';
    let statusFilter = "AND status = 'pending'";
    if (includeHistory && includeSuperseded) statusFilter = '';
    else if (includeHistory) statusFilter = "AND status <> 'superseded'";
    else if (includeSuperseded) statusFilter = "AND status IN ('pending','superseded')";
    const { rows: recs } = await pool.query(`
      SELECT id, rule_id, rule_name, rule_type, severity, category, title,
             recommendation, proposed_changes, expected_impact, metrics,
             status, applied_at, applied_by, dismissed_at, dismiss_reason, created_at,
             verification_status, verified_at, actual_impact, deviation_pct, correction_proposed
      FROM rule_recommendations
      WHERE run_id = $1
        ${statusFilter}
      ORDER BY CASE severity WHEN 'red' THEN 1 WHEN 'yellow' THEN 2 ELSE 3 END,
               (metrics->>'cost')::numeric DESC NULLS LAST
    `, [req.params.id]);
    // Conteggio storico per il counter "X già applicate / Y dismissed" nel frontend
    const { rows: [counts] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE status='applied')::int AS applied,
        COUNT(*) FILTER (WHERE status='dismissed')::int AS dismissed
      FROM rule_recommendations WHERE run_id = $1
    `, [req.params.id]);
    run.status_counts = counts;
    res.json({ run, recommendations: recs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rule-optimizer/recommendations — pending del tenant corrente (latest run)
router.get('/recommendations', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH latest AS (
        SELECT id FROM rule_optimization_runs WHERE tenant_id = $1
        ORDER BY started_at DESC LIMIT 1
      )
      SELECT r.id, r.rule_id, r.rule_name, r.rule_type, r.severity, r.category, r.title,
             r.recommendation, r.proposed_changes, r.expected_impact, r.metrics,
             r.status, r.applied_at, r.applied_by, r.dismissed_at, r.dismiss_reason, r.created_at,
             r.verification_status, r.verified_at, r.actual_impact, r.deviation_pct, r.correction_proposed
      FROM rule_recommendations r
      JOIN latest l ON l.id = r.run_id
      WHERE r.tenant_id = $1 AND r.status <> 'superseded'
      ORDER BY CASE r.severity WHEN 'red' THEN 1 WHEN 'yellow' THEN 2 ELSE 3 END,
               (r.metrics->>'cost')::numeric DESC NULLS LAST
    `, [req.tenantId]);
    res.json({ recommendations: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rule-optimizer/run-now — trigger manuale analisi tenant corrente
router.post('/run-now', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const r = await analyzeTenant(req.tenantId);
    res.json({ runId: r.runId, recommendations: r.recommendations.length, durationMs: r.durationMs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rule-optimizer/run-all — trigger manuale per tutti i tenant (superadmin only)
router.post('/run-all', requireRole('superadmin'), async (req, res) => {
  try {
    const results = await runWeeklyForAllTenants();
    res.json({ results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rule-optimizer/recommendations/:id/applied
router.post('/recommendations/:id/applied', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const userName = req.user?.name || req.user?.email || 'unknown';
    const { rowCount } = await pool.query(
      `UPDATE rule_recommendations SET status = 'applied', applied_at = NOW(), applied_by = $2
       WHERE id = $1 AND tenant_id = $3 AND status = 'pending'`,
      [req.params.id, userName, req.tenantId]
    );
    res.json({ ok: rowCount > 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rule-optimizer/recommendations/:id/dismissed
router.post('/recommendations/:id/dismissed', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const reason = req.body?.reason || null;
    const { rowCount } = await pool.query(
      `UPDATE rule_recommendations SET status = 'dismissed', dismissed_at = NOW(), dismiss_reason = $2
       WHERE id = $1 AND tenant_id = $3 AND status = 'pending'`,
      [req.params.id, reason, req.tenantId]
    );
    res.json({ ok: rowCount > 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
