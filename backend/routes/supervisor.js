const express = require('express');
const { pool } = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');
const { requireRole } = require('../middleware/acl');
const { runFastPath } = require('../services/supervisorChecks');
const { runSlowPath } = require('../services/supervisorAgent');
const { runWeeklyReview } = require('../services/supervisorWeekly');
const { releaseQuarantineBatch } = require('../services/quarantineRecovery');

const router = express.Router();
router.use(authMiddleware, tenantMiddleware);

// GET /api/supervisor/findings — findings aperti per il tenant corrente
router.get('/findings', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const includeResolved = req.query.include_resolved === 'true';
    const sevFilter = req.query.severity; // optional: red|yellow|green
    const where = ['tenant_id = $1'];
    const params = [req.tenantId];
    if (!includeResolved) where.push('resolved_at IS NULL');
    if (sevFilter) { params.push(sevFilter); where.push(`severity = $${params.length}`); }
    const { rows } = await pool.query(`
      SELECT id, run_id, fingerprint, severity, category, title, description,
             evidence, recommended_action, auto_remediable,
             occurrence_count, first_seen_at, last_seen_at,
             resolved_at, resolved_by, resolution_note, silenced_until
      FROM supervisor_findings
      WHERE ${where.join(' AND ')}
      ORDER BY CASE severity WHEN 'red' THEN 1 WHEN 'yellow' THEN 2 ELSE 3 END,
               last_seen_at DESC
      LIMIT 200
    `, params);
    res.json({ findings: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/supervisor/findings/:id/resolve
router.post('/findings/:id/resolve', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const note = req.body?.note || null;
    const userName = req.user?.name || req.user?.email || 'unknown';
    const { rowCount } = await pool.query(`
      UPDATE supervisor_findings
      SET resolved_at = NOW(), resolved_by = $2, resolution_note = $3
      WHERE id = $1 AND tenant_id = $4
    `, [req.params.id, userName, note, req.tenantId]);
    res.json({ ok: rowCount > 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/supervisor/findings/:id/silence — nascondi per N giorni
router.post('/findings/:id/silence', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const days = parseInt(req.body?.days || 7);
    const { rowCount } = await pool.query(`
      UPDATE supervisor_findings
      SET silenced_until = NOW() + ($2::int || ' days')::interval
      WHERE id = $1 AND tenant_id = $3
    `, [req.params.id, days, req.tenantId]);
    res.json({ ok: rowCount > 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/supervisor/runs — storico run (ultimi 30gg)
router.get('/runs', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const typeFilter = req.query.type; // optional
    const where = ['tenant_id = $1', "started_at > NOW() - INTERVAL '30 days'"];
    const params = [req.tenantId];
    if (typeFilter) { params.push(typeFilter); where.push(`run_type = $${params.length}`); }
    const { rows } = await pool.query(`
      SELECT id, run_type, model_used, trigger_reason, llm_summary,
             findings_count, red_count, yellow_count,
             tokens_input, tokens_cached, tokens_output, cost_usd,
             duration_ms, status, error_message,
             started_at, completed_at
      FROM supervisor_runs
      WHERE ${where.join(' AND ')}
      ORDER BY started_at DESC LIMIT 100
    `, params);
    res.json({ runs: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/supervisor/runs/:id — dettaglio singolo run
router.get('/runs/:id', requireRole('superadmin', 'admin', 'viewer'), async (req, res) => {
  try {
    const { rows: [run] } = await pool.query(`
      SELECT * FROM supervisor_runs WHERE id = $1 AND tenant_id = $2
    `, [req.params.id, req.tenantId]);
    if (!run) return res.status(404).json({ error: 'not_found' });
    const { rows: findings } = await pool.query(`
      SELECT * FROM supervisor_findings WHERE run_id = $1 ORDER BY severity, last_seen_at DESC
    `, [req.params.id]);
    res.json({ run, findings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/supervisor/run-now — trigger manuale fast+slow path per il tenant corrente
router.post('/run-now', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const fast = await runFastPath(req.tenantId);
    if (!fast.needsSlowPath) {
      return res.json({ fast, slow: null, message: 'all green, no LLM call' });
    }
    const slow = await runSlowPath(req.tenantId, fast);
    res.json({ fast, slow });
  } catch (err) {
    console.error('[Supervisor] run-now failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/supervisor/weekly-now — trigger manuale weekly review
router.post('/weekly-now', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const result = await runWeeklyReview(req.tenantId);
    res.json(result);
  } catch (err) {
    console.error('[Supervisor] weekly-now failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/supervisor/recovery — rilascia batch SKU dalla quarantena (manual trigger)
// body: { batchSize?: number, reason?: string, dryRun?: bool }
router.post('/recovery', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const result = await releaseQuarantineBatch(req.tenantId, req.body || {});
    res.json(result);
  } catch (err) {
    console.error('[Supervisor] recovery failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
